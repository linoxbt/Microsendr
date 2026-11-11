import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { id, pool } from '../../../packages/database/src/index.js';
import { hashKey } from '../../../packages/payments/src/auth.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { authSecret, requireOrigin } from './config.js';
import { QIE_NATIVE_POSITION, QIE_QUSDC_POSITION } from '../../../packages/qie/src/index.js';

const positionOf = (asset: 'QIE' | 'QUSDC' | undefined) => (asset === 'QUSDC' ? QIE_QUSDC_POSITION : QIE_NATIVE_POSITION);
import { hashPassword, matches } from './consumer.js';
import { holdSends } from './send-hold.js';

type Person = { user_id: string; account_id: string };
type Required = (request: FastifyRequest, write?: boolean) => Promise<Person>;

const PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const pinSchema = z.string().regex(/^\d{6}$/, 'Enter six digits');
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const amountSchema = z.string().regex(/^[1-9][0-9]{0,40}$/);
/** How a send is approved: exactly one of password, PIN or passkey. */
export const sendApprovalSchema = z.union([
  z.object({ password: z.string().min(1).max(128) }).strict(),
  z.object({ pin: pinSchema }).strict(),
  z.object({ passkey: z.object({ challenge_id: z.string().regex(/^wac_[a-f0-9]{32}$/), response: z.record(z.string(), z.unknown()) }).strict() }).strict(),
]);
export type SendApproval = z.infer<typeof sendApprovalSchema>;

// Easy-to-guess PINs are refused outright.
function weakPin(pin: string) {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const step = digits[1] - digits[0];
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return true;
  return ['121212', '112233', '123123', '696969', '101010', '000123'].includes(pin);
}
// The PIN is peppered with the server secret when one is configured, so a stolen
// database alone does not allow an offline search of the million possible PINs.
function pinMaterial(userId: string, pin: string) {
  const secret = authSecret();
  return secret ? createHmac('sha256', secret).update(`payment-pin:${userId}:${pin}`).digest('hex') : `payment-pin:${userId}:${pin}`;
}

/** The relying party is the site the browser is on: its hostname, unless overridden. */
function relyingParty(request: FastifyRequest) {
  const origin = requireOrigin(request);
  return { origin, rpID: process.env.KORA_WEBAUTHN_RP_ID || new URL(origin).hostname };
}

const PASSWORD_ATTEMPTS = 5;
/**
 * Password checks behind a session (payment approval, PIN and passkey changes) share
 * one per-user counter. Each attempt is counted before the hash is compared, so
 * parallel guesses cannot exceed the limit.
 */
async function checkPassword(userId: string, password: string, stored: string) {
  const key = hashKey(`step-up-password:${userId}`);
  const failures = (await pool.query(`INSERT INTO personal_auth_limits(email_hash,failures) VALUES($1,1)
    ON CONFLICT(email_hash) DO UPDATE SET
      failures=CASE WHEN personal_auth_limits.window_started_at<now()-interval '15 minutes' THEN 1 ELSE personal_auth_limits.failures+1 END,
      window_started_at=CASE WHEN personal_auth_limits.window_started_at<now()-interval '15 minutes' THEN now() ELSE personal_auth_limits.window_started_at END
    RETURNING failures`, [key])).rows[0].failures as number;
  if (failures > PASSWORD_ATTEMPTS)
    throw new PaymentError(429, 'password_locked', 'Too many wrong passwords. Try again in 15 minutes.');
  if (!(await matches(password, stored, 'payment'))) throw new PaymentError(401, 'invalid_password', 'Your password is incorrect');
  await pool.query('DELETE FROM personal_auth_limits WHERE email_hash=$1', [key]);
}

/**
 * Setting a PIN or changing passkeys needs the password, or a fresh email-code session.
 * Returns how it was authorised; a change made with only an email code pauses sends.
 */
async function reauthenticate(request: FastifyRequest, person: Person, password: string | undefined): Promise<'password' | 'email'> {
  const user = (await pool.query('SELECT password_hash FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
  if (user?.password_hash) {
    if (!password) throw new PaymentError(401, 'invalid_password', 'Enter your password');
    await checkPassword(person.user_id, password, user.password_hash);
    return 'password';
  }
  const token = request.cookies.kora_personal;
  const current = token ? (await pool.query('SELECT auth_method,created_at FROM personal_sessions WHERE token_hash=$1 AND expires_at>now()',
    [hashKey(token)])).rows[0] : null;
  if (current && ['email', 'restore'].includes(current.auth_method) && Date.now() - new Date(current.created_at).getTime() < 600_000) return 'email';
  throw new PaymentError(401, 'reauth_required', 'Set a password in Security first, or sign in again with an email code.');
}

async function checkPin(userId: string, pin: string) {
  // Reserve the attempt before comparing: the counter rises atomically and the lock is
  // armed by the fifth reservation, so concurrent guesses can never exceed five. An
  // expired lock starts a fresh window.
  const reserved = (await pool.query(`UPDATE personal_users SET
      pin_failed_attempts=CASE WHEN pin_locked_until IS NOT NULL AND pin_locked_until<=now() THEN 1 ELSE pin_failed_attempts+1 END,
      pin_locked_until=CASE
        WHEN pin_locked_until IS NOT NULL AND pin_locked_until<=now() THEN NULL
        WHEN pin_failed_attempts+1>=$2 THEN now()+make_interval(mins => $3)
        ELSE pin_locked_until END
    WHERE id=$1 AND payment_pin_hash IS NOT NULL AND (pin_locked_until IS NULL OR pin_locked_until<=now())
    RETURNING payment_pin_hash,pin_failed_attempts`, [userId, PIN_ATTEMPTS, PIN_LOCK_MINUTES])).rows[0];
  if (!reserved) {
    const row = (await pool.query('SELECT payment_pin_hash,pin_locked_until FROM personal_users WHERE id=$1', [userId])).rows[0];
    if (!row?.payment_pin_hash) throw new PaymentError(409, 'pin_not_set', 'Set a payment PIN in Security first');
    throw new PaymentError(429, 'pin_locked', `Too many wrong PINs. Try again after ${new Date(row.pin_locked_until).toISOString().slice(11, 16)} UTC, or use your passkey.`);
  }
  if (await matches(pinMaterial(userId, pin), reserved.payment_pin_hash, 'payment')) {
    await pool.query('UPDATE personal_users SET pin_failed_attempts=0,pin_locked_until=NULL WHERE id=$1', [userId]);
    return;
  }
  const failed = reserved.pin_failed_attempts as number;
  if (failed >= PIN_ATTEMPTS)
    throw new PaymentError(429, 'pin_locked', `Too many wrong PINs. Your PIN is locked for ${PIN_LOCK_MINUTES} minutes.`);
  const left = PIN_ATTEMPTS - failed;
  throw new PaymentError(401, 'invalid_pin', `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
}

async function checkPasskey(request: FastifyRequest, person: Person, approval: { challenge_id: string; response: Record<string, unknown> },
  transfer: { to: string; amountAtomic: string; asset?: 'QIE' | 'QUSDC' }) {
  const { origin, rpID } = relyingParty(request);
  // Single use whatever the outcome: a captured assertion can never be replayed.
  const challenge = (await pool.query(`UPDATE personal_webauthn_challenges SET used_at=now()
    WHERE id=$1 AND personal_user_id=$2 AND purpose='send' AND used_at IS NULL AND expires_at>now()
    RETURNING challenge,origin,destination_address,amount_atomic::text,asset_position_id`, [approval.challenge_id, person.user_id])).rows[0];
  const rejected = new PaymentError(401, 'passkey_rejected', 'Your passkey did not approve this payment. Try again.');
  if (!challenge || challenge.origin !== origin) throw rejected;
  if (challenge.destination_address !== transfer.to.toLowerCase() || challenge.amount_atomic !== transfer.amountAtomic ||
      challenge.asset_position_id !== positionOf(transfer.asset))
    throw new PaymentError(409, 'passkey_mismatch', 'The payment changed after you approved it. Review it again.');
  const response = approval.response as unknown as AuthenticationResponseJSON;
  if (typeof response.id !== 'string') throw rejected;
  const key = (await pool.query('SELECT id,credential_id,public_key,counter,transports FROM personal_passkeys WHERE personal_user_id=$1 AND credential_id=$2',
    [person.user_id, response.id])).rows[0];
  if (!key) throw rejected;
  const verified = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: key.transports as AuthenticatorTransportFuture[] },
  }).catch(() => null);
  if (!verified?.verified) throw rejected;
  await pool.query('UPDATE personal_passkeys SET counter=$2,last_used_at=now() WHERE id=$1', [key.id, verified.authenticationInfo.newCounter]);
}

/** Approves one send from the account wallet. Throws unless the approval is valid. */
export async function approveSend(request: FastifyRequest, person: Person, approval: SendApproval,
  transfer: { to: string; amountAtomic: string; asset?: 'QIE' | 'QUSDC' }) {
  if ('pin' in approval) return checkPin(person.user_id, approval.pin);
  if ('passkey' in approval) return checkPasskey(request, person, approval.passkey, transfer);
  const stored = (await pool.query('SELECT password_hash FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
  if (!stored?.password_hash) throw new PaymentError(403, 'password_required', 'Set a password in Security before sending');
  await checkPassword(person.user_id, approval.password, stored.password_hash);
}

export function registerPaymentAuth(app: FastifyInstance, required: Required) {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/personal/api/payment-auth', async (request) => {
    const person = await required(request);
    const user = (await pool.query('SELECT payment_pin_hash IS NOT NULL AS pin_set,pin_locked_until,send_hold_until FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    const keys = (await pool.query('SELECT id,label,created_at,last_used_at FROM personal_passkeys WHERE personal_user_id=$1 ORDER BY created_at', [person.user_id])).rows;
    return {
      pin_set: !!user?.pin_set,
      pin_locked_until: user?.pin_locked_until && new Date(user.pin_locked_until) > new Date() ? user.pin_locked_until : null,
      send_hold_until: user?.send_hold_until && new Date(user.send_hold_until) > new Date() ? user.send_hold_until : null,
      passkeys: keys,
    };
  });

  app.post('/personal/api/payment-auth/pin', limited, async (request) => {
    const person = await required(request, true);
    const input = z.object({ pin: pinSchema, password: z.string().max(128).optional() }).strict().parse(request.body);
    if (weakPin(input.pin)) throw new PaymentError(422, 'weak_pin', 'Choose a PIN that is harder to guess');
    const method = await reauthenticate(request, person, input.password);
    await pool.query('UPDATE personal_users SET payment_pin_hash=$2,pin_failed_attempts=0,pin_locked_until=NULL,updated_at=now() WHERE id=$1',
      [person.user_id, await hashPassword(pinMaterial(person.user_id, input.pin), 'payment')]);
    if (method === 'email') await holdSends(person.user_id);
    return { pin_set: true };
  });

  app.post('/personal/api/payment-auth/passkeys/options', limited, async (request) => {
    const person = await required(request, true);
    const input = z.object({ password: z.string().max(128).optional() }).strict().parse(request.body ?? {});
    const method = await reauthenticate(request, person, input.password);
    const { origin, rpID } = relyingParty(request);
    const user = (await pool.query('SELECT email,username FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    const existing = (await pool.query('SELECT credential_id,transports FROM personal_passkeys WHERE personal_user_id=$1', [person.user_id])).rows;
    if (existing.length >= 10) throw new PaymentError(409, 'passkey_limit', 'Remove a passkey before adding another');
    const options = await generateRegistrationOptions({
      rpName: 'Roots', rpID, userName: user?.username ? `@${user.username}` : user?.email ?? 'Roots account',
      userID: new TextEncoder().encode(person.user_id), attestationType: 'none',
      excludeCredentials: existing.map((key) => ({ id: key.credential_id, transports: key.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    const challengeId = id('wac');
    await pool.query(`INSERT INTO personal_webauthn_challenges(id,personal_user_id,purpose,challenge,origin,expires_at)
      VALUES($1,$2,'register',$3,$4,now()+interval '5 minutes')`, [challengeId, person.user_id, options.challenge, origin]);
    if (method === 'email') await holdSends(person.user_id);
    return { challenge_id: challengeId, options };
  });

  app.post('/personal/api/payment-auth/passkeys', limited, async (request) => {
    const person = await required(request, true);
    const input = z.object({ challenge_id: z.string().regex(/^wac_[a-f0-9]{32}$/), response: z.record(z.string(), z.unknown()),
      label: z.string().trim().min(1).max(60).optional() }).strict().parse(request.body);
    const { origin, rpID } = relyingParty(request);
    const challenge = (await pool.query(`UPDATE personal_webauthn_challenges SET used_at=now()
      WHERE id=$1 AND personal_user_id=$2 AND purpose='register' AND used_at IS NULL AND expires_at>now() RETURNING challenge,origin`,
      [input.challenge_id, person.user_id])).rows[0];
    const rejected = new PaymentError(400, 'passkey_not_added', 'This passkey could not be added. Try again.');
    if (!challenge || challenge.origin !== origin) throw rejected;
    const verified = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    }).catch(() => null);
    if (!verified?.verified || !verified.registrationInfo) throw rejected;
    const { credential } = verified.registrationInfo;
    const passkeyId = id('pky');
    const inserted = await pool.query(`INSERT INTO personal_passkeys(id,personal_user_id,credential_id,public_key,counter,transports,label)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(credential_id) DO NOTHING RETURNING id,label,created_at`,
      [passkeyId, person.user_id, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], input.label ?? 'Passkey']);
    if (!inserted.rows[0]) throw new PaymentError(409, 'passkey_exists', 'This passkey is already added');
    return inserted.rows[0];
  });

  // Removing a passkey needs the password too, so a stolen session cannot strip them.
  app.post('/personal/api/payment-auth/passkeys/:id/remove', limited, async (request) => {
    const person = await required(request, true);
    const { id: passkeyId } = z.object({ id: z.string().regex(/^pky_[a-f0-9]{32}$/) }).parse(request.params);
    const input = z.object({ password: z.string().max(128).optional() }).strict().parse(request.body ?? {});
    const method = await reauthenticate(request, person, input.password);
    const removed = await pool.query('DELETE FROM personal_passkeys WHERE id=$1 AND personal_user_id=$2', [passkeyId, person.user_id]);
    if (!removed.rowCount) throw new PaymentError(404, 'passkey_not_found', 'Passkey not found');
    if (method === 'email') await holdSends(person.user_id);
    return { removed: true };
  });

  // A send challenge names the recipient and amount it may approve.
  app.post('/personal/api/payment-auth/passkeys/challenge', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const input = z.object({ to: addressSchema, amount_atomic: amountSchema, asset: z.enum(['QIE', 'QUSDC']).default('QIE') }).strict().parse(request.body);
    const { origin, rpID } = relyingParty(request);
    const keys = (await pool.query('SELECT credential_id,transports FROM personal_passkeys WHERE personal_user_id=$1', [person.user_id])).rows;
    if (!keys.length) throw new PaymentError(409, 'passkey_not_set', 'Add a passkey in Security first');
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required',
      allowCredentials: keys.map((key) => ({ id: key.credential_id, transports: key.transports })),
    });
    const challengeId = id('wac');
    await pool.query(`INSERT INTO personal_webauthn_challenges(id,personal_user_id,purpose,challenge,origin,destination_address,amount_atomic,asset_position_id,expires_at)
      VALUES($1,$2,'send',$3,$4,$5,$6,$7,now()+interval '5 minutes')`,
      [challengeId, person.user_id, options.challenge, origin, input.to.toLowerCase(), input.amount_atomic, positionOf(input.asset)]);
    return { challenge_id: challengeId, options };
  });
}
