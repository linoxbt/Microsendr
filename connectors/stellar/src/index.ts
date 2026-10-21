import { createHash } from 'node:crypto';
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { pool, type Client } from '../../../packages/database/src/index.js';
import {
  ProviderError,
  evidenceFor,
  type Connector,
  type PayoutRequest,
  type ProviderStatus,
} from '../../../packages/provider-sdk/src/index.js';
export const HORIZON = 'https://horizon-testnet.stellar.org';
export interface TestnetSigner {
  readonly publicKey: string;
  sign(transaction: Transaction): Promise<Transaction>;
}
function assertSignerPolicy(tx: Transaction, publicKey: string, issuer: string) {
  const op = tx.operations[0];
  if (
    tx.networkPassphrase !== Networks.TESTNET ||
    tx.source !== publicKey ||
    tx.operations.length !== 1 ||
    op.type !== 'payment' ||
    (op.source && op.source !== publicKey) ||
    (op.type === 'payment' &&
      (op.asset.code !== 'KUSD' ||
        op.asset.issuer !== issuer ||
        op.destination === publicKey ||
        op.destination === issuer)) ||
    BigInt(tx.fee) > 1000n ||
    !tx.timeBounds ||
    BigInt(tx.timeBounds.maxTime) > BigInt(Math.floor(Date.now() / 1000) + 300) ||
    BigInt(tx.timeBounds.maxTime) <= BigInt(Math.floor(Date.now() / 1000))
  )
    throw new Error('Signer policy refused transaction');
}
/** HTTPS custody bridge for the isolated Testnet asset. No local-key fallback. */
export class RemoteTestnetSigner implements TestnetSigner {
  readonly publicKey: string;
  private endpoint: string;
  constructor(
    private config: {
      endpoint: string;
      token: string;
      publicKey: string;
      issuer: string;
      fetch?: typeof fetch;
    },
  ) {
    const u = new URL(config.endpoint);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !config.token ||
      !StrKey.isValidEd25519PublicKey(config.publicKey) ||
      !StrKey.isValidEd25519PublicKey(config.issuer)
    )
      throw new Error('Invalid remote Testnet signer configuration');
    this.endpoint = u.toString();
    this.publicKey = config.publicKey;
  }
  async sign(tx: Transaction): Promise<Transaction> {
    assertSignerPolicy(tx, this.publicKey, this.config.issuer);
    if (tx.signatures.length) throw new Error('Remote signer requires an unsigned envelope');
    const expected = Buffer.from(tx.hash()).toString('hex');
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
          'idempotency-key': expected,
        },
        body: JSON.stringify({
          version: 1,
          network: 'testnet',
          asset: { code: 'KUSD', issuer: this.config.issuer },
          public_key: this.publicKey,
          transaction_hash: expected,
          unsigned_xdr: tx.toXDR(),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new Error('Remote signer unavailable');
    }
    if (!response.ok) throw new Error('Remote signer refused transaction');
    if (Number(response.headers.get('content-length') ?? 0) > 65536)
      throw new Error('Invalid remote signer response');
    // Bound the body while streaming, including responses without Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty remote signer response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error('Invalid remote signer response');
      }
      chunks.push(part.value);
    }
    const body = z
      .object({
        transaction_hash: z.string().regex(/^[a-f0-9]{64}$/),
        signed_xdr: z.string().max(60000),
      })
      .strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const signed = TransactionBuilder.fromXDR(body.signed_xdr, Networks.TESTNET);
    if (
      !(signed instanceof Transaction) ||
      body.transaction_hash !== expected ||
      Buffer.from(signed.hash()).toString('hex') !== expected ||
      !signed.signatures.some((s) =>
        Keypair.fromPublicKey(this.publicKey).verify(signed.hash(), s.signature),
      )
    )
      throw new Error('Remote signer response does not match the approved transaction');
    assertSignerPolicy(signed, this.publicKey, this.config.issuer);
    return signed;
  }
}
export class LocalTestnetSigner implements TestnetSigner {
  private key: Keypair;
  readonly publicKey: string;
  constructor(
    secret: string,
    private issuer: string,
  ) {
    this.key = Keypair.fromSecret(secret);
    this.publicKey = this.key.publicKey();
  }
  async sign(tx: Transaction) {
    assertSignerPolicy(tx, this.publicKey, this.issuer);
    tx.sign(this.key);
    return tx;
  }
}
export interface StellarConfig {
  issuer: string;
  treasury: string;
  signer: TestnetSigner;
  fetch?: typeof fetch;
}
export const integer = z.string().regex(/^(0|[1-9]\d*)$/);
const balanceSchema = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: z.string(),
  limit: z.string().optional(),
  buying_liabilities: z.string().optional(),
  selling_liabilities: z.string().optional(),
  is_authorized: z.boolean().optional(),
});
const accountSchema = z.object({
  account_id: z.string(),
  sequence: integer,
  balances: z.array(balanceSchema),
});
export function units(value: string): bigint {
  if (!/^\d+\.\d{7}$/.test(value))
    throw new ProviderError('unknown', 'Invalid Stellar amount', true);
  return BigInt(value.replace('.', ''));
}
export function stellarAmount(value: string) {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new ProviderError('rejected', 'Invalid Stellar amount');
  return `${BigInt(value) / 10000000n}.${(BigInt(value) % 10000000n).toString().padStart(7, '0')}`;
}
export class StellarTestnetConnector implements Connector {
  readonly id = 'stellar-testnet';
  readonly capabilities = ['payout', 'status'] as const;
  readonly idempotentInstructions = true;
  readonly binding: string;
  private networkChecked = false;
  constructor(readonly config: StellarConfig) {
    if (
      ![config.issuer, config.treasury, config.signer.publicKey].every(
        StrKey.isValidEd25519PublicKey,
      ) ||
      config.treasury !== config.signer.publicKey ||
      config.issuer === config.treasury
    )
      throw new ProviderError('rejected', 'Invalid Testnet issuer or signer configuration');
    this.binding = createHash('sha256')
      .update(`${Networks.TESTNET}:KUSD:${config.issuer}:${config.treasury}`)
      .digest('hex');
  }
  static configured() {
    return (
      !!process.env.STELLAR_TESTNET_ISSUER &&
      (process.env.STELLAR_SIGNER_MODE === 'remote'
        ? !!process.env.STELLAR_TESTNET_TREASURY_PUBLIC_KEY &&
          !!process.env.STELLAR_SIGNER_URL &&
          !!process.env.STELLAR_SIGNER_TOKEN
        : !!process.env.STELLAR_TESTNET_TREASURY_SECRET)
    );
  }
  static fromEnvironment() {
    if (
      process.env.STELLAR_SIGNER_MODE &&
      !['local', 'remote'].includes(process.env.STELLAR_SIGNER_MODE)
    )
      throw new Error('Unknown Stellar signer mode');
    const signer =
      process.env.STELLAR_SIGNER_MODE === 'remote'
        ? new RemoteTestnetSigner({
            endpoint: process.env.STELLAR_SIGNER_URL ?? '',
            token: process.env.STELLAR_SIGNER_TOKEN ?? '',
            publicKey: process.env.STELLAR_TESTNET_TREASURY_PUBLIC_KEY ?? '',
            issuer: process.env.STELLAR_TESTNET_ISSUER ?? '',
          })
        : new LocalTestnetSigner(
            process.env.STELLAR_TESTNET_TREASURY_SECRET ?? '',
            process.env.STELLAR_TESTNET_ISSUER ?? '',
          );
    return new StellarTestnetConnector({
      issuer: process.env.STELLAR_TESTNET_ISSUER ?? '',
      treasury: signer.publicKey,
      signer,
    });
  }
  async request(path: string, body?: URLSearchParams): Promise<unknown | null> {
    if (!/^\/[A-Za-z0-9/_?=&-]*$/.test(path)) throw new Error('Invalid Horizon path');
    let r: Response;
    try {
      r = await (this.config.fetch ?? fetch)(HORIZON + path, {
        method: body ? 'POST' : 'GET',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ProviderError('timeout', 'Stellar response unavailable', true);
    }
    if (r.status === 404 && !body) return null;
    if (!r.ok) throw new ProviderError('unavailable', `Stellar request failed (${r.status})`, true);
    try {
      return await r.json();
    } catch {
      throw new ProviderError('unknown', 'Invalid Horizon response', true);
    }
  }
  async assertNetwork() {
    if (!this.networkChecked) {
      const root = z
        .object({ network_passphrase: z.literal(Networks.TESTNET) })
        .parse(await this.request('/'));
      if (root.network_passphrase === Networks.TESTNET) this.networkChecked = true;
    }
  }
  async account(address: string) {
    if (!StrKey.isValidEd25519PublicKey(address))
      throw new ProviderError('invalid_account', 'Use a Stellar G address');
    await this.assertNetwork();
    const account = accountSchema.parse(await this.request(`/accounts/${address}`));
    if (account.account_id !== address)
      throw new ProviderError('unknown', 'Stellar account identity mismatch', true);
    return account;
  }
  async trustline(address: string, amount = 0n, sending = false) {
    const account = await this.account(address);
    const line = account.balances.find(
      (b) =>
        b.asset_code === 'KUSD' &&
        b.asset_issuer === this.config.issuer &&
        ['credit_alphanum4', 'credit_alphanum12'].includes(b.asset_type),
    );
    if (!line || line.is_authorized !== true || !line.limit)
      throw new ProviderError(
        'invalid_account',
        'An authorized KUSD trustline to the configured issuer is required',
      );
    const held = units(line.balance);
    const capacity = sending
      ? held - units(line.selling_liabilities ?? '0.0000000')
      : units(line.limit) - held - units(line.buying_liabilities ?? '0.0000000');
    if (capacity < amount)
      throw new ProviderError('insufficient_float', 'Insufficient Stellar trustline capacity');
    return account;
  }
  private validate(request: PayoutRequest) {
    const i = request.stellar_identity;
    if (
      request.provider_binding !== this.binding ||
      request.asset !== 'NGN' ||
      request.destination?.asset !== 'KUSD' ||
      !i ||
      i.network !== 'testnet' ||
      i.issuer !== this.config.issuer ||
      i.code !== 'KUSD' ||
      i.source !== this.config.treasury ||
      !StrKey.isValidEd25519PublicKey(request.beneficiary) ||
      request.beneficiary === this.config.treasury ||
      request.beneficiary === this.config.issuer
    )
      throw new ProviderError('rejected', 'Stellar instruction identity mismatch');
    stellarAmount(request.destination.amount_minor);
  }
  async payout(request: PayoutRequest, session?: Client): Promise<ProviderStatus> {
    this.validate(request);
    const c = session ?? (await pool.connect());
    const lock = `stellar-sequence:${this.config.treasury}`;
    try {
      await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]);
      let prepared = (
        await c.query('SELECT * FROM stellar_transactions WHERE instruction_id=$1', [
          request.instruction_id,
        ])
      ).rows[0];
      if (!prepared) {
        const pending = (await c.query(
          "SELECT st.transaction_hash,st.expires_at FROM stellar_transactions st JOIN instructions ins ON ins.id=st.instruction_id JOIN intents i ON i.id=ins.intent_id WHERE st.source_address=$1 AND i.state IN ('processing','unknown') AND st.instruction_id<>$2",
          [this.config.treasury, request.instruction_id],
        )).rows;
        // An envelope whose time bounds closed (with a minute of clock margin) and that
        // the network never applied can no longer be included, so it must not block the
        // treasury sequence forever. Its intent stays unknown for reconciliation.
        const now = BigInt(Math.floor(Date.now() / 1000));
        let busy = false;
        for (const previous of pending)
          if (BigInt(previous.expires_at) + 60n > now || (await this.transaction(previous.transaction_hash))) {
            busy = true;
            break;
          }
        if (busy)
          throw new ProviderError(
            'unavailable',
            'A previous treasury sequence awaits reconciliation',
            true,
          );
        const amount = BigInt(request.destination!.amount_minor);
        const source = await this.trustline(this.config.treasury, amount, true);
        await this.trustline(request.beneficiary, amount);
        const tx = new TransactionBuilder(new Account(this.config.treasury, source.sequence), {
          fee: '1000',
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.payment({
              destination: request.beneficiary,
              asset: new Asset('KUSD', this.config.issuer),
              amount: stellarAmount(request.destination!.amount_minor),
            }),
          )
          .addMemo(Memo.hash(createHash('sha256').update(request.instruction_id).digest()))
          .setTimeout(300)
          .build();
        const expected = Buffer.from(tx.hash()).toString('hex');
        const signed = await this.config.signer.sign(tx);
        if (
          Buffer.from(signed.hash()).toString('hex') !== expected ||
          !signed.signatures.some((s) =>
            Keypair.fromPublicKey(this.config.treasury).verify(signed.hash(), s.signature),
          )
        )
          throw new ProviderError(
            'rejected',
            'Signer changed or failed to authorize the instruction',
          );
        prepared = (
          await c.query(
            'INSERT INTO stellar_transactions(instruction_id,source_address,sequence,transaction_hash,signed_xdr,binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              request.instruction_id,
              this.config.treasury,
              signed.sequence,
              expected,
              signed.toXDR(),
              this.binding,
              signed.timeBounds!.maxTime,
            ],
          )
        ).rows[0];
      }
      // The durable envelope is the only envelope ever submitted for an instruction.
      if (prepared.binding !== this.binding)
        throw new ProviderError('rejected', 'Stellar credential binding changed');
      const previous = await this.fetchStatus(request.instruction_id, c);
      if (previous) return previous;
      if (BigInt(prepared.expires_at) <= BigInt(Math.floor(Date.now() / 1000)))
        throw new ProviderError(
          'unknown',
          'Expired transaction needs reconciliation; no replacement signed',
          true,
        );
      try {
        await this.request('/transactions', new URLSearchParams({ tx: prepared.signed_xdr }));
      } catch {
        /* GET is authoritative, including a failed transaction. */
      }
      const result = await this.fetchStatus(request.instruction_id, c);
      if (!result)
        throw new ProviderError('unknown', 'Transaction acknowledgement is ambiguous', true);
      return result;
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
      if (!session) c.release();
    }
  }
  async transaction(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new ProviderError('rejected', 'Invalid transaction hash');
    await this.assertNetwork();
    const raw = await this.request(`/transactions/${hash}`);
    if (raw === null) return null;
    const record = z
      .object({
        hash: z.string(),
        successful: z.boolean(),
        ledger: z.number().int().positive(),
        envelope_xdr: z.string(),
        fee_charged: integer,
      })
      .parse(raw);
    const tx = TransactionBuilder.fromXDR(record.envelope_xdr, Networks.TESTNET);
    if (
      !(tx instanceof Transaction) ||
      record.hash !== hash ||
      Buffer.from(tx.hash()).toString('hex') !== hash
    )
      throw new ProviderError('unknown', 'Transaction hash mismatch', true);
    return { record, tx };
  }
  async fetchStatus(instructionId: string, session?: Client): Promise<ProviderStatus | null> {
    const row = (
      await (session ?? pool).query(
        "SELECT st.*,ins.request FROM stellar_transactions st JOIN instructions ins ON ins.id=st.instruction_id WHERE st.instruction_id=$1 AND ins.provider='stellar-testnet'",
        [instructionId],
      )
    ).rows[0];
    if (!row) return null;
    this.validate(row.request);
    if (row.binding !== this.binding)
      throw new ProviderError('rejected', 'Stellar binding mismatch');
    const found = await this.transaction(row.transaction_hash);
    if (!found) return null;
    if (found.tx.toXDR() !== row.signed_xdr)
      throw new ProviderError('unknown', 'Stellar envelope mismatch', true);
    const op = found.tx.operations[0];
    if (
      found.tx.operations.length !== 1 ||
      op.type !== 'payment' ||
      op.destination !== row.request.beneficiary ||
      op.asset.code !== 'KUSD' ||
      op.asset.issuer !== this.config.issuer ||
      units(op.amount).toString() !== row.request.destination.amount_minor ||
      (op.source ?? found.tx.source) !== this.config.treasury
    )
      throw new ProviderError('unknown', 'Stellar payment evidence mismatch', true);
    return {
      provider_ref: `stellar_${instructionId}`,
      outcome: found.record.successful ? 'confirmed' : 'rejected',
      evidence: evidenceFor(row.request),
      stellar_data: {
        hash: row.transaction_hash,
        network: 'testnet',
        issuer: this.config.issuer,
        code: 'KUSD',
        ledger: found.record.ledger,
        fee_stroops: found.record.fee_charged,
        source: this.config.treasury,
        destination: row.request.beneficiary,
        amount_minor: row.request.destination.amount_minor,
      },
    };
  }
}
