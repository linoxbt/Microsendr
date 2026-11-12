import { formatAtomic } from './money.js';
import { MicrosendrWatermark } from './microsendr-logo.js';
import React from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Clock3, RefreshCw } from 'lucide-react';

export type PersonalAsset = {
  code: 'QIE' | 'QUSDC' | 'NGN';
  name: string;
  amount_atomic: string | null;
  decimals: number | null;
  status: 'ready' | 'unavailable';
  source: 'wallet' | 'fiat';
};

export const assetDefaults: PersonalAsset[] = [
  { code: 'QIE', name: 'QIE', amount_atomic: null, decimals: 18, status: 'unavailable', source: 'wallet' },
  { code: 'QUSDC', name: 'Digital dollars', amount_atomic: null, decimals: 6, status: 'unavailable', source: 'wallet' },
  { code: 'NGN', name: 'Nigerian naira', amount_atomic: null, decimals: 2, status: 'unavailable', source: 'fiat' },
];

export function assetAmount(asset: PersonalAsset): string {
  if (asset.amount_atomic === null || asset.decimals === null || asset.decimals === undefined) return '—';
  return formatAtomic(asset.amount_atomic, asset.decimals, 8);
}


export function AssetIcon({ code, large = false }: { code: PersonalAsset['code']; large?: boolean }) {
  return <span className={`fin-asset-icon fin-asset-${code.toLowerCase()}${large ? ' fin-asset-icon-large' : ''}`} aria-hidden="true">
    {code === 'QIE' ? <img src="/images/qie-asset.png" alt="" />
      : code === 'QUSDC' ? <img src="/images/qusdc-icon.jpg" alt="" />
      : <span>₦</span>}
  </span>;
}

type AssetMovement = {
  id: string;
  direction?: 'sent' | 'received';
  asset: string;
  amount_atomic: string;
  decimals: number | null;
  status: string;
  to: string;
  created_at: string;
};

export function AssetDetail({ asset, activity, go, hidden, refresh, refreshing }: {
  asset: PersonalAsset;
  activity: AssetMovement[];
  go: (path: string) => void;
  hidden: boolean;
  refresh: () => void;
  refreshing: boolean;
}) {
  const crypto = asset.source === 'wallet';
  const movements = activity.filter(item => item.asset === asset.code ||
    (asset.code === 'QIE' && item.asset === 'QIEV3')).slice(0, 4);
  return <div className={`fin-asset-detail fin-asset-detail-${asset.code.toLowerCase()}`}>
    <div className="fin-asset-detail-nav">
      <button className="fin-asset-back" onClick={() => go('/personal/assets')}><ArrowLeft size={17} /> All assets</button>
      <button className="fin-asset-refresh" disabled={refreshing} onClick={refresh} aria-label={`Refresh ${asset.code} balance`}>
        <RefreshCw size={17} className={refreshing ? 'fin-spin' : ''} /> <span>Refresh</span>
      </button>
    </div>
    <section className="fin-asset-detail-card" aria-label={`${asset.code} details`}>
      <MicrosendrWatermark className="fin-asset-watermark" />
      <div className="fin-asset-detail-card-top">
        <div className="fin-asset-detail-title"><AssetIcon code={asset.code} large />
          <div><span>{asset.code === 'QIE' ? 'QIE Mainnet' : asset.name}</span><h1>{asset.code}</h1></div>
        </div>
        <span className="fin-asset-detail-status"><i />{asset.status === 'ready' ? 'Balance available' : 'Unavailable'}</span>
      </div>
      <div className="fin-asset-detail-balance">
        <span>Your balance</span>
        <strong>{hidden ? '••••' : assetAmount(asset)} <small>{asset.amount_atomic === null ? '' : asset.code}</small></strong>
        <p>{asset.status === 'ready' ? 'Across your Microsendr wallets' : asset.code === 'NGN'
          ? 'Naira accounts are not available yet' : 'Balance could not be loaded'}</p>
      </div>
      <div className="fin-asset-detail-actions">
        {asset.code !== 'NGN' ? <>
          <button onClick={() => go(`/personal/deposit?asset=${asset.code.toLowerCase()}`)}><span><ArrowDownLeft size={20} /></span>Receive {asset.code}</button>
          <button onClick={() => go(`/personal/send?asset=${asset.code.toLowerCase()}`)}><span><ArrowUpRight size={20} /></span>Send {asset.code}</button>
        </> : <button onClick={() => go('/personal/deposit?method=bank')}><span><ArrowDownLeft size={20} /></span>Add naira</button>}
      </div>
    </section>
    <div className="fin-asset-detail-grid">
      <section className="fin-panel fin-asset-detail-activity" aria-label={`${asset.code} activity`}>
        <div className="fin-asset-detail-section-title"><h2>Activity</h2>{movements.length > 0 && <button onClick={() => go('/personal/activity')}>View all <ArrowRight size={15} /></button>}</div>
        {movements.length ? <div className="fin-asset-detail-movements">{movements.map(item =>
          <div className="fin-asset-detail-movement" key={item.id}>
            <span className="fin-asset-detail-movement-icon">{item.direction === 'received' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span>
            <span className="fin-asset-detail-movement-copy"><b>{item.direction === 'received' ? 'Received' : 'Sent'} {item.asset === 'QIEV3' ? 'QIE' : item.asset}</b><small>{new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {item.status === 'confirmed' ? 'Completed' : item.status === 'failed' ? 'Failed' : 'Processing'}</small></span>
            <b>{hidden ? '••••' : `${item.direction === 'received' ? '+' : '−'}${assetAmount({ ...asset, amount_atomic: item.amount_atomic, decimals: item.decimals ?? asset.decimals })}`}</b>
          </div>)}</div> : <div className="fin-asset-detail-empty"><Clock3 size={21} /><strong>No activity yet</strong><span>{asset.code === 'NGN' ? 'Naira activity will appear here when available.' : `${asset.code} you send or receive in your wallets appears here.`}</span></div>}
      </section>
      <section className="fin-panel fin-asset-detail-info" aria-label="Asset information">
        <h2>About {asset.code}</h2>
        <div className="fin-asset-detail-fact"><span>Type</span><b>{asset.code === 'QIE' ? 'Native asset' : asset.code === 'QUSDC' ? 'Stablecoin' : 'Local currency'}</b></div>
        {crypto && <div className="fin-asset-detail-fact"><span>Network</span><b>QIE Mainnet</b></div>}
        {asset.code === 'QUSDC' && <a className="fin-asset-detail-contract" href="https://mainnet.qie.digital/token/0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5" target="_blank" rel="noreferrer">View token contract <ArrowUpRight size={15} /></a>}
        {asset.code === 'QIE' && <p>Network details are shown when you receive or send.</p>}
        {asset.code === 'NGN' && <p>Your balance will appear here when an eligible naira account is available.</p>}
      </section>
    </div>
  </div>;
}
