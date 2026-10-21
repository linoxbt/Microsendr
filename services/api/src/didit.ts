import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { id, pool, transaction, type Client } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { requireOrigin } from './config.js';
import { required as requiredPersonal } from './personal.js';

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

// Didit shares the Personal session check, including the active-account requirement.
async function personal(request: FastifyRequest, write = false) {
  return (await requiredPersonal(request, write)).user_id;
}

// Terminal decisions cannot be overwritten by delayed progress events.
async function applyStatus(c: Client, current: { id: string; status: string }, status: string) {
  if (['Approved', 'Declined', 'Kyc Expired'].includes(current.status) && status !== 'Kyc Expired') return;
  if (current.status === status) return;
  await c.query('UPDATE personal_didit_sessions SET status=$2,updated_at=now() WHERE id=$1', [current.id, status]);
}

/** Worker job: fetch the decision for a session whose webhook may have been missed. */
export async function reconcileOneDiditSession(request: typeof fetch = fetch) {
  const apiKey = process.env.DIDIT_API_KEY;
  // A session left in 'creating' by a crash would otherwise block new attempts forever.
  await pool.query("UPDATE personal_didit_sessions SET status='create_failed',updated_at=now() WHERE status='creating' AND created_at<now()-interval '10 minutes'");
  if (!apiKey) return false;
  const due = (await pool.query(`UPDATE personal_didit_sessions SET updated_at=now()
    WHERE id=(SELECT id FROM personal_didit_sessions WHERE provider_session_id IS NOT NULL
      AND status IN ('Not Started','In Progress','Awaiting User','In Review','Resubmitted')
      AND updated_at<now()-interval '10 minutes' ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,provider_session_id`)).rows[0];
  if (!due) return false;
  const response = await request(`${API_URL}${due.provider_session_id}/decision/`, {
    headers: { 'x-api-key': apiKey }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new PaymentError(502, 'kyc_decision_unavailable', `Didit decision lookup returned ${response.status}`);
  const { status } = z.object({ status: statusSchema }).passthrough().parse(await response.json());
  await transaction(async c => {
    const current = (await c.query('SELECT id,status FROM personal_didit_sessions WHERE id=$1 FOR UPDATE', [due.id])).rows[0];
    if (current) await applyStatus(c, current, status);
  });
  return true;
}

export function registerDidit(app: FastifyInstance) {
  app.get('/personal/api/kyc', async request => {
    const userId = await personal(request);
    const latest = (await pool.query('SELECT status,verification_url,updated_at FROM personal_didit_sessions WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [userId])).rows[0];
    const identity = (await pool.query('SELECT email_verified_at FROM personal_users WHERE id=$1',[userId])).rows[0];
    return { email_verified: !!identity.email_verified_at, status: latest?.status ?? 'Not Started', url: latest && active.includes(latest.status) ? latest.verification_url : null, updated_at: latest?.updated_at ?? null,
      configured: !!process.env.DIDIT_API_KEY && !!process.env.DIDIT_WEBHOOK_SECRET };
  });

  app.post('/personal/api/kyc/session', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async request => {
    const userId = await personal(request, true);
    z.object({ consent: z.literal(true) }).strict().parse(request.body);
    const owner = (await pool.query('SELECT email_verified_at FROM personal_users WHERE id=$1',[userId])).rows[0];
    if (!owner.email_verified_at) throw new PaymentError(403,'verified_email_required','Verify your email before starting identity verification.');
    const apiKey = process.env.DIDIT_API_KEY;
    if (!apiKey || !process.env.DIDIT_WEBHOOK_SECRET) throw new PaymentError(503, 'kyc_unavailable', 'Identity verification is being set up');
    const origin = requireOrigin(request);
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
    const event = z.object({ event_id: z.string().min(1).max(128).optional(), session_id: z.string().uuid(), vendor_data: z.string().min(1).max(128), status: statusSchema, timestamp: z.union([z.string(), z.number()]) }).passthrough().parse(request.body);
    // Didit payloads are not guaranteed to carry an event id; the signed session,
    // status and timestamp identify a delivery just as well.
    const eventId = event.event_id ?? `sha256:${createHash('sha256').update(`${event.session_id}|${event.status}|${event.timestamp}`).digest('hex')}`;
    await transaction(async c => {
      const inserted = await c.query('INSERT INTO personal_didit_events(event_id,provider_session_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [eventId, event.session_id, event.status]);
      if (!inserted.rowCount) return;
      const current = (await c.query('SELECT id,status FROM personal_didit_sessions WHERE provider_session_id=$1 AND personal_user_id=$2 FOR UPDATE', [event.session_id, event.vendor_data])).rows[0];
      if (current) await applyStatus(c, current, event.status);
    });
    reply.header('cache-control', 'no-store');
    return { ok: true };
  });
}
