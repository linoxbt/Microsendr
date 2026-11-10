import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { id, pool } from '../packages/database/src/index.js';
import { QieClient, QieEvidenceMismatch, QIE_CHAIN_ID, QIE_NATIVE_POSITION, QIE_NETWORK, QIE_QUSDC_CONTRACT, QIE_QUSDC_POSITION, qusdcTransferData } from '../packages/qie/src/index.js';
import { nativeTransferAuthorization, type ChainSettlementAdapter, type SettlementEvidence } from '../packages/settlement/src/index.js';
import { chainAdapters, createNativeSettlement, publicSettlement, reconcileChainSettlement, submitNativeSettlement } from '../packages/settlement/src/service.js';

after(async () => { await pool.end(); });
const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'c'.repeat(64);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;

function chain(overrides: { input?: string; to?: string; value?: string; status?: string; logs?: unknown[]; head?: string } = {}) {
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    const result = ({
      eth_chainId: '0x7c6', eth_blockNumber: overrides.head ?? '0x200',
      eth_getTransactionByHash: { from, to: overrides.to ?? QIE_QUSDC_CONTRACT, value: overrides.value ?? '0x0', input: overrides.input ?? qusdcTransferData(to, 2_500_000n), blockHash: '0x' + 'b'.repeat(64) },
      eth_getTransactionReceipt: { transactionHash: hash, status: overrides.status ?? '0x1', blockNumber: '0x100', blockHash: '0x' + 'b'.repeat(64),
        logs: overrides.logs ?? [{ address: QIE_QUSDC_CONTRACT, topics: [TRANSFER, topic(from), topic(to)], data: '0x' + (2_500_000).toString(16).padStart(64, '0') }] },
      eth_getBlockByNumber: { hash: '0x' + 'b'.repeat(64) },
    } as Record<string, unknown>)[method];
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return new QieClient(request);
}
const instruction = { from, to, amountAtomic: 2_500_000n, confirmations: 12n };

test('QUSDC transfer calldata is transfer(to, amount) on the allowlisted contract', () => {
  assert.equal(qusdcTransferData(to, 2_500_000n),
    '0xa9059cbb' + to.slice(2).padStart(64, '0') + (2_500_000).toString(16).padStart(64, '0'));
  assert.throws(() => qusdcTransferData('0x12', 1n));
  assert.throws(() => qusdcTransferData(to, 0n));
});

test('token evidence confirms only the exact call and its Transfer log', async () => {
  const confirmed = await chain().tokenTransferEvidence(hash, QIE_QUSDC_POSITION, instruction);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal((await chain({ head: '0x105' }).tokenTransferEvidence(hash, QIE_QUSDC_POSITION, instruction)).state, 'pending');
  assert.equal((await chain({ status: '0x0', logs: [] }).tokenTransferEvidence(hash, QIE_QUSDC_POSITION, instruction)).state, 'failed');
  // A different recipient or amount in the calldata, another contract, or value attached: mismatch.
  for (const bad of [{ input: qusdcTransferData(from, 2_500_000n) }, { input: qusdcTransferData(to, 1n) },
    { to: '0x3333333333333333333333333333333333333333' }, { value: '0x1' },
    { logs: [{ address: QIE_QUSDC_CONTRACT, topics: [TRANSFER, topic(from), topic(from)], data: '0x' + (2_500_000).toString(16).padStart(64, '0') }] },
    { logs: [] }])
    await assert.rejects(chain(bad).tokenTransferEvidence(hash, QIE_QUSDC_POSITION, instruction), QieEvidenceMismatch);
  await assert.rejects(chain().tokenTransferEvidence(hash, 'pos_unknown', instruction));
});

test('a linked wallet signs a QUSDC settlement that names the token, and it reconciles by token evidence', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,now())', [userId, `${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query('INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address) VALUES($1,$2,$3,$4,$5)',
    [id('cwa'), userId, accountId, QIE_NETWORK, account.address.toLowerCase()]);
  const key = id('key'), expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
  const base = { accountId, network: QIE_NETWORK, chainId: QIE_CHAIN_ID, from: account.address, to, amountAtomic: 2_500_000n, idempotencyKey: key, expiresAt };
  const tokenMessage = nativeTransferAuthorization({ ...base, token: { code: 'QUSDC', contract: QIE_QUSDC_CONTRACT } });
  assert.match(tokenMessage, /Asset: QUSDC \(0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5\)/);
  let evidence: SettlementEvidence = { state: 'confirmed', confirmations: '12', block_number: '300', block_hash: '0x' + 'd'.repeat(64) };
  const calls: string[] = [];
  const adapter: ChainSettlementAdapter = {
    network: QIE_NETWORK, chainId: QIE_CHAIN_ID, nativeAssetPositionId: QIE_NATIVE_POSITION, nativeAssetCode: 'QIEV3', nativeDecimals: 18,
    requiredConfirmations: 12n, transactionUrl: (h) => h, headBlock: async () => 200n,
    tokens: { [QIE_QUSDC_POSITION]: { code: 'QUSDC', decimals: 6, contract: QIE_QUSDC_CONTRACT } },
    nativeTransferEvidence: async () => { calls.push('native'); return evidence; },
    tokenTransferEvidence: async (_h, position, i) => { calls.push(`token:${position}:${i.amountAtomic}`); return evidence; },
  };
  const previous = chainAdapters[QIE_NETWORK];
  chainAdapters[QIE_NETWORK] = () => adapter;
  try {
    const input = { userId, accountId, network: QIE_NETWORK, from: account.address, to, amountAtomic: '2500000', idempotencyKey: key, expiresAt,
      assetPositionId: QIE_QUSDC_POSITION, signature: await account.signMessage({ message: tokenMessage }) };
    // A signature over the native message (no asset line) cannot authorize a token send.
    await assert.rejects(createNativeSettlement({ ...input, signature: await account.signMessage({ message: nativeTransferAuthorization(base) }) }),
      { code: 'wallet_signature_invalid' });
    await assert.rejects(createNativeSettlement({ ...input, assetPositionId: 'pos_unknown' }), { code: 'asset_unavailable' });
    const created = await createNativeSettlement(input);
    assert.deepEqual([created.asset, created.decimals, created.asset_position_id], ['QUSDC', 6, QIE_QUSDC_POSITION]);
    // The same key for the native asset is a different transfer.
    const nativeSig = await account.signMessage({ message: nativeTransferAuthorization(base) });
    await assert.rejects(createNativeSettlement({ ...input, assetPositionId: undefined, signature: nativeSig }), { code: 'idempotency_conflict' });
    await submitNativeSettlement(userId, created.id, `0x${randomBytes(32).toString('hex')}`);
    await reconcileChainSettlement(created.id, adapter);
    assert.deepEqual(calls, [`token:${QIE_QUSDC_POSITION}:2500000`]);
    const row = (await pool.query('SELECT * FROM chain_settlements WHERE id=$1', [created.id])).rows[0];
    assert.equal(row.status, 'confirmed');
    assert.equal(publicSettlement(row).asset, 'QUSDC');
    evidence = { ...evidence };
  } finally { chainAdapters[QIE_NETWORK] = previous; }
});
