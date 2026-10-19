import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, Menu, Play, X } from 'lucide-react';
import { microsendrMarkPath } from './microsendr-logo.js';
import './landing.css';

type Props = {
  header: ReactNode;
  brand: ReactNode;
  go: (path: string) => void;
  authenticated: boolean;
};
type Panel = 'experience' | 'availability' | 'questions';
const services = [
  {
    name: 'Personal account',
    description:
      'Your profile, your username, your place to start. Sign up with email and password — no external wallet needed.',
    status: 'Available',
    detail:
      'Add your name, phone, country and address. Edit your details and manage account security from one place.',
  },
  {
    name: 'Receive',
    description: 'Digital-dollar deposits with clear instructions and the right network details.',
    status: 'Coming',
    detail:
      'Deposits are not yet enabled in the Personal app. Supported assets and deposit instructions will appear when a verified route is available.',
  },
  {
    name: 'Send',
    description:
      'Payments built around the person receiving them, with a review before you confirm.',
    status: 'Coming',
    detail:
      'Personal transfers are not yet enabled. The recipient, amount and all costs must be confirmed before any funds move.',
  },
  {
    name: 'Exchange',
    description:
      'Digital dollars and local currency. One quote with the rate, fees and final amount.',
    status: 'Coming',
    detail:
      'No live conversion route is available yet. Exchange requires an executable provider quote; an estimated rate is not a payment.',
  },
  {
    name: 'Withdraw',
    description: 'A clear path to your bank, from recipient details to a payment you can follow.',
    status: 'Coming',
    detail:
      'Bank withdrawals require an authorised payout partner and an eligible, verified account. They are not yet enabled.',
  },
];
const questions = [
  [
    'What can I do today?',
    'Create your account, complete and edit your profile, and explore the Personal app. Deposits, transfers, exchange and bank withdrawals are not yet enabled.',
  ],
  [
    'Do I need a crypto wallet?',
    'No. Register with your email and password. You do not need to connect an external wallet to create an account.',
  ],
  [
    'When do I verify my identity?',
    'You can complete your profile first and return to Identity later. Verification is required before eligible money services can be enabled.',
  ],
  [
    'Are digital dollars a bank deposit?',
    'No. Digital dollars refer to supported digital assets, not insured bank deposits. Asset and network information must be shown wherever it is needed for a safe deposit or withdrawal.',
  ],
  [
    'How will fees work?',
    'Before you authorise an enabled payment, its quote must show all service, provider and network costs, together with the amount the recipient will receive.',
  ],
];

function MetallicMark() {
  return (
    <svg className="nl-metal-mark" viewBox="0 0 420 360" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="microsendr-chrome" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#777f86" />
          <stop offset=".17" stopColor="#faffff" />
          <stop offset=".32" stopColor="#c7ccd0" />
          <stop offset=".46" stopColor="#f5f6f7" />
          <stop offset=".5" stopColor="#727b84" />
          <stop offset=".56" stopColor="#e3e6e9" />
          <stop offset=".8" stopColor="#fafcfc" />
          <stop offset="1" stopColor="#788692" />
        </linearGradient>
        <linearGradient id="microsendr-edge" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#c8cdd2" />
          <stop offset=".3" stopColor="#303b42" />
          <stop offset=".67" stopColor="#0c1014" />
          <stop offset="1" stopColor="#a9bac8" />
        </linearGradient>
        <linearGradient id="microsendr-glint" x1="0" y1="0" x2="1" y2=".4">
          <stop stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform="translate(37 22) scale(9.5)">
        <path
          d={microsendrMarkPath}
          transform="translate(.55 .75)"
          fill="url(#microsendr-edge)"
          stroke="#303b44"
          strokeWidth=".18"
        />
        <path
          d={microsendrMarkPath}
          fill="url(#microsendr-chrome)"
          stroke="#e7ecef"
          strokeWidth=".14"
          strokeLinejoin="round"
        />
        <path
          d="M2 30 8 2h5l5 15L23 2h5 M8 30l3-17 5 14h4l5-14"
          fill="none"
          stroke="url(#microsendr-glint)"
          strokeWidth=".3"
        />
      </g>
    </svg>
  );
}

export function LandingPage({ brand, go, authenticated }: Props) {
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = (next: Panel) => {
    setMenu(false);
    setPanel(next);
  };
  const start = () => go(authenticated ? '/personal/home' : '/personal/login');
  useEffect(() => {
    document.title = 'Microsendr | Your money. Your next move.';
    document.body.classList.add('microsendr-landing-active');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = meta?.content;
    if (meta) meta.content = '#000000';
    return () => {
      document.body.classList.remove('microsendr-landing-active');
      if (meta && previous) meta.content = previous;
    };
  }, []);
  useEffect(() => {
    if (!panel || !dialog.current) return;
    const node = dialog.current;
    if (!node.open) node.showModal();
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [panel]);
  return (
    <div className="ms-site nl-site" id="top">
      <a className="nl-skip" href="#main-content">
        Skip to content
      </a>
      <header className="public-header nl-header">
        <a className="nl-brand" href="/" aria-label="Microsendr home">
          {brand}
        </a>
        <span className="nl-brand-caption">
          <i>/</i> PERSONAL FINANCE, CONNECTED
        </span>
        <nav
          className={menu ? 'nl-nav is-open' : 'nl-nav'}
          aria-label="Main navigation"
          id="landing-navigation"
        >
          <span className="nl-live">
            <i /> Early access
          </span>
          <button onClick={() => open('experience')}>The experience</button>
          <button onClick={() => open('availability')}>Availability</button>
          <button onClick={start}>
            {authenticated ? 'My account' : 'Sign in'} <ArrowUpRight size={13} />
          </button>
        </nav>
        <button
          className="nl-menu"
          aria-label={menu ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menu}
          aria-controls="landing-navigation"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X size={22} /> : <Menu size={22} />}
        </button>
      </header>
      <main id="main-content" className="nl-main">
        <section className="nl-meta" aria-label="About Microsendr">
          <div>
            <h2>
              Microsendr<span>Personal</span>
            </h2>
            <span className="nl-star">*</span>
            <p className="nl-pixel nl-intro">A clearer way to move through your financial life</p>
          </div>
          <div>
            <h2>
              Money &<span>Movement</span>
            </h2>
          </div>
          <div>
            <h3 className="nl-label">What we’re building</h3>
            <p className="nl-body">
              Digital dollars, everyday payments and local withdrawals — coming together in one
              personal account.
            </p>
          </div>
          <div>
            <h3 className="nl-label">Made for your everyday</h3>
            <ul className="nl-list">
              <li>Receive digital dollars</li>
              <li>Send to people, simply</li>
              <li>Exchange with clear fees</li>
              <li>Withdraw to your bank</li>
            </ul>
            <button className="nl-subtle" onClick={() => open('availability')}>
              Money services coming <ArrowUpRight size={11} />
            </button>
          </div>
        </section>
        <div className="nl-stage">
          <button
            className="nl-emblem"
            onClick={() => open('experience')}
            aria-label="Explore Microsendr"
          >
            <MetallicMark />
          </button>
        </div>
        <section className="nl-bottom" aria-labelledby="landing-title">
          <h1 id="landing-title">
            <span>Your money.</span>
            <span>Your life.</span>
            <span>Your next</span>
            <span className="nl-pixel nl-accent">move.</span>
          </h1>
          <div className="nl-actions">
            <button className="nl-cta" onClick={start}>
              <Play size={11} fill="currentColor" />
              {authenticated ? 'Open your account' : 'Get started'}
              <ArrowUpRight size={15} />
            </button>
            <div className="nl-chips">
              <button onClick={() => open('experience')}>
                <b>Personal</b>
                <span>Account open</span>
              </button>
              <button onClick={() => open('availability')}>
                <b>Money services</b>
                <span>Coming</span>
              </button>
              <button onClick={() => open('questions')}>
                <b>Questions?</b>
                <span>Start here</span>
              </button>
            </div>
          </div>
        </section>
      </main>
      <footer className="nl-footer">
        <p>
          Account creation is open. Money services are in development.{' '}
          <button onClick={() => open('availability')}>See availability.</button>
        </p>
        <p>
          © {new Date().getFullYear()} Microsendr <span>•</span>{' '}
          <button onClick={() => open('questions')}>Built for everyday life.</button>
        </p>
      </footer>
      <dialog
        className="nl-dialog"
        ref={dialog}
        aria-labelledby="landing-dialog-title"
        onClose={() => setPanel(null)}
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="nl-dialog-shell">
          <header>
            <a href="/" aria-label="Microsendr home">
              {brand}
            </a>
            <button
              className="nl-close"
              aria-label="Close details"
              onClick={() => dialog.current?.close()}
            >
              <X size={22} />
            </button>
          </header>
          <nav aria-label="Product details">
            <button
              aria-current={panel === 'experience' ? 'page' : undefined}
              onClick={() => setPanel('experience')}
            >
              The experience
            </button>
            <button
              aria-current={panel === 'availability' ? 'page' : undefined}
              onClick={() => setPanel('availability')}
            >
              Availability
            </button>
            <button
              aria-current={panel === 'questions' ? 'page' : undefined}
              onClick={() => setPanel('questions')}
            >
              FAQs
            </button>
          </nav>
          <div className="nl-dialog-content">
            <p className="nl-label">MICROSENDR / PERSONAL</p>
            <h2 id="landing-dialog-title">
              {panel === 'experience'
                ? 'One place. Your next move.'
                : panel === 'availability'
                  ? 'The full picture.'
                  : 'A little clarity.'}
            </h2>
            {panel === 'experience' && (
              <>
                <p className="nl-dialog-intro">
                  A familiar financial experience. Explore what’s available today and what we’re
                  building next.
                </p>
                <div className="nl-service-list">
                  {services.map((service, index) => (
                    <details key={service.name}>
                      <summary>
                        <span className="nl-service-number">0{index + 1}</span>
                        <strong>{service.name}</strong>
                        <span className="nl-service-description">{service.description}</span>
                        <span
                          className={
                            service.status === 'Available' ? 'nl-state available' : 'nl-state'
                          }
                        >
                          {service.status}
                        </span>
                        <ChevronDown size={16} />
                      </summary>
                      <p>{service.detail}</p>
                    </details>
                  ))}
                </div>
                <button className="nl-cta" onClick={start}>
                  Open Personal <ArrowUpRight size={15} />
                </button>
              </>
            )}
            {panel === 'availability' && (
              <>
                <p className="nl-dialog-intro">
                  Create your account and make it yours. Money services will appear in the app as
                  each supported route becomes ready.
                </p>
                <div className="nl-status-list">
                  {services.map((service) => (
                    <div key={service.name}>
                      <span>{service.name}</span>
                      <span
                        className={
                          service.status === 'Available' ? 'nl-state available' : 'nl-state'
                        }
                      >
                        {service.status}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="nl-disclosure">
                  <h3>Before money moves</h3>
                  <p>
                    Availability depends on your location, identity verification and supported
                    providers. Deposits, transfers, exchange and bank withdrawals are not yet
                    enabled in the Personal app.
                  </p>
                  <p>
                    Digital assets are not insured bank deposits. Fees and recipient amounts must be
                    shown before you authorise a payment.
                  </p>
                </div>
                <button className="nl-cta" onClick={start}>
                  Explore your account <ArrowUpRight size={15} />
                </button>
              </>
            )}
            {panel === 'questions' && (
              <div className="nl-faq">
                {questions.map(([question, answer]) => (
                  <details key={question}>
                    <summary>
                      {question}
                      <ChevronDown size={18} />
                    </summary>
                    <p>{answer}</p>
                  </details>
                ))}
              </div>
            )}
          </div>
          <footer>POWERED BY POSSIBILITY. BUILT FOR EVERYDAY LIFE.</footer>
        </div>
      </dialog>
    </div>
  );
}
