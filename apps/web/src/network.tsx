import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Microsendr, MicrosendrError, type Model } from '@microsendr/sdk';
function money(minor: string, asset: string) {
  const scale = asset === 'KUSD' ? 7 : 2,
    value = BigInt(minor),
    factor = 10n ** BigInt(scale);
  return `${asset} ${value / factor}.${(value % factor).toString().padStart(scale, '0')}`;
}
export function NetworkPage({
  api,
  can,
  onSelect,
}: {
  api: Microsendr;
  can: (scope: string) => boolean;
  onSelect: (intent: Model<'Intent'>) => void;
}) {
  const [registry, setRegistry] = useState<Model<'NetworkRegistry'>>();
  const [routing, setRouting] = useState<Model<'NetworkRouting'>>();
  const [routeMode, setRouteMode] = useState('auto');
  const [healthParticipant, setHealthParticipant] = useState('nigeria-payout-sandbox');
  const [healthStatus, setHealthStatus] = useState<'healthy' | 'degraded' | 'unavailable'>(
    'unavailable',
  );
  const [healthReason, setHealthReason] = useState('');
  const [customers, setCustomers] = useState<Model<'Customer'>[]>([]);
  const [instruments, setInstruments] = useState<Model<'Instrument'>[]>([]);
  const [plans, setPlans] = useState<Model<'NetworkPlanList'>['data']>([]);
  const [plan, setPlan] = useState<Model<'NetworkPlan'>>();
  const [quote, setQuote] = useState<Model<'NetworkQuote'>>();
  const [customer, setCustomer] = useState(''),
    [instrument, setInstrument] = useState('');
  const [name, setName] = useState(''),
    [amount, setAmount] = useState('160000');
  const [scenario, setScenario] = useState<'success' | 'timeout' | 'insufficient_float'>('success');
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ key: string; run: (key: string) => Promise<void> } | undefined>(
    undefined,
  );
  const writable = can('payments:write'),
    locked = busy || uncertain;
  async function load() {
    const [r, p] = await Promise.all([api.getNetwork(), api.listNetworkPlans()]);
    setRegistry(r);
    setPlans(p.data);
    if (/^[1-9][0-9]{0,23}$/.test(amount)) setRouting(await api.getNetworkRouting(amount));
    if (can('customers:read')) setCustomers((await api.listCustomers({ limit: '100' })).data);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [api]);
  useEffect(() => {
    let canceled = false;
    const timer = setTimeout(() => {
      if (!/^[1-9][0-9]{0,23}$/.test(amount)) {
        setRouting(undefined);
        return;
      }
      void api
        .getNetworkRouting(amount)
        .then((r) => {
          if (!canceled) setRouting(r);
        })
        .catch((e) => {
          if (!canceled) setError(e.message);
        });
    }, 300);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [api, amount]);
  useEffect(() => {
    let canceled = false;
    setInstruments([]);
    setInstrument('');
    if (customer)
      void api
        .listInstruments(customer, { limit: '100' })
        .then((result) => {
          if (canceled) return;
          const eligible = result.data.filter(
            (i) => i.asset === 'NGN' && i.verified && i.type === 'bank_account',
          );
          setInstruments(eligible);
          setInstrument(eligible[0]?.id ?? '');
        })
        .catch((e) => {
          if (!canceled) setError(e.message);
        });
    return () => {
      canceled = true;
    };
  }, [api, customer]);
  useEffect(() => {
    if (!plan?.intent_id || plan.capacity_state !== 'held') return;
    let canceled = false;
    const timer = setInterval(() => {
      void api
        .getNetworkPlan(plan.id)
        .then((p) => {
          if (!canceled) setPlan(p);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [api, plan?.id, plan?.intent_id, plan?.capacity_state]);
  async function mutate(run: (key: string) => Promise<void>) {
    if (busy) return;
    const operation = pending.current ?? { key: crypto.randomUUID(), run };
    pending.current = operation;
    setBusy(true);
    setError('');
    try {
      await operation.run(operation.key);
      pending.current = undefined;
      setUncertain(false);
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
  async function selectPlan(id: string) {
    try {
      setPlan(await api.getNetworkPlan(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="network-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NIGERIA FIRST</p>
          <h1>The Microsendr network</h1>
          <p>NGN source → simulated KUSD settlement → NGN payout.</p>
        </div>
        <span className="badge sandbox">Sandbox</span>
      </div>
      <div className="inline-note">
        All three participants are simulators. This route moves sandbox balances; external
        settlement and provider cash are unverified.
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {uncertain && (
        <div className="notice">
          The response is uncertain. Your original request is saved.{' '}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void mutate(pending.current!.run)}
          >
            Retry original request
          </button>
        </div>
      )}
      <div className="network-workspace">
        <section className="card">
          <h2>Plan a Nigeria transfer</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const body = { corridor_id: routeMode, amount_minor: amount, scenario };
              void mutate(async (key) => {
                const q = await api.createNetworkQuote(body, key);
                setQuote(q);
                setPlan(await api.getNetworkPlan(q.plan_id));
              });
            }}
          >
            <label>
              Amount in kobo
              <input
                aria-label="Amount in kobo"
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                required
                value={amount}
                disabled={locked}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setQuote(undefined);
                }}
              />
            </label>
            <label>
              Route preference
              <select
                aria-label="Route preference"
                value={routeMode}
                disabled={locked}
                onChange={(e) => {
                  setRouteMode(e.target.value);
                  setQuote(undefined);
                }}
              >
                <option value="auto">Automatic · health and capacity</option>
                <option value="ng-ng-sandbox">Nigeria primary payout</option>
                <option value="ng-ng-alternate">Nigeria alternate payout</option>
              </select>
            </label>
            <label>
              Sandbox scenario
              <select
                aria-label="Sandbox scenario"
                value={scenario}
                disabled={locked}
                onChange={(e) => {
                  setScenario(e.target.value as typeof scenario);
                  setQuote(undefined);
                }}
              >
                <option value="success">All steps succeed</option>
                <option value="timeout">Settlement acknowledgement lost</option>
                <option value="insufficient_float">Destination payout rejected</option>
              </select>
            </label>
            <button className="button primary" disabled={locked || !writable}>
              Get route quote <ArrowRight size={16} />
            </button>
          </form>
          {quote && (
            <div className="network-quote">
              <h3>Frozen quote</h3>
              {quote.routing && (
                <p>
                  Selected route: <b>{quote.routing.selected_corridor_id}</b>. Provider choice stays
                  fixed for this quote.
                </p>
              )}
              <p>
                Source: <b>{money(quote.source.amount_minor, 'NGN')}</b>
              </p>
              <p>Included fee: {money(quote.fee.amount_minor, 'NGN')}</p>
              <p>
                Payout: <b>{money(quote.destination.amount_minor, 'NGN')}</b>
              </p>
              <small>Expires {new Date(quote.expires_at).toLocaleTimeString()}</small>
            </div>
          )}
          <label>
            Recipient
            <select
              aria-label="Network recipient"
              value={customer}
              disabled={locked}
              onChange={(e) => setCustomer(e.target.value)}
            >
              <option value="">Choose a recipient</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sandbox bank account
            <select
              aria-label="Sandbox bank account"
              value={instrument}
              disabled={locked}
              onChange={(e) => setInstrument(e.target.value)}
            >
              <option value="">Choose an NGN account</option>
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={
              locked ||
              !writable ||
              !quote ||
              !customer ||
              !instrument ||
              Date.parse(quote.expires_at) <= Date.now()
            }
            onClick={() => {
              const body = {
                plan_id: quote!.plan_id,
                customer_id: customer,
                destination_instrument_id: instrument,
                reference: `network-${crypto.randomUUID()}`,
              };
              void mutate(async (key) => {
                await api.createNetworkIntent(body, key);
                setQuote(undefined);
                setPlan(await api.getNetworkPlan(body.plan_id));
              });
            }}
          >
            Start sandbox route
          </button>
          {can('customers:write') && (
            <form
              className="network-add"
              onSubmit={(e) => {
                e.preventDefault();
                const recipientName = name;
                void mutate(async (key) => {
                  const c = await api.createCustomer({ name: recipientName }, `${key}-customer`);
                  await api.createInstrument(
                    c.id,
                    {
                      type: 'bank_account',
                      asset: 'NGN',
                      label: 'Nigeria sandbox account',
                      sandbox_identifier: `sandbox:network:${c.id}`,
                    },
                    `${key}-instrument`,
                  );
                  setCustomer(c.id);
                  setName('');
                });
              }}
            >
              <label>
                New sandbox recipient
                <input
                  aria-label="New sandbox recipient"
                  required
                  maxLength={100}
                  disabled={locked}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button className="button secondary" disabled={locked}>
                Add sandbox recipient
              </button>
            </form>
          )}
        </section>
        <section className="card">
          <div className="network-title">
            <h2>Route timeline</h2>
            <button
              aria-label="Refresh route"
              className="button secondary"
              disabled={!plan || busy}
              onClick={() => plan && void selectPlan(plan.id)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {!plan ? (
            <p>Get a quote or select a saved route to inspect its three steps.</p>
          ) : (
            <>
              <p className="mono">{plan.id}</p>
              <p>
                Saved corridor: <b>{plan.corridor_id}</b>
              </p>
              <p>
                Capacity: <b>{plan.capacity_state ?? 'Not reserved'}</b>
              </p>
              <ol className="network-legs">
                {plan.snapshot.legs.map((spec) => {
                  const leg = plan.legs.find((l) => l.position === spec.position);
                  return (
                    <li key={spec.position}>
                      <div>
                        <b>{spec.name}</b>
                        <span className="badge">
                          {leg?.outcome === 'confirmed' ? 'Confirmed' : (leg?.state ?? 'Waiting')}
                        </span>
                      </div>
                      <p>{money(spec.amount_minor, spec.asset)}</p>
                      <small>{spec.rail}</small>
                      {leg?.provider_reference && (
                        <p className="mono">Receipt: {leg.provider_reference}</p>
                      )}
                      {leg?.journal_id && <p className="mono">Journal: {leg.journal_id}</p>}
                    </li>
                  );
                })}
              </ol>
              {plan.legs.some((l) => l.outcome === 'rejected') && (
                <div className="notice">
                  The payout was rejected after earlier steps were accepted. Funds and capacity
                  remain held for operator review. Recovery never refunds or replaces accepted
                  steps.
                </div>
              )}
              {plan.intent_id && (
                <div className="network-actions">
                  <button
                    className="button secondary"
                    onClick={() => {
                      void api
                        .getIntent(plan.intent_id!)
                        .then(onSelect)
                        .catch((e) => setError(e.message));
                    }}
                  >
                    View transaction
                  </button>
                  {can('operations:write') && plan.capacity_state === 'held' && (
                    <button
                      className="button secondary"
                      disabled={locked}
                      onClick={() => {
                        const intentId = plan.intent_id!;
                        void mutate(async (key) => {
                          await api.recoverIntent(intentId, key);
                          setPlan(await api.getNetworkPlan(plan.id));
                        });
                      }}
                    >
                      Recover saved route
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <section className="card">
        <h2>Saved routes</h2>
        <div className="network-history">
          {plans.length ? (
            plans.map((p) => (
              <button
                className="button secondary mono"
                key={p.id}
                onClick={() => void selectPlan(p.id)}
              >
                {p.id} · {p.corridor_id}
              </button>
            ))
          ) : (
            <p>No route plans yet.</p>
          )}
        </div>
      </section>
      <section className="card network-routing">
        <div className="network-title">
          <h2>Sandbox routing</h2>
          <button
            className="button secondary"
            disabled={locked}
            onClick={() =>
              void api
                .getNetworkRouting(amount)
                .then(setRouting)
                .catch((e) => setError(e.message))
            }
          >
            Refresh route options
          </button>
        </div>
        <p>
          Healthy participants and available budget come first. Recent receipt results and simulator
          latency rank eligible routes.
        </p>
        <p>
          Current recommendation: <b>{routing?.selected_corridor_id ?? 'No eligible route'}</b>
        </p>
        <div className="rail-grid">
          {routing?.candidates.map((c) => (
            <article
              className="network-candidate"
              key={c.corridor_id}
              data-corridor={c.corridor_id}
            >
              <h3>
                {c.corridor_id === 'ng-ng-sandbox'
                  ? 'Nigeria primary payout'
                  : 'Nigeria alternate payout'}
              </h3>
              <span className="badge">{c.eligible ? 'Eligible' : 'Blocked'}</span>
              <p>
                {c.reason === 'participant_health'
                  ? 'Participant unavailable, degraded, or stale'
                  : c.reason === 'corridor_capacity'
                    ? 'Insufficient sandbox budget'
                    : c.reason === 'corridor_disabled'
                      ? 'Corridor disabled'
                      : 'Healthy sandbox route'}
              </p>
              <p>Budget: {money(c.available_minor, 'NGN')}</p>
              {c.health.map((h) => (
                <p key={h.participant_id} className="network-health mono">
                  {h.participant_id}: <b>{h.status}</b>
                  <br />
                  <small>
                    {h.samples} receipt samples ·{' '}
                    {h.latency_ms === null
                      ? 'Latency not measured'
                      : `${h.latency_ms} ms simulator latency`}{' '}
                    · {h.source.replaceAll('_', ' ')}
                  </small>
                </p>
              ))}
            </article>
          ))}
        </div>
        {can('operations:write') && (
          <form
            className="network-add"
            onSubmit={(e) => {
              e.preventDefault();
              const input = {
                participant_id: healthParticipant,
                status: healthStatus,
                reason: healthReason,
                valid_for_seconds: 300,
              };
              void mutate(async (key) => {
                await api.recordNetworkHealth(input, key);
                setQuote(undefined);
                setHealthReason('');
              });
            }}
          >
            <h3>Simulate provider health</h3>
            <p>
              These controls affect only your workspace. A scenario expires after five minutes;
              refresh it to keep routing available.
            </p>
            <label>
              Health participant
              <select
                aria-label="Health participant"
                value={healthParticipant}
                disabled={locked}
                onChange={(e) => setHealthParticipant(e.target.value)}
              >
                {registry?.participants
                  .filter((p) => p.enabled)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Health status
              <select
                aria-label="Health status"
                value={healthStatus}
                disabled={locked}
                onChange={(e) => setHealthStatus(e.target.value as typeof healthStatus)}
              >
                <option value="unavailable">Unavailable</option>
                <option value="degraded">Degraded</option>
                <option value="healthy">Healthy</option>
              </select>
            </label>
            <label>
              Health reason
              <input
                aria-label="Health reason"
                required
                maxLength={240}
                value={healthReason}
                disabled={locked}
                onChange={(e) => setHealthReason(e.target.value)}
              />
            </label>
            <button className="button secondary" disabled={locked}>
              Record sandbox health
            </button>
          </form>
        )}
      </section>
      <div className="rail-grid">
        {registry?.corridors
          .filter((c) => ['ng-ng-sandbox', 'ng-ng-alternate', 'ng-ke-sandbox'].includes(c.id))
          .map((c) => (
            <section className="card rail-card" key={c.id}>
              <h3>
                {c.source_asset} → {c.destination_asset}
              </h3>
              <p>
                {c.id === 'ng-ng-alternate'
                  ? 'Nigeria alternate sandbox corridor'
                  : c.enabled
                    ? 'Nigeria primary sandbox corridor'
                    : 'Second-country template · disabled'}
              </p>
              <span className="badge sandbox">{c.enabled ? 'Available' : 'Pending selection'}</span>
              <p>Budget remaining: {money(c.available_minor, c.source_asset)}</p>
              <small>
                This sandbox budget includes pending and completed routes; it is not a provider cash
                balance.
              </small>
            </section>
          ))}
      </div>
    </div>
  );
}
