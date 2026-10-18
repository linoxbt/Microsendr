import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QieClient, QieRpcError } from '../packages/qie/src/index.js';

function fakeRpc(values: Record<string, unknown>) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: 1, result: values[method] });
  }) as typeof fetch;
}
const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const blockHash = '0x' + 'b'.repeat(64);

test('QIE native transfer evidence requires mainnet, matching instruction and finality', async () => {
  const values = {
    eth_chainId: '0x7c6',
    eth_getTransactionByHash: { from, to, value: '0x64', blockHash },
    eth_getTransactionReceipt: { transactionHash: hash, status: '0x1', blockNumber: '0xa', blockHash },
    eth_getBlockByNumber: { hash: blockHash },
    eth_blockNumber: '0xb',
  };
  const client = new QieClient(fakeRpc(values));
  const expected = { from, to, amountAtomic: 100n, confirmations: 3n };
  assert.deepEqual(await client.nativeTransferEvidence(hash, expected), { state: 'pending', confirmations: '2', block_number: '10', block_hash: blockHash });
  values.eth_blockNumber = '0xc';
  assert.deepEqual(await client.nativeTransferEvidence(hash, expected), { state: 'confirmed', confirmations: '3', block_number: '10', block_hash: blockHash });
  values.eth_getTransactionReceipt.status = '0x0';
  assert.equal((await client.nativeTransferEvidence(hash, expected)).state, 'failed');
  values.eth_getTransactionReceipt.status = '0x1';
  await assert.rejects(client.nativeTransferEvidence(hash, { ...expected, amountAtomic: 99n }), QieRpcError);
  values.eth_getBlockByNumber.hash = '0x' + 'c'.repeat(64);
  assert.equal((await client.nativeTransferEvidence(hash, expected)).state, 'pending');
  values.eth_getBlockByNumber.hash = blockHash;
  values.eth_chainId = '0x1';
  await assert.rejects(client.nativeTransferEvidence(hash, expected), QieRpcError);
});

test('QIE balance reads only a valid address on chain 1990', async () => {
  const client = new QieClient(fakeRpc({ eth_chainId: '0x7c6', eth_getBalance: '0xde0b6b3a7640000', eth_blockNumber: '0x10' }));
  assert.deepEqual(await client.nativeBalance(from), { balance_wei: '1000000000000000000', block_number: '16' });
  await assert.rejects(client.nativeBalance('0x123'), QieRpcError);
});
