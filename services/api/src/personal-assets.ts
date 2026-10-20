import { pool } from '../../../packages/database/src/index.js';
import { QieClient } from '../../../packages/qie/src/index.js';

export type PersonalAsset = {
  code: 'QIE' | 'QUSDC' | 'NGN';
  name: string;
  amount_atomic: string | null;
  decimals: number;
  status: 'ready' | 'unavailable';
  source: 'wallet' | 'fiat';
};

export async function personalAssets(userId: string, accountId: string, chain = new QieClient()): Promise<PersonalAsset[]> {
  const rows = (await pool.query(
    `SELECT address FROM personal_managed_wallets WHERE personal_user_id=$1 AND account_id=$2
     UNION
     SELECT address FROM personal_chain_wallets WHERE personal_user_id=$1 AND account_id=$2
       AND network='qie-mainnet' AND status='active'`,
    [userId, accountId],
  )).rows as { address: string }[];
  const addresses = [...new Set(rows.map(row => row.address.toLowerCase()))];
  return walletAssetSnapshot(addresses, chain);
}

export async function walletAssetSnapshot(addresses: string[], chain: Pick<QieClient, 'nativeBalance' | 'qusdcBalance'>): Promise<PersonalAsset[]> {
  const read = async (kind: 'native' | 'qusdc'): Promise<string | null> => {
    if (!addresses.length) return null;
    const results = await Promise.allSettled(addresses.map(address =>
      kind === 'native' ? chain.nativeBalance(address) : chain.qusdcBalance(address),
    ));
    // A partial result would understate the account's holdings.
    if (results.some(result => result.status === 'rejected')) return null;
    return results.reduce((sum, result) => sum + BigInt(result.status === 'fulfilled'
      ? 'balance_wei' in result.value ? result.value.balance_wei : result.value.balance_atomic
      : '0'), 0n).toString();
  };
  const [qie, qusdc] = await Promise.all([read('native'), read('qusdc')]);
  return [
    { code: 'QIE', name: 'QIE', amount_atomic: qie, decimals: 18, status: qie === null ? 'unavailable' : 'ready', source: 'wallet' },
    { code: 'QUSDC', name: 'Digital dollars', amount_atomic: qusdc, decimals: 6, status: qusdc === null ? 'unavailable' : 'ready', source: 'wallet' },
    // A real NGN position needs a regulated fiat partner and reconciled ledger.
    { code: 'NGN', name: 'Nigerian naira', amount_atomic: null, decimals: 2, status: 'unavailable', source: 'fiat' },
  ];
}
