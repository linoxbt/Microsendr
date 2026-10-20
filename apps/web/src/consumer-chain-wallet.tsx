import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatEther, getAddress, isAddress, parseEther } from 'viem';
import { ArrowRight, ArrowUpRight, Copy, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { consumerRequest } from './consumer-api.js';

type WalletRecord = { id: string; address: string; label: string; network: string; managed?: boolean };
type Balance = {
  balance_wei: string; block_number: string; explorer_url: string; asset: string;
};
type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
const qieChainId = '0x7c6';
const explorer = 'https://mainnet.qie.digital/';
function previewAmount(wei: string) {
  const [whole, fraction = ''] = formatEther(BigInt(wei)).split('.');
  const short = fraction.slice(0, 6).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString()}${short ? `.${short}` : ''}`;
}

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

export function ConsumerChainWallet({
  csrf, mode, go, onChanged,
}: {
  csrf: string;
  mode: 'summary' | 'receive' | 'send';
  go: (path: string) => void;
  onChanged?: () => void;
}) {
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [balance, setBalance] = useState<Balance>();
  const [qr, setQr] = useState('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ id: string; hash?: string }>();
  const selected = wallets.find(wallet => wallet.id === selectedId);

  async function loadWallets() {
    const result = await consumerRequest<{ data: WalletRecord[] }>('wallets');
    setWallets(result.data);
    setSelectedId(current => result.data.some(wallet => wallet.id === current)
      ? current : result.data[0]?.id ?? '');
  }
  useEffect(() => { void loadWallets().catch(e => setError((e as Error).message)); }, []);
  useEffect(() => {
    setBalance(undefined);
    if (!selectedId) return;
    void consumerRequest<Balance>(`wallets/${selectedId}/balance`)
      .then(setBalance).catch(e => setError((e as Error).message));
  }, [selectedId]);
  useEffect(() => {
    setQr('');
    if (mode !== 'receive' || !selected) return;
    void QRCode.toDataURL(selected.address, {
      width: 240, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#183247', light: '#ffffff' },
    }).then(setQr).catch(() => setError('Could not create the QR code. Copy the address instead.'));
  }, [mode, selected?.address]);

  async function refreshBalance() {
    if (!selected) return;
    setBusy(true); setError('');
    try { setBalance(await consumerRequest<Balance>(`wallets/${selected.id}/balance`)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function copyAddress() {
    if (!selected) return;
    try { await navigator.clipboard.writeText(selected.address); setNotice('Address copied.'); }
    catch { setError('Copy is unavailable. Select the address shown below.'); }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || selected.managed || pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!isAddress(destination) || getAddress(destination) === getAddress(selected.address))
        throw new Error('Enter a different valid QIE recipient address.');
      if (!/^\d+(?:\.\d{1,18})?$/.test(amount)) throw new Error('Enter a valid QIE amount.');
      const atomic = parseEther(amount);
      if (atomic <= 0n) throw new Error('Enter an amount above zero.');
      const injected = provider();
      await mainnet(injected);
      const connected = await selectedAccount(injected);
      if (connected.toLowerCase() !== selected.address.toLowerCase())
        throw new Error('Select the linked sending address in your wallet.');
      const current = await consumerRequest<Balance>(`wallets/${selected.id}/balance`);
      setBalance(current);
      if (atomic >= BigInt(current.balance_wei))
        throw new Error('Leave enough QIE in this wallet to pay the network fee.');
      const authorization = await consumerRequest<{
        message: string; idempotency_key: string; expires_at: string; network: string;
      }>('settlements/authorization', 'POST', {
        from: selected.address, to: getAddress(destination), amount_atomic: atomic.toString(),
      }, csrf);
      const signed = await signature(injected, selected.address, authorization.message);
      const settlement = await consumerRequest<{ id: string }>('settlements', 'POST', {
        network: authorization.network, from: selected.address, to: getAddress(destination),
        amount_atomic: atomic.toString(), expires_at: authorization.expires_at, signature: signed,
      }, csrf, { 'Idempotency-Key': authorization.idempotency_key });
      setPending({ id: settlement.id });
      // Only the wallet can broadcast. A rejected or ambiguous provider result is never retried automatically.
      if (await injected.request({ method: 'eth_chainId' }) !== qieChainId)
        throw new Error('Network changed. No transfer was requested. Switch back to QIE Mainnet.');
      const hash = await injected.request({ method: 'eth_sendTransaction', params: [{
        from: selected.address, to: getAddress(destination), value: `0x${atomic.toString(16)}`,
        chainId: qieChainId,
      }] });
      if (typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash))
        throw new Error('Check your wallet history before attempting another transfer.');
      setPending({ id: settlement.id, hash });
      await consumerRequest(`settlements/${settlement.id}/submit`, 'POST', { tx_hash: hash }, csrf);
      setNotice('Sent to QIE Mainnet. The transaction is being confirmed.');
      onChanged?.();
      await refreshBalance();
    } catch (cause) {
      setError((cause as Error).message || 'Check your wallet history before retrying.');
    } finally { setBusy(false); }
  }
  async function retryTracking() {
    if (!pending?.hash) return;
    setBusy(true); setError('');
    try {
      await consumerRequest(`settlements/${pending.id}/submit`, 'POST', { tx_hash: pending.hash }, csrf);
      setNotice('Transfer is being confirmed.'); onChanged?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className={`fin-panel fin-chain-wallet fin-chain-wallet-${mode}`} aria-label="QIE wallet">
    <div className="fin-section-head">
      <div><span className="fin-kicker">QIE MAINNET · NATIVE ASSET</span><h2>
        {mode === 'receive' ? 'Receive QIE' : mode === 'send' ? 'Send QIE' : 'Your QIE wallet'}
      </h2></div>
      <Wallet size={23} />
    </div>
    {!wallets.length ? <div className="fin-chain-empty">
      <p>Your wallet address is being prepared. Check again shortly.</p>
      <button className="fin-primary" type="button" onClick={() => void loadWallets().catch(e => setError((e as Error).message))} disabled={busy}>
        <RefreshCw size={17} /> Check wallet
      </button>
    </div> : <>
      <div className="fin-chain-select">
        <label>Wallet address
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {wallets.map(wallet => <option key={wallet.id} value={wallet.id}>
              {wallet.managed ? 'Your wallet · ' : ''}{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
            </option>)}
          </select>
        </label>
      </div>
      {selected && <>
        {mode !== 'send' && <div className="fin-chain-balance">
          <span>Onchain balance</span>
          <strong>{balance ? previewAmount(balance.balance_wei) : '—'} <small>QIEV3</small></strong>
          <button className="fin-text" type="button" onClick={refreshBalance} disabled={busy}><RefreshCw size={14} /> Refresh</button>
        </div>}
        {mode === 'receive' && <div className="fin-chain-receive">
          {qr && <img src={qr} alt="QR code for the QIE wallet address shown below" width="240" height="240" />}
          <code>{selected.address}</code>
          <button className="fin-secondary" type="button" onClick={copyAddress}><Copy size={16} /> Copy address</button>
          <p>Send only native QIEV3 on QIE Mainnet to this address. Other assets and networks are not credited by Microsendr. Microsendr manages this wallet's signing key. Outbound transfers from this wallet are not enabled yet; do not deposit funds you need to withdraw.</p>
          <a href={`${explorer}address/${selected.address}`} target="_blank" rel="noreferrer">View on explorer <ArrowUpRight size={15} /></a>
        </div>}
        {mode === 'send' && selected.managed && <p className="fin-chain-empty">Sending from this account wallet is being prepared. Do not fund it until withdrawals are enabled.</p>}
        {mode === 'send' && !selected.managed && <form className="fin-chain-send" onSubmit={send}>
          <label>Recipient QIE address<input value={destination} onChange={e => setDestination(e.target.value.trim())}
            placeholder="0x…" autoComplete="off" required disabled={!!pending} /></label>
          <label>Amount in QIEV3<input value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0.00" inputMode="decimal" required disabled={!!pending} /></label>
          <p>Available onchain: {balance ? formatEther(BigInt(balance.balance_wei)) : 'checking…'} QIEV3. Your wallet shows the network fee before you confirm. Onchain sends cannot be reversed.</p>
          {!pending && <button className="fin-primary" disabled={busy || !balance}>
            {busy ? 'Opening wallet…' : 'Review in wallet'} <ArrowRight size={17} />
          </button>}
        </form>}
        {pending && <div className="fin-chain-pending">
          <ShieldCheck size={19} /><div><b>Transfer reference: {pending.id}</b>
            <p>{pending.hash ? 'Broadcast to QIE Mainnet. Awaiting confirmation.' : 'Check wallet history before starting another send.'}</p>
            {pending.hash && <a href={`${explorer}tx/${pending.hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a>}
          </div>
          {pending.hash && <button className="fin-text" type="button" onClick={retryTracking} disabled={busy}>Track</button>}
          <button className="fin-text" type="button" onClick={() => {
            setPending(undefined); setNotice('Check your wallet history before sending again.');
          }}>New send</button>
        </div>}
      </>}
    </>}
    {notice && <p className="fin-chain-notice" role="status">{notice}</p>}
    {error && <p className="fin-error" role="alert">{error}</p>}
    {mode === 'summary' && wallets.length > 0 && <div className="fin-chain-links">
      <button className="fin-text" onClick={() => go('/personal/deposit')}>Receive QIE <ArrowRight size={15} /></button>
      <button className="fin-text" onClick={() => go('/personal/send')}>Send QIE <ArrowRight size={15} /></button>
    </div>}
  </section>;
}
