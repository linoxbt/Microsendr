import React, { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, RefreshCw, ShieldCheck } from 'lucide-react';

type Bank = { name: string; code: string };
type Operation = {
  id: string; kind: 'collection' | 'withdrawal'; amount_minor: string; status: string;
  checkout_url: string | null; bank_name: string | null; bank_last4: string | null;
  provider_fee_minor: string | null; created_at: string;
};
const money = (minor: string) => {
  const amount = BigInt(minor);
  return `₦${new Intl.NumberFormat('en-NG').format(amount / 100n)}.${(amount % 100n).toString().padStart(2,'0')}`;
};
const minor = (amount: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter a valid NGN amount');
  const [whole,fraction=''] = amount.split('.');
  const value = BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if (value < 1n || value > 100000000000n) throw new Error('Amount is outside the test limit');
  return value.toString();
};
async function api<T>(path: string, method = 'GET', body?: object, csrf?: string, key?: string): Promise<T> {
  const response = await fetch(path, { method, credentials: 'include', headers: {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(csrf ? { 'x-kora-csrf': csrf } : {}),
    ...(key ? { 'idempotency-key': key } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Request failed');
  return result as T;
}

export function PersonalMoney({ csrf, kycState, onBalanceChanged }: { csrf?: string; kycState?: string; onBalanceChanged: () => Promise<void> }) {
  const [configured,setConfigured] = useState<boolean>();
  const [banks,setBanks] = useState<Bank[]>([]);
  const [operations,setOperations] = useState<Operation[]>([]);
  const [depositAmount,setDepositAmount] = useState('');
  const [withdrawAmount,setWithdrawAmount] = useState('');
  const [bankCode,setBankCode] = useState('');
  const [accountNumber,setAccountNumber] = useState('');
  const [accountName,setAccountName] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const refresh = async () => {
    const [config,history] = await Promise.all([
      api<{configured:boolean}>('/personal/api/paystack/config'),
      api<{data:Operation[]}>('/personal/api/paystack/operations'),
    ]);
    setConfigured(config.configured); setOperations(history.data);
    if (config.configured && kycState === 'sandbox_approved') {
      const listed = await api<{data:Bank[]}>('/personal/api/paystack/banks');
      setBanks(listed.data);
    }
  };
  useEffect(() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load payment methods')); }, [kycState]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Try again'); }
    finally { setBusy(false); }
  };
  const add = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    const result = await api<Operation>('/personal/api/paystack/collections','POST',{ amount_minor: minor(depositAmount) },csrf,crypto.randomUUID());
    await refresh();
    setNotice(result.checkout_url ? 'Your Paystack test checkout is ready.' : 'Payment initialization needs review. Check its status below.');
  }); };
  const resolve = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    const result = await api<{account_name:string}>('/personal/api/paystack/resolve','POST',{ bank_code: bankCode, account_number: accountNumber },csrf);
    setAccountName(result.account_name);
  }); };
  const withdraw = () => void run(async () => {
    if (!accountName) throw new Error('Verify the bank account first');
    const result = await api<Operation>('/personal/api/paystack/withdrawals','POST',{
      amount_minor: minor(withdrawAmount), bank_code: bankCode, account_number: accountNumber,
    },csrf,crypto.randomUUID());
    setWithdrawAmount(''); setAccountName('');
    await refresh(); await onBalanceChanged();
    setNotice(result.status === 'unknown' ? 'The payout outcome is unknown. Keep the reservation and check its status below.' : 'Test withdrawal submitted. Check its status below.');
  });
  const verify = (operation: Operation) => void run(async () => {
    const route = operation.kind === 'collection' ? 'collections' : 'withdrawals';
    const result = await api<Operation>(`/personal/api/paystack/${route}/${operation.id}/verify`,'POST',{},csrf);
    await refresh(); await onBalanceChanged();
    setNotice(result.status === 'completed' ? 'Verified in Paystack test mode.' : `Current test status: ${result.status}.`);
  });
  const eligible = configured && kycState === 'sandbox_approved';
  return <>
    <div className="personal-heading"><span className="personal-eyebrow">MOVE MONEY · TEST MODE</span><h1>Add or withdraw.</h1><p>Try Paystack test payments with simulated NGN. No real money moves.</p></div>
    {error && <p className="personal-error" role="alert">{error}</p>}{notice && <p className="personal-success" role="status">{notice}</p>}
    {!configured && <section className="personal-card"><h2>Paystack test mode is being set up</h2><p>Funding and bank withdrawal tests will appear when test credentials are configured.</p></section>}
    {configured && kycState !== 'sandbox_approved' && <section className="personal-card"><h2>Enable sandbox access first</h2><p>Return to Home and enable the sandbox verification fixture before trying test payments.</p></section>}
    {eligible && <div className="personal-money-grid">
      <section className="personal-card personal-form-card"><h2>Add money</h2><p>Pay on Paystack’s test checkout. Your simulated balance is credited only after Microsendr verifies the test transaction.</p><form onSubmit={add}><label>Amount in NGN<input inputMode="decimal" value={depositAmount} onChange={event=>setDepositAmount(event.target.value)} placeholder="1,000.00" required/></label><button className="personal-primary" disabled={busy}>Create test checkout <ArrowRight size={17}/></button></form></section>
      <section className="personal-card personal-form-card"><h2>Withdraw to bank</h2><p>Test a Nigerian bank payout from your simulated balance. The provider result is verified before it appears complete.</p><form onSubmit={resolve}><label>Bank<select value={bankCode} onChange={event=>{setBankCode(event.target.value);setAccountName('');}} required><option value="">Choose a bank</option>{banks.map(bank=><option value={bank.code} key={bank.code}>{bank.name}</option>)}</select></label><label>Account number<input inputMode="numeric" pattern="[0-9]{10}" maxLength={10} value={accountNumber} onChange={event=>{setAccountNumber(event.target.value.replace(/\D/g,'').slice(0,10));setAccountName('');}} required/></label><button className="personal-secondary" disabled={busy || !bankCode || accountNumber.length!==10}>Verify account</button></form>{accountName && <div className="personal-bank-review"><strong>{accountName}</strong><span>{banks.find(bank=>bank.code===bankCode)?.name} ···· {accountNumber.slice(-4)}</span><label>Amount in NGN<input inputMode="decimal" value={withdrawAmount} onChange={event=>setWithdrawAmount(event.target.value)} placeholder="500.00" required/></label><p>Recipient receives the amount shown. Microsendr fee: ₦0.00 in test mode. Provider test fees are covered by the sandbox.</p><button className="personal-primary" disabled={busy || !withdrawAmount} onClick={withdraw}>Confirm test withdrawal <ArrowRight size={17}/></button></div>}</section>
    </div>}
    <section className="personal-card personal-activity"><h2>Payment tests</h2>{operations.length ? operations.map(operation=><div className="personal-activity-row" key={operation.id}><span className="personal-activity-icon"><ShieldCheck size={19}/></span><span><b>{operation.kind==='collection'?'Add money':'Bank withdrawal'} · {money(operation.amount_minor)}</b><small>{operation.bank_name ? `${operation.bank_name} ···· ${operation.bank_last4} · ` : ''}{operation.status.replaceAll('_',' ')} · Paystack test mode</small></span><div className="personal-money-row-actions">{operation.checkout_url && operation.status==='checkout_ready' && <a href={operation.checkout_url}>Open checkout <ArrowRight size={15}/></a>}{!['failed','returned'].includes(operation.status) && <button disabled={busy} onClick={()=>verify(operation)}><RefreshCw size={15}/> Check status</button>}</div></div>) : <p className="personal-muted">No Paystack test payments yet.</p>}</section>
    <p className="personal-money-disclosure"><ShieldCheck size={17}/> Test-mode transactions and simulated NGN only. There is no QIE-to-NGN conversion or live bank payout.</p>
  </>;
}
