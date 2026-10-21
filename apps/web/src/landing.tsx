import React, { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Fingerprint,
  Globe2,
  Menu,
  Plus,
  Repeat2,
  ShieldCheck,
  Smartphone,
  Wallet,
  X,
} from 'lucide-react';
import './landing.css';

type Props = {
  brand: ReactNode;
  go: (path: string) => void;
};
const previews = {
  Receive: {
    title: 'A simpler way to get paid.',
    text: 'A digital-dollar experience built around you. Clear deposit instructions, with the important details exactly where you need them.',
    label: 'Receive digital dollars',
    value: '@yourname',
    detail: 'Your personal payment identity',
    icon: ArrowDownLeft,
  },
  Send: {
    title: 'People first. Payments second.',
    text: 'A familiar name. A clear amount. A review before you confirm. Sending money should feel that straightforward.',
    label: 'Send to a person',
    value: '@amara',
    detail: 'Review recipient, amount and fees',
    icon: ArrowUpRight,
  },
  Exchange: {
    title: 'Know what you’ll get.',
    text: 'A clear view of the exchange rate, total fees and final amount before you make your next move.',
    label: 'Digital dollars to naira',
    value: 'USD → NGN',
    detail: 'An available provider quote is required',
    icon: Repeat2,
  },
  Withdraw: {
    title: 'From your screen to real life.',
    text: 'Bank withdrawals designed around the details that matter: the right recipient, a clear total and a payment you can follow.',
    label: 'Withdraw to your bank',
    value: 'Your bank account',
    detail: 'Confirm the recipient before paying',
    icon: Wallet,
  },
};
type Preview = keyof typeof previews;
const questions = [
  [
    'What can I do on Microsendr today?',
    'You can create your Personal account, complete your profile, link a self-custody QIE wallet you control, and use it to receive or send native QIEV3 on QIE Mainnet. Deposits to and sends from a Microsendr-managed account wallet, digital-dollar deposits, exchange, and bank payments are still coming.',
  ],
  [
    'Do I need a crypto wallet to register?',
    'No. Create your Microsendr account with your email and password. You do not need to connect an external wallet to sign up.',
  ],
  [
    'When do I verify my identity?',
    'You can create your account and complete your profile first. Identity verification may be required for regulated services as they become available. You can return to the Identity section when you’re ready.',
  ],
  [
    'Is a digital-dollar balance a bank account?',
    'No. Digital dollars refer to supported digital assets, not insured bank deposits. Asset and network details will be shown wherever they are needed for a safe deposit or withdrawal.',
  ],
  [
    'What will a payment cost?',
    'Before an enabled payment is authorised, its quote must show the service fee, any provider or network costs, and the amount the recipient will receive. There are no live exchange rates or executable payments on this landing page.',
  ],
];

export function LandingPage({ brand, go }: Props) {
  const [menu, setMenu] = useState(false);
  // "My account" reflects the Personal session, not the retired Business console session.
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/personal/api/session', { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : { authenticated: false }))
      .then((session) => {
        if (active) setAuthenticated(session?.authenticated === true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const [preview, setPreview] = useState<Preview>('Receive');
  const current = previews[preview];
  const Icon = current.icon;
  const start = () => go(authenticated ? '/personal/home' : '/personal/login');
  useEffect(() => {
    document.title = 'Microsendr | Money for the life you’re building.';
  }, []);
  return (
    <div className="ms-site lp-site">
      <a className="lp-skip" href="#main-content">
        Skip to content
      </a>
      <header className="public-header lp-header">
        <a className="lp-brand" href="/" aria-label="Microsendr home">
          {brand}
        </a>
        <nav
          aria-label="Main navigation"
          className={menu ? 'lp-nav is-open' : 'lp-nav'}
          id="landing-navigation"
        >
          <a href="#platform" onClick={() => setMenu(false)}>
            The experience
          </a>
          <a href="#how-it-works" onClick={() => setMenu(false)}>
            Getting started
          </a>
          <a href="#questions" onClick={() => setMenu(false)}>
            FAQs
          </a>
        </nav>
        <button className="lp-signin" onClick={start}>
          {authenticated ? 'My account' : 'Sign in'} <ArrowUpRight size={15} />
        </button>
        <button
          className="lp-menu"
          aria-label={menu ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menu}
          aria-controls="landing-navigation"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </button>
      </header>
      <main id="main-content">
        <section className="lp-hero" aria-labelledby="landing-title">
          <div className="lp-hero-copy">
            <a className="lp-eyebrow lp-announcement" href="#availability">
              <span /> Meet your next money move <ArrowUpRight size={14} />
            </a>
            <h1 id="landing-title">
              Money for
              <br />
              the life you’re
              <br />
              <span>building.</span>
            </h1>
            <p>
              A fresh take on everyday money. Digital dollars, local payments and everything in
              between — coming together in Microsendr.
            </p>
            <div className="lp-hero-actions">
              <button className="lp-button" onClick={start}>
                {authenticated ? 'Open your account' : 'Get started'} <ArrowUpRight size={20} />
              </button>
              <a href="#platform" className="lp-text-link">
                Meet the app <ArrowRight size={17} />
              </a>
            </div>
            <p className="lp-early">
              <span /> Early access · Account creation is open. Money services are coming.
            </p>
          </div>
          <div
            className="lp-hero-art"
            aria-label="Microsendr product concept alongside everyday payment photography"
          >
            <div className="lp-orbit lp-orbit-one" />
            <div className="lp-orbit lp-orbit-two" />
            <div className="lp-photo">
              <img
                src="/images/payment-cafe.webp"
                alt="A customer paying by card at a café"
                fetchPriority="high"
                width="1280"
                height="1920"
              />
              <span>Made for your everyday.</span>
            </div>
            <div className="lp-phone">
              <div className="lp-phone-top">
                <span>9:41</span>
                <span className="lp-island" />
                <span>•••</span>
              </div>
              <div className="lp-phone-content">
                <div className="lp-phone-greeting">
                  <div>
                    <small>YOUR PERSONAL ACCOUNT</small>
                    <b>
                      Hello, Alex <span>↗</span>
                    </b>
                  </div>
                  <span className="lp-avatar">A</span>
                </div>
                <div className="lp-balance">
                  <span>
                    Your money <Globe2 size={15} />
                  </span>
                  <strong>
                    $0<span>.00</span>
                  </strong>
                  <small>Digital dollars</small>
                  <div className="lp-balance-line" />
                </div>
                <div className="lp-phone-actions">
                  {[
                    [Plus, 'Add'],
                    [ArrowUpRight, 'Send'],
                    [Repeat2, 'Exchange'],
                    [ArrowDownLeft, 'Withdraw'],
                  ].map(([Action, label]) => {
                    const ActionIcon = Action as typeof Plus;
                    return (
                      <div key={String(label)}>
                        <span>
                          <ActionIcon size={18} />
                        </span>
                        <small>{String(label)}</small>
                      </div>
                    );
                  })}
                </div>
                <div className="lp-profile-note">
                  <ShieldCheck size={23} />
                  <div>
                    <b>Make it yours</b>
                    <small>Complete your personal profile</small>
                  </div>
                  <ArrowRight size={16} />
                </div>
                <div className="lp-phone-activity">
                  <b>Your activity</b>
                  <span>All in one place</span>
                  <div>
                    <div className="lp-activity-lines">
                      <i />
                      <i />
                      <i />
                    </div>
                    <p>Your next chapter starts here.</p>
                  </div>
                </div>
                <div className="lp-phone-nav">
                  <span>
                    <Wallet size={17} />
                    Home
                  </span>
                  <span>
                    <Repeat2 size={17} />
                    Payments
                  </span>
                  <span>
                    <Fingerprint size={17} />
                    Account
                  </span>
                </div>
              </div>
            </div>
            <div className="lp-floating">
              <span>
                <Globe2 size={23} />
              </span>
              <div>
                <b>Big plans. One place.</b>
                <small>Built around your next move.</small>
              </div>
            </div>
            <span className="lp-preview-label">PRODUCT PREVIEW · MONEY SERVICES COMING</span>
          </div>
        </section>
        <div className="lp-principles">
          <span>
            ONE ACCOUNT.
            <br />
            <b>MORE POSSIBILITY.</b>
          </span>
          <div>
            <Globe2 /> A global outlook
          </div>
          <div>
            <Smartphone /> An everyday experience
          </div>
          <div>
            <ShieldCheck /> You stay in control
          </div>
        </div>
        <section className="lp-platform lp-section" id="platform">
          <div className="lp-section-heading">
            <span className="lp-eyebrow">YOUR MONEY, CONNECTED</span>
            <h2>
              Less figuring it out.
              <br />
              <span>More getting on with life.</span>
            </h2>
            <p>We’re bringing your everyday money moves into one thoughtfully designed app.</p>
          </div>
          <div
            className="lp-product-tabs"
            role="tablist"
            aria-label="Explore planned money services"
          >
            {(Object.keys(previews) as Preview[]).map((name) => (
              <button
                key={name}
                role="tab"
                id={`tab-${name}`}
                aria-selected={preview === name}
                aria-controls="product-panel"
                tabIndex={preview === name ? 0 : -1}
                onClick={() => setPreview(name)}
                onKeyDown={(event) => {
                  const names = Object.keys(previews) as Preview[];
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 3
                          : (names.indexOf(name) + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
                    setPreview(names[next]);
                    document.getElementById(`tab-${names[next]}`)?.focus();
                  }
                }}
              >
                {name}
                <ArrowUpRight size={17} />
              </button>
            ))}
          </div>
          <div
            className="lp-product-panel"
            id="product-panel"
            role="tabpanel"
            aria-labelledby={`tab-${preview}`}
            tabIndex={0}
          >
            <div className="lp-product-copy">
              <span className="lp-status">IN DEVELOPMENT</span>
              <h3>{current.title}</h3>
              <p>{current.text}</p>
              <a className="lp-text-link" href="#availability">
                See what’s available <ArrowRight size={17} />
              </a>
            </div>
            <div className="lp-product-art">
              <div className="lp-route-dot">$</div>
              <div className="lp-route-dash" />
              <div className="lp-product-card" key={preview}>
                <span className="lp-product-icon">
                  <Icon size={26} />
                </span>
                <small>{current.label}</small>
                <strong>{current.value}</strong>
                <p>{current.detail}</p>
                <div>
                  <ShieldCheck size={16} /> Clear details. Your confirmation.
                </div>
              </div>
              <div className="lp-route-dot lp-naira">₦</div>
              <small className="lp-art-caption">Concept preview · No money is moved</small>
            </div>
          </div>
        </section>
        <section className="lp-life lp-section">
          <div className="lp-life-photo">
            <img
              src="/images/payment-tanzania.jpg"
              alt="A contactless card payment at a shop counter"
              loading="lazy"
              width="1400"
              height="1001"
            />
            <div>
              <span className="lp-eyebrow">FOR THE EVERYDAY. AND THE WHAT’S NEXT.</span>
              <h2>
                Your life doesn’t
                <br />
                stand still.
                <br />
                Neither should
                <br />
                your money.
              </h2>
            </div>
          </div>
          <div className="lp-life-copy">
            <span className="lp-eyebrow">MADE WITH YOU IN MIND</span>
            <h2>
              Big ambitions.
              <br />
              Everyday needs.
            </h2>
            <p>
              From your first freelance project to your next chapter abroad, we’re building for the
              way you live and work.
            </p>
            <article>
              <span>01</span>
              <div>
                <h3>For the independent</h3>
                <p>A clearer home for the money you earn, wherever work takes you.</p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>For the connected</h3>
                <p>Payments designed around people, with the details easy to follow.</p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>For the forward-looking</h3>
                <p>Digital dollars and local payments, built into one everyday experience.</p>
              </div>
            </article>
          </div>
        </section>
        <section className="lp-start lp-section" id="how-it-works">
          <div className="lp-section-heading">
            <span className="lp-eyebrow">A SIMPLE START</span>
            <h2>
              A few details.
              <br />
              <span>A place to make your own.</span>
            </h2>
          </div>
          <div className="lp-step-grid">
            {[
              [
                '01',
                'Create your account',
                'Sign up with your email and password. No external wallet needed.',
              ],
              [
                '02',
                'Make it personal',
                'Add your name, phone, address and username. Your profile stays in your control.',
              ],
              [
                '03',
                'Get ready for what’s next',
                'Explore the app now. Return to identity verification before using eligible money services.',
              ],
            ].map(([number, title, body]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <button className="lp-button" onClick={start}>
            Get started <ArrowUpRight size={19} />
          </button>
        </section>
        <section className="lp-control lp-section" id="availability">
          <div>
            <span className="lp-eyebrow">CLARITY COMES FIRST</span>
            <h2>
              Your money deserves
              <br />
              the full picture.
            </h2>
            <p>
              Good financial experiences start with knowing where you stand. Here’s where Microsendr
              stands today.
            </p>
            <div className="lp-control-principles">
              <span>
                <Fingerprint /> Personal identity checks
              </span>
              <span>
                <ShieldCheck /> Explicit payment approval
              </span>
              <span>
                <Check /> Clear fees before confirmation
              </span>
            </div>
          </div>
          <div className="lp-availability">
            <span className="lp-eyebrow">PRODUCT AVAILABILITY</span>
            <h3>Building the next chapter.</h3>
            <div>
              <span>Personal account & profile</span>
              <b className="lp-open">Available</b>
            </div>
            <div>
              <span>Native QIE transfers with your linked wallet</span>
              <b className="lp-open">Available</b>
            </div>
            <div>
              <span>Microsendr account wallet deposits & sends</span>
              <b>Coming</b>
            </div>
            <div>
              <span>Digital-dollar deposits & transfers</span>
              <b>Coming</b>
            </div>
            <div>
              <span>Currency exchange</span>
              <b>Coming</b>
            </div>
            <div>
              <span>Local deposits & bank withdrawals</span>
              <b>Coming</b>
            </div>
            <p>
              Native QIE transfers use a self-custody wallet you link and control. Digital-dollar and fiat services depend
              on supported assets, providers and verification. Digital assets are not insured bank deposits.
            </p>
          </div>
        </section>
        <section className="lp-faq lp-section" id="questions">
          <div>
            <span className="lp-eyebrow">GOOD QUESTIONS</span>
            <h2>
              A little clarity
              <br />
              goes a long way.
            </h2>
          </div>
          <div>
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={19} />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="lp-finale">
          <div className="lp-finale-orbit" />
          <span className="lp-eyebrow">YOUR NEXT CHAPTER</span>
          <h2>
            Make room for
            <br />
            your next move.
          </h2>
          <button className="lp-button" onClick={start}>
            Get started with Microsendr <ArrowUpRight size={20} />
          </button>
          <p>Your account starts here. Money services are on the way.</p>
        </section>
      </main>
      <footer className="lp-footer">
        <div className="lp-footer-top">
          <div>
            {brand}
            <p>
              Powered by possibility.
              <br />
              Built for everyday life.
            </p>
          </div>
          <nav aria-label="Footer navigation">
            <a href="#platform">The experience</a>
            <a href="#how-it-works">Getting started</a>
            <a href="#availability">Availability</a>
            <a href="#questions">FAQs</a>
            <button onClick={start}>
              Your account <ArrowUpRight size={15} />
            </button>
          </nav>
        </div>
        <div className="lp-footer-bottom">
          <span>© {new Date().getFullYear()} Microsendr</span>
          <span>Personal finance. A fresh perspective.</span>
          <a href="#landing-title">Back to top ↑</a>
        </div>
      </footer>
    </div>
  );
}
