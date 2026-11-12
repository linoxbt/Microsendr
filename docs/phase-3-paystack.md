# Phase 3 — Paystack test mode

The first local rail implements domestic NGN collections and bank payouts using
Paystack's test API. It shares Kora's ledger, payment intents, outbox, scoped
authentication, idempotency, events and merchant webhooks. Cross-border conversion
and Stellar settlement continue to use the simulator.

The implementation is validated locally against a Paystack API harness. **The
provider sandbox exit gate remains open:** no Paystack test credential was
provided or used. Local tests do not establish partner approval, account access,
provider liquidity, complete statement coverage or production suitability.

## Configure and check

1. Apply migrations with `pnpm db:migrate` and build with `pnpm build`.
2. Add `PAYSTACK_SECRET_KEY` to `.env` using your Paystack test secret key.
   The connector rejects live keys and public keys. Keep provider credentials
   on the API/worker server; never use a frontend environment variable.
3. Run `pnpm paystack:check`. It only reads banks, balance availability and the
   provider balance-ledger snapshot. Its output omits credentials, account
   numbers and provider balances. This check does not send a payout or initialize
   a collection.
4. Start `pnpm start` and `pnpm worker`. Open **Local rail** in the console.
5. Configure Paystack's webhook URL to reach
   `POST /internal/providers/paystack/webhook` on your API. Localhost needs an
   appropriately configured test endpoint/tunnel. Kora does not create a public
   tunnel or change your provider dashboard settings automatically.

Without a configured test key, the console shows **Setup required** and disables
provider payment actions. Existing simulator flows remain usable. Merchant ledger
balances are test fixtures; they do not establish a Paystack transfer balance.

## Bank accounts and payouts

Use **Bank accounts** to select a customer and bank, perform account-name enquiry,
then register the resolved account. The enquiry expires after one day. The full
account number is encrypted at rest. Public API responses and the console show
the name and last four digits; persisted payout instructions contain an account
identity hash. Recipient identity, bank code and account hash must match verified
provider evidence. Recipient registration is deduplicated by customer/provider
recipient, including concurrent requests.

**Bank payout** creates an NGN-to-NGN quote and the existing payment intent in one
transaction. The source amount includes Kora's illustrative 0.5% fee, rounded up;
the recipient gets the remaining principal. For example, a source amount of
100,000 kobo reserves 100,000, quotes a 500 fee and sends 99,500 to the recipient.
The quote lasts five minutes, and merchant limits and compliance decisions apply.
Only a provider-verified NGN bank instrument can receive a domestic payout.

The worker persists the immutable instruction before submitting. Its stable
Paystack reference is `kora_<instruction_id>`, within the documented reference
format. It queries transfer status before a possible submission or retry.
A POST acknowledgement never captures funds: independent verified status must
match the reference, exact amount, currency, test domain and recipient identity.
Pending, OTP/approval, unreadable or mismatched outcomes retain the reservation
and surface as unknown/review. No automatic OTP or approval-setting change occurs.

Test provider payout fees are separately journaled as operator expense against
sandbox treasury funding. They do not silently reduce the quoted merchant or
recipient amount. This is a declared test accounting policy, not a production
fee agreement or representation of real provider cash.

## Collections

**Collections** queues initialization of a Paystack hosted checkout with a stable
reference, customer, payer email and exact gross kobo amount. Refresh/polling shows
the checkout link once initialization succeeds. Initialization is marked as a
possible submission before network I/O. A lost response or crash only permits
verification of that same reference; the worker never initializes another
checkout automatically. If a crash happened before the provider accepted it,
the collection remains unknown for operator review rather than guessing.

An authenticated `charge.success` callback is saved to an encrypted immutable
inbox and acknowledged before verification. The worker independently calls
transaction verification. The reference, test domain, NGN currency, amount and
payer email must match. Provider fees must be present, nonnegative and below the
gross charge. Only then does one atomic transaction persist the receipt, journal,
state and merchant event. Duplicate callbacks or concurrent verification cannot
credit twice. A fresh explicit verification fences an older job acknowledgement,
so overlapping requests cannot silently discard the requested check.

For a 100,000 kobo charge with a verified 100 fee, the journal debits 99,900 to
merchant available, debits 100 to provider expense and credits 100,000 to the
collection clearing account. If the customer or merchant becomes held/disabled
before verification, the 99,900 credits reserved instead. An authorized operator
must record customer approval and release the settled collection before it is
spendable. Failed collections create no credit. Collection refunds/chargebacks
are not implemented in this phase and require a later explicit workflow.

## Callbacks, returns and account binding

Paystack signatures use HMAC SHA-512 of the exact raw body. Kora verifies them
with the server test key, deduplicates by payload hash, and queues durable work.
Supported events are `charge.success`, `transfer.success`, `transfer.failed` and
`transfer.reversed`. Other signed event types are ignored. Callback payloads
cannot directly post financial entries. Provider verification remains authoritative.

A verified late transfer reversal moves an intent from succeeded to returned and
posts one correcting journal that refunds the original merchant principal and
Kora fee. The original capture, receipt and journals stay immutable. A reversal
verified before capture releases the held source funds instead. Replays cannot
refund twice, and a stale success cannot move a returned intent back to succeeded.
Any original payout provider expense remains recorded unless separately verified;
the test policy does not assume that the provider refunded its own fee.

Operations inspection shows correcting journals and rail receipts. Operators can
queue `POST /v1/local_payouts/:id/verify` for a late return even if its callback was
lost. This requires `operations:write` and ownership. The endpoint also appears
in the TypeScript SDK as `verifyLocalPayout`.

Enquiries, recipients, collections, statements and payout instructions are bound
to a non-secret fingerprint of the configured test key. Changing credentials
blocks existing instructions from verification/resubmission through a different
binding. This deliberately also blocks old work after a same-account key rotation:
an operator must review and reconcile the old account first. No automatic binding
migration or resend is provided. Pre-binding local fixtures remain unbound and
cannot be silently assigned to a provider account.

## Compliance and statement reconciliation

**Controls & statements** records reasoned allow/hold decisions with the operator
API key identity. Records are append-only. These controls enforce sandbox customer
verification and merchant limits; they do not implement production KYC, KYB,
sanctions checks or legal authorization. Holds stop unsent payouts. Status recovery
of an already-submitted payout continues while the customer is held.

Reconciliation reads the current Paystack balance-ledger snapshot. Provider
Transaction IDs map to net collection credits; Transfer IDs map to verified
payout principal plus provider fee debits and verified return principal credits.
Each run stores immutable row evidence and expected versus actual amounts.
Mismatch or unmapped rows produce review; an empty snapshot also produces review.
A failed fetch/invalid snapshot produces a visible failed run and can be retried
by creating a fresh run. Reconciliation never changes a merchant balance.

The snapshot is integration-wide and can contain entries outside one workspace.
The merchant API exposes only its mapped rows and an unmapped count. Provider IDs,
amounts and evidence for unowned/unmapped rows are redacted. A matched snapshot
certifies only those returned rows. Pagination, historical imports, opening/closing
balance proof and complete daily cash reconciliation remain an explicit provider
validation/production gate.

## API and SDK additions

All `/v1` endpoints require the existing scoped key or cookie session. Mutations
require an idempotency key. The generated [OpenAPI](../specs/openapi/microsendr.json)
includes concrete request/response models and the browser-safe SDK methods.

| Capability | Endpoints | Scope |
| --- | --- | --- |
| Provider configuration | `GET /v1/rails` | `payments:read` |
| Banks/name enquiry | `GET /v1/banks`, `POST /v1/bank_resolutions` | `customers:read/write` |
| Verified recipients | `GET/POST /v1/customers/:id/bank_accounts` | `customers:read/write` |
| Domestic payout | `POST /v1/local_payouts` | `payments:write` |
| Late payout status | `POST /v1/local_payouts/:id/verify` | `operations:write` |
| Collections | `GET/POST /v1/collections`, `GET /v1/collections/:id` | `payments:read/write` |
| Collection verification | `POST /v1/collections/:id/verify` | `payments:write` |
| Held collection release | `POST /v1/collections/:id/release` | `operations:write` |
| Compliance history/decisions | `GET/POST /v1/customers/:id/compliance_decisions` | `operations:read/write` |
| Statement runs | `GET/POST /v1/operations/statements`, `GET /v1/operations/statements/:id` | `operations:read/write` |

Collection events use `collection.created`, `.succeeded`, `.failed` and `.held`;
their event data is a Collection model with `intent_id: null`. Merchant event
consumers should handle the Intent-or-Collection union and deduplicate stable
event IDs. Request metadata logs omit payloads, bank details and credentials.

## Validation commands and remaining gate

Run checks sequentially with standalone workers stopped:

```sh
pnpm check
pnpm contract:check
pnpm build
pnpm smoke:phase1
pnpm smoke:phase3
pnpm test:browser
pnpm test:browser:rail
```

`smoke:phase3` uses local HTTP and separate worker processes. It kills a worker
after provider acceptance, verifies one recovered payout POST, performs a
collection with duplicate signed callbacks, verifies one late return, and matches
three statement rows with clean ledger invariants. The browser rail suite runs
against a test-only provider harness and test-only callback completion server;
those controls are absent from production entry points.

To close the external sandbox gate, use an approved Paystack test integration to
validate a real name enquiry/recipient, checkout completion, transfer verification,
signed callback delivery, account-specific error/OTP behavior, provider fees and
statement rows. Preserve redacted evidence, verify entitlement and provider cash
coverage, and record any differences from the harness. A read-only readiness check
alone does not satisfy these criteria. Live activation remains Phase 5 work.

## Provider references

Implementation was checked against Paystack's official documentation:

- [Single transfers and stable retry references](https://paystack.com/docs/transfers/single-transfers/)
- [Transfer verification and fee evidence](https://paystack.com/docs/api/transfer/)
- [Recipient registration](https://paystack.com/docs/api/transfer-recipient/)
- [Account-name enquiry](https://paystack.com/docs/api/verification/)
- [Collection initialization and verification](https://paystack.com/docs/api/transaction/)
- [Balance-ledger snapshots](https://paystack.com/docs/api/transfer-control/)
- [Webhook signatures and supported events](https://paystack.com/docs/payments/webhooks/)
