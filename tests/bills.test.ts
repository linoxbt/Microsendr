import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { QieClient, QIE_QUSDC_CONTRACT } from '../packages/qie/src/index.js';
import { hashPassword } from '../services/api/src/consumer.js';
import { sendFromManagedWallet } from '../services/api/src/managed-transfer.js';
import { BillsProviderError, priceOf, reconcileOneBillOrder, type BillsProvider, type ProviderOrder } from '../services/api/src/bills.js';
import { buildApi } from '../services/api/src/app.js';

const treasury = privateKeyToAccount(generatePrivateKey()).address;
const env = ['KORA_MANAGED_TRANSFERS', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'BILLS_TREASURY_ADDRESS', 'BILLS_FEE_PERCENT'];
const saved = Object.fromEntries(env.map((key) => [key, process.env[key]]));
before(() => Object.assign(process.env, { KORA_MANAGED_TRANSFERS: 'true', PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'test-secret',
  BILLS_TREASURY_ADDRESS: treasury, BILLS_FEE_PERCENT: '2' }));

// A provider stand-in: an MTN airtime operator, an MTN data operator and a Netflix card.
const placed: { kind: string; reference: string }[] = [];
let failNext: BillsProviderError | null = null;
const orders = new Map<string, ProviderOrder>();
const fake: BillsProvider = {
  sandbox: true,
  async detectOperator(phone) { return phone.startsWith('234') ? (await this.operators('NG'))[0] : null; },
  async operators() {
    return [
      { id: 341, name: 'MTN Nigeria', countryCode: 'NG', logo: null, data: false, currency: 'NGN', denomination: 'RANGE', min: 50, max: 50000, fixed: [], plans: [] },
      { id: 645, name: 'MTN Nigeria Data', countryCode: 'NG', logo: null, data: true, currency: 'NGN', denomination: 'FIXED', min: null, max: null,
        fixed: [500, 1000], plans: [{ amount: 500, description: '1GB, 30 days' }, { amount: 1000, description: '3GB, 30 days' }] },
    ];
  },
  async operator(operatorId) { const o = (await this.operators('NG')).find((x) => x.id === operatorId); if (!o) throw new BillsProviderError(404, 'NOT_FOUND', 'No operator', true); return o; },
  async topupCostUsd(_operatorId, localAmount) { return Math.ceil((localAmount / 1600) * 100) / 100; },
  async topup(input) {
    if (failNext) { const e = failNext; failNext = null; throw e; }
    placed.push({ kind: 'topup', reference: input.reference });
    const order: ProviderOrder = { transactionId: `t${placed.length}`, status: 'SUCCESSFUL', details: { delivered: input.localAmount } };
    orders.set(input.reference, order);
    return order;
  },
  async findTopup(reference) { return orders.get(reference) ?? null; },
  async giftCards() { return [
    { id: 18, name: 'Netflix US', brand: 'Netflix', countryCode: 'US', logo: null, currency: 'USD', denomination: 'FIXED', fixed: [25, 50], min: null, max: null },
    { id: 99, name: 'Some Store US', brand: 'Some Store', countryCode: 'US', logo: null, currency: 'USD', denomination: 'FIXED', fixed: [10], min: null, max: null },
  ]; },
  async giftCard(productId) { const c = (await this.giftCards('US')).find((x) => x.id === productId); if (!c) throw new BillsProviderError(404, 'NOT_FOUND', 'No card', true); return c; },
  async giftCardCostUsd(_productId, faceAmount) { return faceAmount + 0.5; },
  async orderGiftCard(input) {
    placed.push({ kind: 'giftcard', reference: input.reference });
    const order: ProviderOrder = { transactionId: `g${placed.length}`, status: 'SUCCESSFUL', details: {} };
    orders.set(input.reference, order);
    return order;
  },
  async findGiftCardOrder(reference) { return orders.get(reference) ?? null; },
  async giftCardCodes(transactionId) { return [{ code: `NFLX-${transactionId}-CODE`, pin: null }]; },
};

// A QIE node that holds QUSDC for everyone and records broadcasts; Privy signs with each wallet's key.
const keys = new Map<string, ReturnType<typeof privateKeyToAccount>>();
const broadcasts: string[] = [];
const node = new QieClient((async (_url: string | URL | Request, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body));
  if (method === 'eth_sendRawTransaction') broadcasts.push(params[0]);
  const result = ({
    eth_chainId: '0x7c6', eth_blockNumber: '0x100', eth_getTransactionCount: `0x${(7 + broadcasts.length).toString(16)}`, eth_maxPriorityFeePerGas: '0x77359400',
    eth_estimateGas: '0x5208', eth_getBalance: `0x${(10n ** 20n).toString(16)}`, eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_call: `0x${(500n * 10n ** 6n).toString(16).padStart(64, '0')}`,
  } as Record<string, unknown>)[method] ?? (method === 'eth_sendRawTransaction' ? keccak256(params[0]) : null);
  return Response.json({ jsonrpc: '2.0', id: 1, result });
}) as typeof fetch);
const privy = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  const t = body.params.transaction;
  // Privy signs with the wallet named in the URL: /v1/wallets/{id}/rpc.
  const account = keys.get(String(url).split('/wallets/')[1].split('/')[0])!;
  const signed = await account.signTransaction({ type: 'eip1559', chainId: t.chain_id, to: t.to, value: BigInt(t.value), nonce: t.nonce,
    gas: BigInt(t.gas_limit), data: t.data, maxFeePerGas: BigInt(t.max_fee_per_gas), maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas) });
  return Response.json({ method: 'eth_signTransaction', data: { signed_transaction: signed, encoding: 'rlp' } });
}) as typeof fetch;

const app = await buildApi({ serveWeb: false, rateLimitMax: 10000, personal: {
  billsProvider: fake,
  billsPayment: (input) => sendFromManagedWallet(input, node, privy),
} });
after(async () => {
  await app.close();
  for (const key of env) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  await pool.end();
});

async function member() {
  const userId = id('usr'), accountId = id('acct'), token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const account = privateKeyToAccount(generatePrivateKey());
  const walletId = `privy_${randomBytes(8).toString('hex')}`;
  keys.set(walletId, account);
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at,password_hash) VALUES($1,$2,now(),$3)', [userId, `${userId}@example.test`, await hashPassword('bills-password-123')]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), userId, csrf]);
  await pool.query('INSERT INTO personal_managed_wallets(personal_user_id,account_id,privy_wallet_id,address) VALUES($1,$2,$3,$4)',
    [userId, accountId, walletId, account.address.toLowerCase()]);
  await pool.query("INSERT INTO personal_didit_sessions(id,personal_user_id,status) VALUES($1,$2,'Approved')", [id('kyc'), userId]);
  const headers = { origin: 'http://127.0.0.1:4310', cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf };
  const ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const post = (url: string, payload: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload: payload as object, remoteAddress: ip() });
  const get = (url: string) => app.inject({ url, headers, remoteAddress: ip() });
  await post('/personal/api/payment-auth/pin', { pin: '402913', password: 'bills-password-123' });
  return { userId, account, post, get };
}
const settle = (settlementId: string) => pool.query(`UPDATE chain_settlements SET status='confirmed',block_number=300,
  block_hash=$2,observed_confirmations=12,updated_at=now() WHERE id=$1`, [settlementId, '0x' + 'b'.repeat(64)]);
const drain = async () => { while (await reconcileOneBillOrder(fake)) { /* due orders */ } };

test('the price is the provider cost plus the fee, at least five cents, in QUSDC base units', () => {
  process.env.BILLS_FEE_PERCENT = '2';
  assert.deepEqual(priceOf(10), { feeUsd: 0.2, atomic: 10_200_000n });
  assert.deepEqual(priceOf(0.31), { feeUsd: 0.05, atomic: 360_000n });
});

test('airtime: the network is found from the number, paid in QUSDC to the treasury, delivered once the payment confirms', async () => {
  const who = await member();
  assert.equal((await who.get('/personal/api/bills/config')).json().available, true);
  const operator = (await who.get('/personal/api/bills/operator?phone=%2B2348031234567&country=NG')).json().operator;
  assert.equal(operator.name, 'MTN Nigeria');
  assert.equal((await who.get('/personal/api/bills/operator?phone=4479001234567&country=NG')).statusCode, 404);
  const body = { kind: 'airtime', country: 'NG', phone: '+2348031234567', operator_id: 341, amount: 1600 };
  const quote = (await who.post('/personal/api/bills/quote', body)).json();
  assert.deepEqual([quote.price_atomic, quote.pay_to, quote.face], ['1050000', treasury, { amount: 1600, currency: 'NGN' }]);
  // Never more than the customer saw; a wrong PIN pays nothing.
  assert.equal((await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: '1000000', pin: '402913' }, { 'idempotency-key': id('key') })).json().error.code, 'price_changed');
  assert.equal((await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '000001' }, { 'idempotency-key': id('key') })).statusCode, 401);
  const key = id('key');
  const ordered = await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': key });
  assert.equal(ordered.statusCode, 200, ordered.body);
  const order = ordered.json();
  assert.equal(order.status, 'paid');
  // The payment is a QUSDC transfer of exactly the price, to the treasury.
  const tx = parseTransaction(broadcasts.at(-1) as Hex);
  assert.equal(tx.to?.toLowerCase(), QIE_QUSDC_CONTRACT.toLowerCase());
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  assert.deepEqual([call.functionName, String(call.args[0]).toLowerCase(), call.args[1]], ['transfer', treasury.toLowerCase(), 1_050_000n]);
  // A repeat with the same key is the same order, not a second payment.
  assert.equal((await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': key })).json().id, order.id);
  // Not fulfilled until the payment is confirmed on chain.
  await drain();
  assert.equal(placed.filter((p) => p.reference === order.id).length, 0);
  const row = (await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0];
  await settle(row.settlement_id);
  await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
  await drain();
  assert.equal(placed.filter((p) => p.reference === order.id).length, 1);
  assert.equal((await who.get(`/personal/api/bills/orders/${order.id}`)).json().status, 'delivered');
});

test('data plans come from the network’s data operator and only offered plans can be bought', async () => {
  const who = await member();
  const data = (await who.get('/personal/api/bills/operator?phone=2348031234567&country=NG&kind=data')).json().operator;
  assert.deepEqual(data.plans.map((p: { description: string }) => p.description), ['1GB, 30 days', '3GB, 30 days']);
  const off = await who.post('/personal/api/bills/quote', { kind: 'data', country: 'NG', phone: '2348031234567', operator_id: 645, amount: 700 });
  assert.equal(off.json().error.code, 'amount_not_offered');
  const wrongKind = await who.post('/personal/api/bills/quote', { kind: 'airtime', country: 'NG', phone: '2348031234567', operator_id: 645, amount: 500 });
  assert.equal(wrongKind.json().error.code, 'operator_mismatch');
  const quote = (await who.post('/personal/api/bills/quote', { kind: 'data', country: 'NG', phone: '2348031234567', operator_id: 645, amount: 1000 })).json();
  assert.equal(quote.product_name, 'MTN Nigeria Data · 3GB, 30 days');
});

test('subscription cards: only subscription brands, the code is read from the provider once delivered', async () => {
  const who = await member();
  const cards = (await who.get('/personal/api/bills/giftcards?country=US')).json().data;
  assert.deepEqual(cards.map((c: { brand: string }) => c.brand), ['Netflix']);
  const body = { kind: 'giftcard', country: 'US', product_id: 18, amount: 25 };
  assert.equal((await who.post('/personal/api/bills/quote', { ...body, product_id: 99, amount: 10 })).json().error.code, 'product_unavailable');
  const quote = (await who.post('/personal/api/bills/quote', body)).json();
  assert.equal(quote.price_atomic, '26010000');
  const order = (await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': id('key') })).json();
  assert.equal(order.recipient, `${who.userId}@example.test`);
  assert.equal((await who.get(`/personal/api/bills/orders/${order.id}`)).json().codes, undefined);
  await settle((await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0].settlement_id);
  await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
  await drain();
  const delivered = (await who.get(`/personal/api/bills/orders/${order.id}`)).json();
  assert.equal(delivered.status, 'delivered');
  assert.match(delivered.codes[0].code, /^NFLX-g\d+-CODE$/);
  const stored = (await pool.query('SELECT delivery::text FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0].delivery;
  assert.doesNotMatch(stored, /NFLX/, 'codes are not stored');
});

test('a definite provider refusal is marked for refund; a failed payment closes the order; others cannot see it', async () => {
  const who = await member(), other = await member();
  const body = { kind: 'airtime', country: 'NG', phone: '2348031234567', operator_id: 341, amount: 800 };
  const quote = (await who.post('/personal/api/bills/quote', body)).json();
  const placedOrder = await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': id('key') });
  assert.equal(placedOrder.statusCode, 200, placedOrder.body);
  const order = placedOrder.json();
  assert.equal((await other.get(`/personal/api/bills/orders/${order.id}`)).statusCode, 404);
  await settle((await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0].settlement_id);
  await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
  failNext = new BillsProviderError(400, 'INVALID_PHONE', 'Invalid phone number', true);
  await drain();
  assert.equal((await who.get(`/personal/api/bills/orders/${order.id}`)).json().status, 'refund_due');
  const secondResponse = await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': id('key') });
  assert.equal(secondResponse.statusCode, 200, secondResponse.body);
  const second = secondResponse.json();
  const settlementId = (await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [second.id])).rows[0].settlement_id;
  await pool.query("UPDATE chain_settlements SET status='expired',last_error='test',updated_at=now() WHERE id=$1", [settlementId]);
  await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [second.id]);
  await drain();
  assert.equal((await who.get(`/personal/api/bills/orders/${second.id}`)).json().status, 'payment_failed');
  assert.equal(placed.filter((p) => p.reference === second.id).length, 0);
});

test('after an unclear provider error the order is only read back, never placed twice', async () => {
  const who = await member();
  const body = { kind: 'airtime', country: 'NG', phone: '2348031234567', operator_id: 341, amount: 500 };
  const quote = (await who.post('/personal/api/bills/quote', body)).json();
  const order = (await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': id('key') })).json();
  await settle((await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0].settlement_id);
  await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
  failNext = new BillsProviderError(504, 'HTTP_504', 'Gateway timeout', false);
  await reconcileOneBillOrder(fake).catch(() => undefined);
  for (let i = 0; i < 3; i++) {
    await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
    await reconcileOneBillOrder(fake);
  }
  assert.equal(placed.filter((p) => p.reference === order.id).length, 0, 'no second attempt');
  assert.equal((await who.get(`/personal/api/bills/orders/${order.id}`)).json().status, 'fulfilling');
  await pool.query('UPDATE personal_bill_orders SET attempts=25,next_check_at=now() WHERE id=$1', [order.id]);
  await reconcileOneBillOrder(fake);
  assert.equal((await who.get(`/personal/api/bills/orders/${order.id}`)).json().status, 'refund_due');
});

test('with the MicrosendrPay escrow: the payment is held on chain, settled on delivery, refunded on failure', async () => {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { createPublicClient, createWalletClient, http } = await import('viem');
  const ganache = createRequire(import.meta.url)('ganache');
  const keysForChain = [generatePrivateKey(), generatePrivateKey()];
  const [deployerKey, operatorKey] = keysForChain;
  const server = ganache.server({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 1990 },
    wallet: { accounts: keysForChain.map((secretKey) => ({ secretKey, balance: '0x56bc75e2d63100000' })) } });
  await new Promise<void>((resolve, reject) => server.listen(0, (e: Error | null) => (e ? reject(e) : resolve())));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const chain = { id: 1990, name: 'test', nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const deployer = createWalletClient({ account: privateKeyToAccount(deployerKey), chain, transport: http(rpcUrl) });
  const artifact = (name: string) => JSON.parse(readFileSync(`contracts/artifacts/${name}.json`, 'utf8'));
  const deploy = async (name: string, args: unknown[]) => (await reader.waitForTransactionReceipt({
    hash: await deployer.deployContract({ abi: artifact(name).abi, bytecode: artifact(name).bytecode, args } as never) })).contractAddress!;
  const token = await deploy('TestToken', []);
  const vault = privateKeyToAccount(generatePrivateKey()).address;
  const contract = await deploy('MicrosendrPay', [token, vault, privateKeyToAccount(operatorKey).address]);
  const balanceOf = (who: string) => reader.readContract({ address: token, abi: artifact('TestToken').abi, functionName: 'balanceOf', args: [who] } as never) as Promise<bigint>;
  const mintTo = async (who: string, amount: bigint) => reader.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: token, abi: artifact('TestToken').abi, functionName: 'mint', args: [who, amount] } as never) });
  const previous = { address: process.env.MICROSENDR_PAY_ADDRESS, key: process.env.OPERATOR_PRIVATE_KEY, rpc: process.env.QIE_RPC_URL };
  Object.assign(process.env, { MICROSENDR_PAY_ADDRESS: contract, OPERATOR_PRIVATE_KEY: operatorKey, QIE_RPC_URL: rpcUrl });
  try {
    const { configuredEscrow } = await import('../services/api/src/escrow.js');
    const escrow = configuredEscrow()!;
    const who = await member();
    const body = { kind: 'airtime', country: 'NG', phone: '2348031234567', operator_id: 341, amount: 1600 };
    const quote = (await who.post('/personal/api/bills/quote', body)).json();
    // Customers now pay the contract, not a plain treasury address.
    assert.equal(quote.pay_to.toLowerCase(), contract.toLowerCase());
    const order = (await who.post('/personal/api/bills/orders', { ...body, max_price_atomic: quote.price_atomic, pin: '402913' }, { 'idempotency-key': id('key') })).json();
    // The QUSDC transfer lands in the contract (here: minted to stand in for it), then confirms.
    await mintTo(contract, BigInt(quote.price_atomic));
    await settle((await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [order.id])).rows[0].settlement_id);
    await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [order.id]);
    for (let i = 0; i < 4 && await reconcileOneBillOrder(fake, escrow); i++) { /* hold, deliver, settle */ }
    const done = (await who.get(`/personal/api/bills/orders/${order.id}`)).json();
    assert.equal(done.status, 'delivered');
    assert.equal(done.escrow.state, 'settled');
    assert.match(done.escrow.hold_tx, /^0x[0-9a-f]{64}$/);
    assert.equal(await escrow.state(order.id), 'settled');
    assert.equal(await balanceOf(vault), BigInt(quote.price_atomic));
    // A purchase the provider refuses is refunded on chain to the wallet that paid.
    const second = (await who.post('/personal/api/bills/orders', { ...body, amount: 800, max_price_atomic: '9000000', pin: '402913' }, { 'idempotency-key': id('key') })).json();
    await mintTo(contract, BigInt(second.price_atomic));
    await settle((await pool.query('SELECT settlement_id FROM personal_bill_orders WHERE id=$1', [second.id])).rows[0].settlement_id);
    await pool.query('UPDATE personal_bill_orders SET next_check_at=now() WHERE id=$1', [second.id]);
    await reconcileOneBillOrder(fake, escrow); // hold
    failNext = new BillsProviderError(400, 'INVALID_PHONE', 'Invalid phone number', true);
    await reconcileOneBillOrder(fake, escrow); // provider refuses
    await reconcileOneBillOrder(fake, escrow); // refund
    const refunded = (await who.get(`/personal/api/bills/orders/${second.id}`)).json();
    assert.deepEqual([refunded.status, refunded.escrow.state], ['refunded', 'refunded']);
    assert.equal(await balanceOf(who.account.address), BigInt(second.price_atomic));
  } finally {
    for (const [name, value] of [['MICROSENDR_PAY_ADDRESS', previous.address], ['OPERATOR_PRIVATE_KEY', previous.key], ['QIE_RPC_URL', previous.rpc]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await server.close();
  }
});
