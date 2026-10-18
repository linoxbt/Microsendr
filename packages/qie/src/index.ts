import type { ChainSettlementAdapter, NativeTransferInstruction, SettlementEvidence } from '../../settlement/src/index.js';

export const QIE_CHAIN_ID = 1990n;
export const QIE_RPC_URL = 'https://rpc1mainnet.qie.digital/';
export const QIE_EXPLORER = 'https://mainnet.qie.digital/';
export const QIE_NETWORK = 'qie-mainnet';
export const QIE_NATIVE_POSITION = 'pos_qiev3_mainnet';
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const hashPattern = /^0x[a-fA-F0-9]{64}$/;

export class QieRpcError extends Error {}

export class QieClient implements ChainSettlementAdapter {
  readonly network = QIE_NETWORK;
  readonly chainId = QIE_CHAIN_ID;
  readonly nativeAssetPositionId = QIE_NATIVE_POSITION;
  readonly nativeAssetCode = 'QIEV3';
  readonly nativeDecimals = 18;
  readonly requiredConfirmations = 12n;
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
    const chainId = await this.rpc<string>('eth_chainId');
    if (typeof chainId !== 'string' || BigInt(chainId) !== QIE_CHAIN_ID)
      throw new QieRpcError('RPC does not serve QIE mainnet');
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

  async headBlock(): Promise<bigint> {
    await this.assertMainnet();
    const block = await this.rpc<string>('eth_blockNumber');
    if (!/^0x[0-9a-f]+$/i.test(block)) throw new QieRpcError('Invalid QIE block height');
    return BigInt(block);
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
      throw new QieRpcError('Settlement transaction does not match instruction');
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
