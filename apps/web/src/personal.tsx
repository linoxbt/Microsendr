import React, { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, CheckCircle2, History, Home, LogOut, Menu, Send, ShieldCheck, UserRound, Wallet } from 'lucide-react';
import { PersonalLogin } from './personal-login.js';
import { PersonalKyc } from './personal-kyc.js';
import { usePersonalPrivy } from './personal-context.js';
import type { AuthConfig } from './microsendr-auth.js';
import { MicrosendrMark } from './microsendr-logo.js';
import './personal.css';
const PersonalWallet = React.lazy(() => import('./personal-wallet.js').then(module => ({ default: module.PersonalWallet })));
const PersonalMoney = React.lazy(() => import('./personal-money.js').then(module => ({ default: module.PersonalMoney })));
const PersonalProvider = React.lazy(() => import('./personal-provider.js').then(module => ({ default: module.PersonalProvider })));

function PersonalLoading() {
  return <div className="personal-loading" role="status" aria-label="Opening Personal">
    <span className="personal-loading-mark"><MicrosendrMark /></span>
  </div>;
}

type Session = { authenticated: boolean; csrf_token?: string; email?: string; kyc_state?: string; residence_country?: string | null; display_currency?: string; privy_subject?: string | null };
type HomeData = { email: string; kyc_state: string; sandbox_funded: boolean; balance: { available_minor: string; pending_minor: string; held_minor: string; simulated: true } };
type Transfer = { id: string; amount_minor: string; direction: 'sent' | 'received'; counterparty: string; created_at: string; status: string };
const money = (minor: string) => {
  const amount = BigInt(minor), sign = amount < 0n ? '-' : '', absolute = amount < 0n ? -amount : amount;
  return `${sign}₦${new Intl.NumberFormat('en-NG').format(absolute / 100n)}.${(absolute % 100n).toString().padStart(2, '0')}`;
};

async function request<T>(path: string, method = 'GET', body?: object, csrf?: string, key?: string): Promise<T> {
  const response = await fetch(path, { method, credentials: 'include', headers: {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(csrf ? { 'x-kora-csrf': csrf } : {}),
    ...(key ? { 'idempotency-key': key } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Request failed');
  return result as T;
}

export function PersonalPage({ go, path, brand, themeToggle, onAuthChange }: { go: (path: string) => void; path: string; brand: React.ReactNode; themeToggle: React.ReactNode; onAuthChange: (authenticated: boolean) => void }) {
  const [authConfig, setAuthConfig] = useState<AuthConfig>();
  useEffect(() => {
    void fetch('/personal/api/auth/config').then(response => response.json()).then(setAuthConfig).catch(() => setAuthConfig({ enabled: false }));
  }, []);
  if (!authConfig) return <PersonalLoading />;
  return <React.Suspense fallback={<PersonalLoading />}><PersonalProvider config={authConfig}><PersonalContent go={go} path={path} brand={brand} themeToggle={themeToggle} onAuthChange={onAuthChange} authConfig={authConfig}/></PersonalProvider></React.Suspense>;
}

function PersonalContent({ go, path, brand, themeToggle, onAuthChange, authConfig }: { go: (path: string) => void; path: string; brand: React.ReactNode; themeToggle: React.ReactNode; onAuthChange: (authenticated: boolean) => void; authConfig: AuthConfig }) {
  const { logout: privyLogout } = usePersonalPrivy();
  const [session, setSession] = useState<Session>();
  const [home, setHome] = useState<HomeData>();
  const [activity, setActivity] = useState<Transfer[]>([]);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(false);
  const tab = path.split('/')[2] || 'home';
  const refresh = async () => {
    const s = await request<Session>('/personal/api/session');
    setSession(s);
    if (s.authenticated) {
      const [h, a] = await Promise.all([request<HomeData>('/personal/api/home'), request<{ data: Transfer[] }>('/personal/api/activity')]);
      setHome(h); setActivity(a.data);
    }
  };
  useEffect(() => { void refresh().catch((e) => { setError(e.message); setSession({ authenticated: false }); }); }, []);
  useEffect(() => { if (session) onAuthChange(!!session.authenticated); }, [session?.authenticated, onAuthChange]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); }
    finally { setBusy(false); }
  };
  const verifySandbox = () => void run(async () => {
    await request('/personal/api/sandbox/verify', 'POST', { residence_country: 'NG', acknowledge_simulation: true }, session?.csrf_token);
    await refresh(); setNotice('Sandbox verification fixture enabled. This does not verify your real identity.');
  });
  const fund = () => void run(async () => {
    await request('/personal/api/sandbox/fund', 'POST', {}, session?.csrf_token);
    await refresh(); setNotice('₦100,000.00 in simulated funds added.');
  });
  const send = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter a valid NGN amount');
    const [whole, fraction = ''] = amount.split('.');
    const amount_minor = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
    if (amount_minor === '0') throw new Error('Enter an amount greater than zero');
    await request('/personal/api/transfers', 'POST', { recipient_email: recipient, amount_minor }, session?.csrf_token, crypto.randomUUID());
    setAmount(''); setRecipient(''); await refresh(); go('/personal/activity'); setNotice('Transfer completed.');
  }); };
  const logout = () => void run(async () => { await request('/personal/api/logout', 'POST', {}, session?.csrf_token); await privyLogout().catch(() => undefined); setSession({ authenticated: false }); setHome(undefined); go('/personal/login'); });
  const nav = [ ['home', 'Home', Home], ['send', 'Send', Send], ['activity', 'Activity', History], ['profile', 'Profile', UserRound] ] as const;
  if (!session) return <PersonalLoading />;
  if (!session.authenticated) return <PersonalLogin brand={brand} go={go} error={error} authConfig={authConfig} onComplete={next => { setSession(next); void refresh(); go('/personal/home'); }} />;
  return <div className="personal-shell"><aside className={`personal-sidebar ${menu ? 'open' : ''}`}><button className="personal-brand" onClick={() => go('/personal/home')}>{brand}</button><div className="personal-sidebar-caption">PERSONAL ACCOUNT <span>Sandbox</span></div><nav>{nav.map(([id,label,Icon]) => <button key={id} className={tab===id || (tab==='money' && id==='home')?'active':''} onClick={() => {go('/personal/'+id);setMenu(false);}}><Icon size={19}/>{label}</button>)}</nav><div className="personal-sidebar-bottom"><div className="personal-sandbox-note"><ShieldCheck size={18}/><span>Simulated NGN only<br/><small>No live money movement</small></span></div><button onClick={logout}><LogOut size={18}/> Sign out</button></div></aside>
    {menu && <button className="personal-scrim" aria-label="Close menu" onClick={() => setMenu(false)}/>}
    <div className="personal-main"><header className="personal-topbar"><button className="personal-mobile-menu" aria-label="Open menu" onClick={() => setMenu(true)}><Menu size={22}/></button><span>Personal <b>/ {tab==='money'?'Move money':nav.find(([id])=>id===tab)?.[1] ?? 'Home'}</b></span><div>{themeToggle}<span className="personal-avatar">{session.email?.slice(0,1).toUpperCase()}</span></div></header><main className="personal-content">
      {error && <p className="personal-error" role="alert">{error}</p>}{notice && <p className="personal-success" role="status">{notice}</p>}
      {tab==='home' && <><div className="personal-heading"><span className="personal-eyebrow">YOUR ACCOUNT</span><h1>Your money, at a glance.</h1><p></p></div><div className="personal-balance"><div><span>AVAILABLE · SIMULATED NGN</span><strong>{money(home?.balance.available_minor ?? '0')}</strong><small>Simulated NGN</small></div><Wallet size={38}/></div><div className="personal-actions"><button onClick={() => go('/personal/money')}><Wallet size={20}/> Add / Withdraw <ArrowRight size={17}/></button><button onClick={() => go('/personal/send')}><Send size={20}/> Send <ArrowRight size={17}/></button></div><section className="personal-card"><h2>Getting started</h2>{home?.kyc_state !== 'sandbox_approved' ? <><p>Enable sandbox access to try transfers.</p><button className="personal-primary" onClick={verifySandbox} disabled={busy}>Enable sandbox verification <ArrowRight size={17}/></button></> : home.sandbox_funded ? <><p>Ready to send.</p><button className="personal-primary" onClick={() => go('/personal/send')}>Send simulated NGN <ArrowRight size={17}/></button></> : <><p>Add test funds to begin.</p><button className="personal-primary" onClick={fund} disabled={busy}>Add ₦100,000 test funds <ArrowRight size={17}/></button><small>Simulated balance only.</small></>}</section></>}
      {tab==='money' && <React.Suspense fallback={<section className="personal-card">Loading payment tests…</section>}><PersonalMoney csrf={session.csrf_token} kycState={home?.kyc_state} onBalanceChanged={refresh}/></React.Suspense>}
      {tab==='send' && <><div className="personal-heading"><span className="personal-eyebrow">SEND</span><h1>Who are you paying?</h1><p>Send simulated NGN to another Personal account.</p></div><section className="personal-card personal-form-card"><form onSubmit={send}><label>Recipient email<input type="email" value={recipient} onChange={(e)=>setRecipient(e.target.value)} placeholder="friend@example.com" required/></label><label>Amount in NGN<input inputMode="decimal" value={amount} onChange={(e)=>setAmount(e.target.value)} placeholder="0.00" required/></label><div className="personal-form-summary"><span>Fee</span><b>₦0.00 · Sandbox</b></div><button className="personal-primary" disabled={busy || home?.kyc_state!=='sandbox_approved'}>Send simulated NGN <ArrowRight size={17}/></button>{home?.kyc_state!=='sandbox_approved' && <p className="personal-muted">Enable sandbox verification on Home first.</p>}</form></section></>}
      {tab==='activity' && <><div className="personal-heading"><span className="personal-eyebrow">ACTIVITY</span><h1>Your money, in motion.</h1><p>Your recent transfers.</p></div><section className="personal-card personal-activity"><h2>Recent activity</h2>{activity.length ? activity.map((item)=><div key={item.id} className="personal-activity-row"><span className="personal-activity-icon">{item.direction==='sent'?<ArrowUpRight size={20}/>:<ArrowLeft size={20}/>}</span><span><b>{item.direction==='sent'?'Sent to':'Received from'} {item.counterparty}</b><small>{new Date(item.created_at).toLocaleString()} · Simulated · Completed</small></span><strong>{item.direction==='sent'?'-':'+'}{money(item.amount_minor)}</strong></div>) : <p className="personal-muted">No transfers yet. Your first simulated payment will appear here.</p>}</section></>}
      {tab==='profile' && <><div className="personal-heading"><span className="personal-eyebrow">PROFILE</span><h1>Account details.</h1><p></p></div><section className="personal-card personal-profile"><div><span>Email</span><b>{session.email}</b></div><div><span>Residence</span><b>{session.residence_country==='NG'?'Nigeria':'Not set'}</b></div><div><span>Display currency</span><b>{session.display_currency ?? 'NGN'}</b></div><div><span>Sandbox access</span><b>{session.kyc_state==='sandbox_approved'?'Enabled':'Not started'}</b></div><p>Sandbox access only allows simulated transfers.</p></section>{authConfig.enabled && authConfig.app_id && <React.Suspense fallback={<section className="personal-card"><h2>Settlement address</h2><p>Loading…</p></section>}><PersonalWallet subject={session.privy_subject ?? null}/></React.Suspense>}<PersonalKyc csrf={session.csrf_token}/></>}
    </main></div></div>;
}
