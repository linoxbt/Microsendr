import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, custom, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

// The contract runs on an in-process chain (Paris rules, like QIE Mainnet).
const ganache = createRequire(import.meta.url)('ganache');
const pay = JSON.parse(readFileSync('contracts/artifacts/MicrosendrPay.json', 'utf8')) as { abi: Abi; bytecode: Hex };
const token = JSON.parse(readFileSync('contracts/artifacts/TestToken.json', 'utf8')) as { abi: Abi; bytecode: Hex };
const keys = Array.from({ length: 6 }, () => generatePrivateKey());
const accounts = new Map<Address, PrivateKeyAccount>(keys.map((k) => { const a = privateKeyToAccount(k); return [a.address, a]; }));
const provider = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'merge', chainId: 1990 },
  wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: '0x56bc75e2d63100000' })) } });
const transport = custom(provider);
const chain = { id: 1990, name: 'test', nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 }, rpcUrls: { default: { http: [''] } } } as const;
const reader = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, transport, mode: 'ganache' });
let owner: Address, operator: Address, treasury: Address, alice: Address, bob: Address, stranger: Address;
let tokenAddress: Address, payAddress: Address;
// Transactions are signed locally (as the operator does in production) and sent raw.
const as = (address: Address) => createWalletClient({ account: accounts.get(address)!, chain, transport });
const order = (name: string) => keccak256(toHex(name));

async function send(account: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await as(account).writeContract({ address, abi, functionName, args } as never);
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('reverted');
  return receipt;
}
const call = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  reader.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const balance = (who: Address) => call<bigint>(tokenAddress, token.abi, 'balanceOf', [who]);
async function reverts(promise: Promise<unknown>, error: string) {
  await assert.rejects(promise, (e: Error) => e.message.includes(error) || /revert/i.test(e.message), `expected ${error}`);
}

before(async () => {
  [owner, operator, treasury, alice, bob, stranger] = [...accounts.keys()];
  const deploy = async (artifact: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
    const hash = await as(owner).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args } as never);
    return (await reader.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  tokenAddress = await deploy(token, []);
  payAddress = await deploy(pay, [tokenAddress, treasury, operator]);
  for (const who of [alice, bob]) await send(owner, tokenAddress, token.abi, 'mint', [who, 100_000_000n]);
});
after(async () => { await provider.disconnect(); });

test('a payment is held for an order only if it arrived, and only once', async () => {
  await send(alice, tokenAddress, token.abi, 'transfer', [payAddress, 10_000_000n]);
  assert.equal(await call<bigint>(payAddress, pay.abi, 'unallocated'), 10_000_000n);
  // Only the operator records payments, and never more than arrived.
  await reverts(send(stranger, payAddress, pay.abi, 'hold', [order('o1'), alice, 10_000_000n]), 'NotOperator');
  await reverts(send(operator, payAddress, pay.abi, 'hold', [order('o1'), alice, 10_000_001n]), 'InsufficientUnallocated');
  const receipt = await send(operator, payAddress, pay.abi, 'hold', [order('o1'), alice, 10_000_000n]);
  assert.equal(receipt.logs.length, 1);
  await reverts(send(operator, payAddress, pay.abi, 'hold', [order('o1'), alice, 1n]), 'OrderExists');
  assert.equal(await call<bigint>(payAddress, pay.abi, 'totalHeld'), 10_000_000n);
  assert.equal(await call<bigint>(payAddress, pay.abi, 'unallocated'), 0n);
  // The same tokens cannot back a second order.
  await reverts(send(operator, payAddress, pay.abi, 'hold', [order('o2'), bob, 1n]), 'InsufficientUnallocated');
});

test('delivered: settle sends the held payment to the treasury, once', async () => {
  const before = await balance(treasury);
  await send(operator, payAddress, pay.abi, 'settle', [order('o1')]);
  assert.equal(await balance(treasury) - before, 10_000_000n);
  assert.equal(await call<bigint>(payAddress, pay.abi, 'totalHeld'), 0n);
  await reverts(send(operator, payAddress, pay.abi, 'settle', [order('o1')]), 'NotHeld');
  await reverts(send(operator, payAddress, pay.abi, 'refund', [order('o1')]), 'NotHeld');
  const [, , state] = await call<[Address, bigint, number, bigint]>(payAddress, pay.abi, 'payments', [order('o1')]);
  assert.equal(state, 2);
});

test('not delivered: the operator refunds the payer; the payer alone can reclaim after the deadline', async () => {
  await send(bob, tokenAddress, token.abi, 'transfer', [payAddress, 5_000_000n]);
  await send(operator, payAddress, pay.abi, 'hold', [order('o3'), bob, 5_000_000n]);
  const start = await balance(bob);
  await send(operator, payAddress, pay.abi, 'refund', [order('o3')]);
  assert.equal(await balance(bob) - start, 5_000_000n);

  await send(bob, tokenAddress, token.abi, 'transfer', [payAddress, 2_000_000n]);
  await send(operator, payAddress, pay.abi, 'hold', [order('o4'), bob, 2_000_000n]);
  // Before the deadline neither the payer nor anyone else can take it.
  await reverts(send(bob, payAddress, pay.abi, 'refund', [order('o4')]), 'NotAllowed');
  await testClient.increaseTime({ seconds: 7 * 24 * 3600 });
  await testClient.mine({ blocks: 1 });
  await reverts(send(stranger, payAddress, pay.abi, 'refund', [order('o4')]), 'NotAllowed');
  // Not even the operator can then settle it to the treasury twice over: the payer reclaims.
  const mid = await balance(bob);
  await send(bob, payAddress, pay.abi, 'refund', [order('o4')]);
  assert.equal(await balance(bob) - mid, 2_000_000n);
});

test('the owner can change the operator and sweep strays, but never held payments', async () => {
  await send(alice, tokenAddress, token.abi, 'transfer', [payAddress, 3_000_000n]);
  await send(operator, payAddress, pay.abi, 'hold', [order('o5'), alice, 2_000_000n]);
  await reverts(send(owner, payAddress, pay.abi, 'sweep', [owner, 1_000_001n]), 'InsufficientUnallocated');
  await send(owner, payAddress, pay.abi, 'sweep', [alice, 1_000_000n]);
  assert.equal(await call<bigint>(payAddress, pay.abi, 'unallocated'), 0n);
  await reverts(send(operator, payAddress, pay.abi, 'setOperator', [stranger]), 'NotOwner');
  await send(owner, payAddress, pay.abi, 'setOperator', [stranger]);
  await reverts(send(operator, payAddress, pay.abi, 'settle', [order('o5')]), 'NotOperator');
  await send(stranger, payAddress, pay.abi, 'settle', [order('o5')]);
  assert.equal(await call<Address>(payAddress, pay.abi, 'treasury'), treasury);
});
