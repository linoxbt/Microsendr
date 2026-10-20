import type { PersonalAsset } from './personal-assets.js';

const EXPLORER = 'https://mainnet.qie.digital/api/v2';
const QUSDC = '0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5';
const CACHE_MS = 60_000;
type Prices = { qie: string; qusdc: string; checked_at: string };
let cached: { prices: Prices; expires: number } | undefined;
let pending: Promise<Prices | null> | undefined;

function priceUnits(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  return units > 0n ? units : null;
}

async function explorerPrices(): Promise<Prices | null> {
  if (cached && cached.expires > Date.now()) return cached.prices;
  if (pending) return pending;
  pending = (async () => {
    try {
      const [statsResponse, tokenResponse] = await Promise.all([
        fetch(`${EXPLORER}/stats`, { signal: AbortSignal.timeout(3000) }),
        fetch(`${EXPLORER}/tokens/${QUSDC}`, { signal: AbortSignal.timeout(3000) }),
      ]);
      if (!statsResponse.ok || !tokenResponse.ok) return null;
      const [stats, token] = await Promise.all([statsResponse.json(), tokenResponse.json()]);
      const qie = stats.coin_price;
      const qusdc = token.exchange_rate;
      if (typeof qie !== 'string' || typeof qusdc !== 'string' ||
        !priceUnits(qie) || !priceUnits(qusdc) ||
        token.address?.toLowerCase() !== QUSDC.toLowerCase()) return null;
      const prices = { qie, qusdc, checked_at: new Date().toISOString() };
      cached = { prices, expires: Date.now() + CACHE_MS };
      return prices;
    } catch {
      return null;
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}

export function walletUsdValue(assets: PersonalAsset[], prices: Prices | null): {
  amount_usd: string | null; checked_at: string | null;
} {
  const walletAssets = assets.filter(asset => asset.source === 'wallet');
  if (walletAssets.some(asset => asset.status !== 'ready' || asset.amount_atomic === null))
    return { amount_usd: null, checked_at: null };
  if (walletAssets.every(asset => asset.amount_atomic === '0'))
    return { amount_usd: '0.00', checked_at: null };
  if (!prices) return { amount_usd: null, checked_at: null };
  let totalCents = 0n;
  for (const asset of walletAssets) {
    if (!asset.amount_atomic || asset.amount_atomic === '0') continue;
    const price = priceUnits(asset.code === 'QIE' ? prices.qie : asset.code === 'QUSDC' ? prices.qusdc : '');
    if (!price || !/^\d+$/.test(asset.amount_atomic)) return { amount_usd: null, checked_at: null };
    const denominator = (10n ** BigInt(asset.decimals)) * 1_000_000n;
    totalCents += (BigInt(asset.amount_atomic) * price + denominator / 2n) / denominator;
  }
  return { amount_usd: `${totalCents / 100n}.${(totalCents % 100n).toString().padStart(2, '0')}`, checked_at: prices.checked_at };
}

export async function personalWalletUsdValue(assets: PersonalAsset[]) {
  return walletUsdValue(assets, await explorerPrices());
}
