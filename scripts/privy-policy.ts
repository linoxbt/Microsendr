/**
 * Creates the Privy policy that limits what Microsendr account wallets can sign, and attaches
 * it to every existing account wallet. Privy then refuses anything outside the policy
 * even if the app secret leaks: only QIE Mainnet (chain 1990), native QIE up to the
 * per-transfer limit with no calldata, or QUSDC transfer() calls on the QUSDC contract up
 * to its limit.
 *
 *   pnpm tsx scripts/privy-policy.ts            # print the policy only (dry run)
 *   pnpm tsx scripts/privy-policy.ts --apply    # create it and attach it to all wallets
 *
 * Then set PRIVY_POLICY_ID on the api and worker services so new wallets get it too, and
 * make one small test send of each token.
 */
import 'dotenv/config';
import { pool } from '../packages/database/src/index.js';
import { QIE_CHAIN_ID, QIE_QUSDC_CONTRACT } from '../packages/qie/src/index.js';
import { managedTransferLimits } from '../services/api/src/managed-transfer.js';

const appId = process.env.PRIVY_APP_ID, secret = process.env.PRIVY_APP_SECRET;
const hex = (value: bigint) => `0x${value.toString(16)}`;
const limits = managedTransferLimits();
const erc20 = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
  inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
const policy = {
  version: '1.0',
  name: 'Microsendr account wallets',
  chain_type: 'ethereum',
  rules: [
    {
      name: 'Native QIE within limit',
      method: 'eth_signTransaction',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(QIE_CHAIN_ID) },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: hex(limits.per_transfer_wei) },
        { field_source: 'ethereum_transaction', field: 'data_byte_length', operator: 'eq', value: '0' },
      ],
    },
    {
      name: 'QUSDC transfer within limit',
      method: 'eth_signTransaction',
      action: 'ALLOW',
      conditions: [
        { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(QIE_CHAIN_ID) },
        { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: QIE_QUSDC_CONTRACT },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0x0' },
        { field_source: 'ethereum_calldata', field: 'function_name', operator: 'eq', value: 'transfer', abi: erc20 },
        { field_source: 'ethereum_calldata', field: 'transfer.amount', operator: 'lte', value: hex(limits.qusdc_per_transfer_atomic), abi: erc20 },
      ],
    },
  ],
};

console.log(JSON.stringify(policy, null, 2));
if (!process.argv.includes('--apply')) {
  console.log('\nDry run. Re-run with --apply to create the policy and attach it to every account wallet.');
  process.exit(0);
}
if (!appId || !secret) throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET');
const headers = { authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`, 'privy-app-id': appId, 'content-type': 'application/json' };
const created = await fetch('https://api.privy.io/v1/policies', { method: 'POST', headers, body: JSON.stringify(policy) });
if (!created.ok) throw new Error(`Policy creation failed: ${created.status} ${await created.text()}`);
const { id } = await created.json() as { id: string };
console.log(`Created policy ${id}`);
const wallets = (await pool.query('SELECT privy_wallet_id FROM personal_managed_wallets')).rows as { privy_wallet_id: string }[];
let failed = 0;
for (const { privy_wallet_id } of wallets) {
  const updated = await fetch(`https://api.privy.io/v1/wallets/${privy_wallet_id}`, { method: 'PATCH', headers, body: JSON.stringify({ policy_ids: [id] }) });
  if (!updated.ok) { failed += 1; console.error(`Wallet ${privy_wallet_id}: ${updated.status} ${await updated.text()}`); }
}
console.log(`Attached to ${wallets.length - failed} of ${wallets.length} wallets. Now set PRIVY_POLICY_ID=${id} on the api and worker services.`);
await pool.end();
