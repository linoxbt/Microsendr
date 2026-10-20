import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QieClient, QieRpcError, QIE_QUSDC_CONTRACT } from '../packages/qie/src/index.js';
import { walletAssetSnapshot } from '../services/api/src/personal-assets.js';
import { walletUsdValue } from '../services/api/src/personal-valuation.js';

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

test('QUSDC balance reads the allowlisted mainnet token with six decimal units', async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    return Response.json({ result: method === 'eth_chainId' ? '0x7c6'
      : method === 'eth_blockNumber' ? '0x10' : '0x' + (1250000n).toString(16).padStart(64, '0') });
  }) as typeof fetch;
  const client = new QieClient(request);
  assert.deepEqual(await client.qusdcBalance(from), { balance_atomic: '1250000', block_number: '16' });
  const call = calls.find(c => c.method === 'eth_call');
  assert.equal((call?.params[0] as { to: string }).to, QIE_QUSDC_CONTRACT);
  assert.equal((call?.params[0] as { data: string }).data, `0x70a08231${from.slice(2).padStart(64, '0')}`);
  await assert.rejects(client.qusdcBalance('bad'), QieRpcError);
});

test('wallet asset snapshot sums linked wallets without inventing fiat or partial balances', async () => {
  const snapshot = await walletAssetSnapshot([from, to], {
    nativeBalance: async address => ({ balance_wei: address === from ? '100' : '200', block_number: '10' }),
    qusdcBalance: async address => {
      if (address === to) throw new Error('RPC unavailable');
      return { balance_atomic: '1000000', block_number: '10' };
    },
  });
  assert.deepEqual(snapshot.map(asset => [asset.code, asset.amount_atomic, asset.status]), [
    ['QIE', '300', 'ready'], ['QUSDC', null, 'unavailable'], ['NGN', null, 'unavailable'],
  ]);
});

test('wallet USD estimate uses exact wallet units and fails closed on missing balances or quotes', () => {
  const assets = [
    { code: 'QIE' as const, name: 'QIE', amount_atomic: '1250000000000000000', decimals: 18, status: 'ready' as const, source: 'wallet' as const },
    { code: 'QUSDC' as const, name: 'Digital dollars', amount_atomic: '2500000', decimals: 6, status: 'ready' as const, source: 'wallet' as const },
  ];
  const prices = { qie: '0.187425', qusdc: '1.0', checked_at: '2026-10-21T10:00:00.000Z' };
  assert.deepEqual(walletUsdValue(assets, prices), { amount_usd: '2.73', checked_at: prices.checked_at });
  assert.equal(walletUsdValue(assets, null).amount_usd, null);
  assert.equal(walletUsdValue([{ ...assets[0], amount_atomic: null, status: 'unavailable' }, assets[1]], prices).amount_usd, null);
  assert.equal(walletUsdValue(assets, { ...prices, qusdc: '0' }).amount_usd, null);
  assert.equal(walletUsdValue(assets.map(asset => ({ ...asset, amount_atomic: '0' })), null).amount_usd, '0.00');
});
