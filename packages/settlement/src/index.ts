/** Chain-neutral evidence contract. Adding a network requires its own adapter and asset allowlist. */
export interface NativeTransferInstruction {
  from: string;
  to: string;
  amountAtomic: bigint;
  confirmations: bigint;
}

export interface SettlementEvidence {
  state: 'pending' | 'confirmed' | 'failed';
  confirmations: string;
  block_number: string | null;
  block_hash: string | null;
}

export interface ChainSettlementAdapter {
  readonly network: string;
  readonly chainId: bigint;
  readonly nativeAssetPositionId: string;
  readonly nativeAssetCode: string;
  readonly nativeDecimals: number;
  readonly requiredConfirmations: bigint;
  transactionUrl(hash: string): string;
  headBlock(): Promise<bigint>;
  /** Sender of a broadcast transaction, or null while it is not yet visible. */
  transactionSender?(hash: string): Promise<string | null>;
  nativeTransferEvidence(hash: string, instruction: NativeTransferInstruction): Promise<SettlementEvidence>;
}

export function nativeTransferAuthorization(input: {
  accountId: string; network: string; chainId: bigint; from: string; to: string;
  amountAtomic: bigint; idempotencyKey: string; expiresAt: string;
}): string {
  return [
    'Microsendr settlement authorization',
    `Account: ${input.accountId}`,
    `Network: ${input.network}`,
    `Chain ID: ${input.chainId}`,
    `From: ${input.from.toLowerCase()}`,
    `To: ${input.to.toLowerCase()}`,
    `Amount (atomic units): ${input.amountAtomic}`,
    `Idempotency key: ${input.idempotencyKey}`,
    `Expires: ${input.expiresAt}`,
  ].join('\n');
}
