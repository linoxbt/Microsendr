import { production } from './config.js';
import { assertNoSendHold } from './send-hold.js';
import { getAddress, isAddress, keccak256, parseEther, parseTransaction, parseUnits, recoverTransactionAddress, type Hex } from 'viem';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { id, pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { QieClient, QIE_CHAIN_ID, QIE_NATIVE_POSITION, QIE_NETWORK, QIE_QUSDC_CONTRACT, QIE_QUSDC_POSITION, QUSDC_DECIMALS, qusdcTransferData } from '../../../packages/qie/src/index.js';
import { publicSettlement } from '../../../packages/settlement/src/service.js';
import { findManagedWallet, managedWalletConfigured, privyWalletRpc } from './managed-wallet.js';

/**
 * Sending from a Privy-managed wallet makes Microsendr custodial of the funds, so it
 * is off unless KORA_MANAGED_TRANSFERS=true, and needs a verified email, approved
 * identity verification (unless KORA_MANAGED_TRANSFERS_REQUIRE_KYC=false), the
 * account password, and per-transfer and rolling 24-hour limits.
 */
export function managedTransfersEnabled() {
  return process.env.KORA_MANAGED_TRANSFERS === 'true' && managedWalletConfigured() && signingPolicyInPlace();
}
/**
 * In production, account-wallet sends need the Privy signing policy (PRIVY_POLICY_ID),
 * so Privy itself refuses anything above the limits even if this server were compromised.
 * KORA_ALLOW_UNPOLICED_TRANSFERS=true is an explicit, temporary override.
 */
export function signingPolicyInPlace() {
  return !production() || !!process.env.PRIVY_POLICY_ID || process.env.KORA_ALLOW_UNPOLICED_TRANSFERS === 'true';
}
const limit = (name: string, fallback: string) => parseEther(process.env[name] || fallback);
const tokenLimit = (name: string, fallback: string) => parseUnits(process.env[name] || fallback, QUSDC_DECIMALS);
export const managedTransferLimits = () => ({
  per_transfer_wei: limit('KORA_MANAGED_TRANSFER_MAX_QIE', '1000'),
  daily_wei: limit('KORA_MANAGED_TRANSFER_DAILY_QIE', '5000'),
  qusdc_per_transfer_atomic: tokenLimit('KORA_MANAGED_TRANSFER_MAX_QUSDC', '1000'),
  qusdc_daily_atomic: tokenLimit('KORA_MANAGED_TRANSFER_DAILY_QUSDC', '5000'),
});
export type ManagedAsset = 'QIE' | 'QUSDC';
// Until identity is verified, account-wallet sends are held to small limits
// (only reachable when KORA_MANAGED_TRANSFERS_REQUIRE_KYC=false).
export const unverifiedTransferLimits = () => ({
  per_transfer_wei: limit('KORA_UNVERIFIED_TRANSFER_MAX_QIE', '50'),
  daily_wei: limit('KORA_UNVERIFIED_TRANSFER_DAILY_QIE', '100'),
  qusdc_per_transfer_atomic: tokenLimit('KORA_UNVERIFIED_TRANSFER_MAX_QUSDC', '50'),
  qusdc_daily_atomic: tokenLimit('KORA_UNVERIFIED_TRANSFER_DAILY_QUSDC', '100'),
});

const signedSchema = z.object({ data: z.object({ signed_transaction: z.string().regex(/^0x[0-9a-fA-F]+$/) }) });

export interface ManagedTransferInput {
  userId: string;
  accountId: string;
  to: string;
  amountAtomic: string;
  idempotencyKey: string;
  /** QIE (native) when omitted. */
  asset?: ManagedAsset;
}

export async function sendFromManagedWallet(input: ManagedTransferInput, client = new QieClient(), privy: typeof fetch = fetch) {
  if (!managedTransfersEnabled()) throw new PaymentError(403, 'managed_transfers_unavailable', 'Sending from your account wallet is not available yet.');
  if (!isAddress(input.to)) throw new PaymentError(400, 'invalid_destination', 'Enter a valid QIE address');
  if (!/^[1-9][0-9]{0,40}$/.test(input.amountAtomic)) throw new PaymentError(400, 'invalid_amount', 'Enter a valid QIE amount');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
  const value = BigInt(input.amountAtomic);
  const to = getAddress(input.to);
  const token = input.asset === 'QUSDC';
  const position = token ? QIE_QUSDC_POSITION : QIE_NATIVE_POSITION;
  // A QUSDC send is a call to the token contract with value 0; the recipient is in the calldata.
  const txTo = token ? getAddress(QIE_QUSDC_CONTRACT) : to;
  const txValue = token ? 0n : value;
  const txData = token ? qusdcTransferData(to, value) : undefined;
  const wallet = await findManagedWallet(input.userId, input.accountId);
  if (!wallet) throw new PaymentError(404, 'wallet_not_found', 'Your account wallet is not ready yet');
  if (to === wallet.address) throw new PaymentError(400, 'invalid_destination', 'Choose a different recipient');

  // A retried request returns the original transfer; a reused key with new details is
  // refused, and a key whose attempt failed before anything was signed says so.
  const replay = async () => {
    const previous = (await pool.query('SELECT * FROM chain_settlements WHERE personal_user_id=$1 AND idempotency_key=$2', [input.userId, input.idempotencyKey])).rows[0];
    if (!previous) return null;
    if (previous.custody !== 'managed' || previous.destination_address !== to.toLowerCase() || String(previous.amount_atomic) !== input.amountAtomic ||
        previous.asset_position_id !== position)
      throw new PaymentError(409, 'idempotency_conflict', 'This request key was used for another transfer');
    if (!previous.tx_hash && ['expired', 'mismatched', 'failed'].includes(previous.status))
      throw new PaymentError(409, 'transfer_failed', 'That attempt did not go through and nothing was sent. Try again.');
    return publicSettlement(previous);
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const owner = (await pool.query(`SELECT u.email_verified_at,(SELECT status FROM personal_didit_sessions d WHERE d.personal_user_id=u.id
    ORDER BY created_at DESC,id DESC LIMIT 1) AS kyc FROM personal_users u WHERE u.id=$1`, [input.userId])).rows[0];
  if (!owner?.email_verified_at) throw new PaymentError(403, 'verified_email_required', 'Verify your email before sending');
  // A send already recorded is replayed above; a new one waits out any recovery hold.
  await assertNoSendHold(input.userId);
  const verified = owner.kyc === 'Approved';
  if (process.env.KORA_MANAGED_TRANSFERS_REQUIRE_KYC !== 'false' && !verified)
    throw new PaymentError(403, 'identity_verification_required', 'Complete identity verification before sending from your account wallet');
  // Unverified accounts (allowed only when KYC is not required) get much smaller limits.
  const limits = verified ? managedTransferLimits() : unverifiedTransferLimits();
  const perTransfer = token ? limits.qusdc_per_transfer_atomic : limits.per_transfer_wei;
  const daily = token ? limits.qusdc_daily_atomic : limits.daily_wei;
  if (value > perTransfer)
    throw new PaymentError(422, 'transfer_limit', verified ? 'This amount is above the per-transfer limit'
      : 'This amount is above the limit for unverified accounts. Verify your identity to send more.');

  // One signing per wallet at a time: two concurrent sends must not share a nonce. The
  // claim carries a token so only its holder can release it.
  const lockToken = randomBytes(16).toString('hex');
  const claimed = (await pool.query(`UPDATE personal_managed_wallets SET signing_until=now()+interval '2 minutes',signing_token=$2
    WHERE personal_user_id=$1 AND (signing_until IS NULL OR signing_until<now()) RETURNING 1`, [input.userId, lockToken])).rowCount;
  if (!claimed) throw new PaymentError(409, 'transfer_in_progress', 'Another transfer is being sent. Try again in a moment.');
  let settlementId: string | null = null;
  let recorded = false;
  try {
    // Re-check under the claim: a concurrent request with the same key may have just finished.
    const raced = await replay();
    if (raced) return raced;
    const sentToday = BigInt((await pool.query(`SELECT COALESCE(sum(amount_atomic),0)::text total FROM chain_settlements
      WHERE personal_user_id=$1 AND custody='managed' AND asset_position_id=$2 AND created_at>now()-interval '24 hours'
      AND status NOT IN ('expired','mismatched')`, [input.userId, position])).rows[0].total);
    if (sentToday + value > daily)
      throw new PaymentError(422, 'daily_limit', verified ? 'This transfer would exceed your 24-hour sending limit'
        : 'This transfer would exceed the 24-hour limit for unverified accounts. Verify your identity to send more.');
    if (token && BigInt((await client.qusdcBalance(wallet.address)).balance_atomic) < value)
      throw new PaymentError(422, 'insufficient_funds', 'Your account wallet does not have enough QUSDC for this amount');
    const params = await client.transferParameters(wallet.address, txTo, txValue, txData);
    if (params.balance < txValue + params.gas * params.maxFeePerGas)
      throw new PaymentError(422, 'insufficient_funds', token
        ? 'Your account wallet needs a little QIE to pay the network fee'
        : 'Your account wallet does not have enough QIE for this amount and the network fee');
    const head = await client.headBlock();
    // Never reuse a nonce this wallet already signed and has not seen confirmed: the node's
    // pending count misses a transaction whose broadcast failed or went to another node.
    const highest = (await pool.query(`SELECT max(nonce)::text AS n FROM chain_settlements
      WHERE source_address=$1 AND custody='managed' AND status IN ('submitted','pending','unknown')`, [wallet.address.toLowerCase()])).rows[0].n;
    const nonce = Math.max(params.nonce, highest === null ? 0 : Number(highest) + 1);
    settlementId = id('stl');
    await pool.query(`INSERT INTO chain_settlements(id,personal_user_id,account_id,asset_position_id,network,chain_id,direction,
      source_address,destination_address,amount_atomic,required_confirmations,minimum_block_number,idempotency_key,
      authorization_expires_at,submission_expires_at,custody,nonce)
      VALUES($1,$2,$3,$4,$5,$6,'outbound',$7,$8,$9,$10,$11,$12,now()+interval '5 minutes',now()+interval '5 minutes','managed',$13)`,
      [settlementId, input.userId, input.accountId, position, QIE_NETWORK, String(QIE_CHAIN_ID),
        wallet.address.toLowerCase(), to.toLowerCase(), input.amountAtomic, Number(client.requiredConfirmations),
        String(head), input.idempotencyKey, nonce]);
    const signed = signedSchema.parse(await privyWalletRpc(wallet.id, {
      method: 'eth_signTransaction',
      params: { transaction: {
        to: txTo, value: `0x${txValue.toString(16)}`, ...(txData ? { data: txData } : {}), chain_id: Number(QIE_CHAIN_ID), type: 2, nonce,
        gas_limit: `0x${params.gas.toString(16)}`, max_fee_per_gas: `0x${params.maxFeePerGas.toString(16)}`,
        max_priority_fee_per_gas: `0x${params.maxPriorityFeePerGas.toString(16)}`,
      } },
    }, privy)).data.signed_transaction.toLowerCase() as Hex;
    // Never broadcast what we did not ask for: decode the signed bytes and recover the signer.
    const decoded = parseTransaction(signed);
    const signer = await recoverTransactionAddress({ serializedTransaction: signed as never });
    // Exactly an EIP-1559 transfer: no access list, no EIP-7702 delegation, no legacy gas price.
    if (decoded.type !== 'eip1559' || decoded.authorizationList !== undefined || (decoded.accessList?.length ?? 0) > 0 ||
        decoded.gasPrice !== undefined || decoded.maxFeePerGas === undefined || decoded.maxPriorityFeePerGas === undefined ||
        decoded.to?.toLowerCase() !== txTo.toLowerCase() || (decoded.value ?? 0n) !== txValue || decoded.chainId !== Number(QIE_CHAIN_ID) ||
        decoded.nonce !== nonce || (decoded.data ?? '0x').toLowerCase() !== (txData ?? '0x') ||
        signer.toLowerCase() !== wallet.address.toLowerCase() ||
        decoded.maxFeePerGas > params.maxFeePerGas || decoded.maxPriorityFeePerGas > params.maxPriorityFeePerGas || (decoded.gas ?? 0n) > params.gas)
      throw new PaymentError(502, 'signature_mismatch', 'The signed transfer did not match the request. Nothing was sent.');
    const hash = keccak256(signed);
    // Record the exact transaction before it is broadcast, so a crash cannot lose it. If the
    // record was already closed (for example expired by the worker), nothing is broadcast.
    const submitted = (await pool.query(`UPDATE chain_settlements SET tx_hash=$2,signed_transaction=$3,status='submitted',updated_at=now()
      WHERE id=$1 AND status='awaiting_submission' AND submission_expires_at>now()`, [settlementId, hash, signed])).rowCount;
    if (submitted !== 1) throw new PaymentError(409, 'transfer_expired', 'That attempt took too long and nothing was sent. Try again.');
    recorded = true;
    await client.sendRawTransaction(signed).catch(() => undefined); // The worker re-broadcasts if needed.
    return publicSettlement((await pool.query('SELECT * FROM chain_settlements WHERE id=$1', [settlementId])).rows[0]);
  } catch (error) {
    // Once the signed transaction is recorded it will be broadcast and tracked: report it,
    // never "nothing was moved".
    if (recorded && settlementId)
      return publicSettlement((await pool.query('SELECT * FROM chain_settlements WHERE id=$1', [settlementId])).rows[0]);
    if (settlementId)
      await pool.query(`UPDATE chain_settlements SET status='expired',last_error=$2,updated_at=now()
        WHERE id=$1 AND status='awaiting_submission'`, [settlementId, error instanceof PaymentError ? error.code : 'signing_failed']);
    if (error instanceof PaymentError) throw error;
    throw new PaymentError(503, 'transfer_unavailable', 'Your transfer could not be sent. Nothing was moved; try again.');
  } finally {
    await pool.query('UPDATE personal_managed_wallets SET signing_until=NULL,signing_token=NULL WHERE personal_user_id=$1 AND signing_token=$2',
      [input.userId, lockToken]);
  }
}
