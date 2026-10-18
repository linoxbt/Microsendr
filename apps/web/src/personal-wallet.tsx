import React, { useEffect, useState, type FormEvent } from 'react';
import { usePrivy, useSendTransaction, useSignMessage, useWallets } from '@privy-io/react-auth';
import { formatUnits, isAddress, parseUnits } from 'viem';
import { ArrowUpRight, Copy } from 'lucide-react';
import { nativeTransferAuthorization } from '../../../packages/settlement/src/index.js';

type Balance = { balance_wei: string; block_number: string; explorer_url: string };
type Settlement = { id: string; status: string; amount_atomic: string; to: string; tx_hash: string | null;
  explorer_url: string | null; confirmations: number; required_confirmations: number };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Settlement request failed');
  return result as T;
}

function WalletDetails({ subject, accountId, csrf, showSend }: { subject: string | null; accountId: string; csrf: string; showSend: boolean }) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const { signMessage } = useSignMessage();
  const matched = !!subject && authenticated && user?.id === subject;
  const wallet = matched ? wallets.find(item => item.walletClientType === 'privy') : undefined;
  const [balance, setBalance] = useState<Balance>();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [recoveryHashes, setRecoveryHashes] = useState<Record<string,string>>({});
  const refresh = async (address: string) => {
    const list = await api<{ data: Settlement[] }>('/personal/api/settlements');
    setSettlements(list.data);
    void api<Balance>(`/personal/api/qie/balance?address=${encodeURIComponent(address)}`)
      .then(setBalance).catch(() => undefined);
  };
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void api<Balance>(`/personal/api/qie/balance?address=${encodeURIComponent(wallet.address)}`)
      .then(nextBalance => { if (!cancelled) setBalance(nextBalance); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'QIE is unavailable'); });
    void api<{ data: Settlement[] }>('/personal/api/settlements')
      .then(list => { if (!cancelled) setSettlements(list.data); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Transfer history is unavailable'); });
    return () => { cancelled = true; };
  }, [wallet?.address]);
  useEffect(() => {
    if (!wallet || !settlements.some(item => ['submitted','pending','unknown'].includes(item.status))) return;
    const timer = window.setInterval(() => { void api<{ data: Settlement[] }>('/personal/api/settlements').then(list => setSettlements(list.data)).catch(() => undefined); }, 15000);
    return () => window.clearInterval(timer);
  }, [wallet?.address, settlements]);
  const submitHash = async (id: string, hash: string) => {
    await api<Settlement>(`/personal/api/settlements/${id}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kora-csrf': csrf },
      body: JSON.stringify({ tx_hash: hash }),
    });
    setPendingId(''); setTxHash('');
    if (wallet) await refresh(wallet.address);
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!wallet || !accountId) return;
    setBusy(true); setError('');
    try {
      if (!isAddress(destination) || destination.toLowerCase() === wallet.address.toLowerCase())
        throw new Error('Enter another valid QIE wallet address');
      const amountAtomic = parseUnits(amount, 18);
      if (amountAtomic <= 0n) throw new Error('Enter an amount above zero');
      if (balance && amountAtomic >= BigInt(balance.balance_wei))
        throw new Error('Leave some QIE for the network fee');
      await wallet.switchChain(1990);
      const idempotencyKey = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
      const message = nativeTransferAuthorization({ accountId, network: 'qie-mainnet', chainId: 1990n,
        from: wallet.address, to: destination, amountAtomic, idempotencyKey, expiresAt });
      const { signature } = await signMessage({ message }, { address: wallet.address });
      const intent = await api<Settlement>('/personal/api/settlements', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-kora-csrf': csrf, 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ network: 'qie-mainnet', from: wallet.address, to: destination,
          amount_atomic: amountAtomic.toString(), expires_at: expiresAt, signature }),
      });
      setPendingId(intent.id);
      const { hash } = await sendTransaction({ to: destination as `0x${string}`, value: amountAtomic, chainId: 1990 }, { address: wallet.address });
      setTxHash(hash);
      await submitHash(intent.id, hash);
      setAmount(''); setDestination('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'QIE transfer could not start'); }
    finally { setBusy(false); }
  };
  if (!ready) return <p className="personal-muted">Opening settlement account…</p>;
  if (!matched || !wallet) return <p className="personal-muted">Your QIE address will appear after you sign in with the matching Privy account.</p>;
  return <div className="personal-wallet-details">
    <div><span>QIE Mainnet · native QIEV3</span><code>{wallet.address}</code></div>
    <div className="personal-wallet-actions"><button onClick={() => void navigator.clipboard.writeText(wallet.address)}><Copy size={15}/> Copy address</button><a href={balance?.explorer_url ?? `https://mainnet.qie.digital/address/${wallet.address}`} target="_blank" rel="noreferrer">View on explorer <ArrowUpRight size={15}/></a></div>
    {balance && <p>Wallet balance: <strong>{formatUnits(BigInt(balance.balance_wei), 18)} QIEV3</strong> <small>at block {balance.block_number}</small></p>}
    <small>This is your Privy wallet on QIE Mainnet. Only native QIEV3 is tracked here. It is separate from simulated NGN and is not a bank balance. Check the network and address before receiving funds.</small>
    {showSend && <form onSubmit={event => void send(event)} className="personal-qie-form">
      <h3>Send QIEV3</h3><p>Live QIE Mainnet transfer. The wallet will ask you to approve it. Confirmed transfers cannot be reversed.</p>
      <label>Recipient QIE address<input value={destination} onChange={event => setDestination(event.target.value.trim())} placeholder="0x…" required/></label>
      <label>Amount in QIEV3<input value={amount} onChange={event => setAmount(event.target.value.trim())} inputMode="decimal" placeholder="0.00" required/></label>
      <p className="personal-muted">Network fee is charged by QIE and shown by your wallet before approval. Microsendr fee: 0 QIEV3.</p>
      <button className="personal-primary" disabled={busy}>{busy ? 'Confirm in wallet…' : 'Review in wallet'}</button>
    </form>}
    {pendingId && txHash && <div className="personal-qie-retry"><p>Transaction sent. Save this hash until tracking is linked: <code>{txHash}</code></p><button className="personal-secondary" disabled={busy} onClick={() => void submitHash(pendingId,txHash).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not link transaction'))}>Retry tracking</button></div>}
    {error && <p className="personal-error" role="alert">{error}</p>}
    {settlements.length > 0 && <div className="personal-qie-history"><h3>QIE transfers</h3>{settlements.map(item => <div key={item.id}><span><b>{formatUnits(BigInt(item.amount_atomic),18)} QIEV3</b><small>To {item.to}</small><small>{item.status} · {item.confirmations}/{item.required_confirmations} confirmations</small>{item.status==='awaiting_submission' && <span className="personal-qie-recovery"><input aria-label="QIE transaction hash" value={recoveryHashes[item.id] ?? ''} onChange={event => setRecoveryHashes(previous => ({ ...previous, [item.id]: event.target.value.trim() }))} placeholder="Transaction hash (0x…)"/><button type="button" disabled={!/^0x[a-fA-F0-9]{64}$/.test(recoveryHashes[item.id] ?? '')} onClick={() => void submitHash(item.id,recoveryHashes[item.id]).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not link transaction'))}>Track transaction</button></span>}</span>{item.explorer_url && <a href={item.explorer_url} target="_blank" rel="noreferrer">Transaction <ArrowUpRight size={14}/></a>}</div>)}</div>}
  </div>;
}

export function PersonalWallet({ subject, accountId, csrf, showSend = false }: { subject: string | null; accountId: string; csrf: string; showSend?: boolean }) {
  return <section className="personal-card personal-qie-card"><h2>{showSend ? 'QIE Mainnet' : 'Settlement address'}</h2><WalletDetails subject={subject} accountId={accountId} csrf={csrf} showSend={showSend}/></section>;
}
