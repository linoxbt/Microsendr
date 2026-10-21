import { createHash } from 'node:crypto';
import { assets, asset, assetPositionId, minor, type AssetId } from '../../core/src/index.js';
import { pool, id, transaction, type Client } from '../../database/src/index.js';

export class LedgerError extends Error {
  constructor(
    readonly code:
      | 'insufficient_funds'
      | 'reference_conflict'
      | 'invalid_journal'
      | 'invalid_hold'
      | 'account_not_found',
    message: string,
  ) {
    super(message);
  }
}
export interface Entry {
  account_id: string;
  side: 'debit' | 'credit';
  amount: string;
}
export interface Journal {
  reference: string;
  description: string;
  entries: Entry[];
}
export interface Hold {
  id: string;
  merchant_id: string;
  asset: AssetId;
  amount: string;
  reference: string;
  state: 'held' | 'captured' | 'released';
}

export function accountId(merchantId: string | null, code: AssetId, purpose: string) {
  return `${merchantId ?? 'sys'}:${code}:${purpose}`;
}
export async function createMerchant(merchantId: string, name: string) {
  return transaction((c) => createMerchantInTransaction(c, merchantId, name));
}
export async function createMerchantInTransaction(c: Client, merchantId: string, name: string) {
  await c.query(
    "INSERT INTO merchants(id,name,mode) VALUES($1,$2,'sandbox') ON CONFLICT(id) DO NOTHING",
    [merchantId, name],
  );
  await c.query(
    'INSERT INTO organizations(id,legacy_merchant_id,name) VALUES($1,$2,$3) ON CONFLICT(legacy_merchant_id) DO NOTHING',
    [id('org'), merchantId, name],
  );
  const organizationId = (
    await c.query('SELECT id FROM organizations WHERE legacy_merchant_id=$1', [merchantId])
  ).rows[0].id as string;
  await c.query(
    "INSERT INTO kora_accounts(id,owner_type,organization_id) VALUES($1,'business',$2) ON CONFLICT(organization_id) DO NOTHING",
    [id('acct'), organizationId],
  );
  const ownerAccountId = (
    await c.query('SELECT id FROM kora_accounts WHERE organization_id=$1', [organizationId])
  ).rows[0].id as string;
  for (const { id: code } of assets) {
    if (code === 'XLM') continue;
    for (const purpose of ['available', 'reserved'])
      await c.query(
        'INSERT INTO ledger_accounts(id,merchant_id,owner_account_id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [accountId(merchantId, code, purpose), merchantId, ownerAccountId, assetPositionId(code), code, purpose],
      );
    for (const purpose of ['clearing', 'fees', 'funding'])
      await c.query(
        'INSERT INTO ledger_accounts(id,asset_position_id,asset,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [accountId(null, code, purpose), assetPositionId(code), code, purpose],
      );
  }
}
export async function balance(c: Client, account: string): Promise<bigint> {
  const result = await c.query(
    "SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0)::text amount FROM ledger_entries WHERE account_id=$1",
    [account],
  );
  return BigInt(result.rows[0].amount);
}
export async function balances(merchantId: string) {
  const result = await pool.query(
    "SELECT a.asset,a.asset_position_id,a.purpose,COALESCE(SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END),0)::text AS minor FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.merchant_id=$1 GROUP BY a.asset,a.asset_position_id,a.purpose ORDER BY a.asset,a.purpose",
    [merchantId],
  );
  return result.rows as { asset: AssetId; asset_position_id: string; purpose: string; minor: string }[];
}
const checked = (a: { merchant_id: string | null; owner_account_id: string | null; purpose: string }) =>
  !!(a.merchant_id || a.owner_account_id) && ['available', 'pending', 'reserved'].includes(a.purpose);
// Compose with the domain write inside the same PostgreSQL transaction.
export async function postJournal(c: Client, journal: Journal): Promise<string> {
  if (!journal.reference || !journal.description || journal.entries.length < 2)
    throw new LedgerError(
      'invalid_journal',
      'A journal needs a reference, description and at least two entries',
    );
  const entries = [...journal.entries].sort(
    (a, b) =>
      a.account_id.localeCompare(b.account_id) ||
      a.side.localeCompare(b.side) ||
      a.amount.localeCompare(b.amount),
  );
  for (const e of entries)
    if (!['debit', 'credit'].includes(e.side) || minor(e.amount) <= 0n)
      throw new LedgerError('invalid_journal', 'Journal entries must contain positive amounts');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ description: journal.description, entries }))
    .digest('hex');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `journal:${journal.reference}`,
  ]);
  const existing = (
    await c.query('SELECT id,fingerprint FROM journals WHERE reference=$1', [journal.reference])
  ).rows[0];
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new LedgerError(
        'reference_conflict',
        'Reference already used for different journal contents',
      );
    return existing.id;
  }
  const accountIds = [...new Set(entries.map((e) => e.account_id))].sort();
  // Only owned balance accounts need a row lock to serialize their non-negative check.
  // Shared system accounts (clearing, fees, funding) are never locked, so they do not
  // serialize every posting in the system. Locks are still taken in id order.
  const accounts = (
    await c.query('SELECT * FROM ledger_accounts WHERE id=ANY($1::text[]) ORDER BY id', [accountIds])
  ).rows;
  const guarded = accounts.filter(checked).map((a) => a.id);
  if (guarded.length)
    await c.query('SELECT id FROM ledger_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [guarded]);
  if (accounts.length !== accountIds.length)
    throw new LedgerError('account_not_found', 'Journal refers to an unknown account');
  const totals = new Map<string, bigint>();
  for (const a of accounts) {
    let delta = 0n;
    for (const e of entries.filter((e) => e.account_id === a.id))
      delta += (e.side === 'debit' ? 1n : -1n) * minor(e.amount);
    totals.set(a.asset_position_id, (totals.get(a.asset_position_id) ?? 0n) + delta);
    if (checked(a) && (await balance(c, a.id)) + delta < 0n)
      throw new LedgerError('insufficient_funds', 'Insufficient available or reserved funds');
  }
  if ([...totals.values()].some((total) => total !== 0n))
    throw new LedgerError('invalid_journal', 'Debits must equal credits for each asset');
  const journalId = id('jrn');
  await c.query('INSERT INTO journals(id,reference,fingerprint,description) VALUES($1,$2,$3,$4)', [
    journalId,
    journal.reference,
    fingerprint,
    journal.description,
  ]);
  for (const e of entries)
    await c.query(
      'INSERT INTO ledger_entries(id,journal_id,account_id,side,amount) VALUES($1,$2,$3,$4,$5)',
      [id('ent'), journalId, e.account_id, e.side, e.amount],
    );
  return journalId;
}
export async function sandboxFund(
  merchantId: string,
  code: AssetId,
  amount: string,
  reference: string,
) {
  asset(code);
  return transaction((c) =>
    postJournal(c, {
      reference,
      description: 'Sandbox fixture funding',
      entries: [
        { account_id: accountId(merchantId, code, 'available'), side: 'debit', amount },
        { account_id: accountId(null, code, 'funding'), side: 'credit', amount },
      ],
    }),
  );
}
export async function reserve(
  merchantId: string,
  code: AssetId,
  amount: string,
  reference: string,
): Promise<Hold> {
  return transaction((c) => reserveInTransaction(c, merchantId, code, amount, reference));
}
export async function reserveInTransaction(
  c: Client,
  merchantId: string,
  code: AssetId,
  amount: string,
  reference: string,
): Promise<Hold> {
  asset(code);
  if (minor(amount) <= 0n) throw new LedgerError('invalid_hold', 'Hold must be positive');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`hold:${reference}`]);
  const existing = (await c.query('SELECT * FROM holds WHERE reference=$1', [reference]))
    .rows[0] as Hold | undefined;
  if (existing) {
    if (
      existing.merchant_id !== merchantId ||
      existing.asset !== code ||
      existing.amount !== amount
    )
      throw new LedgerError(
        'reference_conflict',
        'Hold reference already used for different contents',
      );
    return existing;
  }
  await postJournal(c, {
    reference: `hold:${reference}`,
    description: 'Reserve funds for outbound instruction',
    entries: [
      { account_id: accountId(merchantId, code, 'available'), side: 'credit', amount },
      { account_id: accountId(merchantId, code, 'reserved'), side: 'debit', amount },
    ],
  });
  return (
    await c.query(
      "INSERT INTO holds(id,merchant_id,asset,amount,reference,state) VALUES($1,$2,$3,$4,$5,'held') RETURNING *",
      [id('hld'), merchantId, code, amount, reference],
    )
  ).rows[0] as Hold;
}
async function completeHoldInTransaction(
  c: Client,
  holdId: string,
  action: 'capture' | 'release',
  fee = '0',
): Promise<Hold> {
  const feeAmount = minor(fee);
  const hold = (await c.query('SELECT * FROM holds WHERE id=$1 FOR UPDATE', [holdId])).rows[0] as
    Hold | undefined;
  if (!hold) throw new LedgerError('invalid_hold', 'Hold not found');
  const desired = action === 'capture' ? 'captured' : 'released';
  if (hold.state === desired) {
    if (action === 'capture') {
      const recorded = (
        await c.query('SELECT fee::text FROM hold_completions WHERE hold_id=$1', [holdId])
      ).rows[0];
      if (recorded?.fee !== fee)
        throw new LedgerError(
          'reference_conflict',
          'Capture fee differs from the original capture',
        );
    }
    return hold;
  }
  if (hold.state !== 'held')
    throw new LedgerError('invalid_hold', `Cannot ${action} a ${hold.state} hold`);
  if (feeAmount >= minor(hold.amount))
    throw new LedgerError('invalid_hold', 'Fee must be smaller than the held amount');
  const entries: Entry[] = [
    {
      account_id: accountId(hold.merchant_id, hold.asset, 'reserved'),
      side: 'credit',
      amount: hold.amount,
    },
  ];
  if (action === 'release')
    entries.push({
      account_id: accountId(hold.merchant_id, hold.asset, 'available'),
      side: 'debit',
      amount: hold.amount,
    });
  else {
    entries.push({
      account_id: accountId(null, hold.asset, 'clearing'),
      side: 'debit',
      amount: (minor(hold.amount) - feeAmount).toString(),
    });
    if (feeAmount)
      entries.push({ account_id: accountId(null, hold.asset, 'fees'), side: 'debit', amount: fee });
  }
  await postJournal(c, {
    reference: `${action}:${hold.id}`,
    description:
      action === 'capture'
        ? 'Capture held funds against confirmed settlement'
        : 'Release held funds',
    entries,
  });
  if (action === 'capture')
    await c.query('INSERT INTO hold_completions(hold_id,fee) VALUES($1,$2)', [hold.id, fee]);
  return (
    await c.query('UPDATE holds SET state=$2,updated_at=now() WHERE id=$1 RETURNING *', [
      holdId,
      desired,
    ])
  ).rows[0] as Hold;
}
export const captureInTransaction = (c: Client, holdId: string, fee = '0') =>
  completeHoldInTransaction(c, holdId, 'capture', fee);
export const releaseInTransaction = (c: Client, holdId: string) =>
  completeHoldInTransaction(c, holdId, 'release');
export const capture = (holdId: string, fee = '0') =>
  transaction((c) => captureInTransaction(c, holdId, fee));
export const release = (holdId: string) => transaction((c) => releaseInTransaction(c, holdId));
export async function reverseJournal(originalId: string, reference: string, reason: string) {
  if (!reason.trim()) throw new LedgerError('invalid_journal', 'Reversal requires a reason');
  return transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `reverse:${originalId}`,
    ]);
    const existing = (
      await c.query(
        'SELECT j.id,j.reference,r.reason FROM journal_reversals r JOIN journals j ON j.id=r.reversing_journal_id WHERE r.original_journal_id=$1',
        [originalId],
      )
    ).rows[0];
    if (existing) {
      if (existing.reference !== reference || existing.reason !== reason)
        throw new LedgerError('reference_conflict', 'Journal has already been reversed');
      return existing.id as string;
    }
    const result = await c.query(
      'SELECT account_id,side,amount::text FROM ledger_entries WHERE journal_id=$1',
      [originalId],
    );
    if (!result.rowCount) throw new LedgerError('invalid_journal', 'Original journal not found');
    // Payment lifecycles own these entries; generic reversal must not orphan their state.
    if (
      (
        await c.query(
          "SELECT 1 FROM journals WHERE id=$1 AND (reference LIKE 'hold:%' OR reference LIKE 'capture:%' OR reference LIKE 'release:%' OR reference LIKE 'collection:%' OR reference LIKE 'collection-release:%' OR reference LIKE 'return:%' OR reference LIKE 'provider-fee:%' OR reference LIKE 'stellar-%' OR reference LIKE 'destination:%' OR reference LIKE 'corridor-leg:%')",
          [originalId],
        )
      ).rowCount
    )
      throw new LedgerError(
        'invalid_journal',
        'Use the payment lifecycle to correct a hold or local-rail journal',
      );
    const reversalId = await postJournal(c, {
      reference,
      description: `Reversal of ${originalId}: ${reason}`,
      entries: result.rows.map((e) => ({
        account_id: e.account_id,
        side: e.side === 'debit' ? 'credit' : 'debit',
        amount: e.amount,
      })),
    });
    await c.query(
      'INSERT INTO journal_reversals(original_journal_id,reversing_journal_id,reason) VALUES($1,$2,$3)',
      [originalId, reversalId, reason],
    );
    return reversalId;
  });
}
export async function invariantReport() {
  const unbalanced = await pool.query(
    "SELECT e.journal_id,a.asset_position_id FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id GROUP BY e.journal_id,a.asset_position_id HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END)<>0",
  );
  const negative = await pool.query(
    "SELECT a.id FROM ledger_accounts a JOIN ledger_entries e ON e.account_id=a.id WHERE (a.merchant_id IS NOT NULL OR a.owner_account_id IS NOT NULL) AND a.purpose IN ('available','pending','reserved') GROUP BY a.id HAVING SUM(CASE WHEN side='debit' THEN amount ELSE -amount END)<0",
  );
  const empty = await pool.query(
    'SELECT id FROM journals WHERE NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.journal_id=journals.id)',
  );
  return {
    balanced: unbalanced.rowCount === 0,
    nonnegative: negative.rowCount === 0,
    no_empty_journals: empty.rowCount === 0,
    violations: [...unbalanced.rows, ...negative.rows, ...empty.rows],
  };
}
