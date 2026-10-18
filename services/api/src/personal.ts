import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { id, pool, transaction } from '../../../packages/database/src/index.js';
import { balance, postJournal } from '../../../packages/ledger/src/index.js';
import { hashKey } from '../../../packages/payments/src/auth.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { privyConfiguration, privyVerifier, type PrivyConfig } from './identity.js';
import { QieClient, QIE_CHAIN_ID, QIE_EXPLORER } from '../../../packages/qie/src/index.js';
import type { PaystackClient } from '../../../connectors/paystack/src/index.js';
import { registerPersonalPaystack } from './personal-paystack.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const minorSchema = z.string().regex(/^[1-9][0-9]{0,11}$/);
const ngn = 'pos_ngn_fiat';
const personalAccount = (accountId: string) => `personal:${accountId}:NGN:available`;

export interface PersonalOptions {
  sendCode?: (email: string, code: string) => Promise<void>;
  codeSecret?: string;
}

export function mailer(): PersonalOptions['sendCode'] | undefined {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) return undefined;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
  });
  return async (email, code) => {
    await transport.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: 'Your Microsendr sign-in code',
      text: `Your Microsendr sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
    });
  };
}

function origin(request: FastifyRequest) {
  const current = request.headers.origin;
  const allowed = (process.env.KORA_CONSOLE_ORIGINS ?? 'http://127.0.0.1:4310,http://localhost:4310,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5176,http://localhost:5176')
    .split(',').map((s) => s.trim());
  if (typeof current !== 'string' || !allowed.includes(current))
    throw new PaymentError(403, 'origin_denied', 'This origin is not allowed');
  return current;
}
export function codeHash(secret: string, challengeId: string, code: string) {
  return createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}
async function session(request: FastifyRequest) {
  const token = request.cookies.kora_personal;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = (await pool.query(
    `SELECT s.csrf_token,u.id AS user_id,u.email,u.residence_country,u.display_currency,u.kyc_state,u.privy_subject,
            a.id AS account_id FROM personal_sessions s JOIN personal_users u ON u.id=s.personal_user_id
            JOIN kora_accounts a ON a.personal_user_id=u.id
            WHERE s.token_hash=$1 AND s.expires_at>now() AND a.status='active'`,
    [hashKey(token)],
  )).rows[0];
  return row ?? null;
}
function csrf(request: FastifyRequest, row: { csrf_token: string }) {
  origin(request);
  const token = request.headers['x-kora-csrf'];
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(row.csrf_token)))
    throw new PaymentError(403, 'csrf_invalid', 'Refresh your session and try again');
}
async function required(request: FastifyRequest, write = false) {
  const row = await session(request);
  if (!row) throw new PaymentError(401, 'personal_login_required', 'Sign in to your Personal account');
  if (write) csrf(request, row);
  return row as { csrf_token: string; user_id: string; account_id: string; email: string | null; residence_country: string | null; display_currency: string; kyc_state: string; privy_subject: string | null };
}
function publicSession(row: Awaited<ReturnType<typeof required>>) {
  return { authenticated: true, csrf_token: row.csrf_token, email: row.email,
    residence_country: row.residence_country, display_currency: row.display_currency,
    kyc_state: row.kyc_state, account_id: row.account_id, privy_subject: row.privy_subject ?? null, mode: 'sandbox' };
}
function setCookie(request: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie('kora_personal', token, { httpOnly: true, sameSite: 'strict',
    secure: origin(request).startsWith('https:'), path: '/', maxAge: 86400 });
}

export async function registerPersonal(app: FastifyInstance, options: PersonalOptions = {}, privyConfig: PrivyConfig = privyConfiguration(), paystackClient?: PaystackClient) {
  const secret = options.codeSecret ?? process.env.KORA_AUTH_SECRET;
  const sendCode = options.sendCode ?? mailer();
  const verifier = privyVerifier(privyConfig);
  app.get('/personal/api/auth/config', async () => ({ enabled: await verifier.ready(), method: 'privy', app_id: privyConfig.appId, client_id: privyConfig.clientId ?? null }));
  app.post('/personal/api/auth/privy', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const requestOrigin = origin(request);
    const { access_token, identity_token } = z.object({ access_token: z.string().min(1).max(8192), identity_token: z.string().min(1).max(32768).optional() }).strict().parse(request.body);
    const verified = await verifier.verify(access_token);
    let email: string | null = null;
    if (identity_token) email = emailSchema.parse(await verifier.verifyEmailIdentity(identity_token, verified.subject));
    else {
      try { email = emailSchema.parse(await verifier.verifyEmailFromPrivy(access_token, verified.subject, requestOrigin)); }
      catch (cause) {
        if (!(cause instanceof PaymentError) || !['identity_lookup_unavailable', 'verified_email_required'].includes(cause.code)) throw cause;
      }
    }
    const result = await transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-privy:${verified.app_id}:${verified.subject}`]);
      if (email) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-email:${email}`]);
      let user = (await c.query('SELECT * FROM personal_users WHERE privy_app_id=$1 AND privy_subject=$2 FOR UPDATE', [verified.app_id, verified.subject])).rows[0];
      if (email && user && user.email !== email) {
        if ((await c.query('SELECT 1 FROM personal_users WHERE email=$1', [email])).rowCount)
          throw new PaymentError(409, 'identity_conflict', 'This email is linked to another account');
        await c.query('UPDATE personal_users SET email=$2,email_verified_at=now(),updated_at=now() WHERE id=$1', [user.id, email]);
      }
      if (!user && email) {
        await c.query('INSERT INTO personal_users(id,email,email_verified_at,privy_app_id,privy_subject) VALUES($1,$2,now(),$3,$4) ON CONFLICT(email) DO NOTHING', [id('usr'), email, verified.app_id, verified.subject]);
        user = (await c.query('SELECT * FROM personal_users WHERE email=$1 FOR UPDATE', [email])).rows[0];
      }
      if (!user) {
        await c.query('INSERT INTO personal_users(id,privy_app_id,privy_subject) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id('usr'), verified.app_id, verified.subject]);
        user = (await c.query('SELECT * FROM personal_users WHERE privy_app_id=$1 AND privy_subject=$2 FOR UPDATE', [verified.app_id, verified.subject])).rows[0];
      }
      if (user.privy_subject && (user.privy_subject !== verified.subject || user.privy_app_id !== verified.app_id))
        throw new PaymentError(409, 'identity_conflict', 'This email is linked to another account');
      await c.query('UPDATE personal_users SET privy_app_id=$2,privy_subject=$3,updated_at=now() WHERE id=$1', [user.id, verified.app_id, verified.subject]);
      await c.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2) ON CONFLICT(personal_user_id) DO NOTHING", [id('acct'), user.id]);
      const account = (await c.query('SELECT id FROM kora_accounts WHERE personal_user_id=$1', [user.id])).rows[0];
      await c.query('INSERT INTO ledger_accounts(id,owner_account_id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [personalAccount(account.id), account.id, ngn, 'NGN', 'available']);
      await c.query('INSERT INTO ledger_accounts(id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', ['sys:NGN:funding',ngn,'NGN','funding']);
      const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
      await c.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), user.id, csrfToken]);
      return { token, csrfToken, userId: user.id };
    });
    setCookie(request, reply, result.token);
    reply.header('cache-control', 'no-store');
    const user = (await pool.query('SELECT u.*,a.id AS account_id FROM personal_users u JOIN kora_accounts a ON a.personal_user_id=u.id WHERE u.id=$1', [result.userId])).rows[0];
    return publicSession({ ...user, user_id: user.id, csrf_token: result.csrfToken });
  });
  app.post('/personal/api/auth/start', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    origin(request);
    if (!secret || !sendCode) throw new PaymentError(503, 'email_unavailable', 'Email sign-in is not configured');
    const { email } = z.object({ email: emailSchema }).strict().parse(request.body);
    const latest = (await pool.query('SELECT created_at FROM personal_email_challenges WHERE email=$1 ORDER BY created_at DESC LIMIT 1', [email])).rows[0];
    if (latest && Date.now() - new Date(latest.created_at).getTime() < 60_000)
      throw new PaymentError(429, 'code_recently_sent', 'Wait a minute before requesting another code');
    const challengeId = id('otp');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query("INSERT INTO personal_email_challenges(id,email,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [challengeId, email, codeHash(secret, challengeId, code)]);
    try { await sendCode(email, code); }
    catch {
      await pool.query('DELETE FROM personal_email_challenges WHERE id=$1', [challengeId]);
      throw new PaymentError(503, 'email_unavailable', 'Email delivery is temporarily unavailable');
    }
    reply.header('cache-control', 'no-store');
    return { sent: true, challenge_id: challengeId };
  });
  app.post('/personal/api/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    origin(request);
    if (!secret || !sendCode) throw new PaymentError(503, 'email_unavailable', 'Email sign-in is not configured');
    const { challenge_id, code } = z.object({ challenge_id: z.string().regex(/^otp_[a-f0-9]{32}$/), code: z.string().regex(/^[0-9]{6}$/) }).strict().parse(request.body);
    const result = await transaction(async (c) => {
      const challenge = (await c.query('SELECT * FROM personal_email_challenges WHERE id=$1 FOR UPDATE', [challenge_id])).rows[0];
      if (!challenge || challenge.consumed_at || challenge.attempts >= 5 || new Date(challenge.expires_at).getTime() <= Date.now())
        throw new PaymentError(401, 'invalid_code', 'Code is invalid or expired');
      const valid = timingSafeEqual(Buffer.from(challenge.code_hash), Buffer.from(codeHash(secret, challenge_id, code)));
      if (!valid) {
        await c.query('UPDATE personal_email_challenges SET attempts=attempts+1 WHERE id=$1', [challenge_id]);
        return null;
      }
      await c.query('UPDATE personal_email_challenges SET consumed_at=now() WHERE id=$1', [challenge_id]);
      await c.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,now()) ON CONFLICT(email) DO NOTHING', [id('usr'), challenge.email]);
      const user = (await c.query('SELECT id FROM personal_users WHERE email=$1', [challenge.email])).rows[0];
      await c.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2) ON CONFLICT(personal_user_id) DO NOTHING", [id('acct'), user.id]);
      const account = (await c.query('SELECT id FROM kora_accounts WHERE personal_user_id=$1', [user.id])).rows[0];
      await c.query('INSERT INTO ledger_accounts(id,owner_account_id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [personalAccount(account.id), account.id, ngn, 'NGN', 'available']);
      await c.query('INSERT INTO ledger_accounts(id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', ['sys:NGN:funding',ngn,'NGN','funding']);
      const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
      await c.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), user.id, csrfToken]);
      return { token, csrfToken, userId: user.id };
    });
    if (!result) throw new PaymentError(401, 'invalid_code', 'Code is invalid or expired');
    setCookie(request, reply, result.token);
    // The cookie is only on the response, so construct the session from its committed identity.
    const user = (await pool.query('SELECT u.*,a.id AS account_id FROM personal_users u JOIN kora_accounts a ON a.personal_user_id=u.id WHERE u.id=$1', [result.userId])).rows[0];
    return publicSession({ ...user, user_id: user.id, csrf_token: result.csrfToken });
  });
  app.get('/personal/api/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const row = await session(request);
    return row ? publicSession(row) : { authenticated: false };
  });
  app.post('/personal/api/logout', async (request, reply) => {
    await required(request, true);
    await pool.query('DELETE FROM personal_sessions WHERE token_hash=$1', [hashKey(request.cookies.kora_personal!)]);
    reply.clearCookie('kora_personal', { path: '/' });
    return { authenticated: false };
  });
  app.get('/personal/api/home', async (request) => {
    const row = await required(request);
    const available = await pool.connect();
    try {
      const amount = await balance(available, personalAccount(row.account_id));
      const funded = Boolean((await available.query('SELECT 1 FROM personal_sandbox_funding WHERE personal_user_id=$1', [row.user_id])).rowCount);
      return { account_id: row.account_id, email: row.email, kyc_state: row.kyc_state,
        display_currency: row.display_currency, sandbox_funded: funded,
        balance: { asset_position_id: ngn, asset: 'NGN', available_minor: amount.toString(), pending_minor: '0', held_minor: '0', simulated: true } };
    } finally { available.release(); }
  });
  app.get('/personal/api/qie/balance', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request);
    const { address } = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).strict().parse(request.query);
    const observed = await new QieClient().nativeBalance(address);
    return { chain_id: Number(QIE_CHAIN_ID), address, asset: 'QIEV3', decimals: 18,
      ...observed, explorer_url: `${QIE_EXPLORER}address/${address}`, ledger_credited: false };
  });
  app.post('/personal/api/sandbox/verify', async (request) => {
    const row = await required(request, true);
    const input = z.object({ residence_country: z.literal('NG'), acknowledge_simulation: z.literal(true) }).strict().parse(request.body);
    void input;
    await pool.query("UPDATE personal_users SET residence_country='NG',kyc_state='sandbox_approved',updated_at=now() WHERE id=$1", [row.user_id]);
    return { kyc_state: 'sandbox_approved', message: 'Approved for simulated NGN transfers only. This is not identity verification.' };
  });
  app.post('/personal/api/sandbox/fund', async (request) => {
    const row = await required(request, true);
    if (row.kyc_state !== 'sandbox_approved') throw new PaymentError(403, 'sandbox_verification_required', 'Complete the sandbox verification fixture first');
    return transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-fund:${row.user_id}`]);
      if ((await c.query('SELECT 1 FROM personal_sandbox_funding WHERE personal_user_id=$1', [row.user_id])).rowCount)
        throw new PaymentError(409, 'already_funded', 'Your sandbox balance has already been funded');
      const journalId = await postJournal(c, { reference: `personal:fund:${row.user_id}`, description: 'Personal sandbox NGN fixture', entries: [
        { account_id: personalAccount(row.account_id), side: 'debit', amount: '10000000' },
        { account_id: 'sys:NGN:funding', side: 'credit', amount: '10000000' },
      ] });
      await c.query('INSERT INTO personal_sandbox_funding(personal_user_id,journal_id) VALUES($1,$2)', [row.user_id,journalId]);
      return { funded_minor: '10000000', asset: 'NGN', simulated: true };
    });
  });
  app.post('/personal/api/transfers', async (request) => {
    const row = await required(request, true);
    if (row.kyc_state !== 'sandbox_approved') throw new PaymentError(403, 'sandbox_verification_required', 'Complete the sandbox verification fixture first');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
    const { recipient_email, amount_minor } = z.object({ recipient_email: emailSchema, amount_minor: minorSchema }).strict().parse(request.body);
    return transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-transfer:${row.account_id}:${key}`]);
      const existing = (await c.query('SELECT t.*,u.email AS recipient_email FROM personal_transfers t JOIN kora_accounts a ON a.id=t.receiver_account_id JOIN personal_users u ON u.id=a.personal_user_id WHERE t.sender_account_id=$1 AND t.idempotency_key=$2', [row.account_id,key])).rows[0];
      if (existing) {
        if (existing.recipient_email !== recipient_email || existing.amount_minor !== amount_minor)
          throw new PaymentError(409, 'idempotency_conflict', 'That request key was used for a different transfer');
        return { id: existing.id, amount_minor, recipient_email, status: 'completed', simulated: true };
      }
      const recipient = (await c.query("SELECT a.id FROM personal_users u JOIN kora_accounts a ON a.personal_user_id=u.id WHERE u.email=$1 AND u.kyc_state='sandbox_approved' AND a.status='active'", [recipient_email])).rows[0];
      if (!recipient || recipient.id === row.account_id)
        throw new PaymentError(422, 'recipient_unavailable', 'Choose another eligible Microsendr Personal recipient');
      const transferId = id('trf');
      const journalId = await postJournal(c, { reference: `personal:transfer:${transferId}`, description: 'Personal sandbox P2P transfer', entries: [
        { account_id: personalAccount(row.account_id), side: 'credit', amount: amount_minor },
        { account_id: personalAccount(recipient.id), side: 'debit', amount: amount_minor },
      ] });
      await c.query('INSERT INTO personal_transfers(id,sender_account_id,receiver_account_id,amount_minor,asset_position_id,journal_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [transferId,row.account_id,recipient.id,amount_minor,ngn,journalId,key]);
      return { id: transferId, amount_minor, recipient_email, status: 'completed', simulated: true };
    });
  });
  app.get('/personal/api/activity', async (request) => {
    const row = await required(request);
    const result = await pool.query(`SELECT t.id,t.amount_minor::text,t.created_at,
      CASE WHEN t.sender_account_id=$1 THEN 'sent' ELSE 'received' END AS direction,
      CASE WHEN t.sender_account_id=$1 THEN COALESCE(recipient.email,'Microsendr member') ELSE COALESCE(sender.email,'Microsendr member') END AS counterparty
      FROM personal_transfers t
      JOIN kora_accounts sa ON sa.id=t.sender_account_id JOIN personal_users sender ON sender.id=sa.personal_user_id
      JOIN kora_accounts ra ON ra.id=t.receiver_account_id JOIN personal_users recipient ON recipient.id=ra.personal_user_id
      WHERE t.sender_account_id=$1 OR t.receiver_account_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 50`, [row.account_id]);
    return { data: result.rows.map((t) => ({ ...t, asset: 'NGN', status: 'completed', simulated: true })) };
  });
  await registerPersonalPaystack(app, { required, origin, client: paystackClient });
}
