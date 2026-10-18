import React, { useState, type FormEvent } from 'react';
import { Captcha, PrivyProvider, getIdentityToken, useLoginWithEmail, usePrivy } from '@privy-io/react-auth';
import { ArrowRight } from 'lucide-react';
import { qieMainnet } from './qie-chain.js';

export type AuthConfig = { enabled: boolean; app_id?: string | null; client_id?: string | null };
export type AuthProps = { mode: 'personal' | 'business'; onComplete: (result: any) => void; csrf?: string; inviteToken?: string; saveWorkspace?: boolean };
type Props = AuthProps & { config: AuthConfig };

export function MicrosendrAuthForm({ mode, onComplete, csrf, inviteToken, saveWorkspace }: AuthProps) {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function exchange() {
    const access_token = await getAccessToken();
    if (!access_token) throw new Error('Your session expired. Sign in again.');
    const personal = mode === 'personal';
    const identity_token = personal ? await getIdentityToken() : undefined;
    if (personal && !identity_token) throw new Error('Email verification is unavailable. Sign in again.');
    const response = await fetch(personal ? '/personal/api/auth/privy' : '/console/auth/privy', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-kora-csrf': csrf } : {}) },
      body: JSON.stringify(personal ? { access_token, identity_token } : {
        access_token, business_account: true, link_current: !!saveWorkspace,
        ...(inviteToken ? { invite_token: inviteToken } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'Sign-in failed');
    // Keep the Personal Privy session alive so its embedded wallet remains
    // available after the account session is established.
    if (!personal) await logout().catch(() => undefined);
    onComplete(result);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Try again.'); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (authenticated) return exchange();
      if (!sent) { await sendCode({ email: email.trim() }); setSent(true); }
      else { await loginWithCode({ code }); await exchange(); }
    });
  };
  return <div className="ms-auth-form">
    {error && <p className="personal-error" role="alert">{error}</p>}
    {authenticated ? <button className="personal-primary" disabled={busy || !ready} onClick={() => void run(exchange)}>Continue to {mode} <ArrowRight size={17}/></button> :
      <form onSubmit={submit}>
        {sent ? <><p className="ms-auth-sent" role="status">We sent a code to <strong>{email.trim()}</strong>.</p><label>Verification code<input type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} maxLength={6} required /></label></> :
          <label>Email address<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required /></label>}
        <button className="personal-primary" disabled={busy || !ready || (sent && code.length !== 6)} aria-busy={busy}>{busy ? 'Please wait…' : sent ? 'Verify and continue' : 'Continue with email'} <ArrowRight size={17}/></button>
        {sent && <button type="button" className="personal-text" onClick={() => { setSent(false); setCode(''); }}>Use another email</button>}
        <Captcha />
      </form>}
  </div>;
}

export function MicrosendrAuth(props: Props) {
  const config = props.config;
  return <PrivyProvider appId={config.app_id!} clientId={config.client_id ?? undefined} config={{
    loginMethods: ['email'],
    embeddedWallets: { ethereum: { createOnLogin: props.mode === 'personal' ? 'users-without-wallets' : 'off' }, solana: { createOnLogin: 'off' } },
    supportedChains: [qieMainnet], defaultChain: qieMainnet,
    appearance: { theme: 'light', accentColor: '#4682B4' },
  }}><MicrosendrAuthForm {...props} /></PrivyProvider>;
}
