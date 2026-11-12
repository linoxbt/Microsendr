import './consumer.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Search,
  RefreshCw,
  Printer,
  CreditCard,
  Globe2,
  CheckCircle2,
  Circle,
  ArrowLeft,
  Copy,
  QrCode,
  Coins,
  Landmark,
  Inbox,
  AtSign,
  Phone,
  Wifi,
  Gift,
  LockKeyhole,
  Moon,
  Sun,
} from 'lucide-react';
import { PersonalLogin } from './personal-login.js';
import { PersonalKyc } from './personal-kyc.js';
import { ConsumerProfileForm, ConsumerSecurity } from './consumer-profile.js';
import {
  consumerRequest,
  isSessionExpired,
  sessionExpiredEvent,
  type ConsumerProfile,
} from './consumer-api.js';
import { logoutPrivyIfMounted } from './auth-shell.js';
import { MicrosendrMark, MicrosendrWatermark } from './microsendr-logo.js';
import { ConsumerChainWallet } from './consumer-chain-wallet.js';
import { AssetDetail, AssetIcon, assetAmount, assetDefaults, type PersonalAsset } from './personal-assets.js';
import { formatAtomic } from './money.js';
import { ConversionPanel } from './conversion-panel.js';
import { BillReceipt, BillsFlow, billTitles } from './bills.js';
import { ToastProvider, useToast } from './toast.js';
import { type PaymentAuthStatus } from './payment-security.js';

type Session = { authenticated: boolean; csrf_token?: string; email?: string; account_id?: string };
type Capability = { available: boolean; reason: string };
type Movement = {
  id: string;
  direction?: 'sent' | 'received';
  status: string;
  from?: string;
  to: string;
  to_username?: string | null;
  amount_atomic: string;
  asset: string;
  decimals: number | null;
  network: string;
  created_at: string;
  tx_hash: string | null;
  explorer_url: string | null;
  confirmations?: number;
  required_confirmations?: number;
};
type Overview = {
  balances: unknown[];
  total: null;
  assets: PersonalAsset[];
  wallet_value_usd?: { amount_usd: string | null; checked_at: string | null };
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
const assetLabel = (asset: string) => (asset === 'QIEV3' ? 'QIE' : asset);
// Activity holds outbound settlements from a linked wallet and verified incoming transfers.
const received = (item: Movement) => item.direction === 'received';
const movementTitle = (item: Movement) => `${received(item) ? 'Received' : 'Sent'} ${assetLabel(item.asset)}`;
const counterparty = (item: Movement) =>
  received(item)
    ? `From ${shortAddress(item.from ?? '')}`
    : item.to_username ? `To @${item.to_username}` : `To ${shortAddress(item.to)}`;
const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};
const payeePattern = /^(0x[a-fA-F0-9]{40}|@?[a-zA-Z][a-zA-Z0-9_]{2,23})$/;
const tone = (name: string) => [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4;
const dayLabel = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
};
const shortAddress = (value: string) =>
  value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const formatAmount = (item: Movement) => {
  if (item.decimals === null || item.decimals === undefined)
    return `${item.amount_atomic} base units of`;
  return formatAtomic(item.amount_atomic, item.decimals);
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
/** The app's shape while the account loads, so nothing jumps when data arrives. */
function PersonalSkeleton() {
  return (
    <div className="fin-app fin-skeleton-app" role="status" aria-label="Loading account">
      <header className="fin-topbar fin-skeleton-top">
        <span className="fin-mobile-logo"><MicrosendrMark /></span>
        <i className="fin-sk fin-sk-circle" />
      </header>
      <main className="fin-content fin-home-content" aria-hidden="true">
        <div className="rt-home">
          <i className="fin-sk rt-sk-balance" />
          <div className="rt-shortcuts">{[0, 1, 2, 3].map((n) => <i key={n} className="fin-sk rt-sk-shortcut" />)}</div>
          <div className="fin-skeleton-rows">
            {[0, 1, 2].map((row) => <span key={row}><i className="fin-sk fin-sk-circle" /><i className="fin-sk fin-sk-line" /></span>)}
          </div>
        </div>
      </main>
    </div>
  );
}
const actions = [
  ['deposit', 'Add money', Plus],
  ['send', 'Send', ArrowUpRight],
  ['airtime', 'Airtime', Phone],
  ['data', 'Data', Wifi],
  ['giftcards', 'Subscriptions & gift cards', Gift],
  ['assets', 'Assets', Coins],
  ['convert', 'Convert', ArrowLeftRight],
  ['withdraw', 'Withdraw', ArrowDownLeft],
] as const;
// Home shortcuts: round icons under the balance card.
const shortcuts = [
  ['/personal/airtime', 'Airtime', Phone, 'blue'],
  ['/personal/data', 'Data', Wifi, 'amber'],
  ['/personal/giftcards', 'Subscriptions', Gift, 'green'],
  ['/personal/deposit/crypto', 'Receive', QrCode, 'slate'],
] as const;

export function PersonalPage({
  go,
  path,
  brand,
  themeToggle,
  theme = 'light',
  onToggleTheme,
  onAuthChange,
}: {
  go: (path: string) => void;
  path: string;
  brand: React.ReactNode;
  themeToggle: React.ReactNode;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
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
    [refreshing, setRefreshing] = useState(false),
    [signInNotice, setSignInNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [payTo, setPayTo] = useState('');
  const toastRef = useRef<(message: string) => void>(() => undefined);
  const toast = (message: string) => toastRef.current(message);
  const rawTab = path.split('/')[2]?.split('?')[0] || 'home';
  const tab = rawTab === 'login' ? 'home' : rawTab === 'money' ? 'deposit' : rawTab;
  const assetCode = path.split('/')[3]?.split('?')[0]?.toUpperCase();
  const navTab = tab === 'assets' ? 'home' : ['profile', 'identity', 'security', 'onboarding'].includes(tab)
    ? 'profile'
    : ['deposit', 'withdraw', 'send', 'convert', 'airtime', 'data', 'giftcards', 'bills'].includes(tab)
      ? 'payments'
      : tab;
  // Balances and activity load on their own: a slow or failing chain read never blocks
  // the rest of the app. Each load is numbered so an older answer cannot overwrite a newer one.
  const overviewSeq = useRef(0), appliedSeq = useRef(0);
  const [overviewError, setOverviewError] = useState('');
  async function loadOverview() {
    const seq = ++overviewSeq.current;
    try {
      const next = await consumerRequest<Overview>('overview');
      if (seq > appliedSeq.current) { appliedSeq.current = seq; setOverview(next); setOverviewError(''); }
    } catch (e) {
      if (!isSessionExpired(e) && seq > appliedSeq.current) setOverviewError((e as Error).message);
      throw e;
    }
  }
  async function refresh() {
    const s = await consumerRequest<Session>('session');
    setSession(s);
    if (s.authenticated) {
      setProfile(await consumerRequest<ConsumerProfile>('profile'));
      void loadOverview().catch(() => undefined);
    }
  }
  // Drop everything tied to the account so no stale dashboard survives a sign-out or expiry.
  const clearLocalState = useCallback(() => {
    setSession({ authenticated: false });
    setProfile(undefined);
    setOverview(undefined);
    setSelected(null);
    setError('');
  }, []);
  useEffect(() => {
    void refresh().catch((e) => {
      if (!isSessionExpired(e)) setError(e.message);
    });
  }, []);
  useEffect(() => {
    const expired = () => {
      clearLocalState();
      setSignInNotice('Your session has ended. Sign in again to continue.');
      go('/personal/login');
    };
    window.addEventListener(sessionExpiredEvent, expired);
    return () => window.removeEventListener(sessionExpiredEvent, expired);
  }, [clearLocalState, go]);
  useEffect(() => {
    if (session) onAuthChange(session.authenticated);
  }, [session?.authenticated, onAuthChange]);
  // Each page names itself in the browser tab.
  useEffect(() => {
    const titles: Record<string, string> = { home: 'Home', payments: 'Payments', deposit: 'Add money', send: 'Send', convert: 'Convert',
      withdraw: 'Withdraw', activity: 'Activity', profile: 'Account', security: 'Security', identity: 'Identity', assets: 'Assets', onboarding: 'Welcome' };
    if (session?.authenticated) document.title = `${titles[tab] ?? 'Microsendr'} · Microsendr`;
  }, [tab, session?.authenticated]);
  useEffect(() => {
    if (tab !== 'activity') setSelected(null);
    setError('');
    window.scrollTo(0, 0);
  }, [tab]);
  // On a phone the receipt opens below the list, so bring it into view.
  useEffect(() => {
    if (!selected || window.innerWidth > 650) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() =>
      document.querySelector('.fin-receipt')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
  }, [selected]);
  // Poll the overview only while the page is visible; a 401 fires the session-expired handler.
  useEffect(() => {
    if (!session?.authenticated) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    // One poll at a time: a slow answer is never stacked on or overtaken by older ones.
    const tick = () => {
      if (inFlight || !active) return;
      inFlight = true;
      void loadOverview().catch(() => undefined).finally(() => { inFlight = false; });
    };
    const start = () => {
      if (timer === undefined && !document.hidden) timer = setInterval(tick, 15000);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const visibility = () => {
      if (document.hidden) stop();
      else {
        tick();
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [session?.authenticated]);
  const retry = async () => {
    setRefreshing(true);
    setError('');
    try {
      await refresh();
    } catch (e) {
      if (!isSessionExpired(e)) setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const signingOut = useRef(false);
  async function logout() {
    if (signingOut.current) return;
    signingOut.current = true;
    const csrf = session?.csrf_token;
    // Local state is cleared first so a failed server call can never leave the account on screen.
    clearLocalState();
    setSignInNotice('');
    go('/personal/login');
    const [server] = await Promise.allSettled([
      consumerRequest('logout', 'POST', {}, csrf),
      logoutPrivyIfMounted(),
    ]);
    if (server.status === 'rejected' && !isSessionExpired(server.reason))
      setSignInNotice(
        'You are signed out on this device. We could not reach Microsendr to end the session, so it will expire on its own.',
      );
    signingOut.current = false;
  }
  if (!session || (session.authenticated && !profile))
    return error ? (
      <div className="fin-connection">
        <MicrosendrMark />
        <h1>Let’s reconnect.</h1>
        <p role="alert">{error}</p>
        <button className="fin-primary" onClick={retry}>
          Try again
        </button>
        {session?.authenticated && <button className="fin-text" onClick={logout}>Sign out</button>}
      </div>
    ) : path.startsWith('/personal/login') || path.startsWith('/personal/register') || path === '/personal' ? (
      <PersonalLoading />
    ) : (
      <PersonalSkeleton />
    );
  if (!session.authenticated)
    return (
      <PersonalLogin
        brand={brand}
        go={go}
        notice={signInNotice}
        onComplete={async (s, isNew) => {
          setSession(s);
          setError('');
          setSignInNotice('');
          try {
            await refresh();
            go(isNew ? '/personal/onboarding' : '/personal/home');
          } catch (e) {
            if (!isSessionExpired(e)) setError((e as Error).message);
          }
        }}
      />
    );
  const p = profile!,
    o: Overview = overview ?? { balances: [], total: null, assets: [], activity: [], capabilities: {} },
    csrf = session.csrf_token!;
  const assets = assetDefaults.map(defaultAsset => o.assets?.find(asset => asset.code === defaultAsset.code) ?? defaultAsset);
  const walletValue = o.wallet_value_usd?.amount_usd ?? null;
  const formattedWalletValue = walletValue === null ? '—' :
    `$${walletValue.replace(/\B(?=(\d{3})+(?=\.))/g, ',')}`;
  const detailAsset = assets.find(asset => asset.code.toLowerCase() === assetCode?.toLowerCase());
  const movements = o.activity.filter(
    (item) =>
      (filter === 'all' ||
        (filter === 'completed'
          ? item.status === 'confirmed'
          : !['confirmed', 'failed', 'expired'].includes(item.status))) &&
      `${item.id} ${item.to} ${item.from ?? ''} ${movementTitle(item)} ${statusLabel(item.status)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const receipt = selected ? o.activity.find((x) => x.id === selected) : undefined;
  // Only usernames this account itself paid, recorded when they matched the address sent to.
  const payees = [...new Set(o.activity
    .filter((item) => !received(item) && item.to_username && !['failed', 'expired'].includes(item.status))
    .map((item) => item.to_username!))].slice(0, 5);
  const recentDays = o.activity.slice(0, 6).reduce<[string, Movement[]][]>((days, item) => {
    const day = dayLabel(item.created_at);
    const last = days[days.length - 1];
    if (last?.[0] === day) last[1].push(item);
    else days.push([day, [item]]);
    return days;
  }, []);
  async function copyUsername() {
    try {
      await navigator.clipboard.writeText(`@${p.username}`);
      toast('Username copied');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Copy is unavailable on this device.');
    }
  }
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
            <span className={`fin-tx-icon${received(item) ? ' fin-tx-icon-in' : ''}`}>
              {received(item) ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}
            </span>
            <span>
              <b>{movementTitle(item)}</b>
              <small>
                {new Date(item.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                · {counterparty(item)}
              </small>
            </span>
            <span>
              <b className={`fin-tx-amount${received(item) ? ' fin-feed-in' : ''}`}>
                {hidden ? '••••' : item.decimals === null || item.decimals === undefined
                  ? statusLabel(item.status)
                  : `${received(item) ? '+' : '−'}${formatAmount(item)} ${assetLabel(item.asset)}`}
              </b>
              <small>
                {statusLabel(item.status)} <ChevronRight size={12} />
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
    <ToastProvider>
    <ToastBridge target={toastRef} />
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
              {(p.first_name?.[0] ?? 'R') + (p.last_name?.[0] ?? '')}
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
              {overviewError && (
                <div className="fin-error fin-inline-retry" role="alert">
                  <span>Balances could not load.</span>
                  <button className="fin-text" onClick={() => void loadOverview().catch(() => undefined)}>Try again</button>
                </div>
              )}
              <div className="rt-home">
                <h1 className="fin-sr-only">{greeting()}{p.first_name ? `, ${p.first_name}` : ''}</h1>
                <section className="rt-balance" aria-label="Your wallet overview">
                  <MicrosendrWatermark />
                  <div className="rt-balance-top">
                    <button className="rt-balance-avatar" onClick={() => go('/personal/profile')} aria-label="Open your account">
                      {(p.first_name?.[0] ?? 'R') + (p.last_name?.[0] ?? '')}
                    </button>
                    {p.username && (
                      <button className="rt-id" onClick={() => void copyUsername()} aria-label={`Copy your username @${p.username}`}>
                        @{p.username} {copied ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                    )}
                  </div>
                  <div className="rt-balance-main">
                    <span>
                      Total balance
                      <button aria-label={hidden ? 'Show balance' : 'Hide balance'} onClick={() => setHidden(!hidden)}>
                        {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </span>
                    <div className="fin-wallet-amount">
                      <strong className={formattedWalletValue.length > 13 ? 'fin-amount-xlong' : formattedWalletValue.length > 10 ? 'fin-amount-long' : undefined}>
                        {hidden ? '••••' : !overview ? '…' : formattedWalletValue}
                      </strong>
                    </div>
                  </div>
                  <div className="rt-balance-actions" role="group" aria-label="Money actions">
                    <button onClick={() => go('/personal/deposit')}><Plus size={18} /> Add money</button>
                    <button onClick={() => go('/personal/send')}>Send <ArrowUpRight size={18} /></button>
                  </div>
                </section>
                <section className="rt-pay" aria-labelledby="pay-card-title">
                  <h2 id="pay-card-title">Pay anyone on Microsendr</h2>
                  <form
                    className="rt-pay-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = payTo.trim();
                      go(value && payeePattern.test(value) ? `/personal/send/${value.startsWith('0x') ? 'address' : 'user'}/qie?to=${encodeURIComponent(value)}` : '/personal/send');
                    }}
                  >
                    <Search size={18} aria-hidden="true" />
                    <input
                      value={payTo}
                      onChange={(e) => setPayTo(e.target.value)}
                      placeholder="@username or 0x… address"
                      aria-label="Pay a Microsendr @username or QIE address"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <button aria-label="Continue to payment"><ArrowRight size={18} /></button>
                  </form>
                </section>
                <nav className="rt-shortcuts" aria-label="Shortcuts">
                  {shortcuts.map(([path, label, Icon, tone]) => (
                    <button key={label} onClick={() => go(path)}>
                      <span className={`rt-shortcut-icon rt-tone-${tone}`}><Icon size={22} /></span>
                      {label}
                    </button>
                  ))}
                </nav>
                <section className="rt-activity" aria-labelledby="home-activity-title">
                  <div className="rt-activity-head">
                    <h2 id="home-activity-title">Activity</h2>
                    {o.activity.length > 0 && (
                      <button className="fin-text" onClick={() => go('/personal/activity')}>See all</button>
                    )}
                  </div>
                  {recentDays.length ? recentDays.map(([day, items]) => (
                    <div className="fin-day" key={day}>
                      <h3>{day}</h3>
                      {items.map((item) => (
                        <button
                          className="fin-feed-row"
                          key={item.id}
                          onClick={() => {
                            setSelected(item.id);
                            go('/personal/activity');
                          }}
                        >
                          <span className={`fin-tx-icon${received(item) ? ' fin-tx-icon-in' : ''}`}>
                            {received(item) ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                          </span>
                          <span className="fin-feed-text">
                            <b>{counterparty(item)}</b>
                            <small>
                              {assetLabel(item.asset)} ·{' '}
                              {new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                              {item.status !== 'confirmed' && ` · ${statusLabel(item.status)}`}
                            </small>
                          </span>
                          <span className={`fin-feed-amount${received(item) ? ' fin-feed-in' : ''}`}>
                            {hidden ? '••••' : item.decimals === null || item.decimals === undefined
                              ? statusLabel(item.status)
                              : `${received(item) ? '+' : '−'}${formatAmount(item)}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  )) : !overview ? (
                    <div className="fin-skeleton-rows fin-skeleton-inline" aria-label="Loading activity" role="status">
                      {[0, 1, 2].map((row) => <span key={row}><i className="fin-sk fin-sk-circle" /><i className="fin-sk fin-sk-line" /></span>)}
                    </div>
                  ) : (
                    <div className="rt-empty">
                      <span><Inbox size={30} /></span>
                      <p>No transactions</p>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {tab === 'assets' && !assetCode && (
            <div className="rt-page">
              <PageBar title="Assets" back={() => go('/personal/home')} />
              <section className="rt-list" aria-label="Your assets">
                {assets.map(asset => <button className="fin-asset-row rt-row" key={asset.code} onClick={() => go(`/personal/assets/${asset.code.toLowerCase()}`)} aria-label={`View ${asset.code} details, ${asset.name}, balance ${hidden ? 'hidden' : asset.amount_atomic === null ? 'unavailable' : `${assetAmount(asset)} ${asset.code}`}`}>
                  <AssetIcon code={asset.code} />
                  <span className="fin-asset-name"><b>{asset.code}</b><small>{asset.name}</small></span>
                  <span className="fin-asset-value"><b>{hidden ? '••••' : assetAmount(asset)}</b>{asset.status !== 'ready' && <small>Soon</small>}</span>
                  <ChevronRight className="fin-asset-chevron" size={17} />
                </button>)}
              </section>
            </div>
          )}
          {tab === 'assets' && assetCode && (detailAsset
            ? <AssetDetail asset={detailAsset} activity={o.activity} go={go} hidden={hidden} refresh={() => void retry()} refreshing={refreshing} />
            : <div className="fin-panel"><h1>Asset not found</h1><button className="fin-secondary" onClick={() => go('/personal/assets')}>All assets</button></div>)}
          {tab === 'payments' && (
            <div className="rt-page">
              <h1 className="rt-account-title">Payments</h1>
              <OptionList label="Payments" options={actions.map(([key, label, Icon]) => ({
                key, title: label, icon: <Icon size={22} />, onClick: () => go('/personal/' + key),
              }))} />
            </div>
          )}
          {['airtime', 'data', 'giftcards'].includes(tab) && (
            <div className="rt-page">
              <PageBar title={billTitles[tab === 'giftcards' ? 'giftcard' : tab as 'airtime' | 'data']} back={() => go('/personal/home')} />
              <BillsFlow key={tab} kind={tab === 'giftcards' ? 'giftcard' : tab as 'airtime' | 'data'} csrf={csrf} profile={p} go={go} />
            </div>
          )}
          {tab === 'bills' && assetCode && (
            <div className="rt-page">
              <PageBar title="Purchase" back={() => go('/personal/home')} />
              <BillReceipt id={path.split('/')[3].split('?')[0]} go={go} />
            </div>
          )}
          {['deposit', 'send', 'withdraw', 'convert'].includes(tab) && (
            <MoneyFlow
              key={tab}
              kind={tab}
              path={path}
              payees={payees}
              capabilities={o.capabilities}
              csrf={csrf}
              go={go}
              onChanged={refresh}
            />
          )}
          {tab === 'activity' && (
            <>
              <PageHeading
                title="Activity"
              />
              <section className="fin-panel">
                <div className="fin-activity-tools">
                  <label className="fin-search">
                    <Search size={18} />
                    <input
                      aria-label="Search payments"
                      placeholder="Search payments"
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
                <section className="fin-panel fin-receipt" aria-label="Receipt">
                  <div className="fin-receipt-print-head" aria-hidden="true">
                    <MicrosendrMark /> <b>Microsendr</b> <span>Payment receipt</span>
                  </div>
                  <div className="fin-section-head">
                    <h2>{movementTitle(receipt)}</h2>
                    <button className="fin-text" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                  <dl>
                    {Object.entries(received(receipt) ? {
                      Status: statusLabel(receipt.status),
                      Amount: hidden ? '••••' : `${formatAmount(receipt)} ${assetLabel(receipt.asset)}`,
                      Date: new Date(receipt.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
                      From: receipt.from ?? '',
                      'Received at': receipt.to,
                      Reference: receipt.id,
                      Network: receipt.network,
                      'Transaction reference': receipt.tx_hash ?? '',
                    } : {
                      Status: statusLabel(receipt.status),
                      Amount: hidden ? '••••' : `${formatAmount(receipt)} ${assetLabel(receipt.asset)}`,
                      Date: new Date(receipt.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
                      Recipient: receipt.to_username ? `@${receipt.to_username} · ${receipt.to}` : receipt.to,
                      Reference: receipt.id,
                      Network: receipt.network,
                      'Transaction reference': receipt.tx_hash ?? 'Not submitted',
                      Confirmations: `${receipt.confirmations ?? 0} / ${receipt.required_confirmations ?? 0}`,
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
                    <button className="fin-secondary" onClick={() => window.print()}>
                      <Printer size={15} /> Print or save PDF
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
          {tab === 'profile' && assetCode !== 'DETAILS' && (
            <div className="rt-page rt-account">
              <h1 className="rt-account-title">Account</h1>
              <div className="rt-account-head">
                <span className="rt-account-avatar">{(p.first_name?.[0] ?? 'R') + (p.last_name?.[0] ?? '')}</span>
                <h2>{p.first_name ? `${p.first_name} ${p.last_name ?? ''}`.trim() : 'Your account'}</h2>
                {p.username && <p>@{p.username}</p>}
                <span className={`rt-badge ${p.identity_status === 'Approved' ? 'rt-badge-green' : 'rt-badge-grey'}`}>
                  {p.identity_status === 'Approved' ? 'Verified' : 'Not verified'}
                </span>
              </div>
              <OptionList label="Account settings" options={[
                { key: 'profile', title: 'My profile', text: 'Your details', icon: <UserRound size={21} />, onClick: () => go('/personal/profile/details') },
                { key: 'activity', title: 'Transactions', text: 'All your payments', icon: <ReceiptText size={21} />, onClick: () => go('/personal/activity') },
                { key: 'identity', title: 'Identity', text: p.identity_status === 'Approved' ? 'Verified' : 'Verify your account', icon: <ShieldCheck size={21} />, onClick: () => go('/personal/identity') },
                { key: 'security', title: 'Security', text: 'Password, PIN and passkeys', icon: <LockKeyhole size={21} />, onClick: () => go('/personal/security') },
                { key: 'theme', title: 'Theme', text: theme === 'dark' ? 'Dark' : 'Light', icon: theme === 'dark' ? <Moon size={21} /> : <Sun size={21} />, onClick: onToggleTheme },
              ]} />
              <button className="rt-logout" onClick={logout}>Sign out</button>
            </div>
          )}
          {tab === 'profile' && assetCode === 'DETAILS' && (
            <div className="rt-page">
              <PageBar title="My profile" back={() => go('/personal/profile')} />
              <ConsumerProfileForm profile={p} csrf={csrf} onSaved={refresh} go={go} />
            </div>
          )}
          {tab === 'security' && (
            <div className="rt-page">
              <PageBar title="Security" back={() => go('/personal/profile')} />
              <ConsumerSecurity profile={p} csrf={csrf} onSaved={refresh} />
            </div>
          )}
          {['identity', 'onboarding'].includes(tab) && (
            <div className="rt-page">
              {tab === 'identity'
                ? <PageBar title="Identity" back={() => go('/personal/profile')} />
                : <h1 className="rt-welcome">You’re in{p.first_name ? `, ${p.first_name}` : ''}.</h1>}
              <div className="fin-verification">
                <PersonalKyc csrf={csrf} />
                {tab === 'onboarding' && (
                  <button className="fin-text" onClick={() => go('/personal/home')}>
                    Do this later <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </div>
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
            'assets',
            'airtime',
            'data',
            'giftcards',
            'bills',
          ].includes(tab) && (
            <section className="fin-panel">
              <h1>Page not found</h1>
              <button className="fin-primary" onClick={() => go('/personal/home')}>
                Back to overview
              </button>
            </section>
          )}
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}
/** Lets PersonalPage, which renders the provider, show toasts. */
function ToastBridge({ target }: { target: React.MutableRefObject<(message: string) => void> }) {
  target.current = useToast();
  return null;
}

/** New accounts: three steps in place of an empty activity list. */
/** Mobile-style page header: back arrow, centred title. */
function PageBar({ title, back }: { title: string; back: () => void }) {
  return (
    <div className="rt-page-bar">
      <button onClick={back} aria-label="Back"><ArrowLeft size={22} /></button>
      <h1>{title}</h1>
      <span aria-hidden="true" />
    </div>
  );
}

type Option = { key: string; title: string; text?: string; icon: React.ReactNode; badge?: string; badgeTone?: 'green' | 'blue' | 'grey'; onClick?: () => void };
/** A list of large tappable choices, each with an icon, a title and one short line. */
function OptionList({ label, options }: { label: string; options: Option[] }) {
  return (
    <div className="rt-options" role="list" aria-label={label}>
      {options.map((option) => (
        <button key={option.key} role="listitem" className="rt-option" onClick={option.onClick} disabled={!option.onClick}>
          <span className="rt-option-icon">{option.icon}</span>
          <span className="rt-option-text">
            <b>{option.title}{option.badge && <em className={`rt-badge rt-badge-${option.badgeTone ?? 'grey'}`}>{option.badge}</em>}</b>
            {option.text && <small>{option.text}</small>}
          </span>
          {option.onClick && <ChevronRight size={20} />}
        </button>
      ))}
    </div>
  );
}

function PageHeading({ kicker, title, text }: { kicker?: string; title: string; text?: string }) {
  return (
    <div className="fin-heading">
      <div>
        {kicker && <span className="fin-kicker">{kicker}</span>}
        <h1>{title}</h1>
        {text && <p>{text}</p>}
      </div>
    </div>
  );
}
function MoneyFlow({
  kind,
  path,
  payees,
  capabilities,
  csrf,
  go,
  onChanged,
}: {
  kind: string;
  path: string;
  payees: string[];
  capabilities: Record<string, Capability>;
  csrf: string;
  go: (path: string) => void;
  onChanged: () => Promise<void>;
}) {
  const query = new URLSearchParams(window.location.search);
  // A recipient chosen elsewhere (?to=@name or ?to=0x…) prefills the send form.
  const [initialRecipient] = useState(() => {
    const to = query.get('to')?.trim() ?? '';
    return payeePattern.test(to) ? to : '';
  });
  const capability = capabilities?.[kind === 'convert' ? 'conversion' : 'withdrawal'];
  // Steps live in the path (/personal/deposit/crypto/qusdc), so the back button walks back
  // through them. Older links (?method=bank, ?asset=qusdc, ?to=…) still land on the right step.
  const [, , , stepRaw, tokenRaw] = path.split('?')[0].split('/');
  const legacyAsset = query.get('asset')?.toUpperCase();
  const step = stepRaw ?? (query.get('method') === 'bank' ? 'bank' : legacyAsset || initialRecipient ? (kind === 'send' ? 'address' : 'crypto') : undefined);
  const token = (tokenRaw ?? legacyAsset)?.toUpperCase() === 'QUSDC' ? 'QUSDC' : (tokenRaw ?? legacyAsset) ? 'QIE' : undefined;
  const back = (to: string) => () => go(to);

  if (kind === 'deposit') {
    if (!step)
      return (
        <div className="rt-page">
          <PageBar title="Add money" back={back('/personal/home')} />
          <OptionList label="Add money with" options={[
            { key: 'bank', title: 'Naira deposit', text: 'From your bank', icon: <Landmark size={22} />, onClick: back('/personal/deposit/bank') },
            { key: 'crypto', title: 'Crypto deposit', text: 'From a crypto wallet', icon: <Coins size={22} />, onClick: back('/personal/deposit/crypto') },
          ]} />
        </div>
      );
    if (step === 'bank')
      return (
        <div className="rt-page">
          <PageBar title="Naira deposit" back={back('/personal/deposit')} />
          {capabilities?.conversion?.available ? (
            <section className="fin-panel fin-add-bank" aria-label="Add money by bank">
              <h2 className="fin-sr-only">Buy with naira</h2>
              <ConversionPanel csrf={csrf} buyOnly />
            </section>
          ) : (
            <div className="rt-empty rt-empty-page" aria-label="Add money by bank">
              <span><Landmark size={30} /></span>
              <p>Coming soon</p>
            </div>
          )}
        </div>
      );
    if (!token)
      return (
        <div className="rt-page">
          <PageBar title="Select crypto" back={back('/personal/deposit')} />
          <OptionList label="Choose a token" options={(['QIE', 'QUSDC'] as const).map((code) => ({
            key: code, title: code, text: code === 'QUSDC' ? 'Digital dollars on QIE' : 'QIE Mainnet',
            icon: <AssetIcon code={code} />, onClick: back(`/personal/deposit/crypto/${code.toLowerCase()}`),
          }))} />
        </div>
      );
    return (
      <div className="rt-page fin-flow-narrow fin-flow-deposit">
        <PageBar title={`Receive ${token}`} back={back('/personal/deposit/crypto')} />
        <ConsumerChainWallet key={token} csrf={csrf} mode="receive" onChanged={onChanged} initialToken={token} go={go} />
      </div>
    );
  }

  if (kind === 'send') {
    if (!step)
      return (
        <div className="rt-page">
          <PageBar title="Send" back={back('/personal/home')} />
          <OptionList label="Send to" options={[
            { key: 'user', title: 'Microsendr user', badge: 'No fee', badgeTone: 'green', text: 'Send to an @username', icon: <AtSign size={22} />, onClick: back('/personal/send/user') },
            { key: 'address', title: 'Wallet address', text: 'QIE or QUSDC to any address', icon: <Wallet size={22} />, onClick: back('/personal/send/address') },
            { key: 'bank', title: 'Bank account', badge: 'Soon', badgeTone: 'blue', text: 'Send to a bank account', icon: <Landmark size={22} /> },
          ]} />
        </div>
      );
    const via = step === 'user' ? 'user' : 'address';
    // Pick the token first, from a list that can grow.
    if (!token && !initialRecipient)
      return (
        <div className="rt-page">
          <PageBar title="Select token" back={back('/personal/send')} />
          <OptionList label="Choose a token" options={(['QIE', 'QUSDC'] as const).map((code) => ({
            key: code, title: code, text: code === 'QUSDC' ? 'Digital dollars on QIE' : 'QIE Mainnet',
            icon: <AssetIcon code={code} />, onClick: back(`/personal/send/${via}/${code.toLowerCase()}`),
          }))} />
        </div>
      );
    const sendToken = token ?? 'QIE';
    return (
      <div className="rt-page fin-flow-narrow fin-flow-send">
        <PageBar title={`Send ${sendToken}`} back={back(`/personal/send/${via}`)} />
        <ConsumerChainWallet key={sendToken} csrf={csrf} mode="send" onChanged={onChanged} initialRecipient={initialRecipient}
          initialToken={sendToken} go={go} />
        {step === 'user' && payees.length > 0 && (
          <section className="rt-recent" aria-label="Pay again">
            <h2>Recent</h2>
            <ul className="fin-payees" aria-label="People you paid recently">
              {payees.map((name) => (
                <li key={name}>
                  <button onClick={() => go(`/personal/send/user/${sendToken.toLowerCase()}?to=${encodeURIComponent('@' + name)}`)} aria-label={`Pay @${name} again`}>
                    <span className={`fin-payee-avatar fin-payee-tone-${tone(name)}`} aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
                    <small>@{name}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="rt-page">
      <PageBar title={kind === 'convert' ? 'Convert' : 'Withdraw'} back={back('/personal/home')} />
      {kind === 'convert' && capability?.available ? (
        <section className="fin-panel fin-flow"><ConversionPanel csrf={csrf} /></section>
      ) : (
        <div className="rt-empty rt-empty-page">
          <span>{kind === 'convert' ? <ArrowLeftRight size={30} /> : <Landmark size={30} />}</span>
          <p>Coming soon</p>
        </div>
      )}
    </div>
  );
}
