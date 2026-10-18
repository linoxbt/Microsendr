import React, { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  ChevronDown,
  Check,
  CheckCircle2,
  X,
  Copy,
  Download,
  Menu,
  LayoutDashboard,
  ArrowLeftRight,
  Globe2,
  Wallet,
  Users,
  Code2,
  Activity,
  LogOut,
  ExternalLink,
  Search,
  RefreshCw,
  Clock,
  ShieldCheck,
  AlertCircle,
  BookOpen,
  Command,
  ChevronRight,
} from 'lucide-react';
import { Kora, KoraError, type Model } from '@kora/sdk';
import '@fontsource-variable/dm-sans';
import './style.css';
import { NetworkPage } from './network.js';
import { ControlsPage } from './controls.js';
import { StellarPage } from './stellar.js';
import { LocalRailPage } from './local-rail.js';
import type { Session } from './session.js';
import { AccountPage } from './account.js';
import { LandingPage } from './landing.js';
import { BusinessPage } from './business.js';
import { PersonalPage } from './personal.js';
import { BusinessLogin } from './business-login.js';
import './microsendr.css';
import './personal-login.css';
type Intent = Model<'Intent'>;
type Asset = Model<'AssetList'>['data'][number];
const codes = ['NGN', 'KES', 'GHS', 'USDC'] as const;
const flags: Record<string, string> = { NGN: '🇳🇬', KES: '🇰🇪', GHS: '🇬🇭', USDC: '$' };
const scale = (asset: string) =>
  asset === 'KUSD' || asset === 'XLM' ? 7 : asset === 'USDC' ? 6 : 2;
function decimal(minor: string, asset: string, group = true) {
  const n = BigInt(minor),
    s = scale(asset),
    sign = n < 0n ? '-' : '',
    a = n < 0n ? -n : n,
    power = 10n ** BigInt(s);
  const whole = (a / power).toString(),
    fraction = (a % power).toString().padStart(s, '0');
  return (
    sign +
    (group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole) +
    '.' +
    (s === 6 ? fraction.replace(/0+$/, '').padEnd(2, '0') : fraction)
  );
}
function parseMinor(value: string, asset: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Enter a positive amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale(asset)) throw new Error(`Use at most ${scale(asset)} decimal places`);
  const amount =
    BigInt(whole) * 10n ** BigInt(scale(asset)) + BigInt(fraction.padEnd(scale(asset), '0'));
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  return amount.toString();
}
const uid = () => crypto.randomUUID();
const short = (id: string) => (id.length > 22 ? id.slice(0, 10) + '…' + id.slice(-6) : id);
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <rect width="36" height="36" rx="9" fill="#4682B4" />
        <path d="M7 25V11l11 10 11-10v14" fill="none" stroke="#FFF8EA" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 27h7m0 0-3-3m3 3-3 3" fill="none" stroke="#FFF8EA" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      microsendr
    </span>
  );
}
function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state}`}>
      <i />
      {state === 'unknown'
        ? 'Needs review'
        : state === 'succeeded'
          ? 'Completed'
          : state.replaceAll('_', ' ')}
    </span>
  );
}
function AssetIcon({ asset }: { asset: string }) {
  return (
    <span className={`asset-icon ${asset === 'USDC' ? 'usdc' : ''}`}>
      {flags[asset] ?? asset.slice(0, 2)}
    </span>
  );
}
function CopyButton({ value }: { value: string }) {
  const [copied, set] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        set(true);
        setTimeout(() => set(false), 1500);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="alert">
      <AlertCircle size={17} />
      {children}
    </div>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Network({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={`network-map ${compact ? 'compact' : ''}`}
      viewBox="0 0 620 390"
      role="img"
      aria-label="Simulated connections between Accra, Lagos, Nairobi and Stellar"
    >
      <defs>
        <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="9" cy="9" r="1" fill="currentColor" opacity=".16" />
        </pattern>
      </defs>
      <rect width="620" height="390" fill="url(#dots)" />
      <path
        d="M239 43L308 34 364 56 371 81 423 102 432 140 467 154 443 197 416 216 398 271 371 326 346 351 325 316 310 274 280 259 275 216 246 197 208 188 193 155 211 104Z"
        fill="currentColor"
        opacity=".07"
      />
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M216 165Q289 60 335 161" />
        <path d="M250 165Q345 81 417 217" />
        <path d="M216 165Q329 260 417 217" />
        <path d="M335 161Q416 140 417 217" />
      </g>
      {[
        [216, 165, 'Accra'],
        [250, 165, 'Lagos'],
        [417, 217, 'Nairobi'],
        [335, 100, 'Stellar'],
      ].map(([x, y, label]) => (
        <g key={label}>
          <circle cx={x} cy={y} r="15" fill="currentColor" opacity=".10" />
          <circle cx={x} cy={y} r="5" fill="currentColor" />
          <text
            x={Number(x) + 12}
            y={Number(y) + (label === 'Lagos' ? 25 : -10)}
            fill="currentColor"
            fontSize="13"
            fontFamily="inherit"
          >
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}
function usePath() {
  const personalPath = (value: string) => /^\/(?:business|app|connect|login|docs|ramp)(?:\/|$)/.test(value) ? '/personal/login' : value;
  const [path, setPath] = useState(personalPath(location.pathname));
  useEffect(() => {
    if (personalPath(location.pathname) !== location.pathname) history.replaceState(null, '', '/personal/login');
    const change = () => {
      const next = personalPath(location.pathname);
      if (next !== location.pathname) history.replaceState(null, '', next);
      setPath(next);
    };
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  const go = (next: string) => {
    const destination = personalPath(next);
    history.pushState(null, '', destination);
    setPath(destination);
    window.scrollTo(0, 0);
  };
  return [path, go] as const;
}
function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [value, set] = useState<T>(),
    [error, setError] = useState(''),
    [version, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    load()
      .then((v) => {
        if (active) set(v);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [...deps, version]);
  return { value, error, refresh: () => refresh((n) => n + 1) };
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLElement>('button,input,select')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && dialog) {
        const els = Array.from(
          dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]'),
        );
        if (!els.length) return;
        const first = els[0],
          last = els.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section role="dialog" aria-modal="true" aria-label={title} className="modal">
        <header>
          <div>
            <span className="eyebrow">KORA SANDBOX</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function TransferFlow({
  api,
  onDone,
  hosted = false,
}: {
  api: Kora;
  onDone: () => void;
  hosted?: boolean;
}) {
  const [source, setSource] = useState<(typeof codes)[number]>(hosted ? 'USDC' : 'NGN'),
    [destination, setDestination] = useState<(typeof codes)[number]>(hosted ? 'NGN' : 'KES'),
    [amount, setAmount] = useState(hosted ? '25' : '16000'),
    [name, setName] = useState(''),
    [reference, setReference] = useState(''),
    [scenario, setScenario] = useState<'success' | 'timeout' | 'insufficient_float'>('success'),
    [quote, setQuote] = useState<Model<'Quote'>>(),
    [intent, setIntent] = useState<Intent>(),
    [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  const [keys, setKeys] = useState(() => ({
    customer: uid(),
    instrument: uid(),
    quote: uid(),
    intent: uid(),
  }));
  const [beneficiary, setBeneficiary] = useState<{ customer: string; instrument: string }>();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!intent || !['processing', 'unknown'].includes(intent.state)) return;
    let active = true;
    const timer = setInterval(
      () =>
        api
          .getIntent(intent.id)
          .then((i) => {
            if (active) setIntent(i);
          })
          .catch((e) => {
            if (active) setError(message(e));
          }),
      1000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [intent?.id, intent?.state, api]);
  const seconds = quote ? Math.max(0, Math.floor((Date.parse(quote.expires_at) - now) / 1000)) : 0;
  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      if (!name.trim()) throw new Error('Enter a recipient name');
      if (!reference.trim()) throw new Error('Enter a payment reference');
      if (source === destination) throw new Error('Choose two different assets');
      const q = await api.createQuote(
        {
          source_asset: source,
          destination_asset: destination,
          amount_minor: parseMinor(amount, source),
        },
        keys.quote,
      );
      setQuote(q);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!quote) return;
    setBusy(true);
    setError('');
    try {
      let recipient = beneficiary;
      if (!recipient) {
        const customer = await api.createCustomer({ name }, keys.customer);
        const instrument = await api.createInstrument(
          customer.id,
          {
            asset: destination,
            type:
              destination === 'USDC'
                ? 'stellar_account'
                : destination === 'KES'
                  ? 'mobile_money'
                  : 'bank_account',
            label: `${name} · ${destination}`,
            sandbox_identifier: `sandbox:${keys.instrument}`,
          },
          keys.instrument,
        );
        recipient = { customer: customer.id, instrument: instrument.id };
        setBeneficiary(recipient);
      }
      setSubmitted(true);
      setIntent(
        await api.createIntent(
          {
            quote_id: quote.id,
            customer_id: recipient.customer,
            destination_instrument_id: recipient.instrument,
            reference,
            scenario,
            type: hosted ? (source === 'USDC' ? 'asset_redemption' : 'asset_purchase') : 'transfer',
          },
          keys.intent,
        ),
      );
    } catch (e) {
      if (e instanceof KoraError && e.status < 500) setSubmitted(false);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = () => {
    setQuote(undefined);
    setBeneficiary(undefined);
    setError('');
    setKeys({ customer: uid(), instrument: uid(), quote: uid(), intent: uid() });
  };
  return (
    <div className="transfer-flow">
      <div className="steps">
        {['Details', 'Review', 'Track'].map((s, i) => (
          <span className={(intent ? 2 : quote ? 1 : 0) >= i ? 'active' : ''} key={s}>
            <b>{i + 1}</b>
            {s}
          </span>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      {intent ? (
        <>
          <div className={`result ${intent.state}`}>
            <span className="result-icon">
              {intent.state === 'succeeded' ? (
                <CheckCircle2 size={36} />
              ) : intent.state === 'failed' ? (
                <AlertCircle size={36} />
              ) : (
                <Clock size={36} />
              )}
            </span>
            <h2>
              {intent.state === 'succeeded'
                ? 'Transfer completed'
                : intent.state === 'failed'
                  ? 'Transfer failed'
                  : intent.state === 'unknown'
                    ? 'Confirmation pending'
                    : 'Processing transfer'}
            </h2>
            <p>
              {intent.state === 'unknown'
                ? 'Funds remain reserved while Microsendr verifies the provider status. Review this intent in Operations.'
                : intent.state === 'succeeded'
                  ? 'The simulated provider receipt and settlement journals are recorded.'
                  : intent.state === 'failed'
                    ? 'The simulated provider rejected the transfer. Reserved funds were released.'
                    : 'Your sandbox funds are reserved. The worker is processing the instruction.'}
            </p>
            <div className="receipt-line">
              <code>{intent.id}</code>
              <CopyButton value={intent.id} />
            </div>
            <Badge state={intent.state} />
          </div>
          <button className="button primary full" onClick={onDone}>
            Back to workspace <ArrowRight size={17} />
          </button>
        </>
      ) : quote ? (
        <>
          <div className="quote-amount">
            <span>Recipient gets</span>
            <h1>
              {decimal(quote.destination.amount_minor, destination)} <small>{destination}</small>
            </h1>
            <p>
              {name} · {reference}
            </p>
          </div>
          <div className="review-lines">
            <div>
              <span>You send</span>
              <b>
                {decimal(quote.source.amount_minor, source)} {source}
              </b>
            </div>
            <div>
              <span>Included fee · 0.5%</span>
              <b>
                {decimal(quote.fee.amount_minor, source)} {source}
              </b>
            </div>
            <div>
              <span>Total reserved</span>
              <b>
                {decimal(quote.source.amount_minor, source)} {source}
              </b>
            </div>
            <div>
              <span>Quote expires in</span>
              <b>{seconds}s</b>
            </div>
          </div>
          <div className="route-line">
            {quote.route.map((leg, i) => (
              <React.Fragment key={leg.name}>
                {i > 0 && <ArrowRight size={14} />}
                <span>{leg.asset}</span>
              </React.Fragment>
            ))}
          </div>
          <p className="muted small">
            Fixed sandbox rates. This transfer uses simulated funds and a fake provider.
          </p>
          <button
            className="button primary full"
            disabled={busy || (seconds === 0 && !submitted)}
            onClick={submit}
          >
            {busy
              ? 'Submitting…'
              : seconds === 0
                ? submitted
                  ? 'Retry submission'
                  : 'Quote expired'
                : 'Confirm transfer'}
            <ArrowRight size={17} />
          </button>
          {!submitted && (
            <button
              className="button subtle full"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={edit}
            >
              {seconds === 0 ? 'Get a new quote' : 'Edit transfer'}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="currency-row">
            <label>
              You send
              <select
                value={source}
                onChange={(e) => {
                  const next = e.target.value as typeof source;
                  setSource(next);
                  if (hosted) setDestination(next === 'USDC' ? 'NGN' : 'USDC');
                }}
              >
                {codes.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <ArrowLeftRight size={20} />
            <label>
              Recipient gets
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value as typeof destination)}
              >
                {(hosted
                  ? source === 'USDC'
                    ? codes.filter((a) => a !== 'USDC')
                    : ['USDC']
                  : codes
                ).map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Amount
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Recipient name
            <input
              placeholder="e.g. Nairobi Supply Co."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Payment reference
            <input
              placeholder="e.g. Invoice #1043"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            Sandbox outcome
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as typeof scenario)}
            >
              <option value="success">Successful settlement</option>
              <option value="timeout">Acknowledgement timeout</option>
              <option value="insufficient_float">Insufficient provider liquidity</option>
            </select>
          </label>
          <div className="inline-note">
            <ShieldCheck size={17} />
            <span>Prefunded sandbox balances. No real money moves.</span>
          </div>
          <button className="button primary full" disabled={busy} onClick={prepare}>
            {busy ? 'Getting quote…' : 'Review transfer'}
            <ArrowRight size={17} />
          </button>
        </>
      )}
    </div>
  );
}
function Transactions({
  api,
  compact = false,
  onSelect,
}: {
  api: Kora;
  compact?: boolean;
  onSelect: (i: Intent) => void;
}) {
  const [search, setSearch] = useState(''),
    [state, setState] = useState(''),
    [items, setItems] = useState<Intent[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      setError('');
      try {
        const result = await api.listIntents({
          limit: compact ? '5' : '20',
          ...(state ? { state } : {}),
          ...(search ? { search } : {}),
          ...(after ? { after } : {}),
        });
        setItems((old) => (after ? [...old, ...result.data] : result.data));
        setCursor(result.next_cursor);
      } catch (e) {
        setError(message(e));
      } finally {
        setLoading(false);
      }
    },
    [api, state, search, compact],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);
  const exportCsv = () => {
    const cell = (v: string) =>
      `"${(/^[=+\-@\t\r]/.test(v) ? "'" : '') + v.replaceAll('"', '""')}"`;
    const rows = [
      [
        'ID',
        'Reference',
        'State',
        'Source asset',
        'Source minor',
        'Destination asset',
        'Destination minor',
        'Created at',
      ],
      ...items.map((i) => [
        i.id,
        i.reference,
        i.state,
        i.source.asset,
        i.source.amount_minor,
        i.destination.asset,
        i.destination.amount_minor,
        i.created_at,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'microsendr-transactions.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="card transactions">
      <div className="card-heading">
        <div>
          <h3>{compact ? 'Recent transactions' : 'All transactions'}</h3>
          <p>
            {compact
              ? 'Your latest movement across the network'
              : 'Track payments from reservation to settlement'}
          </p>
        </div>
        {compact ? (
          <span className="muted small">Latest 5</span>
        ) : (
          <button className="button subtle" onClick={exportCsv}>
            <Download size={15} />
            Export loaded rows
          </button>
        )}
      </div>
      {!compact && (
        <div className="table-controls">
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Search transactions"
              placeholder="Search reference or intent ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Filter by status"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">All statuses</option>
            {['succeeded', 'processing', 'unknown', 'failed', 'canceled'].map((s) => (
              <option value={s} key={s}>
                {s === 'succeeded' ? 'Completed' : s === 'unknown' ? 'Needs review' : s}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Refresh transactions"
            onClick={() => void load()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Amount</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} onClick={() => onSelect(i)}>
                <td>
                  <button
                    className="transaction-title"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(i);
                    }}
                  >
                    <span className="transaction-icon">
                      <ArrowUpRight size={19} />
                    </span>
                    <span>
                      <b>{i.reference}</b>
                      <small>{short(i.id)}</small>
                    </span>
                  </button>
                </td>
                <td className="number">
                  {decimal(i.source.amount_minor, i.source.asset)}
                  <small>{i.source.asset}</small>
                </td>
                <td>
                  <span className="destination">
                    <AssetIcon asset={i.destination.asset} />
                    {i.destination.asset}
                  </span>
                </td>
                <td>
                  <Badge state={i.state} />
                </td>
                <td className="muted">{date(i.created_at)}</td>
                <td>
                  <ChevronRight size={16} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && (
        <Empty>{loading ? 'Loading transactions…' : 'No transactions match your filters.'}</Empty>
      )}
      {!compact && cursor && (
        <div className="table-footer">
          <button className="button subtle" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
function IntentDetail({
  api,
  intent,
  onClose,
  operations = false,
}: {
  api: Kora;
  intent: Intent;
  onClose: () => void;
  operations?: boolean;
}) {
  const data = useLoad<Intent | Model<'OperationDetail'>>(
    () => (operations ? api.getOperationDetail(intent.id) : api.getIntent(intent.id)),
    [api, intent.id, operations],
  );
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false);
  const detail = data.value && 'intent' in data.value ? data.value : undefined;
  const i = detail?.intent ?? (data.value && 'state' in data.value ? data.value : intent);
  const recover = async () => {
    setBusy(true);
    try {
      if (i.provider === 'paystack-test') await api.verifyLocalPayout(intent.id, uid());
      else await api.recoverIntent(intent.id, uid());
      setValue('Recovery queued. Checking provider status…');
      setTimeout(() => {
        data.refresh();
        setBusy(false);
      }, 1800);
    } catch (e) {
      setValue(message(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={operations ? 'Inspect payment' : 'Transaction details'} onClose={onClose}>
      {data.error && <Notice>{data.error}</Notice>}
      <div className="detail-summary">
        <Badge state={i.state} />
        <h1>
          {decimal(i.source.amount_minor, i.source.asset)} <small>{i.source.asset}</small>
        </h1>
        <p>{i.reference}</p>
        <div className="receipt-line">
          <code>{i.id}</code>
          <CopyButton value={i.id} />
        </div>
      </div>
      <div className="review-lines">
        <div>
          <span>Destination</span>
          <b>
            {decimal(i.destination.amount_minor, i.destination.asset)} {i.destination.asset}
          </b>
        </div>
        <div>
          <span>Fee</span>
          <b>
            {decimal(i.fee.amount_minor, i.fee.asset)} {i.fee.asset}
          </b>
        </div>
        <div>
          <span>Created</span>
          <b>{new Date(i.created_at).toLocaleString()}</b>
        </div>
        <div>
          <span>Compliance</span>
          <b>{i.compliance_state.replaceAll('_', ' ')}</b>
        </div>
      </div>
      {!operations && i.history && (
        <div className="timeline">
          {i.history.map((h, index) => (
            <div key={index}>
              <i />
              <span>
                <b>{h.state}</b>
                <small>{h.detail}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <>
          <div className="section-label">Provider evidence</div>
          <div className="evidence">
            <p>
              Hold <b>{detail.hold.state}</b> · {detail.hold.asset}{' '}
              {decimal(detail.hold.amount, detail.hold.asset)}
            </p>
            {detail.instructions.map((ins) => (
              <p key={ins.id}>
                <code>{short(ins.provider_ref)}</code> <Badge state={ins.state} />
              </p>
            ))}
            <p>
              {detail.attempts.length} attempts ·{' '}
              {detail.receipts.length + detail.rail_receipts.length} verified receipts
            </p>
            {detail.stellar_transactions.map((t) => (
              <div className="receipt-card" key={t.instruction_id}>
                <b>Stellar Testnet transaction</b>
                <p style={{ overflowWrap: 'anywhere' }}>
                  <code>{t.transaction_hash}</code>
                </p>
                <p>Sequence {t.sequence}</p>
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${t.transaction_hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Inspect transaction
                </a>
              </div>
            ))}
            {detail.rail_receipts.map((r) => (
              <p key={r.id}>
                <b>{r.kind.replaceAll('_', ' ')}</b> · verified provider receipt{' '}
                <code>{short(r.id)}</code>
              </p>
            ))}
          </div>
          <div className="section-label">Double-entry journals</div>
          {detail.journals.map((j) => (
            <div className="journal" key={j.id}>
              <b>{j.description}</b>
              <code>{j.reference}</code>
              {j.entries.map((e, index) => (
                <div key={index}>
                  <span>
                    {e.side} · {e.asset}
                  </span>
                  <b>{decimal(e.amount, e.asset)}</b>
                </div>
              ))}
            </div>
          ))}
          {(i.state === 'unknown' ||
            (i.provider === 'paystack-test' && i.state === 'succeeded')) && (
            <button className="button primary full" disabled={busy} onClick={recover}>
              <RefreshCw size={16} />
              {busy ? 'Checking status…' : 'Recover provider status'}
            </button>
          )}
          {value && (
            <p role="status" className="muted">
              {value}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
function Overview({
  api,
  onTransfer,
  onSelect,
  canTransfer,
}: {
  api: Kora;
  onTransfer: () => void;
  onSelect: (i: Intent) => void;
  canTransfer: boolean;
}) {
  const [days, setDays] = useState(7);
  const stats = useLoad(() => api.getOverview(days), [api, days]);
  const balances = useLoad(() => api.listBalances(), [api]);
  const s = stats.value;
  const max = s ? Math.max(1, ...s.chart.map((p) => Number(p.minor_usd))) : 1;
  return (
    <>
      {stats.error && <Notice>{stats.error}</Notice>}
      <div className="welcome">
        <div>
          <span className="eyebrow">YOUR NETWORK, AT A GLANCE</span>
          <h1>Let your money move.</h1>
          <p>One workspace. Every connection.</p>
        </div>
        <button className="button primary" disabled={!canTransfer} onClick={onTransfer}>
          <Plus size={18} />
          New transfer
        </button>
      </div>
      <div className="metrics">
        <div className="metric">
          <span>
            Available balance <Wallet size={16} />
          </span>
          <h2>{s ? '$' + decimal(s.available_minor_usd, 'NGN') : '—'}</h2>
          <p>USD equivalent · sandbox rates</p>
        </div>
        <div className="metric">
          <span>
            Total payment volume <ArrowUpRight size={16} />
          </span>
          <h2>{s ? '$' + decimal(s.volume_minor_usd, 'NGN') : '—'}</h2>
          <p>{s?.completed ?? '—'} completed transactions</p>
        </div>
        <div className="metric">
          <span>
            Reserved funds <Clock size={16} />
          </span>
          <h2>{s ? '$' + decimal(s.reserved_minor_usd, 'NGN') : '—'}</h2>
          <p>{s?.open_reconciliation ?? '—'} items awaiting reconciliation</p>
        </div>
      </div>
      <div className="overview-grid">
        <section className="card chart-card">
          <div className="card-heading">
            <div>
              <h3>Payment activity</h3>
              <p>Settled source volume · USD equivalent</p>
            </div>
            <select
              aria-label="Chart range"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="7">Last 7 days</option>
              <option value="28">Last 28 days</option>
            </select>
          </div>
          <div className="chart">
            <div className="chart-grid">
              <span>${decimal(Math.round(max).toString(), 'NGN')}</span>
              <span>${decimal(Math.round(max / 2).toString(), 'NGN')}</span>
              <span>$0</span>
            </div>
            <div className="bars">
              {s?.chart.map((p) => (
                <div className="bar-slot" key={p.date}>
                  <div
                    className="bar"
                    title={`${p.date}: $${decimal(p.minor_usd, 'NGN')}`}
                    style={{ height: `${(Number(p.minor_usd) / max) * 100}%` }}
                  />
                  <small>
                    {new Date(p.date + 'T12:00:00Z').toLocaleDateString('en', { weekday: 'short' })}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <div className="chart-caption">
            <span className="chart-dot" />
            Actual sandbox activity · dates in UTC
          </div>
        </section>
        <section className="network-card">
          <div>
            <span className="eyebrow">BORDERLESS BY DESIGN</span>
            <h3>
              A continent.
              <br />
              Connected.
            </h3>
            <p>
              3 local currencies.
              <br />
              One simulated network.
            </p>
          </div>
          <Network compact />
          <div className="network-card-bottom">
            <span>
              <i /> Sandbox network
            </span>
            <Globe2 size={18} />
          </div>
        </section>
      </div>
      <section className="balances-strip">
        {codes.map((code) => {
          const amount =
            balances.value?.data.find((b) => b.asset === code && b.purpose === 'available')
              ?.minor ?? '0';
          return (
            <div key={code}>
              <AssetIcon asset={code} />
              <span>
                <small>{code} balance</small>
                <b>{balances.value ? decimal(amount, code) : '—'}</b>
              </span>
              <ArrowUpRight size={16} />
            </div>
          );
        })}
      </section>
      <Transactions api={api} compact onSelect={onSelect} />
    </>
  );
}
function BusinessOverview({ api, go }: { api: Kora; go: (path: string) => void }) {
  const balances = useLoad(() => api.listBalances(), [api]);
  const ngnAvailable = balances.value?.data.find((b) => b.asset === 'NGN' && b.purpose === 'available')?.minor ?? '0';
  const ngnHeld = balances.value?.data.find((b) => b.asset === 'NGN' && b.purpose === 'reserved')?.minor ?? '0';
  return <>
    <div className="welcome"><div><span className="eyebrow">MICROSENDR BUSINESS · SANDBOX</span><h1>Your business, in one place.</h1></div></div>
    {balances.error && <Notice>{balances.error}</Notice>}
    <section className="business-balance-card"><span>AVAILABLE · SIMULATED NGN</span><strong>₦{decimal(ngnAvailable,'NGN')}</strong><small>Test funds only</small></section>
    <div className="business-overview-grid">
      <section className="card"><span className="eyebrow">BALANCES</span><h2>Available and reserved</h2><b>Reserved: ₦{decimal(ngnHeld,'NGN')}</b><button className="button subtle" onClick={()=>go('/app/assets')}>View balances <ArrowRight size={16}/></button></section>
      <section className="card"><span className="eyebrow">PAYMENTS</span><h2>Settlement activity</h2><button className="button subtle" onClick={()=>go('/app/transactions')}>View payments <ArrowRight size={16}/></button></section>
      <section className="card"><span className="eyebrow">DEVELOPERS</span><h2>API and webhooks</h2><button className="button subtle" onClick={()=>go('/app/developers')}>Open developers <ArrowRight size={16}/></button></section>
    </div>
  </>;
}
function BusinessBalances({ api }: { api: Kora }) {
  const balances=useLoad(()=>api.listBalances(),[api]);
  const available=balances.value?.data.find(b=>b.asset==='NGN'&&b.purpose==='available')?.minor??'0';
  const reserved=balances.value?.data.find(b=>b.asset==='NGN'&&b.purpose==='reserved')?.minor??'0';
  return <><div className="page-heading"><div><span className="eyebrow">BUSINESS ACCOUNT</span><h1>Balances</h1></div></div>{balances.error&&<Notice>{balances.error}</Notice>}<section className="card business-position"><div><span>Asset</span><b>NGN · Nigerian naira</b></div><div><span>Network</span><b>Fiat Nigeria · simulated</b></div><div><span>Available</span><b>₦{decimal(available,'NGN')}</b></div><div><span>Reserved</span><b>₦{decimal(reserved,'NGN')}</b></div></section></>;
}
function AssetsPage({ api }: { api: Kora }) {
  const data = useLoad(() => Promise.all([api.listAssets(), api.listBalances()]), [api]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Assets & balances</h1>
          <p>Your ledger balances, with every asset accounted for.</p>
        </div>
      </div>
      {data.error && <Notice>{data.error}</Notice>}
      <div className="asset-grid">
        {data.value?.[0].data.map((a) => (
          <section className="card asset-card" key={a.id}>
            <div className="card-heading">
              <AssetIcon asset={a.id} />
              <span className="badge sandbox">
                {a.kind === 'stellar' ? 'Stellar sandbox' : 'Local currency'}
              </span>
            </div>
            <h3>{a.name}</h3>
            <span className="muted">
              {a.code} · {a.country}
            </span>
            <div className="asset-balance">
              {decimal(
                data.value?.[1].data.find((b) => b.asset === a.id && b.purpose === 'available')
                  ?.minor ?? '0',
                a.id,
              )}{' '}
              <small>{a.code}</small>
            </div>
            <div className="review-lines">
              <div>
                <span>Reserved</span>
                <b>
                  {decimal(
                    data.value?.[1].data.find((b) => b.asset === a.id && b.purpose === 'reserved')
                      ?.minor ?? '0',
                    a.id,
                  )}
                </b>
              </div>
              <div>
                <span>Precision</span>
                <b>{a.scale} decimals</b>
              </div>
              <div>
                <span>Rail</span>
                <b>{a.rail}</b>
              </div>
              {a.issuer && (
                <div>
                  <span>Issuer</span>
                  <code>{a.issuer}</code>
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
async function readAll<T>(
  api: Kora,
  list: (query: Record<string, string>) => Promise<{ data: T[]; next_cursor: string | null }>,
) {
  const data: T[] = [];
  for await (const item of api.paginate(list, { limit: '100' })) data.push(item);
  return { data, has_more: false, next_cursor: null };
}
function CustomersPage({ api }: { api: Kora }) {
  const data = useLoad(() => readAll(api, api.listCustomers), [api]);
  const [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Model<'Customer'>>();
  const add = async () => {
    setBusy(true);
    try {
      await api.createCustomer({ name }, uid());
      setName('');
      setError('');
      data.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Customers</h1>
          <p>Recipients and their verified sandbox instruments.</p>
        </div>
      </div>
      <section className="card customer-create">
        <label>
          Customer name
          <input
            placeholder="Business or recipient name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="button primary" disabled={busy || !name.trim()} onClick={add}>
          <Plus size={17} />
          Add customer
        </button>
      </section>
      {(error || data.error) && <Notice>{error || data.error}</Notice>}
      <section className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Verification</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.value?.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="transaction-title" onClick={() => setSelected(c)}>
                      <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
                      <span>
                        <b>{c.name}</b>
                        <small>{short(c.id)}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <Badge state={c.verification_state} />
                  </td>
                  <td>{date(c.created_at)}</td>
                  <td>
                    <button className="button subtle" onClick={() => setSelected(c)}>
                      Instruments <ChevronRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.value && !data.value.data.length && <Empty>Add your first sandbox recipient.</Empty>}
      </section>
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(undefined)}>
          <CustomerInstruments api={api} customer={selected} />
        </Modal>
      )}
    </>
  );
}
function CustomerInstruments({ api, customer }: { api: Kora; customer: Model<'Customer'> }) {
  const data = useLoad(
    () => readAll(api, (query) => api.listInstruments(customer.id, query)),
    [api, customer.id],
  );
  const [asset, setAsset] = useState<(typeof codes)[number]>('NGN'),
    [label, setLabel] = useState(''),
    [error, setError] = useState('');
  return (
    <>
      {data.value?.data.map((i) => (
        <div className="instrument" key={i.id}>
          <AssetIcon asset={i.asset} />
          <div>
            <b>{i.label}</b>
            <small>
              {i.type.replaceAll('_', ' ')} · {i.sandbox_identifier}
            </small>
          </div>
          <ShieldCheck size={18} />
        </div>
      ))}
      {data.value && !data.value.data.length && <Empty>No instruments yet.</Empty>}
      <div className="section-label">Add sandbox instrument</div>
      <label>
        Asset
        <select value={asset} onChange={(e) => setAsset(e.target.value as typeof asset)}>
          {codes.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <label>
        Instrument label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Recipient's sandbox account"
        />
      </label>
      {error && <Notice>{error}</Notice>}
      <button
        className="button primary full"
        disabled={!label.trim()}
        onClick={async () => {
          try {
            await api.createInstrument(
              customer.id,
              {
                asset,
                label,
                type:
                  asset === 'USDC'
                    ? 'stellar_account'
                    : asset === 'KES'
                      ? 'mobile_money'
                      : 'bank_account',
                sandbox_identifier: `sandbox:${uid()}`,
              },
              uid(),
            );
            setLabel('');
            data.refresh();
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        Add instrument <Plus size={17} />
      </button>
    </>
  );
}
function DevelopersPage({ api, session, go }: { api: Kora; session: Session; go: (path: string) => void }) {
  const [tab, setTab] = useState('keys'),
    [secret, setSecret] = useState(''),
    [error, setError] = useState(''),
    [name, setName] = useState(''),
    [url, setUrl] = useState('http://127.0.0.1:4311/webhook'),
    [scopes, setScopes] = useState<string[]>(['payments:read']);
  const keys = useLoad(
    () =>
      session.scopes?.includes('keys:read')
        ? readAll(api, api.listApiKeys)
        : Promise.resolve({ data: [], has_more: false, next_cursor: null }),
    [api, session],
  );
  const hooks = useLoad(() => api.listWebhookEndpoints(), [api]);
  const logs = useLoad(
    () =>
      session.scopes?.includes('keys:read') ? api.listRequestLogs() : Promise.resolve({ data: [] }),
    [api, session],
  );
  const events = useLoad(() => api.listEvents(), [api]);
  const deliveries = useLoad(() => api.listWebhookDeliveries(), [api]);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      keys.refresh();
      hooks.refresh();
      events.refresh();
      deliveries.refresh();
      logs.refresh();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Developer workspace</h1>
          <p>Build once. Move money across the network.</p>
        </div>
        <a className="button subtle" href="/docs">
          <BookOpen size={16} />
          API documentation <ExternalLink size={14} />
        </a>
      </div>
      <div className="developer-banner">
        <Code2 size={32} />
        <div>
          <h3>Your next integration starts here.</h3>
          <p>Typed SDK. Idempotent requests. Signed events.</p>
        </div>
        <a href="/openapi.json" download="kora-openapi.json" className="button">
          Download OpenAPI <Download size={16} />
        </a>
      </div>
      <section className="card developer-sandbox-tools">
        <div className="card-heading"><h3>Developer Sandbox</h3><span className="badge sandbox">Simulated</span></div>
        <p className="muted">Inspect route, rail and testnet fixtures separately from the Business account.</p>
        <div className="developer-tool-links">
          {([['network','Route simulator'],['rail','NGN local rail'],['stellar','Stellar Testnet'],['operations','Operations'],['controls','Pilot controls']] as const)
            .filter(([id]) => !['operations','controls'].includes(id) || session.scopes?.includes('operations:read'))
            .map(([id,label]) => <button className="button subtle" key={id} onClick={() => go('/app/'+id)}>{label} <ArrowUpRight size={14}/></button>)}
        </div>
      </section>
      <div className="tabs">
        {[
          ['keys', 'API keys'],
          ['webhooks', 'Webhooks'],
          ['events', 'Events & deliveries'],
          ['logs', 'Request logs'],
        ].map(([id, title]) => (
          <button
            className={tab === id ? 'active' : ''}
            key={id}
            onClick={() => {
              setTab(id);
              setSecret('');
              setError('');
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {error && <Notice>{error}</Notice>}
      {secret && (
        <div className="secret-panel">
          <b>Save your secret now</b>
          <p>Keep it in your server environment. It is omitted from list responses.</p>
          <div className="receipt-line">
            <code>{secret}</code>
            <CopyButton value={secret} />
          </div>
          <button className="button subtle" onClick={() => setSecret('')}>
            I’ve saved it
          </button>
        </div>
      )}
      {tab === 'keys' && (
        <>
          <section className="card key-create">
            <h3>Create an API key</h3>
            <label>
              Key name
              <input
                placeholder="e.g. Test integration"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="scope-grid">
              {session.scopes?.map((scope) => (
                <label className="checkbox" key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((old) =>
                        e.target.checked ? [...old, scope] : old.filter((s) => s !== scope),
                      )
                    }
                  />
                  {scope}
                </label>
              ))}
            </div>
            <button
              className="button primary"
              disabled={!name.trim() || !scopes.length || !session.scopes?.includes('keys:write')}
              onClick={() =>
                void run(async () => {
                  const result = await api.createApiKey(
                    { name, scopes: scopes as Parameters<Kora['createApiKey']>[0]['scopes'] },
                    uid(),
                  );
                  setSecret(result.secret);
                  setName('');
                })
              }
            >
              <Plus size={16} />
              Create key
            </button>
          </section>
          <section className="card">
            <div className="card-heading">
              <h3>API keys</h3>
              <span className="muted small">Secrets are stored as hashes</span>
            </div>
            {keys.error && <Notice>{keys.error}</Notice>}
            {keys.value?.data.map((k) => (
              <div className="key-row" key={k.id}>
                <span className="key-icon">
                  <Code2 size={20} />
                </span>
                <div>
                  <b>
                    {k.name}
                    {k.id === session.key_id && <small> · Current session</small>}
                  </b>
                  <code>{k.prefix}…</code>
                  <small>{k.scopes.join(' · ')}</small>
                </div>
                <Badge state={k.revoked_at ? 'revoked' : 'active'} />
                <button
                  className="button subtle"
                  disabled={
                    !!k.revoked_at ||
                    k.id === session.key_id ||
                    !session.scopes?.includes('keys:write')
                  }
                  onClick={() => void run(() => api.revokeApiKey(k.id, uid()))}
                >
                  Revoke
                </button>
              </div>
            ))}
          </section>
        </>
      )}
      {tab === 'webhooks' && (
        <>
          <section className="card key-create">
            <h3>Register a signed endpoint</h3>
            <p className="muted">
              The origin must be in the server’s webhook allowlist. Start a local receiver with{' '}
              <code>pnpm webhook:receiver</code>.
            </p>
            <label>
              Endpoint URL
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <button
              className="button primary"
              disabled={!session.scopes?.includes('webhooks:write')}
              onClick={() =>
                void run(async () => {
                  const result = await api.createWebhookEndpoint(url, uid());
                  setSecret(result.secret ?? '');
                })
              }
            >
              <Plus size={16} />
              Add endpoint
            </button>
          </section>
          <section className="card">
            {hooks.error && <Notice>{hooks.error}</Notice>}
            {hooks.value?.data.map((h) => (
              <div className="key-row" key={h.id}>
                <Globe2 size={22} />
                <div>
                  <b>{h.url}</b>
                  <code>{short(h.id)}</code>
                </div>
                <Badge state={h.active ? 'active' : 'disabled'} />
                <button
                  className="button subtle"
                  disabled={!h.active || !session.scopes?.includes('webhooks:write')}
                  onClick={() => void run(() => api.disableWebhookEndpoint(h.id, uid()))}
                >
                  Disable
                </button>
              </div>
            ))}
            {hooks.value && !hooks.value.data.length && (
              <Empty>No webhook endpoints registered.</Empty>
            )}
          </section>
        </>
      )}
      {tab === 'events' && (
        <>
          <section className="card">
            <div className="card-heading">
              <h3>Event stream</h3>
              <button
                className="icon-button"
                aria-label="Refresh events"
                onClick={() => {
                  events.refresh();
                  deliveries.refresh();
                }}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {events.error && <Notice>{events.error}</Notice>}
            {events.value?.data.map((e) => (
              <div className="key-row" key={e.id}>
                <Activity size={18} />
                <div>
                  <b>{e.type}</b>
                  <code>{short(e.id)}</code>
                  <small>{e.intent_id ? short(e.intent_id) : ''}</small>
                </div>
                <button
                  className="button subtle"
                  disabled={!session.scopes?.includes('webhooks:write')}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.replayEvent(e.id, uid());
                      setError(`Replay queued for ${result.queued} active endpoint(s).`);
                    })
                  }
                >
                  Replay <RefreshCw size={14} />
                </button>
              </div>
            ))}
          </section>
          <section className="card">
            <div className="card-heading">
              <h3>Delivery attempts</h3>
            </div>
            {deliveries.value?.data.map((d) => (
              <div className="key-row" key={d.id}>
                <div>
                  <code>{short(d.event_id)}</code>
                  <small>
                    {d.attempts} attempts · HTTP {d.status_code ?? '—'} ·{' '}
                    {d.last_error ?? 'No error'}
                  </small>
                </div>
                <Badge state={d.state} />
              </div>
            ))}
            {deliveries.value && !deliveries.value.data.length && (
              <Empty>Register a webhook and replay an event to inspect delivery.</Empty>
            )}
          </section>
        </>
      )}
      {tab === 'logs' && (
        <section className="card">
          <div className="card-heading">
            <div>
              <h3>API request logs</h3>
              <p>Metadata only. Credentials, payloads and query values are omitted.</p>
            </div>
            <button className="icon-button" aria-label="Refresh logs" onClick={logs.refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
          {logs.error && <Notice>{logs.error}</Notice>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Route</th>
                  <th>Status</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {logs.value?.data.map((l) => (
                  <tr key={l.request_id}>
                    <td>
                      <code>{short(l.request_id)}</code>
                    </td>
                    <td>
                      <b>{l.method}</b> <code>{l.path}</code>
                    </td>
                    <td>
                      <span className={`http-status ${l.status_code >= 400 ? 'bad' : ''}`}>
                        {l.status_code}
                      </span>
                    </td>
                    <td>{l.duration_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
function OperationsPage({ api, onSelect }: { api: Kora; onSelect: (i: Intent) => void }) {
  const data = useLoad(() => api.listReconciliation(), [api]);
  const intents = useLoad(() => api.listIntents({ limit: '100', state: 'unknown' }), [api]);
  const [lookup, setLookup] = useState(''),
    [lookupError, setLookupError] = useState(''),
    [looking, setLooking] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Operations</h1>
          <p>Trace every instruction. Resolve every unknown.</p>
        </div>
        <button
          className="button subtle"
          onClick={() => {
            data.refresh();
            intents.refresh();
          }}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      <section className="card rail-form">
        <h3>Inspect a payment</h3>
        <p>Open any owned intent to view its provider evidence and journals.</p>
        <label>
          Payment intent ID
          <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="int_…" />
        </label>
        <button
          className="button secondary"
          disabled={looking || !lookup}
          onClick={async () => {
            setLooking(true);
            setLookupError('');
            try {
              onSelect((await api.getOperationDetail(lookup)).intent);
            } catch (e) {
              setLookupError((e as Error).message);
            } finally {
              setLooking(false);
            }
          }}
        >
          Inspect payment
        </button>
        {lookupError && <Notice>{lookupError}</Notice>}
      </section>
      <div className="operations-note">
        <ShieldCheck size={25} />
        <div>
          <b>Evidence before settlement</b>
          <p>
            Ambiguous acknowledgements keep funds reserved. Recovery queries the durable provider
            status before capturing or releasing a hold.
          </p>
        </div>
      </div>
      {(data.error || intents.error) && <Notice>{data.error || intents.error}</Notice>}
      <section className="card">
        <div className="card-heading">
          <h3>Reconciliation queue</h3>
          <span className="badge unknown">
            {data.value?.data.filter((r) => r.state === 'open').length ?? 0} open
          </span>
        </div>
        {data.value?.data.map((r) => (
          <div className="key-row" key={r.id}>
            <AlertCircle size={20} />
            <div>
              <b>{r.reference}</b>
              <small>
                {r.reason.replaceAll('_', ' ')} · {date(r.created_at)}
              </small>
              <code>{short(r.intent_id)}</code>
            </div>
            <Badge state={r.state} />
            <button
              className="button subtle"
              onClick={async () => onSelect(await api.getIntent(r.intent_id))}
            >
              Inspect <ArrowUpRight size={15} />
            </button>
          </div>
        ))}
        {data.value && !data.value.data.length && (
          <Empty>Your reconciliation queue is clear.</Empty>
        )}
      </section>
      <section className="card">
        <div className="card-heading">
          <h3>Ambiguous intents</h3>
        </div>
        {intents.value?.data.map((i) => (
          <div className="key-row" key={i.id}>
            <Clock size={20} />
            <div>
              <b>{i.reference}</b>
              <small>
                {decimal(i.source.amount_minor, i.source.asset)} {i.source.asset} →{' '}
                {i.destination.asset}
              </small>
            </div>
            <Badge state={i.state} />
            <button className="button subtle" onClick={() => onSelect(i)}>
              Inspect <ChevronRight size={16} />
            </button>
          </div>
        ))}
        {intents.value && !intents.value.data.length && <Empty>No ambiguous intents.</Empty>}
      </section>
    </>
  );
}
function Docs() {
  const data = useLoad(async () => {
    const r = await fetch('/openapi.json');
    if (!r.ok) throw new Error('Contract could not be loaded');
    return (await r.json()) as {
      paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
    };
  });
  const code = `import { Kora } from '@kora/sdk';\n\nconst kora = new Kora({\n  baseUrl: 'http://127.0.0.1:4310',\n  apiKey: process.env.KORA_API_KEY\n});\n\nconst quote = await kora.createQuote({\n  source_asset: 'NGN',\n  destination_asset: 'KES',\n  amount_minor: '1600000'\n}, crypto.randomUUID());`;
  return (
    <div className="docs">
      <span className="eyebrow">DEVELOPER DOCUMENTATION</span>
      <h1>One API. A connected continent.</h1>
      <p className="lead">
        Create customers, get an exact quote, submit a payment intent, and receive a signed
        settlement event.
      </p>
      <div className="docs-actions">
        <a className="button primary" href="/reference">
          Interactive API reference <ExternalLink size={16} />
        </a>
        <a className="button subtle" href="/openapi.json" download="kora-openapi.json">
          OpenAPI contract <Download size={16} />
        </a>
      </div>
      <div className="docs-grid">
        <section>
          <h2>Start in the sandbox</h2>
          <p>
            Use a key from Developer workspace or <code>pnpm sandbox:create</code>. All amounts are
            integer strings in the asset’s smallest unit: NGN, KES and GHS use 2 decimals; USDC uses
            6.
          </p>
          <h3>1. Create a recipient</h3>
          <p>
            Create a customer and destination instrument. Identifiers begin with{' '}
            <code>sandbox:</code>. Identity and bank verification are simulated.
          </p>
          <h3>2. Quote and submit</h3>
          <p>
            Create a quote, then an intent with the quote, customer and instrument IDs. Quotes
            expire after five minutes. The source amount includes the fee; conversion uses source
            minus fee.
          </p>
          <h3>3. Track the result</h3>
          <p>
            Poll the intent or receive <code>intent.succeeded</code> and <code>intent.failed</code>{' '}
            events. An <code>unknown</code> state keeps funds reserved while provider status is
            recovered.
          </p>
          <h3>Retry safely</h3>
          <p>
            Every mutation requires an <code>Idempotency-Key</code>. Reuse the same key and body
            after a network error. Changing the body returns a conflict. The SDK does not
            automatically retry mutations.
          </p>
          <h3>Verify signed webhooks</h3>
          <p>
            Read the raw body and verify <code>kora-signature</code> with <code>verifyWebhook</code>{' '}
            from <code>@kora/sdk/webhooks</code>. Deduplicate by event ID; replay retains the same
            ID.
          </p>
        </section>
        <aside>
          <div className="code-card">
            <div>
              <span>TypeScript · @kora/sdk</span>
              <CopyButton value={code} />
            </div>
            <pre>{code}</pre>
          </div>
          <div className="docs-note">
            <ShieldCheck size={20} />
            <p>
              API keys belong on your server. The console uses HttpOnly cookie sessions and CSRF
              protection.
            </p>
          </div>
        </aside>
      </div>
      <h2>API endpoints</h2>
      {data.error && <Notice>{data.error}</Notice>}
      <section className="card endpoint-list">
        {data.value &&
          Object.entries(data.value.paths).flatMap(([path, methods]) =>
            Object.entries(methods)
              .filter(([method]) => ['get', 'post'].includes(method))
              .map(([method, op]) => (
                <div key={method + path}>
                  <span className={`method ${method}`}>{method.toUpperCase()}</span>
                  <code>{path}</code>
                  <span>{op.summary}</span>
                </div>
              )),
          )}
      </section>
    </div>
  );
}
const nav = [
  ['overview', 'Overview', LayoutDashboard],
  ['transactions', 'Payments', ArrowLeftRight],
  ['assets', 'Balances', Wallet],
  ['developers', 'Developers', Code2],
  ['account', 'Settings', ShieldCheck],
] as const;
function BusinessVerification({ session, onApproved }: { session: Session; onApproved: () => void }) {
  const [account,setAccount]=useState<{ kyb_required:boolean; kyb_state:string }>();
  const [error,setError]=useState('');
  const refresh=()=>fetch('/business/api/account',{credentials:'include'}).then(r=>r.json()).then(setAccount).catch(()=>setError('Business verification status is unavailable.'));
  useEffect(()=>{if(session.auth_method==='email'||session.auth_method==='privy')void refresh();},[session.auth_method]);
  if(!account?.kyb_required) return null;
  return <section className="card business-verification"><span className="eyebrow">BUSINESS VERIFICATION</span><h2>{account.kyb_state==='sandbox_approved'?'Sandbox ready':'Enable Business sandbox'}</h2><p>{account.kyb_state==='sandbox_approved'?'Simulated activity is enabled. Real activity requires KYB.':'Activate the test KYB fixture to use simulated funds. This is not real verification.'}</p>{error&&<Notice>{error}</Notice>}{account.kyb_state!=='sandbox_approved'&&<button className="button primary" onClick={()=>void fetch('/business/api/sandbox/verify',{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-kora-csrf':session.csrf_token??''},body:JSON.stringify({acknowledge_simulation:true})}).then(async r=>{if(!r.ok)throw new Error((await r.json()).error?.message??'Verification failed');onApproved();}).catch(e=>setError(e.message))}>Enable sandbox <ArrowRight size={15}/></button>}</section>;
}
function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('microsendr-theme') === 'dark' ? 'dark' : 'light',
  );
  const themeToggle = <button className="theme-toggle" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'Dark'} theme</button>;
  const [path, go] = usePath(),
    [session, setSession] = useState<Session>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [workspaceName, setWorkspaceName] = useState('My sandbox workspace'),
    [menu, setMenu] = useState(false),
    [transfer, setTransfer] = useState(false),
    [selected, setSelected] = useState<Intent>(),
    [version, setVersion] = useState(0);
  const [personalAuthenticated, setPersonalAuthenticated] = useState(false);
  useEffect(() => {
    const signedInApp = path.startsWith('/app') && !!session?.authenticated && (session.auth_method === 'email' || session.auth_method === 'privy');
    document.documentElement.dataset.theme = signedInApp || (path.startsWith('/personal') && personalAuthenticated) ? theme : 'light';
    localStorage.setItem('microsendr-theme', theme);
  }, [theme, path, session?.authenticated, session?.auth_method, personalAuthenticated]);
  const api = useMemo(() => new Kora({ csrfToken: session?.csrf_token }), [session?.csrf_token]);
  const merchant = useLoad(
    () => (session?.authenticated ? api.getMerchant() : Promise.resolve(undefined)),
    [api, session?.authenticated],
  );
  useEffect(() => {
    fetch('/console/session', { credentials: 'include' })
      .then((r) => r.json())
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, []);
  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/console/workspaces', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(session?.csrf_token ? { 'x-kora-csrf': session.csrf_token } : {}),
        },
        body: JSON.stringify({ name: workspaceName }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error?.message ?? 'Unable to connect');
      setSession(result);
      go('/app/overview');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    const response = await fetch('/console/logout', {
      method: 'POST',
      headers: { 'x-kora-csrf': session?.csrf_token ?? '' },
    });
    if (!response.ok) {
      setError('Sign out failed. Refresh your session and try again.');
      return;
    }
    setSession({ authenticated: false });
    go('/login');
  };
  const done = () => {
    setTransfer(false);
    setVersion((n) => n + 1);
    go('/app/transactions');
  };
  const tab = path.split('/')[2] ?? 'overview';
  const can = (scope: string) => session?.scopes?.includes(scope);
  const topNav = (
    <header className="public-header">
      <button className="logo-button" onClick={() => go('/')}>
        <Logo />
      </button>
      <nav>
        {path === '/' && (
          <>
            <a href="#platform">Platform</a>
            <a href="#how-it-works">How it works</a>
          </>
        )}
        <button onClick={() => go('/personal/login')}>Personal</button>
      </nav>
      {!session?.authenticated && (
        <button className="public-login text-button" onClick={() => go('/personal/login')}>
          Sign in
        </button>
      )}
      <button
        className="button primary"
        onClick={() => go('/personal/login')}
      >
        Get started
        <ArrowRight size={16} />
      </button>
    </header>
  );
  if (path === '/docs')
    return (
      <>
        {topNav}
        <Docs />
        <footer className="public-footer">
          <Logo />
          <span>African financial interoperability · Sandbox</span>
        </footer>
      </>
    );
  if (path.startsWith('/personal'))
    return <PersonalPage go={go} path={path} brand={<Logo />} themeToggle={themeToggle} onAuthChange={setPersonalAuthenticated} />;
  if (path === '/business/login' || path === '/login' || path === '/login/save')
    return <BusinessLogin brand={<Logo />} go={go} session={session} saveWorkspace={path === '/login/save'} onSession={setSession} />;
  if (path === '/business')
    return <BusinessPage header={topNav} brand={<Logo />} go={go} />;
  if (path === '/')
    return (
      <LandingPage
        header={topNav}
        brand={<Logo />}
        go={go}
        authenticated={!!session?.authenticated}
      />
    );
  if (!session)
    return (
      <div className="loading-page">
        <Logo />
        <p>Connecting to your workspace…</p>
      </div>
    );
  if (!session.authenticated && path.startsWith('/app'))
    return <BusinessLogin brand={<Logo />} go={go} session={session} onSession={setSession} />;
  if (!session.authenticated || path === '/connect')
    return (
      <>
        {topNav}
        <main className="connect-page">
          <div>
            <span className="eyebrow">YOUR NEXT CONNECTION</span>
            <h1>Meet your workspace.</h1>
            <p>
              Start with an isolated, prefunded sandbox and try real payment-engine workflows with
              simulated money.
            </p>
            <Network />
          </div>
          <section className="card connect-card">
            <span className="badge sandbox">
              <i />
              Sandbox access
            </span>
            <h2>Make your first move.</h2>
            {error && <Notice>{error}</Notice>}
            <label>
              Workspace name
              <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
            </label>
            <button
              className="button primary full"
              disabled={busy || !workspaceName.trim()}
              onClick={() => void connect()}
            >
              {busy ? 'Creating workspace…' : 'Start sandbox'}
              <ArrowRight size={17} />
            </button>
            <p className="muted small">
              <ShieldCheck size={14} />
              This guest sandbox uses simulated funds. Save it to your email to return later.
            </p>
            <div className="login-footer">
              <span>Have a saved workspace?</span>
              <button className="text-button" onClick={() => go('/login')}>
                Sign in <ArrowRight size={14} />
              </button>
            </div>
          </section>
        </main>
      </>
    );
  if (path === '/ramp')
    return (
      <div className="hosted-page">
        <header>
          <Logo />
          <button className="button subtle" onClick={() => go('/app/overview')}>
            Back to workspace <ArrowUpRight size={16} />
          </button>
        </header>
        <main>
          <div>
            <span className="eyebrow">HOSTED SANDBOX FLOW</span>
            <h1>
              A simpler way
              <br />
              to move value.
            </h1>
            <p>
              Convert between local currency and simulated USDC using your prefunded workspace
              balance.
            </p>
            <span className="badge sandbox">
              <i />
              No real funds
            </span>
            <Network />
          </div>
          <section className="card hosted-card">
            <div className="card-heading">
              <h3>Convert & send</h3>
              <span className="badge sandbox">Sandbox</span>
            </div>
            <TransferFlow api={api} hosted onDone={done} />
          </section>
        </main>
        <footer>Powered by Microsendr · Simulated settlement</footer>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <button className="logo-button" onClick={() => go('/app/overview')}>
          <Logo />
        </button>
        <button
          className="workspace-switch"
          onClick={() => go('/app/account')}
          aria-label="Workspace and access settings"
        >
          <span className="workspace-icon">{merchant.value?.name.slice(0, 1) ?? 'K'}</span>
          <div>
            <b>{merchant.value?.name ?? 'Workspace'}</b>
            <small>{session.auth_method === 'email' || session.auth_method === 'privy' ? 'Business account · Sandbox' : 'Developer Sandbox'}</small>
          </div>
          <ChevronDown size={15} />
        </button>
        <span className="sidebar-label">BUSINESS</span>
        <nav>
          {nav
            .filter(([id]) => id !== 'developers' || can('keys:read'))
            .map(([id, label, Icon]) => (
              <button
                key={id}
                className={tab === id ? 'active' : ''}
                onClick={() => {
                  go('/app/' + id);
                  setMenu(false);
                }}
              >
                <Icon size={18} />
                {label}
                {id === 'developers' && <span className="nav-code">&lt;/&gt;</span>}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sandbox-card">
            <span>
              <i />
              Sandbox mode
            </span>
            <p>
              Explore freely.
              <br />
              Test funds and eligible routes.
            </p>
            {can('payments:write') && (
              <button onClick={() => go('/ramp')}>
                Try hosted flow <ArrowUpRight size={15} />
              </button>
            )}
          </div>
          <button className="sidebar-docs" onClick={() => go('/docs')}>
            <BookOpen size={17} />
            Documentation <ArrowUpRight size={14} />
          </button>
          <button className="sidebar-docs" onClick={() => void logout()}>
            <LogOut size={17} />
            Sign out
          </button>
          <div className="sidebar-version">
            Microsendr <span>v0.8 · Sandbox</span>
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="app-main">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb">
              {session.auth_method === 'email' || session.auth_method === 'privy' ? 'Business' : 'Developer Sandbox'} <ChevronRight size={14} />
              <b>{nav.find((n) => n[0] === tab)?.[1] ?? 'Overview'}</b>
            </span>
          </div>
          <div>
            {(session.auth_method === 'email' || session.auth_method === 'privy') && themeToggle}
            <span className="sandbox-top">
              <i />
              Sandbox
            </span>
            <span className="top-divider" />
            <span className="avatar">{merchant.value?.name.slice(0, 2).toUpperCase() ?? 'MS'}</span>
          </div>
        </header>
        <main className="content" key={version}>
          {tab === 'overview' && <BusinessVerification session={session} onApproved={() => setVersion((n) => n + 1)} />}
          {tab === 'overview' ? (
            session.auth_method === 'email' || session.auth_method === 'privy' ? <BusinessOverview api={api} go={go} /> : <Overview
              api={api}
              onTransfer={() => setTransfer(true)}
              onSelect={setSelected}
              canTransfer={!!can('payments:write')}
            />
          ) : tab === 'transactions' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>Transactions</h1>
                  <p>Follow every movement, from start to settlement.</p>
                </div>
                <button
                  className="button primary"
                  disabled={!can('payments:write')}
                  onClick={() => setTransfer(true)}
                >
                  <Plus size={17} />
                  New transfer
                </button>
              </div>
              <Transactions api={api} onSelect={setSelected} />
            </>
          ) : tab === 'stellar' ? (
            <StellarPage api={api} onSelect={setSelected} can={(scope) => !!can(scope)} />
          ) : tab === 'rail' ? (
            <LocalRailPage api={api} onSelect={setSelected} can={(scope) => !!can(scope)} />
          ) : tab === 'network' ? (
            <NetworkPage api={api} can={(scope) => !!can(scope)} onSelect={setSelected} />
          ) : tab === 'assets' ? (
            session.auth_method === 'email' || session.auth_method === 'privy' ? <BusinessBalances api={api} /> : <AssetsPage api={api} />
          ) : tab === 'customers' ? (
            <CustomersPage api={api} />
          ) : tab === 'developers' && can('keys:read') ? (
            <DevelopersPage api={api} session={session} go={go} />
          ) : tab === 'account' ? (
            <AccountPage session={session} go={go} onSession={setSession} />
          ) : tab === 'controls' ? (
            <ControlsPage api={api} can={(scope) => !!can(scope)} />
          ) : tab === 'operations' ? (
            <OperationsPage api={api} onSelect={setSelected} />
          ) : (
            <Empty>
              Page not found. <button onClick={() => go('/app/overview')}>Open overview</button>
            </Empty>
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={14} /> Sandbox data · Test funds and provider rails
            </span>
            <span>Microsendr infrastructure</span>
          </footer>
        </main>
      </div>
      {transfer && (
        <Modal title="New transfer" onClose={() => setTransfer(false)}>
          <TransferFlow api={api} onDone={done} />
        </Modal>
      )}
      {selected && (
        <IntentDetail
          api={api}
          intent={selected}
          operations={tab === 'operations'}
          onClose={() => {
            setSelected(undefined);
            setVersion((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
