import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { buildApi } from '../services/api/src/app.js';
import { QIE_CHAIN_ID, QIE_NATIVE_POSITION, QIE_NETWORK, QieEvidenceMismatch } from '../packages/qie/src/index.js';
import { nativeTransferAuthorization, type ChainSettlementAdapter, type SettlementEvidence } from '../packages/settlement/src/index.js';
import { chainAdapters, createNativeSettlement, reconcileChainSettlement, submitNativeSettlement } from '../packages/settlement/src/service.js';

after(async () => { await pool.end(); });

test('signed QIE settlement is idempotent, hash-unique, and reconciles only matching new chain evidence', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,now())', [userId,`${userId}@example.test`]);
  await pool.query('UPDATE personal_users SET privy_app_id=$2,privy_subject=$3 WHERE id=$1',[userId,'settlement-test',`did:privy:${userId}`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)",[accountId,userId]);
  await pool.query("INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address) VALUES($1,$2,$3,$4,$5)",
    [id('cwa'),userId,accountId,QIE_NETWORK,account.address.toLowerCase()]);
  const to = '0x2222222222222222222222222222222222222222';
  const key = id('key'), expiresAt = new Date(Date.now()+4*60_000).toISOString(), amountAtomic = 100000000000000000n;
  const signed = (idempotencyKey: string, amount = amountAtomic) => account.signMessage({ message: nativeTransferAuthorization({
    accountId, network: QIE_NETWORK, chainId: QIE_CHAIN_ID, from: account.address, to,
    amountAtomic: amount, idempotencyKey, expiresAt,
  }) });
  let evidence: SettlementEvidence = { state: 'pending', confirmations: '2', block_number: '101', block_hash: '0x'+'b'.repeat(64) };
  const adapter: ChainSettlementAdapter = { network: QIE_NETWORK, chainId: QIE_CHAIN_ID,
    nativeAssetPositionId: QIE_NATIVE_POSITION, nativeAssetCode: 'QIEV3',nativeDecimals:18,requiredConfirmations:12n,
    transactionUrl: hash => `https://mainnet.qie.digital/tx/${hash}`,headBlock: async () => 100n,
    nativeTransferEvidence: async (_hash, instruction) => {
      assert.equal(instruction.from,account.address.toLowerCase());
      assert.equal(instruction.to,to.toLowerCase());
      assert.equal(instruction.amountAtomic,amountAtomic);
      return evidence;
    },
  };
  const previous = chainAdapters[QIE_NETWORK];
  chainAdapters[QIE_NETWORK] = () => adapter;
  try {
    const input = { userId, accountId, network: QIE_NETWORK, from: account.address, to,
      amountAtomic: amountAtomic.toString(), idempotencyKey: key, expiresAt, signature: await signed(key) };
    const created = await createNativeSettlement(input);
    assert.equal(created.status,'awaiting_submission');
    assert.equal((await createNativeSettlement(input)).id,created.id);
    await assert.rejects(createNativeSettlement({ ...input, amountAtomic: '2' }), { code: 'wallet_signature_invalid' });
    await assert.rejects(createNativeSettlement({ ...input, amountAtomic: '2', signature: await signed(key,2n) }), { code: 'idempotency_conflict' });
    const hash = `0x${randomBytes(32).toString('hex')}`;
    assert.equal((await submitNativeSettlement(userId,created.id,hash)).status,'submitted');
    assert.equal((await submitNativeSettlement(userId,created.id,hash)).tx_hash,hash);
    await assert.rejects(submitNativeSettlement(userId,created.id,'0x'+'c'.repeat(64)), { code: 'transaction_conflict' });
    await reconcileChainSettlement(created.id,adapter);
    assert.equal((await pool.query('SELECT status FROM chain_settlements WHERE id=$1',[created.id])).rows[0].status,'pending');
    evidence = { ...evidence, state: 'confirmed', confirmations: '12', block_number: '101' };
    await reconcileChainSettlement(created.id,adapter);
    assert.equal((await pool.query('SELECT status,block_number FROM chain_settlements WHERE id=$1',[created.id])).rows[0].status,'confirmed');
    // Terminal states cannot be rewritten, and instruction fields are immutable.
    await assert.rejects(pool.query("UPDATE chain_settlements SET status='unknown' WHERE id=$1",[created.id]), /terminal/);
    await assert.rejects(pool.query("UPDATE chain_settlements SET amount_atomic=1 WHERE id=$1",[created.id]), /immutable/);
    const fresh = async () => {
      const key = id('key');
      return createNativeSettlement({ ...input, idempotencyKey: key, signature: await signed(key) });
    };
    const second = await fresh();
    await assert.rejects(submitNativeSettlement(userId,second.id,hash), { code: 'transaction_already_tracked' });
    // A transaction mined before the instruction existed can never settle it.
    const historical = await fresh();
    await submitNativeSettlement(userId,historical.id,`0x${randomBytes(32).toString('hex')}`);
    evidence = { ...evidence, block_number: '99' };
    await reconcileChainSettlement(historical.id,adapter);
    assert.deepEqual((await pool.query('SELECT status,last_error FROM chain_settlements WHERE id=$1',[historical.id])).rows[0],
      { status: 'mismatched', last_error: 'historical_transaction' });
    // Contradicting evidence is terminal; transient RPC errors back off.
    const contradicted = await fresh(), flaky = await fresh();
    await submitNativeSettlement(userId,contradicted.id,`0x${randomBytes(32).toString('hex')}`);
    await submitNativeSettlement(userId,flaky.id,`0x${randomBytes(32).toString('hex')}`);
    const failing = (error: Error): ChainSettlementAdapter => ({ ...adapter, nativeTransferEvidence: async () => { throw error; } });
    await reconcileChainSettlement(contradicted.id,failing(new QieEvidenceMismatch('mismatch')));
    assert.equal((await pool.query('SELECT status FROM chain_settlements WHERE id=$1',[contradicted.id])).rows[0].status,'mismatched');
    await reconcileChainSettlement(flaky.id,failing(new Error('timeout')));
    const backoff = (await pool.query("SELECT status,check_failures,next_check_at>now()+interval '20 seconds' AS later FROM chain_settlements WHERE id=$1",[flaky.id])).rows[0];
    assert.deepEqual(backoff, { status: 'unknown', check_failures: 1, later: true });
    // A visible transaction from another sender cannot be claimed.
    const claimed = await fresh();
    const withSender: ChainSettlementAdapter = { ...adapter, transactionSender: async () => '0x9999999999999999999999999999999999999999' };
    chainAdapters[QIE_NETWORK] = () => withSender;
    await assert.rejects(submitNativeSettlement(userId,claimed.id,`0x${randomBytes(32).toString('hex')}`), { code: 'transaction_sender_mismatch' });
    chainAdapters[QIE_NETWORK] = () => adapter;
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM chain_settlements WHERE tx_hash=$1",[hash])).rows[0].count,1);
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[hashKey(token),userId,csrf]);
    const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
    try {
      const routeKey = id('key');
      const body = { network: QIE_NETWORK, from: account.address, to, amount_atomic: amountAtomic.toString(),
        expires_at: expiresAt, signature: await signed(routeKey) };
      const url = '/personal/api/settlements';
      assert.equal((await app.inject({ method:'POST',url,payload:body })).statusCode,401);
      assert.equal((await app.inject({ method:'POST',url,headers:{ cookie:`kora_personal=${token}`,origin:'http://127.0.0.1:4310','idempotency-key':routeKey },payload:body })).statusCode,403);
      const createdByApi = await app.inject({ method:'POST',url,headers:{ cookie:`kora_personal=${token}`,origin:'http://127.0.0.1:4310','x-kora-csrf':csrf,'idempotency-key':routeKey },payload:body });
      assert.equal(createdByApi.statusCode,200,createdByApi.body);
      const listed = await app.inject({ url,headers:{ cookie:`kora_personal=${token}` } });
      assert.equal(listed.statusCode,200);
      assert.ok(listed.json().data.some((item: { id: string }) => item.id === createdByApi.json().id));
    } finally { await app.close(); }
  } finally { chainAdapters[QIE_NETWORK] = previous; }
});

test('QIE wallet linking requires an owned account, a fresh challenge and a valid signature', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const userId = id('usr'), accountId = id('acct');
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2)', [userId,`${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)",[accountId,userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[hashKey(token),userId,csrf]);
  const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  const headers = { cookie:`kora_personal=${token}`,origin:'http://127.0.0.1:4310','x-kora-csrf':csrf };
  try {
    const challenge = await app.inject({ method:'POST',url:'/personal/api/wallets/challenge',headers,payload:{ address:account.address } });
    assert.equal(challenge.statusCode,200,challenge.body);
    assert.match(challenge.json().message,/Chain ID: 1990/);
    const invalid = await app.inject({ method:'POST',url:'/personal/api/wallets',headers,payload:{
      challenge_id:challenge.json().challenge_id,
      signature:await privateKeyToAccount(generatePrivateKey()).signMessage({ message:challenge.json().message }),
    } });
    assert.equal(invalid.statusCode,401,invalid.body);
    const signature = await account.signMessage({ message:challenge.json().message });
    const linked = await app.inject({ method:'POST',url:'/personal/api/wallets',headers,payload:{
      challenge_id:challenge.json().challenge_id,signature,
    } });
    assert.equal(linked.statusCode,200,linked.body);
    assert.equal(linked.json().address,account.address);
    assert.equal((await app.inject({ method:'POST',url:'/personal/api/wallets',headers,payload:{
      challenge_id:challenge.json().challenge_id,signature,
    } })).statusCode,409);
    const listed = await app.inject({ url:'/personal/api/wallets',headers });
    assert.equal(listed.json().data.length,1);
    assert.equal(listed.json().data[0].id,linked.json().id);
    const auth = await app.inject({ method:'POST',url:'/personal/api/settlements/authorization',headers,payload:{
      from:account.address,to:'0x2222222222222222222222222222222222222222',amount_atomic:'1000000000000000',
    } });
    assert.equal(auth.statusCode,200,auth.body);
    assert.match(auth.json().message,/Amount \(atomic units\): 1000000000000000/);
    const notOwned = await app.inject({ method:'POST',url:'/personal/api/settlements/authorization',headers,payload:{
      from:'0x3333333333333333333333333333333333333333',to:account.address,amount_atomic:'1',
    } });
    assert.equal(notOwned.statusCode,403);
    const removed = await app.inject({ method:'DELETE',url:`/personal/api/wallets/${linked.json().id}`,headers });
    assert.equal(removed.statusCode,200,removed.body);
    assert.equal((await app.inject({ url:'/personal/api/wallets',headers })).json().data.length,0);
  } finally { await app.close(); }
});
