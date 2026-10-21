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
import {
  consumerRequest,
  isSessionExpired,
  sessionExpiredEvent,
  type ConsumerProfile,
} from './consumer-api.js';
import { logoutPrivyIfMounted } from './auth-shell.js';
import { MicrosendrMark } from './microsendr-logo.js';
import { ConsumerChainWallet } from './consumer-chain-wallet.js';
import { AssetDetail, AssetIcon, assetAmount, assetDefaults, type PersonalAsset } from './personal-assets.js';

type Session = { authenticated: boolean; csrf_token?: string; email?: string; account_id?: string };
type Capability = { available: boolean; reason: string };
type Movement = {
  id: string;
  status: string;
  to: string;
  amount_atomic: string;
  asset: string;
  decimals: number | null;
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
// Personal activity rows are chain settlements: outbound native transfers from a linked wallet.
const movementTitle = (item: Movement) => `Sent ${assetLabel(item.asset)}`;
const shortAddress = (value: string) =>
  value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const formatAmount = (item: Movement) => {
  if (item.decimals === null || item.decimals === undefined)
    return `${item.amount_atomic} base units of`;
  const unit = 10n ** BigInt(item.decimals);
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
    [refreshing, setRefreshing] = useState(false),
    [signInNotice, setSignInNotice] = useState('');
  const rawTab = path.split('/')[2]?.split('?')[0] || 'home';
  const tab = rawTab === 'login' ? 'home' : rawTab === 'money' ? 'deposit' : rawTab;
  const assetCode = path.split('/')[3]?.split('?')[0]?.toUpperCase();
  const navTab = tab === 'assets' ? 'home' : ['profile', 'identity', 'security', 'onboarding'].includes(tab)
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
  useEffect(() => {
    if (tab !== 'activity') setSelected(null);
    setError('');
    window.scrollTo(0, 0);
  }, [tab]);
  // Poll the overview only while the page is visible; a 401 fires the session-expired handler.
  useEffect(() => {
    if (!session?.authenticated) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      void consumerRequest<Overview>('overview')
        .then((next) => {
          if (active) setOverview(next);
        })
        .catch(() => undefined);
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
    o = overview!,
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
      `${item.id} ${item.to} ${movementTitle(item)} ${statusLabel(item.status)}`
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
              <b>{movementTitle(item)}</b>
              <small>
                {new Date(item.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                · To {shortAddress(item.to)}
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
                  <span className="fin-wallet-username">@{p.username}</span>
                </div>
                <div className="fin-wallet-amount">
                  <span>Estimated wallet value · USD</span>
                  <div>
                    <strong>{hidden ? '••••' : formattedWalletValue}</strong>
                    <button
                      aria-label={hidden ? 'Show balance' : 'Hide balance'}
                      onClick={() => setHidden(!hidden)}
                    >
                      {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  <p>{hidden ? 'Your balances are hidden' : walletValue === null
                    ? 'Wallet value temporarily unavailable' : o.wallet_value_usd?.checked_at
                      ? `Approximate value · Price checked ${new Date(o.wallet_value_usd.checked_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : 'Approximate value · See each balance below'}</p>
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
              <section className="fin-panel fin-home-assets">
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
            </>
          )}
          {tab === 'assets' && (detailAsset
            ? <AssetDetail asset={detailAsset} activity={o.activity} go={go} hidden={hidden} refresh={() => void retry()} refreshing={refreshing} />
            : <div className="fin-panel"><h1>Asset not found</h1><button className="fin-secondary" onClick={() => go('/personal/home')}>Back to assets</button></div>)}
          {tab === 'payments' && (
            <>
              <PageHeading
                kicker="MOVE MONEY"
                title="Your next move."
                text="Send QIE from a linked wallet. More money services are on the way."
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
                          'Receive QIE to a wallet you link.',
                          'Send native QIE from a linked wallet.',
                          'Currency exchange is not available yet.',
                          'Bank withdrawals are not available yet.',
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
                    <h2>{movementTitle(receipt)}</h2>
                    <button className="fin-text" onClick={() => setSelected(null)}>
                      Close
                    </button>
                  </div>
                  <dl>
                    {Object.entries({
                      Status: statusLabel(receipt.status),
                      Amount: `${formatAmount(receipt)} ${assetLabel(receipt.asset)}`,
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
            'assets',
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
  // "Crypto transfer" shows only wallets the user links and controls; never the managed account wallet.
  const [method, setMethod] = useState<'crypto' | 'bank'>('crypto');
  const capability =
    capabilities?.[
      kind === 'deposit'
        ? 'fiat_deposit'
        : kind === 'convert'
          ? 'conversion'
          : 'withdrawal'
    ];
  const title =
    kind === 'deposit'
      ? 'Add money.'
      : kind === 'convert'
        ? 'Convert currencies.'
        : kind === 'send'
          ? 'Who are you paying?'
          : 'Withdraw to your bank.';
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
            ? 'Currency exchange is not available yet.'
            : kind === 'deposit'
              ? 'Receive QIE to a wallet you link, or check local funding.'
              : kind === 'send'
                ? 'Send native QIE from a wallet you link, on QIE Mainnet.'
                : 'Bank withdrawals are not available yet.'
        }
      />
      <div className="fin-flow-layout">
        <section className="fin-panel fin-flow">
          {kind === 'deposit' && (
            <div className="fin-methods" role="group" aria-label="Deposit method">
              <button
                type="button"
                className={method === 'bank' ? 'active' : ''}
                aria-pressed={method === 'bank'}
                onClick={() => setMethod('bank')}
              >
                <CreditCard size={20} /> Bank / card
              </button>
              <button
                type="button"
                className={method === 'crypto' ? 'active' : ''}
                aria-pressed={method === 'crypto'}
                onClick={() => setMethod('crypto')}
              >
                <Globe2 size={20} /> Crypto transfer
              </button>
            </div>
          )}
          {kind === 'send' || (kind === 'deposit' && method === 'crypto') ? (
            <ConsumerChainWallet
              csrf={csrf}
              mode={kind === 'send' ? 'send' : 'receive'}
              onChanged={onChanged}
            />
          ) : (
            <div className="fin-method-detail">
              <span className="fin-method-icon">
                {kind === 'deposit' ? (
                  <CreditCard size={30} />
                ) : kind === 'convert' ? (
                  <ArrowLeftRight size={30} />
                ) : (
                  <ArrowDownLeft size={30} />
                )}
              </span>
              <h2>
                {kind === 'deposit'
                  ? 'Local deposits'
                  : kind === 'convert'
                    ? 'Currency exchange'
                    : 'Bank withdrawal'}
              </h2>
              <p>{capability?.reason ?? 'This payment method is not available yet.'}</p>
              <span className="fin-status">Not available</span>
              {kind === 'convert' && (
                <p className="fin-small">
                  No exchange is offered and no funds are moved here. A digital-dollar balance is
                  an asset balance, not a bank deposit.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
