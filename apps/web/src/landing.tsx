import React, { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  AtSign,
  BadgeCheck,
  Check,
  ChevronDown,
  Clock,
  Fingerprint,
  House,
  KeyRound,
  Landmark,
  LineChart,
  Menu,
  Receipt,
  Repeat2,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import './landing.css';

type Props = {
  brand: ReactNode;
  go: (path: string) => void;
};

const navigation = [
  { id: 'product', label: 'Product' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'security', label: 'Security' },
  { id: 'questions', label: 'FAQs' },
] as const;

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------------------------------
 * Product tour. Every panel states plainly whether the feature is live or coming soon.
 * ---------------------------------------------------------------------------------------- */
const tour = {
  Send: {
    status: 'available',
    title: 'Pay people, not long addresses.',
    text: 'Send QIE or QUSDC on QIE Mainnet to another Microsendr user by their @username, or to any QIE address. Every send from your Microsendr account is approved with your PIN or a passkey.',
    points: [
      'Look up a Microsendr user by @username and see their name before you pay',
      'Or paste any QIE Mainnet wallet address',
      'Send from your Microsendr account, or from a wallet you link',
    ],
  },
  Receive: {
    status: 'available',
    title: 'Payments that show up on their own.',
    text: 'Incoming QIE and QUSDC payments appear in Activity automatically, checked against the QIE network, with a receipt for each one.',
    points: [
      'QIE and QUSDC (digital dollars on QIE) supported',
      'Every incoming payment verified on chain',
      'Live balances with an approximate USD value',
    ],
  },
  Exchange: {
    status: 'soon',
    title: 'Know what you’ll get.',
    text: 'Buying digital dollars with naira is coming soon. You will see every fee and the exact amount you receive before you confirm.',
    points: ['Naira to digital dollars, every fee shown', 'Not available yet'],
  },
  Withdraw: {
    status: 'soon',
    title: 'From your screen to real life.',
    text: 'Bank deposits and withdrawals are coming soon, so you can move money between Microsendr and a bank account you own.',
    points: ['Deposits from and withdrawals to your bank', 'Not available yet'],
  },
} as const;
type TourKey = keyof typeof tour;
const tourKeys = Object.keys(tour) as TourKey[];

const pillars = [
  {
    icon: AtSign,
    title: 'Pay by @username',
    text: 'Send to people on Microsendr by name, instead of copying a long wallet address.',
  },
  {
    icon: KeyRound,
    title: 'An account wallet, ready to use',
    text: 'Every account gets its own QIE address. Prefer self-custody? Link your own wallet too.',
  },
  {
    icon: BadgeCheck,
    title: 'Verified on chain',
    text: 'Incoming QIE and QUSDC payments land in Activity with a receipt.',
  },
  {
    icon: LineChart,
    title: 'Live balances',
    text: 'See what is in your wallet, with an approximate value in US dollars.',
  },
];

const steps = [
  {
    title: 'Create your free account',
    text: 'Sign up with your email and a password. Your account comes with its own wallet address.',
  },
  {
    title: 'Set up your profile',
    text: 'Choose a username, set a payment PIN or passkey, and verify your identity.',
  },
  {
    title: 'Send, receive and track',
    text: 'Pay people by @username, send QIE or QUSDC, and watch incoming payments arrive in Activity.',
  },
];

const security = [
  {
    icon: KeyRound,
    title: 'Every send approved by you',
    text: 'Sends from your Microsendr account need your payment PIN or a passkey, with limits per transfer and per day. A wallet you link stays yours; Microsendr never sees its keys.',
  },
  {
    icon: BadgeCheck,
    title: 'Checked on chain',
    text: 'Incoming payments are matched against the QIE network before they appear in your Activity, each with a receipt.',
  },
  {
    icon: AtSign,
    title: 'Opt-in usernames',
    text: 'Nobody can pay you by @username until you switch it on. You can turn it off again in your settings.',
  },
  {
    icon: Fingerprint,
    title: 'Identity checks',
    text: 'Verify your identity with our provider Didit before you send from your Microsendr account. Your document is matched to your profile.',
  },
];

const availability: { name: string; detail: string; soon?: boolean }[] = [
  { name: 'Personal account & profile', detail: 'Free account with email and password, profile and security settings' },
  { name: 'Identity verification', detail: 'Provided by Didit; needed to send from your Microsendr account' },
  { name: 'Linked self-custody wallet', detail: 'Any EVM wallet you control, on QIE Mainnet' },
  { name: 'Microsendr account wallet', detail: 'Your own QIE address, sends approved with a PIN or passkey' },
  { name: 'Send and receive QIE and QUSDC', detail: 'On QIE Mainnet, from your account or a linked wallet' },
  { name: 'Incoming QIE & QUSDC in Activity', detail: 'Verified on chain, with receipts' },
  { name: 'Pay Microsendr users by @username', detail: 'Recipients opt in to be payable by username' },
  { name: 'Live balances', detail: 'With an approximate USD value' },
  { name: 'Bank deposits & withdrawals', detail: 'Move money to and from your bank', soon: true },
  { name: 'Buy digital dollars with naira', detail: 'By bank transfer, every fee shown first', soon: true },
  { name: 'P2P trading marketplace', detail: 'Trade with other Microsendr users', soon: true },
];

const questions: [string, string][] = [
  [
    'What can I do on Microsendr today?',
    'You can open a free Microsendr account with its own QIE address, send and receive QIE and QUSDC on QIE Mainnet, pay other Microsendr users by @username, and see incoming payments in Activity with receipts. You can also link a self-custody wallet you control. Bank deposits and withdrawals, buying digital dollars with naira and the P2P marketplace are coming soon.',
  ],
  [
    'Is Microsendr a bank?',
    'No. Microsendr is not a bank, and money in your wallet is not a bank deposit. Digital assets such as QIE and QUSDC are not covered by deposit insurance or protection schemes.',
  ],
  [
    'Do I need a crypto wallet to sign up?',
    'No. You create your Microsendr account with an email address and a password, and it comes with its own QIE address. Linking a self-custody wallet is optional.',
  ],
  [
    'Who holds the keys to my wallet?',
    'Your Microsendr account wallet is held for you by our wallet provider, Privy, and every send needs your payment PIN or a passkey. A self-custody wallet you link is different: its keys stay with you and Microsendr never holds them.',
  ],
  [
    'How does paying by @username work?',
    'Search for a Microsendr user by their username and check their name before you send. People can only be paid this way after they choose to be payable by username in their settings.',
  ],
  [
    'What is QUSDC?',
    'QUSDC is a digital dollar on the QIE network. You can hold, send and receive it in Microsendr alongside QIE.',
  ],
  [
    'Do I have to verify my identity?',
    'To send from your Microsendr account, yes. You verify with our identity provider, Didit, from your account, and the document must match the name and date of birth on your profile.',
  ],
  [
    'Can a payment be reversed?',
    'No. Transfers on the QIE network are final once confirmed and cannot be reversed by you or by Microsendr. Always check the recipient and amount before you approve.',
  ],
];

/* ------------------------------------------------------------------------------------------
 * Small presentational pieces
 * ---------------------------------------------------------------------------------------- */
function Status({ soon }: { soon?: boolean }) {
  return soon ? (
    <span className="lp-badge lp-badge-soon">
      <Clock size={13} aria-hidden="true" /> Coming soon
    </span>
  ) : (
    <span className="lp-badge lp-badge-live">
      <Check size={13} aria-hidden="true" /> Available
    </span>
  );
}

function Token({ symbol }: { symbol: 'QIE' | 'QUSDC' }) {
  return (
    <span className={symbol === 'QIE' ? 'lp-token lp-token-qie' : 'lp-token lp-token-usd'} aria-hidden="true">
      {symbol === 'QIE' ? 'Q' : '$'}
    </span>
  );
}

/** Phone mockup built in HTML/CSS. Purely illustrative; hidden from assistive tech as a whole. */
function PhonePreview() {
  return (
    <div className="lp-phone" aria-hidden="true">
      <div className="lp-phone-bar">
        <span>9:41</span>
        <span className="lp-phone-island" />
        <span className="lp-phone-signal">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="lp-phone-screen">
        <div className="lp-phone-head">
          <div>
            <small>Good morning</small>
            <b>Ada</b>
          </div>
          <span className="lp-phone-avatar">A</span>
        </div>
        <div className="lp-phone-balance">
          <small>Wallet balance</small>
          <strong>
            ≈ $1,284<span>.50</span>
          </strong>
          <div className="lp-phone-assets">
            <span>
              <Token symbol="QIE" /> 1,034.50 QIE
            </span>
            <span>
              <Token symbol="QUSDC" /> 250.00 QUSDC
            </span>
          </div>
        </div>
        <div className="lp-phone-actions">
          <span>
            <i>
              <ArrowUpRight size={16} />
            </i>
            Send
          </span>
          <span>
            <i>
              <ArrowDownLeft size={16} />
            </i>
            Receive
          </span>
          <span>
            <i>
              <AtSign size={16} />
            </i>
            Pay
          </span>
          <span className="is-soon">
            <i>
              <Repeat2 size={16} />
            </i>
            Soon
          </span>
        </div>
        <div className="lp-phone-list">
          <b>Activity</b>
          <div className="lp-phone-row">
            <span className="lp-phone-icon is-in">
              <ArrowDownLeft size={14} />
            </span>
            <div>
              <b>Received QUSDC</b>
              <small>
                <BadgeCheck size={11} /> Verified on chain
              </small>
            </div>
            <em className="is-in">+250.00</em>
          </div>
          <div className="lp-phone-row">
            <span className="lp-phone-icon">
              <AtSign size={14} />
            </span>
            <div>
              <b>Paid @amara</b>
              <small>QIE · Today</small>
            </div>
            <em>−40.00</em>
          </div>
          <div className="lp-phone-row">
            <span className="lp-phone-icon is-in">
              <ArrowDownLeft size={14} />
            </span>
            <div>
              <b>Received QIE</b>
              <small>
                <BadgeCheck size={11} /> Verified on chain
              </small>
            </div>
            <em className="is-in">+120.00</em>
          </div>
        </div>
        <div className="lp-phone-nav">
          <span className="is-active">
            <House size={16} />
            Home
          </span>
          <span>
            <Receipt size={16} />
            Activity
          </span>
          <span>
            <UserRound size={16} />
            Account
          </span>
        </div>
      </div>
    </div>
  );
}

function TourVisual({ name }: { name: TourKey }) {
  if (name === 'Send')
    return (
      <div className="lp-ui-card" aria-hidden="true">
        <div className="lp-ui-head">
          <b>Send QIE</b>
          <small>QIE Mainnet</small>
        </div>
        <div className="lp-ui-field">
          <small>To</small>
          <div className="lp-ui-recipient">
            <span className="lp-phone-avatar is-small">A</span>
            <div>
              <b>Amara O.</b>
              <small>@amara</small>
            </div>
            <BadgeCheck size={16} className="lp-ui-ok" />
          </div>
        </div>
        <div className="lp-ui-field">
          <small>Amount</small>
          <div className="lp-ui-amount">
            40.00 <span>QIE</span>
          </div>
        </div>
        <div className="lp-ui-button">Review in your wallet</div>
        <p className="lp-ui-note">
          <TriangleAlert size={13} /> Transfers on QIE are final once confirmed.
        </p>
      </div>
    );
  if (name === 'Receive')
    return (
      <div className="lp-ui-card" aria-hidden="true">
        <div className="lp-ui-head">
          <b>Receipt</b>
          <span className="lp-ui-pill">
            <BadgeCheck size={12} /> Verified on chain
          </span>
        </div>
        <div className="lp-ui-received">
          <Token symbol="QUSDC" />
          <strong>+250.00 QUSDC</strong>
          <small>≈ $250.00</small>
        </div>
        <dl className="lp-ui-list">
          <div>
            <dt>From</dt>
            <dd>0x8f3…a21c</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>QIE Mainnet</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>Confirmed</dd>
          </div>
        </dl>
      </div>
    );
  return (
    <div className="lp-ui-card is-soon" aria-hidden="true">
      <div className="lp-ui-head">
        <b>{name === 'Exchange' ? 'Convert' : 'Withdraw'}</b>
        <span className="lp-ui-pill is-soon">
          <Clock size={12} /> Coming soon
        </span>
      </div>
      {name === 'Exchange' ? (
        <div className="lp-ui-convert">
          <div>
            <small>You convert</small>
            <b>NGN</b>
          </div>
          <span>
            <Repeat2 size={16} />
          </span>
          <div>
            <small>You receive</small>
            <b>USD</b>
          </div>
        </div>
      ) : (
        <div className="lp-ui-convert">
          <div>
            <small>From</small>
            <b>Microsendr</b>
          </div>
          <span>
            <ArrowRight size={16} />
          </span>
          <div>
            <small>To</small>
            <b>
              <Landmark size={15} /> Your bank
            </b>
          </div>
        </div>
      )}
      <div className="lp-ui-skeleton">
        <i />
        <i />
      </div>
      <div className="lp-ui-button is-disabled">Not available yet</div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------------------------- */
export function LandingPage({ brand, go }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const [motion, setMotion] = useState(false);
  const [active, setActive] = useState<TourKey>('Send');
  // "My account" reflects the Personal session, not the retired Business console session.
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch('/personal/api/session', { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : { authenticated: false }))
      .then((session) => {
        if (live) setAuthenticated(session?.authenticated === true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    document.title = 'Microsendr | Money for the life you’re building.';
  }, []);

  // Header condenses once the top-of-page sentinel scrolls away.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(([entry]) => setCondensed(!entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  // Reveal-on-scroll, only when motion is welcome. Content is visible by default without JS.
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function' || typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const container = root.current;
    if (!motion || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    container.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [motion]);

  // Mobile menu: Escape closes and returns focus; clicks outside close; first link takes focus.
  useEffect(() => {
    if (!menu) return;
    root.current?.querySelector<HTMLAnchorElement>('#landing-navigation a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        toggle.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const header = root.current?.querySelector('.lp-header');
      if (header && !header.contains(event.target as Node)) setMenu(false);
    };
    const desktop = matchMedia('(min-width: 961px)');
    const onResize = () => desktop.matches && setMenu(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    desktop.addEventListener('change', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      desktop.removeEventListener('change', onResize);
    };
  }, [menu]);

  const scrollToSection = useCallback((id: string, smooth: boolean) => {
    const target = document.getElementById(id);
    if (!target) return false;
    target.scrollIntoView({ behavior: smooth && !reduceMotion() ? 'smooth' : 'auto', block: 'start' });
    target.focus({ preventScroll: true });
    return true;
  }, []);

  // Honour a hash on first load (the page renders after the browser's own anchor jump).
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) requestAnimationFrame(() => scrollToSection(id, false));
  }, [scrollToSection]);

  const jump = (event: MouseEvent<HTMLAnchorElement>) => {
    const id = event.currentTarget.hash.slice(1);
    if (!id || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    setMenu(false);
    if (scrollToSection(id, true)) {
      event.preventDefault();
      if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    }
  };

  // Get started opens sign-up; Sign in opens sign-in.
  const start = () => go(authenticated ? '/personal/home' : '/personal/register');
  const signIn = () => go(authenticated ? '/personal/home' : '/personal/login');
  const startLabel = authenticated ? 'Open your account' : 'Get started';
  const current = tour[active];

  return (
    <div
      ref={root}
      className={`ms-site lp-site${motion ? ' lp-motion' : ''}${menu ? ' lp-menu-is-open' : ''}`}
    >
      <a className="lp-skip" href="#main-content">
        Skip to content
      </a>
      <div ref={sentinel} className="lp-sentinel" aria-hidden="true" />
      <header className={`public-header lp-header${condensed ? ' is-condensed' : ''}`}>
        <div className="lp-container lp-header-inner">
          <a className="lp-brand" href="/" aria-label="Microsendr home">
            {brand}
          </a>
          <div className="lp-menu-panel" id="landing-menu">
            <nav aria-label="Main navigation" id="landing-navigation" className="lp-nav">
              {navigation.map((item) => (
                <a key={item.id} href={`#${item.id}`} onClick={jump}>
                  {item.label}
                </a>
              ))}
            </nav>
            <button className="lp-button lp-menu-cta" onClick={start}>
              {startLabel} <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="lp-header-actions">
            <button className="lp-signin" onClick={signIn}>
              {authenticated ? 'My account' : 'Sign in'}
            </button>
            {!authenticated && (
              <button className="lp-button lp-button-sm lp-header-cta" onClick={start}>
                Get started
              </button>
            )}
            <button
              ref={toggle}
              className="lp-menu-toggle"
              aria-label={menu ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menu}
              aria-controls="landing-menu"
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        {/* Hero */}
        <section className="lp-hero" aria-labelledby="landing-title">
          <div className="lp-container lp-hero-grid">
            <div className="lp-hero-copy">
              <a className="lp-kicker" href="#pay" onClick={jump}>
                <span className="lp-kicker-dot" aria-hidden="true" />
                New: pay people on Microsendr by @username
                <ArrowRight size={14} aria-hidden="true" />
              </a>
              <h1 id="landing-title">
                Money for the life you’re <span>building.</span>
              </h1>
              <p className="lp-lead">
                Microsendr is a free account for everyday digital money on the QIE network. Pay people by
                @username, send from a wallet you control, and see every incoming payment verified on
                chain.
              </p>
              <div className="lp-hero-actions">
                <button className="lp-button lp-button-lg" onClick={start}>
                  {startLabel} <ArrowRight size={18} aria-hidden="true" />
                </button>
                <a className="lp-button-secondary lp-button-lg" href="#how-it-works" onClick={jump}>
                  See how it works
                </a>
              </div>
              <ul className="lp-hero-facts" aria-label="Good to know">
                <li>
                  <Check size={15} aria-hidden="true" /> Free to open
                </li>
                <li>
                  <Check size={15} aria-hidden="true" /> No wallet needed to sign up
                </li>
                <li>
                  <Check size={15} aria-hidden="true" /> Your keys stay yours
                </li>
              </ul>
            </div>
            <figure className="lp-hero-visual" aria-label="Illustrative preview of the Microsendr app">
              <div className="lp-hero-stage" aria-hidden="true">
                <span className="lp-hero-ring" />
              </div>
              <PhonePreview />
              <div className="lp-float-card lp-floating lp-float-received" aria-hidden="true">
                <span className="lp-floating-icon is-in">
                  <ArrowDownLeft size={16} />
                </span>
                <div>
                  <b>Payment received</b>
                  <small>+250.00 QUSDC · Verified on chain</small>
                </div>
              </div>
              <div className="lp-float-card lp-float-user" aria-hidden="true">
                <span className="lp-phone-avatar is-small">A</span>
                <div>
                  <b>@amara</b>
                  <small>Payable by username</small>
                </div>
                <BadgeCheck size={16} className="lp-ui-ok" />
              </div>
              <figcaption className="lp-preview-label">Illustrative preview · sample data</figcaption>
            </figure>
          </div>
        </section>

        {/* Value pillars */}
        <section className="lp-pillars" aria-label="Why Microsendr">
          <div className="lp-container">
            <ul className="lp-pillar-grid">
              {pillars.map(({ icon: Icon, title, text }, index) => (
                <li key={title} data-reveal style={{ '--reveal-delay': `${index * 70}ms` } as React.CSSProperties}>
                  <span className="lp-icon">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Product tour */}
        <section className="lp-section" id="product" tabIndex={-1} aria-labelledby="product-title">
          <div className="lp-container">
            <div className="lp-heading" data-reveal>
              <span className="lp-eyebrow">Product</span>
              <h2 id="product-title">One account for everyday digital money.</h2>
              <p>
                Here is what Microsendr does today, and what is on the way. Anything that isn’t live yet is
                marked <strong>Coming soon</strong>.
              </p>
            </div>
            <div className="lp-tour" data-reveal>
              <div className="lp-tabs" role="tablist" aria-label="Microsendr features">
                {tourKeys.map((name, index) => (
                  <button
                    key={name}
                    role="tab"
                    id={`tab-${name}`}
                    aria-selected={active === name}
                    aria-controls="product-panel"
                    tabIndex={active === name ? 0 : -1}
                    onClick={() => setActive(name)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const count = tourKeys.length;
                      const next =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? count - 1
                            : (index + (event.key === 'ArrowRight' ? 1 : count - 1)) % count;
                      setActive(tourKeys[next]);
                      document.getElementById(`tab-${tourKeys[next]}`)?.focus();
                    }}
                  >
                    {name}
                    {tour[name].status === 'soon' && <span className="lp-tab-dot" aria-hidden="true" />}
                  </button>
                ))}
              </div>
              <div
                className="lp-panel"
                id="product-panel"
                role="tabpanel"
                aria-labelledby={`tab-${active}`}
                tabIndex={0}
              >
                <div className="lp-panel-copy" key={`copy-${active}`}>
                  <Status soon={current.status === 'soon'} />
                  <h3>{current.title}</h3>
                  <p>{current.text}</p>
                  <ul className="lp-checklist">
                    {current.points.map((point) => (
                      <li key={point}>
                        {current.status === 'soon' ? (
                          <Clock size={16} aria-hidden="true" />
                        ) : (
                          <Check size={16} aria-hidden="true" />
                        )}
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="lp-panel-visual" key={`visual-${active}`}>
                  <TourVisual name={active} />
                  <small className="lp-preview-label">Illustrative preview</small>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* P2P payments */}
        <section className="lp-section lp-pay" id="pay" tabIndex={-1} aria-labelledby="pay-title">
          <div className="lp-container lp-split">
            <div className="lp-photo" data-reveal>
              <img
                src="/images/payment-cafe.webp"
                alt="A customer paying at a café counter"
                loading="lazy"
                decoding="async"
                width="1280"
                height="1920"
              />
              <div className="lp-photo-card" aria-hidden="true">
                <span className="lp-phone-avatar is-small">A</span>
                <div>
                  <b>Pay @amara</b>
                  <small>Amara O. · 40.00 QIE</small>
                </div>
                <span className="lp-photo-card-action">
                  <ArrowUpRight size={16} />
                </span>
              </div>
            </div>
            <div className="lp-split-copy" data-reveal>
              <span className="lp-eyebrow">Payments between people</span>
              <h2 id="pay-title">Pay anyone on Microsendr by their @username.</h2>
              <p>
                No more copying long wallet addresses. Type a username, check the name that comes back,
                and approve the payment in your wallet. It arrives as QIE on QIE Mainnet.
              </p>
              <ul className="lp-checklist lp-checklist-lg">
                <li>
                  <Check size={18} aria-hidden="true" />
                  <span>
                    <b>See who you’re paying.</b> Microsendr shows the recipient’s name before you send.
                  </span>
                </li>
                <li>
                  <Check size={18} aria-hidden="true" />
                  <span>
                    <b>Opt in to be paid.</b> Your username can’t receive payments until you turn it on.
                  </span>
                </li>
                <li>
                  <Check size={18} aria-hidden="true" />
                  <span>
                    <b>Tracked for both sides.</b> Payments show up in Activity with a receipt.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="lp-section lp-steps-section" id="how-it-works" tabIndex={-1} aria-labelledby="steps-title">
          <div className="lp-container">
            <div className="lp-heading lp-heading-center" data-reveal>
              <span className="lp-eyebrow">How it works</span>
              <h2 id="steps-title">Up and running in three steps.</h2>
            </div>
            <ol className="lp-steps">
              {steps.map((step, index) => (
                <li key={step.title} data-reveal style={{ '--reveal-delay': `${index * 90}ms` } as React.CSSProperties}>
                  <span className="lp-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </li>
              ))}
            </ol>
            <div className="lp-center" data-reveal>
              <button className="lp-button" onClick={start}>
                {authenticated ? 'Open your account' : 'Create your free account'}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="lp-section lp-security" id="security" tabIndex={-1} aria-labelledby="security-title">
          <div className="lp-container">
            <div className="lp-security-grid">
              <div className="lp-heading lp-heading-invert" data-reveal>
                <span className="lp-eyebrow">Security &amp; control</span>
                <h2 id="security-title">You stay in control of your money.</h2>
                <p>
                  Microsendr is built so that you approve what leaves your wallet, and so that what arrives is
                  checked before you see it.
                </p>
                <div className="lp-callout">
                  <ShieldCheck size={20} aria-hidden="true" />
                  <p>
                    Transfers on the QIE network are final once confirmed. Always check the recipient
                    and amount before you approve.
                  </p>
                </div>
              </div>
              <ul className="lp-security-list">
                {security.map(({ icon: Icon, title, text }, index) => (
                  <li key={title} data-reveal style={{ '--reveal-delay': `${index * 70}ms` } as React.CSSProperties}>
                    <span className="lp-icon lp-icon-invert">
                      <Icon size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Availability */}
        <section className="lp-section" id="availability" tabIndex={-1} aria-labelledby="availability-title">
          <div className="lp-container lp-availability-grid">
            <div className="lp-heading" data-reveal>
              <span className="lp-eyebrow">Availability</span>
              <h2 id="availability-title">What’s live, and what’s next.</h2>
              <p>
                We’d rather be clear than clever. This is exactly where Microsendr stands today. We’ll update
                this list as new services launch.
              </p>
            </div>
            <div className="lp-table-card" data-reveal>
              <table className="lp-table">
                <caption className="lp-visually-hidden">Microsendr features and their availability</caption>
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {availability.map((row) => (
                    <tr key={row.name} className={row.soon ? 'is-soon' : undefined}>
                      <th scope="row">
                        <span>{row.name}</span>
                        <small>{row.detail}</small>
                      </th>
                      <td>
                        <Status soon={row.soon} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="lp-section lp-faq" id="questions" tabIndex={-1} aria-labelledby="faq-title">
          <div className="lp-container lp-faq-grid">
            <div className="lp-heading" data-reveal>
              <span className="lp-eyebrow">FAQs</span>
              <h2 id="faq-title">Questions, answered.</h2>
              <p>Straight answers about what Microsendr is, and what it isn’t.</p>
            </div>
            <div className="lp-faq-list" data-reveal>
              {questions.map(([question, answer]) => (
                <details key={question}>
                  <summary>
                    {question}
                    <ChevronDown size={18} aria-hidden="true" />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="lp-section lp-final" aria-labelledby="final-title">
          <div className="lp-container">
            <div className="lp-final-card" data-reveal>
              <h2 id="final-title">Start with a free Microsendr account.</h2>
              <p>Sign up with your email address. Link a wallet whenever you’re ready.</p>
              <div className="lp-final-actions">
                <button className="lp-button lp-button-light lp-button-lg" onClick={start}>
                  {startLabel} <ArrowRight size={18} aria-hidden="true" />
                </button>
                <a className="lp-button-ghost lp-button-lg" href="#questions" onClick={jump}>
                  Read the FAQs
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-top">
            <div className="lp-footer-brand">
              {brand}
              <p>Everyday digital money on the QIE network.</p>
            </div>
            <nav aria-label="Footer navigation" className="lp-footer-nav">
              <div>
                <h3>Microsendr</h3>
                <a href="#product" onClick={jump}>
                  Product
                </a>
                <a href="#how-it-works" onClick={jump}>
                  How it works
                </a>
                <a href="#availability" onClick={jump}>
                  Availability
                </a>
              </div>
              <div>
                <h3>Help</h3>
                <a href="#security" onClick={jump}>
                  Security
                </a>
                <a href="#questions" onClick={jump}>
                  FAQs
                </a>
                <button onClick={signIn}>{authenticated ? 'My account' : 'Sign in'}</button>
              </div>
            </nav>
          </div>
          <div className="lp-footer-legal">
            <p>
              Microsendr is not a bank. Money in your wallet is not a bank deposit and is not covered by
              deposit insurance. QIE network transfers are irreversible. Features marked “Coming soon”
              are not yet available. Identity verification is provided by Didit.
            </p>
            <div className="lp-footer-bottom">
              <span>© {new Date().getFullYear()} Microsendr</span>
              <a href="#main-content" onClick={jump}>
                Back to top
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
