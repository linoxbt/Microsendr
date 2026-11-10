import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { hashPassword } from '../services/api/src/consumer.js';
import { buildApi } from '../services/api/src/app.js';

const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
after(async () => { await app.close(); await pool.end(); });
const origin = 'http://127.0.0.1:4310';
const hex = (n: number) => randomBytes(n).toString('hex');
const password = 'correct-horse-battery';
const to = `0x${hex(20)}`;

async function member() {
  const userId = id('usr'), accountId = id('acct'), token = hex(32), csrf = hex(32);
  await pool.query('INSERT INTO personal_users(id,email,username,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
    [userId, `${userId}@example.test`, `pa_${hex(4)}`, await hashPassword(password)]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), userId, csrf]);
  const headers = { origin, cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf };
  // Each call comes from its own address so the per-IP route limits do not interfere.
  const remoteAddress = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: remoteAddress() });
  return { userId, headers, post };
}
const send = (who: Awaited<ReturnType<typeof member>>, approval: object, amount = '1000') =>
  who.post('/personal/api/wallets/managed/transfers', { to, amount_atomic: amount, ...approval });

test('a payment PIN needs the password, refuses easy PINs and approves sends', async () => {
  const who = await member();
  assert.equal((await send(who, { pin: '402913' })).json().error.code, 'pin_not_set');
  assert.equal((await who.post('/personal/api/payment-auth/pin', { pin: '402913', password: 'wrong-password-xx' })).json().error.code, 'invalid_password');
  for (const weak of ['111111', '123456', '987654'])
    assert.equal((await who.post('/personal/api/payment-auth/pin', { pin: weak, password })).json().error.code, 'weak_pin');
  const set = await who.post('/personal/api/payment-auth/pin', { pin: '402913', password });
  assert.equal(set.statusCode, 200, set.body);
  const stored = (await pool.query('SELECT payment_pin_hash FROM personal_users WHERE id=$1', [who.userId])).rows[0].payment_pin_hash;
  assert.ok(stored.startsWith('scrypt2:') && !stored.includes('402913'));
  const status = await app.inject({ url: '/personal/api/payment-auth', headers: who.headers });
  assert.equal(status.json().pin_set, true);
  // The right PIN gets past approval; sending itself is off in this environment.
  assert.equal((await send(who, { pin: '402913' })).json().error.code, 'managed_transfers_unavailable');
  const wrong = await send(who, { pin: '000001' });
  assert.equal(wrong.statusCode, 401);
  assert.match(wrong.json().error.message, /4 tries left/);
  // Only one way of approving at a time.
  assert.equal((await send(who, { pin: '402913', password })).statusCode, 400);
});

test('five wrong PINs lock the PIN, even for the right one', async () => {
  const who = await member();
  await who.post('/personal/api/payment-auth/pin', { pin: '583920', password });
  for (let i = 0; i < 4; i++) assert.equal((await send(who, { pin: '111112' })).statusCode, 401);
  assert.equal((await send(who, { pin: '111112' })).json().error.code, 'pin_locked');
  assert.equal((await send(who, { pin: '583920' })).json().error.code, 'pin_locked');
  // Setting a new PIN with the password clears the lock.
  await who.post('/personal/api/payment-auth/pin', { pin: '583921', password });
  assert.equal((await send(who, { pin: '583921' })).json().error.code, 'managed_transfers_unavailable');
});

// ---- A software passkey: ES256 key, "none" attestation, user verified. ----
const b64url = (value: Buffer | Uint8Array | string) => Buffer.from(value).toString('base64url');
function cborBytes(bytes: Buffer) {
  const n = bytes.length;
  const head = n < 24 ? Buffer.from([0x40 | n]) : n < 256 ? Buffer.from([0x58, n]) : Buffer.from([0x59, n >> 8, n & 255]);
  return Buffer.concat([head, bytes]);
}
const cborText = (text: string) => Buffer.concat([Buffer.from([0x60 | text.length]), Buffer.from(text)]);
function softwarePasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  const rpHash = createHash('sha256').update('127.0.0.1').digest();
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), cborBytes(Buffer.from(jwk.x, 'base64url')),
    Buffer.from([0x22]), cborBytes(Buffer.from(jwk.y, 'base64url'))]);
  let count = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64url(credentialId),
    register(challenge: string) {
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([0, credentialId.length]), credentialId, cose]);
      const attestation = Buffer.concat([Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)]);
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64url(clientData('webauthn.create', challenge)), attestationObject: b64url(attestation), transports: ['internal'] } };
    },
    assert(challenge: string) {
      count += 1;
      const counter = Buffer.alloc(4); counter.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counter]);
      const data = clientData('webauthn.get', challenge);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(data).digest()]), privateKey);
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64url(data), authenticatorData: b64url(authData), signature: b64url(signature) } };
    },
  };
}

test('a passkey approves only the payment it was asked for, once', async () => {
  const who = await member();
  const key = softwarePasskey();
  assert.equal((await who.post('/personal/api/payment-auth/passkeys/options', { password: 'nope-not-it-123' })).json().error.code, 'invalid_password');
  const options = (await who.post('/personal/api/payment-auth/passkeys/options', { password })).json();
  assert.equal(options.options.rp.id, '127.0.0.1');
  const added = await who.post('/personal/api/payment-auth/passkeys', { challenge_id: options.challenge_id, response: key.register(options.options.challenge), label: 'Test phone' });
  assert.equal(added.statusCode, 200, added.body);
  // A registration challenge cannot be used twice.
  assert.equal((await who.post('/personal/api/payment-auth/passkeys', { challenge_id: options.challenge_id, response: key.register(options.options.challenge) })).statusCode, 400);

  const challenge = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json();
  const assertion = key.assert(challenge.options.challenge);
  const approved = await send(who, { passkey: { challenge_id: challenge.challenge_id, response: assertion } });
  assert.equal(approved.json().error.code, 'managed_transfers_unavailable', approved.body);
  // Replaying the same approval fails.
  assert.equal((await send(who, { passkey: { challenge_id: challenge.challenge_id, response: assertion } })).json().error.code, 'passkey_rejected');
  // An approval for 1000 cannot send 2000.
  const other = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json();
  assert.equal((await send(who, { passkey: { challenge_id: other.challenge_id, response: key.assert(other.options.challenge) } }, '2000')).json().error.code, 'passkey_mismatch');
  // An approval for QIE cannot send the same amount of QUSDC, and a QUSDC approval works for QUSDC.
  const qieOnly = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json();
  assert.equal((await send(who, { asset: 'QUSDC', passkey: { challenge_id: qieOnly.challenge_id, response: key.assert(qieOnly.options.challenge) } })).json().error.code, 'passkey_mismatch');
  const token = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000', asset: 'QUSDC' })).json();
  assert.equal((await send(who, { asset: 'QUSDC', passkey: { challenge_id: token.challenge_id, response: key.assert(token.options.challenge) } })).json().error.code, 'managed_transfers_unavailable');
  // A signature over a different challenge is rejected.
  const third = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json();
  assert.equal((await send(who, { passkey: { challenge_id: third.challenge_id, response: key.assert(b64url(randomBytes(32))) } })).json().error.code, 'passkey_rejected');
  // Another account cannot use this account's challenge.
  const stranger = await member();
  const fourth = (await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json();
  assert.equal((await send(stranger, { passkey: { challenge_id: fourth.challenge_id, response: key.assert(fourth.options.challenge) } })).json().error.code, 'passkey_rejected');

  const listed = (await app.inject({ url: '/personal/api/payment-auth', headers: who.headers })).json();
  assert.equal(listed.passkeys.length, 1);
  assert.equal(listed.passkeys[0].label, 'Test phone');
  const removed = await app.inject({ method: 'DELETE', url: `/personal/api/payment-auth/passkeys/${listed.passkeys[0].id}`, headers: who.headers });
  assert.equal(removed.statusCode, 200);
  assert.equal((await who.post('/personal/api/payment-auth/passkeys/challenge', { to, amount_atomic: '1000' })).json().error.code, 'passkey_not_set');
});
