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
import { RootsMark, RootsWatermark } from './roots-logo.js';
import { ConsumerChainWallet } from './consumer-chain-wallet.js';
import { AssetDetail, AssetIcon, assetAmount, assetDefaults, type PersonalAsset } from './personal-assets.js';
import { formatAtomic } from './money.js';
import { ConversionPanel } from './conversion-panel.js';
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
        <RootsMark />
      </span>
    </div>
  );
}
/** The app's shape while the account loads, so nothing jumps when data arrives. */
function PersonalSkeleton() {
  return (
    <div className="fin-app fin-skeleton-app" role="status" aria-label="Loading account">
      <header className="fin-topbar fin-skeleton-top">
        <span className="fin-mobile-logo"><RootsMark /></span>
        <i className="fin-sk fin-sk-circle" />
      </header>
      <main className="fin-content fin-home-content" aria-hidden="true">
        <i className="fin-sk fin-sk-title" />
        <i className="fin-sk fin-sk-line" />
        <div className="fin-home-grid">
          <div className="fin-skeleton-balance"><i className="fin-sk fin-sk-line" /><i className="fin-sk fin-sk-amount" /></div>
          <i className="fin-sk fin-sk-card" />
          <div className="fin-skeleton-rows">
            {[0, 1, 2, 3].map((row) => <span key={row}><i className="fin-sk fin-sk-circle" /><i className="fin-sk fin-sk-line" /></span>)}
          </div>
        </div>
      </main>
    </div>
  );
}
const actions = [
  ['deposit', 'Add money', Plus],
  ['send', 'Send', ArrowUpRight],
  ['convert', 'Convert', ArrowLeftRight],
  ['withdraw', 'Withdraw', ArrowDownLeft],
] as const;
const quickActions = [
  ['deposit', 'Add money', Plus],
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
    [refreshing, setRefreshing] = useState(false),
    [signInNotice, setSignInNotice] = useState('');
  const [payTo, setPayTo] = useState(''),
    [copied, setCopied] = useState(false);
  const toastRef = useRef<(message: string) => void>(() => undefined);
  const toast = (message: string) => toastRef.current(message);
  const rawTab = path.split('/')[2]?.split('?')[0] || 'home';
  const tab = rawTab === 'login' ? 'home' : rawTab === 'money' ? 'deposit' : rawTab;
  const assetCode = path.split('/')[3]?.split('?')[0]?.toUpperCase();
  const navTab = tab === 'assets' ? 'home' : ['profile', 'identity', 'security', 'onboarding'].includes(tab)
    ? 'profile'
    : ['deposit', 'withdraw', 'send', 'convert'].includes(tab)
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
    if (session?.authenticated) document.title = `${titles[tab] ?? 'Roots'} · Roots`;
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
        'You are signed out on this device. We could not reach Roots to end the session, so it will expire on its own.',
      );
    signingOut.current = false;
  }
  if (!session || (session.authenticated && !profile))
    return error ? (
      <div className="fin-connection">
        <RootsMark />
        <h1>Let’s reconnect.</h1>
        <p role="alert">{error}</p>
        <button className="fin-primary" onClick={retry}>
          Try again
        </button>
        {session?.authenticated && <button className="fin-text" onClick={logout}>Sign out</button>}
      </div>
    ) : path.startsWith('/personal/login') || path === '/personal' ? (
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
              <RootsMark />
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
              <div className="fin-home-heading">
                <div>
                  <h1>{greeting()}{p.first_name ? `, ${p.first_name}` : ''}</h1>
                  <p>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
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
              {overviewError && (
                <div className="fin-error fin-inline-retry" role="alert">
                  <span>Balances and activity could not load. {overviewError}</span>
                  <button className="fin-text" onClick={() => void loadOverview().catch(() => undefined)}>Try again</button>
                </div>
              )}
              <div className="fin-home-grid">
                <section className="fin-wallet-overview" aria-label="Your wallet overview">
                  <div className="fin-wallet-overview-top">
                    <span>Your balance</span>
                    {p.username && (
                      <button
                        className="fin-wallet-username"
                        onClick={() => void copyUsername()}
                        aria-label={`Copy your username @${p.username}`}
                      >
                        @{p.username} {copied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    )}
                  </div>
                  <div className="fin-wallet-amount">
                    <div>
                      <strong className={formattedWalletValue.length > 13 ? 'fin-amount-xlong' : formattedWalletValue.length > 10 ? 'fin-amount-long' : undefined}>{hidden ? '••••' : formattedWalletValue}</strong>
                      <button
                        aria-label={hidden ? 'Show balance' : 'Hide balance'}
                        onClick={() => setHidden(!hidden)}
                      >
                        {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                    <p>{hidden ? 'Your balances are hidden' : !overview ? 'Loading balances…' : walletValue === null
                      ? 'Wallet value temporarily unavailable' : o.wallet_value_usd?.checked_at
                        ? `Estimated in USD · Price checked ${new Date(o.wallet_value_usd.checked_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                        : 'Estimated in USD · See each balance below'}</p>
                  </div>
                  <button
                    className="fin-assets-pill"
                    onClick={() => document.getElementById('home-assets')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  >
                    {assets.length} assets <ChevronRight size={14} />
                  </button>
                </section>
                <section className="fin-pay-card" aria-labelledby="pay-card-title">
                  <RootsWatermark />
                  <h2 id="pay-card-title">Pay anyone on Roots</h2>
                  <form
                    className="fin-pay-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = payTo.trim();
                      go(value && payeePattern.test(value) ? `/personal/send?to=${encodeURIComponent(value)}` : '/personal/send');
                    }}
                  >
                    <Search size={18} aria-hidden="true" />
                    <input
                      value={payTo}
                      onChange={(e) => setPayTo(e.target.value)}
                      placeholder="@username or 0x…"
                      aria-label="Pay a Roots @username or QIE address"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <button aria-label="Continue to payment">
                      <ArrowRight size={18} />
                    </button>
                  </form>
                  {payees.length ? (
                    <ul className="fin-payees" aria-label="People you paid recently">
                      {payees.map((name) => (
                        <li key={name}>
                          <button onClick={() => go(`/personal/send?to=${encodeURIComponent('@' + name)}`)} aria-label={`Pay @${name} again`}>
                            <span className={`fin-payee-avatar fin-payee-tone-${tone(name)}`} aria-hidden="true">
                              {name.slice(0, 2).toUpperCase()}
                            </span>
                            <small>@{name}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="fin-payees-empty">People you pay appear here.</p>
                  )}
                </section>
                <div className="fin-quick-actions" aria-label="Money actions" role="group">
                  {quickActions.map(([key, label, Icon]) => (
                    <button key={key} onClick={() => go('/personal/' + key)}>
                      <Icon size={18} />
                      <b>{label}</b>
                    </button>
                  ))}
                </div>
                <section className="fin-home-activity" aria-labelledby="home-activity-title">
                  <div className="fin-section-head">
                    <h2 id="home-activity-title">Activity</h2>
                    {o.activity.length > 0 && (
                      <button className="fin-text" onClick={() => go('/personal/activity')}>
                        See all <ChevronRight size={14} />
                      </button>
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
                    <GetStarted profile={p} go={go} />
                  )}
                </section>
                <section className="fin-panel fin-home-assets" id="home-assets">
                  <div className="fin-section-head">
                    <h2>Assets</h2>
                  </div>
                  <div className="fin-assets-list">
                    {assets.map(asset => <button className="fin-asset-row" key={asset.code} onClick={() => go(`/personal/assets/${asset.code.toLowerCase()}`)} aria-label={`View ${asset.code} details, ${asset.name}, balance ${hidden ? 'hidden' : asset.amount_atomic === null ? 'unavailable' : `${assetAmount(asset)} ${asset.code}`}`}>
                      <AssetIcon code={asset.code} />
                      <span className="fin-asset-name"><b>{asset.code}</b><small>{asset.name}</small></span>
                      <span className="fin-asset-value"><b>{hidden ? '••••' : assetAmount(asset)}</b><small>{asset.status === 'ready' ? 'Onchain' : 'Unavailable'}</small></span>
                      <ChevronRight className="fin-asset-chevron" size={17} />
                    </button>)}
                  </div>
                </section>
              </div>
            </>
          )}
          {tab === 'assets' && (detailAsset
            ? <AssetDetail asset={detailAsset} activity={o.activity} go={go} hidden={hidden} refresh={() => void retry()} refreshing={refreshing} />
            : <div className="fin-panel"><h1>Asset not found</h1><button className="fin-secondary" onClick={() => go('/personal/home')}>Back to assets</button></div>)}
          {tab === 'payments' && (
            <>
              <PageHeading
                title="Payments"
              />
              <div className="fin-payment-tiles">
                {actions.map(([key, label, Icon]) => (
                  <button key={key} onClick={() => go('/personal/' + key)}>
                    <span>
                      <Icon size={25} />
                    </span>
                    <h2>{label}</h2>
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
                    <RootsMark /> <b>Roots</b> <span>Payment receipt</span>
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
          {tab === 'profile' && (
            <>
              <PageHeading
                title="Account"
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
                title="Security"
              />
              <ConsumerSecurity profile={p} csrf={csrf} onSaved={refresh} />
            </>
          )}
          {['identity', 'onboarding'].includes(tab) && (
            <>
              <PageHeading
                kicker={tab === 'onboarding' ? 'WELCOME TO ROOTS' : 'ACCOUNT VERIFICATION'}
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
            'assets',
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
function GetStarted({ profile, go }: { profile: ConsumerProfile; go: (path: string) => void }) {
  const [approval, setApproval] = useState<boolean>();
  useEffect(() => {
    void consumerRequest<PaymentAuthStatus>('payment-auth')
      .then((status) => setApproval(status.pin_set || status.passkeys.length > 0))
      .catch(() => setApproval(false));
  }, []);
  const steps = [
    { label: 'Verify your email', done: !!profile.email_verified_at, path: '/personal/security' },
    { label: 'Set up a passkey or PIN', done: !!approval, path: '/personal/security' },
    { label: 'Add money', done: false, path: '/personal/deposit' },
  ];
  const done = steps.filter((step) => step.done).length;
  return (
    <div className="fin-get-started">
      <div className="fin-get-started-head">
        <b>Get started</b>
        <span>{done} of {steps.length}</span>
      </div>
      <i className="fin-get-started-bar"><i style={{ width: `${(done / steps.length) * 100}%` }} /></i>
      {steps.map((step) => (
        <button key={step.label} className={step.done ? 'done' : ''} onClick={() => go(step.path)} disabled={step.done}>
          {step.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
          <span>{step.label}</span>
          {!step.done && <ChevronRight size={16} />}
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
  // A recipient chosen on Home (?to=@name or ?to=0x…) prefills the send form.
  const [initialRecipient] = useState(() => {
    const to = new URLSearchParams(window.location.search).get('to')?.trim() ?? '';
    return payeePattern.test(to) ? to : '';
  });
  // ?asset=qusdc opens Send or Receive on that token.
  const [initialToken] = useState<'QIE' | 'QUSDC'>(() =>
    new URLSearchParams(window.location.search).get('asset')?.toUpperCase() === 'QUSDC' ? 'QUSDC' : 'QIE');
  const capability = capabilities?.[kind === 'convert' ? 'conversion' : 'withdrawal'];
  // Add money: crypto to a wallet address, or naira by bank (and card where the provider offers it).
  const [method, setMethod] = useState<'crypto' | 'bank'>(() =>
    new URLSearchParams(window.location.search).get('method') === 'bank' ? 'bank' : 'crypto');
  const back = (
    <button className="fin-text fin-back" onClick={() => go('/personal/payments')}>
      <ArrowLeft size={16} /> Payments
    </button>
  );
  if (kind === 'deposit' || kind === 'send')
    return (
      <div className={`fin-flow-narrow fin-flow-${kind}`}>
        {back}
        {kind === 'send' && <h1 className="fin-flow-title">Send</h1>}
        {kind === 'deposit' && (
          <div className="fin-add-method" role="group" aria-label="Add money with">
            <button type="button" className={method === 'crypto' ? 'active' : ''} aria-pressed={method === 'crypto'} onClick={() => setMethod('crypto')}>
              <Globe2 size={18} /> Crypto
            </button>
            <button type="button" className={method === 'bank' ? 'active' : ''} aria-pressed={method === 'bank'} onClick={() => setMethod('bank')}>
              <CreditCard size={18} /> Bank / card
            </button>
          </div>
        )}
        {kind === 'deposit' && method === 'bank' ? (
          capabilities?.conversion?.available ? (
            <section className="fin-panel fin-add-bank" aria-label="Add money by bank">
              <h1>Buy with naira</h1>
              <ConversionPanel csrf={csrf} buyOnly />
            </section>
          ) : (
            <div className="fin-method-detail fin-add-bank">
              <span className="fin-method-icon"><CreditCard size={30} /></span>
              <h1>Bank and card</h1>
              <p>{capabilities?.fiat_deposit?.reason ?? 'Not available yet.'}</p>
              <span className="fin-status">Not available</span>
            </div>
          )
        ) : (
          <ConsumerChainWallet
            csrf={csrf}
            mode={kind === 'send' ? 'send' : 'receive'}
            onChanged={onChanged}
            initialRecipient={kind === 'send' ? initialRecipient : ''}
            initialToken={initialToken}
            go={go}
          />
        )}
      </div>
    );
  return (
    <>
      {back}
      <PageHeading title={kind === 'convert' ? 'Convert' : 'Withdraw'} />
      <div className="fin-flow-layout">
        <section className="fin-panel fin-flow">
          {kind === 'convert' && capability?.available ? (
            <ConversionPanel csrf={csrf} />
          ) : (
            <div className="fin-method-detail">
              <span className="fin-method-icon">
                {kind === 'convert' ? <ArrowLeftRight size={30} /> : <ArrowDownLeft size={30} />}
              </span>
              <h2>{kind === 'convert' ? 'Currency exchange' : 'Bank withdrawal'}</h2>
              <p>{capability?.reason ?? 'Not available yet.'}</p>
              <span className="fin-status">Not available</span>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
