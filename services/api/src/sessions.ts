import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, transaction, id, type Client } from '../../../packages/database/src/index.js';
import { authenticate, hashKey, type Principal } from '../../../packages/payments/src/auth.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { provisionWorkspace } from './workspace.js';
import { identityPrincipal, privyConfiguration, privyVerifier, type TeamRole } from './identity.js';
import { codeHash, mailer, type PersonalOptions } from './personal.js';
import { accountId, postJournal } from '../../../packages/ledger/src/index.js';
import { authSecret, requireOrigin, secureCookie } from './config.js';
declare module 'fastify' {
  interface FastifyInstance {
    consoleAppId: string;
  }
}
export interface ConsoleSession {
  principal: Principal;
  csrf_token: string;
  auth_method: 'privy' | 'email' | 'api_key' | 'sandbox';
  identity_id: string | null;
  role: TeamRole | null;
}
export function consoleOrigin(request: FastifyRequest) {
  return requireOrigin(request, 'console_origin_denied');
}
export async function readSession(request: FastifyRequest): Promise<ConsoleSession | null> {
  const token = request.cookies.kora_console;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = (
    await pool.query(
      "SELECT s.merchant_id,s.csrf_token,s.auth_method,s.identity_id,cm.role,k.id,k.scopes,k.operator_id FROM sessions s JOIN api_keys k ON k.id=s.api_key_id AND k.merchant_id=s.merchant_id JOIN merchants m ON m.id=s.merchant_id LEFT JOIN console_identities a ON a.id=s.identity_id LEFT JOIN console_memberships cm ON cm.identity_id=s.identity_id AND cm.merchant_id=s.merchant_id AND cm.api_key_id=s.api_key_id WHERE m.mode='sandbox' AND s.token_hash=$1 AND s.expires_at>now() AND k.revoked_at IS NULL AND (s.identity_id IS NULL OR a.disabled_at IS NULL AND (a.provider='email' AND a.app_id='kora-business' OR a.provider='privy' AND a.app_id=$2) AND cm.revoked_at IS NULL AND cm.id IS NOT NULL)",
      [hashKey(token), request.server.consoleAppId],
    )
  ).rows[0];
  return row
    ? {
        principal: {
          merchant_id: row.merchant_id,
          key_id: row.id,
          scopes: row.scopes,
          operator_id: row.operator_id,
        },
        csrf_token: row.csrf_token,
        auth_method: row.auth_method,
        identity_id: row.identity_id,
        role: row.role ?? null,
      }
    : null;
}
export function requireCsrf(request: FastifyRequest, session: ConsoleSession) {
  consoleOrigin(request);
  const token = request.headers['x-kora-csrf'];
  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf_token))
  )
    throw new PaymentError(403, 'csrf_invalid', 'Refresh the console session before trying again');
}
async function persistSession(
  c: Client,
  principal: Principal,
  request: FastifyRequest,
  method: ConsoleSession['auth_method'],
  identityId: string | null,
  role: TeamRole | null = null,
) {
  const token = randomBytes(32).toString('hex'),
    csrf_token = randomBytes(32).toString('hex');
  await c.query(
    "INSERT INTO sessions(token_hash,merchant_id,api_key_id,csrf_token,expires_at,auth_method,identity_id) VALUES($1,$2,$3,$4,now()+interval '1 day',$5,$6)",
    [hashKey(token), principal.merchant_id, principal.key_id, csrf_token, method, identityId],
  );
  if (request.cookies.kora_console)
    await c.query('DELETE FROM sessions WHERE token_hash=$1', [
      hashKey(request.cookies.kora_console),
    ]);
  return {
    token,
    body: {
      authenticated: true,
      csrf_token,
      merchant_id: principal.merchant_id,
      key_id: principal.key_id,
      scopes: principal.scopes,
      auth_method: method,
      account_saved: identityId !== null,
      role,
    },
  };
}
function sessionCookie(request: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie('kora_console', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(consoleOrigin(request)),
    path: '/',
    maxAge: 86400,
  });
}
async function createSession(
  principal: Principal,
  request: FastifyRequest,
  reply: FastifyReply,
  method: ConsoleSession['auth_method'] = 'api_key',
) {
  const result = await transaction((c) => persistSession(c, principal, request, method, null));
  sessionCookie(request, reply, result.token);
  return result.body;
}
export async function registerSessions(app: FastifyInstance, config = privyConfiguration(), emailOptions: PersonalOptions = {}) {
  app.decorate('consoleAppId', config.appId);
  const verifier = privyVerifier(config);
  const secret = authSecret(emailOptions.codeSecret);
  const sendCode = emailOptions.sendCode ?? mailer();
  app.get('/business/api/auth/config', async () => ({ enabled: !!(secret && sendCode), method: 'email_code' }));
  app.post('/business/api/auth/start', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request) => {
    consoleOrigin(request);
    if (!secret || !sendCode) throw new PaymentError(503, 'email_unavailable', 'Email sign-in is not configured');
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict().parse(request.body);
    const latest = (await pool.query('SELECT created_at FROM business_email_challenges WHERE email=$1 ORDER BY created_at DESC LIMIT 1', [email])).rows[0];
    if (latest && Date.now()-new Date(latest.created_at).getTime()<60_000)
      throw new PaymentError(429,'code_recently_sent','Wait a minute before requesting another code');
    const challengeId = id('otp'), code = String(randomInt(0,1_000_000)).padStart(6,'0');
    await pool.query("INSERT INTO business_email_challenges(id,email,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[challengeId,email,codeHash(secret,challengeId,code)]);
    try { await sendCode(email,code); }
    catch { await pool.query('DELETE FROM business_email_challenges WHERE id=$1',[challengeId]); throw new PaymentError(503,'email_unavailable','Email delivery is temporarily unavailable'); }
    return { sent: true, challenge_id: challengeId };
  });
  app.post('/business/api/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    consoleOrigin(request);
    if (!secret || !sendCode) throw new PaymentError(503,'email_unavailable','Email sign-in is not configured');
    const { challenge_id, code, name, link_current, invite_token } = z.object({ challenge_id: z.string().regex(/^otp_[a-f0-9]{32}$/), code: z.string().regex(/^[0-9]{6}$/), name: z.string().trim().min(1).max(80).default('My Microsendr business'), link_current: z.boolean().default(false), invite_token: z.string().regex(/^kora_inv_[a-f0-9]{64}$/).optional() }).strict().parse(request.body);
    if (link_current && invite_token) throw new PaymentError(400,'login_options_conflict','Choose one workspace action');
    const previous = await readSession(request);
    if (previous) requireCsrf(request,previous);
    if (link_current && !previous) throw new PaymentError(401,'workspace_session_required','Open your sandbox workspace before saving it');
    const result = await transaction(async (c) => {
      const challenge = (await c.query('SELECT * FROM business_email_challenges WHERE id=$1 FOR UPDATE',[challenge_id])).rows[0];
      if (!challenge || challenge.consumed_at || challenge.attempts>=5 || new Date(challenge.expires_at).getTime()<=Date.now())
        throw new PaymentError(401,'invalid_code','Code is invalid or expired');
      if (!timingSafeEqual(Buffer.from(challenge.code_hash),Buffer.from(codeHash(secret,challenge_id,code)))) {
        await c.query('UPDATE business_email_challenges SET attempts=attempts+1 WHERE id=$1',[challenge_id]);
        return null;
      }
      await c.query('UPDATE business_email_challenges SET consumed_at=now() WHERE id=$1',[challenge_id]);
      const identity = await identityPrincipal(c,{ provider:'email', app_id:'kora-business', subject:`email:${challenge.email}` },name,link_current?previous?.principal:undefined,{inviteToken:invite_token});
      if (link_current)
        await c.query('UPDATE organizations SET kyb_required=true,kyb_state=\'not_started\',updated_at=now() WHERE legacy_merchant_id=$1',[identity.principal.merchant_id]);
      return persistSession(c,identity.principal,request,'email',identity.identity_id,identity.role);
    });
    if (!result) throw new PaymentError(401,'invalid_code','Code is invalid or expired');
    sessionCookie(request,reply,result.token);
    return result.body;
  });
  app.get('/console/auth/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const enabled = await verifier.ready();
    return {
      provider: 'privy',
      enabled,
      app_id: enabled ? config.appId : null,
      client_id: enabled ? (config.clientId ?? null) : null,
    };
  });
  app.post(
    '/console/auth/privy',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      consoleOrigin(request);
      reply.header('cache-control', 'no-store');
      const input = z
        .object({
          access_token: z.string().min(1).max(8192),
          name: z.string().trim().min(1).max(80).default('My Microsendr workspace'),
          link_current: z.boolean().default(false),
          invite_token: z
            .string()
            .regex(/^kora_inv_[a-f0-9]{64}$/)
            .optional(),
          workspace_id: z
            .string()
            .regex(/^mcht_[a-f0-9]{32}$/)
            .optional(),
          business_account: z.boolean().default(false),
        })
        .strict()
        .parse(request.body);
      const verified = await verifier.verify(input.access_token);
      if (input.link_current && (input.invite_token || input.workspace_id))
        throw new PaymentError(400, 'login_options_conflict', 'Choose one workspace action.');
      let claim: Principal | undefined;
      const previous = await readSession(request);
      // Replacing or upgrading an authenticated workspace is always explicit and CSRF protected.
      if (previous) requireCsrf(request, previous);
      if (input.link_current) {
        if (!previous)
          throw new PaymentError(
            401,
            'workspace_session_required',
            'Open your sandbox workspace before saving it to a login.',
          );
        claim = previous.principal;
      }
      // Do not set a success cookie before ownership/funding/session commit succeeds.
      const result = await transaction(async (c) => {
        const identity = await identityPrincipal(c, verified, input.name, claim, {
          inviteToken: input.invite_token,
          workspaceId: input.workspace_id,
          businessAccount: input.business_account,
        });
        if (input.business_account)
          await c.query('UPDATE organizations SET kyb_required=true,updated_at=now() WHERE legacy_merchant_id=$1', [identity.principal.merchant_id]);
        return persistSession(
          c,
          identity.principal,
          request,
          'privy',
          identity.identity_id,
          identity.role,
        );
      });
      sessionCookie(request, reply, result.token);
      return result.body;
    },
  );
  app.get('/console/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = await readSession(request);
    return session
      ? {
          authenticated: true,
          csrf_token: session.csrf_token,
          merchant_id: session.principal.merchant_id,
          key_id: session.principal.key_id,
          scopes: session.principal.scopes,
          auth_method: session.auth_method,
          account_saved: session.identity_id !== null,
          role: session.role,
        }
      : { authenticated: false };
  });
  app.post('/console/session', async (request, reply) => {
    consoleOrigin(request);
    reply.header('cache-control', 'no-store');
    const previous = await readSession(request);
    if (previous) requireCsrf(request, previous);
    const input = z
      .object({ api_key: z.string().max(200) })
      .strict()
      .parse(request.body);
    return createSession(await authenticate(`Bearer ${input.api_key}`), request, reply);
  });
  app.post('/console/logout', async (request, reply) => {
    consoleOrigin(request);
    const session = await readSession(request);
    if (session) requireCsrf(request, session);
    if (request.cookies.kora_console)
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
        hashKey(request.cookies.kora_console),
      ]);
    reply.clearCookie('kora_console', { path: '/' });
    return { authenticated: false };
  });
  app.post(
    '/console/workspaces',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      consoleOrigin(request);
      reply.header('cache-control', 'no-store');
      const previous = await readSession(request);
      if (previous) requireCsrf(request, previous);
      const input = z
        .object({ name: z.string().trim().min(1).max(80).default('Microsendr Sandbox') })
        .strict()
        .parse(request.body ?? {});
      const principal = await provisionWorkspace(app, input.name);
      return createSession(principal, request, reply, 'sandbox');
    },
  );
  const requireIdentity = async (request: FastifyRequest) => {
    const session = await readSession(request);
    if (!session || !session.identity_id)
      throw new PaymentError(
        401,
        'login_required',
        'Sign in with email to manage workspace access.',
      );
    return session;
  };
  const requireOwner = async (request: FastifyRequest) => {
    const session = await requireIdentity(request);
    if (session.role !== 'owner')
      throw new PaymentError(
        403,
        'owner_required',
        'Only the workspace owner can manage team access.',
      );
    return session;
  };
  app.get('/business/api/account', async (request) => {
    const session = await requireIdentity(request);
    const row = (await pool.query('SELECT o.id,o.name,o.kyb_state,o.kyb_required FROM organizations o WHERE o.legacy_merchant_id=$1',[session.principal.merchant_id])).rows[0];
    return { ...row, mode: 'sandbox' };
  });
  app.post('/business/api/sandbox/verify', async (request) => {
    const session = await requireOwner(request);
    requireCsrf(request,session);
    if (session.auth_method !== 'email' && session.auth_method !== 'privy') throw new PaymentError(403,'business_login_required','Sign in to your Business account');
    z.object({ acknowledge_simulation: z.literal(true) }).strict().parse(request.body);
    return transaction(async (c) => {
      const organization=(await c.query('SELECT kyb_state,kyb_required,sandbox_funding_on_approval FROM organizations WHERE legacy_merchant_id=$1 FOR UPDATE',[session.principal.merchant_id])).rows[0];
      if(!organization?.kyb_required) throw new PaymentError(403,'business_account_required','Open a Microsendr Business account first');
      if(organization.kyb_state!=='sandbox_approved') {
        if(organization.sandbox_funding_on_approval)
          await postJournal(c,{reference:`business:sandbox-fund:${session.principal.merchant_id}`,description:'Business sandbox NGN fixture',entries:[
            {account_id:accountId(session.principal.merchant_id,'NGN','available'),side:'debit',amount:'250000000'},
            {account_id:accountId(null,'NGN','funding'),side:'credit',amount:'250000000'},
          ]});
        await c.query("UPDATE organizations SET kyb_state='sandbox_approved',updated_at=now() WHERE legacy_merchant_id=$1",[session.principal.merchant_id]);
      }
      return { kyb_state: 'sandbox_approved', message: 'Approved for simulated Business activity only. This is not real KYB.' };
    });
  });
  app.get('/console/workspaces', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = await requireIdentity(request);
    const result = await pool.query(
      "SELECT cm.merchant_id,m.name,cm.role FROM console_memberships cm JOIN merchants m ON m.id=cm.merchant_id JOIN api_keys k ON k.id=cm.api_key_id WHERE cm.identity_id=$1 AND cm.revoked_at IS NULL AND k.revoked_at IS NULL ORDER BY (cm.role='owner') DESC,cm.created_at",
      [session.identity_id],
    );
    return { data: result.rows };
  });
  app.post('/console/workspaces/switch', async (request, reply) => {
    const session = await requireIdentity(request);
    requireCsrf(request, session);
    const { merchant_id } = z
      .object({ merchant_id: z.string().regex(/^mcht_[a-f0-9]{32}$/) })
      .strict()
      .parse(request.body);
    const result = await transaction(async (c) => {
      const row = (
        await c.query(
          'SELECT cm.merchant_id,cm.role,k.id,k.scopes,k.operator_id FROM console_memberships cm JOIN api_keys k ON k.id=cm.api_key_id WHERE cm.identity_id=$1 AND cm.merchant_id=$2 AND cm.revoked_at IS NULL AND k.revoked_at IS NULL FOR SHARE OF cm,k',
          [session.identity_id, merchant_id],
        )
      ).rows[0];
      if (!row)
        throw new PaymentError(
          403,
          'workspace_access_denied',
          'You do not have access to this workspace.',
        );
      return persistSession(
        c,
        {
          merchant_id: row.merchant_id,
          key_id: row.id,
          scopes: row.scopes,
          operator_id: row.operator_id,
        },
        request,
        session.auth_method === 'email' ? 'email' : 'privy',
        session.identity_id,
        row.role,
      );
    });
    sessionCookie(request, reply, result.token);
    return result.body;
  });
  app.get('/console/team', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = await requireOwner(request);
    const [members, invitations] = await Promise.all([
      pool.query(
        'SELECT cm.id,cm.role,cm.created_at,cm.revoked_at,cm.identity_id FROM console_memberships cm WHERE cm.merchant_id=$1 ORDER BY cm.created_at',
        [session.principal.merchant_id],
      ),
      pool.query(
        "SELECT id,role,created_at,expires_at,claimed_at,revoked_at FROM console_invitations WHERE merchant_id=$1 AND created_at>now()-interval '7 days' ORDER BY created_at DESC",
        [session.principal.merchant_id],
      ),
    ]);
    return { members: members.rows, invitations: invitations.rows };
  });
  app.post(
    '/console/team/invitations',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const session = await requireOwner(request);
      requireCsrf(request, session);
      reply.header('cache-control', 'no-store');
      const { role } = z
        .object({ role: z.enum(['viewer', 'editor']) })
        .strict()
        .parse(request.body);
      const token = `kora_inv_${randomBytes(32).toString('hex')}`;
      const invitationId = id('invite');
      const row = (
        await pool.query(
          "INSERT INTO console_invitations(id,merchant_id,token_hash,role,created_by_identity_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days') RETURNING id,role,created_at,expires_at",
          [invitationId, session.principal.merchant_id, hashKey(token), role, session.identity_id],
        )
      ).rows[0];
      reply.code(201);
      return { ...row, token };
    },
  );
  app.post('/console/team/invitations/:id/revoke', async (request) => {
    const session = await requireOwner(request);
    requireCsrf(request, session);
    const invitationId = z
      .string()
      .regex(/^invite_[a-f0-9]{32}$/)
      .parse((request.params as { id: string }).id);
    const result = await pool.query(
      'UPDATE console_invitations SET revoked_at=now() WHERE id=$1 AND merchant_id=$2 AND claimed_at IS NULL AND revoked_at IS NULL RETURNING id',
      [invitationId, session.principal.merchant_id],
    );
    if (!result.rowCount)
      throw new PaymentError(404, 'invitation_unavailable', 'This invitation is no longer active.');
    return { revoked: true };
  });
  app.post('/console/team/members/:id/revoke', async (request) => {
    const session = await requireOwner(request);
    requireCsrf(request, session);
    const memberId = z
      .string()
      .regex(/^member_[a-f0-9]{32}$/)
      .parse((request.params as { id: string }).id);
    return transaction(async (c) => {
      const member = (
        await c.query(
          "SELECT id,api_key_id FROM console_memberships WHERE id=$1 AND merchant_id=$2 AND role<>'owner' AND revoked_at IS NULL FOR UPDATE",
          [memberId, session.principal.merchant_id],
        )
      ).rows[0];
      if (!member)
        throw new PaymentError(404, 'member_unavailable', 'This member is no longer active.');
      await c.query('UPDATE console_memberships SET revoked_at=now() WHERE id=$1', [member.id]);
      await c.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [member.api_key_id]);
      return { revoked: true };
    });
  });
}
