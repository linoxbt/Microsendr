import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { ArrowUpRight, Copy } from 'lucide-react';

type Balance = { balance_wei: string; block_number: string; explorer_url: string };

function WalletDetails({ subject }: { subject: string | null }) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const matched = !!subject && authenticated && user?.id === subject;
  const wallet = matched ? wallets.find(item => item.walletClientType === 'privy') : undefined;
  const [balance, setBalance] = useState<Balance>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetch(`/personal/api/qie/balance?address=${encodeURIComponent(wallet.address)}`, { credentials: 'include' })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message ?? 'QIE balance is unavailable');
        return result as Balance;
      })
      .then(result => { if (!cancelled) setBalance(result); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'QIE balance is unavailable'); });
    return () => { cancelled = true; };
  }, [wallet?.address]);
  if (!ready) return <p className="personal-muted">Opening settlement account…</p>;
  if (!matched || !wallet) return <p className="personal-muted">Your settlement address will appear after you sign in with the matching Privy account.</p>;
  const wei = BigInt(balance?.balance_wei ?? '0');
  const amount = `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)}`;
  return <div className="personal-wallet-details">
    <div><span>QIE mainnet address</span><code>{wallet.address}</code></div>
    <div className="personal-wallet-actions"><button onClick={() => void navigator.clipboard.writeText(wallet.address)}><Copy size={15}/> Copy address</button><a href={balance?.explorer_url ?? `https://mainnet.qie.digital/address/${wallet.address}`} target="_blank" rel="noreferrer">View on explorer <ArrowUpRight size={15}/></a></div>
    {balance && <p>Native QIE: <strong>{amount}</strong> <small>at block {balance.block_number}</small></p>}
    {error && <p className="personal-error" role="alert">{error}</p>}
    <small>Network preview only. Do not deposit funds yet: Microsendr is not monitoring or crediting QIE deposits. This balance is separate from simulated NGN.</small>
  </div>;
}

export function PersonalWallet({ subject }: { subject: string | null }) {
  return <section className="personal-card"><h2>Settlement address</h2><WalletDetails subject={subject}/></section>;
}
