# Consumer accounts

## Implemented

Personal is a custom Roots account, independent of Privy authentication. Registration collects legal names, email, username, international phone number, date of birth, residence and address. Nationality, occupation and a second address line are optional. After email ownership is verified, the user can start identity verification or defer it. This prevents an unverified email registration from attaching someone else’s identity decision to the account.

Passwords use asynchronous scrypt (N=131072, r=8, p=1) with random salts; legacy N=32768 hashes still verify and are upgraded on the next login. Session cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. Writes require an allowed Origin and session-bound CSRF token. Password login has IP and persistent per-email attempt limits. Password rotation revokes all previous sessions. Email recovery authorizes a password reset only for ten minutes after a successful one-time code. Existing Privy identities have a separate restore-only path to prove ownership and set a Roots password; it cannot create a new user or provision a new wallet.

Contact entry does not verify a phone or email. Claiming an unverified email using a valid email code revokes previous sessions and clears the pre-existing password to prevent pre-registration account takeover. The email owner then sets a password. Phone verification and email-change workflows are not implemented. Email is read-only in the profile.

Profiles use optimistic versions and an audit log of changed field names. Identity fields are locked during and after an active/approved Didit check; correction requires an operational support workflow. Display-currency edits do not post ledger entries.

The responsive dashboard has Home, Payments, Activity and Account. Add money offers bank/card and crypto methods; conversion supports selecting either direction; unsupported services show availability honestly. The overview never consumes the legacy simulated NGN balance or invents dollar assets. Actual previously tracked external settlements remain visible with their true amounts, network, status and downloadable records.

## API

- `POST /personal/api/auth/register` — create a custom account and session.
- `POST /personal/api/auth/password` — password sign-in.
- `POST /personal/api/auth/start`, `/auth/verify` — email-code verification/recovery.
- `GET /personal/api/profile`, `PATCH /personal/api/profile` — private profile and versioned edits.
- `POST /personal/api/profile/password` — change/set password with reauthentication.
- `GET /personal/api/overview` — consumer capability state and real settlement history.
- `POST /personal/api/conversion/quotes` — validates request, returns `route_unavailable` until an executable provider is integrated. No indicative calculation is represented as an executable quote.
- `GET /personal/api/kyc`, `POST /personal/api/kyc/session` — Didit status and hosted verification.
- `POST /personal/api/webhooks/didit` — signed, fresh, deduplicated provider decisions.

## Deployment

Apply migration 032 before starting the new API. It is additive except that an email can now exist before ownership verification; `email_verified_at` remains authoritative.

Server settings:

- `KORA_AUTH_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional `SMTP_USER`/`SMTP_PASS` enable email codes. Password accounts can be created without SMTP, but without it no user can verify an email, recover a password or start identity verification (Didit requires a verified email). Email codes sign in to existing accounts only. A signed-in owner who verifies their own email keeps their password; anyone else who proves the email resets it.
- `DIDIT_API_KEY` and `DIDIT_WEBHOOK_SECRET` enable verification. The KYC workflow ID lives in code. `node scripts/setup-didit.mjs` validates that workflow and registers/reuses the exact Roots HTTPS destination, storing secrets only in ignored `.env.local` and `.env.public`. It does not execute a person's KYC check.
- Secrets must never be placed in Vite variables or committed. Docker excludes every `.env*` except the empty example.

## Remaining live-payment dependencies

The Paystack implementation in this repository is test-only and is deliberately excluded from the consumer payment flow. Live funding/payout requires a separately verified live adapter, approved account, credentials, production asset positions, reconciliation, funding/limits and refund handling. A Paystack key alone must not switch simulated journals to live money.

Personal users can link existing QIE-compatible EVM wallets with a signed, single-use challenge. A linked wallet can receive native QIEV3 through its address and QR code, and can authorize a native QIEV3 transfer. The wallet provider holds the private key; Roots reads its onchain balance and reconciles outbound receipts without creating a customer ledger balance. Incoming transfers are visible in the wallet balance and explorer but are not independently indexed as Roots deposits. Native QIEV3 is not a digital dollar. Stablecoin deposits still require an approved token contract, custody/attribution model, finality monitoring and reconciliation.

Each account is also issued a Privy-managed EVM address at registration or login (`POST /personal/api/wallets/managed` retries). Roots controls that key through Privy, so it is custodial. Sending from it is off unless `KORA_MANAGED_TRANSFERS=true`. When on, the account wallet shows its address and QR code and can send native QIEV3: each send needs the account password, a verified email, approved identity verification (unless `KORA_MANAGED_TRANSFERS_REQUIRE_KYC=false`), and stays within per-transfer and rolling 24-hour limits. The API asks Privy only to sign (`eth_signTransaction`), decodes the signed bytes and recovers the signer, refuses anything that differs from the request, records the exact transaction, then broadcasts it through the QIE node. The worker re-sends the same bytes while it is unmined and reconciles it like any other settlement. One send signs at a time per wallet. Turning this on makes Roots custodial of those funds.

Crypto↔fiat conversion needs a contracted provider and an executable supported asset/network/currency route. No such provider is currently configured. There is no fabricated rate, bank payout, deposit address or success receipt. KYC approval alone does not enable a financial route.

## Verification

`tests/consumer.test.ts` covers registration, hashing, contact verification separation, date-only preservation, CSRF, version conflicts, identity locks, session revocation, recovery and exclusion of simulated balances. Browser tests create an account, defer KYC, edit a profile, sign out/in, check both conversion directions and test each page at phone width.

## Pay by @username (P2P payments)

Roots users can pay each other by username. Being payable is opt-in (Security page,
"Get paid by username"); until then a username reveals nothing. Looking up
`@username` returns only the recipient's first name and last initial and the address
they receive at: their most recently linked wallet, or their account wallet only
while account wallet sends are enabled. Lookups are rate limited to deter scraping.
The payment itself is an ordinary QIE transfer from the sender's linked or account
wallet, settled and reconciled like any other.

A P2P trading marketplace (swapping crypto for naira between users) is not built: it
needs escrow, dispute handling, payment confirmation and regulatory review first.
