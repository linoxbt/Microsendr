import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { QieClient, QIE_NETWORK, QIE_QUSDC_CONTRACT } from '../packages/qie/src/index.js';
import { indexOneIncomingWallet, personalIncomingTransfers } from '../packages/settlement/src/incoming.js';

after(async () => { await pool.end(); });

const hex = (bytes: number) => `0x${randomBytes(bytes).toString('hex')}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HEAD = 1000n;
type Tx = { from: string; to: string; value: bigint; block: bigint; logs?: { address: string; topics: string[]; data: string; logIndex: string }[]; status?: string };

function chain(txs: Map<string, Tx>) {
  const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    const tx = params?.[0] ? txs.get(String(params[0])) : undefined;
    const result = method === 'eth_chainId' ? '0x7c6'
      : method === 'eth_blockNumber' ? `0x${HEAD.toString(16)}`
      : method === 'eth_getTransactionByHash' ? tx && { from: tx.from, to: tx.to, value: `0x${tx.value.toString(16)}` }
      : method === 'eth_getTransactionReceipt' ? tx && { status: tx.status ?? '0x1', blockNumber: `0x${tx.block.toString(16)}`, blockHash: blockHash(tx.block), logs: tx.logs ?? [] }
      : method === 'eth_getBlockByNumber' ? { hash: blockHash(BigInt(params[0])), timestamp: `0x${Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000).toString(16)}` }
      : null;
    return Response.json({ jsonrpc: '2.0', id: 1, result: result ?? null });
  }) as typeof fetch;
}

function explorer(native: unknown[], tokens: unknown[], calls: string[] = []) {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json({ items: String(url).includes('/token-transfers') ? tokens : native, next_page_params: null });
  }) as typeof fetch;
}

async function owner(address: string, createdAt = '2000-01-01T00:00:00Z') {
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,now())', [userId, `${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  const walletId = id('cwa');
  await pool.query("INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)",
    [walletId, userId, accountId, QIE_NETWORK, address, createdAt]);
  return { userId, accountId, walletId };
}

async function drain(client: QieClient, request: typeof fetch, address: string) {
  // The shared test database holds wallets from other suites. Make sure every wallet has a
  // cursor, defer every address but this test's, then scan until nothing is due.
  await pool.query(`UPDATE chain_incoming_cursors SET next_poll_at=now()+interval '1 day' WHERE address<>$1`, [address]);
  await indexOneIncomingWallet(client, request);
  await pool.query(`UPDATE chain_incoming_cursors SET next_poll_at=now()+interval '1 day' WHERE address<>$1`, [address]);
  for (let i = 0; i < 400 && await indexOneIncomingWallet(client, request); i++);
}

test('verified incoming QIE and QUSDC are recorded once; explorer claims without chain proof are ignored', async () => {
  const address = hex(20), sender = hex(20);
  const { userId, accountId } = await owner(address);
  const native = hex(32), fresh = hex(32), fakeNative = hex(32), token = hex(32), fakeToken = hex(32);
  const txs = new Map<string, Tx>([
    [native, { from: sender, to: address, value: 5n * 10n ** 17n, block: 900n }],
    [fresh, { from: sender, to: address, value: 1n, block: 995n }],
    // The explorer says this pays the address; the chain says it pays someone else.
    [fakeNative, { from: sender, to: hex(20), value: 7n, block: 901n }],
    [token, { from: sender, to: QIE_QUSDC_CONTRACT, value: 0n, block: 902n, logs: [{
      address: QIE_QUSDC_CONTRACT, logIndex: '0x2', data: `0x${(2500000n).toString(16).padStart(64, '0')}`,
      topics: [TRANSFER, `0x${sender.slice(2).padStart(64, '0')}`, `0x${address.slice(2).padStart(64, '0')}`],
    }] }],
    // A Transfer log from a different contract must never count as QUSDC.
    [fakeToken, { from: sender, to: hex(20), value: 0n, block: 903n, logs: [{
      address: hex(20), logIndex: '0x0', data: `0x${(9n).toString(16).padStart(64, '0')}`,
      topics: [TRANSFER, `0x${sender.slice(2).padStart(64, '0')}`, `0x${address.slice(2).padStart(64, '0')}`],
    }] }],
  ]);
  const at = (block: number) => ({ block_number: block, timestamp: '2026-11-01T00:00:00Z', to: { hash: address } });
  const request = explorer(
    [{ hash: fresh, value: '1', status: 'ok', ...at(995) }, { hash: fakeNative, value: '7', status: 'ok', ...at(901) }, { hash: native, value: '500000000000000000', status: 'ok', ...at(900) }],
    [{ transaction_hash: fakeToken, log_index: 0, token: { address_hash: QIE_QUSDC_CONTRACT }, ...at(903) },
      { transaction_hash: token, log_index: 2, token: { address_hash: QIE_QUSDC_CONTRACT }, ...at(902) }],
  );
  const client = new QieClient(chain(txs));
  await drain(client, request, address);
  await pool.query("UPDATE chain_incoming_cursors SET next_poll_at=now() WHERE address=$1", [address]);
  await drain(client, request, address);
  const rows = (await pool.query('SELECT asset,tx_hash,amount_atomic::text,from_address,log_index FROM chain_incoming_transfers WHERE address=$1 ORDER BY asset', [address])).rows;
  assert.deepEqual(rows, [
    { asset: 'QIEV3', tx_hash: native, amount_atomic: '500000000000000000', from_address: sender, log_index: -1 },
    { asset: 'QUSDC', tx_hash: token, amount_atomic: '2500000', from_address: sender, log_index: 2 },
  ]);
  // Not yet final (head - 12), so not recorded; the cursor stops below it.
  const cursor = (await pool.query("SELECT scanned_through_block::text b FROM chain_incoming_cursors WHERE address=$1 AND asset='QIEV3'", [address])).rows[0];
  assert.equal(cursor.b, String(HEAD - 12n));
  const listed = await personalIncomingTransfers(userId, accountId);
  assert.deepEqual(listed.map(item => [item.direction, item.asset, item.decimals, item.status]).sort(),
    [['received', 'QIEV3', 18, 'confirmed'], ['received', 'QUSDC', 6, 'confirmed']]);
  await assert.rejects(pool.query('UPDATE chain_incoming_transfers SET amount_atomic=1 WHERE address=$1', [address]), /immutable/);
});

test('a relinked address shows each account only what arrived while it held the address', async () => {
  const address = hex(20);
  const first = await owner(address, '2026-01-01T00:00:00Z');
  const tx = hex(32), block = hex(32);
  await pool.query(`INSERT INTO chain_incoming_transfers(id,network,asset,address,from_address,amount_atomic,tx_hash,log_index,block_number,block_hash,block_time)
    VALUES($1,$2,'QIEV3',$3,$4,10,$5,-1,5,$6,'2026-02-01T00:00:00Z')`, [id('rcv'), QIE_NETWORK, address, hex(20), tx, block]);
  assert.equal((await personalIncomingTransfers(first.userId, first.accountId)).length, 1);
  await pool.query("UPDATE personal_chain_wallets SET status='removed',updated_at='2026-03-01T00:00:00Z' WHERE id=$1", [first.walletId]);
  const second = await owner(address, '2026-04-01T00:00:00Z');
  assert.equal((await personalIncomingTransfers(second.userId, second.accountId)).length, 0);
  // The first owner keeps the history from while they held it.
  assert.equal((await personalIncomingTransfers(first.userId, first.accountId)).length, 1);
});

test('explorer failures back off one address without advancing its cursor', async () => {
  const address = hex(20);
  await owner(address);
  const client = new QieClient(chain(new Map()));
  const failing = (async () => new Response('busy', { status: 503 })) as typeof fetch;
  await drain(client, failing, address);
  const rows = (await pool.query('SELECT failures,scanned_through_block,last_error,next_poll_at>now() AS later FROM chain_incoming_cursors WHERE address=$1', [address])).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual([row.failures, row.scanned_through_block, row.last_error, row.later], [1, null, 'explorer_status_503', true]);
});

test('a deposit the node cannot prove yet holds the cursor and is recorded on a later pass', async () => {
  const address = hex(20), sender = hex(20), real = hex(32);
  await owner(address);
  const txs = new Map<string, Tx>();
  const recent = new Date().toISOString();
  const request = explorer([{ hash: real, value: '7000000000000000000', status: 'ok', block_number: 900, timestamp: recent, to: { hash: address } }], []);
  // The explorer already lists it but the node does not have it yet.
  await drain(new QieClient(chain(txs)), request, address);
  assert.equal((await pool.query('SELECT 1 FROM chain_incoming_transfers WHERE tx_hash=$1', [real])).rowCount, 0);
  const held = (await pool.query("SELECT scanned_through_block::text b FROM chain_incoming_cursors WHERE address=$1 AND asset='QIEV3'", [address])).rows[0];
  assert.equal(held.b, '899');
  // The node catches up: the next pass records it and the cursor moves on.
  txs.set(real, { from: sender, to: address, value: 7_000_000_000_000_000_000n, block: 900n });
  await pool.query('UPDATE chain_incoming_cursors SET next_poll_at=now() WHERE address=$1', [address]);
  await drain(new QieClient(chain(txs)), request, address);
  assert.equal((await pool.query('SELECT 1 FROM chain_incoming_transfers WHERE tx_hash=$1', [real])).rowCount, 1);
  const moved = (await pool.query("SELECT scanned_through_block::text b FROM chain_incoming_cursors WHERE address=$1 AND asset='QIEV3'", [address])).rows[0];
  assert.equal(moved.b, String(HEAD - 12n));
});

test('a deposit buried under many pages of dust is still found by resuming the walk', async () => {
  const address = hex(20), sender = hex(20);
  await owner(address);
  const txs = new Map<string, Tx>();
  // Fourteen pages of dust (newest first), then the real deposit on page fifteen.
  const pages: { hash: string; block: number }[][] = [];
  for (let page = 0; page < 14; page++) {
    const hash = hex(32), block = 980 - page;
    txs.set(hash, { from: sender, to: address, value: 1n, block: BigInt(block) });
    pages.push([{ hash, block }]);
  }
  const real = hex(32);
  txs.set(real, { from: sender, to: address, value: 9_000_000_000_000_000_000n, block: 950n });
  pages.push([{ hash: real, block: 950 }]);
  const calls: string[] = [];
  const request = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes('/token-transfers')) return Response.json({ items: [], next_page_params: null });
    const page = Number(new URL(String(url)).searchParams.get('page') ?? '0');
    return Response.json({
      items: pages[page].map((item) => ({ hash: item.hash, value: item.hash === real ? '9000000000000000000' : '1', status: 'ok',
        block_number: item.block, timestamp: '2026-11-01T00:00:00Z', to: { hash: address } })),
      next_page_params: page + 1 < pages.length ? { page: page + 1 } : null,
    });
  }) as typeof fetch;
  // One pass stops at the page budget, saves its place and does not move the cursor.
  await pool.query(`UPDATE chain_incoming_cursors SET next_poll_at=now()+interval '1 day' WHERE address<>$1`, [address]);
  await indexOneIncomingWallet(new QieClient(chain(txs)), request);
  await pool.query(`UPDATE chain_incoming_cursors SET next_poll_at=now()+interval '1 day' WHERE address<>$1`, [address]);
  let resumed = false;
  for (let i = 0; i < 4 && !resumed; i++) {
    const row = (await pool.query("SELECT resume_params,scanned_through_block FROM chain_incoming_cursors WHERE address=$1 AND asset='QIEV3'", [address])).rows[0];
    if (row?.resume_params) { assert.equal(row.scanned_through_block, null); resumed = true; break; }
    await indexOneIncomingWallet(new QieClient(chain(txs)), request);
  }
  assert.ok(resumed, 'the first walk stopped at the page budget and saved its place');
  // Later passes continue from the saved page and find the deposit.
  await drain(new QieClient(chain(txs)), request, address);
  assert.equal((await pool.query('SELECT amount_atomic::text a FROM chain_incoming_transfers WHERE tx_hash=$1', [real])).rows[0]?.a, '9000000000000000000');
  assert.ok(calls.some((url) => url.includes('page=14')));
  const done = (await pool.query("SELECT scanned_through_block::text b,resume_params FROM chain_incoming_cursors WHERE address=$1 AND asset='QIEV3'", [address])).rows[0];
  assert.deepEqual(done, { b: String(HEAD - 12n), resume_params: null });
});
