import React, { useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  ArrowRight,
  Plus,
  Home,
  ReceiptText,
  UserRound,
  Wallet,
  LogOut,
  ShieldCheck,
  ChevronRight,
  Eye,
  EyeOff,
  Check,
  CreditCard,
  Globe2,
  Search,
  RefreshCw,
  LockKeyhole,
  Download,
  ArrowLeft,
  Coins,
} from 'lucide-react';
import { PersonalLogin } from './personal-login.js';
import { PersonalKyc } from './personal-kyc.js';
import { ConsumerProfileForm, ConsumerSecurity } from './consumer-profile.js';
import { consumerRequest, type ConsumerProfile } from './consumer-api.js';
import { MicrosendrMark } from './microsendr-logo.js';
import { ConsumerChainWallet } from './consumer-chain-wallet.js';
import './personal.css';
import './consumer.css';

type Session = { authenticated: boolean; csrf_token?: string; email?: string; account_id?: string };
type Capability = { available: boolean; reason: string };
type Movement = {
  id: string;
  status: string;
  to: string;
  amount_atomic: string;
  asset: string;
  decimals: number;
  network: string;
  created_at: string;
  tx_hash: string | null;
  explorer_url: string | null;
  confirmations: number;
  required_confirmations: number;
};
type Overview = {
  balances: unknown[];
  total: null;
  activity: Movement[];
  capabilities: Record<string, Capability>;
};
const statusLabel = (status: string) =>
  ({
    confirmed: 'Completed',
    awaiting_submission: 'Awaiting authorization',
    submitted: 'Processing',
    pending: 'Processing',
    unknown: 'Under review',
    failed: 'Failed',
    expired: 'Expired',
  })[status] ?? status;
const formatAmount = (item: Movement) => {
  const unit = 10n ** BigInt(item.decimals ?? 0);
  const n = BigInt(item.amount_atomic);
  return `${n / unit}.${(n % unit).toString().padStart(item.decimals, '0').slice(0, 6).replace(/0+$/, '') || '00'}`;
};
function PersonalLoading() {
  return (
    <div className="personal-loading" role="status" aria-label="Loading account">
      <span className="personal-loading-mark">
        <MicrosendrMark />
      </span>
    </div>
  );
}
const actions = [
  ['deposit', 'Add money', Plus],
  ['send', 'Send', ArrowUpRight],
  ['convert', 'Convert', ArrowLeftRight],
  ['withdraw', 'Withdraw', ArrowDownLeft],
] as const;

export function PersonalPage({
  go,
  path,
  brand,
  themeToggle,
  onAuthChange,
}: {
  go: (path: string) => void;
  path: string;
  brand: React.ReactNode;
  themeToggle: React.ReactNode;
  onAuthChange: (authenticated: boolean) => void;
}) {
  const [session, setSession] = useState<Session>(),
    [profile, setProfile] = useState<ConsumerProfile>(),
    [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState(''),
    [hidden, setHidden] = useState(false),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const rawTab = path.split('/')[2]?.split('?')[0] || 'home';
  const tab = rawTab === 'login' ? 'home' : rawTab === 'money' ? 'deposit' : rawTab;
  const navTab = ['profile', 'identity', 'security', 'onboarding'].includes(tab)
    ? 'profile'
    : ['deposit', 'withdraw', 'send', 'convert'].includes(tab)
      ? 'payments'
      : tab;
  async function refresh() {
    const s = await consumerRequest<Session>('session');
    setSession(s);
    if (s.authenticated) {
      const [p, o] = await Promise.all([
        consumerRequest<ConsumerProfile>('profile'),
        consumerRequest<Overview>('overview'),
      ]);
      setProfile(p);
      setOverview(o);
    }
  }
  useEffect(() => {
    void refresh().catch((e) => {
      setError(e.message);
    });
  }, []);
  useEffect(() => {
    if (session) onAuthChange(session.authenticated);
  }, [session?.authenticated, onAuthChange]);
  useEffect(() => {
    if (tab !== 'activity') setSelected(null);
    setError('');
    window.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = setInterval(() => {
      void consumerRequest<Overview>('overview')
        .then(setOverview)
        .catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [session?.authenticated]);
  const retry = async () => {
    setRefreshing(true);
    setError('');
    try {
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  async function logout() {
    try {
      await consumerRequest('logout', 'POST', {}, session?.csrf_token);
      setSession({ authenticated: false });
      setProfile(undefined);
      setOverview(undefined);
      go('/personal/login');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!session || (session.authenticated && (!profile || !overview)))
    return error ? (
      <div className="fin-connection">
        <MicrosendrMark />
        <h1>Let’s reconnect.</h1>
        <p role="alert">{error}</p>
        <button className="fin-primary" onClick={retry}>
          Try again
        </button>
      </div>
    ) : (
      <PersonalLoading />
    );
  if (!session.authenticated)
    return (
      <PersonalLogin
        brand={brand}
        go={go}
        onComplete={async (s, isNew) => {
          setSession(s);
          setError('');
          try {
            await refresh();
            go(isNew ? '/personal/onboarding' : '/personal/home');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    );
  const p = profile!,
    o = overview!,
    csrf = session.csrf_token!;
  const movements = o.activity.filter(
    (item) =>
      (filter === 'all' ||
        (filter === 'completed'
          ? item.status === 'confirmed'
          : !['confirmed', 'failed', 'expired'].includes(item.status))) &&
      `${item.id} ${item.to} ${statusLabel(item.status)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const receipt = selected ? o.activity.find((x) => x.id === selected) : undefined;
  const activity = (compact = false) => (
    <div className="fin-activity-list">
      {(compact ? o.activity.slice(0, 4) : movements).length ? (
        (compact ? o.activity.slice(0, 4) : movements).map((item) => (
          <button
            className="fin-transaction"
            key={item.id}
            onClick={() => {
              setSelected(item.id);
              if (compact) go('/personal/activity');
            }}
          >
            <span className="fin-tx-icon">
              <ArrowUpRight size={19} />
            </span>
            <span>
              <b>Wallet transfer</b>
              <small>
                {new Date(item.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </small>
            </span>
            <span>
              <b>{statusLabel(item.status)}</b>
              <small>
                View details <ChevronRight size={12} />
              </small>
            </span>
          </button>
        ))
      ) : (
        <div className="fin-empty">
          <span>
            <ReceiptText size={25} />
          </span>
          <h3>{search ? 'No matching payments' : 'Your story starts here'}</h3>
          <p>
            {search
              ? 'Try a different name or reference.'
              : 'Completed and pending payments will appear here.'}
          </p>
        </div>
      )}
    </div>
  );
  return (
    <div className="fin-app">
      <aside className="fin-sidebar">
        <button className="fin-brand" onClick={() => go('/personal/home')}>
          {brand}
        </button>
        <span className="fin-sidebar-label">PERSONAL ACCOUNT</span>
        <nav aria-label="Account navigation">
          {[
            ['home', 'Home', Home],
            ['payments', 'Payments', ArrowLeftRight],
            ['activity', 'Activity', ReceiptText],
            ['profile', 'Account', UserRound],
          ].map(([key, label, Icon]) => {
            const I = Icon as typeof Home;
            return (
              <button
                key={key as string}
                className={navTab === key ? 'active' : ''}
                aria-current={navTab === key ? 'page' : undefined}
                onClick={() => go(`/personal/${key}`)}
              >
                <I size={20} />
                <span>{label as string}</span>
                {navTab === key && <i />}
              </button>
            );
          })}
        </nav>
        <div className="fin-sidebar-bottom">
          <div className="fin-sidebar-note">
            <ShieldCheck size={22} />
            <b>Make it yours.</b>
            <p>Keep your account details and security up to date.</p>
            <button onClick={() => go('/personal/security')}>
              Manage security <ArrowRight size={14} />
            </button>
          </div>
          <button className="fin-signout" onClick={logout}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>
      <div className="fin-workspace">
        <header className="fin-topbar">
          <div>
            <span className="fin-mobile-logo">
              <MicrosendrMark />
            </span>
            <span className="fin-topbar-brand">{brand}</span>
          </div>
          <nav className="fin-desktop-nav" aria-label="Account navigation">
            {[
              ['home', 'Home'],
              ['payments', 'Payments'],
              ['activity', 'Activity'],
              ['profile', 'Account'],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-current={navTab === key ? 'page' : undefined}
                onClick={() => go(`/personal/${key}`)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div>
            {themeToggle}
            <button
              className="fin-avatar"
              onClick={() => go('/personal/profile')}
              aria-label="Open your profile"
            >
              {(p.first_name?.[0] ?? 'M') + (p.last_name?.[0] ?? '')}
            </button>
          </div>
        </header>
        <main
          className={`fin-content${tab === 'home' ? ' fin-home-content' : ''}`}
          id="main-content"
        >
          {error && (
            <div role="alert" className="fin-error">
              {error}
            </div>
          )}
          {tab === 'home' && (
            <>
              <div className="fin-home-heading">
                <div>
                  <span className="fin-kicker">YOUR MICROSENDR SPACE</span>
                  <h1>
                    Hello{p.first_name ? `, ${p.first_name}` : ''}
                    <span className="fin-greeting-dot">.</span>
                  </h1>
                  <p>One place for digital dollars and your next money move.</p>
                </div>
                <button
                  className="fin-icon-button"
                  onClick={retry}
                  disabled={refreshing}
                  aria-label="Refresh account"
                >
                  <RefreshCw size={18} className={refreshing ? 'fin-spin' : ''} />
                </button>
              </div>
              <section className="fin-wallet-overview" aria-label="Your wallet overview">
                <div className="fin-wallet-overview-top">
                  <span>
                    <Coins size={17} /> Wallet overview
                  </span>
                  <span className="fin-wallet-status">
                    <i /> Getting ready
                  </span>
                </div>
                <div className="fin-wallet-amount">
                  <span>Available balance</span>
                  <div>
                    <strong>{hidden ? '••••' : '—'}</strong>
                    <button
                      aria-label={hidden ? 'Show balance' : 'Hide balance'}
                      onClick={() => setHidden(!hidden)}
                    >
                      {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  <p>{hidden ? 'Your balance is hidden' : 'No available funds yet'}</p>
                </div>
                <div className="fin-wallet-overview-foot">
                  <span>
                    <span className="fin-token-dot">$</span> Digital dollars{' '}
                    <small>Stablecoin access coming</small>
                  </span>
                  <button onClick={() => go('/personal/deposit')}>
                    Explore deposit <ArrowRight size={15} />
                  </button>
                </div>
              </section>
              <div className="fin-wallet-actions" aria-label="Money actions">
                {actions.map(([key, label, Icon]) => (
                  <button key={key} onClick={() => go('/personal/' + key)}>
                    <span>
                      <Icon size={23} />
                    </span>
                    <b>{label}</b>
                  </button>
                ))}
              </div>
              <section className="fin-panel fin-home-activity">
                <div className="fin-section-head">
                  <h2>Activity</h2>
                  <button className="fin-text" onClick={() => go('/personal/activity')}>
                    View all <ArrowRight size={15} />
                  </button>
                </div>
                {activity(true)}
              </section>
            </>
          )}
          {tab === 'payments' && (
            <>
              <PageHeading
                kicker="MOVE MONEY"
                title="Your next move."
                text="Add, send, convert or withdraw from one place."
              />
              <div className="fin-payment-tiles">
                {actions.map(([key, label, Icon], i) => (
                  <button key={key} onClick={() => go('/personal/' + key)}>
                    <span>
                      <Icon size={25} />
                    </span>
                    <h2>{label}</h2>
                    <p>
                      {
                        [
                          'Explore stablecoin or local deposits.',
                          'Pay someone or an external account.',
                          'Review an exchange before you confirm.',
                          'Move money to your bank account.',
                        ][i]
                      }
                    </p>
                    <ArrowRight size={19} />
                  </button>
                ))}
              </div>
            </>
          )}
          {['deposit', 'send', 'withdraw', 'convert'].includes(tab) && (
            <MoneyFlow
              key={tab}
              kind={tab}
              capabilities={o.capabilities}
              csrf={csrf}
              go={go}
              onChanged={refresh}
            />
          )}
          {tab === 'activity' && (
            <>
              <PageHeading
                kicker="YOUR RECORDS"
                title="Every move, in one place."
                text="Track your payments and open a receipt for the details."
              />
              <section className="fin-panel">
                <div className="fin-activity-tools">
                  <label className="fin-search">
                    <Search size={18} />
                    <input
                      aria-label="Search payments"
                      placeholder="Search reference or recipient"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Payment status"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="completed">Completed</option>
                    <option value="pending">In progress</option>
                  </select>
                </div>
                {activity()}
              </section>
              {receipt && (
                <section className="fin-panel fin-receipt">
                  <div className="fin-section-head">
                    <h2>Transfer details</h2>
                    <button className="fin-text" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                  <dl>
                    {Object.entries({
                      Status: statusLabel(receipt.status),
                      Amount: `${formatAmount(receipt)} ${receipt.asset}`,
                      Recipient: receipt.to,
                      Reference: receipt.id,
                      Network: receipt.network,
                      'Transaction reference': receipt.tx_hash ?? 'Not submitted',
                      Confirmations: `${receipt.confirmations} / ${receipt.required_confirmations}`,
                    }).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="fin-form-actions">
                    {receipt.explorer_url && (
                      <a
                        className="fin-secondary"
                        href={receipt.explorer_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction <ArrowUpRight size={15} />
                      </a>
                    )}
                    <button
                      className="fin-secondary"
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(receipt, null, 2)], {
                            type: 'application/json',
                          }),
                        );
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `microsendr-${receipt.id}.json`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      <Download size={15} /> Download record
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
          {tab === 'profile' && (
            <>
              <PageHeading
                kicker="MY ACCOUNT"
                title="Made personal."
                text="Your details, preferences and account security."
              />
              <ConsumerProfileForm profile={p} csrf={csrf} onSaved={refresh} go={go} />
              <button className="fin-secondary fin-profile-logout" onClick={logout}>
                <LogOut size={16} /> Sign out
              </button>
            </>
          )}
          {tab === 'security' && (
            <>
              <PageHeading
                kicker="ACCOUNT SECURITY"
                title="Stay in control."
                text="Manage your email and password."
              />
              <ConsumerSecurity profile={p} csrf={csrf} onSaved={refresh} />
            </>
          )}
          {['identity', 'onboarding'].includes(tab) && (
            <>
              <PageHeading
                kicker={tab === 'onboarding' ? 'WELCOME TO MICROSENDR' : 'ACCOUNT VERIFICATION'}
                title={
                  tab === 'onboarding'
                    ? `You’re in${p.first_name ? `, ${p.first_name}` : ''}.`
                    : 'Let’s make it official.'
                }
                text="Verify your identity now, or return to this step when you’re ready."
              />
              <div className="fin-verification">
                <section className="fin-panel">
                  <span className="fin-verification-icon">
                    <ShieldCheck size={35} />
                  </span>
                  <h2>Your account, verified.</h2>
                  <p>
                    Have a valid identity document ready. You may also be asked to take a selfie.
                  </p>
                  <div className="fin-verification-points">
                    <span>
                      <Check size={16} /> Your documents stay with the verification provider.
                    </span>
                    <span>
                      <Check size={16} /> You can explore your account before verification.
                    </span>
                  </div>
                </section>
                <PersonalKyc csrf={csrf} />
                <button className="fin-text" onClick={() => go('/personal/home')}>
                  {tab === 'onboarding' ? 'Do this later' : 'Back to overview'}{' '}
                  <ArrowRight size={16} />
                </button>
              </div>
            </>
          )}
          {![
            'home',
            'payments',
            'deposit',
            'send',
            'withdraw',
            'convert',
            'activity',
            'profile',
            'security',
            'identity',
            'onboarding',
          ].includes(tab) && (
            <section className="fin-panel">
              <h1>Page not found</h1>
              <button className="fin-primary" onClick={() => go('/personal/home')}>
                Back to overview
              </button>
            </section>
          )}
          <footer className="fin-app-footer">
            <span>© {new Date().getFullYear()} Microsendr</span>
            <button onClick={() => go('/personal/security')}>
              <LockKeyhole size={12} /> Account security
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
function PageHeading({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <div className="fin-heading">
      <div>
        <span className="fin-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </div>
  );
}
function MoneyFlow({
  kind,
  capabilities,
  csrf,
  go,
  onChanged,
}: {
  kind: string;
  capabilities: Record<string, Capability>;
  csrf: string;
  go: (path: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [method, setMethod] = useState('crypto'),
    [source, setSource] = useState('USD'),
    [amount, setAmount] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const destination = source === 'USD' ? 'NGN' : 'USD';
  const capability =
    capabilities[
      kind === 'deposit'
        ? method === 'bank'
          ? 'fiat_deposit'
          : 'crypto_deposit'
        : kind === 'convert'
          ? 'conversion'
          : kind === 'send'
            ? 'transfer'
            : 'withdrawal'
    ];
  const title =
    kind === 'deposit'
      ? 'Add money.'
      : kind === 'convert'
        ? 'A clearer exchange.'
        : kind === 'send'
          ? 'Who are you paying?'
          : 'Withdraw to your bank.';
  async function quote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await consumerRequest('conversion/quotes', 'POST', { source, destination, amount }, csrf);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="fin-text fin-back" onClick={() => go('/personal/payments')}>
        <ArrowLeft size={16} /> Payments
      </button>
      <PageHeading
        kicker="MOVE MONEY"
        title={title}
        text={
          kind === 'convert'
            ? 'See the rate, fees and final amount before you confirm.'
            : kind === 'deposit'
              ? 'Choose a network wallet or a local funding method.'
              : kind === 'send'
                ? 'Send native QIE to a wallet on QIE Mainnet.'
                : 'Send available naira to a verified bank account.'
        }
      />
      <div className="fin-flow-layout">
        <section className="fin-panel fin-flow">
          {kind === 'deposit' && (
            <div className="fin-methods" role="group" aria-label="Deposit method">
              <button
                className={method === 'bank' ? 'active' : ''}
                onClick={() => setMethod('bank')}
              >
                <CreditCard size={20} /> Bank / card
              </button>
              <button
                className={method === 'crypto' ? 'active' : ''}
                onClick={() => setMethod('crypto')}
              >
                <Globe2 size={20} /> Crypto transfer
              </button>
            </div>
          )}
          {(kind === 'send' || (kind === 'deposit' && method === 'crypto')) ? (
            <ConsumerChainWallet
              csrf={csrf}
              mode={kind === 'send' ? 'send' : 'receive'}
              go={go}
              onChanged={onChanged}
            />
          ) : kind === 'convert' ? (
            <form onSubmit={quote}>
              <div className="fin-amount-input">
                <label>
                  You exchange
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    pattern="[1-9][0-9]*(\.[0-9]{1,2})?"
                    required
                    placeholder="0.00"
                  />
                </label>
                <select
                  aria-label="Source currency"
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setError('');
                  }}
                >
                  <option value="USD">USD</option>
                  <option value="NGN">NGN</option>
                </select>
              </div>
              <button
                type="button"
                className="fin-swap"
                aria-label="Reverse conversion"
                onClick={() => {
                  setSource(destination);
                  setError('');
                }}
              >
                <ArrowLeftRight size={18} />
              </button>
              <div className="fin-receive">
                <span>
                  You receive<strong>—</strong>
                </span>
                <b>{destination}</b>
              </div>
              <div className="fin-fee-row">
                <span>Rate & total fees</span>
                <b>Calculated with your quote</b>
              </div>
              <p className="fin-small">
                A digital dollar balance is an asset balance, not a bank deposit. Conversion
                requires an available provider route.
              </p>
              {error && (
                <div className="fin-error" role="alert">
                  {error}
                </div>
              )}
              <button className="fin-primary" disabled={busy}>
                {busy ? 'Checking availability…' : 'Check exchange availability'}
                <ArrowRight size={17} />
              </button>
            </form>
          ) : (
            <div className="fin-method-detail">
              <span className="fin-method-icon">
                {kind === 'deposit' ? (
                  method === 'bank' ? (
                    <CreditCard size={30} />
                  ) : (
                    <Globe2 size={30} />
                  )
                ) : kind === 'send' ? (
                  <ArrowUpRight size={30} />
                ) : (
                  <ArrowDownLeft size={30} />
                )}
              </span>
              <h2>
                {kind === 'deposit'
                  ? method === 'bank'
                    ? 'Local deposits'
                    : 'Receive digital dollars'
                  : kind === 'send'
                    ? 'Send with Microsendr'
                    : 'Bank withdrawal'}
              </h2>
              <p>{capability?.reason ?? 'This payment method is not available yet.'}</p>
              <span className="fin-status">Not available</span>
              {kind === 'deposit' && method === 'crypto' && (
                <p className="fin-small">
                  The deposit instructions will specify the supported asset and network. Only use
                  the address shown for that network.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
