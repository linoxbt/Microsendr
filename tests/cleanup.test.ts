import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { cleanupExpired } from '../services/worker/src/cleanup.js';

after(async () => { await pool.end(); });

test('the cleanup job removes expired sign-in material and keeps what is current', async () => {
  const userId = id('usr');
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2)', [userId, `${userId}@example.test`]);
  const old = randomBytes(32).toString('hex'), current = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES
    ($1,$3,'x',now()-interval '2 days'),($2,$3,'x',now()+interval '1 day')`, [old, current, userId]);
  const oldCode = id('pec'), freshCode = id('pec');
  await pool.query(`INSERT INTO personal_email_challenges(id,email,code_hash,expires_at) VALUES
    ($1,'a@example.test','h',now()-interval '3 days'),($2,'a@example.test','h',now()+interval '5 minutes')`, [oldCode, freshCode]);
  const oldChallenge = id('wch');
  await pool.query(`INSERT INTO personal_webauthn_challenges(id,personal_user_id,purpose,challenge,origin,expires_at)
    VALUES($1,$2,'register','c','https://example.test',now()-interval '2 days')`, [oldChallenge, userId]);
  const staleLimit = `cleanup:${userId}`, liveLimit = `cleanup-live:${userId}`;
  await pool.query(`INSERT INTO personal_auth_limits(email_hash,failures,window_started_at) VALUES
    ($1,3,now()-interval '2 days'),($2,1,now())`, [staleLimit, liveLimit]);

  assert.equal(await cleanupExpired(true), true);
  const left = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rowCount;
  assert.equal(await left('SELECT 1 FROM personal_sessions WHERE token_hash=$1', [old]), 0);
  assert.equal(await left('SELECT 1 FROM personal_sessions WHERE token_hash=$1', [current]), 1);
  assert.equal(await left('SELECT 1 FROM personal_email_challenges WHERE id=$1', [oldCode]), 0);
  assert.equal(await left('SELECT 1 FROM personal_email_challenges WHERE id=$1', [freshCode]), 1);
  assert.equal(await left('SELECT 1 FROM personal_webauthn_challenges WHERE id=$1', [oldChallenge]), 0);
  assert.equal(await left('SELECT 1 FROM personal_auth_limits WHERE email_hash=$1', [staleLimit]), 0);
  assert.equal(await left('SELECT 1 FROM personal_auth_limits WHERE email_hash=$1', [liveLimit]), 1);
  // Not forced and just run: it waits for its interval.
  assert.equal(await cleanupExpired(), false);
});
