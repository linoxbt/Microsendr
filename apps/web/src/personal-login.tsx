import React, { useEffect } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { MicrosendrAuth } from './auth-shell.js';
import type { AuthConfig } from './microsendr-auth.js';

type Props = {
  brand: React.ReactNode;
  go: (path: string) => void;
  error?: string;
  onComplete: (session: any) => void;
  authConfig: AuthConfig;
};

export function PersonalLogin({ brand, go, error, onComplete, authConfig }: Props) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Sign in to Personal | Microsendr';
    return () => { document.title = previousTitle; };
  }, []);

  return <div className="personal-auth ms-personal-login">
    <header className="ms-personal-login-header">
      <button className="ms-personal-login-brand" onClick={() => go('/')} aria-label="Microsendr home">{brand}</button>
      <button className="ms-personal-login-back" onClick={() => go('/')}><ArrowLeft size={17}/> Back to home</button>
    </header>
    <main className="ms-personal-login-main">
      <section className="ms-personal-login-visual" aria-label="Microsendr Personal sandbox preview">
        <img src="/images/payment-cafe.webp" alt="Customer making a payment at a café" />
        <div className="ms-personal-login-scrim" />
        <span className="ms-personal-login-image-label">MICROSENDR / PERSONAL</span>
        <div className="ms-personal-login-visual-copy">
          <h2>Your money.<br/>Your move.</h2>
          <p>A clear place to send and keep track.</p>
          <span><ShieldCheck size={17}/> Sandbox preview · Simulated funds</span>
        </div>
      </section>
      <section className="ms-personal-login-panel" aria-labelledby="personal-signin-title">
        <div className="ms-personal-login-form-wrap">
          <span className="ms-personal-login-eyebrow"><i/> PERSONAL ACCOUNT</span>
          <h1 id="personal-signin-title">Sign in to Personal.</h1>
          <p className="ms-personal-login-intro">Use your email to sign in or create an account.</p>
          {error && <p className="personal-error" role="alert">{error}</p>}
          <MicrosendrAuth mode="personal" onComplete={onComplete} config={authConfig} sharedProvider />
          <div className="ms-personal-login-note"><ShieldCheck size={18}/><span>Sandbox access only. Balances and transfers are simulated.</span></div>
        </div>
      </section>
    </main>
    <footer className="ms-personal-login-footer"><span>© {new Date().getFullYear()} Microsendr</span><span>Personal · Sandbox</span></footer>
  </div>;
}
