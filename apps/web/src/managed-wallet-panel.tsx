import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatEther, getAddress, isAddress, parseEther } from 'viem';
import { ArrowRight, ArrowUpRight, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { consumerRequest } from './consumer-api.js';
import { RecipientStatus, recipientPattern, useRecipient } from './recipient.js';

export type ManagedLimits = { per_transfer_wei: string; daily_wei: string; requires_identity_verification: boolean };
type Balance = { balance_wei: string };
const explorer = 'https://mainnet.qie.digital/';
const qie = (wei: string) => formatEther(BigInt(wei)).replace(/(\.\d{0,6})\d*$/, '$1').replace(/\.$/, '');

/**
 * The Roots account wallet: Roots holds its key (through Privy) and signs
 * sends server-side after the account password confirms each one.
 */
export function ManagedWalletPanel({ wallet, limits, mode, csrf, onChanged, initialRecipient = '' }: {
  wallet: { id: string; address: string };
  limits: ManagedLimits;
  mode: 'receive' | 'send';
  csrf: string;
  onChanged?: () => Promise<unknown> | void;
  initialRecipient?: string;
}) {
  const [balance, setBalance] = useState<Balance>();
  const [qr, setQr] = useState('');
  const [to, setTo] = useState(initialRecipient);
  const payee = useRecipient(to);
  const [amount, setAmount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sent, setSent] = useState<{ id: string; tx_hash: string | null }>();
  // One key per intended transfer: a retry after a timeout cannot send twice.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  async function loadBalance() {
    try { setBalance(await consumerRequest<Balance>(`wallets/${encodeURIComponent(wallet.id)}/balance`)); }
    catch (cause) { setError((cause as Error).message); }
  }
  useEffect(() => { void loadBalance(); }, [wallet.id]);
  useEffect(() => {
    if (mode !== 'receive') return;
    void QRCode.toDataURL(wallet.address, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#183247', light: '#ffffff' } })
      .then(setQr).catch(() => setError('Could not create the QR code. Copy the address instead.'));
  }, [mode, wallet.address]);

  async function copy() {
    try { await navigator.clipboard.writeText(wallet.address); setNotice('Address copied.'); }
    catch { setError('Copy is unavailable. Select the address shown below.'); }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const target = payee.recipient?.address;
      if (!target || getAddress(target) === getAddress(wallet.address)) throw new Error(payee.error ?? 'Enter a QIE address or the @username of a Roots user.');
      if (!/^\d+(?:\.\d{1,18})?$/.test(amount) || parseEther(amount) <= 0n) throw new Error('Enter a QIE amount above zero.');
      const result = await consumerRequest<{ id: string; tx_hash: string | null }>('wallets/managed/transfers', 'POST',
        { to: target, amount_atomic: parseEther(amount).toString(), password,
          ...(payee.recipient?.username ? { recipient_username: payee.recipient.username } : {}) }, csrf, { 'Idempotency-Key': requestKey });
      setSent(result);
      setPassword('');
      setRequestKey(crypto.randomUUID());
      setNotice('Sent to QIE Mainnet. It is being confirmed.');
      try { await onChanged?.(); } catch { /* the overview refresh reports its own errors */ }
      await loadBalance();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const resetKey = () => setRequestKey(crypto.randomUUID());

  return <div className="fin-chain-managed" role="group" aria-label="Roots account wallet">
    <div className="fin-chain-balance">
      <span><ShieldCheck size={15} /> Account wallet balance</span>
      <strong>{balance ? qie(balance.balance_wei) : '—'} <small>QIEV3</small></strong>
      <button className="fin-text" type="button" onClick={() => void loadBalance()} disabled={busy}><RefreshCw size={14} /> Refresh</button>
    </div>
    {mode === 'receive' && <div className="fin-chain-receive">
      {qr && <img src={qr} alt="QR code for your account wallet address shown below" width="240" height="240" />}
      <code>{wallet.address}</code>
      <button className="fin-secondary" type="button" onClick={() => void copy()}><Copy size={16} /> Copy address</button>
      <p>Your Roots account wallet. Roots holds its key and sends only when you confirm with your password. Send only native QIEV3 on QIE Mainnet here.</p>
      <a href={`${explorer}address/${wallet.address}`} target="_blank" rel="noreferrer">View on explorer <ArrowUpRight size={15} /></a>
    </div>}
    {mode === 'send' && (sent ? <div className="fin-chain-pending">
      <ShieldCheck size={19} /><div><b>Transfer reference: {sent.id}</b>
        <p>Broadcast to QIE Mainnet. Awaiting confirmation.</p>
        {sent.tx_hash && <a href={`${explorer}tx/${sent.tx_hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a>}
      </div>
      <button className="fin-text" type="button" onClick={() => { setSent(undefined); setTo(''); setAmount(''); }}>New send</button>
    </div> : <form className="fin-chain-send" onSubmit={send}>
      <label>Recipient<input value={to} onChange={e => { setTo(e.target.value.trim()); resetKey(); }}
        placeholder="@username or 0x…" autoComplete="off" required pattern={recipientPattern} title="A Roots @username or a 0x-prefixed QIE address" /></label>
      <RecipientStatus state={payee} />
      <label>Amount in QIEV3<input value={amount} onChange={e => { setAmount(e.target.value); resetKey(); }}
        placeholder="0.00" inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,18})?" title="A QIE amount, up to 18 decimal places" /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)}
        autoComplete="current-password" required /></label>
      <p>Up to {qie(limits.per_transfer_wei)} QIE per transfer and {qie(limits.daily_wei)} QIE per 24 hours.
        {limits.requires_identity_verification ? ' Requires completed identity verification.' : ''} The network fee is paid from this wallet. Onchain sends cannot be reversed.</p>
      <button className="fin-primary" disabled={busy}>{busy ? 'Sending…' : 'Confirm and send'} <ArrowRight size={17} /></button>
    </form>)}
    {notice && <p className="fin-chain-notice" role="status">{notice}</p>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </div>;
}
