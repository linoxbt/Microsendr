import { createHash } from 'node:crypto';
import { id, pool, transaction, type Client } from '../../database/src/index.js';
import { postJournal, accountId } from '../../ledger/src/index.js';
import { minor, type AssetId } from '../../core/src/index.js';
import { PaymentError } from '../../payments/src/errors.js';
import { evaluateRoutes, healthLock, requireHealthy, type RoutingDecision } from './routing.js';
import {
  ProviderError,
  evidenceFor,
  type Connector,
  type PayoutRequest,
  type ProviderStatus,
} from '../../provider-sdk/src/index.js';
export interface PlanLeg {
  position: number;
  name: string;
  participant_id: string;
  provider_binding: string;
  asset: AssetId;
  amount_minor: string;
  rail: string;
}
export interface PlanSnapshot {
  mode: 'sandbox';
  settlement_mode: 'simulated';
  source_minor: string;
  destination_minor: string;
  fee_minor: string;
  legs: PlanLeg[];
  routing?: RoutingDecision;
}
export async function registry(c: Client) {
  return {
    mode: 'sandbox',
    external_validated: false,
    participants: (await c.query('SELECT * FROM network_participants ORDER BY role,id')).rows,
    corridors: (
      await c.query(
        "SELECT n.*,COALESCE(sum(r.amount_minor) FILTER(WHERE (r.state='held' OR (r.state='consumed' AND r.updated_at>now()-interval '24 hours'))),0)::text allocated_minor,(n.capacity_minor-COALESCE(sum(r.amount_minor) FILTER(WHERE (r.state='held' OR (r.state='consumed' AND r.updated_at>now()-interval '24 hours'))),0))::text available_minor FROM network_corridors n LEFT JOIN network_reservations r ON r.corridor_id=n.id GROUP BY n.id ORDER BY n.id",
      )
    ).rows.map((r) => ({ ...r, capacity_minor: String(r.capacity_minor) })),
  };
}
export async function quoteCorridor(
  c: Client,
  m: string,
  input: {
    corridor_id: string;
    amount_minor: string;
    scenario?: 'success' | 'timeout' | 'insufficient_float';
  },
) {
  let routing: RoutingDecision | undefined;
  let corridorId = input.corridor_id;
  if (corridorId === 'auto') {
    routing = await evaluateRoutes(c, m, input.amount_minor);
    if (!routing.selected_corridor_id)
      throw new PaymentError(
        422,
        'no_eligible_route',
        'No healthy sandbox route has sufficient capacity',
      );
    corridorId = routing.selected_corridor_id;
  }
  const corridor = (await c.query('SELECT * FROM network_corridors WHERE id=$1', [corridorId]))
    .rows[0];
  if (!corridor?.enabled)
    throw new PaymentError(422, 'corridor_unavailable', 'Sandbox corridor is unavailable');
  const participants = (
    await c.query('SELECT * FROM network_participants WHERE id=ANY($1)', [
      [corridor.origin_id, corridor.settlement_id, corridor.destination_id],
    ])
  ).rows;
  if (participants.length !== 3 || participants.some((p) => !p.enabled))
    throw new PaymentError(422, 'participant_unavailable', 'A corridor participant is unavailable');
  for (const participant of participants) await requireHealthy(c, m, participant.id);
  if (
    corridor.source_asset !== 'NGN' ||
    !['NGN', 'KES'].includes(corridor.destination_asset) ||
    !participants.some(
      (p) => p.id === corridor.origin_id && p.role === 'origin' && p.asset === 'NGN',
    ) ||
    !participants.some(
      (p) => p.id === corridor.settlement_id && p.role === 'settlement' && p.asset === 'KUSD',
    ) ||
    !participants.some(
      (p) =>
        p.id === corridor.destination_id &&
        p.role === 'destination' &&
        p.asset === corridor.destination_asset,
    )
  )
    throw new PaymentError(
      422,
      'corridor_unavailable',
      'Corridor assets and participant roles are unsupported',
    );
  const merchant = (
    await c.query('SELECT enabled,max_source_minor FROM merchants WHERE id=$1', [m])
  ).rows[0];
  const gross = minor(input.amount_minor);
  if (!merchant?.enabled || gross > BigInt(merchant.max_source_minor))
    throw new PaymentError(422, 'limit_exceeded', 'Merchant is held or amount exceeds its limit');
  const fee = (gross * 5n + 999n) / 1000n,
    principal = gross - fee,
    kusd = (principal * 10000000n) / 160000n,
    destination = (kusd * (corridor.destination_asset === 'NGN' ? 160000n : 13000n)) / 10000000n;
  if (destination <= 0n || kusd <= 0n)
    throw new PaymentError(422, 'invalid_quote', 'Amount is too small for the corridor');
  const planId = id('rte'),
    quoteId = id('qte');
  const specs = [
    {
      position: 1,
      name: 'Nigeria source conversion',
      participant_id: corridor.origin_id,
      asset: 'NGN' as const,
      amount_minor: principal.toString(),
      rail: 'Nigeria sandbox rail',
    },
    {
      position: 2,
      name: 'KUSD settlement',
      participant_id: corridor.settlement_id,
      asset: 'KUSD' as const,
      amount_minor: kusd.toString(),
      rail: 'Sandbox settlement layer',
    },
    {
      position: 3,
      name:
        corridor.destination_asset === 'NGN'
          ? 'Nigeria destination payout'
          : 'Kenya destination payout',
      participant_id: corridor.destination_id,
      asset: corridor.destination_asset as AssetId,
      amount_minor: destination.toString(),
      rail:
        corridor.destination_asset === 'NGN' ? 'Nigeria sandbox payout rail' : 'Kenya sandbox rail',
    },
  ];
  const legs = specs.map((l) => ({
    ...l,
    provider_binding: participants.find((p) => p.id === l.participant_id).provider_binding,
  }));
  const snapshot: PlanSnapshot = {
    mode: 'sandbox',
    settlement_mode: 'simulated',
    source_minor: gross.toString(),
    destination_minor: destination.toString(),
    fee_minor: fee.toString(),
    legs,
    ...(routing ? { routing } : {}),
  };
  const quote = (
    await c.query(
      "INSERT INTO quotes(id,merchant_id,source_asset,destination_asset,source_minor,destination_minor,fee_minor,route,expires_at) VALUES($1,$2,'NGN',$7,$3,$4,$5,$6,now()+interval '5 minutes') RETURNING *",
      [
        quoteId,
        m,
        gross.toString(),
        destination.toString(),
        fee.toString(),
        JSON.stringify(legs),
        corridor.destination_asset,
      ],
    )
  ).rows[0];
  await c.query(
    'INSERT INTO network_plans(id,merchant_id,quote_id,corridor_id,scenario,snapshot) VALUES($1,$2,$3,$4,$5,$6)',
    [planId, m, quoteId, corridor.id, input.scenario ?? 'success', snapshot],
  );
  return { quote, plan_id: planId, routing: routing ?? null };
}
export async function reserveCorridor(
  c: Client,
  intent: {
    id: string;
    quote_id: string;
    merchant_id: string;
    source_minor: string;
    scenario: string;
  },
) {
  const plan = (await c.query('SELECT * FROM network_plans WHERE quote_id=$1', [intent.quote_id]))
    .rows[0];
  if (!plan) return;
  if (plan.merchant_id !== intent.merchant_id || plan.scenario !== intent.scenario)
    throw new PaymentError(
      422,
      'route_mismatch',
      'Intent must use its frozen corridor plan and scenario',
    );
  const corridor = (
    await c.query('SELECT * FROM network_corridors WHERE id=$1 FOR UPDATE', [plan.corridor_id])
  ).rows[0];
  const participants = (
    await c.query('SELECT * FROM network_participants WHERE id=ANY($1) FOR SHARE', [
      plan.snapshot.legs.map((l: PlanLeg) => l.participant_id),
    ])
  ).rows;
  if (
    !corridor.enabled ||
    plan.snapshot.legs.some(
      (l: PlanLeg) =>
        !participants.some(
          (p) =>
            p.id === l.participant_id && p.enabled && p.provider_binding === l.provider_binding,
        ),
    )
  )
    throw new PaymentError(
      422,
      'participant_unavailable',
      'Frozen participants are unavailable or their binding changed',
    );
  for (const participant of [...participants].sort((a, b) => a.id.localeCompare(b.id))) {
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      healthLock(intent.merchant_id, participant.id),
    ]);
    await requireHealthy(c, intent.merchant_id, participant.id);
  }
  const used = (
    await c.query(
      // Capacity is a rolling 24-hour limit: held amounts count until released, consumed
      // amounts for a day after settlement.
      "SELECT COALESCE(sum(amount_minor),0)::text amount FROM network_reservations WHERE corridor_id=$1 AND (state='held' OR (state='consumed' AND updated_at>now()-interval '24 hours'))",
      [corridor.id],
    )
  ).rows[0].amount;
  if (BigInt(used) + BigInt(intent.source_minor) > BigInt(corridor.capacity_minor))
    throw new PaymentError(422, 'corridor_capacity', 'Sandbox corridor capacity is exhausted');
  await c.query(
    "INSERT INTO network_reservations(plan_id,intent_id,corridor_id,amount_minor,state) VALUES($1,$2,$3,$4,'held')",
    [plan.id, intent.id, corridor.id, intent.source_minor],
  );
}
export async function completeCorridor(
  c: Client,
  intentId: string,
  state: 'consumed' | 'released',
) {
  await c.query(
    "UPDATE network_reservations SET state=$2,updated_at=now() WHERE intent_id=$1 AND state='held'",
    [intentId, state],
  );
}
export async function planned(c: Client, quoteId: string) {
  return (
    (await c.query('SELECT id FROM network_plans WHERE quote_id=$1', [quoteId])).rowCount !== 0
  );
}
export class CorridorSandboxConnector implements Connector {
  readonly id = 'kora-sandbox';
  readonly binding = 'corridor-simulator:v1';
  readonly capabilities = ['payout', 'status'] as const;
  readonly idempotentInstructions = true;
  constructor(
    private options: {
      checkpoint?: (position: number) => Promise<void>;
      beforeAcceptance?: (position: number) => Promise<void>;
    } = {},
  ) {}
  private async instruction(instructionId: string) {
    return (
      await pool.query(
        'SELECT ins.*,p.id plan_id,p.merchant_id,p.scenario,p.snapshot,p.corridor_id FROM instructions ins JOIN intents i ON i.id=ins.intent_id JOIN network_plans p ON p.quote_id=i.quote_id WHERE ins.id=$1',
        [instructionId],
      )
    ).rows[0];
  }
  async fetchStatus(instructionId: string): Promise<ProviderStatus | null> {
    const ins = await this.instruction(instructionId);
    if (!ins) return null;
    const legs = (
      await pool.query(
        'SELECT l.*,m.outcome FROM network_legs l LEFT JOIN network_movements m ON m.leg_id=l.id WHERE l.instruction_id=$1 ORDER BY position',
        [instructionId],
      )
    ).rows;
    for (const leg of legs)
      if (leg.outcome && leg.state !== leg.outcome)
        await pool.query('UPDATE network_legs SET state=$2,updated_at=now() WHERE id=$1', [
          leg.id,
          leg.outcome,
        ]);
    // Partial acceptance is never treated as a whole-route rejection or refunded.
    if (legs.length !== 3 || legs.some((l) => l.outcome !== 'confirmed')) return null;
    return {
      provider_ref: ins.provider_ref,
      outcome: 'confirmed',
      evidence: evidenceFor(ins.request),
    };
  }
  async payout(req: PayoutRequest): Promise<ProviderStatus> {
    const ins = await this.instruction(req.instruction_id);
    if (!ins || JSON.stringify(ins.request) !== JSON.stringify(req))
      throw new ProviderError('rejected', 'Corridor request differs from persisted instruction');
    const reservation = (
      await pool.query("SELECT 1 FROM network_reservations WHERE plan_id=$1 AND state='held'", [
        ins.plan_id,
      ])
    ).rowCount;
    if (!reservation) throw new ProviderError('rejected', 'Corridor reservation is not active');
    for (const spec of ins.snapshot.legs as PlanLeg[]) {
      const leg = await transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `route-leg:${ins.plan_id}:${spec.position}`,
        ]);
        const previous = (
          await c.query('SELECT * FROM network_legs WHERE plan_id=$1 AND position=$2', [
            ins.plan_id,
            spec.position,
          ])
        ).rows[0];
        if (previous) return previous;
        return (
          await c.query(
            "INSERT INTO network_legs(id,plan_id,position,instruction_id,participant_id,provider_binding,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared') RETURNING *",
            [
              id('leg'),
              ins.plan_id,
              spec.position,
              req.instruction_id,
              spec.participant_id,
              spec.provider_binding,
              {
                ...spec,
                beneficiary: req.beneficiary,
                instruction_id: req.instruction_id,
                hold_id: req.hold_id,
              },
            ],
          )
        ).rows[0];
      });
      const existing = (
        await pool.query('SELECT * FROM network_movements WHERE leg_id=$1', [leg.id])
      ).rows[0];
      if (existing) {
        if (existing.outcome === 'rejected')
          throw new ProviderError('unknown', 'Partial corridor requires operator review', true);
        await pool.query(
          "UPDATE network_legs SET state='confirmed',updated_at=now() WHERE id=$1 AND state IN ('prepared','unknown')",
          [leg.id],
        );
        continue;
      }
      const participant = (
        await pool.query('SELECT * FROM network_participants WHERE id=$1', [spec.participant_id])
      ).rows[0];
      if (!participant.enabled || participant.provider_binding !== spec.provider_binding)
        throw new ProviderError('unavailable', 'Frozen participant is unavailable', true);
      await pool.query(
        "UPDATE network_legs SET state='unknown',updated_at=now() WHERE id=$1 AND state='prepared'",
        [leg.id],
      );
      const outcome =
        spec.position === 3 && ins.scenario === 'insufficient_float' ? 'rejected' : 'confirmed';
      await transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `route-leg:${ins.plan_id}:${spec.position}`,
        ]);
        if ((await c.query('SELECT 1 FROM network_movements WHERE leg_id=$1', [leg.id])).rowCount)
          return;
        await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
          healthLock(ins.merchant_id, spec.participant_id),
        ]);
        const boundParticipant = (
          await c.query('SELECT * FROM network_participants WHERE id=$1 FOR SHARE', [
            spec.participant_id,
          ])
        ).rows[0];
        if (
          !boundParticipant?.enabled ||
          boundParticipant.provider_binding !== spec.provider_binding
        )
          throw new ProviderError(
            'unavailable',
            'Frozen participant binding changed before acceptance',
            true,
          );
        await requireHealthy(c, ins.merchant_id, spec.participant_id);
        await this.options.beforeAcceptance?.(spec.position);
        const fingerprint = createHash('sha256').update(JSON.stringify(leg.request)).digest('hex');
        const journal =
          outcome === 'confirmed'
            ? await postJournal(c, {
                reference: `corridor-leg:${leg.id}`,
                description: `Simulated ${spec.name}; no external funds moved`,
                entries: [
                  {
                    account_id: accountId(null, spec.asset, 'network_settled'),
                    side: 'debit',
                    amount: spec.amount_minor,
                  },
                  {
                    account_id: accountId(null, spec.asset, 'network_in_transit'),
                    side: 'credit',
                    amount: spec.amount_minor,
                  },
                ],
              })
            : null;
        await c.query(
          'INSERT INTO network_movements(leg_id,provider_reference,fingerprint,outcome,payload,journal_id) VALUES($1,$2,$3,$4,$5,$6)',
          [
            leg.id,
            `sim_${leg.id}`,
            fingerprint,
            outcome,
            { ...leg.request, mode: 'sandbox', settlement_mode: 'simulated', outcome },
            journal,
          ],
        );
      });
      await this.options.checkpoint?.(spec.position);
      if (spec.position === 2 && ins.scenario === 'timeout')
        throw new ProviderError('timeout', 'Settlement accepted; acknowledgement lost', true);
      await pool.query('UPDATE network_legs SET state=$2,updated_at=now() WHERE id=$1', [
        leg.id,
        outcome,
      ]);
      if (outcome === 'rejected')
        throw new ProviderError(
          'unknown',
          'Destination rejected after earlier legs accepted; retain source hold for review',
          true,
        );
    }
    return (await this.fetchStatus(req.instruction_id))!;
  }
}
export async function detail(c: Client, m: string, planId: string) {
  const plan = (
    await c.query(
      'SELECT p.*,r.intent_id,r.state capacity_state FROM network_plans p LEFT JOIN network_reservations r ON r.plan_id=p.id WHERE p.id=$1 AND p.merchant_id=$2',
      [planId, m],
    )
  ).rows[0];
  if (!plan) throw new PaymentError(404, 'route_not_found', 'Route plan not found');
  const legs = (
    await c.query(
      'SELECT l.id,l.position,l.participant_id,l.provider_binding,l.request,l.state,m.provider_reference,m.outcome,m.payload,m.journal_id,m.created_at receipt_at FROM network_legs l LEFT JOIN network_movements m ON m.leg_id=l.id WHERE l.plan_id=$1 ORDER BY position',
      [plan.id],
    )
  ).rows;
  return {
    id: plan.id,
    quote_id: plan.quote_id,
    intent_id: plan.intent_id ?? null,
    corridor_id: plan.corridor_id,
    capacity_state: plan.capacity_state ?? null,
    scenario: plan.scenario,
    snapshot: plan.snapshot,
    legs,
    mode: 'sandbox',
    external_validated: false,
    created_at: plan.created_at,
  };
}
