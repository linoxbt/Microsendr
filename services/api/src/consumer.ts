import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { id, pool, transaction } from '../../../packages/database/src/index.js';
import { hashKey } from '../../../packages/payments/src/auth.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { publicSettlement } from '../../../packages/settlement/src/service.js';
import { ensureManagedWallet } from './managed-wallet.js';

type Person = { user_id: string; account_id: string; csrf_token: string };
type Dependencies = {
  required: (request: FastifyRequest, write?: boolean) => Promise<Person>;
  origin: (request: FastifyRequest) => string;
  setCookie: (request: FastifyRequest, reply: FastifyReply, token: string) => void;
  emailEnabled: boolean;
};
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, 'Use at least 12 characters').max(128);
const name = z.string().trim().min(1).max(80);
const country = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .refine((value) => {
    try {
      return (
        new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(value) !== undefined
      );
    } catch {
      return false;
    }
  }, 'Choose a country');
const dateOfBirth = z.iso.date().refine((value) => {
  const birth = new Date(value),
    cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
  return birth <= cutoff && birth.getUTCFullYear() >= 1900;
}, 'You must be at least 18');
const profileSchema = z
  .object({
    first_name: name,
    last_name: name,
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{2,23}$/, 'Use 3–24 letters, numbers or underscores'),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{6,14}$/, 'Include the country code, for example +234'),
    residence_country: country,
    nationality: country.nullable().optional(),
    date_of_birth: dateOfBirth,
    address_line1: z.string().trim().min(3).max(160),
    address_line2: z.string().trim().max(160).default(''),
    city: z.string().trim().min(1).max(80),
    region: z.string().trim().min(1).max(80),
    postal_code: z.string().trim().max(20).default(''),
    occupation: z.string().trim().max(80).default(''),
    display_currency: z.enum(['USD', 'NGN', 'GHS', 'EUR', 'GBP']).default('USD'),
  })
  .strict();
const fields = Object.keys(profileSchema.shape);
const privateIdentityFields = [
  'first_name',
  'last_name',
  'date_of_birth',
  'residence_country',
  'nationality',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
];
const derive = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export async function hashPassword(value: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(value, salt)).toString('hex')}`;
}
async function matches(value: string, stored: string | null) {
  const [, salt, hex] = (stored ?? '').split(':');
  const key = await derive(value, salt || 'microsendr-constant-time-missing-user');
  return !!hex && /^[a-f0-9]{128}$/.test(hex) && timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
function profile(row: Record<string, any>) {
  return Object.fromEntries(
    [
      'email',
      'email_verified_at',
      'phone_verified_at',
      'profile_version',
      'created_at',
      ...fields,
    ].map((key) => [
      key,
      key === 'date_of_birth' && row[key] instanceof Date
        ? `${row[key].getFullYear()}-${String(row[key].getMonth() + 1).padStart(2, '0')}-${String(row[key].getDate()).padStart(2, '0')}`
        : (row[key] ?? null),
    ]),
  );
}
async function newSession(userId: string, method: string) {
  const token = randomBytes(32).toString('hex'),
    csrf = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 day',$4)",
    [hashKey(token), userId, csrf, method],
  );
  return { token, csrf };
}
function conflict() {
  return new PaymentError(
    409,
    'account_details_unavailable',
    'These account details are already in use. Sign in or choose another username.',
  );
}

export function registerConsumer(app: FastifyInstance, deps: Dependencies) {
  // All consumer account responses contain private data and must bypass shared caches.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/personal/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.get('/personal/api/registration/config', async () => ({
    method: 'password',
    email_verification_available: deps.emailEnabled,
  }));
  app.post(
    '/personal/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      deps.origin(request);
      const input = profileSchema.extend({ email, password }).strict().parse(request.body);
      const passwordHash = await hashPassword(input.password);
      let userId: string;
      try {
        userId = await transaction(async (c) => {
          const user = id('usr');
          await c.query(
            `INSERT INTO personal_users(id,email,password_hash,${fields.join(',')}) VALUES(${Array.from({ length: fields.length + 3 }, (_, i) => `$${i + 1}`).join(',')})`,
            [
              user,
              input.email,
              passwordHash,
              ...fields.map((key) => input[key as keyof typeof input]),
            ],
          );
          await c.query(
            "INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)",
            [id('acct'), user],
          );
          await c.query(
            'INSERT INTO personal_profile_events(id,personal_user_id,changed_fields) VALUES($1,$2,$3)',
            [id('pev'), user, ['registration']],
          );
          return user;
        });
      } catch (cause) {
        if ((cause as { code?: string }).code === '23505') throw conflict();
        throw cause;
      }
      const s = await newSession(userId, 'password');
      deps.setCookie(request, reply, s.token);
      const account = (await pool.query('SELECT id FROM kora_accounts WHERE personal_user_id=$1', [userId])).rows[0];
      const wallet = await ensureManagedWallet(userId, account.id).catch(() => null);
      return { authenticated: true, csrf_token: s.csrf, wallet_address: wallet?.address ?? null };
    },
  );
  app.post(
    '/personal/api/auth/password',
    { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      deps.origin(request);
      const input = z
        .object({ email, password: z.string().min(1).max(128) })
        .strict()
        .parse(request.body);
      // Durable per-identity limit, in addition to the IP limit. Count before hashing.
      const attempt = await pool.query(
        `INSERT INTO personal_auth_limits(email_hash,failures) VALUES($1,1)
      ON CONFLICT(email_hash) DO UPDATE SET failures=CASE WHEN personal_auth_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE personal_auth_limits.failures+1 END,
      window_started_at=CASE WHEN personal_auth_limits.window_started_at < now()-interval '15 minutes' THEN now() ELSE personal_auth_limits.window_started_at END RETURNING failures`,
        [hashKey(input.email)],
      );
      if (attempt.rows[0].failures > 10)
        throw new PaymentError(429, 'login_limited', 'Too many attempts. Try again in 15 minutes.');
      const user = (
        await pool.query(
          `SELECT u.id,u.password_hash,a.status FROM personal_users u JOIN kora_accounts a ON a.personal_user_id=u.id WHERE u.email=$1`,
          [input.email],
        )
      ).rows[0];
      if (!(await matches(input.password, user?.password_hash)) || user?.status !== 'active')
        throw new PaymentError(401, 'invalid_credentials', 'Email or password is incorrect.');
      // Serialize issuance with password rotation/email recovery. A login that
      // checked an old password must not create a session after revocation.
      const s = await transaction(async (c) => {
        const current = (
          await c.query('SELECT password_hash FROM personal_users WHERE id=$1 FOR UPDATE', [
            user.id,
          ])
        ).rows[0];
        if (current.password_hash !== user.password_hash)
          throw new PaymentError(401, 'invalid_credentials', 'Email or password is incorrect.');
        const token = randomBytes(32).toString('hex'),
          csrf = randomBytes(32).toString('hex');
        await c.query(
          "INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 day','password')",
          [hashKey(token), user.id, csrf],
        );
        return { token, csrf };
      });
      await pool.query('DELETE FROM personal_auth_limits WHERE email_hash=$1', [
        hashKey(input.email),
      ]);
      deps.setCookie(request, reply, s.token);
      const account = (await pool.query('SELECT id FROM kora_accounts WHERE personal_user_id=$1', [user.id])).rows[0];
      const wallet = await ensureManagedWallet(user.id, account.id).catch(() => null);
      return { authenticated: true, csrf_token: s.csrf, wallet_address: wallet?.address ?? null };
    },
  );
  app.get('/personal/api/profile', async (request) => {
    const person = await deps.required(request);
    const row = (await pool.query('SELECT * FROM personal_users WHERE id=$1', [person.user_id]))
      .rows[0];
    const check = (
      await pool.query(
        'SELECT status FROM personal_didit_sessions WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
        [person.user_id],
      )
    ).rows[0];
    return {
      ...profile(row),
      identity_status: check?.status ?? 'Not Started',
      identity_locked:
        !!check &&
        [
          'creating',
          'Not Started',
          'In Progress',
          'In Review',
          'Approved',
          'Awaiting User',
          'Resubmitted',
        ].includes(check.status),
      has_password: !!row.password_hash,
    };
  });
  app.patch('/personal/api/profile', async (request) => {
    const person = await deps.required(request, true);
    const { profile_version, ...input } = profileSchema
      .extend({ profile_version: z.number().int().positive() })
      .parse(request.body);
    try {
      return await transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `didit:${person.user_id}`,
        ]);
        const user = (
          await c.query('SELECT * FROM personal_users WHERE id=$1 FOR UPDATE', [person.user_id])
        ).rows[0];
        if (profile_version !== user.profile_version)
          throw new PaymentError(
            409,
            'profile_changed',
            'Your profile changed in another session. Refresh before saving.',
          );
        const old = profile(user);
        const changed = fields.filter(
          (key) => (old[key] ?? '') !== ((input as Record<string, unknown>)[key] ?? ''),
        );
        const latest = (
          await c.query(
            'SELECT status FROM personal_didit_sessions WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
            [person.user_id],
          )
        ).rows[0];
        if (
          latest &&
          [
            'creating',
            'Not Started',
            'In Progress',
            'Awaiting User',
            'In Review',
            'Approved',
            'Resubmitted',
          ].includes(latest.status) &&
          changed.some((key) => privateIdentityFields.includes(key))
        )
          throw new PaymentError(
            409,
            'identity_locked',
            'Identity details are locked during and after verification. Contact support to correct them.',
          );
        await c.query(
          `UPDATE personal_users SET ${fields.map((key, i) => `${key}=$${i + 2}`).join(',')},phone_verified_at=CASE WHEN phone=$5 THEN phone_verified_at ELSE NULL END,profile_version=profile_version+1,updated_at=now() WHERE id=$1`,
          [person.user_id, ...fields.map((key) => (input as Record<string, unknown>)[key])],
        );
        if (changed.length)
          await c.query(
            'INSERT INTO personal_profile_events(id,personal_user_id,changed_fields) VALUES($1,$2,$3)',
            [id('pev'), person.user_id, changed],
          );
        return { saved: true };
      });
    } catch (cause) {
      if ((cause as { code?: string }).code === '23505') throw conflict();
      throw cause;
    }
  });
  app.post(
    '/personal/api/profile/password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const person = await deps.required(request, true);
      const input = z
        .object({ current_password: z.string().max(128).optional(), password })
        .strict()
        .parse(request.body);
      const hash = await hashPassword(input.password);
      const nextToken = randomBytes(32).toString('hex'),
        nextCsrf = randomBytes(32).toString('hex');
      await transaction(async (c) => {
        const user = (
          await c.query('SELECT password_hash FROM personal_users WHERE id=$1 FOR UPDATE', [
            person.user_id,
          ])
        ).rows[0];
        const current = (
          await c.query(
            'SELECT auth_method,created_at FROM personal_sessions WHERE token_hash=$1 AND expires_at>now()',
            [hashKey(request.cookies.kora_personal!)],
          )
        ).rows[0];
        const recovery =
          ['email', 'restore'].includes(current?.auth_method) &&
          Date.now() - new Date(current.created_at).getTime() < 600000;
        if (
          !current ||
          (!recovery && !(await matches(input.current_password ?? '', user.password_hash)))
        )
          throw new PaymentError(
            401,
            'reauth_required',
            'Enter your current password or sign in with a fresh email code.',
          );
        await c.query('UPDATE personal_users SET password_hash=$2,updated_at=now() WHERE id=$1', [
          person.user_id,
          hash,
        ]);
        await c.query('DELETE FROM personal_sessions WHERE personal_user_id=$1', [person.user_id]);
        await c.query(
          "INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at,auth_method) VALUES($1,$2,$3,now()+interval '1 day','password')",
          [hashKey(nextToken), person.user_id, nextCsrf],
        );
      });
      deps.setCookie(request, reply, nextToken);
      return { saved: true, csrf_token: nextCsrf };
    },
  );
  app.get('/personal/api/overview', async (request) => {
    const person = await deps.required(request);
    const rows = (
      await pool.query(
        'SELECT * FROM chain_settlements WHERE personal_user_id=$1 ORDER BY created_at DESC LIMIT 50',
        [person.user_id],
      )
    ).rows;
    // No consumer custodied live balances exist yet. Never reinterpret test journals or
    // wallet transfer receipts as owned digital dollars or available naira.
    return {
      balances: [],
      total: null,
      activity: rows.map(publicSettlement),
      capabilities: {
        fiat_deposit: { available: false, reason: 'Bank deposits are not available yet.' },
        crypto_deposit: {
          available: false,
          reason:
            'Your deposit account is not available yet. Do not send funds until an address and supported network are displayed.',
        },
        withdrawal: { available: false, reason: 'Bank withdrawals are not available yet.' },
        transfer: {
          available: false,
          reason: 'Transfers from your Microsendr balance are not available yet.',
        },
        conversion: {
          available: false,
          reason: 'No exchange route is available for these currencies yet.',
        },
      },
    };
  });
  app.post('/personal/api/conversion/quotes', async (request) => {
    await deps.required(request, true);
    z.object({
      source: z.enum(['USD', 'NGN']),
      destination: z.enum(['USD', 'NGN']),
      amount: z.string().regex(/^[1-9][0-9]{0,11}(?:\.[0-9]{1,2})?$/),
    })
      .strict()
      .refine((v) => v.source !== v.destination)
      .parse(request.body);
    throw new PaymentError(
      503,
      'route_unavailable',
      'An executable exchange quote is not available. No funds have been moved.',
    );
  });
}
