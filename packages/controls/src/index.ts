import { id, type Client } from '../../database/src/index.js';
import { PaymentError } from '../../payments/src/errors.js';
import type { Principal } from '../../payments/src/auth.js';
import type { AssetId } from '../../core/src/index.js';
export interface Policy {
  caps: { asset: Exclude<AssetId, 'XLM'>; per_transaction_minor: string; per_day_minor: string }[];
}
export const gateKinds = [
  'kyb',
  'kyc',
  'screening',
  'custody',
  'security',
  'legal',
  'partner',
] as const;
export async function control(c: Client, m: string) {
  await c.query('INSERT INTO merchant_controls(merchant_id) VALUES($1) ON CONFLICT DO NOTHING', [
    m,
  ]);
  return (await c.query('SELECT * FROM merchant_controls WHERE merchant_id=$1 FOR UPDATE', [m]))
    .rows[0] as {
    merchant_id: string;
    state: 'sandbox' | 'staging_active' | 'paused';
    revision: number;
    policy: Policy;
    updated_at: Date;
  };
}
export async function assertNewMoney(c: Client, m: string) {
  const row = await control(c, m);
  if (row.state === 'paused')
    throw new PaymentError(
      423,
      'outbound_paused',
      'New payments are paused; evidence recovery remains available',
    );
  return row;
}
export async function recordUsage(
  c: Client,
  m: string,
  asset: AssetId,
  amount: string,
  resource: string,
  customer?: string,
) {
  const row = await assertNewMoney(c, m);
  if (row.state !== 'staging_active') return;
  if (customer && !(await customerReviewed(c, m, customer)))
    throw new PaymentError(
      422,
      'pilot_customer_review',
      'Current staging KYC and screening reviews are required',
    );
  const cap = row.policy.caps.find((p) => p.asset === asset);
  if (!cap)
    throw new PaymentError(
      422,
      'pilot_asset_blocked',
      'Asset is outside the approved staging policy',
    );
  const day = (await c.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
  const used = (
    await c.query(
      'SELECT COALESCE(sum(amount_minor),0)::text amount FROM pilot_usage WHERE merchant_id=$1 AND day=$2 AND asset=$3',
      [m, day, asset],
    )
  ).rows[0].amount;
  if (
    BigInt(amount) > BigInt(cap.per_transaction_minor) ||
    BigInt(used) + BigInt(amount) > BigInt(cap.per_day_minor)
  )
    throw new PaymentError(
      422,
      'pilot_cap_exceeded',
      'Approved staging transaction or UTC daily cap exceeded',
    );
  await c.query(
    'INSERT INTO pilot_usage(id,merchant_id,resource_id,asset,amount_minor,day) VALUES($1,$2,$3,$4,$5,$6)',
    [id('use'), m, resource, asset, amount, day],
  );
}
export async function customerReviewed(c: Client, m: string, customer: string) {
  const rows = (
    await c.query(
      "SELECT DISTINCT ON(kind) kind,outcome,expires_at>now() valid FROM control_evidence WHERE merchant_id=$1 AND customer_id=$2 AND kind IN ('kyc','screening') ORDER BY kind,created_at DESC,id DESC",
      [m, customer],
    )
  ).rows;
  return rows.length === 2 && rows.every((r) => r.outcome === 'checked' && r.valid);
}
export async function dispatchAllowed(c: Client, m: string, customer: string) {
  const row = (await c.query('SELECT state FROM merchant_controls WHERE merchant_id=$1', [m]))
    .rows[0];
  return (
    row?.state !== 'paused' &&
    (row?.state !== 'staging_active' || (await customerReviewed(c, m, customer)))
  );
}
export async function operator(c: Client, p: Principal) {
  const row = p.operator_id
    ? (
        await c.query(
          'SELECT id FROM control_operators WHERE id=$1 AND merchant_id=$2 AND active=true FOR SHARE',
          [p.operator_id, p.merchant_id],
        )
      ).rows[0]
    : null;
  if (!row)
    throw new PaymentError(403, 'operator_required', 'An enrolled operator identity is required');
  return row.id as string;
}
async function audit(c: Client, p: Principal, action: string, resource: string, data: unknown) {
  await c.query(
    'INSERT INTO control_audit(id,merchant_id,actor_key_id,operator_id,action,resource_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id('audit'), p.merchant_id, p.key_id, p.operator_id ?? null, action, resource, data],
  );
}
export async function readiness(c: Client, m: string) {
  const row = (
    await c.query('SELECT state,revision,policy FROM merchant_controls WHERE merchant_id=$1', [m])
  ).rows[0] ?? { state: 'sandbox', revision: 0, policy: { caps: [] } };
  const evidence = (
    await c.query(
      'SELECT DISTINCT ON(kind) id,kind,outcome,expires_at,expires_at>now() valid FROM control_evidence WHERE merchant_id=$1 AND customer_id IS NULL ORDER BY kind,created_at DESC,id DESC',
      [m],
    )
  ).rows;
  const gates = gateKinds.map((kind) => {
    const e = evidence.find((r) => r.kind === kind);
    return {
      kind,
      status: !e
        ? 'open'
        : !e.valid
          ? 'expired'
          : e.outcome === 'checked'
            ? 'staging_reviewed'
            : e.outcome,
      evidence_id: e?.id ?? null,
    };
  });
  const risks = (
    await c.query(
      "SELECT EXISTS(SELECT 1 FROM intents WHERE merchant_id=$1 AND state IN ('processing','unknown')) OR EXISTS(SELECT 1 FROM collections WHERE merchant_id=$1 AND state IN ('processing','unknown','pending','held')) OR EXISTS(SELECT 1 FROM reconciliation_items r JOIN intents i ON i.id=r.intent_id WHERE i.merchant_id=$1 AND r.state='open') OR EXISTS(SELECT 1 FROM statement_runs WHERE merchant_id=$1 AND state IN ('running','review','failed')) AS open",
      [m],
    )
  ).rows[0].open;
  const report = (
    await c.query(
      "SELECT id,control_clean,created_at>now()-interval '1 day' fresh FROM daily_control_reports WHERE merchant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [m],
    )
  ).rows[0];
  return {
    ...row,
    mode: 'staging',
    live_ready: false,
    operator_enrollment: 'platform_managed',
    gates,
    daily_report_id: report?.id ?? null,
    daily_controls_clean: !!report?.control_clean && !!report?.fresh,
    provider_cash_complete: false,
    staging_ready:
      !risks &&
      gates.every((g) => g.status === 'staging_reviewed') &&
      !!report?.control_clean &&
      !!report?.fresh,
  };
}
export async function addEvidence(
  c: Client,
  p: Principal,
  input: {
    customer_id?: string;
    kind: (typeof gateKinds)[number];
    outcome: 'checked' | 'review' | 'rejected';
    reference: string;
    reason: string;
    expires_at: string;
  },
) {
  const actor = await operator(c, p);
  if (
    Date.parse(input.expires_at) <= Date.now() ||
    Date.parse(input.expires_at) > Date.now() + 366 * 86400000
  )
    throw new PaymentError(422, 'invalid_expiry', 'Evidence must expire within one year');
  if (
    input.customer_id &&
    !(
      await c.query('SELECT 1 FROM customers WHERE id=$1 AND merchant_id=$2', [
        input.customer_id,
        p.merchant_id,
      ])
    ).rowCount
  )
    throw new PaymentError(404, 'customer_not_found', 'Customer not found');
  const row = (
    await c.query(
      'INSERT INTO control_evidence(id,merchant_id,customer_id,kind,outcome,reference,reason,operator_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [
        id('cev'),
        p.merchant_id,
        input.customer_id ?? null,
        input.kind,
        input.outcome,
        input.reference,
        input.reason,
        actor,
        input.expires_at,
      ],
    )
  ).rows[0];
  await audit(c, p, 'evidence_recorded', row.id, {
    kind: input.kind,
    outcome: input.outcome,
    mode: 'staging',
  });
  return row;
}
export async function requestChange(
  c: Client,
  p: Principal,
  input: { action: 'start_staging' | 'resume' | 'change_caps'; policy: Policy; reason: string },
) {
  const actor = await operator(c, p),
    row = await control(c, p.merchant_id);
  const request = (
    await c.query(
      'INSERT INTO control_requests(id,merchant_id,action,policy,base_revision,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [id('apr'), p.merchant_id, input.action, input.policy, row.revision, input.reason, actor],
    )
  ).rows[0];
  await audit(c, p, 'change_requested', request.id, {
    action: input.action,
    revision: row.revision,
  });
  return request;
}
export async function reviewChange(
  c: Client,
  p: Principal,
  rid: string,
  input: { decision: 'approve' | 'reject'; reason: string },
) {
  const actor = await operator(c, p),
    row = await control(c, p.merchant_id),
    request = (
      await c.query(
        'SELECT *,expires_at>now() valid FROM control_requests WHERE id=$1 AND merchant_id=$2 FOR UPDATE',
        [rid, p.merchant_id],
      )
    ).rows[0];
  if (!request) throw new PaymentError(404, 'approval_not_found', 'Approval request not found');
  if (request.state !== 'pending' || !request.valid)
    throw new PaymentError(409, 'approval_closed', 'Request is closed or expired');
  if (request.requested_by === actor)
    throw new PaymentError(
      403,
      'self_approval',
      'A different enrolled operator must review this request',
    );
  if (input.decision === 'approve') {
    if (request.base_revision !== row.revision)
      throw new PaymentError(409, 'stale_approval', 'Controls changed; request a new review');
    if (
      !(
        await c.query('SELECT active FROM control_operators WHERE id=$1 FOR SHARE', [
          request.requested_by,
        ])
      ).rows[0]?.active
    )
      throw new PaymentError(409, 'requester_inactive', 'Requesting operator is inactive');
    if (!(await readiness(c, p.merchant_id)).staging_ready)
      throw new PaymentError(
        422,
        'readiness_incomplete',
        'Current staging evidence and a clean daily control report are required',
      );
    if (request.action === 'start_staging' && row.state !== 'sandbox')
      throw new PaymentError(
        409,
        'control_state_conflict',
        'Start is available only from sandbox state',
      );
    if (
      (request.action === 'change_caps' && row.state !== 'staging_active') ||
      (request.action === 'resume' && row.state !== 'paused')
    )
      throw new PaymentError(
        409,
        'control_state_conflict',
        'Action does not match current control state',
      );
    await c.query(
      "UPDATE merchant_controls SET state='staging_active',policy=$2,revision=revision+1,updated_at=now() WHERE merchant_id=$1",
      [p.merchant_id, request.policy],
    );
  }
  const result = (
    await c.query(
      'UPDATE control_requests SET state=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now() WHERE id=$1 RETURNING *',
      [rid, input.decision === 'approve' ? 'approved' : 'rejected', actor, input.reason],
    )
  ).rows[0];
  await audit(c, p, 'change_reviewed', rid, { decision: input.decision, reason: input.reason });
  return result;
}
export async function pause(c: Client, p: Principal, reason: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `dispatch:${p.merchant_id}`,
  ]);
  const row = await control(c, p.merchant_id);
  await c.query(
    "UPDATE merchant_controls SET state='paused',revision=revision+1,updated_at=now() WHERE merchant_id=$1",
    [p.merchant_id],
  );
  await audit(c, p, 'emergency_pause', p.merchant_id, { reason, previous_state: row.state });
  return { state: 'paused', revision: row.revision + 1 };
}
export async function dailyReport(c: Client, p: Principal, day: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day ||
    day > new Date().toISOString().slice(0, 10)
  )
    throw new PaymentError(422, 'invalid_day', 'Choose a valid UTC date no later than today');
  // One SQL statement provides a consistent MVCC snapshot for all checks.
  const data = (
    await c.query(
      `SELECT jsonb_build_object(
 'snapshot_at',statement_timestamp(),'day',$2::text,'period_complete',$2::date<(now() AT TIME ZONE 'UTC')::date,
 'unbalanced_journals',(SELECT count(*) FROM (SELECT e.journal_id,a.asset_position_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY e.journal_id,a.asset_position_id HAVING SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)<>0) bad),
 'empty_journals',(SELECT count(*) FROM journals j WHERE NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.journal_id=j.id)),
 'negative_accounts',(SELECT count(*) FROM (SELECT a.id FROM ledger_accounts a JOIN ledger_entries e ON e.account_id=a.id WHERE a.merchant_id=$1 AND a.purpose IN ('available','pending','reserved') GROUP BY a.id HAVING SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)<0) bad),
 'open_intents',(SELECT count(*) FROM intents WHERE merchant_id=$1 AND state IN ('processing','unknown')),
 'missing_receipts',(SELECT count(*) FROM intents i WHERE i.merchant_id=$1 AND i.state='succeeded' AND NOT EXISTS(SELECT 1 FROM instructions ins JOIN receipts r ON r.instruction_id=ins.id WHERE ins.intent_id=i.id)),
 'unresolved_reconciliation',(SELECT count(*) FROM reconciliation_items r JOIN intents i ON i.id=r.intent_id WHERE i.merchant_id=$1 AND r.state='open'),
 'statement_review',(SELECT count(*) FROM statement_runs WHERE merchant_id=$1 AND state IN ('running','review','failed')),
 'unsettled_collections',(SELECT count(*) FROM collections WHERE merchant_id=$1 AND state IN ('processing','unknown','pending','held')),
 'balances',COALESCE((SELECT jsonb_agg(b) FROM (SELECT a.asset,a.purpose,COALESCE(SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END),0)::text minor FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id AND e.created_at<($2::date+1)::timestamp AT TIME ZONE 'UTC' WHERE a.merchant_id=$1 GROUP BY a.asset,a.purpose ORDER BY a.asset,a.purpose) b),'[]'::jsonb)) data`,
      [p.merchant_id, day],
    )
  ).rows[0].data;
  const clean = [
    'unbalanced_journals',
    'empty_journals',
    'negative_accounts',
    'open_intents',
    'missing_receipts',
    'unresolved_reconciliation',
    'statement_review',
    'unsettled_collections',
  ].every((k) => data[k] === 0);
  const row = (
    await c.query(
      'INSERT INTO daily_control_reports(id,merchant_id,day,control_clean,data) VALUES($1,$2,$3,$4,$5) RETURNING *,day::text AS day',
      [id('day'), p.merchant_id, day, clean, data],
    )
  ).rows[0];
  await audit(c, p, 'daily_controls_recorded', row.id, {
    day,
    control_clean: clean,
    provider_cash_complete: false,
  });
  return row;
}
