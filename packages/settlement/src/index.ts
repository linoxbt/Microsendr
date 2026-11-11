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
  /** Re-sends a transaction this service signed, while it is not yet mined. */
  sendRawTransaction?(raw: string): Promise<string>;
  /** Number of transactions the address has mined (its next nonce). */
  accountNonce?(address: string): Promise<bigint>;
  nativeTransferEvidence(hash: string, instruction: NativeTransferInstruction): Promise<SettlementEvidence>;
  /** Allowlisted tokens on this network, by asset position id. */
  readonly tokens?: Record<string, { code: string; decimals: number; contract: string }>;
  tokenTransferEvidence?(hash: string, positionId: string, instruction: NativeTransferInstruction): Promise<SettlementEvidence>;
}

export function nativeTransferAuthorization(input: {
  accountId: string; network: string; chainId: bigint; from: string; to: string;
  amountAtomic: bigint; idempotencyKey: string; expiresAt: string;
  /** Present for a token transfer; the native message is unchanged without it. */
  token?: { code: string; contract: string };
}): string {
  return [
    'Roots settlement authorization',
    `Account: ${input.accountId}`,
    `Network: ${input.network}`,
    `Chain ID: ${input.chainId}`,
    ...(input.token ? [`Asset: ${input.token.code} (${input.token.contract.toLowerCase()})`] : []),
    `From: ${input.from.toLowerCase()}`,
    `To: ${input.to.toLowerCase()}`,
    `Amount (atomic units): ${input.amountAtomic}`,
    `Idempotency key: ${input.idempotencyKey}`,
    `Expires: ${input.expiresAt}`,
  ].join('\n');
}
