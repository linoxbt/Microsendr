import { z } from 'zod';
import { id, pool } from '../../database/src/index.js';
import { QieClient, QIE_EXPLORER, QIE_NETWORK, QIE_QUSDC_CONTRACT } from '../../qie/src/index.js';

export type IncomingAsset = 'QIEV3' | 'QUSDC';
const ASSETS: IncomingAsset[] = ['QIEV3', 'QUSDC'];
const EXPLORER_API = `${QIE_EXPLORER}api/v2`;
const MAX_PAGES = 20;
const POLL_SECONDS = 60;

const party = z.object({ hash: z.string() }).nullable();
const nativeItem = z.object({
  hash: z.string(), block_number: z.number().int().nonnegative(), timestamp: z.string(),
  to: party, value: z.string(), status: z.string().nullable().optional(),
});
const tokenItem = z.object({
  transaction_hash: z.string(), log_index: z.number().int().nonnegative(), block_number: z.number().int().nonnegative(),
  timestamp: z.string(), to: party, token: z.object({ address_hash: z.string().optional(), address: z.string().optional() }).optional(),
  total: z.object({ value: z.string() }).nullable().optional(),
});
const page = z.object({ items: z.array(z.unknown()), next_page_params: z.record(z.string(), z.unknown()).nullable().optional() });

export interface Candidate { hash: string; logIndex: number; block: bigint; time: Date }

/**
 * Candidate incoming transfers for an address, newest first, from the public explorer.
 * The explorer is only an index; every candidate is verified on chain before use.
 */
export async function* explorerCandidates(address: string, asset: IncomingAsset, request: typeof fetch = fetch) {
  let params: Record<string, unknown> | null | undefined = {};
  for (let pageNo = 0; params && pageNo < MAX_PAGES; pageNo++) {
    const query = new URLSearchParams({ filter: 'to', ...(asset === 'QUSDC' ? { token: QIE_QUSDC_CONTRACT } : {}) });
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    const path = asset === 'QIEV3' ? 'transactions' : 'token-transfers';
    const response = await request(`${EXPLORER_API}/addresses/${address}/${path}?${query}`, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`explorer_status_${response.status}`);
    const body = page.parse(await response.json());
    for (const raw of body.items) {
      if (asset === 'QIEV3') {
        const item = nativeItem.safeParse(raw);
        if (!item.success || item.data.to?.hash.toLowerCase() !== address || !/^[1-9]\d*$/.test(item.data.value) || item.data.status === 'error') continue;
        yield { hash: item.data.hash.toLowerCase(), logIndex: -1, block: BigInt(item.data.block_number), time: new Date(item.data.timestamp) } satisfies Candidate;
      } else {
        const item = tokenItem.safeParse(raw);
        const token = item.success ? (item.data.token?.address_hash ?? item.data.token?.address ?? '') : '';
        if (!item.success || item.data.to?.hash.toLowerCase() !== address || token.toLowerCase() !== QIE_QUSDC_CONTRACT.toLowerCase()) continue;
        yield { hash: item.data.transaction_hash.toLowerCase(), logIndex: item.data.log_index, block: BigInt(item.data.block_number), time: new Date(item.data.timestamp) } satisfies Candidate;
      }
    }
    params = body.next_page_params;
  }
}

/**
 * Worker job: scan one due (address, asset) pair and record verified incoming
 * transfers. Only addresses currently linked or managed are scanned, starting from
 * when they joined an account. The cursor advances only after a scan with no errors.
 */
export async function indexOneIncomingWallet(client = new QieClient(), request: typeof fetch = fetch) {
  // Make sure every current address has a cursor, then claim the most overdue one.
  await pool.query(`INSERT INTO chain_incoming_cursors(network,address,asset)
    SELECT $1, w.address, a.asset FROM (
      SELECT address FROM personal_chain_wallets WHERE status='active' AND network=$1
      UNION SELECT address FROM personal_managed_wallets WHERE network=$1) w
    CROSS JOIN unnest($2::text[]) AS a(asset)
    ON CONFLICT DO NOTHING`, [QIE_NETWORK, ASSETS]);
  const due = (await pool.query(`UPDATE chain_incoming_cursors c SET next_poll_at=now()+interval '5 minutes'
    WHERE (network,address,asset)=(SELECT network,address,asset FROM chain_incoming_cursors
      WHERE next_poll_at<=now() AND (EXISTS(SELECT 1 FROM personal_chain_wallets w WHERE w.address=chain_incoming_cursors.address AND w.status='active')
        OR EXISTS(SELECT 1 FROM personal_managed_wallets m WHERE m.address=chain_incoming_cursors.address))
      ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING c.*`)).rows[0];
  if (!due) return false;
  const address = due.address as string, asset = due.asset as IncomingAsset;
  try {
    const since = (await pool.query(`SELECT min(t) AS since FROM (
      SELECT created_at t FROM personal_chain_wallets WHERE address=$1 AND status='active'
      UNION ALL SELECT created_at FROM personal_managed_wallets WHERE address=$1) x`, [address])).rows[0].since as Date;
    const head = await client.headBlock();
    const safe = head - client.requiredConfirmations;
    const cursor = due.scanned_through_block === null ? null : BigInt(due.scanned_through_block);
    let recorded = 0;
    for await (const candidate of explorerCandidates(address, asset, request)) {
      if (candidate.block > safe) continue;
      if (cursor !== null && candidate.block <= cursor) break;
      // Allow an hour of clock skew around the moment the address joined an account.
      if (candidate.time.getTime() < since.getTime() - 3_600_000) break;
      const evidence = await client.incomingEvidence(candidate.hash, address, asset, candidate.logIndex);
      if (!evidence) continue;
      const inserted = await pool.query(`INSERT INTO chain_incoming_transfers
        (id,network,asset,address,from_address,amount_atomic,tx_hash,log_index,block_number,block_hash,block_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [id('rcv'), QIE_NETWORK, asset, address, evidence.from, evidence.amount_atomic, candidate.hash,
          candidate.logIndex, evidence.block_number, evidence.block_hash, evidence.block_time]);
      recorded += inserted.rowCount ?? 0;
    }
    await pool.query(`UPDATE chain_incoming_cursors SET scanned_through_block=$4,failures=0,last_error=NULL,
      next_poll_at=now()+($5::integer*interval '1 second') WHERE network=$1 AND address=$2 AND asset=$3`,
      [QIE_NETWORK, address, asset, safe.toString(), POLL_SECONDS]);
    return true;
  } catch (error) {
    // Back off this address only; other addresses keep being scanned.
    await pool.query(`UPDATE chain_incoming_cursors SET failures=failures+1,last_error=$4,
      next_poll_at=now()+(LEAST(3600, 60*power(2, LEAST(failures,6)))::integer*interval '1 second')
      WHERE network=$1 AND address=$2 AND asset=$3`,
      [QIE_NETWORK, address, asset, error instanceof Error ? error.message.slice(0, 120) : 'error']);
    return true;
  }
}

/** Incoming transfers for an account: only those that arrived while it held the address. */
export async function personalIncomingTransfers(userId: string, accountId: string, limit = 50) {
  const rows = (await pool.query(`SELECT t.* FROM chain_incoming_transfers t
    WHERE t.network=$3 AND (
      EXISTS(SELECT 1 FROM personal_chain_wallets w WHERE w.personal_user_id=$1 AND w.account_id=$2 AND w.address=t.address
        AND t.block_time>=w.created_at-interval '1 hour' AND (w.status='active' OR t.block_time<=w.updated_at))
      OR EXISTS(SELECT 1 FROM personal_managed_wallets m WHERE m.personal_user_id=$1 AND m.account_id=$2 AND m.address=t.address))
    ORDER BY t.block_time DESC, t.id LIMIT $4`, [userId, accountId, QIE_NETWORK, limit])).rows;
  return rows.map(publicIncoming);
}

export function publicIncoming(row: Record<string, any>) {
  return {
    id: row.id, direction: 'received' as const, network: row.network, asset: row.asset,
    decimals: row.asset === 'QUSDC' ? 6 : 18, from: row.from_address, to: row.address,
    amount_atomic: String(row.amount_atomic), status: 'confirmed', tx_hash: row.tx_hash,
    block_number: String(row.block_number), block_hash: row.block_hash, created_at: row.block_time,
    updated_at: row.observed_at, explorer_url: `${QIE_EXPLORER}tx/${row.tx_hash}`,
    custody: 'user_wallet', ledger_credited: false,
  };
}
