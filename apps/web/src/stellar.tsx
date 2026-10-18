import { useEffect, useRef, useState } from 'react';
import { Microsendr, MicrosendrError, type Model } from '@microsendr/sdk';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
function amount(s: string, scale: number) {
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(s))
    throw new Error(`Use up to ${scale} decimal places`);
  const [a, b = ''] = s.split('.');
  const n = BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale, '0'));
  if (n <= 0n) throw new Error('Amount must be positive');
  return n.toString();
}
export function StellarPage({
  api,
  onSelect,
  can,
}: {
  api: Microsendr;
  onSelect: (i: Model<'Intent'>) => void;
  can: (s: string) => boolean;
}) {
  const [status, setStatus] = useState<Model<'StellarStatus'>>(),
    [customers, setCustomers] = useState<Model<'Customer'>[]>([]),
    [customer, setCustomer] = useState(''),
    [accounts, setAccounts] = useState<Model<'StellarAccount'>[]>([]),
    [wallet, setWallet] = useState('');
  const [address, setAddress] = useState(''),
    [signature, setSignature] = useState(''),
    [challenge, setChallenge] = useState(''),
    [value, setValue] = useState(''),
    [hash, setHash] = useState(''),
    [view, setView] = useState('purchase'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [deposits, setDeposits] = useState<Model<'StellarDeposit'>[]>([]),
    [redemptions, setRedemptions] = useState<Model<'StellarRedemption'>[]>([]);
  const pending = useRef<{ key: string; run: (key: string) => Promise<void> } | undefined>(
    undefined,
  );
  async function load() {
    const [s, c, d, r] = await Promise.all([
      api.getStellarStatus(),
      api.listCustomers({ limit: '100' }),
      api.listStellarDeposits(),
      api.listStellarRedemptions(),
    ]);
    setStatus(s);
    setCustomers(c.data);
    setCustomer((v) => v || c.data[0]?.id || '');
    setDeposits(d.data);
    setRedemptions(r.data);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [api]);
  useEffect(() => {
    let active = true;
    setWallet('');
    setAccounts([]);
    setChallenge('');
    setSignature('');
    if (customer)
      void api
        .listStellarAccounts(customer)
        .then((r) => {
          if (active) {
            setAccounts(r.data);
            setWallet(r.data[0]?.instrument_id || '');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [api, customer, notice]);
  async function mutate(run: (key: string) => Promise<void>) {
    if (busy) return;
    pending.current ??= { key: crypto.randomUUID(), run };
    setBusy(true);
    setError('');
    try {
      await pending.current.run(pending.current.key);
      pending.current = undefined;
      setUncertain(false);
      await load().catch((e) => setError(`Saved successfully; refresh failed: ${e.message}`));
    } catch (e) {
      if (e instanceof MicrosendrError && e.status < 500) {
        pending.current = undefined;
        setUncertain(false);
      } else setUncertain(true);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  async function fetchChallenge() {
    setBusy(true);
    setError('');
    try {
      const r = await api.getStellarChallenge(customer, address);
      setChallenge(r.challenge_hex);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || uncertain;
  return (
    <div className="stellar-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SETTLEMENT & ASSETS</p>
          <h1>Stellar Testnet</h1>
          <p>Move Microsendr Test USD through verified wallets and durable settlement receipts.</p>
        </div>
        <span className="badge">
          <ShieldCheck size={14} /> Test funds
        </span>
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      <section className="card stellar-config">
        <h2>KUSD · Microsendr Test USD</h2>
        <p>
          Fixture rate: 1 KUSD = ₦1,600. This staging asset has no cash redemption promise. Partner
          FX is pending.
        </p>
        {status?.configured ? (
          <>
            <p>
              Issuer <code style={{ overflowWrap: 'anywhere' }}>{status.issuer}</code>
            </p>
            <p>
              Treasury <code style={{ overflowWrap: 'anywhere' }}>{status.treasury}</code>
            </p>
          </>
        ) : (
          <p>
            Set up the isolated issuer and treasury with <code>pnpm stellar:init</code> on the
            server, then restart the API and worker.
          </p>
        )}
      </section>
      {status?.configured && (
        <>
          <div className="rail-tabs" role="tablist" aria-label="Stellar actions">
            {['purchase', 'wallet', 'deposit', 'redeem'].map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                disabled={locked}
                onClick={() => {
                  setView(v);
                  setValue('');
                  setError('');
                }}
                className={view === v ? 'active' : ''}
              >
                {
                  (
                    {
                      purchase: 'Buy KUSD',
                      wallet: 'Verify wallet',
                      deposit: 'Verify deposit',
                      redeem: 'Redeem to NGN',
                    } as Record<string, string>
                  )[v]
                }
              </button>
            ))}
          </div>
          <section className="card rail-form">
            <fieldset disabled={locked} style={{ border: 0, padding: 0 }}>
              <label>
                Customer
                <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {view === 'wallet' ? (
                <>
                  <h2>Verify wallet ownership</h2>
                  <p>
                    The wallet needs an authorized trustline to the issuer above. Sign the challenge
                    bytes with that wallet; keep its secret key in your wallet.
                  </p>
                  <label>
                    Stellar G address
                    <input
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        setChallenge('');
                        setSignature('');
                      }}
                    />
                  </label>
                  <button
                    className="button secondary"
                    disabled={!can('customers:read')}
                    onClick={() => void fetchChallenge()}
                  >
                    Get ownership challenge
                  </button>
                  {challenge && (
                    <>
                      <p style={{ overflowWrap: 'anywhere' }}>
                        <code>{challenge}</code>
                      </p>
                      <label>
                        Signature (hex)
                        <input value={signature} onChange={(e) => setSignature(e.target.value)} />
                      </label>
                      <button
                        className="button primary"
                        disabled={!can('customers:write')}
                        onClick={() =>
                          void mutate(async (key) => {
                            await api.createStellarAccount(
                              customer,
                              { address, signature, label: 'Testnet wallet' },
                              key,
                            );
                            setNotice(`Wallet verified · ${new Date().toLocaleTimeString()}`);
                          })
                        }
                      >
                        Verify wallet
                      </button>
                    </>
                  )}
                </>
              ) : view === 'purchase' ? (
                <>
                  <h2>Buy and deliver KUSD</h2>
                  <label>
                    Verified wallet
                    <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
                      {accounts.map((a) => (
                        <option key={a.instrument_id} value={a.instrument_id}>
                          {a.address.slice(0, 8)}…{a.address.slice(-6)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Total NGN amount
                    <input
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  <p>
                    Total includes a 0.5% Microsendr fee, rounded up to the nearest kobo. Delivery rounds
                    down to 7 decimals.
                  </p>
                  <button
                    className="button primary"
                    disabled={!wallet || !can('payments:write')}
                    onClick={() => {
                      try {
                        const body = {
                          customer_id: customer,
                          destination_instrument_id: wallet,
                          amount_minor: amount(value, 2),
                          reference: `Testnet purchase ${crypto.randomUUID().slice(0, 8)}`,
                        };
                        void mutate(async (key) => {
                          const i = await api.createStellarPurchase(body, key);
                          onSelect(i);
                          setNotice('Purchase queued. Follow the transaction in Operations.');
                        });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Buy KUSD <ArrowUpRight size={16} />
                  </button>
                </>
              ) : view === 'deposit' ? (
                <>
                  <h2>Verify an incoming deposit</h2>
                  <p>
                    Send one KUSD payment from your verified wallet to treasury, then verify its
                    transaction hash. A confirmed deposit is credited once.
                  </p>
                  <label>
                    Sending wallet
                    <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
                      {accounts.map((a) => (
                        <option key={a.instrument_id} value={a.instrument_id}>
                          {a.address.slice(0, 8)}…{a.address.slice(-6)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Transaction hash
                    <input value={hash} onChange={(e) => setHash(e.target.value)} />
                  </label>
                  <button
                    className="button primary"
                    disabled={!wallet || !can('payments:write')}
                    onClick={() =>
                      void mutate(async (key) => {
                        await api.verifyStellarDeposit(
                          { customer_id: customer, instrument_id: wallet, transaction_hash: hash },
                          key,
                        );
                        setNotice(`Deposit verified · ${new Date().toLocaleTimeString()}`);
                      })
                    }
                  >
                    Verify and credit
                  </button>
                </>
              ) : (
                <>
                  <h2>Convert credited KUSD to NGN</h2>
                  <p>
                    Only credited KUSD can be redeemed. Fixture liquidity credits your NGN balance;
                    use Local rail for a separate Paystack test payout.
                  </p>
                  <label>
                    KUSD amount
                    <input
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={!can('payments:write')}
                    onClick={() => {
                      try {
                        const body = { amount_minor: amount(value, 7) };
                        void mutate(async (key) => {
                          await api.redeemStellarBalance(body, key);
                          setNotice(
                            `NGN fixture balance credited · ${new Date().toLocaleTimeString()}`,
                          );
                        });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Redeem at fixture rate
                  </button>
                </>
              )}
            </fieldset>
            {uncertain && (
              <div className="notice">
                <p>The response is uncertain. Retry the same saved request.</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void mutate(pending.current!.run)}
                >
                  Retry saved request
                </button>
              </div>
            )}
          </section>
        </>
      )}
      <section className="card">
        <h2>Verified deposits</h2>
        {deposits.length ? (
          deposits.map((d) => (
            <p key={d.id}>
              <code>{d.transaction_hash.slice(0, 12)}…</code> · {BigInt(d.amount_minor) / 10000000n}
              .{(BigInt(d.amount_minor) % 10000000n).toString().padStart(7, '0')} KUSD · ledger{' '}
              {String(d.evidence.ledger)}
            </p>
          ))
        ) : (
          <p>No confirmed deposits yet.</p>
        )}
        <h2>Fixture redemptions</h2>
        {redemptions.length ? (
          redemptions.map((r) => (
            <p key={r.id}>
              ₦{(BigInt(r.destination_minor) / 100n).toLocaleString()} credited ·{' '}
              <code>{r.journal_id.slice(0, 12)}…</code>
            </p>
          ))
        ) : (
          <p>No redemptions yet.</p>
        )}
      </section>
    </div>
  );
}
