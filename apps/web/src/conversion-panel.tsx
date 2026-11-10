import React, { useEffect, useState } from 'react';
import { ArrowRight, Copy, RefreshCw } from 'lucide-react';
import { consumerRequest } from './consumer-api.js';

type Asset = { code: string; network: string; asset: string };
type Field = { key: string; label?: string; type?: string; required?: boolean; options?: { value: string; label?: string }[] };
type Fee = { id: string; label: string; amount: number; currency?: string };
type Quote = {
  quote_id: string; expires_at: string; direction: 'buy' | 'sell';
  pay: { currency: string; amount: number }; receive: { currency: string; amount: number };
  rate: number; fees: Fee[]; fields: Field[];
};
type Order = {
  id: string; status: string; pay: { currency: string; amount: number };
  receive: Asset & { amount: number }; wallet_address: string; created_at: string; payout_tx_hash: string | null;
  transfer_instructions: { instructionsText?: string | null; warningText?: string | null; transferDetails?: { id: string; value?: unknown; label?: string }[] } | null;
};
type Wallet = { id: string; address: string; managed?: boolean; custody?: string };

const statusText: Record<string, string> = {
  deposit_awaiting: 'Waiting for your bank transfer', deposit_validating: 'Checking your payment', deposit_successful: 'Payment received',
  deposit_invalid: 'Payment could not be matched', deposit_canceled: 'Canceled', deposit_expired: 'Expired (a late payment is still accepted)',
  payout_pending: 'Sending your coins', payout_successful: 'Delivered to your wallet', payout_failed: 'Delivery delayed, retrying',
  refund_initiated: 'Refund started', refund_pending: 'Refund in progress', refund_successful: 'Refunded', refund_failed: 'Refund delayed',
};
const detailLabels: Record<string, string> = {
  recipientBankName: 'Bank', recipientBankAccountNumber: 'Account number', recipientBankAccountName: 'Account name', amountToSend: 'Amount to send',
};
const naira = (n: number) => `₦${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const coin = (code: string) => code.split('_').slice(1).join('_');
const money = (amount: number, currency: string) => currency === 'NGN' ? naira(amount) : `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${coin(currency)}`;

/** Buy stablecoins with naira through Fonbnk, and quote both directions with every fee shown. */
export function ConversionPanel({ csrf }: { csrf: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletId, setWalletId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<Order>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  const loadOrders = () => consumerRequest<{ data: Order[] }>('conversion/orders').then((r) => setOrders(r.data)).catch(() => undefined);
  useEffect(() => {
    void consumerRequest<{ assets: Asset[] }>('conversion/config').then((c) => { setAssets(c.assets); setAsset(c.assets[0]?.code ?? ''); })
      .catch((e) => setError((e as Error).message));
    void consumerRequest<{ data: Wallet[] }>('wallets').then((w) => {
      const own = w.data.filter((x) => !x.managed && x.custody !== 'managed');
      setWallets(own); setWalletId(own[0]?.id ?? '');
    }).catch(() => undefined);
    void loadOrders();
  }, []);
  const reset = () => { setQuote(undefined); setRequestKey(crypto.randomUUID()); };

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const getQuote = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const value = Number(amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount above zero.');
      setQuote(await consumerRequest<Quote>('conversion/quote', 'POST', { direction, asset, amount: value }, csrf));
    });
  };
  const placeOrder = (event: React.FormEvent) => {
    event.preventDefault();
    if (!quote) return;
    void run(async () => {
      if (!walletId) throw new Error('Link a self-custody wallet first. Your coins are sent there.');
      const created = await consumerRequest<Order>('conversion/orders', 'POST',
        { quote_id: quote.quote_id, asset, amount: Number(amount), wallet_id: walletId, fields }, csrf, { 'Idempotency-Key': requestKey });
      setOrder(created); setQuote(undefined); setRequestKey(crypto.randomUUID()); void loadOrders();
    });
  };
  const act = (path: 'refresh' | 'confirm') => order && void run(async () => {
    setOrder(await consumerRequest<Order>(`conversion/orders/${order.id}/${path}`, 'POST', path === 'confirm' ? { fields: {} } : {}, csrf));
    void loadOrders();
  });
  const selected = assets.find((a) => a.code === asset);

  if (order) {
    const details = order.transfer_instructions?.transferDetails ?? [];
    return <div className="fin-convert">
      <h2>{statusText[order.status] ?? order.status}</h2>
      <p>Buying {money(order.receive.amount, order.receive.code)} on {order.receive.network}, delivered to {order.wallet_address.slice(0, 8)}…{order.wallet_address.slice(-6)}.</p>
      {order.status === 'deposit_awaiting' && <>
        <dl className="fin-convert-instructions" aria-label="Bank transfer details">
          {details.map((d) => <div key={d.id}>
            <dt>{detailLabels[d.id] ?? d.label ?? d.id}</dt>
            <dd>{d.id === 'amountToSend' ? naira(Number(d.value)) : String(d.value ?? '')}
              {d.id === 'recipientBankAccountNumber' && <button type="button" className="fin-text" aria-label="Copy account number"
                onClick={() => void navigator.clipboard?.writeText(String(d.value ?? ''))}><Copy size={14} /></button>}</dd>
          </div>)}
        </dl>
        {order.transfer_instructions?.instructionsText && <p>{order.transfer_instructions.instructionsText}</p>}
        {order.transfer_instructions?.warningText && <p className="fin-convert-warning" role="note">{order.transfer_instructions.warningText}</p>}
        <button className="fin-primary" type="button" disabled={busy} onClick={() => act('confirm')}>I've sent the payment <ArrowRight size={17} /></button>
      </>}
      <div className="fin-form-actions">
        <button className="fin-secondary" type="button" disabled={busy} onClick={() => act('refresh')}><RefreshCw size={15} /> Refresh status</button>
        <button className="fin-text" type="button" onClick={() => setOrder(undefined)}>New conversion</button>
      </div>
      {error && <p className="fin-error" role="alert">{error}</p>}
    </div>;
  }

  return <div className="fin-convert">
    <div className="fin-methods" role="group" aria-label="Conversion direction">
      {(['buy', 'sell'] as const).map((d) => <button key={d} type="button" className={direction === d ? 'active' : ''} aria-pressed={direction === d}
        onClick={() => { setDirection(d); reset(); }}>{d === 'buy' ? 'Buy with naira' : 'Sell for naira'}</button>)}
    </div>
    <form className="fin-convert-form" onSubmit={getQuote}>
      <label>Stablecoin
        <select value={asset} onChange={(e) => { setAsset(e.target.value); reset(); }}>
          {assets.map((a) => <option key={a.code} value={a.code}>{a.asset} on {a.network}</option>)}
        </select>
      </label>
      <label>{direction === 'buy' ? 'Amount in naira (NGN)' : `Amount in ${selected?.asset ?? 'coins'}`}
        <input value={amount} onChange={(e) => { setAmount(e.target.value); reset(); }} inputMode="decimal" placeholder={direction === 'buy' ? '10000' : '10'} required />
      </label>
      <button className="fin-secondary" disabled={busy}>{busy && !quote ? 'Getting quote…' : 'Get quote'}</button>
    </form>
    {quote && <section className="fin-convert-quote" aria-label="Quote">
      <dl>
        <div><dt>You pay</dt><dd>{money(quote.pay.amount, quote.pay.currency)}</dd></div>
        {quote.fees.map((f) => <div key={`${f.id}-${f.currency}`}><dt>{f.label}</dt><dd>{money(f.amount, f.currency ?? quote.pay.currency)}</dd></div>)}
        <div><dt>Rate</dt><dd>1 {coin(direction === 'buy' ? quote.receive.currency : quote.pay.currency)} = {naira(quote.rate)}</dd></div>
        <div className="fin-convert-total"><dt>You receive</dt><dd>{money(quote.receive.amount, quote.receive.currency)}</dd></div>
      </dl>
      <p className="fin-small">Quote from Fonbnk, valid until {new Date(quote.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Prices are checked again when you place the order.</p>
      {direction === 'sell' ? <p className="fin-small"><span className="fin-status">Coming soon</span> Selling to your bank account is not available yet.</p>
        : <form className="fin-convert-form" onSubmit={placeOrder}>
          <label>Deliver to wallet
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)} required>
              {wallets.map((w) => <option key={w.id} value={w.id}>{w.address.slice(0, 8)}…{w.address.slice(-6)}</option>)}
            </select>
          </label>
          {!wallets.length && <p className="fin-small">Link a self-custody wallet on the Add money page first. Fonbnk delivers to {selected?.network ?? 'its network'}, so coins go to a wallet you control.</p>}
          {quote.fields.map((f) => <label key={f.key}>{f.label ?? f.key}
            {f.options?.length
              ? <select value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} required={f.required !== false}>
                  <option value="" disabled>Choose…</option>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                </select>
              : <input value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  type={f.type === 'phone' ? 'tel' : 'text'} required={f.required !== false} />}
          </label>)}
          <button className="fin-primary" disabled={busy || !wallets.length}>{busy ? 'Placing order…' : 'Buy now'} <ArrowRight size={17} /></button>
        </form>}
    </section>}
    {orders.length > 0 && <section className="fin-convert-orders" aria-label="Your conversions">
      <h3>Your conversions</h3>
      {orders.map((o) => <button key={o.id} type="button" className="fin-convert-order" onClick={() => setOrder(o)}>
        <span><b>{money(o.receive.amount, o.receive.code)}</b><small>{new Date(o.created_at).toLocaleDateString()} · {naira(o.pay.amount)}</small></span>
        <span>{statusText[o.status] ?? o.status}</span>
      </button>)}
    </section>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </div>;
}
