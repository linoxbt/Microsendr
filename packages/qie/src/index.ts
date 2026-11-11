import type { ChainSettlementAdapter, NativeTransferInstruction, SettlementEvidence } from '../../settlement/src/index.js';

export const QIE_CHAIN_ID = 1990n;
export const QIE_RPC_URL = process.env.QIE_RPC_URL || 'https://rpc1mainnet.qie.digital/';
export const QIE_EXPLORER = 'https://mainnet.qie.digital/';
export const QIE_NETWORK = 'qie-mainnet';
export const QIE_NATIVE_POSITION = 'pos_qiev3_mainnet';
// Exact mainnet contract. A ticker match is never sufficient to credit QUSDC.
export const QIE_QUSDC_CONTRACT = '0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5';
export const QIE_QUSDC_POSITION = 'pos_qusdc_mainnet';
export const QUSDC_DECIMALS = 6;
const word = (hex: string) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** Calldata for QUSDC transfer(to, amount). */
export function qusdcTransferData(to: string, amountAtomic: bigint) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(to) || amountAtomic <= 0n) throw new QieRpcError('Invalid token transfer input');
  return `0xa9059cbb${word(to)}${word(amountAtomic.toString(16))}`;
}
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const hashPattern = /^0x[a-fA-F0-9]{64}$/;

export class QieRpcError extends Error {}
/** match: proven; mismatch: provably not this transfer; retry: the node cannot tell yet. */
export type IncomingCheck = { status: 'match'; evidence: IncomingEvidence } | { status: 'mismatch' } | { status: 'retry' };
export interface IncomingEvidence {
  from: string;
  amount_atomic: string;
  block_number: string;
  block_hash: string;
  block_time: string;
}
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The chain evidence contradicts the instruction; retrying cannot change the outcome. */
export class QieEvidenceMismatch extends QieRpcError {}
// eth_chainId is fixed per endpoint; verify once per RPC URL and process.
const verifiedEndpoints = new Set<string>();

export class QieClient implements ChainSettlementAdapter {
  readonly network = QIE_NETWORK;
  readonly chainId = QIE_CHAIN_ID;
  readonly nativeAssetPositionId = QIE_NATIVE_POSITION;
  readonly nativeAssetCode = 'QIEV3';
  readonly nativeDecimals = 18;
  readonly requiredConfirmations = 12n;
  readonly tokens = { [QIE_QUSDC_POSITION]: { code: 'QUSDC', decimals: QUSDC_DECIMALS, contract: QIE_QUSDC_CONTRACT } };
  transactionUrl(hash: string) { return `${QIE_EXPLORER}tx/${hash}`; }
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly rpcUrl: string = QIE_RPC_URL,
  ) {
    if (new URL(rpcUrl).protocol !== 'https:') throw new QieRpcError('QIE RPC must use HTTPS');
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.request(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new QieRpcError('QIE RPC is unavailable');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('result' in body) || 'error' in body)
      throw new QieRpcError('Invalid QIE RPC response');
    return (body as { result: T }).result;
  }

  async assertMainnet(): Promise<void> {
    if (this.request === fetch && verifiedEndpoints.has(this.rpcUrl)) return;
    const chainId = await this.rpc<string>('eth_chainId');
    if (typeof chainId !== 'string' || BigInt(chainId) !== QIE_CHAIN_ID)
      throw new QieRpcError('RPC does not serve QIE mainnet');
    if (this.request === fetch) verifiedEndpoints.add(this.rpcUrl);
  }

  async transactionSender(hash: string): Promise<string | null> {
    if (!hashPattern.test(hash)) throw new QieRpcError('Invalid transaction hash');
    await this.assertMainnet();
    const tx = await this.rpc<{ from?: string } | null>('eth_getTransactionByHash', [hash]);
    if (!tx) return null;
    if (typeof tx.from !== 'string' || !addressPattern.test(tx.from)) throw new QieRpcError('Invalid transaction response');
    return tx.from.toLowerCase();
  }

  async nativeBalance(address: string): Promise<{ balance_wei: string; block_number: string }> {
    if (!addressPattern.test(address)) throw new QieRpcError('Invalid QIE address');
    await this.assertMainnet();
    const [rawBalance, rawBlock] = await Promise.all([
      this.rpc<string>('eth_getBalance', [address, 'latest']),
      this.rpc<string>('eth_blockNumber'),
    ]);
    if (!/^0x[0-9a-f]+$/i.test(rawBalance) || !/^0x[0-9a-f]+$/i.test(rawBlock))
      throw new QieRpcError('Invalid balance response');
    return { balance_wei: BigInt(rawBalance).toString(), block_number: BigInt(rawBlock).toString() };
  }

  async qusdcBalance(address: string): Promise<{ balance_atomic: string; block_number: string }> {
    if (!addressPattern.test(address)) throw new QieRpcError('Invalid QIE address');
    await this.assertMainnet();
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
    const [rawBalance, rawBlock] = await Promise.all([
      this.rpc<string>('eth_call', [{ to: QIE_QUSDC_CONTRACT, data }, 'latest']),
      this.rpc<string>('eth_blockNumber'),
    ]);
    if (!/^0x[0-9a-f]{64}$/i.test(rawBalance) || !/^0x[0-9a-f]+$/i.test(rawBlock))
      throw new QieRpcError('Invalid QUSDC balance response');
    return { balance_atomic: BigInt(rawBalance).toString(), block_number: BigInt(rawBlock).toString() };
  }

  async headBlock(): Promise<bigint> {
    await this.assertMainnet();
    const block = await this.rpc<string>('eth_blockNumber');
    if (!/^0x[0-9a-f]+$/i.test(block)) throw new QieRpcError('Invalid QIE block height');
    return BigInt(block);
  }

  /** Inputs for an EIP-1559 transfer: pending nonce, fees and gas. With data, a contract call of value 0. */
  async transferParameters(from: string, to: string, value: bigint, data?: string) {
    if (!addressPattern.test(from) || !addressPattern.test(to)) throw new QieRpcError('Invalid transfer input');
    if (data === undefined ? value <= 0n : value !== 0n || !/^0x[0-9a-f]+$/i.test(data)) throw new QieRpcError('Invalid transfer input');
    await this.assertMainnet();
    const [nonce, block, priority, gas, balance] = await Promise.all([
      this.rpc<string>('eth_getTransactionCount', [from, 'pending']),
      this.rpc<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]),
      this.rpc<string>('eth_maxPriorityFeePerGas'),
      this.rpc<string>('eth_estimateGas', [{ from, to, value: `0x${value.toString(16)}`, ...(data ? { data } : {}) }]),
      this.rpc<string>('eth_getBalance', [from, 'pending']),
    ]);
    for (const value of [nonce, priority, gas, balance, block?.baseFeePerGas])
      if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new QieRpcError('Invalid fee response');
    const maxPriorityFeePerGas = BigInt(priority);
    // Twice the base fee absorbs several blocks of increases; unused fee is not charged.
    const maxFeePerGas = 2n * BigInt(block!.baseFeePerGas!) + maxPriorityFeePerGas;
    return { nonce: Number(BigInt(nonce)), gas: BigInt(gas), maxFeePerGas, maxPriorityFeePerGas, balance: BigInt(balance) };
  }

  /** Transactions mined from the address: the next nonce at the latest block. */
  async accountNonce(address: string): Promise<bigint> {
    if (!addressPattern.test(address)) throw new QieRpcError('Invalid address');
    await this.assertMainnet();
    const count = await this.rpc<string>('eth_getTransactionCount', [address, 'latest']);
    if (typeof count !== 'string' || !/^0x[0-9a-f]+$/i.test(count)) throw new QieRpcError('Invalid nonce response');
    return BigInt(count);
  }

  /** Broadcasts a signed transaction; resending one the node already has is harmless. */
  async sendRawTransaction(raw: string): Promise<string> {
    if (!/^0x[0-9a-f]+$/i.test(raw)) throw new QieRpcError('Invalid signed transaction');
    await this.assertMainnet();
    return this.rpc<string>('eth_sendRawTransaction', [raw]);
  }

  /**
   * Verifies an incoming transfer straight from the node: the explorer only suggests
   * candidates. Native transfers must be a successful top-level transaction to the
   * address; QUSDC transfers must be the exact Transfer log from the allowlisted
   * contract. A transfer the node cannot see or finalise yet is "retry", never "mismatch",
   * so the indexer does not skip it.
   */
  async incomingEvidence(hash: string, to: string, asset: 'QIEV3' | 'QUSDC', logIndex: number,
    confirmations = this.requiredConfirmations): Promise<IncomingCheck> {
    if (!hashPattern.test(hash) || !addressPattern.test(to) || !Number.isSafeInteger(logIndex))
      throw new QieRpcError('Invalid incoming transfer input');
    await this.assertMainnet();
    const [tx, receipt, head] = await Promise.all([
      this.rpc<{ from: string; to: string | null; value: string } | null>('eth_getTransactionByHash', [hash]),
      this.rpc<{ status: string; blockNumber: string; blockHash?: string; logs?: { address: string; topics: string[]; data: string; logIndex: string }[] } | null>('eth_getTransactionReceipt', [hash]),
      this.rpc<string>('eth_blockNumber'),
    ]);
    if (!tx || !receipt || !receipt.blockHash || !hashPattern.test(receipt.blockHash)) return { status: 'retry' };
    if (receipt.status !== '0x1') return { status: 'mismatch' };
    const block = BigInt(receipt.blockNumber);
    if (BigInt(head) - block + 1n < confirmations) return { status: 'retry' };
    const canonical = await this.rpc<{ hash: string; timestamp: string } | null>('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!canonical || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'retry' };
    let from: string, amount: bigint;
    if (asset === 'QIEV3') {
      if (logIndex !== -1 || tx.to?.toLowerCase() !== to.toLowerCase()) return { status: 'mismatch' };
      from = tx.from;
      amount = BigInt(tx.value);
    } else {
      const log = receipt.logs?.find(item => Number(BigInt(item.logIndex)) === logIndex);
      const padded = `0x${to.slice(2).toLowerCase().padStart(64, '0')}`;
      if (!log || log.address.toLowerCase() !== QIE_QUSDC_CONTRACT.toLowerCase() || log.topics.length !== 3 ||
          log.topics[0].toLowerCase() !== TRANSFER_TOPIC || log.topics[2].toLowerCase() !== padded ||
          !/^0x[0-9a-f]{64}$/i.test(log.data)) return { status: 'mismatch' };
      from = `0x${log.topics[1].slice(-40)}`;
      amount = BigInt(log.data);
    }
    if (amount <= 0n || !addressPattern.test(from)) return { status: 'mismatch' };
    return { status: 'match', evidence: {
      from: from.toLowerCase(), amount_atomic: amount.toString(), block_number: block.toString(),
      block_hash: receipt.blockHash.toLowerCase(), block_time: new Date(Number(BigInt(canonical.timestamp)) * 1000).toISOString(),
    } };
  }

  /**
   * Evidence for a QUSDC transfer this account sent: the transaction calls the
   * allowlisted contract with exactly transfer(to, amount), and once mined the
   * receipt holds the matching Transfer log.
   */
  async tokenTransferEvidence(hash: string, positionId: string, expected: NativeTransferInstruction): Promise<SettlementEvidence> {
    const token = this.tokens[positionId as keyof typeof this.tokens];
    if (!token || !hashPattern.test(hash) || !addressPattern.test(expected.from) || !addressPattern.test(expected.to) ||
        expected.amountAtomic <= 0n || expected.confirmations < 1n)
      throw new QieRpcError('Invalid settlement input');
    await this.assertMainnet();
    const [tx, receipt, head] = await Promise.all([
      this.rpc<{ from: string; to: string | null; value: string; input?: string; blockHash?: string } | null>('eth_getTransactionByHash', [hash]),
      this.rpc<{ transactionHash: string; status: string; blockNumber: string; blockHash?: string; logs?: { address: string; topics: string[]; data: string }[] } | null>('eth_getTransactionReceipt', [hash]),
      this.rpc<string>('eth_blockNumber'),
    ]);
    if (!tx) return { state: 'pending', confirmations: '0', block_number: null, block_hash: null };
    if (tx.from.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== token.contract.toLowerCase() ||
        BigInt(tx.value) !== 0n || tx.input?.toLowerCase() !== qusdcTransferData(expected.to, expected.amountAtomic))
      throw new QieEvidenceMismatch('Token transfer does not match instruction');
    if (!receipt) return { state: 'pending', confirmations: '0', block_number: null, block_hash: null };
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new QieEvidenceMismatch('Receipt does not match');
    if (!receipt.blockHash || !hashPattern.test(receipt.blockHash) ||
        (tx.blockHash && tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()))
      throw new QieRpcError('Invalid settlement block evidence');
    if (!['0x0', '0x1'].includes(receipt.status)) throw new QieRpcError('Invalid receipt status');
    if (receipt.status === '0x1' && !receipt.logs?.some((log) => log.address.toLowerCase() === token.contract.toLowerCase() &&
        log.topics.length === 3 && log.topics[0].toLowerCase() === TRANSFER_TOPIC &&
        log.topics[1].toLowerCase() === `0x${word(expected.from)}` && log.topics[2].toLowerCase() === `0x${word(expected.to)}` &&
        /^0x[0-9a-f]+$/i.test(log.data) && BigInt(log.data) === expected.amountAtomic))
      throw new QieEvidenceMismatch('Token transfer log does not match instruction');
    const block = BigInt(receipt.blockNumber);
    const canonical = await this.rpc<{ hash: string } | null>('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!canonical || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      return { state: 'pending', confirmations: '0', block_number: null, block_hash: null };
    const confirmations = BigInt(head) >= block ? BigInt(head) - block + 1n : 0n;
    const state = confirmations < expected.confirmations ? 'pending' : receipt.status === '0x0' ? 'failed' : 'confirmed';
    return { state, confirmations: confirmations.toString(), block_number: block.toString(), block_hash: receipt.blockHash.toLowerCase() };
  }

  // This is settlement evidence only. Financial posting requires a separately
  // persisted instruction, wallet binding, token allowlist, and reconciliation.
  async nativeTransferEvidence(
    hash: string,
    expected: NativeTransferInstruction,
  ): Promise<SettlementEvidence> {
    if (!hashPattern.test(hash) || !addressPattern.test(expected.from) ||
        !addressPattern.test(expected.to) || expected.amountAtomic <= 0n ||
        expected.confirmations < 1n)
      throw new QieRpcError('Invalid settlement input');
    await this.assertMainnet();
    const [tx, receipt, head] = await Promise.all([
      this.rpc<{ from: string; to: string | null; value: string; blockHash?: string } | null>('eth_getTransactionByHash', [hash]),
      this.rpc<{ transactionHash: string; status: string; blockNumber: string; blockHash?: string } | null>('eth_getTransactionReceipt', [hash]),
      this.rpc<string>('eth_blockNumber'),
    ]);
    if (!tx || !receipt) return { state: 'pending', confirmations: '0', block_number: null, block_hash: null };
    if (tx.from.toLowerCase() !== expected.from.toLowerCase() ||
        tx.to?.toLowerCase() !== expected.to.toLowerCase() ||
        BigInt(tx.value) !== expected.amountAtomic ||
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
      throw new QieEvidenceMismatch('Settlement transaction does not match instruction');
    if (!receipt.blockHash || !hashPattern.test(receipt.blockHash) ||
        (tx.blockHash && tx.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()))
      throw new QieRpcError('Invalid settlement block evidence');
    const block = BigInt(receipt.blockNumber);
    const canonical = await this.rpc<{ hash: string } | null>('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!canonical || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      return { state: 'pending', confirmations: '0', block_number: null, block_hash: null };
    const confirmations = BigInt(head) >= block ? BigInt(head) - block + 1n : 0n;
    if (!['0x0', '0x1'].includes(receipt.status)) throw new QieRpcError('Invalid receipt status');
    const state = confirmations < expected.confirmations ? 'pending' : receipt.status === '0x0' ? 'failed' : 'confirmed';
    return { state, confirmations: confirmations.toString(), block_number: block.toString(), block_hash: receipt.blockHash.toLowerCase() };
  }
}
