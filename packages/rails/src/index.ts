import { assertNewMoney, dispatchAllowed, customerReviewed } from '../../controls/src/index.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PaystackClient,
  PaystackTestConnector,
  PaystackApiError,
} from '../../../connectors/paystack/src/index.js';
import { wireId, wireMinor } from '../../../connectors/paystack/src/client.js';
import { pool, id, transaction, transactionOn, type Client } from '../../database/src/index.js';
import { postJournal, accountId } from '../../ledger/src/index.js';
import {
  createIntent,
  assertEnabled,
  publicIntent,
  recoverPaystackIntent,
  type Intent,
} from '../../payments/src/index.js';
import { PaymentError } from '../../payments/src/errors.js';
import { seal, unseal } from '../../payments/src/secrets.js';
export function collectionView(row: Record<string, any>) {
  return {
    id: row.id,
    object: 'collection',
    customer_id: row.customer_id,
    amount_minor: String(row.amount_minor),
    asset: 'NGN',
    provider: 'paystack-test',
    provider_reference: row.provider_reference,
    state: row.state,
    fee_minor: row.fee_minor === null ? null : String(row.fee_minor),
    credited_minor: row.credited_minor === null ? null : String(row.credited_minor),
    checkout_url: row.checkout_sealed
      ? JSON.parse(unseal(row.checkout_sealed)).authorization_url
      : null,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    mode: 'sandbox',
  };
}
async function customerAllowed(c: Client, m: string, customer: string) {
  await assertEnabled(c, m);
  const row = (
    await c.query(
      'SELECT verification_state FROM customers WHERE id=$1 AND merchant_id=$2 FOR SHARE',
      [customer, m],
    )
  ).rows[0];
  if (!row) throw new PaymentError(404, 'customer_not_found', 'Customer not found');
  if (row.verification_state !== 'sandbox_verified')
    throw new PaymentError(422, 'compliance_hold', 'Customer is held by a compliance decision');
}
export async function resolveBank(
  c: Client,
  m: string,
  client: PaystackClient,
  input: { account_number: string; bank_code: string },
  // Resolved before the transaction so no connection or lock waits on Paystack.
  prepared?: { account_name: string },
) {
  await assertEnabled(c, m);
  const resolved = prepared ?? (await client.resolveAccount(input.account_number, input.bank_code));
  return (
    await c.query(
      'INSERT INTO bank_resolutions(id,merchant_id,bank_code,account_last4,account_name,account_sealed,provider_binding) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,bank_code,account_last4,account_name,expires_at,created_at',
      [
        id('bres'),
        m,
        input.bank_code,
        input.account_number.slice(-4),
        resolved.account_name,
        seal(input.account_number),
        client.binding,
      ],
    )
  ).rows[0];
}
/** Paystack recipient creation is idempotent per account; call it outside any transaction. */
export async function createBankRecipient(
  db: Pick<Client, 'query'>,
  m: string,
  client: PaystackClient,
  resolutionId: string,
) {
  const r = (
    await db.query('SELECT * FROM bank_resolutions WHERE id=$1 AND merchant_id=$2 AND expires_at>now()', [
      resolutionId,
      m,
    ])
  ).rows[0];
  if (!r)
    throw new PaymentError(404, 'resolution_not_found', 'A current owned name enquiry is required');
  if (r.provider_binding !== client.binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'Name enquiry belongs to another provider credential binding',
    );
  return client.createRecipient({
    account_number: unseal(r.account_sealed),
    bank_code: r.bank_code,
    name: r.account_name,
  });
}
export async function registerBank(
  c: Client,
  m: string,
  customer: string,
  client: PaystackClient,
  input: { resolution_id: string; label: string },
  prepared?: { recipient_code: string },
) {
  await customerAllowed(c, m, customer);
  const r = (
    await c.query(
      'SELECT * FROM bank_resolutions WHERE id=$1 AND merchant_id=$2 AND expires_at>now()',
      [input.resolution_id, m],
    )
  ).rows[0];
  if (!r)
    throw new PaymentError(404, 'resolution_not_found', 'A current owned name enquiry is required');
  if (r.provider_binding !== client.binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'Name enquiry belongs to another provider credential binding',
    );
  const recipient = prepared ?? (await createBankRecipient(pool, m, client, input.resolution_id));
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `bank:${m}:${customer}:${recipient.recipient_code}`,
  ]);
  const existing = (
    await c.query(
      'SELECT * FROM bank_accounts WHERE merchant_id=$1 AND customer_id=$2 AND recipient_code=$3',
      [m, customer, recipient.recipient_code],
    )
  ).rows[0];
  if (existing) return existing;
  const instrument = id('inst');
  await c.query(
    "INSERT INTO instruments(id,merchant_id,customer_id,type,asset,label,sandbox_identifier) VALUES($1,$2,$3,'bank_account','NGN',$4,$5)",
    [instrument, m, customer, input.label, `sandbox:paystack:${recipient.recipient_code}`],
  );
  return (
    await c.query(
      'INSERT INTO bank_accounts(instrument_id,merchant_id,customer_id,resolution_id,recipient_code,bank_code,account_last4,account_name,provider_binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [
        instrument,
        m,
        customer,
        r.id,
        recipient.recipient_code,
        r.bank_code,
        r.account_last4,
        r.account_name,
        client.binding,
      ],
    )
  ).rows[0];
}
export async function localPayout(
  c: Client,
  m: string,
  input: {
    customer_id: string;
    destination_instrument_id: string;
    amount_minor: string;
    reference: string;
  },
  binding: string,
) {
  const bank = (
    await c.query(
      'SELECT provider_binding FROM bank_accounts WHERE instrument_id=$1 AND merchant_id=$2 AND customer_id=$3',
      [input.destination_instrument_id, m, input.customer_id],
    )
  ).rows[0];
  if (!bank || bank.provider_binding !== binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'A verified bank account for the configured test key is required',
    );
  await customerAllowed(c, m, input.customer_id);
  const merchant = await assertEnabled(c, m),
    total = BigInt(input.amount_minor),
    fee = (total * 50n + 9999n) / 10000n,
    principal = total - fee;
  if (
    total > BigInt(merchant.max_source_minor) ||
    total > BigInt(Number.MAX_SAFE_INTEGER) ||
    principal <= 0n
  )
    throw new PaymentError(
      422,
      'limit_exceeded',
      'Payout is outside the configured exact amount limits',
    );
  const quote = (
    await c.query(
      "INSERT INTO quotes(id,merchant_id,source_asset,destination_asset,source_minor,destination_minor,fee_minor,route,expires_at,provider) VALUES($1,$2,'NGN','NGN',$3,$4,$5,$6,now()+interval '5 minutes','paystack-test') RETURNING id",
      [
        id('qte'),
        m,
        total.toString(),
        principal.toString(),
        fee.toString(),
        JSON.stringify([
          { name: 'Domestic NGN payout', rail: 'Paystack test-mode bank transfer', asset: 'NGN' },
        ]),
      ],
    )
  ).rows[0];
  const intent = await createIntent(c, m, {
    quote_id: quote.id,
    customer_id: input.customer_id,
    destination_instrument_id: input.destination_instrument_id,
    reference: input.reference,
    type: 'transfer',
    scenario: 'success',
  });
  await c.query(
    'INSERT INTO compliance_decisions(id,merchant_id,customer_id,decision,reason,evidence) VALUES($1,$2,$3,$4,$5,$6)',
    [
      id('cd'),
      m,
      input.customer_id,
      'allow',
      'Sandbox payout preflight passed',
      {
        intent_id: intent.id,
        checks: [
          'merchant_enabled',
          'customer_not_held',
          'verified_provider_recipient',
          'transaction_limit',
        ],
        identity_checks: 'sandbox_only',
      },
    ],
  );
  return publicIntent(intent);
}
async function emitCollection(c: Client, row: Record<string, any>, type: string) {
  const eventId = id('evt');
  await c.query('INSERT INTO events(id,merchant_id,type,data) VALUES($1,$2,$3,$4)', [
    eventId,
    row.merchant_id,
    type,
    collectionView(row),
  ]);
  await c.query(
    "INSERT INTO webhook_deliveries(id,endpoint_id,event_id) SELECT $1 || '_' || id,id,$2 FROM webhook_endpoints WHERE merchant_id=$3 AND active=true ON CONFLICT DO NOTHING",
    [id('dlv'), eventId, row.merchant_id],
  );
}
export async function createCollection(
  c: Client,
  m: string,
  input: { customer_id: string; amount_minor: string; email: string },
  binding: string,
) {
  const controls = await assertNewMoney(c, m);
  if (controls.state === 'staging_active' && !(await customerReviewed(c, m, input.customer_id)))
    throw new PaymentError(
      422,
      'pilot_customer_review',
      'Current staging KYC and screening reviews are required',
    );
  await customerAllowed(c, m, input.customer_id);
  const merchant = await assertEnabled(c, m);
  if (
    BigInt(input.amount_minor) > BigInt(merchant.max_source_minor) ||
    BigInt(input.amount_minor) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new PaymentError(422, 'limit_exceeded', 'Collection exceeds the exact sandbox limit');
  const collectionId = id('col');
  const row = (
    await c.query(
      'INSERT INTO collections(id,merchant_id,customer_id,provider_reference,amount_minor,input_sealed,provider_binding) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        collectionId,
        m,
        input.customer_id,
        `kora_${collectionId}`,
        input.amount_minor,
        seal(JSON.stringify({ email: input.email })),
        binding,
      ],
    )
  ).rows[0];
  await enqueue(c, 'collection_init', collectionId);
  await emitCollection(c, row, 'collection.created');
  return collectionView(row);
}
export async function enqueue(c: Client, kind: string, resource: string) {
  // A new explicit request revokes the old lease, so its acknowledgement cannot
  // discard the requested verification. Domain locks and immutable references
  // make overlapping financial work idempotent; initialization still claims once.
  return c.query(
    'INSERT INTO outbox(id,kind,resource_id) VALUES($1,$2,$3) ON CONFLICT(resource_id,kind) WHERE resource_id IS NOT NULL DO UPDATE SET processed_at=NULL,available_at=now(),locked_by=NULL,locked_until=NULL RETURNING id',
    [id('job'), kind, resource],
  );
}
const chargeSchema = z.object({
  id: wireId,
  domain: z.literal('test'),
  reference: z.string(),
  currency: z.literal('NGN'),
  amount: wireMinor,
  status: z.string(),
  fees: wireMinor.nullable().optional(),
  customer: z.object({ email: z.string().email() }),
});
export async function verifyCollection(
  collectionId: string,
  client: PaystackClient,
): Promise<boolean> {
  const original = (await pool.query('SELECT * FROM collections WHERE id=$1', [collectionId]))
    .rows[0];
  if (!original) throw new PaymentError(404, 'collection_not_found', 'Collection not found');
  if (original.provider_binding !== client.binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'Collection belongs to another provider credential binding',
    );
  if (['succeeded', 'held', 'failed'].includes(original.state)) return true;
  const raw = await client.verifyCollection(original.provider_reference);
  if (raw === null) return false;
  const charge = chargeSchema.parse(raw);
  const email = JSON.parse(unseal(original.input_sealed)).email;
  if (
    charge.reference !== original.provider_reference ||
    charge.amount !== original.amount_minor ||
    charge.customer.email.toLowerCase() !== email.toLowerCase()
  )
    throw new PaymentError(
      422,
      'receipt_mismatch',
      'Collection evidence does not match reference, amount, currency or payer',
    );
  if (!['success', 'failed', 'abandoned'].includes(charge.status)) return false;
  // Paystack reports an unfinished checkout as abandoned; the customer can still pay
  // until the checkout window closes, so only a stale abandonment is final.
  if (charge.status === 'abandoned' && !checkoutClosed(original.created_at)) return false;
  return transaction(async (c) => {
    const row = (await c.query('SELECT * FROM collections WHERE id=$1 FOR UPDATE', [collectionId]))
      .rows[0];
    if (['succeeded', 'held', 'failed'].includes(row.state)) return true;
    if (charge.status !== 'success') {
      const failed = (
        await c.query(
          "UPDATE collections SET state='failed',last_error='provider_rejected',updated_at=now() WHERE id=$1 RETURNING *",
          [row.id],
        )
      ).rows[0];
      await emitCollection(c, failed, 'collection.failed');
      return true;
    }
    if (
      charge.fees === null ||
      charge.fees === undefined ||
      BigInt(charge.fees) >= BigInt(charge.amount)
    )
      throw new PaymentError(
        422,
        'receipt_mismatch',
        'Collection provider fees must be known and below the gross amount',
      );
    const fee = charge.fees,
      net = (BigInt(charge.amount) - BigInt(fee)).toString();
    const allowed = (
      await c.query(
        "SELECT m.enabled AND cu.verification_state='sandbox_verified' AS allowed FROM merchants m JOIN customers cu ON cu.merchant_id=m.id WHERE m.id=$1 AND cu.id=$2 FOR SHARE",
        [row.merchant_id, row.customer_id],
      )
    ).rows[0].allowed;
    const entries = [
      {
        account_id: accountId(row.merchant_id, 'NGN', allowed ? 'available' : 'reserved'),
        side: 'debit' as const,
        amount: net,
      },
      {
        account_id: accountId(null, 'NGN', 'clearing'),
        side: 'credit' as const,
        amount: charge.amount,
      },
    ];
    if (BigInt(fee) > 0n)
      entries.push({
        account_id: accountId(null, 'NGN', 'provider_fees'),
        side: 'debit',
        amount: fee,
      });
    const journal = await postJournal(c, {
      reference: `collection:${row.id}`,
      description: 'Verified Paystack test collection, net credit and explicit provider fee',
      entries,
    });
    await c.query(
      'INSERT INTO rail_receipts(id,merchant_id,resource_id,provider_reference,kind,provider_id,payload,journal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id('rrcpt'),
        row.merchant_id,
        row.id,
        row.provider_reference,
        'collection',
        charge.id,
        {
          id: charge.id,
          reference: charge.reference,
          amount_minor: charge.amount,
          fee_minor: fee,
          domain: 'test',
          status: charge.status,
        },
        journal,
      ],
    );
    const updated = (
      await c.query(
        'UPDATE collections SET state=$2,fee_minor=$3,credited_minor=$4,provider_id=$5,last_error=NULL,updated_at=now() WHERE id=$1 RETURNING *',
        [row.id, allowed ? 'succeeded' : 'held', fee, net, charge.id],
      )
    ).rows[0];
    await emitCollection(c, updated, allowed ? 'collection.succeeded' : 'collection.held');
    return true;
  });
}
export async function releaseCollection(c: Client, m: string, collectionId: string) {
  const row = (
    await c.query('SELECT * FROM collections WHERE id=$1 AND merchant_id=$2 FOR UPDATE', [
      collectionId,
      m,
    ])
  ).rows[0];
  if (!row) throw new PaymentError(404, 'collection_not_found', 'Collection not found');
  if (row.state === 'succeeded') return collectionView(row);
  if (row.state !== 'held')
    throw new PaymentError(
      409,
      'collection_not_held',
      'Only settled compliance-held collections can be released',
    );
  await customerAllowed(c, m, row.customer_id);
  await postJournal(c, {
    reference: `collection-release:${row.id}`,
    description: 'Release verified collection after compliance approval',
    entries: [
      { account_id: accountId(m, 'NGN', 'reserved'), side: 'credit', amount: row.credited_minor },
      { account_id: accountId(m, 'NGN', 'available'), side: 'debit', amount: row.credited_minor },
    ],
  });
  const updated = (
    await c.query(
      "UPDATE collections SET state='succeeded',updated_at=now() WHERE id=$1 RETURNING *",
      [row.id],
    )
  ).rows[0];
  await emitCollection(c, updated, 'collection.succeeded');
  return collectionView(updated);
}
export async function ingestProviderEvent(raw: string, signature: unknown, client: PaystackClient) {
  if (!client.verifySignature(raw, signature))
    throw new PaymentError(401, 'invalid_provider_signature', 'Paystack signature is invalid');
  const envelope = z.object({ event: z.string(), data: z.unknown() }).parse(JSON.parse(raw));
  if (
    !['charge.success', 'transfer.success', 'transfer.failed', 'transfer.reversed'].includes(
      envelope.event,
    )
  )
    return { received: true, ignored: true };
  const event = {
    event: envelope.event,
    data: z
      .object({ reference: z.string().min(1).max(80), domain: z.literal('test') })
      .parse(envelope.data),
  };
  if (
    !['charge.success', 'transfer.success', 'transfer.failed', 'transfer.reversed'].includes(
      event.event,
    )
  )
    return { received: true, ignored: true };
  return transaction(async (c) => {
    const inboxId = id('pin');
    const row = (
      await c.query(
        'INSERT INTO provider_inbox(id,payload_hash,event_type,provider_reference,payload_sealed) VALUES($1,$2,$3,$4,$5) ON CONFLICT(payload_hash) DO NOTHING RETURNING id',
        [
          inboxId,
          createHash('sha256').update(raw).digest('hex'),
          event.event,
          event.data.reference,
          seal(raw),
        ],
      )
    ).rows[0];
    if (row) await enqueue(c, 'provider_event', row.id);
    return { received: true, duplicate: !row };
  });
}
async function initialize(collectionId: string, client: PaystackClient) {
  const row = (await pool.query('SELECT * FROM collections WHERE id=$1', [collectionId])).rows[0];
  if (!row || ['succeeded', 'held', 'failed', 'pending'].includes(row.state)) return true;
  if (row.provider_binding !== client.binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'Collection belongs to another provider credential binding',
    );
  if (row.state === 'unknown') return verifyCollection(collectionId, client);
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock_shared(hashtextextended($1,0))', [
      `dispatch:${row.merchant_id}`,
    ]);
    if (!(await dispatchAllowed(c, row.merchant_id, row.customer_id))) return false;
    const input = JSON.parse(unseal(row.input_sealed));
    const allowed = (
      await c.query(
        "SELECT m.enabled AND cu.verification_state='sandbox_verified' AS allowed FROM merchants m JOIN customers cu ON cu.merchant_id=m.id WHERE m.id=$1 AND cu.id=$2",
        [row.merchant_id, row.customer_id],
      )
    ).rows[0]?.allowed;
    if (!allowed) return false;
    // Persist possible submission before network IO. A crashed/lost response only
    // permits status verification, never a fresh initialization/reference.
    const claimed = (
      await c.query(
        "UPDATE collections SET state='unknown',last_error='initialization_pending',updated_at=now() WHERE id=$1 AND state='processing' RETURNING id",
        [row.id],
      )
    ).rowCount;
    if (!claimed) return false;
    const result = await client.initializeCollection({
      reference: row.provider_reference,
      amount: row.amount_minor,
      email: input.email,
    });
    await transactionOn(c, async (c) => {
      await c.query(
        "UPDATE collections SET checkout_sealed=$2,state=CASE WHEN state='unknown' THEN 'pending' ELSE state END,last_error=NULL,updated_at=now() WHERE id=$1",
        [row.id, seal(JSON.stringify(result))],
      );
      await enqueue(c, 'collection_verify', row.id);
    });
    return true;
  } finally {
    try {
      await c.query('SELECT pg_advisory_unlock_shared(hashtextextended($1,0))', [
        `dispatch:${row.merchant_id}`,
      ]);
    } finally {
      c.release();
    }
  }
}
async function providerEvent(inboxId: string, client: PaystackClient) {
  const row = (await pool.query('SELECT * FROM provider_inbox WHERE id=$1', [inboxId])).rows[0];
  if (!row) return true;
  if (row.event_type === 'charge.success') {
    const col = (
      await pool.query('SELECT id FROM collections WHERE provider_reference=$1', [
        row.provider_reference,
      ])
    ).rows[0];
    if (!col)
      throw new PaymentError(404, 'unmapped_provider_event', 'Provider collection is not mapped');
    return verifyCollection(col.id, client);
  }
  const intent = (
    await pool.query(
      "SELECT intent_id FROM instructions WHERE provider_ref=$1 AND provider='paystack-test'",
      [row.provider_reference],
    )
  ).rows[0];
  if (!intent)
    throw new PaymentError(404, 'unmapped_provider_event', 'Provider transfer is not mapped');
  await recoverPaystackIntent(intent.intent_id, new PaystackTestConnector(client));
  return true;
}
export async function startStatement(c: Client, m: string, binding: string) {
  const runId = id('stmt');
  const row = (
    await c.query(
      "INSERT INTO statement_runs(id,merchant_id,state,provider_binding) VALUES($1,$2,'running',$3) RETURNING *",
      [runId, m, binding],
    )
  ).rows[0];
  await enqueue(c, 'statement_sync', runId);
  return row;
}
async function reconcileStatement(runId: string, client: PaystackClient) {
  const run = (await pool.query('SELECT * FROM statement_runs WHERE id=$1', [runId])).rows[0];
  if (!run || run.state !== 'running') return true;
  if (run.provider_binding !== client.binding)
    throw new PaymentError(
      422,
      'provider_binding_mismatch',
      'Statement belongs to another provider credential binding',
    );
  const statement = await client.statement();
  await transaction(async (c) => {
    const locked = (await c.query('SELECT * FROM statement_runs WHERE id=$1 FOR UPDATE', [runId]))
      .rows[0];
    if (locked.state !== 'running') return;
    let matched = 0,
      unmatched = 0;
    for (const line of statement) {
      if (line.currency !== 'NGN') continue;
      let resource: string | null = null,
        expected: string | null = null;
      if (line.model_responsible === 'Transaction') {
        const col = (
          await c.query(
            "SELECT id,credited_minor::text FROM collections WHERE merchant_id=$1 AND provider_id=$2 AND state IN ('succeeded','held')",
            [run.merchant_id, line.model_row],
          )
        ).rows[0];
        if (col) {
          resource = col.id;
          expected = col.credited_minor;
        }
      }
      if (line.model_responsible === 'Transfer') {
        const ins = (
          await c.query(
            "SELECT i.id,i.destination_minor::text,r.payload FROM intents i JOIN instructions ins ON ins.intent_id=i.id JOIN receipts r ON r.instruction_id=ins.id WHERE i.merchant_id=$1 AND ins.provider='paystack-test' AND r.payload->'provider_data'->>'id'=$2",
            [run.merchant_id, line.model_row],
          )
        ).rows[0];
        if (ins) {
          resource = ins.id;
          expected = (
            -BigInt(ins.destination_minor) - BigInt(ins.payload.provider_data.fee_minor)
          ).toString();
          if (BigInt(line.difference) > 0n) {
            const returned = (
              await c.query("SELECT 1 FROM rail_receipts WHERE resource_id=$1 AND kind='return'", [
                ins.id,
              ])
            ).rowCount;
            expected = returned ? ins.destination_minor : null;
          }
        }
      }
      // The provider statement is integration-wide. Unowned/unmapped lines are
      // redacted and never attributed to a merchant or silently marked matched.
      const state =
        expected === null ? 'unmapped' : line.difference === expected ? 'matched' : 'mismatch';
      if (state === 'matched') matched++;
      else unmatched++;
      await c.query(
        'INSERT INTO statement_items(id,run_id,provider_row_id,resource_id,difference_minor,expected_minor,state,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id('sitem'),
          run.id,
          line.id,
          resource,
          line.difference,
          expected,
          state,
          { model: line.model_responsible, domain: line.domain, currency: line.currency },
        ],
      );
    }
    await c.query(
      'UPDATE statement_runs SET state=$2,matched=$3,unmatched=$4,completed_at=now() WHERE id=$1',
      [run.id, unmatched || matched === 0 ? 'review' : 'matched', matched, unmatched],
    );
  });
  return true;
}
export const MAX_OUTBOX_ATTEMPTS = 25;
export const CHECKOUT_WINDOW_MS = 6 * 60 * 60_000;
export const checkoutClosed = (createdAt: Date | string) =>
  Date.now() - new Date(createdAt).getTime() > CHECKOUT_WINDOW_MS;
export async function runRailOnce(
  options: { client?: PaystackClient; onlyResource?: string; leaseMs?: number } = {},
): Promise<boolean> {
  if (!options.client && !PaystackClient.configured()) return false;
  const client = options.client ?? PaystackClient.fromEnvironment(),
    token = id('lease');
  const job = await transaction(async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM outbox WHERE kind IN ('collection_init','collection_verify','provider_event','statement_sync','payout_verify') AND processed_at IS NULL AND dead_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now()) AND ($1::text IS NULL OR resource_id=$1) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        [options.onlyResource ?? null],
      )
    ).rows[0];
    if (!row) return null;
    return (
      await c.query(
        "UPDATE outbox SET locked_by=$2,locked_until=now()+($3::int*interval '1 millisecond'),attempts=attempts+1 WHERE id=$1 RETURNING *",
        [row.id, token, options.leaseMs ?? 30000],
      )
    ).rows[0];
  });
  if (!job) return false;
  try {
    const terminal =
      job.kind === 'collection_init'
        ? await initialize(job.resource_id, client)
        : job.kind === 'collection_verify'
          ? await verifyCollection(job.resource_id, client)
          : job.kind === 'provider_event'
            ? await providerEvent(job.resource_id, client)
            : job.kind === 'payout_verify'
              ? (await recoverPaystackIntent(job.resource_id, new PaystackTestConnector(client)),
                true)
              : await reconcileStatement(job.resource_id, client);
    if (terminal)
      await pool.query(
        'UPDATE outbox SET processed_at=now(),locked_by=NULL,locked_until=NULL,last_error=NULL WHERE id=$1 AND locked_by=$2',
        [job.id, token],
      );
    else
      await pool.query(
        "UPDATE outbox SET available_at=now()+($3::integer*interval '1 second'),locked_by=NULL,locked_until=NULL,last_error='awaiting_verified_status',failures=0 WHERE id=$1 AND locked_by=$2",
        [job.id, token, Math.min(600, 10 * 2 ** Math.min(job.attempts - 1, 6))],
      );
  } catch (error) {
    if (job.kind === 'statement_sync')
      await pool.query(
        "UPDATE statement_runs SET state='failed',completed_at=now() WHERE id=$1 AND state='running'",
        [job.resource_id],
      );
    const code =
      error instanceof PaymentError
        ? error.code
        : error instanceof PaystackApiError
          ? 'provider_unavailable'
          : 'provider_evidence_unavailable';
    // Retries back off and are bounded; exhausted jobs are parked for operator review.
    // Only consecutive failures count; ordinary status polls reset the streak.
    const limit = code === 'unmapped_provider_event' ? 10 : MAX_OUTBOX_ATTEMPTS;
    const failures = job.failures + 1,
      dead = failures >= limit;
    await pool.query(
      "UPDATE outbox SET available_at=now()+($4::integer*interval '1 second'),locked_by=NULL,locked_until=NULL,last_error=$3,failures=$6,dead_at=CASE WHEN $5 THEN now() END WHERE id=$1 AND locked_by=$2",
      [job.id, token, code, Math.min(3600, 30 * 2 ** Math.min(failures - 1, 7)), dead, failures],
    );
    console.error(JSON.stringify({ level: dead ? 'error' : 'warn', msg: dead ? 'outbox job parked' : 'outbox job failed',
      job: job.id, kind: job.kind, failures, code }));
    if (job.kind.startsWith('collection'))
      await pool.query(
        "UPDATE collections SET last_error=$2,updated_at=now() WHERE id=$1 AND state IN ('processing','pending','unknown')",
        [job.resource_id, code],
      );
  }
  return true;
}
