import React, { type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, History, ShieldCheck, Send } from 'lucide-react';
import './landing.css';

type Props = { header: ReactNode; brand: ReactNode; go: (path: string) => void; authenticated: boolean };

export function LandingPage({ header, brand, go }: Props) {
  const start = () => go('/personal/login');
  return <div className="ms-site">
    {header}
    <main>
      <section className="ms-hero">
        <div className="ms-hero-copy">
          <span className="ms-kicker"><i/> MICROSENDR PERSONAL</span>
          <h1>Money moves<br/><em>with you.</em></h1>
          <p>A clear place to send money, see your balance and follow every payment.</p>
          <div className="ms-hero-actions"><button className="ms-button" onClick={start}>Get started <ArrowRight size={18}/></button><a className="ms-link" href="#how-it-works">See how it works <ArrowUpRight size={18}/></a></div>
          <span className="ms-disclosure"><ShieldCheck size={16}/> Sandbox preview · Funds and transfers are simulated</span>
        </div>
        <div className="ms-hero-visual"><img src="/images/payment-cafe.webp" alt="Customer making a payment at a café" fetchPriority="high"/><div className="ms-hero-photo-shade"/><div className="ms-payment-note" aria-label="Illustrative sandbox transfer"><span className="ms-payment-note-icon"><Check size={19}/></span><span><b>Transfer posted</b><small>Example · Simulated</small></span><strong>₦12,500</strong></div><span className="ms-image-index">01 / EVERYDAY PAYMENTS</span></div>
      </section>

      <section className="ms-proof-strip" aria-label="Personal account highlights"><span>ONE PERSONAL ACCOUNT</span><span>SIMPLE TRANSFERS <i/></span><span>CLEAR ACTIVITY <i/></span><span>SIMULATED NGN</span></section>

      <section className="ms-personal" id="platform"><div className="ms-personal-copy"><span className="ms-kicker"><i/> YOUR ACCOUNT</span><h2>Your money.<br/><em>Your move.</em></h2><p>See your simulated balance, send to another Personal account and keep every transfer in view.</p><button className="ms-text-action" onClick={start}>Open Personal <ArrowUpRight size={19}/></button></div><div className="ms-personal-stage"><div className="ms-stage-orbit ms-stage-orbit-one"/><div className="ms-stage-orbit ms-stage-orbit-two"/><div className="ms-account-card"><div className="ms-account-head"><span>{brand}</span><small>Personal · Sandbox</small></div><small>AVAILABLE · SIMULATED NGN</small><strong>₦100,000.00</strong><div className="ms-account-actions"><span><Send size={18}/> Send</span><span><History size={18}/> Activity</span></div><div className="ms-account-activity"><span><ArrowUpRight size={17}/></span><div><b>Transfer sent</b><small>Example activity</small></div><strong>− ₦12,500</strong></div></div></div></section>

      <section className="ms-steps" id="how-it-works"><div className="ms-section-intro"><span className="ms-kicker"><i/> HOW IT WORKS</span><h2>Every move, in view.</h2><p>Three steps from sign-in to a clear payment record.</p></div><div className="ms-steps-grid"><article><span>01 / SIGN IN</span><h3>Start with email</h3><p>Create your Personal account with Privy email sign-in.</p></article><article><span>02 / SEND</span><h3>Know the cost</h3><p>Enter a recipient and amount. Review the fee before you send.</p></article><article><span>03 / FOLLOW</span><h3>Track every move</h3><p>Find the completed simulated transfer in your activity.</p></article></div><small>Current sandbox supports simulated NGN transfers between eligible Personal accounts.</small></section>

      <section className="ms-business ms-personal-story"><div className="ms-business-image"><img src="/images/business-payments.webp" alt="People reviewing a payment on a laptop" loading="lazy"/><span className="ms-image-index">02 / CLEAR PAYMENTS</span></div><div className="ms-business-copy"><span className="ms-kicker"><i/> BUILT FOR CLARITY</span><h2>See where your<br/>money went.</h2><p>Your balance and activity stay together. Every simulated payment has a clear record.</p><button className="ms-button" onClick={start}>Explore the app <ArrowRight size={18}/></button></div></section>

      <section className="ms-capabilities"><div><span className="ms-kicker"><i/> PERSONAL ACCOUNT</span><h2>Simple from the start.</h2></div><div className="ms-capability-grid"><article><span>01</span><h3>One balance</h3><p>See available simulated NGN at a glance.</p></article><article><span>02</span><h3>Easy sending</h3><p>Pay another eligible Personal account by email.</p></article><article><span>03</span><h3>Identity check</h3><p>Didit identity checks are prepared in your profile and will open when verification is configured.</p></article></div></section>

      <section className="ms-final"><span className="ms-kicker"><i/> START HERE</span><h2>Ready for your next move?</h2><div><button className="ms-button" onClick={start}>Create a Personal account <ArrowRight size={18}/></button></div><small>Sandbox only · No live funds or providers</small></section>
    </main>
    <footer className="ms-footer"><div>{brand}<span>Move with confidence.</span></div><nav><button onClick={start}>Personal</button></nav><small>© {new Date().getFullYear()} Microsendr · Sandbox</small></footer>
  </div>;
}
