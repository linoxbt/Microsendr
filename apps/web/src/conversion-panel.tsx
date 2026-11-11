import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { ConsumerRequestError, consumerRequest } from './consumer-api.js';

type Asset = { code: string; network: string; asset: string };
type Field = { key: string; label?: string; type?: string; required?: boolean; options?: { value: string; label?: string }[] };
type Fee = { id: string; label: string; amount: number; currency?: string };
type Quote = {
  quote_id: string; expires_at: string; direction: 'buy' | 'sell'; environment: string;
  pay: { currency: string; amount: number }; receive: { currency: string; amount: number };
  rate: number; fees: Fee[]; fields: Field[];
};
type Order = {
  id: string; status: string; environment: string; pay: { currency: string; amount: number };
  receive: Asset & { amount: number }; wallet_address: string; created_at: string; payout_tx_hash: string | null;
  fees: Fee[]; expires_at: string | null; quote_used: boolean | null;
  transfer_instructions: {
    instructionsText?: string | null; warningText?: string | null; paymentUrl?: string | null;
    transferDetails?: { id: string; value?: unknown; label?: string }[]; fieldsToConfirmOrder?: Field[];
  } | null;
};
type Wallet = { id: string; address: string; managed?: boolean; custody?: string };
type Kyc = { ready: boolean; support_required: boolean; kyc_url: string | null };
type Limits = { supported: boolean; min: number; max: number };

const statusText: Record<string, string> = {
  creating: 'Creating your order', deposit_awaiting: 'Waiting for your bank transfer', deposit_validating: 'Checking your payment',
  deposit_successful: 'Payment received', deposit_invalid: 'Payment could not be matched', deposit_canceled: 'Canceled',
  deposit_expired: 'Expired (a late payment is still accepted)', payout_pending: 'Sending your coins',
  payout_successful: 'Delivered to your wallet', payout_failed: 'Delivery delayed, retrying', refund_initiated: 'Refund started',
  refund_pending: 'Refund in progress', refund_successful: 'Refunded', refund_failed: 'Refund delayed',
};
const settled = new Set(['payout_successful', 'refund_successful']);
const detailLabels: Record<string, string> = {
  recipientBankName: 'Bank', recipientBankAccountNumber: 'Account number', recipientBankAccountName: 'Account name',
  amountToSend: 'Amount to send', narration: 'Narration',
};
const copyable = new Set(['recipientBankAccountNumber', 'amountToSend', 'narration']);
const naira = (n: number) => `₦${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const coin = (code: string) => code.split('_').slice(1).join('_') || code;
const money = (amount: number, currency: string) =>
  currency === 'NGN' ? naira(amount) : `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${coin(currency)}`;
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

function FieldInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  return <label>{field.label ?? field.key}
    {field.options?.length
      ? <select value={value} onChange={(e) => onChange(e.target.value)} required={field.required !== false}>
          <option value="" disabled>Choose…</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
        </select>
      : <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={120}
          type={field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : 'text'} required={field.required !== false} />}
  </label>;
}

/** Buy stablecoins with naira through Fonbnk, with every fee shown before the order. */
export function ConversionPanel({ csrf, buyOnly = false }: { csrf: string; buyOnly?: boolean }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sandbox, setSandbox] = useState(false);
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [limits, setLimits] = useState<Limits>();
  const [quote, setQuote] = useState<Quote>();
  const [expired, setExpired] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletId, setWalletId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [confirmFields, setConfirmFields] = useState<Record<string, string>>({});
  const [kyc, setKyc] = useState<Kyc>();
  const [order, setOrder] = useState<Order>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  const loadOrders = () => consumerRequest<{ data: Order[] }>('conversion/orders').then((r) => setOrders(r.data)).catch(() => undefined);
  useEffect(() => {
    void consumerRequest<{ assets: Asset[]; environment: string }>('conversion/config').then((c) => {
      setAssets(c.assets); setAsset(c.assets[0]?.code ?? ''); setSandbox(c.environment === 'sandbox');
    }).catch((e) => setError((e as Error).message));
    void consumerRequest<{ data: Wallet[] }>('wallets').then((w) => {
      const own = w.data.filter((x) => !x.managed && x.custody !== 'managed');
      setWallets(own); setWalletId(own[0]?.id ?? '');
    }).catch(() => undefined);
    void loadOrders();
  }, []);
  useEffect(() => {
    setLimits(undefined);
    if (!asset || direction !== 'buy') return;
    void consumerRequest<Limits>(`conversion/limits?asset=${encodeURIComponent(asset)}`).then(setLimits).catch(() => undefined);
  }, [asset, direction]);
  // A quote is only good until it expires; then the customer asks for current terms.
  useEffect(() => {
    if (!quote) return;
    const left = new Date(quote.expires_at).getTime() - Date.now();
    if (left <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [quote]);
  // Keep an open order's status current while it is on screen.
  useEffect(() => {
    if (!order || settled.has(order.status) || order.status === 'creating') return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void consumerRequest<Order>(`conversion/orders/${order.id}/refresh`, 'POST', {}, csrf).then(setOrder).catch(() => undefined);
    }, 20000);
    return () => clearInterval(timer);
  }, [order?.id, order?.status, csrf]);

  const reset = () => { setQuote(undefined); setExpired(false); setRequestKey(crypto.randomUUID()); };
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) {
      const code = e instanceof ConsumerRequestError ? e.code : null;
      if (code === 'quote_expired' || code === 'quote_mismatch') setExpired(true);
      if (code === 'provider_kyc_required' || code === 'provider_kyc_support')
        void consumerRequest<Kyc>('conversion/kyc').then(setKyc).catch(() => undefined);
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  const getQuote = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const value = Number(amount);
      if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || !(value > 0)) throw new Error('Enter an amount with at most two decimals.');
      if (direction === 'buy' && limits) {
        if (value < limits.min) throw new Error(`The minimum is ${naira(limits.min)}.`);
        if (value > limits.max) throw new Error(`The maximum is ${naira(limits.max)}.`);
      }
      setExpired(false);
      setQuote(await consumerRequest<Quote>('conversion/quote', 'POST', { direction, asset, amount: value }, csrf));
      if (direction === 'buy') void consumerRequest<Kyc>('conversion/kyc').then(setKyc).catch(() => undefined);
    });
  };
  const placeOrder = (event: React.FormEvent) => {
    event.preventDefault();
    if (!quote) return;
    void run(async () => {
      if (!walletId) throw new Error('Link a self-custody wallet first. Your coins are sent there.');
      const created = await consumerRequest<Order>('conversion/orders', 'POST',
        { quote_id: quote.quote_id, asset, amount: Number(amount), wallet_id: walletId, fields }, csrf, { 'Idempotency-Key': requestKey });
      setOrder(created); setQuote(undefined); setRequestKey(crypto.randomUUID()); setConfirmFields({}); void loadOrders();
    });
  };
  const act = (path: 'refresh' | 'confirm') => order && void run(async () => {
    setOrder(await consumerRequest<Order>(`conversion/orders/${order.id}/${path}`, 'POST', path === 'confirm' ? { fields: confirmFields } : {}, csrf));
    void loadOrders();
  });
  const copy = (id: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); });
  };
  const selected = assets.find((a) => a.code === asset);
  const badge = sandbox && <span className="fin-status" title="Test mode: no real money moves">Test mode</span>;

  if (order) {
    const instructions = order.transfer_instructions;
    const details = instructions?.transferDetails ?? [];
    const toConfirm = instructions?.fieldsToConfirmOrder ?? [];
    return <div className="fin-convert">
      <h2>{statusText[order.status] ?? order.status} {order.environment === 'sandbox' && <span className="fin-status">Test mode</span>}</h2>
      <p>{money(order.receive.amount, order.receive.code)} on {order.receive.network} to {short(order.wallet_address)}.</p>
      {order.quote_used === false && <p className="fin-convert-warning" role="note">The price changed before your order was placed. The amounts shown are the new terms.</p>}
      {order.status === 'deposit_awaiting' && <>
        <dl className="fin-convert-instructions" aria-label="Bank transfer details">
          {details.map((d) => {
            const value = String(d.value ?? '');
            return <div key={d.id}>
              <dt>{detailLabels[d.id] ?? d.label ?? d.id}</dt>
              <dd>{d.id === 'amountToSend' ? naira(Number(d.value)) : value}
                {copyable.has(d.id) && <button type="button" className="fin-text" aria-label={`Copy ${(detailLabels[d.id] ?? d.id).toLowerCase()}`}
                  onClick={() => copy(d.id, value)}>{copied === d.id ? <Check size={14} /> : <Copy size={14} />}</button>}</dd>
            </div>;
          })}
          {order.expires_at && <div><dt>Pay before</dt><dd>{new Date(order.expires_at).toLocaleString([], { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}</dd></div>}
        </dl>
        {details.some((d) => d.id === 'narration') && <p className="fin-small">Use the narration exactly, so your payment is matched.</p>}
        {instructions?.instructionsText && <p>{instructions.instructionsText}</p>}
        {instructions?.warningText && <p className="fin-convert-warning" role="note">{instructions.warningText}</p>}
        {instructions?.paymentUrl && <a className="fin-secondary" href={instructions.paymentUrl} target="_blank" rel="noreferrer">Open payment page <ExternalLink size={14} /></a>}
        <form className="fin-convert-form" onSubmit={(e) => { e.preventDefault(); act('confirm'); }}>
          {toConfirm.map((f) => <FieldInput key={f.key} field={f} value={confirmFields[f.key] ?? ''}
            onChange={(v) => setConfirmFields({ ...confirmFields, [f.key]: v })} />)}
          <button className="fin-primary" disabled={busy}>I've sent the payment <ArrowRight size={17} /></button>
        </form>
      </>}
      {order.payout_tx_hash && <p className="fin-small">Transaction {short(order.payout_tx_hash)}</p>}
      <div className="fin-form-actions">
        <button className="fin-secondary" type="button" disabled={busy || order.status === 'creating'} onClick={() => act('refresh')}><RefreshCw size={15} /> Refresh</button>
        <button className="fin-text" type="button" onClick={() => setOrder(undefined)}>New purchase</button>
      </div>
      {error && <p className="fin-error" role="alert">{error}</p>}
    </div>;
  }

  return <div className="fin-convert">
    {badge}
    {!buyOnly && <div className="fin-methods" role="group" aria-label="Conversion direction">
      {(['buy', 'sell'] as const).map((d) => <button key={d} type="button" className={direction === d ? 'active' : ''} aria-pressed={direction === d}
        onClick={() => { setDirection(d); reset(); }}>{d === 'buy' ? 'Buy with naira' : 'Sell for naira'}</button>)}
    </div>}
    <form className="fin-convert-form" onSubmit={getQuote}>
      <label>Stablecoin
        <select value={asset} onChange={(e) => { setAsset(e.target.value); reset(); }}>
          {assets.map((a) => <option key={a.code} value={a.code}>{a.asset} on {a.network}</option>)}
        </select>
      </label>
      <label>{direction === 'buy' ? 'Amount in naira (NGN)' : `Amount in ${selected?.asset ?? 'coins'}`}
        <input value={amount} onChange={(e) => { setAmount(e.target.value); reset(); }} inputMode="decimal"
          placeholder={direction === 'buy' ? (limits ? `${limits.min.toLocaleString('en-US')} – ${limits.max.toLocaleString('en-US')}` : '10000') : '10'} required />
      </label>
      {limits && !limits.supported && <p className="fin-small">Not available right now for this coin.</p>}
      <button className="fin-secondary" disabled={busy || (limits && !limits.supported)}>{busy && !quote ? 'Getting quote…' : 'Get quote'}</button>
    </form>
    {quote && <section className="fin-convert-quote" aria-label="Quote">
      <dl>
        <div><dt>You pay by bank transfer</dt><dd>{money(quote.pay.amount, quote.pay.currency)}</dd></div>
        {quote.fees.map((f) => <div key={`${f.id}-${f.currency}`}><dt>{f.label}</dt><dd>{money(f.amount, f.currency ?? quote.pay.currency)}</dd></div>)}
        <div><dt>Rate</dt><dd>1 {coin(direction === 'buy' ? quote.receive.currency : quote.pay.currency)} = {naira(quote.rate)}</dd></div>
        <div className="fin-convert-total"><dt>You receive</dt><dd>{money(quote.receive.amount, quote.receive.currency)}</dd></div>
      </dl>
      {expired
        ? <p className="fin-convert-warning" role="note">This quote expired. <button type="button" className="fin-text" onClick={getQuote}>Get a new quote</button></p>
        : <p className="fin-small">Valid until {new Date(quote.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Quoted by Fonbnk.</p>}
      {direction === 'sell' ? <p className="fin-small"><span className="fin-status">Coming soon</span> Selling to your bank is not available yet.</p>
        : kyc && !kyc.ready ? <div className="fin-convert-kyc" role="note">
            <p>{kyc.support_required ? 'Fonbnk needs to check your BVN. Contact Fonbnk support to continue.' : 'Verify your BVN with Fonbnk once before your first purchase.'}</p>
            {kyc.kyc_url && <a className="fin-primary" href={kyc.kyc_url} target="_blank" rel="noreferrer">Verify BVN <ExternalLink size={15} /></a>}
            <button type="button" className="fin-text" onClick={() => void consumerRequest<Kyc>('conversion/kyc').then(setKyc).catch(() => undefined)}>I've verified</button>
          </div>
        : <form className="fin-convert-form" onSubmit={placeOrder}>
          <label>Deliver to wallet
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)} required>
              {wallets.map((w) => <option key={w.id} value={w.id}>{short(w.address)}</option>)}
            </select>
          </label>
          {!wallets.length && <p className="fin-small">Link a self-custody wallet first. Coins arrive on {selected?.network ?? 'its network'}, in a wallet you control.</p>}
          {quote.fields.map((f) => <FieldInput key={f.key} field={f} value={fields[f.key] ?? ''} onChange={(v) => setFields({ ...fields, [f.key]: v })} />)}
          <button className="fin-primary" disabled={busy || !wallets.length || expired}>{busy ? 'Placing order…' : 'Buy now'} <ArrowRight size={17} /></button>
        </form>}
    </section>}
    {orders.length > 0 && <section className="fin-convert-orders" aria-label="Your purchases">
      <h3>Your purchases</h3>
      {orders.map((o) => <button key={o.id} type="button" className="fin-convert-order" onClick={() => setOrder(o)}>
        <span><b>{money(o.receive.amount, o.receive.code)}</b><small>{new Date(o.created_at).toLocaleDateString()} · {naira(o.pay.amount)}</small></span>
        <span>{statusText[o.status] ?? o.status}</span>
      </button>)}
    </section>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </div>;
}
