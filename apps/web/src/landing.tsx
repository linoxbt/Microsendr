import React, { type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleDollarSign, LockKeyhole, MoveUpRight, ShieldCheck, Wallet } from 'lucide-react';
import './landing.css';

type Props = { header: ReactNode; brand: ReactNode; go: (path: string) => void; authenticated: boolean };

export function LandingPage({ header, brand, go }: Props) {
  const start = () => go('/personal/login');
  return <div className="ms-site">
    {header}
    <main>
      <section className="ms-hero" aria-labelledby="ms-hero-title">
        <div className="ms-hero-copy">
          <span className="ms-kicker"><i/> MONEY, MADE SIMPLE</span>
          <h1 id="ms-hero-title">Your money.<br/><em>More places.</em></h1>
          <p>One clear place to receive, send and follow your money. Designed for people whose lives cross borders.</p>
          <div className="ms-hero-actions"><button className="ms-button" onClick={start}>Explore Microsendr <ArrowRight size={18}/></button><a className="ms-link" href="#platform">See the experience <ArrowUpRight size={18}/></a></div>
          <span className="ms-disclosure"><ShieldCheck size={16}/> Simulated NGN · QIE Mainnet wallet transfers</span>
        </div>
        <div className="ms-hero-visual"><img src="/images/payment-cafe.webp" alt="A customer making a payment at a café" fetchPriority="high"/><div className="ms-hero-photo-shade"/><div className="ms-payment-note"><span className="ms-payment-note-icon"><Check size={19}/></span><span><b>Payment received</b><small>Illustrative sandbox activity</small></span><strong>₦12,500</strong></div><span className="ms-image-index">PAYMENTS FOR EVERYDAY LIFE</span></div>
      </section>
      <section className="ms-proof-strip" aria-label="Microsendr overview"><span>ONE PERSONAL ACCOUNT</span><span>PAYMENTS YOU CAN FOLLOW</span><span>BUILT FOR AFRICA</span><span>QIE MAINNET WALLET</span></section>
      <section className="ms-personal" id="platform"><div className="ms-personal-copy"><span className="ms-kicker"><i/> THE APP</span><h2>Everything in<br/><em>one clear view.</em></h2><p>See your balance, make a payment and find the details later. No maze of wallets or networks to navigate.</p><button className="ms-text-action" onClick={start}>Open the app <ArrowUpRight size={19}/></button></div><div className="ms-personal-stage"><div className="ms-stage-orbit ms-stage-orbit-one"/><div className="ms-stage-orbit ms-stage-orbit-two"/><div className="ms-account-card"><div className="ms-account-head"><span>{brand}</span><small>Personal preview</small></div><small>AVAILABLE · SIMULATED NGN</small><strong>₦100,000.00</strong><div className="ms-account-actions"><span><MoveUpRight size={18}/> Send</span><span><Wallet size={18}/> Balance</span></div><div className="ms-account-activity"><span><Check size={17}/></span><div><b>Transfer complete</b><small>Illustrative activity</small></div><strong>− ₦12,500</strong></div></div></div></section>
      <section className="ms-steps" id="how-it-works"><div className="ms-section-intro"><span className="ms-kicker"><i/> SIMPLE BY DESIGN</span><h2>From sign-in to sent.</h2><p>The details stay in the background. The important things stay in view.</p></div><div className="ms-steps-grid"><article><span>01</span><CircleDollarSign size={26}/><h3>See your money</h3><p>A balance and activity you can understand at a glance.</p></article><article><span>02</span><MoveUpRight size={26}/><h3>Send with clarity</h3><p>Know the recipient, amount and fee before confirming.</p></article><article><span>03</span><LockKeyhole size={26}/><h3>Keep a record</h3><p>Every completed sandbox payment has a clear activity entry.</p></article></div><small>NGN transfers are simulated. Native QIE wallet transfers use Mainnet; live bank services require approved partners.</small></section>
      <section className="ms-business ms-personal-story"><div className="ms-business-image"><img src="/images/payment-tanzania.jpg" alt="Customer completing a card payment at a terminal in Tanzania" loading="lazy"/><span className="ms-image-index">A CLEARER WAY TO MOVE</span></div><div className="ms-business-copy"><span className="ms-kicker"><i/> MADE FOR REAL LIFE</span><h2>Send confidently.<br/><em>Stay in control.</em></h2><p>Microsendr brings the information you need together before and after a payment.</p><button className="ms-button" onClick={start}>Try the preview <ArrowRight size={18}/></button></div></section>
      <section className="ms-capabilities"><div><span className="ms-kicker"><i/> WHAT COMES NEXT</span><h2>One experience.<br/><em>More ways to move.</em></h2></div><div className="ms-capability-grid"><article><span>01 / TODAY</span><h3>Personal + QIE</h3><p>Try simulated NGN payments or send native QIEV3 from your wallet.</p></article><article><span>02 / IN DEVELOPMENT</span><h3>Digital dollars on QIE</h3><p>Receive and send supported stablecoins through a verified settlement path.</p></article><article><span>03 / PARTNER DEPENDENT</span><h3>Local deposits and payouts</h3><p>NGN funding and bank withdrawals when partner access and approvals are complete.</p></article></div></section>
      <section className="ms-final"><span className="ms-kicker"><i/> YOUR NEXT MOVE</span><h2>Start with a clearer view.</h2><div><button className="ms-button" onClick={start}>Explore Personal <ArrowRight size={18}/></button></div><small>NGN sandbox · Live native QIE wallet transfers · No live bank payouts</small></section>
    </main>
    <footer className="ms-footer"><div>{brand}<span>Money moves with you.</span></div><nav><button onClick={start}>Personal</button></nav><small>© {new Date().getFullYear()} Microsendr</small></footer>
  </div>;
}
