import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { QIE_CHAIN_ID } from '../../../packages/qie/src/index.js';

/**
 * The Microsendr operator's side of the MicrosendrPay escrow contract (contracts/MicrosendrPay.sol).
 * Customers' QUSDC for a purchase is sent to the contract; the operator records it against the
 * order (hold), then settles it to the treasury on delivery or refunds the payer on failure.
 * Configured with MICROSENDR_PAY_ADDRESS and OPERATOR_PRIVATE_KEY (an account holding a little
 * QIE for gas, set as the contract's operator).
 */
export const escrowAbi = JSON.parse(readFileSync(new URL('../../../contracts/artifacts/MicrosendrPay.json', import.meta.url), 'utf8')).abi as Abi;
export type EscrowState = 'none' | 'held' | 'settled' | 'refunded';
export interface Escrow {
  readonly address: Address;
  state(orderId: string): Promise<EscrowState>;
  hold(orderId: string, payer: Address, amount: bigint): Promise<Hex>;
  settle(orderId: string): Promise<Hex>;
  refund(orderId: string): Promise<Hex>;
}
/** The on-chain key for a Microsendr order id. */
export const escrowOrderKey = (orderId: string) => keccak256(toHex(orderId));
const STATES: EscrowState[] = ['none', 'held', 'settled', 'refunded'];

export function contractEscrow(options: { address: Address; privateKey: Hex; rpcUrl: string; chainId?: number }): Escrow {
  const chain = { id: options.chainId ?? Number(QIE_CHAIN_ID), name: 'QIE Mainnet', nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } } } as const;
  const transport = http(options.rpcUrl, { timeout: 20_000 });
  const reader = createPublicClient({ chain, transport });
  const writer = createWalletClient({ account: privateKeyToAccount(options.privateKey), chain, transport });
  const address = getAddress(options.address);
  async function write(functionName: string, args: unknown[]) {
    const hash = await writer.writeContract({ address, abi: escrowAbi, functionName, args } as never);
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== 'success') throw new Error(`escrow ${functionName} reverted`);
    return hash;
  }
  return {
    address,
    async state(orderId) {
      const [, , state] = await reader.readContract({ address, abi: escrowAbi, functionName: 'payments', args: [escrowOrderKey(orderId)] } as never) as [Address, bigint, number, bigint];
      return STATES[Number(state)] ?? 'none';
    },
    hold: (orderId, payer, amount) => write('hold', [escrowOrderKey(orderId), getAddress(payer), amount]),
    settle: (orderId) => write('settle', [escrowOrderKey(orderId)]),
    refund: (orderId) => write('refund', [escrowOrderKey(orderId)]),
  };
}

let cached: { key: string; escrow: Escrow } | null = null;
/** The configured escrow, or null when purchases go straight to a treasury address. */
export function configuredEscrow(): Escrow | null {
  const address = process.env.MICROSENDR_PAY_ADDRESS ?? '', key = process.env.OPERATOR_PRIVATE_KEY ?? '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !/^0x[a-fA-F0-9]{64}$/.test(key)) return null;
  const id = `${address}|${keccak256(key as Hex)}`;
  if (cached?.key !== id) cached = { key: id, escrow: contractEscrow({ address: address as Address, privateKey: key as Hex,
    rpcUrl: process.env.QIE_RPC_URL || 'https://rpc1mainnet.qie.digital/' }) };
  return cached.escrow;
}
