import { useEffect, useRef, useState } from 'react';
import { Microsendr, MicrosendrError, type Model } from '@microsendr/sdk';
import { ArrowUpRight, RefreshCw, ShieldCheck, Landmark } from 'lucide-react';

const money = (minor: string) => {
  const n = BigInt(minor),
    s = n < 0n ? '-' : '',
    v = n < 0n ? -n : n;
  return `${s}₦${(v / 100n).toLocaleString()}.${(v % 100n).toString().padStart(2, '0')}`;
};
const amount = (s: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(s))
    throw new Error('Enter an NGN amount with at most two decimals');
  const [a, b = ''] = s.split('.');
  const n = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
  if (n <= 0n) throw new Error('Amount must be positive');
  return n.toString();
};
export function LocalRailPage({
  api,
  onSelect,
  can,
}: {
  api: Microsendr;
  onSelect: (intent: Model<'Intent'>) => void;
  can: (scope: string) => boolean;
}) {
  const [rail, setRail] = useState<Model<'RailStatus'>>(),
    [customers, setCustomers] = useState<Model<'Customer'>[]>([]),
    [customer, setCustomer] = useState('');
  const [banks, setBanks] = useState<Model<'BankList'>['data']>([]),
    [accounts, setAccounts] = useState<Model<'BankAccount'>[]>([]),
    [collections, setCollections] = useState<Model<'Collection'>[]>([]),
    [statements, setStatements] = useState<Model<'Statement'>[]>([]),
    [detail, setDetail] = useState<Model<'StatementDetail'>>();
  const [view, setView] = useState('payout'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [bank, setBank] = useState(''),
    [number, setNumber] = useState(''),
    [resolution, setResolution] = useState<Model<'BankResolution'>>(),
    [instrument, setInstrument] = useState(''),
    [value, setValue] = useState(''),
    [email, setEmail] = useState(''),
    [reason, setReason] = useState(''),
    [reference, setReference] = useState(`Bank payout ${crypto.randomUUID().slice(0, 8)}`);
  const pending = useRef<{ payload: string; key: string } | undefined>(undefined);
  async function reload() {
    try {
      const r = await api.getRailStatus();
      setRail(r);
      const cc: Model<'Customer'>[] = [];
      for await (const c of api.paginate(api.listCustomers, { limit: '100' })) cc.push(c);
      setCustomers(cc);
      setCustomer((v) => v || cc[0]?.id || '');
      setCollections((await api.listCollections({ limit: '25' })).data);
      if (can('operations:read')) setStatements((await api.listStatements({ limit: '25' })).data);
      if (r.configured && can('customers:read')) {
        const b = (await api.listBanks()).data.filter((b) => b.active && b.currency === 'NGN');
        setBanks(b);
        setBank((v) => v || b[0]?.code || '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the local rail');
    }
  }
  useEffect(() => {
    void reload();
  }, [api]);
  useEffect(() => {
    let active = true;
    setAccounts([]);
    setInstrument('');
    setResolution(undefined);
    if (customer && can('customers:read'))
      api
        .listBankAccounts(customer)
        .then((r) => {
          if (active) {
            setAccounts(r.data);
            setInstrument(r.data[0]?.instrument_id || '');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [customer, api]);
  useEffect(() => {
    if (
      !collections.some((c) => ['processing', 'pending', 'unknown'].includes(c.state)) &&
      !statements.some((s) => s.state === 'running')
    )
      return;
    const timer = setInterval(() => {
      void api
        .listCollections({ limit: '25' })
        .then((r) => setCollections(r.data))
        .catch(() => {});
      if (can('operations:read'))
        void api
          .listStatements({ limit: '25' })
          .then((r) => setStatements(r.data))
          .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [collections, statements, api]);
  async function act(payload: unknown, run: (key: string) => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    const encoded = JSON.stringify(payload);
    if (pending.current && pending.current.payload !== encoded) {
      setError('Retry the pending action with the same details first');
      setBusy(false);
      return;
    }
    pending.current ??= { payload: encoded, key: crypto.randomUUID() };
    try {
      await run(pending.current.key);
      pending.current = undefined;
      setUncertain(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      const ambiguous = !(e instanceof MicrosendrError) || e.status >= 500;
      setUncertain(ambiguous);
      if (!ambiguous) pending.current = undefined;
    } finally {
      setBusy(false);
    }
  }
  const configured = !!rail?.configured,
    selected = customers.find((c) => c.id === customer),
    held = selected?.verification_state === 'held';
  const customerSelect = (
    <label>
      Customer
      <select
        value={customer}
        disabled={busy || uncertain}
        onChange={(e) => setCustomer(e.target.value)}
      >
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.verification_state === 'held' ? ' · Held' : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Local rail</h1>
          <p>Collect and pay out NGN through Paystack test mode.</p>
        </div>
        <button className="button subtle" onClick={() => void reload()} disabled={busy}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      <section className="card rail-status">
        <div className="rail-provider">
          <span className="rail-provider-icon">
            <Landmark size={25} />
          </span>
          <div>
            <h3>Paystack · Nigeria</h3>
            <p>
              {rail
                ? configured
                  ? 'Test key configured'
                  : 'Awaiting a Paystack test key'
                : 'Checking provider configuration…'}
            </p>
          </div>
        </div>
        <span className={`badge ${configured ? 'succeeded' : 'unknown'}`}>
          <i />
          {configured ? 'Test mode ready' : 'Setup required'}
        </span>
      </section>
      {!configured && rail && (
        <div className="rail-info" role="status">
          Add your Paystack test key to local configuration to enable name enquiry, collections, and
          payouts. Your sandbox workspace remains available.
        </div>
      )}
      <div className="rail-tabs" role="tablist" aria-label="Local rail actions">
        {[
          ['payout', 'Bank payout'],
          ['collect', 'Collections'],
          ['recipient', 'Bank accounts'],
          ...(can('operations:read') ? [['controls', 'Controls & statements']] : []),
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            disabled={busy || uncertain}
            className={view === id ? 'active' : ''}
            onClick={() => {
              setView(id);
              setError('');
              setNotice('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
          {uncertain &&
            ' · The response is uncertain. Retry with the same details; the original idempotency key will be reused.'}
        </div>
      )}
      {notice && (
        <div className="rail-info" role="status">
          {notice}
        </div>
      )}
      {view === 'payout' && (
        <section className="card rail-form">
          <h3>Send to a verified bank account</h3>
          <p>
            Your source amount includes the 0.5% Microsendr fee. Funds stay reserved until the provider
            outcome is verified.
          </p>
          <fieldset disabled={busy || uncertain}>
            {customerSelect}
            <label>
              Bank account
              <select value={instrument} onChange={(e) => setInstrument(e.target.value)}>
                <option value="">Select a verified account</option>
                {accounts.map((a) => (
                  <option key={a.instrument_id} value={a.instrument_id}>
                    {a.account_name} · •••• {a.account_last4}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Source amount (NGN)
              <input
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="5,000.00"
              />
            </label>
            <label>
              Payment reference
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={128}
              />
            </label>
          </fieldset>
          {value &&
            (() => {
              try {
                const gross = BigInt(amount(value)),
                  fee = (gross * 50n + 9999n) / 10000n;
                return (
                  <div className="rail-summary">
                    <span>
                      Microsendr fee <b>{money(fee.toString())}</b>
                    </span>
                    <span>
                      Recipient receives <b>{money((gross - fee).toString())}</b>
                    </span>
                  </div>
                );
              } catch {
                return null;
              }
            })()}
          <button
            className="button primary"
            disabled={
              busy ||
              !configured ||
              !instrument ||
              !value ||
              !reference ||
              held ||
              !can('payments:write')
            }
            onClick={() => {
              try {
                const input = {
                  customer_id: customer,
                  destination_instrument_id: instrument,
                  amount_minor: amount(value),
                  reference,
                };
                void act(['payout', input], async (key) => {
                  const result = await api.createLocalPayout(input, key);
                  onSelect(result);
                  setValue('');
                  setReference(`Bank payout ${crypto.randomUUID().slice(0, 8)}`);
                  setNotice('Payout queued. Follow its verified outcome in Transactions.');
                });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {busy ? 'Queuing…' : uncertain ? 'Retry bank payout' : 'Queue bank payout'}
            <ArrowUpRight size={16} />
          </button>
          {!accounts.length && (
            <p>Add an account in Bank accounts after completing name enquiry.</p>
          )}
          {held && <p>This customer is held. An operator must record approval before a payout.</p>}
        </section>
      )}
      {view === 'recipient' && (
        <section className="card rail-form">
          <h3>Name enquiry</h3>
          <p>
            Resolve the account name before registering a recipient. Microsendr displays only the last
            four account digits after registration.
          </p>
          <fieldset disabled={busy || uncertain}>
            {customerSelect}
            <label>
              Bank
              <select
                value={bank}
                onChange={(e) => {
                  setBank(e.target.value);
                  setResolution(undefined);
                }}
              >
                <option value="">Select a bank</option>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Account number
              <input
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                value={number}
                onChange={(e) => {
                  setNumber(e.target.value.replace(/\D/g, ''));
                  setResolution(undefined);
                }}
              />
            </label>
          </fieldset>
          <button
            className="button primary"
            disabled={
              busy ||
              !configured ||
              number.length !== 10 ||
              !bank ||
              held ||
              !can('customers:write')
            }
            onClick={() =>
              void act(['resolve', bank, number], async (key) => {
                setResolution(
                  await api.resolveBank({ bank_code: bank, account_number: number }, key),
                );
              })
            }
          >
            Resolve account name
          </button>
          {resolution && (
            <div className="rail-info">
              <b>{resolution.account_name}</b> · •••• {resolution.account_last4}
              <button
                className="button subtle"
                disabled={busy || held || !can('customers:write')}
                onClick={() =>
                  void act(['register', customer, resolution.id], async (key) => {
                    const result = await api.createBankAccount(
                      customer,
                      { resolution_id: resolution.id, label: resolution.account_name },
                      key,
                    );
                    setAccounts((v) => [
                      result,
                      ...v.filter((a) => a.instrument_id !== result.instrument_id),
                    ]);
                    setInstrument(result.instrument_id);
                    setNumber('');
                    setResolution(undefined);
                    setNotice('Verified bank account added.');
                  })
                }
              >
                Add verified account
              </button>
            </div>
          )}
          <div className="rail-account-list">
            {accounts.map((a) => (
              <div key={a.instrument_id}>
                <ShieldCheck size={18} />
                <span>
                  <b>{a.account_name}</b>
                  <small>
                    {a.bank_code} · •••• {a.account_last4}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {view === 'collect' && (
        <>
          <section className="card rail-form">
            <h3>Create a collection checkout</h3>
            <p>
              A callback starts verification. Your balance is credited only after Paystack confirms
              the charge and its fee.
            </p>
            <fieldset disabled={busy || uncertain}>
              {customerSelect}
              <label>
                Amount (NGN)
                <input
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
              <label>
                Payer email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
            </fieldset>
            <button
              className="button primary"
              disabled={
                busy ||
                !configured ||
                !customer ||
                !value ||
                !email ||
                held ||
                !can('payments:write')
              }
              onClick={() => {
                try {
                  const input = { customer_id: customer, amount_minor: amount(value), email };
                  void act(['collect', input], async (key) => {
                    await api.createCollection(input, key);
                    setValue('');
                    setNotice('Collection queued. Its checkout will appear after initialization.');
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {uncertain ? 'Retry collection' : 'Create checkout'}
            </button>
          </section>
          <section className="card">
            <div className="card-heading">
              <h3>Recent collections</h3>
              <span>NGN</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Collection</th>
                    <th>Gross</th>
                    <th>Credited</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <b>{c.id.slice(0, 12)}…</b>
                        {c.last_error && <small>{c.last_error.replaceAll('_', ' ')}</small>}
                      </td>
                      <td>{money(c.amount_minor)}</td>
                      <td>{c.credited_minor ? money(c.credited_minor) : '—'}</td>
                      <td>
                        <span className={`badge ${c.state}`}>
                          <i />
                          {c.state}
                        </span>
                      </td>
                      <td>
                        {c.checkout_url && c.state === 'pending' && (
                          <a
                            className="button subtle"
                            href={c.checkout_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open checkout
                            <ArrowUpRight size={14} />
                          </a>
                        )}
                        {['pending', 'unknown', 'processing'].includes(c.state) && (
                          <button
                            className="button subtle"
                            disabled={busy || !configured || !can('payments:write')}
                            onClick={() =>
                              void act(['verify', c.id], async (key) => {
                                await api.verifyCollection(c.id, key);
                                setNotice('Verification queued.');
                              })
                            }
                          >
                            Verify
                          </button>
                        )}
                        {c.state === 'held' && can('operations:write') && (
                          <button
                            className="button subtle"
                            disabled={busy}
                            onClick={() =>
                              void act(['release', c.id], (key) => api.releaseCollection(c.id, key))
                            }
                          >
                            Release after approval
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!collections.length && <div className="empty-state">No collections yet.</div>}
          </section>
        </>
      )}
      {view === 'controls' && (
        <>
          <section className="card rail-form">
            <h3>Customer controls</h3>
            <p>
              These decisions govern test payments. Identity verification remains a sandbox check.
            </p>
            {customerSelect}
            <label>
              Decision reason
              <input
                value={reason}
                disabled={busy || uncertain}
                onChange={(e) => setReason(e.target.value)}
                maxLength={240}
              />
            </label>
            <div className="rail-actions">
              <button
                className="button subtle"
                disabled={busy || !reason || !customer || !can('operations:write')}
                onClick={() =>
                  void act(['hold', customer, reason], async (key) => {
                    await api.setComplianceDecision(customer, { decision: 'hold', reason }, key);
                    setNotice('Customer held. Unsent payouts are blocked.');
                  })
                }
              >
                Place hold
              </button>
              <button
                className="button primary"
                disabled={busy || !reason || !customer || !can('operations:write')}
                onClick={() =>
                  void act(['allow', customer, reason], async (key) => {
                    await api.setComplianceDecision(customer, { decision: 'allow', reason }, key);
                    setNotice('Sandbox approval recorded.');
                  })
                }
              >
                Record approval
              </button>
            </div>
          </section>
          <section className="card rail-form">
            <div className="card-heading">
              <h3>Statement reconciliation</h3>
              <button
                className="button subtle"
                disabled={busy || !configured || !can('operations:write')}
                onClick={() =>
                  void act(['statement'], async (key) => {
                    await api.createStatement(key);
                    setNotice('Provider ledger snapshot reconciliation queued.');
                  })
                }
              >
                Reconcile snapshot
              </button>
            </div>
            <p>
              Checks the provider’s current balance-ledger snapshot. Rows outside this workspace are
              redacted; this does not certify the complete account history.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Matched</th>
                    <th>Needs review</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {statements.map((s) => (
                    <tr key={s.id}>
                      <td>{s.id.slice(0, 13)}…</td>
                      <td>{s.state}</td>
                      <td>{s.matched}</td>
                      <td>{s.unmatched}</td>
                      <td>
                        <button
                          className="button subtle"
                          onClick={() =>
                            void api
                              .getStatement(s.id)
                              .then(setDetail)
                              .catch((e) => setError(e.message))
                          }
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail && (
              <div className="rail-info">
                <b>
                  {detail.state} · {detail.redacted_unmapped} unmapped rows redacted
                </b>
                {detail.items.map((i) => (
                  <p key={i.id}>
                    {i.resource_id.slice(0, 12)}… · {i.state} · actual {money(i.difference_minor)} ·
                    expected {i.expected_minor ? money(i.expected_minor) : 'Requires review'}
                  </p>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
