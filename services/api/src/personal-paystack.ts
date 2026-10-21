import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PaystackClient, transferSchema } from '../../../connectors/paystack/src/index.js';
import { wireId, wireMinor } from '../../../connectors/paystack/src/client.js';
import { id, pool, transaction, type Client } from '../../../packages/database/src/index.js';
import { postJournal } from '../../../packages/ledger/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { checkoutClosed } from '../../../packages/rails/src/index.js';

type Person = { user_id: string; account_id: string; email: string | null; kyc_state: string };
type Dependencies = {
  required: (request: FastifyRequest, write?: boolean) => Promise<Person>;
  origin: (request: FastifyRequest) => string;
  client?: PaystackClient;
};

const amountSchema = z.string().regex(/^[1-9][0-9]{0,11}$/).refine(value => BigInt(value) <= 100000000000n);
const operationId = z.string().regex(/^pop_[a-f0-9]{32}$/);
const ngn = 'pos_ngn_fiat';
const available = (account: string) => `personal:${account}:NGN:available`;
const held = (account: string) => `personal:${account}:NGN:paystack_held`;
const clearing = 'sys:NGN:clearing';
const fees = 'sys:NGN:provider_fees';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptSchema = z.object({
  id: wireId, domain: z.literal('test'), reference: z.string(), currency: z.literal('NGN'),
  amount: wireMinor, status: z.string(), fees: wireMinor.nullable().optional(),
  customer: z.object({ email: z.string().email() }),
});

async function accounts(c: Client, account: string) {
  await c.query('INSERT INTO ledger_accounts(id,owner_account_id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [held(account), account, ngn, 'NGN', 'reserved']);
  await c.query('INSERT INTO ledger_accounts(id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [clearing,ngn,'NGN','clearing']);
  await c.query('INSERT INTO ledger_accounts(id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [fees,ngn,'NGN','provider_fees']);
}

function publicOperation(row: Record<string, any>) {
  return {
    id: row.id, kind: row.kind, amount_minor: String(row.amount_minor), currency: 'NGN',
    status: row.status, provider: 'paystack-test', simulated: true,
    checkout_url: row.checkout_url ?? null,
    bank_name: row.bank_name ?? null, bank_last4: row.bank_last4 ?? null,
    provider_fee_minor: row.provider_fee_minor === null ? null : String(row.provider_fee_minor),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function idempotencyKey(request: FastifyRequest) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
  return key;
}

export async function registerPersonalPaystack(app: FastifyInstance, dependencies: Dependencies) {
  const provider = () => {
    if (dependencies.client) return dependencies.client;
    if (!PaystackClient.configured())
      throw new PaymentError(503, 'provider_not_configured', 'Paystack test mode is not configured');
    return PaystackClient.fromEnvironment();
  };
  const eligible = async (request: FastifyRequest, write = false) => {
    const person = await dependencies.required(request, write);
    if (person.kyc_state !== 'sandbox_approved')
      throw new PaymentError(403, 'sandbox_verification_required', 'Enable Personal sandbox access first');
    return person;
  };
  const owned = async (person: Person, operation: string, kind: 'collection' | 'withdrawal') => {
    const row = (await pool.query(
      'SELECT * FROM personal_paystack_operations WHERE id=$1 AND personal_user_id=$2 AND kind=$3',
      [operationId.parse(operation), person.user_id, kind],
    )).rows[0];
    if (!row) throw new PaymentError(404, 'operation_not_found', 'Operation not found');
    if (row.provider_binding !== provider().binding)
      throw new PaymentError(409, 'provider_binding_mismatch', 'This operation needs provider credential review');
    return row;
  };

  app.get('/personal/api/paystack/config', async (request) => {
    await dependencies.required(request);
    return { configured: !!dependencies.client || PaystackClient.configured(), mode: 'test', currency: 'NGN', simulated: true };
  });
  app.get('/personal/api/paystack/banks', async (request) => {
    await eligible(request);
    return { data: (await provider().banks()).filter(bank => bank.active && bank.currency === 'NGN') };
  });
  app.post('/personal/api/paystack/resolve', async (request) => {
    await eligible(request, true);
    const input = z.object({ bank_code: z.string().regex(/^[0-9]{2,8}$/), account_number: z.string().regex(/^[0-9]{10}$/) }).strict().parse(request.body);
    const result = await provider().resolveAccount(input.account_number,input.bank_code);
    return { account_name: result.account_name, bank_last4: input.account_number.slice(-4), mode: 'test' };
  });
  app.get('/personal/api/paystack/operations', async (request) => {
    const person = await dependencies.required(request);
    const rows = (await pool.query('SELECT * FROM personal_paystack_operations WHERE personal_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [person.user_id])).rows;
    return { data: rows.map(publicOperation) };
  });

  app.post('/personal/api/paystack/collections', async (request) => {
    const person = await eligible(request, true);
    if (!person.email) throw new PaymentError(403, 'verified_email_required', 'Link a verified email before starting a collection');
    const key = idempotencyKey(request), client = provider();
    const { amount_minor } = z.object({ amount_minor: amountSchema }).strict().parse(request.body);
    const fingerprint = digest(JSON.stringify({ amount_minor, email: person.email }));
    const row = await transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-paystack:collection:${person.user_id}:${key}`]);
      const existing = (await c.query("SELECT * FROM personal_paystack_operations WHERE personal_user_id=$1 AND kind='collection' AND idempotency_key=$2", [person.user_id,key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new PaymentError(409, 'idempotency_conflict', 'Request key was used for another payment');
        return existing;
      }
      const operation = id('pop');
      return (await c.query("INSERT INTO personal_paystack_operations(id,personal_user_id,account_id,kind,amount_minor,reference,idempotency_key,request_fingerprint,provider_binding) VALUES($1,$2,$3,'collection',$4,$5,$6,$7,$8) RETURNING *",
        [operation,person.user_id,person.account_id,amount_minor,`ms${operation.replaceAll('_','')}`,key,fingerprint,client.binding])).rows[0];
    });
    if (row.status !== 'created') return publicOperation(row);
    const claimed = (await pool.query("UPDATE personal_paystack_operations SET status='submitting',updated_at=now() WHERE id=$1 AND status='created' RETURNING id", [row.id])).rowCount;
    if (!claimed) return publicOperation((await pool.query('SELECT * FROM personal_paystack_operations WHERE id=$1', [row.id])).rows[0]);
    try {
      const result = await client.initializeCollection({ reference: row.reference, amount: String(row.amount_minor), email: person.email, callbackUrl: `${dependencies.origin(request)}/personal/money` });
      await pool.query("UPDATE personal_paystack_operations SET status='checkout_ready',checkout_url=$2,updated_at=now() WHERE id=$1 AND status='submitting'", [row.id,result.authorization_url]);
    } catch {
      await pool.query("UPDATE personal_paystack_operations SET status='unknown',updated_at=now() WHERE id=$1 AND status='submitting'", [row.id]);
    }
    return publicOperation((await pool.query('SELECT * FROM personal_paystack_operations WHERE id=$1', [row.id])).rows[0]);
  });

  app.post('/personal/api/paystack/collections/:id/verify', async (request) => {
    const person = await eligible(request, true);
    if (!person.email) throw new PaymentError(403, 'verified_email_required', 'Link a verified email before verifying a collection');
    const row = await owned(person, (request.params as {id: string}).id, 'collection');
    return verifyCollection(row, person.email, provider());
  });

  app.post('/personal/api/paystack/withdrawals', async (request) => {
    const person = await eligible(request, true), key = idempotencyKey(request), client = provider();
    const input = z.object({ amount_minor: amountSchema, bank_code: z.string().regex(/^[0-9]{2,8}$/), account_number: z.string().regex(/^[0-9]{10}$/) }).strict().parse(request.body);
    const accountHash = digest(`${input.bank_code}:${input.account_number}`);
    const fingerprint = digest(JSON.stringify({ amount_minor: input.amount_minor, bank_code: input.bank_code, accountHash }));
    const previous = (await pool.query("SELECT * FROM personal_paystack_operations WHERE personal_user_id=$1 AND kind='withdrawal' AND idempotency_key=$2", [person.user_id,key])).rows[0];
    if (previous) {
      if (previous.request_fingerprint !== fingerprint) throw new PaymentError(409, 'idempotency_conflict', 'Request key was used for another payout');
      return publicOperation(previous);
    }
    const resolved = await client.resolveAccount(input.account_number,input.bank_code);
    const recipient = await client.createRecipient({ account_number: input.account_number, bank_code: input.bank_code, name: resolved.account_name });
    const row = await transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-paystack:withdrawal:${person.user_id}:${key}`]);
      const existing = (await c.query("SELECT * FROM personal_paystack_operations WHERE personal_user_id=$1 AND kind='withdrawal' AND idempotency_key=$2", [person.user_id,key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new PaymentError(409, 'idempotency_conflict', 'Request key was used for another payout');
        return existing;
      }
      await accounts(c,person.account_id);
      const operation = id('pop');
      const journal = await postJournal(c, { reference: `personal:paystack:reserve:${operation}`, description: 'Reserve simulated NGN for Paystack test payout', entries: [
        { account_id: available(person.account_id), side: 'credit', amount: input.amount_minor },
        { account_id: held(person.account_id), side: 'debit', amount: input.amount_minor },
      ] });
      return (await c.query("INSERT INTO personal_paystack_operations(id,personal_user_id,account_id,kind,amount_minor,reference,idempotency_key,request_fingerprint,provider_binding,recipient_code,bank_code,bank_last4,bank_account_hash,bank_name,reserve_journal_id) VALUES($1,$2,$3,'withdrawal',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
        [operation,person.user_id,person.account_id,input.amount_minor,`ms${operation.replaceAll('_','')}`,key,fingerprint,client.binding,recipient.recipient_code,input.bank_code,input.account_number.slice(-4),accountHash,resolved.account_name,journal])).rows[0];
    });
    if (row.status !== 'created') return publicOperation(row);
    const claimed = (await pool.query("UPDATE personal_paystack_operations SET status='submitting',updated_at=now() WHERE id=$1 AND status='created' RETURNING id", [row.id])).rowCount;
    if (!claimed) return publicOperation((await pool.query('SELECT * FROM personal_paystack_operations WHERE id=$1', [row.id])).rows[0]);
    try {
      const ack = z.object({ domain: z.literal('test'), reference: z.string(), currency: z.literal('NGN'), amount: wireMinor }).parse(await client.request('POST','/transfer', {
        source: 'balance', currency: 'NGN', amount: Number(row.amount_minor), recipient: row.recipient_code, reference: row.reference, reason: 'Microsendr test-mode payout',
      }));
      if (ack.reference !== row.reference || ack.amount !== String(row.amount_minor)) throw new Error('Payout acknowledgement mismatch');
      await pool.query("UPDATE personal_paystack_operations SET status='pending',updated_at=now() WHERE id=$1 AND status='submitting'", [row.id]);
    } catch {
      // Never retry a submission after an ambiguous response. Verify by immutable reference.
      await pool.query("UPDATE personal_paystack_operations SET status='unknown',updated_at=now() WHERE id=$1 AND status='submitting'", [row.id]);
    }
    return publicOperation((await pool.query('SELECT * FROM personal_paystack_operations WHERE id=$1', [row.id])).rows[0]);
  });

  app.post('/personal/api/paystack/withdrawals/:id/verify', async (request) => {
    const person = await eligible(request, true);
    const row = await owned(person,(request.params as {id: string}).id,'withdrawal');
    return verifyWithdrawal(row, provider());
  });
}

// Shared by the verify routes and the worker sweeper, so a crash or an unclicked
// verify never leaves an operation (or its reserved funds) stuck.
async function verifyCollection(row: Record<string, any>, email: string, client: PaystackClient) {
  if (row.status === 'completed' || row.status === 'failed') return publicOperation(row);
  const raw = await client.verifyCollection(row.reference);
  if (raw === null) return publicOperation(row);
  const receipt = receiptSchema.parse(raw);
  if (receipt.reference !== row.reference || receipt.amount !== String(row.amount_minor) || receipt.customer.email.toLowerCase() !== email.toLowerCase())
    throw new PaymentError(422, 'receipt_mismatch', 'Payment evidence does not match this instruction');
  if (!['success','failed','abandoned'].includes(receipt.status)) return publicOperation(row);
  // An unfinished checkout reads as abandoned; it is final only once the window closes.
  if (receipt.status === 'abandoned' && !checkoutClosed(row.created_at)) return publicOperation(row);
  return transaction(async (c) => {
    const current = (await c.query('SELECT * FROM personal_paystack_operations WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (current.status === 'completed' || current.status === 'failed') return publicOperation(current);
    if (receipt.status !== 'success') {
      const failed = (await c.query("UPDATE personal_paystack_operations SET status='failed',provider_id=$2,updated_at=now() WHERE id=$1 RETURNING *", [row.id,receipt.id])).rows[0];
      return publicOperation(failed);
    }
    if (receipt.fees === null || receipt.fees === undefined || BigInt(receipt.fees) >= BigInt(receipt.amount))
      throw new PaymentError(422, 'receipt_mismatch', 'Provider fee evidence is incomplete');
    await accounts(c, row.account_id);
    const net = (BigInt(receipt.amount)-BigInt(receipt.fees)).toString();
    const entries: {account_id: string; side: 'debit'|'credit'; amount: string}[] = [
      { account_id: available(row.account_id), side: 'debit', amount: net },
      { account_id: clearing, side: 'credit', amount: receipt.amount },
    ];
    if (BigInt(receipt.fees)>0n) entries.push({ account_id: fees, side: 'debit', amount: receipt.fees });
    const journal = await postJournal(c, { reference: `personal:paystack:collection:${row.id}`, description: 'Verified Paystack test collection and provider fee', entries });
    const completed = (await c.query("UPDATE personal_paystack_operations SET status='completed',provider_id=$2,provider_fee_minor=$3,journal_id=$4,updated_at=now() WHERE id=$1 RETURNING *", [row.id,receipt.id,receipt.fees,journal])).rows[0];
    return publicOperation(completed);
  });
}

async function verifyWithdrawal(row: Record<string, any>, client: PaystackClient) {
  if (row.status === 'failed' || row.status === 'returned') return publicOperation(row);
  const raw = await client.verifyTransfer(row.reference);
  if (raw === null) {
    // Paystack has no transfer with this immutable reference: after an hour the
    // submission never reached it, so the reservation is released.
    if (['submitting','unknown'].includes(row.status) && Date.now() - new Date(row.created_at).getTime() > 60 * 60_000)
      return transaction(async (c) => {
        const current = (await c.query('SELECT * FROM personal_paystack_operations WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
        if (!['submitting','unknown'].includes(current.status)) return publicOperation(current);
        await accounts(c,row.account_id);
        const journal = await postJournal(c,{ reference: `personal:paystack:release:${row.id}`, description: 'Release unsubmitted Paystack test payout reservation', entries: [
          { account_id: held(row.account_id), side: 'credit', amount: String(row.amount_minor) },
          { account_id: available(row.account_id), side: 'debit', amount: String(row.amount_minor) },
        ] });
        return publicOperation((await c.query("UPDATE personal_paystack_operations SET status='failed',return_journal_id=$2,updated_at=now() WHERE id=$1 RETURNING *",[row.id,journal])).rows[0]);
      });
    return publicOperation(row);
  }
  const receipt = transferSchema.parse(raw);
  if (receipt.reference !== row.reference || receipt.amount !== String(row.amount_minor) ||
      receipt.recipient.recipient_code !== row.recipient_code || receipt.recipient.details.bank_code !== row.bank_code ||
      digest(`${row.bank_code}:${receipt.recipient.details.account_number}`) !== row.bank_account_hash)
    throw new PaymentError(422,'receipt_mismatch','Payout evidence does not match this instruction');
  if (!['success','failed','abandoned','rejected','reversed'].includes(receipt.status)) return publicOperation(row);
  return transaction(async (c) => {
    const current = (await c.query('SELECT * FROM personal_paystack_operations WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (current.status === 'failed' || current.status === 'returned') return publicOperation(current);
    await accounts(c,row.account_id);
    if (receipt.status === 'success') {
      if (current.status === 'completed') return publicOperation(current);
      const entries: {account_id: string; side: 'debit'|'credit'; amount: string}[] = [
        { account_id: held(row.account_id), side: 'credit', amount: receipt.amount },
        { account_id: clearing, side: 'debit', amount: receipt.amount },
      ];
      if (BigInt(receipt.fee_charged)>0n) {
        entries.push({ account_id: fees, side: 'debit', amount: receipt.fee_charged });
        entries.push({ account_id: clearing, side: 'credit', amount: receipt.fee_charged });
      }
      const journal = await postJournal(c,{ reference: `personal:paystack:payout:${row.id}`, description: 'Verified Paystack test payout and provider fee', entries });
      return publicOperation((await c.query("UPDATE personal_paystack_operations SET status='completed',provider_id=$2,provider_fee_minor=$3,journal_id=$4,updated_at=now() WHERE id=$1 RETURNING *",[row.id,receipt.id,receipt.fee_charged,journal])).rows[0]);
    }
    if (current.status === 'completed') {
      if (receipt.status !== 'reversed') throw new PaymentError(409,'provider_state_conflict','Completed payout needs an operator review');
      const journal = await postJournal(c,{ reference: `personal:paystack:return:${row.id}`, description: 'Verified Paystack test payout return', entries: [
        { account_id: available(row.account_id), side: 'debit', amount: receipt.amount },
        { account_id: clearing, side: 'credit', amount: receipt.amount },
      ] });
      return publicOperation((await c.query("UPDATE personal_paystack_operations SET status='returned',return_journal_id=$2,updated_at=now() WHERE id=$1 RETURNING *",[row.id,journal])).rows[0]);
    }
    const journal = await postJournal(c,{ reference: `personal:paystack:release:${row.id}`, description: 'Release failed Paystack test payout reservation', entries: [
      { account_id: held(row.account_id), side: 'credit', amount: receipt.amount },
      { account_id: available(row.account_id), side: 'debit', amount: receipt.amount },
    ] });
    return publicOperation((await c.query("UPDATE personal_paystack_operations SET status=$2,provider_id=$3,provider_fee_minor=$4,return_journal_id=$5,updated_at=now() WHERE id=$1 RETURNING *",[row.id,receipt.status==='reversed'?'returned':'failed',receipt.id,receipt.fee_charged,journal])).rows[0]);
  });
}

/** Worker job: verify one stale in-flight Personal Paystack operation. */
export async function reconcileOnePersonalPaystack(client?: PaystackClient) {
  if (!client && !PaystackClient.configured()) return false;
  const provider = client ?? PaystackClient.fromEnvironment();
  const row = (await pool.query(`UPDATE personal_paystack_operations SET updated_at=now()
    WHERE id=(SELECT id FROM personal_paystack_operations
      WHERE status IN ('submitting','checkout_ready','pending','unknown') AND provider_binding=$1 AND updated_at<now()-interval '5 minutes'
      ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [provider.binding])).rows[0];
  if (!row) return false;
  if (row.kind === 'withdrawal') await verifyWithdrawal(row, provider);
  else {
    const owner = (await pool.query('SELECT email FROM personal_users WHERE id=$1', [row.personal_user_id])).rows[0];
    if (owner?.email) await verifyCollection(row, owner.email, provider);
  }
  return true;
}
