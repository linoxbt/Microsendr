import { verifyMessage } from 'viem';
import { id, pool, transaction } from '../../database/src/index.js';
import { QieClient, QIE_NETWORK } from '../../qie/src/index.js';
import { nativeTransferAuthorization, type ChainSettlementAdapter } from './index.js';

export class SettlementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const hashPattern = /^0x[a-fA-F0-9]{64}$/;
export const chainAdapters: Record<string, () => ChainSettlementAdapter> = {
  [QIE_NETWORK]: () => new QieClient(),
};

export interface CreateNativeSettlement {
  userId: string;
  accountId: string;
  network: string;
  from: string;
  to: string;
  amountAtomic: string;
  idempotencyKey: string;
  expiresAt: string;
  signature: `0x${string}`;
}

export async function createNativeSettlement(input: CreateNativeSettlement) {
  const adapter = chainAdapters[input.network]?.();
  if (!adapter || adapter.network !== input.network)
    throw new SettlementError(422, 'network_unavailable', 'This settlement network is unavailable');
  if (!addressPattern.test(input.from) || !addressPattern.test(input.to) || input.from.toLowerCase() === input.to.toLowerCase())
    throw new SettlementError(400, 'invalid_destination', 'Choose a different valid QIE address');
  if (!/^[1-9][0-9]{0,77}$/.test(input.amountAtomic) || BigInt(input.amountAtomic) > (1n << 256n) - 1n)
    throw new SettlementError(400, 'invalid_amount', 'Enter a valid QIE amount');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey))
    throw new SettlementError(400, 'idempotency_key_required', 'A valid Idempotency-Key is required');
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 5 * 60_000)
    throw new SettlementError(400, 'authorization_expired', 'Sign a fresh transfer authorization');
  const amountAtomic = BigInt(input.amountAtomic);
  const message = nativeTransferAuthorization({ accountId: input.accountId, network: input.network,
    chainId: adapter.chainId, from: input.from, to: input.to, amountAtomic,
    idempotencyKey: input.idempotencyKey, expiresAt: input.expiresAt });
  const valid = await verifyMessage({ address: input.from as `0x${string}`, message, signature: input.signature }).catch(() => false);
  if (!valid) throw new SettlementError(401, 'wallet_signature_invalid', 'The sending wallet did not authorize this transfer');
  return transaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`chain:${input.userId}:${input.idempotencyKey}`]);
    const existing = (await c.query('SELECT * FROM chain_settlements WHERE personal_user_id=$1 AND idempotency_key=$2', [input.userId,input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.account_id !== input.accountId || existing.network !== input.network ||
          existing.source_address !== input.from.toLowerCase() || existing.destination_address !== input.to.toLowerCase() ||
          existing.amount_atomic !== input.amountAtomic)
        throw new SettlementError(409, 'idempotency_conflict', 'This request key was used for another transfer');
      return publicSettlement(existing);
    }
    const minimumBlock = await adapter.headBlock();
    const settlementId = id('stl');
    const result = (await c.query(`INSERT INTO chain_settlements
      (id,personal_user_id,account_id,asset_position_id,network,chain_id,direction,source_address,destination_address,amount_atomic,required_confirmations,minimum_block_number,idempotency_key,authorization_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'outbound',$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [settlementId,input.userId,input.accountId,adapter.nativeAssetPositionId,adapter.network,String(adapter.chainId),input.from.toLowerCase(),input.to.toLowerCase(),input.amountAtomic,Number(adapter.requiredConfirmations),String(minimumBlock),input.idempotencyKey,input.expiresAt])).rows[0];
    return publicSettlement(result);
  });
}

export function publicSettlement(row: Record<string, any>) {
  const adapter = chainAdapters[row.network]?.();
  return { id: row.id, network: row.network, chain_id: Number(row.chain_id), asset_position_id: row.asset_position_id,
    asset: adapter?.nativeAssetCode ?? row.asset_position_id, decimals: adapter?.nativeDecimals ?? null,
    from: row.source_address, to: row.destination_address,
    amount_atomic: String(row.amount_atomic), status: row.status, tx_hash: row.tx_hash,
    block_number: row.block_number === null ? null : String(row.block_number), block_hash: row.block_hash,
    confirmations: row.observed_confirmations, required_confirmations: row.required_confirmations,
    created_at: row.created_at, updated_at: row.updated_at,
    explorer_url: row.tx_hash && adapter ? adapter.transactionUrl(row.tx_hash) : null,
    custody: 'user_wallet', ledger_credited: false };
}

export async function submitNativeSettlement(userId: string, settlementId: string, hash: string) {
  if (!hashPattern.test(hash)) throw new SettlementError(400, 'invalid_hash', 'Enter a valid transaction hash');
  return transaction(async c => {
    const row = (await c.query('SELECT * FROM chain_settlements WHERE id=$1 AND personal_user_id=$2 FOR UPDATE', [settlementId,userId])).rows[0];
    if (!row) throw new SettlementError(404, 'settlement_not_found', 'Settlement not found');
    if (row.tx_hash) {
      if (row.tx_hash !== hash.toLowerCase()) throw new SettlementError(409, 'transaction_conflict', 'A different transaction is already linked');
      return publicSettlement(row);
    }
    if (row.status !== 'awaiting_submission' || new Date(row.submission_expires_at).getTime() < Date.now())
      throw new SettlementError(409, 'settlement_expired', 'Create a new settlement authorization');
    try {
      const updated = (await c.query(`UPDATE chain_settlements SET tx_hash=$2,status='submitted',updated_at=now()
        WHERE id=$1 RETURNING *`, [settlementId,hash.toLowerCase()])).rows[0];
      return publicSettlement(updated);
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505')
        throw new SettlementError(409, 'transaction_already_tracked', 'This transaction is already tracked');
      throw cause;
    }
  });
}

/** Worker-safe reconciliation. A timeout remains unknown and is checked again; never resubmits a transfer. */
export async function reconcileChainSettlement(settlementId: string, adapter: ChainSettlementAdapter = new QieClient()) {
  const row = (await pool.query(`SELECT * FROM chain_settlements WHERE id=$1 AND status IN ('submitted','pending','unknown')`, [settlementId])).rows[0];
  if (!row) return false;
  if (row.network !== adapter.network || BigInt(row.chain_id) !== adapter.chainId || row.asset_position_id !== adapter.nativeAssetPositionId)
    throw new SettlementError(422, 'adapter_mismatch', 'No adapter is configured for this settlement');
  try {
    const evidence = await adapter.nativeTransferEvidence(row.tx_hash, {
      from: row.source_address, to: row.destination_address,
      amountAtomic: BigInt(row.amount_atomic), confirmations: BigInt(row.required_confirmations),
    });
    if (evidence.block_number !== null && BigInt(evidence.block_number) < BigInt(row.minimum_block_number))
      throw new SettlementError(422, 'historical_transaction', 'Transaction predates the settlement instruction');
    await pool.query(`UPDATE chain_settlements SET status=$2,block_number=$3,block_hash=$4,observed_confirmations=$5,
      last_error=NULL,last_checked_at=now(),updated_at=now() WHERE id=$1 AND status IN ('submitted','pending','unknown')`,
      [settlementId,evidence.state,evidence.block_number,evidence.block_hash,Number(evidence.confirmations)]);
  } catch (cause) {
    await pool.query(`UPDATE chain_settlements SET status='unknown',last_error=$2,last_checked_at=now(),updated_at=now()
      WHERE id=$1 AND status IN ('submitted','pending','unknown')`,
      [settlementId,cause instanceof Error ? cause.name : 'RPC error']);
  }
  return true;
}

export async function reconcileOneChainSettlement() {
  await pool.query(`UPDATE chain_settlements SET status='expired',updated_at=now()
    WHERE status='awaiting_submission' AND submission_expires_at<now()`);
  const row = (await pool.query(`SELECT id,network FROM chain_settlements
    WHERE status IN ('submitted','pending','unknown') AND (last_checked_at IS NULL OR last_checked_at<now()-interval '15 seconds')
    ORDER BY last_checked_at NULLS FIRST,created_at LIMIT 1`)).rows[0];
  if (!row) return false;
  const adapter = chainAdapters[row.network]?.();
  if (!adapter) return false;
  return reconcileChainSettlement(row.id,adapter);
}
