import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Microsendr, MicrosendrError, type Model } from '@microsendr/sdk';
export function ControlsPage({ api, can }: { api: Microsendr; can: (scope: string) => boolean }) {
  const [status, setStatus] = useState<Model<'ControlStatus'>>(),
    [approvals, setApprovals] = useState<Model<'ControlApproval'>[]>([]),
    [reports, setReports] = useState<Model<'ControlReport'>[]>([]),
    [evidence, setEvidence] = useState<Model<'ControlEvidence'>[]>([]),
    [audit, setAudit] = useState<Model<'ControlAuditList'>['data']>([]);
  const [tab, setTab] = useState('approvals'),
    [reason, setReason] = useState(''),
    [kind, setKind] = useState('kyb'),
    [outcome, setOutcome] = useState('review'),
    [reference, setReference] = useState(''),
    [customer, setCustomer] = useState(''),
    [expiry, setExpiry] = useState(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [action, setAction] = useState('start_staging'),
    [asset, setAsset] = useState('NGN'),
    [transactionCap, setTransactionCap] = useState('200000'),
    [dayCap, setDayCap] = useState('1000000'),
    [day, setDay] = useState(new Date().toISOString().slice(0, 10)),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ key: string; run: (key: string) => Promise<unknown> } | undefined>(
    undefined,
  );
  async function load() {
    const [s, a, r, e, u] = await Promise.all([
      api.getControls(),
      api.listControlApprovals(),
      api.listDailyReports(),
      api.listControlEvidence(),
      api.listControlAudit(),
    ]);
    setStatus(s);
    setApprovals(a.data);
    setReports(r.data);
    setEvidence(e.data);
    setAudit(u.data);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [api]);
  async function mutate(run: (key: string) => Promise<unknown>) {
    if (busy) return;
    const mutation = pending.current ?? { key: crypto.randomUUID(), run };
    pending.current = mutation;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await mutation.run(mutation.key);
      pending.current = undefined;
      setUncertain(false);
      setNotice('Control action recorded.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      if (e instanceof MicrosendrError && e.status < 500) {
        pending.current = undefined;
        setUncertain(false);
      } else setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || uncertain,
    write = can('operations:write'),
    operator = write && !!status?.operator_id;
  return (
    <div className="controls-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">OPERATIONS & READINESS</p>
          <h1>Pilot controls</h1>
          <p>Review evidence, approve capped staging, and pause new payments.</p>
        </div>
        <span className="badge">
          <ShieldCheck size={14} />
          Staging only
        </span>
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {uncertain && (
        <div className="notice">
          The response is uncertain.{' '}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void mutate(pending.current!.run)}
          >
            Retry original action
          </button>
        </div>
      )}
      <section className="card controls-summary">
        <div>
          <h2>{status?.state.replaceAll('_', ' ') ?? 'Loading controls'}</h2>
          <p>Policy revision {status?.revision ?? 0} · Live activation unavailable</p>
          <p>
            Daily ledger controls: {status?.daily_controls_clean ? 'clean' : 'review required'} ·
            Provider cash reconciliation pending
          </p>
        </div>
        <div>
          <label>
            Incident reason
            <input
              aria-label="Incident reason"
              disabled={locked}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={240}
            />
          </label>
          <button
            className="button secondary"
            disabled={locked || !write || !reason.trim()}
            onClick={() => {
              const value = reason;
              void mutate((key) => api.pausePayments(value, key));
            }}
          >
            Pause new payments
          </button>
        </div>
      </section>
      <section className="card">
        <h2>Readiness evidence</h2>
        <div className="control-gates">
          {status?.gates.map((g) => (
            <div key={g.kind}>
              <b>{g.kind.toUpperCase()}</b>
              <span className="badge">{g.status.replaceAll('_', ' ')}</span>
            </div>
          ))}
        </div>
        <p>
          Staging reviews record operator evidence. Partner validation, production custody, and
          complete cash reconciliation remain external gates.
        </p>
        {!!status?.policy.caps.length && (
          <p>
            Approved gross source caps:{' '}
            {status.policy.caps
              .map(
                (c) =>
                  `${c.asset} ${c.per_transaction_minor} per transaction / ${c.per_day_minor} per UTC day (minor units)`,
              )
              .join('; ')}
          </p>
        )}
      </section>
      <div className="rail-tabs" role="tablist" aria-label="Control records">
        {['approvals', 'evidence', 'reports', 'audit'].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {(tab === 'approvals' || tab === 'evidence') && !operator && (
        <div className="notice">
          Evidence and policy approvals require an enrolled operator identity. Emergency pause and
          daily reports are available to operations writers.
        </div>
      )}
      {tab === 'approvals' && (
        <>
          <section className="card control-form">
            <h2>Request a policy change</h2>
            <fieldset disabled={locked || !operator}>
              <label>
                Action
                <select value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="start_staging">Start capped staging</option>
                  <option value="change_caps">Change caps</option>
                  <option value="resume">Resume staging</option>
                </select>
              </label>
              <label>
                Source asset
                <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                  {['NGN', 'KES', 'GHS', 'USDC', 'KUSD'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label>
                Transaction cap (minor units)
                <input
                  value={transactionCap}
                  onChange={(e) => setTransactionCap(e.target.value)}
                  inputMode="numeric"
                />
              </label>
              <label>
                UTC daily cap (minor units)
                <input
                  value={dayCap}
                  onChange={(e) => setDayCap(e.target.value)}
                  inputMode="numeric"
                />
              </label>
              <label>
                Review reason
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={240} />
              </label>
              <button
                className="button primary"
                disabled={!reason.trim()}
                onClick={() => {
                  const body = {
                    action: action as 'start_staging' | 'change_caps' | 'resume',
                    reason,
                    policy: {
                      caps: [
                        {
                          asset: asset as 'NGN',
                          per_transaction_minor: transactionCap,
                          per_day_minor: dayCap,
                        },
                      ],
                    },
                  };
                  void mutate((key) => api.createControlApproval(body, key));
                }}
              >
                Request approval
              </button>
            </fieldset>
            <p>
              A different enrolled operator must approve. Requests expire after 24 hours and apply
              only to their saved policy revision.
            </p>
          </section>
          <section className="card">
            <h2>Approval requests</h2>
            {approvals.length === 0 ? (
              <p>No requests yet.</p>
            ) : (
              approvals.map((a) => (
                <article className="control-record" key={a.id}>
                  <b>
                    {a.action.replaceAll('_', ' ')} · {a.state}
                  </b>
                  <p>{a.reason}</p>
                  <small>
                    Requested by {a.requested_by} · revision {a.base_revision}
                  </small>
                  <p>
                    {a.policy.caps
                      .map((c) => `${c.asset}: ${c.per_transaction_minor} / ${c.per_day_minor}`)
                      .join('; ')}
                  </p>
                  {a.state === 'pending' && (
                    <div className="control-actions">
                      {['approve', 'reject'].map((decision) => (
                        <button
                          key={decision}
                          className="button secondary"
                          disabled={
                            locked ||
                            !operator ||
                            a.requested_by === status?.operator_id ||
                            !reason.trim()
                          }
                          onClick={() => {
                            const body = { decision: decision as 'approve' | 'reject', reason };
                            void mutate((key) => api.reviewControlApproval(a.id, body, key));
                          }}
                        >
                          {decision === 'approve' ? 'Approve' : 'Reject'}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))
            )}
          </section>
        </>
      )}
      {tab === 'evidence' && (
        <>
          <section className="card control-form">
            <h2>Record a staging review</h2>
            <fieldset disabled={locked || !operator}>
              <label>
                Review kind
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {['kyb', 'kyc', 'screening', 'custody', 'security', 'legal', 'partner'].map(
                    (k) => (
                      <option key={k}>{k}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Outcome
                <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  {['review', 'checked', 'rejected'].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label>
                Evidence reference
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={240}
                />
              </label>
              <label>
                Customer ID (optional)
                <input value={customer} onChange={(e) => setCustomer(e.target.value)} />
              </label>
              <label>
                Expires on (UTC)
                <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </label>
              <label>
                Review reason
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={240} />
              </label>
              <button
                className="button primary"
                disabled={!reason.trim() || !reference.trim()}
                onClick={() => {
                  const body = {
                    kind: kind as 'kyb',
                    outcome: outcome as 'review',
                    reference,
                    reason,
                    expires_at: `${expiry}T23:59:59.000Z`,
                    ...(customer ? { customer_id: customer } : {}),
                  };
                  void mutate((key) => api.createControlEvidence(body, key));
                }}
              >
                Record evidence
              </button>
            </fieldset>
          </section>
          <section className="card">
            <h2>Review history</h2>
            {evidence.length === 0 ? (
              <p>No evidence recorded.</p>
            ) : (
              evidence.map((e) => (
                <article className="control-record" key={e.id}>
                  <b>
                    {e.kind.toUpperCase()} · {e.outcome}
                  </b>
                  <p>
                    {e.reference} · {e.reason}
                  </p>
                  <small>
                    {e.customer_id ?? 'Merchant review'} · expires {e.expires_at.slice(0, 10)}
                  </small>
                </article>
              ))
            )}
          </section>
        </>
      )}
      {tab === 'reports' && (
        <>
          <section className="card control-form">
            <h2>Daily ledger controls</h2>
            <p>
              Closing balances use the selected UTC date. Unresolved-work checks describe the
              current snapshot. Today's balances are provisional; these reports do not attest
              provider cash.
            </p>
            <label>
              UTC report date
              <input
                type="date"
                value={day}
                disabled={locked}
                onChange={(e) => setDay(e.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={locked || !write}
              onClick={() => {
                const value = day;
                void mutate((key) => api.createDailyReport(value, key));
              }}
            >
              Run daily controls
            </button>
          </section>
          <section className="card">
            <h2>Daily reports</h2>
            {reports.length === 0 ? (
              <p>No reports yet.</p>
            ) : (
              reports.map((r) => (
                <article className="control-record" key={r.id}>
                  <b>
                    {r.day.slice(0, 10)} · {r.control_clean ? 'Controls clean' : 'Review required'}
                  </b>
                  <p>Provider cash reconciliation pending</p>
                  <details>
                    <summary>View control snapshot</summary>
                    <pre>{JSON.stringify(r.data, null, 2)}</pre>
                  </details>
                </article>
              ))
            )}
          </section>
        </>
      )}
      {tab === 'audit' && (
        <section className="card">
          <h2>Operator audit</h2>
          {audit.length === 0 ? (
            <p>No control actions yet.</p>
          ) : (
            audit.map((a) => (
              <article className="control-record" key={a.id}>
                <b>{a.action.replaceAll('_', ' ')}</b>
                <p>{a.resource_id}</p>
                <small>
                  {a.operator_id ?? a.actor_key_id} · {a.created_at}
                </small>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
