import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose';
import { id, type Client } from '../../../packages/database/src/index.js';
import {
  accountId,
  createMerchantInTransaction,
  postJournal,
} from '../../../packages/ledger/src/index.js';
import {
  allScopes,
  hashKey,
  issueApiKey,
  type Principal,
  type Scope,
} from '../../../packages/payments/src/auth.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';

export interface PrivyConfig {
  appId: string;
  clientId?: string;
  verificationKey: string;
}
export type TeamRole = 'owner' | 'viewer' | 'editor';
export const teamScopes: Record<'viewer' | 'editor', Scope[]> = {
  viewer: ['payments:read', 'customers:read', 'operations:read'],
  editor: [
    'payments:read',
    'payments:write',
    'customers:read',
    'customers:write',
    'operations:read',
  ],
};
export function privyConfiguration(): PrivyConfig {
  return {
    appId: process.env.PRIVY_APP_ID?.trim() ?? '',
    clientId: process.env.PRIVY_CLIENT_ID?.trim() || undefined,
    verificationKey: (process.env.PRIVY_VERIFICATION_KEY ?? '').replace(/\\n/g, '\n'),
  };
}
export function privyVerifier(config: PrivyConfig) {
  const configured = /^[A-Za-z0-9_-]{1,120}$/.test(config.appId);
  // Privy's app-scoped public keys rotate. A pinned PEM remains supported for
  // offline deployments; otherwise use only the fixed Privy HTTPS endpoint.
  const key = configured && config.verificationKey
    ? importSPKI(config.verificationKey, 'ES256').catch(() => null)
    : Promise.resolve(null);
  const remoteKey = configured && !config.verificationKey
    ? createRemoteJWKSet(new URL(`https://api.privy.io/v1/apps/${config.appId}/jwks.json`), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
      })
    : null;
  return {
    async ready() {
      return configured && ((await key) !== null || remoteKey !== null);
    },
    async verify(token: string) {
      const publicKey = (await key) ?? remoteKey;
      if (!publicKey)
        throw new PaymentError(
          503,
          'login_not_configured',
          'Email login is not configured yet. You can explore Microsendr in a guest sandbox.',
        );
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          algorithms: ['ES256'],
          issuer: 'privy.io',
          audience: config.appId,
          requiredClaims: ['sub', 'iat', 'exp', 'sid'],
          clockTolerance: 5,
          maxTokenAge: '1h',
        });
        if (
          typeof payload.sub !== 'string' ||
          !/^did:privy:[A-Za-z0-9_-]{1,190}$/.test(payload.sub) ||
          typeof payload.sid !== 'string' ||
          payload.sid.length < 1 ||
          payload.sid.length > 200
        )
          throw new Error('Invalid identity');
        return { app_id: config.appId, subject: payload.sub };
      } catch {
        throw new PaymentError(
          401,
          'invalid_identity_token',
          'Your login could not be verified. Sign in again.',
        );
      }
    },
    async verifyEmailIdentity(token: string, expectedSubject: string) {
      const publicKey = (await key) ?? remoteKey;
      if (!publicKey) throw new PaymentError(503, 'login_not_configured', 'Privy login is not configured');
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          algorithms: ['ES256'], issuer: 'privy.io', audience: config.appId,
          requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5, maxTokenAge: '1h',
        });
        if (payload.sub !== expectedSubject || typeof payload.linked_accounts !== 'string') throw new Error('Identity mismatch');
        const accounts: unknown = JSON.parse(payload.linked_accounts);
        if (!Array.isArray(accounts)) throw new Error('Invalid accounts');
        const email = accounts.find((account) => account && account.type === 'email' &&
          typeof account.address === 'string' && typeof account.lv === 'number' && account.lv > 0)?.address;
        if (typeof email !== 'string') throw new Error('Verified email required');
        return email.trim().toLowerCase();
      } catch {
        throw new PaymentError(401, 'invalid_identity_token', 'Your email could not be verified. Sign in again.');
      }
    },
    async verifyEmailFromPrivy(accessToken: string, expectedSubject: string, requestOrigin: string) {
      // Privy's web SDK reads the current user through this app-scoped endpoint.
      // Use the verified access token to resolve linked accounts server-side when
      // an application has not enabled identity tokens in its dashboard.
      let user: unknown;
      try {
        const response = await fetch('https://auth.privy.io/api/v1/users/me', {
          headers: {
            authorization: `Bearer ${accessToken}`,
            'privy-app-id': config.appId,
            origin: requestOrigin,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Privy user lookup failed');
        const result: unknown = await response.json();
        user = result && typeof result === 'object' && 'user' in result ? result.user : result;
      } catch {
        throw new PaymentError(502, 'identity_lookup_unavailable', 'Sign-in could not finish. Try again.');
      }
      if (!user || typeof user !== 'object' || !('id' in user) || user.id !== expectedSubject ||
          !('linked_accounts' in user) || !Array.isArray(user.linked_accounts))
        throw new PaymentError(401, 'invalid_identity', 'Your account could not be verified. Sign in again.');
      const email = user.linked_accounts.find((account: unknown) => account && typeof account === 'object' &&
        'type' in account && account.type === 'email' && 'address' in account && typeof account.address === 'string' &&
        (('latest_verified_at' in account && typeof account.latest_verified_at === 'number' && account.latest_verified_at > 0) ||
         ('verified_at' in account && typeof account.verified_at === 'number' && account.verified_at > 0)));
      if (!email || typeof email.address !== 'string')
        throw new PaymentError(401, 'verified_email_required', 'No verified email is linked to this account.');
      return email.address.trim().toLowerCase();
    },
  };
}

export async function identityPrincipal(
  c: Client,
  verified: { app_id: string; subject: string; provider?: 'privy' | 'email' },
  name: string,
  claim?: Principal,
  options: { inviteToken?: string; workspaceId?: string; businessAccount?: boolean } = {},
): Promise<{ principal: Principal; identity_id: string; role: TeamRole }> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `console-identity:${verified.app_id}:${verified.subject}`,
  ]);
  const identity = (
    await c.query(
      "INSERT INTO console_identities(id,provider,app_id,subject) VALUES($1,$2,$3,$4) ON CONFLICT(provider,app_id,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id,disabled_at",
      [id('acct'), verified.provider ?? 'privy', verified.app_id, verified.subject],
    )
  ).rows[0];
  if (identity.disabled_at)
    throw new PaymentError(
      403,
      'account_disabled',
      'This account is disabled. Contact your workspace administrator.',
    );
  if (options.inviteToken) {
    const invitation = (
      await c.query(
        'SELECT id,merchant_id,role FROM console_invitations WHERE token_hash=$1 AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
        [hashKey(options.inviteToken)],
      )
    ).rows[0];
    if (!invitation)
      throw new PaymentError(
        404,
        'invitation_unavailable',
        'This invitation has expired or was already used.',
      );
    if (claim)
      throw new PaymentError(
        409,
        'invite_claim_conflict',
        'Save your guest workspace before joining an invitation.',
      );
    const member = await c.query(
      'SELECT 1 FROM console_memberships WHERE identity_id=$1 AND merchant_id=$2 AND revoked_at IS NULL',
      [identity.id, invitation.merchant_id],
    );
    if (member.rowCount)
      throw new PaymentError(409, 'already_a_member', 'You already have access to this workspace.');
    const scopes = teamScopes[invitation.role as 'viewer' | 'editor'];
    const key = await issueApiKey(invitation.merchant_id, `Console ${invitation.role}`, scopes, c);
    await c.query(
      'INSERT INTO console_memberships(identity_id,merchant_id,api_key_id,role) VALUES($1,$2,$3,$4)',
      [identity.id, invitation.merchant_id, key.id, invitation.role],
    );
    await c.query(
      'UPDATE console_invitations SET claimed_by_identity_id=$1,claimed_at=now() WHERE id=$2',
      [identity.id, invitation.id],
    );
    return {
      identity_id: identity.id,
      role: invitation.role,
      principal: { merchant_id: invitation.merchant_id, key_id: key.id, scopes },
    };
  }
  const existing = (
    await c.query(
      "SELECT m.merchant_id,m.role,k.id,k.scopes,k.revoked_at,k.operator_id FROM console_memberships m JOIN api_keys k ON k.id=m.api_key_id AND k.merchant_id=m.merchant_id WHERE m.identity_id=$1 AND m.revoked_at IS NULL AND ($2::text IS NULL OR m.merchant_id=$2) ORDER BY (m.role='owner') DESC,m.created_at LIMIT 1 FOR SHARE OF k",
      [identity.id, options.workspaceId ?? null],
    )
  ).rows[0];
  if (existing) {
    if (claim && existing.merchant_id !== claim.merchant_id)
      throw new PaymentError(
        409,
        'account_workspace_conflict',
        'This login already belongs to another workspace. Sign in to open it.',
      );
    if (existing.revoked_at)
      throw new PaymentError(
        403,
        'workspace_access_revoked',
        'Workspace access has been revoked. Contact your administrator.',
      );
    return {
      identity_id: identity.id,
      role: existing.role,
      principal: {
        merchant_id: existing.merchant_id,
        key_id: existing.id,
        scopes: existing.scopes,
        operator_id: existing.operator_id,
      },
    };
  }
  if (options.workspaceId)
    throw new PaymentError(
      403,
      'workspace_access_denied',
      'You do not have access to this workspace.',
    );
  if (
    (await c.query('SELECT 1 FROM console_memberships WHERE identity_id=$1', [identity.id]))
      .rowCount
  )
    throw new PaymentError(
      403,
      'workspace_access_revoked',
      'Workspace access has been revoked. Contact your administrator.',
    );
  let principal: Principal;
  if (claim) {
    await c.query('SELECT id FROM merchants WHERE id=$1 FOR UPDATE', [claim.merchant_id]);
    const key = (
      await c.query(
        'SELECT scopes,revoked_at,operator_id FROM api_keys WHERE id=$1 AND merchant_id=$2 FOR SHARE',
        [claim.key_id, claim.merchant_id],
      )
    ).rows[0];
    if (
      !key ||
      key.revoked_at ||
      key.operator_id ||
      !allScopes.every((scope) => key.scopes.includes(scope))
    )
      throw new PaymentError(
        403,
        'workspace_claim_denied',
        'Saving this workspace requires its full administrator session.',
      );
    if (
      (await c.query('SELECT 1 FROM console_memberships WHERE merchant_id=$1', [claim.merchant_id]))
        .rowCount
    )
      throw new PaymentError(
        409,
        'workspace_already_owned',
        'This workspace already has a login owner.',
      );
    const ownerKey = await issueApiKey(claim.merchant_id, 'Privy workspace owner', allScopes, c);
    principal = { merchant_id: claim.merchant_id, key_id: ownerKey.id, scopes: [...allScopes] };
  } else {
    const merchant = id('mcht');
    await createMerchantInTransaction(c, merchant, name);
    for (const [asset, amount] of ([
      ['NGN', '250000000'],
      ['USDC', '8000000000'],
      ['KES', '75000000'],
      ['GHS', '1200000'],
    ] as const).filter(() => verified.provider !== 'email' && !options.businessAccount))
      await postJournal(c, {
        reference: `${merchant}:fixture:${asset}`,
        description: 'Sandbox fixture funding',
        entries: [
          { account_id: accountId(merchant, asset, 'available'), side: 'debit', amount },
          { account_id: accountId(null, asset, 'funding'), side: 'credit', amount },
        ],
      });
    const ownerKey = await issueApiKey(merchant, 'Business workspace owner', allScopes, c);
    principal = { merchant_id: merchant, key_id: ownerKey.id, scopes: [...allScopes] };
    if (verified.provider === 'email' || options.businessAccount)
      await c.query("UPDATE organizations SET kyb_required=true,sandbox_funding_on_approval=true WHERE legacy_merchant_id=$1", [merchant]);
  }
  await c.query(
    'INSERT INTO console_memberships(identity_id,merchant_id,api_key_id) VALUES($1,$2,$3)',
    [identity.id, principal.merchant_id, principal.key_id],
  );
  return { identity_id: identity.id, principal, role: 'owner' };
}
