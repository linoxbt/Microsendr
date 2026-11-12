import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Fingerprint, RefreshCw, Share2 } from 'lucide-react';
import { consumerRequest, isNetworkError } from './consumer-api.js';
import { RecipientStatus, recipientPattern, useRecipient } from './recipient.js';
import { MicrosendrMark } from './microsendr-logo.js';
import { startAuthentication } from '@simplewebauthn/browser';
import { passkeysSupported, type PaymentAuthStatus } from './payment-security.js';

type ManagedLimits = {
  per_transfer_wei: string; daily_wei: string; requires_identity_verification: boolean;
  qusdc_per_transfer_atomic?: string; qusdc_daily_atomic?: string;
};
export type Token = 'QIE' | 'QUSDC';
// Both tokens live on QIE Mainnet at the same wallet address.
const TOKENS: Record<Token, { decimals: number; label: string }> = { QIE: { decimals: 18, label: 'QIE' }, QUSDC: { decimals: 6, label: 'QUSDC' } };
const QUSDC_CONTRACT = '0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5';
const word = (hex: string) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** transfer(to, amount) on the QUSDC contract. */
const qusdcTransferData = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${word(amount.toString(16))}`;

type WalletRecord = {
  id: string;
  address: string;
  label?: string;
  network: string;
  managed?: boolean;
  custody?: string;
  can_send?: boolean;
};
type Balance = {
  balance_wei: string; block_number: string; explorer_url: string; asset: string;
};
type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
const qieChainId = '0x7c6';
const explorer = 'https://mainnet.qie.digital/';
/** A managed (custodial) wallet is offered for deposits only when it can also send. */
export const isManaged = (wallet: WalletRecord) => wallet.managed === true || wallet.custody === 'managed';

function provider(): EthereumProvider {
  const injected = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!injected) throw new Error('Install or open a compatible EVM wallet to link and send QIE.');
  return injected;
}
async function mainnet(wallet: EthereumProvider) {
  let chain = await wallet.request({ method: 'eth_chainId' });
  if (chain !== qieChainId) {
    try {
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: qieChainId }] });
    } catch (error) {
      if ((error as { code?: number }).code !== 4902) throw error;
      await wallet.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: qieChainId, chainName: 'QIE Mainnet',
        nativeCurrency: { name: 'QIE', symbol: 'QIEV3', decimals: 18 },
        rpcUrls: ['https://rpc1mainnet.qie.digital/'],
        blockExplorerUrls: [explorer],
      }] });
    }
    chain = await wallet.request({ method: 'eth_chainId' });
  }
  if (chain !== qieChainId) throw new Error('Switch your wallet to QIE Mainnet before continuing.');
}
async function selectedAccount(wallet: EthereumProvider) {
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !isAddress(accounts[0]))
    throw new Error('Choose an EVM wallet account to continue.');
  return getAddress(accounts[0]);
}
async function signature(wallet: EthereumProvider, address: string, message: string) {
  const signed = await wallet.request({ method: 'personal_sign', params: [message, address] });
  if (typeof signed !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signed))
    throw new Error('Your wallet did not return a valid signature.');
  return signed;
}

type Source = { key: string; wallet: WalletRecord; managed: boolean; label: string };
/**
 * A send in progress. `done` shows the Sent screen; `unrecorded` means the wallet broadcast
 * it but Microsendr could not record it yet, so the user can finish recording.
 */
type Sent = { id: string; hash?: string | null; done: boolean; unrecorded?: boolean };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Receive and send QIE. Sources are the Microsendr account wallet (only while it can
 * also send) and the self-custody wallets the user linked. Receive shows one
 * address at a time; send goes form → review → done.
 */
export function ConsumerChainWallet({
  csrf, mode, onChanged, initialRecipient = '', initialToken = 'QIE', go,
}: {
  csrf: string;
  mode: 'receive' | 'send';
  onChanged?: () => Promise<unknown> | void;
  initialRecipient?: string;
  initialToken?: Token;
  go?: (path: string) => void;
}) {
  // The token is chosen on the step before this screen.
  const token = initialToken;
  // What the user typed survives switching token or wallet.
  const [draft, setDraft] = useState({ to: initialRecipient, amount: '' });
  const [wallets, setWallets] = useState<WalletRecord[]>();
  const [limits, setLimits] = useState<ManagedLimits | null>(null);
  const [sourceKey, setSourceKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Once a payment is under review the source is fixed.
  const [locked, setLocked] = useState(false);

  const managed = (wallets ?? []).find(isManaged);
  const managedOpen = !!managed?.can_send && !!limits;
  const linked = (wallets ?? []).filter(wallet => !isManaged(wallet));
  // Your Microsendr address can always receive; it is offered for sending while account-wallet sends are on.
  const sources: Source[] = [
    ...(managed && (mode === 'receive' || managedOpen) ? [{ key: managed.id, wallet: managed, managed: true, label: 'Microsendr wallet' }] : []),
    ...linked.map((wallet) => ({
      key: wallet.id, wallet, managed: false,
      label: linked.length > 1 ? `Wallet ··${wallet.address.slice(-4)}` : 'My wallet',
    })),
  ];
  const source = sources.find(s => s.key === sourceKey) ?? sources[0];

  async function notifyChanged() {
    try { await onChanged?.(); } catch { /* the overview refresh reports its own errors */ }
  }
  async function loadWallets() {
    const result = await consumerRequest<{ data: WalletRecord[]; managed_transfers?: ManagedLimits | null }>('wallets');
    setWallets(result.data);
    setLimits(result.managed_transfers ?? null);
  }
  useEffect(() => { void loadWallets().catch(e => setError((e as Error).message)); }, []);
  useEffect(() => { setNotice(''); setError(''); }, [source?.key]);

  async function setUpAccountWallet() {
    setBusy(true); setError('');
    try { await consumerRequest('wallets/managed', 'POST', {}, csrf); await loadWallets(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const switcher = sources.length > 1 && !locked && (
    <div className="fin-source-switch" role="group" aria-label={mode === 'receive' ? 'Receive to' : 'Send from'}>
      {sources.map(s => <button key={s.key} type="button" aria-pressed={s.key === source?.key}
        className={s.key === source?.key ? 'active' : ''} onClick={() => setSourceKey(s.key)}>{s.label}</button>)}
    </div>
  );
  return <section className={`fin-chain-wallet fin-chain-wallet-${mode}`} aria-label="QIE wallet">
    {switcher}
    {!wallets ? <div className={`fin-wallet-skeleton fin-wallet-skeleton-${mode}`} role="status" aria-label="Loading wallets">
        {mode === 'receive' ? <><i className="fin-sk fin-sk-line" /><i className="fin-sk fin-sk-qr" /></>
          : <><i className="fin-sk fin-sk-field" /><i className="fin-sk fin-sk-field" /><i className="fin-sk fin-sk-button" /></>}
      </div>
      : !source ? <div className="fin-chain-empty" role="group" aria-label="Microsendr account wallet">
        {mode === 'receive' && <h1 className="fin-sr-only">Your address</h1>}
        {managed
          ? <p>Sending isn’t available right now. You can still receive.</p>
          : <><p>Your Microsendr address is being set up.</p>
            <button className="fin-secondary" type="button" onClick={() => void setUpAccountWallet()} disabled={busy}>
              <RefreshCw size={15} /> {busy ? 'Checking…' : 'Check again'}
            </button></>}
      </div>
      : mode === 'receive' ? <ReceiveCard key={source.key} source={source} token={token} />
        : <SendFlow key={`${source.key}-${token}`} source={source} token={token} limits={limits} csrf={csrf} draft={draft} onDraft={setDraft}
          onChanged={notifyChanged} onLock={setLocked} go={go} />}
    {notice && <p className="fin-chain-notice" role="status">{notice}</p>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </section>;
}

function ReceiveCard({ source, token }: { source: Source; token: Token }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  const address = source.wallet.address;
  useEffect(() => {
    // High error correction keeps the code readable under the centre mark.
    void QRCode.toDataURL(address, { width: 480, margin: 0, errorCorrectionLevel: 'H', color: { dark: '#0f1c27', light: '#ffffff' } })
      .then(setQr).catch(() => setProblem('Could not draw the QR code. Copy the address instead.'));
  }, [address]);
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { setProblem('Copy is unavailable. Select the address instead.'); }
  }
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  return <div className="fin-receive" role="group" aria-label={source.managed ? 'Microsendr account wallet' : 'Linked wallet'}>
    <h1 className="fin-sr-only">Your address</h1>
    <p className="fin-receive-warning">Only send {token} on QIE Mainnet.</p>
    <div className="fin-chain-receive">
      <div className="fin-qr">
        {qr && <img src={qr} width="240" height="240"
          alt={source.managed ? 'QR code for your account wallet address' : 'QR code for the QIE wallet address shown below'} />}
        <span className="fin-qr-mark" aria-hidden="true">{token === 'QUSDC' ? <img src="/images/qusdc-icon.jpg" alt="" /> : <MicrosendrMark />}</span>
      </div>
      <code>{address}</code>
    </div>
    <div className="fin-receive-actions">
      <button type="button" className="fin-receive-copy" onClick={() => void copy()}>
        {copied ? <Check size={18} /> : <Copy size={18} />} {copied ? 'Copied' : 'Copy'}
      </button>
      {canShare && <button type="button" className="fin-receive-share" aria-label="Share address"
        onClick={() => void navigator.share({ text: address }).catch(() => undefined)}><Share2 size={18} /></button>}
    </div>
    {problem && <p className="fin-error" role="alert">{problem}</p>}
  </div>;
}

function SendFlow({ source, token, limits, csrf, draft, onDraft, onChanged, onLock, go }: {
  source: Source; token: Token; limits: ManagedLimits | null; csrf: string;
  draft: { to: string; amount: string }; onDraft: (draft: { to: string; amount: string }) => void;
  onChanged: () => Promise<void>; onLock: (locked: boolean) => void; go?: (path: string) => void;
}) {
  const [to, setToRaw] = useState(draft.to);
  const payee = useRecipient(to);
  const [amount, setAmountRaw] = useState(draft.amount);
  const setTo = (value: string) => { setToRaw(value); onDraft({ to: value, amount }); };
  const setAmount = (value: string) => { setAmountRaw(value); onDraft({ to, amount: value }); };
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [auth, setAuth] = useState<PaymentAuthStatus>();
  const [method, setMethod] = useState<'passkey' | 'pin' | 'password'>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Sent>();
  // One key per intended transfer: a retry after a timeout cannot send twice.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const fresh = () => setRequestKey(crypto.randomUUID());
  const { decimals } = TOKENS[token];
  const atomicAmount = () => parseUnits(amount, decimals);
  useEffect(() => { onLock(step !== 'form' || !!sent); return () => onLock(false); }, [step, sent]);
  const pinLocked = !!auth?.pin_locked_until && new Date(auth.pin_locked_until) > new Date();
  const pinUsable = !!auth?.pin_set && !pinLocked;
  // The account wallet is approved by passkey, else PIN (unless locked), else password.
  useEffect(() => {
    if (!source.managed || step !== 'review' || auth) return;
    void consumerRequest<PaymentAuthStatus>('payment-auth').then((status) => {
      setAuth(status);
      const locked = !!status.pin_locked_until && new Date(status.pin_locked_until) > new Date();
      setMethod(status.passkeys.length && passkeysSupported() ? 'passkey' : status.pin_set && !locked ? 'pin' : 'password');
    }).catch(() => setAuth({ pin_set: false, pin_locked_until: null, passkeys: [] }));
  }, [source.managed, step, auth]);

  function review(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const target = payee.recipient?.address;
    if (target && getAddress(target) === getAddress(source.wallet.address))
      return setError("That's this wallet's own address. Choose someone else to pay.");
    if (!target) return setError(payee.error ?? 'Enter a QIE address or the @username of a Microsendr user.');
    if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(amount) || atomicAmount() <= 0n)
      return setError(`Enter an amount above zero, with up to ${decimals} decimal places.`);
    const max = token === 'QUSDC' ? limits?.qusdc_per_transfer_atomic : limits?.per_transfer_wei;
    if (source.managed && max && atomicAmount() > BigInt(max))
      return setError(`The most you can send at once is ${formatUnits(BigInt(max), decimals)} ${token}.`);
    setStep('review');
  }
  const extra = payee.recipient?.username ? { recipient_username: payee.recipient.username } : {};

  async function approval() {
    const transfer = { to: payee.recipient!.address, amount_atomic: atomicAmount().toString(), asset: token };
    if (method === 'pin') return { pin };
    if (method === 'password') return { password };
    const { challenge_id, options } = await consumerRequest<{ challenge_id: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
      'payment-auth/passkeys/challenge', 'POST', transfer, csrf);
    const response = await startAuthentication({ optionsJSON: options }).catch(() => {
      throw new Error('The passkey did not approve this payment. Try again or use your PIN.');
    });
    return { passkey: { challenge_id, response } };
  }
  async function sendManaged() {
    const result = await consumerRequest<{ id: string; tx_hash: string | null; status: string }>('wallets/managed/transfers', 'POST',
      { to: payee.recipient!.address, amount_atomic: atomicAmount().toString(), asset: token, ...(await approval()), ...extra }, csrf, { 'Idempotency-Key': requestKey });
    setPassword(''); setPin('');
    // Only a transfer that was signed and recorded counts as sent.
    if (!result.tx_hash || ['expired', 'failed', 'mismatched'].includes(result.status)) {
      fresh();
      throw new Error('That attempt did not go through and nothing was sent. Try again.');
    }
    setSent({ id: result.id, hash: result.tx_hash, done: true });
  }
  // The wallet already broadcast the transaction; record it with Microsendr, retrying briefly.
  async function record(settlementId: string, hash: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        await consumerRequest(`settlements/${settlementId}/submit`, 'POST', { tx_hash: hash }, csrf);
        setSent({ id: settlementId, hash, done: true });
        return;
      } catch (cause) {
        if (attempt >= 2) {
          setSent({ id: settlementId, hash, done: false, unrecorded: true });
          throw new Error('Your wallet sent the payment, but Microsendr could not record it yet. Tap Finish recording.');
        }
        await sleep(1000 * 3 ** attempt);
      }
    }
  }
  async function sendLinked() {
    const target = payee.recipient!.address;
    const atomic = atomicAmount();
    const injected = provider();
    await mainnet(injected);
    const connected = await selectedAccount(injected);
    if (connected.toLowerCase() !== source.wallet.address.toLowerCase())
      throw new Error(`Select ${short(source.wallet.address)} in your wallet.`);
    const current = await consumerRequest<{ balance_wei: string; qusdc_balance_atomic?: string }>(`wallets/${source.wallet.id}/balance`);
    if (token === 'QIE' ? atomic >= BigInt(current.balance_wei) : BigInt(current.balance_wei) === 0n)
      throw new Error('Leave enough QIE in this wallet to pay the network fee.');
    if (token === 'QUSDC' && atomic > BigInt(current.qusdc_balance_atomic ?? '0'))
      throw new Error('This wallet does not have enough QUSDC.');
    const authorization = await consumerRequest<{ message: string; idempotency_key: string; expires_at: string; network: string }>(
      'settlements/authorization', 'POST', { from: source.wallet.address, to: target, amount_atomic: atomic.toString(), asset: token }, csrf);
    const signed = await signature(injected, source.wallet.address, authorization.message);
    const settlement = await consumerRequest<{ id: string }>('settlements', 'POST', {
      network: authorization.network, from: source.wallet.address, to: target,
      amount_atomic: atomic.toString(), expires_at: authorization.expires_at, signature: signed, asset: token, ...extra,
    }, csrf, { 'Idempotency-Key': authorization.idempotency_key });
    setSent({ id: settlement.id, done: false });
    // Only the wallet can broadcast. A rejected or ambiguous provider result is never retried automatically.
    if (await injected.request({ method: 'eth_chainId' }) !== qieChainId)
      throw new Error('Network changed. No transfer was requested. Switch back to QIE Mainnet.');
    // QUSDC is a call to the token contract; QIE is a plain value transfer.
    const hash = await injected.request({ method: 'eth_sendTransaction', params: [token === 'QUSDC'
      ? { from: source.wallet.address, to: QUSDC_CONTRACT, value: '0x0', data: qusdcTransferData(target, atomic), chainId: qieChainId }
      : { from: source.wallet.address, to: target, value: `0x${atomic.toString(16)}`, chainId: qieChainId }] });
    if (typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash))
      throw new Error('Check your wallet history before attempting another transfer.');
    await record(settlement.id, hash);
  }
  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await (source.managed ? sendManaged() : sendLinked());
      fresh();
      await onChanged();
    } catch (cause) {
      const code = (cause as { code?: string | null }).code;
      // A definite refusal frees the attempt; an unclear outcome keeps its key, so retrying
      // returns the same transfer instead of sending twice.
      if (code && ['transfer_failed', 'transfer_expired', 'idempotency_conflict'].includes(code)) fresh();
      setError(isNetworkError(cause)
        ? "We couldn't confirm whether this went through. Check Activity before trying again."
        : (cause as Error).message || 'Check your wallet history before retrying.');
    }
    finally { setBusy(false); }
  }
  async function finishRecording() {
    if (!sent?.hash || busy) return;
    setBusy(true); setError('');
    try { await record(sent.id, sent.hash); await onChanged(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const who = payee.recipient?.username ? `@${payee.recipient.username}` : payee.recipient ? short(payee.recipient.address) : '';

  if (sent?.done) return <div className="fin-send-done" role="status">
    <span className="fin-send-done-icon"><Check size={28} /></span>
    <h2>Sent</h2>
    <p>{amount} {token} to {who}</p>
    <p className="fin-small">Confirming on QIE Mainnet. It shows as completed in Activity once final.</p>
    {sent.hash && <a href={`${explorer}tx/${sent.hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a>}
    <button className="fin-secondary" type="button" onClick={() => { setSent(undefined); setStep('form'); setTo(''); setAmount(''); }}>Done</button>
  </div>;

  if (sent?.unrecorded) return <div className="fin-send-done" role="alert">
    <h2>Almost done</h2>
    <p>Your wallet sent {amount} {token} to {who}. Microsendr still needs to record it.</p>
    {sent.hash && <a href={`${explorer}tx/${sent.hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a>}
    <button className="fin-primary" type="button" onClick={() => void finishRecording()} disabled={busy}>{busy ? 'Recording…' : 'Finish recording'}</button>
    {error && <p className="fin-error">{error}</p>}
  </div>;

  if (step === 'review') return <form className="fin-send-review" onSubmit={confirm} aria-label="Review payment">
    <button type="button" className="fin-text fin-send-edit" onClick={() => { setStep('form'); setError(''); }} disabled={busy}>
      <ArrowLeft size={15} /> Edit
    </button>
    <div className="fin-send-summary">
      <span>You send</span>
      <strong>{amount} <small>{token}</small></strong>
      <span>to <b>{payee.recipient?.label ?? who}</b></span>
    </div>
    <dl className="fin-send-facts">
      <div><dt>From</dt><dd>{source.label}</dd></div>
      <div><dt>Network fee</dt><dd>Paid from this wallet</dd></div>
    </dl>
    {source.managed && method === 'pin' && <label>Payment PIN<input className="fin-pin-input" type="password" inputMode="numeric"
      autoComplete="off" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} pattern="[0-9]{6}"
      maxLength={6} required autoFocus /></label>}
    {source.managed && method === 'password' && <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)}
      autoComplete="current-password" required autoFocus /></label>}
    <button className="fin-primary" disabled={busy || (source.managed && !auth) || (method === 'pin' && pin.length !== 6)}>
      {busy ? 'Sending…' : !source.managed ? 'Confirm in wallet' : method === 'passkey'
        ? <><Fingerprint size={18} /> Confirm with passkey</> : <>Confirm and send <ArrowRight size={17} /></>}
    </button>
    {source.managed && auth && <div className="fin-approval-switch">
      {method !== 'passkey' && !!auth.passkeys.length && passkeysSupported() && <button type="button" className="fin-text" onClick={() => setMethod('passkey')}>Use passkey</button>}
      {method !== 'pin' && pinUsable && <button type="button" className="fin-text" onClick={() => setMethod('pin')}>Use PIN</button>}
      {auth.send_hold_until && new Date(auth.send_hold_until) > new Date() && <span className="fin-small">Sending is paused until {new Date(auth.send_hold_until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} after a recent sign-in change</span>}
      {pinLocked && <span className="fin-small">PIN locked until {new Date(auth.pin_locked_until!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      {!auth.pin_set && !auth.passkeys.length && go && <button type="button" className="fin-text" onClick={() => go('/personal/security')}>Set up a PIN or passkey</button>}
    </div>}
    {sent && !sent.done && <p className="fin-small" role="status">Reference {sent.id}. Check your wallet history before trying again.</p>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </form>;

  return <form className="fin-chain-send" onSubmit={review}>
    <label>Recipient<input value={to} onChange={e => { setTo(e.target.value.trim()); fresh(); }}
      placeholder="@username or 0x…" autoComplete="off" autoCapitalize="none" spellCheck={false} required
      pattern={recipientPattern} title="A Microsendr @username or a 0x-prefixed QIE address" /></label>
    <RecipientStatus state={payee} />
    <label className="fin-amount-field">Amount
      <span><input value={amount} onChange={e => { setAmount(e.target.value); fresh(); }} placeholder="0.00" inputMode="decimal" required
        pattern={`[0-9]+(\\.[0-9]{1,${decimals}})?`} title={`A ${token} amount, up to ${decimals} decimal places`} /><b>{token}</b></span>
    </label>
    <button className="fin-primary" disabled={payee.loading}>Continue <ArrowRight size={17} /></button>
    {error && <p className="fin-error" role="alert">{error}</p>}
  </form>;
}
