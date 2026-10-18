import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id, pool, transaction } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { hashKey } from '../../../packages/payments/src/auth.js';

const WORKFLOW_ID = '5045382d-f318-4cfe-8439-7b3d097adf63';
const API_URL = 'https://verification.didit.me/v3/session/';
const active = ['creating', 'Not Started', 'In Progress', 'Awaiting User', 'In Review', 'Resubmitted'];
const statuses = ['Not Started', 'In Progress', 'Awaiting User', 'In Review', 'Approved', 'Declined', 'Resubmitted', 'Abandoned', 'Expired', 'Kyc Expired'] as const;
const statusSchema = z.enum(statuses);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function verifyDiditWebhook(body: unknown, signature: string, secret: string, now = Date.now()) {
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(JSON.stringify(canonical(body)), 'utf8').digest('hex');
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return false;
  const timestamp = Number((body as Record<string, unknown> | null)?.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 && Math.abs(now / 1000 - timestamp) <= 300;
}

function allowedOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  const allowed = (process.env.KORA_CONSOLE_ORIGINS ?? 'http://127.0.0.1:4310,http://127.0.0.1:5176')
    .split(',').map(value => value.trim());
  if (typeof origin !== 'string' || !allowed.includes(origin))
    throw new PaymentError(403, 'origin_denied', 'This origin is not allowed');
  return origin;
}

async function personal(request: FastifyRequest, write = false) {
  const token = request.cookies.kora_personal;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new PaymentError(401, 'personal_login_required', 'Sign in to Personal');
  const row = (await pool.query('SELECT personal_user_id,csrf_token FROM personal_sessions WHERE token_hash=$1 AND expires_at>now()', [hashKey(token)])).rows[0];
  if (!row) throw new PaymentError(401, 'personal_login_required', 'Sign in to Personal');
  if (write) {
    allowedOrigin(request);
    const csrf = request.headers['x-kora-csrf'];
    if (typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(row.csrf_token)))
      throw new PaymentError(403, 'csrf_invalid', 'Refresh your session and try again');
  }
  return row.personal_user_id as string;
}

export function registerDidit(app: FastifyInstance) {
  app.get('/personal/api/kyc', async request => {
    const userId = await personal(request);
    const latest = (await pool.query('SELECT status,verification_url,updated_at FROM personal_didit_sessions WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [userId])).rows[0];
    return { status: latest?.status ?? 'Not Started', url: latest && active.includes(latest.status) ? latest.verification_url : null, updated_at: latest?.updated_at ?? null,
      configured: !!process.env.DIDIT_API_KEY && !!process.env.DIDIT_WEBHOOK_SECRET };
  });

  app.post('/personal/api/kyc/session', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async request => {
    const userId = await personal(request, true);
    z.object({ consent: z.literal(true) }).strict().parse(request.body);
    const apiKey = process.env.DIDIT_API_KEY;
    if (!apiKey || !process.env.DIDIT_WEBHOOK_SECRET) throw new PaymentError(503, 'kyc_unavailable', 'Identity verification is being set up');
    const origin = allowedOrigin(request);
    const recordId = id('kyc');
    await transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`didit:${userId}`]);
      const existing = (await c.query('SELECT status FROM personal_didit_sessions WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [userId])).rows[0];
      if (existing && active.includes(existing.status)) throw new PaymentError(409, 'kyc_in_progress', 'Verification is already in progress');
      if (existing?.status === 'Approved') throw new PaymentError(409, 'kyc_approved', 'Identity verification is already approved');
      await c.query('INSERT INTO personal_didit_sessions(id,personal_user_id) VALUES($1,$2)', [recordId, userId]);
    });
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow_id: WORKFLOW_ID, vendor_data: userId, callback: `${origin}/personal/profile?kyc_return=1` }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Didit session request failed');
      const session = z.object({ session_id: z.string().uuid(), url: z.string().url() }).parse(await response.json());
      if (new URL(session.url).origin !== 'https://verify.didit.me') throw new Error('Unexpected verification URL');
      await pool.query("UPDATE personal_didit_sessions SET provider_session_id=$2,verification_url=$3,status='Not Started',updated_at=now() WHERE id=$1", [recordId, session.session_id, session.url]);
      return { session_id: session.session_id, url: session.url };
    } catch {
      await pool.query("UPDATE personal_didit_sessions SET status='create_failed',updated_at=now() WHERE id=$1 AND status='creating'", [recordId]);
      throw new PaymentError(502, 'kyc_session_failed', 'Identity verification could not start. Please try again');
    }
  });

  app.post('/personal/api/webhooks/didit', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
    const secret = process.env.DIDIT_WEBHOOK_SECRET;
    if (!secret) throw new PaymentError(503, 'kyc_unavailable', 'Identity verification webhook is not configured');
    const signature = request.headers['x-signature-v2'];
    if (typeof signature !== 'string' || !verifyDiditWebhook(request.body, signature, secret))
      throw new PaymentError(401, 'invalid_signature', 'Invalid or stale webhook signature');
    const event = z.object({ event_id: z.string().min(1).max(128), session_id: z.string().uuid(), vendor_data: z.string().min(1).max(128), status: statusSchema, timestamp: z.union([z.string(), z.number()]) }).passthrough().parse(request.body);
    await transaction(async c => {
      const inserted = await c.query('INSERT INTO personal_didit_events(event_id,provider_session_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [event.event_id, event.session_id, event.status]);
      if (!inserted.rowCount) return;
      const current = (await c.query('SELECT id,status FROM personal_didit_sessions WHERE provider_session_id=$1 AND personal_user_id=$2 FOR UPDATE', [event.session_id, event.vendor_data])).rows[0];
      if (!current) return;
      // Terminal decisions cannot be overwritten by delayed progress events.
      if (['Approved', 'Declined', 'Kyc Expired'].includes(current.status) && event.status !== 'Kyc Expired') return;
      await c.query('UPDATE personal_didit_sessions SET status=$2,updated_at=now() WHERE id=$1', [current.id, event.status]);
    });
    reply.header('cache-control', 'no-store');
    return { ok: true };
  });
}
