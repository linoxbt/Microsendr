import React from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, RefreshCw } from 'lucide-react';

export type PersonalAsset = {
  code: 'QIE' | 'QUSDC' | 'NGN';
  name: string;
  amount_atomic: string | null;
  decimals: number;
  status: 'ready' | 'unavailable';
  source: 'wallet' | 'fiat';
};

export const assetDefaults: PersonalAsset[] = [
  { code: 'QIE', name: 'QIE', amount_atomic: null, decimals: 18, status: 'unavailable', source: 'wallet' },
  { code: 'QUSDC', name: 'Digital dollars', amount_atomic: null, decimals: 6, status: 'unavailable', source: 'wallet' },
  { code: 'NGN', name: 'Nigerian naira', amount_atomic: null, decimals: 2, status: 'unavailable', source: 'fiat' },
];

export function assetAmount(asset: PersonalAsset): string {
  if (asset.amount_atomic === null) return '—';
  const amount = BigInt(asset.amount_atomic);
  const unit = 10n ** BigInt(asset.decimals);
  const whole = (amount / unit).toLocaleString();
  const fraction = (amount % unit).toString().padStart(asset.decimals, '0');
  const visible = fraction.slice(0, 8).replace(/0+$/, '');
  if (amount > 0n && amount < unit / 100000000n) return '<0.00000001';
  return visible ? `${whole}.${visible}` : whole;
}

export function AssetIcon({ code, large = false }: { code: PersonalAsset['code']; large?: boolean }) {
  return <span className={`fin-asset-icon fin-asset-${code.toLowerCase()}${large ? ' fin-asset-icon-large' : ''}`} aria-hidden="true">
    {code === 'QIE' ? <img src="/images/qie-asset.png" alt="" />
      : code === 'QUSDC' ? <img src="/images/qusdc-asset.png" alt="" />
      : <span>₦</span>}
  </span>;
}

export function AssetDetail({ asset, go, hidden, refresh, refreshing }: {
  asset: PersonalAsset;
  go: (path: string) => void;
  hidden: boolean;
  refresh: () => void;
  refreshing: boolean;
}) {
  const crypto = asset.source === 'wallet';
  return <div className="fin-asset-detail">
    <button className="fin-asset-back" onClick={() => go('/personal/home')}><ArrowLeft size={17} /> Assets</button>
    <section className="fin-panel fin-asset-detail-card" aria-label={`${asset.code} details`}>
      <div className="fin-asset-detail-title">
        <AssetIcon code={asset.code} large />
        <div><span className="fin-kicker">ASSET BALANCE</span><h1>{asset.code}</h1><p>{asset.name}</p></div>
      </div>
      <div className="fin-asset-detail-balance">
        <span>{crypto ? 'Onchain balance' : 'Balance'}</span>
        <strong>{hidden ? '••••' : assetAmount(asset)} <small>{asset.amount_atomic === null ? '' : asset.code}</small></strong>
        <span>{asset.status === 'ready' ? 'Across your Microsendr wallets' : 'Unavailable'}</span>
      </div>
      <div className="fin-asset-detail-actions">
        {asset.code === 'QIE' && <>
          <button className="fin-primary" onClick={() => go('/personal/deposit')}>Receive QIE <ArrowRight size={16} /></button>
          <button className="fin-secondary" onClick={() => go('/personal/send')}>Send QIE <ArrowRight size={16} /></button>
        </>}
        <button className="fin-secondary" disabled={refreshing} onClick={refresh}><RefreshCw size={16} className={refreshing ? 'fin-spin' : ''} /> Refresh</button>
      </div>
    </section>
    <section className="fin-panel fin-asset-detail-info">
      <h2>Details</h2>
      <dl>
        <div><dt>Asset</dt><dd>{asset.name}</dd></div>
        <div><dt>Type</dt><dd>{crypto ? asset.code === 'QIE' ? 'Native crypto asset' : 'ERC-20 token' : 'Local currency'}</dd></div>
        {crypto && <div><dt>Network</dt><dd>QIE Mainnet</dd></div>}
        {asset.code === 'QUSDC' && <div><dt>Token contract</dt><dd><a href="https://mainnet.qie.digital/token/0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5" target="_blank" rel="noreferrer">0x3F43…5DA5 <ArrowUpRight size={14} /></a></dd></div>}
        <div><dt>Status</dt><dd>{asset.status === 'ready' ? 'Balance available' : 'Not available'}</dd></div>
      </dl>
      {asset.code === 'QUSDC' && <p>QUSDC balances are read directly from the allowlisted token contract. Transfers and deposit tracking for this asset are not yet enabled in Microsendr.</p>}
      {asset.code === 'NGN' && <p>A live NGN account and bank deposit route are not available yet. No naira balance is being represented here.</p>}
    </section>
  </div>;
}
