import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress, verifyMessage } from 'viem';
import { z } from 'zod';
import { id, pool, transaction } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { QieClient, QIE_CHAIN_ID, QIE_EXPLORER, QIE_NETWORK } from '../../../packages/qie/src/index.js';
import { ensureManagedWallet } from './managed-wallet.js';

type Person = { user_id: string; account_id: string };
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const walletIdSchema = z.string().regex(/^(?:cwa_[a-f0-9]{32}|[A-Za-z0-9_-]{8,100})$/);
const challengeIdSchema = z.string().regex(/^cwc_[a-f0-9]{32}$/);
const signatureSchema = z.string().regex(/^0x[a-fA-F0-9]{130}$/);

export function walletChallengeMessage(input: {
  accountId: string; address: string; nonce: string; expiresAt: string;
}) {
  return [
    'Link this QIE wallet to your Microsendr account',
    `Account: ${input.accountId}`,
    `Network: ${QIE_NETWORK}`,
    `Chain ID: ${QIE_CHAIN_ID}`,
    `Address: ${input.address.toLowerCase()}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expiresAt}`,
    'This signature does not authorize a transaction.',
  ].join('\n');
}

export async function requireLinkedWallet(person: Person, address: string) {
  const linked = (await pool.query(
    `SELECT id FROM personal_chain_wallets
     WHERE personal_user_id=$1 AND account_id=$2 AND network=$3 AND address=$4 AND status='active'`,
    [person.user_id, person.account_id, QIE_NETWORK, address.toLowerCase()],
  )).rows[0];
  if (!linked) throw new PaymentError(403, 'wallet_not_linked', 'Link this wallet to your account first');
  return linked.id as string;
}

export function registerPersonalWallets(
  app: FastifyInstance,
  required: (request: FastifyRequest, write?: boolean) => Promise<Person>,
) {
  app.get('/personal/api/wallets', async request => {
    const person = await required(request);
    const managed = await ensureManagedWallet(person.user_id, person.account_id).catch(() => null);
    const rows = await pool.query(
      `SELECT id,address,label,network,created_at FROM personal_chain_wallets
       WHERE personal_user_id=$1 AND account_id=$2 AND status='active' ORDER BY created_at,id`,
      [person.user_id, person.account_id],
    );
    return {
      data: [
        ...(managed ? [{ ...managed, label: 'Your wallet', managed: true }] : []),
        ...rows.rows.map(row => ({ ...row, address: getAddress(row.address), managed: false })),
      ],
      provisioning_available: !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET),
    };
  });

  app.post('/personal/api/wallets/challenge',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
      const person = await required(request, true);
      const { address } = z.object({ address: addressSchema }).strict().parse(request.body);
      const normalized = getAddress(address);
      const challengeId = id('cwc');
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const message = walletChallengeMessage({
        accountId: person.account_id, address: normalized,
        nonce: randomBytes(32).toString('hex'), expiresAt,
      });
      await pool.query(
        `INSERT INTO personal_chain_wallet_challenges
         (id,personal_user_id,account_id,network,address,message,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [challengeId, person.user_id, person.account_id, QIE_NETWORK, normalized.toLowerCase(), message, expiresAt],
      );
      return { challenge_id: challengeId, message, expires_at: expiresAt };
    });

  app.post('/personal/api/wallets',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
      const person = await required(request, true);
      const { challenge_id, signature } = z.object({
        challenge_id: challengeIdSchema, signature: signatureSchema,
      }).strict().parse(request.body);
      return transaction(async c => {
        const challenge = (await c.query(
          `SELECT * FROM personal_chain_wallet_challenges WHERE id=$1 AND personal_user_id=$2
           AND account_id=$3 FOR UPDATE`,
          [challenge_id, person.user_id, person.account_id],
        )).rows[0];
        if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now())
          throw new PaymentError(409, 'wallet_challenge_expired', 'Request a fresh wallet confirmation');
        const valid = await verifyMessage({
          address: getAddress(challenge.address), message: challenge.message,
          signature: signature as `0x${string}`,
        }).catch(() => false);
        if (!valid) throw new PaymentError(401, 'wallet_signature_invalid', 'The wallet signature did not match');
        await c.query('UPDATE personal_chain_wallet_challenges SET consumed_at=now() WHERE id=$1', [challenge_id]);
        const existing = (await c.query(
          `SELECT id,personal_user_id FROM personal_chain_wallets
           WHERE network=$1 AND address=$2 AND status='active'`,
          [QIE_NETWORK, challenge.address],
        )).rows[0];
        if (existing) {
          if (existing.personal_user_id !== person.user_id)
            throw new PaymentError(409, 'wallet_already_linked', 'This wallet is linked to another account');
          return { id: existing.id, address: getAddress(challenge.address), network: QIE_NETWORK };
        }
        const walletId = id('cwa');
        try {
          await c.query(
            `INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address)
             VALUES($1,$2,$3,$4,$5)`,
            [walletId, person.user_id, person.account_id, QIE_NETWORK, challenge.address],
          );
        } catch (cause) {
          if ((cause as { code?: string }).code === '23505')
            throw new PaymentError(409, 'wallet_already_linked', 'This wallet is linked to another account');
          throw cause;
        }
        return { id: walletId, address: getAddress(challenge.address), network: QIE_NETWORK };
      });
    });

  app.get('/personal/api/wallets/:id/balance',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
      const person = await required(request);
      const { id: walletId } = z.object({ id: walletIdSchema }).parse(request.params);
      const wallet = walletId.startsWith('cwa_') ? (await pool.query(
        `SELECT address FROM personal_chain_wallets WHERE id=$1 AND personal_user_id=$2
         AND account_id=$3 AND status='active'`, [walletId, person.user_id, person.account_id],
      )).rows[0] : (await pool.query(
        `SELECT address FROM personal_managed_wallets WHERE privy_wallet_id=$1 AND personal_user_id=$2 AND account_id=$3`,
        [walletId, person.user_id, person.account_id],
      )).rows[0];
      if (!wallet) throw new PaymentError(404, 'wallet_not_found', 'Wallet not found');
      try {
        const observed = await new QieClient().nativeBalance(wallet.address);
        return {
          address: getAddress(wallet.address), network: QIE_NETWORK,
          chain_id: Number(QIE_CHAIN_ID), asset: 'QIEV3', decimals: 18,
          ...observed, explorer_url: `${QIE_EXPLORER}address/${wallet.address}`,
          source: 'onchain', ledger_credited: false,
        };
      } catch {
        throw new PaymentError(503, 'qie_unavailable', 'QIE balance is temporarily unavailable. Try again.');
      }
    });

  app.delete('/personal/api/wallets/:id', async request => {
    const person = await required(request, true);
    const { id: walletId } = z.object({ id: walletIdSchema }).parse(request.params);
    const removed = await pool.query(
      `UPDATE personal_chain_wallets SET status='removed',updated_at=now()
       WHERE id=$1 AND personal_user_id=$2 AND account_id=$3 AND status='active' RETURNING id`,
      [walletId, person.user_id, person.account_id],
    );
    if (!removed.rowCount) throw new PaymentError(404, 'wallet_not_found', 'Wallet not found');
    return { removed: true };
  });
}
