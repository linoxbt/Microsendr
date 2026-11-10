import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { id, pool } from '../packages/database/src/index.js';
import { QieClient, QIE_QUSDC_CONTRACT, qusdcTransferData } from '../packages/qie/src/index.js';
import { chainAdapters, reconcileChainSettlement } from '../packages/settlement/src/service.js';
import { sendFromManagedWallet } from '../services/api/src/managed-transfer.js';
import { hashPassword } from '../services/api/src/consumer.js';
import { buildApi } from '../services/api/src/app.js';
import { hashKey } from '../packages/payments/src/auth.js';

const env = ['KORA_MANAGED_TRANSFERS', 'KORA_MANAGED_TRANSFERS_REQUIRE_KYC', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'KORA_MANAGED_TRANSFER_MAX_QIE', 'KORA_MANAGED_TRANSFER_DAILY_QIE'];
const saved = Object.fromEntries(env.map((key) => [key, process.env[key]]));
before(() => Object.assign(process.env, { KORA_MANAGED_TRANSFERS: 'true', PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'test-secret', KORA_MANAGED_TRANSFER_MAX_QIE: '10', KORA_MANAGED_TRANSFER_DAILY_QIE: '15' }));
after(async () => {
  for (const key of env) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  await pool.end();
});

const QIE = 10n ** 18n;
const recipient = `0x${randomBytes(20).toString('hex')}`;

async function person({ kyc = 'Approved', verified = true } = {}) {
  const key = generatePrivateKey(), account = privateKeyToAccount(key);
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at,password_hash) VALUES($1,$2,$3,$4)',
    [userId, `${userId}@example.test`, verified ? new Date() : null, await hashPassword('send-password-12345')]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  const walletId = `privy_${randomBytes(8).toString('hex')}`;
  await pool.query('INSERT INTO personal_managed_wallets(personal_user_id,account_id,privy_wallet_id,address) VALUES($1,$2,$3,$4)',
    [userId, accountId, walletId, account.address.toLowerCase()]);
  if (kyc) await pool.query('INSERT INTO personal_didit_sessions(id,personal_user_id,status) VALUES($1,$2,$3)', [id('kyc'), userId, kyc]);
  return { userId, accountId, account, walletId };
}

// A QIE node with 1 gwei base fee; records broadcasts.
function node(balance = 100n * QIE, qusdc = 0n) {
  const broadcasts: string[] = [];
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    if (method === 'eth_sendRawTransaction') broadcasts.push(params[0]);
    const result = ({
      eth_chainId: '0x7c6', eth_blockNumber: '0x100', eth_getTransactionCount: '0x7', eth_maxPriorityFeePerGas: '0x77359400',
      eth_estimateGas: '0x5208', eth_getBalance: `0x${balance.toString(16)}`, eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
      eth_call: `0x${qusdc.toString(16).padStart(64, '0')}`,
    } as Record<string, unknown>)[method] ?? (method === 'eth_sendRawTransaction' ? keccak256(params[0]) : null);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { client: new QieClient(request), broadcasts };
}

// Privy stand-in that signs whatever it is asked with the wallet's key (or tampers).
function privy(account: ReturnType<typeof privateKeyToAccount>, tamper?: (tx: Record<string, unknown>) => void) {
  const calls: unknown[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    const t = { ...body.params.transaction };
    tamper?.(t);
    const signed = await account.signTransaction({
      type: 'eip1559', chainId: t.chain_id, to: t.to, value: BigInt(t.value), nonce: t.nonce, gas: BigInt(t.gas_limit), data: t.data,
      maxFeePerGas: BigInt(t.max_fee_per_gas), maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas),
    });
    return Response.json({ method: 'eth_signTransaction', data: { signed_transaction: signed, encoding: 'rlp' } });
  }) as typeof fetch;
  return { request, calls };
}

const send = (p: Awaited<ReturnType<typeof person>>, amount: bigint, key = id('key'), qie = node(), signer = privy(p.account)) =>
  sendFromManagedWallet({ userId: p.userId, accountId: p.accountId, to: recipient, amountAtomic: amount.toString(), idempotencyKey: key }, qie.client, signer.request);

test('a managed transfer is signed by Privy, verified, recorded before broadcast and idempotent', async () => {
  const p = await person();
  const qie = node(), signer = privy(p.account), key = id('key');
  const sent = await send(p, 2n * QIE, key, qie, signer);
  assert.equal(sent.status, 'submitted');
  assert.equal(sent.custody, 'managed');
  assert.equal(qie.broadcasts.length, 1);
  assert.equal(sent.tx_hash, keccak256(qie.broadcasts[0] as Hex));
  const tx = parseTransaction(qie.broadcasts[0] as Hex);
  assert.deepEqual([tx.to?.toLowerCase(), tx.value, tx.chainId, tx.nonce], [recipient, 2n * QIE, 1990, 7]);
  const call = signer.calls[0] as { url: string; body: { method: string } };
  assert.equal(call.url, `https://api.privy.io/v1/wallets/${p.walletId}/rpc`);
  assert.equal(call.body.method, 'eth_signTransaction');
  const row = (await pool.query('SELECT signed_transaction,source_address FROM chain_settlements WHERE id=$1', [sent.id])).rows[0];
  assert.equal(row.signed_transaction, qie.broadcasts[0]);
  assert.equal(row.source_address, p.account.address.toLowerCase());
  // A retry with the same key returns the same transfer without signing again.
  assert.equal((await send(p, 2n * QIE, key, qie, signer)).id, sent.id);
  assert.equal(signer.calls.length, 1);
  await assert.rejects(send(p, 3n * QIE, key, qie, signer), { code: 'idempotency_conflict' });
  // While unmined, reconciliation re-sends the identical bytes, never a new signature.
  const pending = { ...qie.client, network: 'qie-mainnet', chainId: 1990n, nativeAssetPositionId: 'pos_qiev3_mainnet', nativeAssetCode: 'QIEV3',
    nativeDecimals: 18, requiredConfirmations: 12n, transactionUrl: (h: string) => h, headBlock: async () => 300n,
    nativeTransferEvidence: async () => ({ state: 'pending' as const, confirmations: '0', block_number: null, block_hash: null }),
    sendRawTransaction: (raw: string) => qie.client.sendRawTransaction(raw) };
  await reconcileChainSettlement(sent.id, pending);
  assert.deepEqual(qie.broadcasts, [row.signed_transaction, row.signed_transaction]);
});

test('a signed transaction that differs from the request is never broadcast', async () => {
  const p = await person();
  const qie = node();
  const attacker = `0x${randomBytes(20).toString('hex')}`;
  const key = id('key');
  await assert.rejects(send(p, QIE, key, qie, privy(p.account, (t) => { t.to = attacker; })), { code: 'signature_mismatch' });
  // A signature from some other key is refused too.
  await assert.rejects(send(p, QIE, id('key'), qie, privy(privateKeyToAccount(generatePrivateKey()))), { code: 'signature_mismatch' });
  assert.equal(qie.broadcasts.length, 0);
  assert.deepEqual((await pool.query('SELECT status,tx_hash,last_error FROM chain_settlements WHERE personal_user_id=$1 AND idempotency_key=$2', [p.userId, key])).rows[0],
    { status: 'expired', tx_hash: null, last_error: 'signature_mismatch' });
  // The wallet is released for the next attempt.
  assert.equal((await send(p, QIE, id('key'), qie)).status, 'submitted');
});

test('verification, identity, limits and balance are enforced before anything is signed', async () => {
  const unverified = await person({ verified: false });
  await assert.rejects(send(unverified, QIE), { code: 'verified_email_required' });
  const noKyc = await person({ kyc: 'In Review' });
  await assert.rejects(send(noKyc, QIE), { code: 'identity_verification_required' });
  const p = await person();
  await assert.rejects(send(p, 11n * QIE), { code: 'transfer_limit' });
  await send(p, 9n * QIE);
  await assert.rejects(send(p, 7n * QIE), { code: 'daily_limit' });
  const poor = await person();
  await assert.rejects(send(poor, 5n * QIE, id('key'), node(5n * QIE)), { code: 'insufficient_funds' });
  process.env.KORA_MANAGED_TRANSFERS = 'false';
  try { await assert.rejects(send(p, QIE), { code: 'managed_transfers_unavailable' }); }
  finally { process.env.KORA_MANAGED_TRANSFERS = 'true'; }
});

test('only one transfer signs at a time per wallet', async () => {
  const p = await person();
  await pool.query("UPDATE personal_managed_wallets SET signing_until=now()+interval '1 minute' WHERE personal_user_id=$1", [p.userId]);
  await assert.rejects(send(p, QIE), { code: 'transfer_in_progress' });
});

test('the transfer route requires CSRF, the account password and an idempotency key', async () => {
  const p = await person();
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), p.userId, csrf]);
  const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  const previous = chainAdapters['qie-mainnet'];
  try {
    const headers = { origin: 'http://127.0.0.1:4310', cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf, 'idempotency-key': id('key') };
    const url = '/personal/api/wallets/managed/transfers';
    const payload = { to: recipient, amount_atomic: QIE.toString(), password: 'wrong-password-000' };
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-kora-csrf': '0'.repeat(64) }, payload })).statusCode, 403);
    const wrong = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, 'invalid_password');
    const listed = (await app.inject({ url: '/personal/api/wallets', headers })).json();
    assert.equal(listed.data[0].can_send, true);
    assert.equal(listed.managed_transfers.per_transfer_wei, (10n * QIE).toString());
  } finally {
    chainAdapters['qie-mainnet'] = previous;
    await app.close();
  }
});

test('the account wallet sends QUSDC as an exact transfer call, with its own limits and balance checks', async () => {
  const p = await person();
  const USDC = 1_000_000n;
  const qie = node(100n * QIE, 50n * USDC), signer = privy(p.account), key = id('key');
  const sendToken = (amount: bigint, k = id('key'), chain = qie) => sendFromManagedWallet({ userId: p.userId, accountId: p.accountId, to: recipient,
    amountAtomic: amount.toString(), idempotencyKey: k, asset: 'QUSDC' }, chain.client, signer.request);
  const sent = await sendToken(25n * USDC, key);
  assert.deepEqual([sent.asset, sent.decimals, sent.status], ['QUSDC', 6, 'submitted']);
  const tx = parseTransaction(qie.broadcasts[0] as Hex);
  assert.equal(tx.to?.toLowerCase(), QIE_QUSDC_CONTRACT.toLowerCase());
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.data, qusdcTransferData(recipient, 25n * USDC));
  // The same key for QIE is a different transfer.
  await assert.rejects(send(p, 25n * USDC, key, qie, signer), { code: 'idempotency_conflict' });
  // QUSDC limits (default 1000 per send) and balance are separate from QIE's.
  await assert.rejects(sendToken(1001n * USDC), { code: 'transfer_limit' });
  await assert.rejects(sendToken(60n * USDC), { code: 'insufficient_funds' });
  // Gas is paid in QIE even for a token send.
  await assert.rejects(sendToken(5n * USDC, id('key'), node(0n, 50n * USDC)), { code: 'insufficient_funds' });
  // A signature that swaps the calldata recipient is never broadcast.
  const attacker = `0x${randomBytes(20).toString('hex')}`;
  const tampered = privy(p.account, (t) => { t.data = qusdcTransferData(attacker, 5n * USDC); });
  const fresh = node(100n * QIE, 50n * USDC);
  await assert.rejects(sendFromManagedWallet({ userId: p.userId, accountId: p.accountId, to: recipient, amountAtomic: (5n * USDC).toString(),
    idempotencyKey: id('key'), asset: 'QUSDC' }, fresh.client, tampered.request), { code: 'signature_mismatch' });
  assert.equal(fresh.broadcasts.length, 0);
});
