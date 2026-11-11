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

test('retrying a key whose attempt failed says so instead of reporting a transfer', async () => {
  const p = await person();
  const key = id('key');
  await assert.rejects(send(p, QIE, key, node(), privy(p.account, (t) => { t.to = `0x${randomBytes(20).toString('hex')}`; })), { code: 'signature_mismatch' });
  await assert.rejects(send(p, QIE, key), { code: 'transfer_failed' });
});

test('nonces skip past every unconfirmed transaction the wallet already signed', async () => {
  const p = await person();
  // An earlier transfer with nonce 7 was signed but its broadcast never reached the node,
  // so the node still reports 7 as the next nonce.
  await pool.query(`INSERT INTO chain_settlements(id,personal_user_id,account_id,asset_position_id,network,chain_id,direction,source_address,
    destination_address,amount_atomic,required_confirmations,minimum_block_number,idempotency_key,authorization_expires_at,custody,nonce,status,tx_hash,signed_transaction)
    VALUES($1,$2,$3,'pos_qiev3_mainnet','qie-mainnet','1990','outbound',$4,$5,1,12,1,$6,now(),'managed',7,'submitted',$7,'0x02f8')`,
    [id('stl'), p.userId, p.accountId, p.account.address.toLowerCase(), recipient, id('key'), `0x${randomBytes(32).toString('hex')}`]);
  const qie = node();
  await send(p, QIE, id('key'), qie);
  assert.equal(parseTransaction(qie.broadcasts[0] as Hex).nonce, 8);
});

test('a legacy or otherwise unexpected transaction type is never broadcast', async () => {
  const p = await person();
  const qie = node();
  const legacy = (async (_url: string | URL | Request, init?: RequestInit) => {
    const t = JSON.parse(String(init?.body)).params.transaction;
    const signed = await p.account.signTransaction({ type: 'legacy', chainId: t.chain_id, to: t.to, value: BigInt(t.value), nonce: t.nonce,
      gas: BigInt(t.gas_limit), gasPrice: BigInt(t.max_fee_per_gas) });
    return Response.json({ data: { signed_transaction: signed } });
  }) as typeof fetch;
  await assert.rejects(sendFromManagedWallet({ userId: p.userId, accountId: p.accountId, to: recipient, amountAtomic: QIE.toString(), idempotencyKey: id('key') },
    qie.client, legacy), { code: 'signature_mismatch' });
  assert.equal(qie.broadcasts.length, 0);
});

test('nothing is broadcast once the attempt was closed while signing', async () => {
  const p = await person();
  const qie = node();
  const signer = privy(p.account);
  const slow = (async (url: string | URL | Request, init?: RequestInit) => {
    // The worker sweep closes the attempt while Privy is still signing.
    await pool.query("UPDATE chain_settlements SET status='expired' WHERE personal_user_id=$1 AND status='awaiting_submission'", [p.userId]);
    return signer.request(url, init);
  }) as typeof fetch;
  await assert.rejects(sendFromManagedWallet({ userId: p.userId, accountId: p.accountId, to: recipient, amountAtomic: QIE.toString(), idempotencyKey: id('key') },
    qie.client, slow), { code: 'transfer_expired' });
  assert.equal(qie.broadcasts.length, 0);
});

test('without identity verification, sends are held to the unverified limits', async () => {
  process.env.KORA_MANAGED_TRANSFERS_REQUIRE_KYC = 'false';
  process.env.KORA_UNVERIFIED_TRANSFER_MAX_QIE = '3';
  process.env.KORA_UNVERIFIED_TRANSFER_DAILY_QIE = '5';
  try {
    const p = await person({ kyc: '' });
    await assert.rejects(send(p, 4n * QIE), { code: 'transfer_limit' });
    await send(p, 3n * QIE);
    await assert.rejects(send(p, 3n * QIE), { code: 'daily_limit' });
    // A verified account keeps the normal limits.
    const v = await person();
    await send(v, 9n * QIE);
  } finally {
    delete process.env.KORA_MANAGED_TRANSFERS_REQUIRE_KYC;
    delete process.env.KORA_UNVERIFIED_TRANSFER_MAX_QIE;
    delete process.env.KORA_UNVERIFIED_TRANSFER_DAILY_QIE;
  }
});

test('a signed transfer whose nonce was used by another transaction is closed, and only then', async () => {
  const p = await person();
  const qie = node();
  const sent = await send(p, QIE, id('key'), qie);
  const row = (await pool.query('SELECT nonce FROM chain_settlements WHERE id=$1', [sent.id])).rows[0];
  let reads = 0;
  const adapter = (minedOnSecondRead: boolean, nonce: bigint) => ({ network: 'qie-mainnet', chainId: 1990n, nativeAssetPositionId: 'pos_qiev3_mainnet',
    nativeAssetCode: 'QIEV3', nativeDecimals: 18, requiredConfirmations: 12n, transactionUrl: (h: string) => h, headBlock: async () => 300n,
    sendRawTransaction: async () => 'ok', accountNonce: async () => nonce,
    nativeTransferEvidence: async () => {
      reads += 1;
      return minedOnSecondRead && reads > 1
        ? { state: 'pending' as const, confirmations: '1', block_number: '299', block_hash: '0x' + 'a'.repeat(64) }
        : { state: 'pending' as const, confirmations: '0', block_number: null, block_hash: null };
    } });
  // The nonce is not used yet: keep waiting.
  await reconcileChainSettlement(sent.id, adapter(false, BigInt(row.nonce)));
  assert.equal((await pool.query('SELECT status FROM chain_settlements WHERE id=$1', [sent.id])).rows[0].status, 'pending');
  // Our own transaction was mined between the reads: not a replacement.
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(true, BigInt(row.nonce) + 1n));
  assert.equal((await pool.query('SELECT status FROM chain_settlements WHERE id=$1', [sent.id])).rows[0].status, 'pending');
  const state = async () => (await pool.query('SELECT status,last_error,replaced_seen_at FROM chain_settlements WHERE id=$1', [sent.id])).rows[0];
  // Missing after the nonce moved on: noted, but one node's view is not enough yet.
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(false, BigInt(row.nonce) + 1n));
  let seen = await state();
  assert.equal(seen.status, 'pending');
  assert.ok(seen.replaced_seen_at);
  // Seen again within ten minutes: still open.
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(false, BigInt(row.nonce) + 1n));
  assert.equal((await state()).status, 'pending');
  // Found mined after all: the note is cleared.
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(true, BigInt(row.nonce) + 1n));
  seen = await state();
  assert.deepEqual([seen.status, seen.replaced_seen_at], ['pending', null]);
  // Still missing ten minutes after it was first seen missing: replaced.
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(false, BigInt(row.nonce) + 1n));
  await pool.query("UPDATE chain_settlements SET replaced_seen_at=now()-interval '11 minutes' WHERE id=$1", [sent.id]);
  reads = 0;
  await reconcileChainSettlement(sent.id, adapter(false, BigInt(row.nonce) + 1n));
  const closed = await state();
  assert.deepEqual([closed.status, closed.last_error], ['expired', 'nonce_replaced']);
});

test('after a recovery-only credential change, account-wallet sends wait out a 24-hour hold', async () => {
  const p = await person();
  const { holdSends } = await import('../services/api/src/send-hold.js');
  const key = id('key');
  const first = await send(p, QIE, key);
  await holdSends(p.userId);
  // A send recorded before the hold is still replayed, but nothing new is signed.
  assert.equal((await send(p, QIE, key)).id, first.id);
  const signer = privy(p.account);
  await assert.rejects(send(p, QIE, id('key'), node(), signer), { code: 'send_hold' });
  assert.equal(signer.calls.length, 0);
  // The hold only ever extends, never shortens; once it lapses, sends work again.
  const until = (await pool.query('SELECT send_hold_until FROM personal_users WHERE id=$1', [p.userId])).rows[0].send_hold_until;
  assert.ok(new Date(until).getTime() > Date.now() + 23 * 3600_000);
  await pool.query("UPDATE personal_users SET send_hold_until=now()-interval '1 minute' WHERE id=$1", [p.userId]);
  await send(p, QIE);
});

test('in production, account-wallet sends need the Privy signing policy', async () => {
  const { managedTransfersEnabled } = await import('../services/api/src/managed-transfer.js');
  const saved = { env: process.env.NODE_ENV, policy: process.env.PRIVY_POLICY_ID, allow: process.env.KORA_ALLOW_UNPOLICED_TRANSFERS };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PRIVY_POLICY_ID; delete process.env.KORA_ALLOW_UNPOLICED_TRANSFERS;
    assert.equal(managedTransfersEnabled(), false);
    const p = await person();
    await assert.rejects(send(p, QIE), { code: 'managed_transfers_unavailable' });
    process.env.PRIVY_POLICY_ID = 'policy_test';
    assert.equal(managedTransfersEnabled(), true);
  } finally {
    for (const [name, value] of [['NODE_ENV', saved.env], ['PRIVY_POLICY_ID', saved.policy], ['KORA_ALLOW_UNPOLICED_TRANSFERS', saved.allow]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
