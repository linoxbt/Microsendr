import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, Fingerprint, Gift, Phone, Wifi } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ConsumerRequestError, consumerRequest, type ConsumerProfile } from './consumer-api.js';
import { passkeysSupported, type PaymentAuthStatus } from './payment-security.js';
import { formatAtomic } from './money.js';

type Kind = 'airtime' | 'data' | 'giftcard';
type Config = { available: boolean; environment: string; giftcard_countries: string[] };
type Operator = { id: number; name: string; logo: string | null; currency: string; denomination: 'RANGE' | 'FIXED'; min: number | null; max: number | null; fixed: number[]; plans: { amount: number; description: string }[] };
type Card = { id: number; name: string; brand: string; logo: string | null; currency: string; denomination: 'RANGE' | 'FIXED'; fixed: number[]; min: number | null; max: number | null };
type Quote = { product_name: string; face: { amount: number; currency: string }; fee_usd: number; price_atomic: string; pay_to: string };
type Order = { id: string; kind: Kind; status: string; product_name: string; recipient: string | null; face: { amount: number; currency: string };
  price_atomic: string; environment: string; created_at: string; codes?: { code: string; pin: string | null }[]; codes_unavailable?: boolean };

const money = (amount: number, currency: string) =>
  currency === 'NGN' ? `₦${amount.toLocaleString('en-US')}` : `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
const qusdc = (atomic: string) => `${formatAtomic(atomic, 6)} QUSDC`;
const statusText: Record<string, string> = {
  paying: 'Paying', paid: 'Payment confirming', fulfilling: 'Delivering', delivered: 'Delivered',
  payment_failed: 'Payment did not go through', refund_due: 'Refund on the way',
};
const AIRTIME_AMOUNTS = [100, 200, 500, 1000, 2000, 5000];
const titles: Record<Kind, string> = { airtime: 'Airtime', data: 'Data', giftcard: 'Subscriptions & gift cards' };

/** Approve a payment from the account wallet with a passkey, the payment PIN, or the password. */
function useApproval(csrf: string) {
  const [auth, setAuth] = useState<PaymentAuthStatus>();
  const [method, setMethod] = useState<'passkey' | 'pin' | 'password'>('password');
  const [pin, setPin] = useState(''), [password, setPassword] = useState('');
  useEffect(() => {
    void consumerRequest<PaymentAuthStatus>('payment-auth').then((status) => {
      setAuth(status);
      const locked = !!status.pin_locked_until && new Date(status.pin_locked_until) > new Date();
      setMethod(status.passkeys.length && passkeysSupported() ? 'passkey' : status.pin_set && !locked ? 'pin' : 'password');
    }).catch(() => setAuth({ pin_set: false, pin_locked_until: null, passkeys: [] }));
  }, []);
  async function approval(transfer: { to: string; amount_atomic: string }) {
    if (method === 'pin') return { pin };
    if (method === 'password') return { password };
    const { challenge_id, options } = await consumerRequest<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
      'payment-auth/passkeys/challenge', 'POST', { ...transfer, asset: 'QUSDC' }, csrf);
    const response = await startAuthentication({ optionsJSON: options }).catch(() => {
      throw new Error('The passkey did not approve this payment. Try again or use your PIN.');
    });
    return { passkey: { challenge_id, response } };
  }
  const ready = !!auth && (method !== 'pin' || pin.length === 6) && (method !== 'password' || password.length > 0);
  const fields = <>
    {method === 'pin' && <label>Payment PIN<input className="fin-pin-input" type="password" inputMode="numeric" autoComplete="off"
      value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} maxLength={6} required autoFocus /></label>}
    {method === 'password' && <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
      autoComplete="current-password" required autoFocus /></label>}
    {auth && <div className="fin-approval-switch">
      {method !== 'passkey' && !!auth.passkeys.length && passkeysSupported() && <button type="button" className="fin-text" onClick={() => setMethod('passkey')}>Use passkey</button>}
      {method !== 'pin' && auth.pin_set && <button type="button" className="fin-text" onClick={() => setMethod('pin')}>Use PIN</button>}
    </div>}
  </>;
  const clear = () => { setPin(''); setPassword(''); };
  return { method, ready, fields, approval, clear };
}

export function BillsFlow({ kind, csrf, profile, go }: { kind: Kind; csrf: string; profile: ConsumerProfile; go: (path: string) => void }) {
  const [config, setConfig] = useState<Config>();
  const [phone, setPhone] = useState((profile.phone ?? '').replace(/\s/g, ''));
  const [operator, setOperator] = useState<Operator>();
  const [country, setCountry] = useState('US');
  const [cards, setCards] = useState<Card[]>();
  const [card, setCard] = useState<Card>();
  const [email, setEmail] = useState(profile.email ?? '');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const approval = useApproval(csrf);

  useEffect(() => { void consumerRequest<Config>('bills/config').then(setConfig).catch(() => setConfig({ available: false, environment: '', giftcard_countries: [] })); }, []);
  useEffect(() => {
    if (kind !== 'giftcard' || !config?.available) return;
    setCards(undefined); setCard(undefined);
    void consumerRequest<{ data: Card[] }>(`bills/giftcards?country=${country}`).then((r) => setCards(r.data)).catch((e) => setError((e as Error).message));
  }, [kind, country, config?.available]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) {
      if (e instanceof ConsumerRequestError && e.code === 'price_changed') setQuote(undefined);
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  const findOperator = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setOperator(undefined); setAmount(''); setQuote(undefined);
      const r = await consumerRequest<{ operator: Operator }>(`bills/operator?phone=${encodeURIComponent(phone)}&country=NG&kind=${kind}`);
      setOperator(r.operator);
    });
  };
  const body = () => kind === 'giftcard'
    ? { kind, country, product_id: card!.id, amount: Number(amount), email }
    : { kind, country: 'NG', phone, operator_id: operator!.id, amount: Number(amount) };
  const getQuote = () => void run(async () => {
    if (!(Number(amount) > 0)) throw new Error('Choose an amount.');
    setQuote(await consumerRequest<Quote>('bills/quote', 'POST', body(), csrf));
    setRequestKey(crypto.randomUUID());
  });
  const pay = (event: React.FormEvent) => {
    event.preventDefault();
    if (!quote) return;
    void run(async () => {
      const order = await consumerRequest<Order>('bills/orders', 'POST',
        { ...body(), max_price_atomic: quote.price_atomic, ...(await approval.approval({ to: quote.pay_to, amount_atomic: quote.price_atomic })) },
        csrf, { 'Idempotency-Key': requestKey });
      approval.clear();
      go(`/personal/bills/${order.id}`);
    });
  };

  if (!config) return <div className="rt-bills"><div className="fin-skeleton-rows" role="status" aria-label="Loading">
    {[0, 1, 2].map((n) => <span key={n}><i className="fin-sk fin-sk-line" /></span>)}</div></div>;
  if (!config.available) return <div className="rt-empty rt-empty-page"><span>{kind === 'giftcard' ? <Gift size={30} /> : kind === 'data' ? <Wifi size={30} /> : <Phone size={30} />}</span><p>Coming soon</p></div>;

  // Review and approve: what it costs in QUSDC and what the recipient gets.
  if (quote) return <form className="rt-bills rt-bill-review" onSubmit={pay} aria-label="Review purchase">
    <div className="rt-bill-total"><span>You pay</span><strong>{qusdc(quote.price_atomic)}</strong></div>
    <dl className="fin-send-facts">
      <div><dt>{kind === 'giftcard' ? 'Card' : 'For'}</dt><dd>{quote.product_name}</dd></div>
      <div><dt>{kind === 'giftcard' ? 'Value' : 'Recipient gets'}</dt><dd>{money(quote.face.amount, quote.face.currency)}</dd></div>
      <div><dt>{kind === 'giftcard' ? 'Code sent to' : 'Phone'}</dt><dd>{kind === 'giftcard' ? email || 'Your account' : `+${phone.replace(/^\+/, '')}`}</dd></div>
      <div><dt>Fee</dt><dd>{quote.fee_usd.toFixed(2)} QUSDC (included)</dd></div>
    </dl>
    {approval.fields}
    <button className="fin-primary" disabled={busy || !approval.ready}>
      {busy ? 'Paying…' : approval.method === 'passkey' ? <><Fingerprint size={18} /> Pay with passkey</> : <>Pay {qusdc(quote.price_atomic)} <ArrowRight size={17} /></>}
    </button>
    <button type="button" className="fin-text" onClick={() => setQuote(undefined)} disabled={busy}>Change</button>
    {error && <p className="fin-error" role="alert">{error}</p>}
  </form>;

  if (kind === 'giftcard') return <div className="rt-bills">
    <div className="fin-methods rt-country" role="group" aria-label="Card country">
      {config.giftcard_countries.map((c) => <button key={c} type="button" className={c === country ? 'active' : ''} aria-pressed={c === country} onClick={() => setCountry(c)}>{c}</button>)}
    </div>
    {!card ? (cards === undefined ? <div className="fin-skeleton-rows" role="status" aria-label="Loading cards">{[0, 1, 2].map((n) => <span key={n}><i className="fin-sk fin-sk-line" /></span>)}</div>
      : cards.length ? <div className="rt-brand-grid" role="list" aria-label="Cards">
        {cards.map((c) => <button key={c.id} role="listitem" type="button" className="rt-brand" onClick={() => { setCard(c); setAmount(''); }}>
          {c.logo ? <img src={c.logo} alt="" loading="lazy" /> : <span className="rt-brand-fallback">{c.brand.slice(0, 1)}</span>}
          <b>{c.brand}</b>
        </button>)}
      </div> : <div className="rt-empty"><span><Gift size={28} /></span><p>No cards for this country yet</p></div>)
      : <form className="fin-chain-send" onSubmit={(e) => { e.preventDefault(); getQuote(); }}>
        <div className="rt-bill-picked"><b>{card.name}</b><button type="button" className="fin-text" onClick={() => setCard(undefined)}>Change</button></div>
        <div className="rt-amounts" role="group" aria-label="Amount">
          {(card.denomination === 'FIXED' ? card.fixed : [10, 25, 50, 100].filter((v) => v >= (card.min ?? 0) && v <= (card.max ?? Infinity))).slice(0, 8).map((v) =>
            <button key={v} type="button" className={Number(amount) === v ? 'active' : ''} aria-pressed={Number(amount) === v} onClick={() => setAmount(String(v))}>{money(v, card.currency)}</button>)}
        </div>
        <label>Send the code to<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <button className="fin-primary" disabled={busy || !amount}>{busy ? 'Getting price…' : 'Continue'} <ArrowRight size={17} /></button>
      </form>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </div>;

  return <div className="rt-bills">
    <form className="fin-chain-send" onSubmit={findOperator}>
      <label>Phone number<input type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value.replace(/[^\d+]/g, '')); setOperator(undefined); }}
        placeholder="+234 801 234 5678" autoComplete="tel" required /></label>
      {!operator && <button className="fin-primary" disabled={busy || phone.replace(/\D/g, '').length < 10}>{busy ? 'Finding network…' : 'Continue'} <ArrowRight size={17} /></button>}
    </form>
    {operator && <div className="fin-chain-send">
      <div className="rt-bill-picked">{operator.logo && <img src={operator.logo} alt="" />}<b>{operator.name}</b></div>
      {kind === 'data'
        ? <div className="rt-plans" role="list" aria-label="Data plans">
          {operator.plans.map((plan) => <button key={plan.amount} role="listitem" type="button" className={`rt-plan${Number(amount) === plan.amount ? ' active' : ''}`}
            aria-pressed={Number(amount) === plan.amount} onClick={() => setAmount(String(plan.amount))}>
            <span>{plan.description}</span><b>{money(plan.amount, operator.currency)}</b></button>)}
        </div>
        : <>
          <div className="rt-amounts" role="group" aria-label="Amount">
            {(operator.denomination === 'FIXED' ? operator.fixed : AIRTIME_AMOUNTS.filter((v) => v >= (operator.min ?? 0) && v <= (operator.max ?? Infinity))).slice(0, 8).map((v) =>
              <button key={v} type="button" className={Number(amount) === v ? 'active' : ''} aria-pressed={Number(amount) === v} onClick={() => setAmount(String(v))}>{money(v, operator.currency)}</button>)}
          </div>
          {operator.denomination === 'RANGE' && <label>Or enter an amount<input inputMode="numeric" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder={`${operator.min ?? ''} – ${operator.max ?? ''}`} /></label>}
        </>}
      <button className="fin-primary" type="button" onClick={getQuote} disabled={busy || !amount}>{busy ? 'Getting price…' : 'Continue'} <ArrowRight size={17} /></button>
    </div>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </div>;
}

/** One purchase: status while it is paid and delivered, and a gift card's code once ready. */
export function BillReceipt({ id, go }: { id: string; go: (path: string) => void }) {
  const [order, setOrder] = useState<Order>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let stop = false;
    const load = () => consumerRequest<Order>(`bills/orders/${id}`).then((o) => {
      if (stop) return;
      setOrder(o);
      if (['paying', 'paid', 'fulfilling'].includes(o.status)) setTimeout(load, 4000);
    }).catch((e) => setError((e as Error).message));
    void load();
    return () => { stop = true; };
  }, [id]);
  if (error) return <p className="fin-error" role="alert">{error}</p>;
  if (!order) return <div className="fin-skeleton-rows" role="status" aria-label="Loading"><span><i className="fin-sk fin-sk-line" /></span></div>;
  const done = order.status === 'delivered';
  return <section className="rt-bills rt-receipt" aria-label="Purchase">
    <span className={`rt-receipt-icon${done ? ' done' : ''}`}>{done ? <Check size={28} /> : order.kind === 'giftcard' ? <Gift size={26} /> : <Phone size={26} />}</span>
    <h2>{statusText[order.status] ?? order.status}</h2>
    <p>{order.product_name} · {money(order.face.amount, order.face.currency)}{order.recipient ? ` · ${order.recipient}` : ''}</p>
    <dl className="fin-send-facts">
      <div><dt>Paid</dt><dd>{qusdc(order.price_atomic)}</dd></div>
      <div><dt>Date</dt><dd>{new Date(order.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</dd></div>
      {order.environment === 'sandbox' && <div><dt>Mode</dt><dd>Test</dd></div>}
    </dl>
    {order.codes?.map((c, i) => <div className="rt-code" key={i}>
      <span>Code</span><code>{c.code}</code>
      {c.pin && <><span>PIN</span><code>{c.pin}</code></>}
      <button type="button" className="fin-secondary" onClick={() => void navigator.clipboard?.writeText(c.code).then(() => setCopied(c.code))}>
        {copied === c.code ? <Check size={15} /> : <Copy size={15} />} {copied === c.code ? 'Copied' : 'Copy code'}
      </button>
    </div>)}
    {order.codes_unavailable && <p className="fin-small">The code is on its way to your email.</p>}
    {order.status === 'refund_due' && <p className="fin-small">The provider could not complete this. Your QUSDC will be returned to your wallet.</p>}
    <button className="fin-text" type="button" onClick={() => go('/personal/home')}>Done</button>
  </section>;
}

export const billTitles = titles;
