# Deploying the API and worker on Railway

Railway runs the same production image as `compose.public.yaml`, built from the
repository `Dockerfile`. CI builds that image and boots it on every push (the
`image` job in `.github/workflows/ci.yml`), so a green build means it starts.

## Services

| Service | Config file | Notes |
| --- | --- | --- |
| PostgreSQL | Railway PostgreSQL | Provides `DATABASE_URL` |
| `api` | `deploy/railway/api.json` | Runs migrations before each deploy, then the API; health check `/health`; give it a public domain |
| `worker` | `deploy/railway/worker.json` | Background queues; no public domain. Exits after five minutes without progress so the ALWAYS restart policy restarts it |

Both app services deploy from `main` of the GitHub repository. Railway no longer
lets new services read a config file, so the settings in `deploy/railway/*.json`
(start command, pre-deploy migration, health check, restart policy) are set on
each service directly; keep the two in step.

The API runs in the production environment at `roots-api.up.railway.app`.

The general per-client request limit is kept in memory by default, which is right for
one `api` replica. Before running more than one, set `KORA_RATE_LIMIT_STORE=postgres`
on `api` so every replica counts against the same window (one small write per request;
the worker clears old counters). The limits that guard against guessing (sign-in, email
codes, password, payment PIN) are kept in PostgreSQL and hold across replicas either way.

## Variables

Set on both `api` and `worker` (Railway variable references keep them in step):

- `DATABASE_URL`: reference the PostgreSQL service's `DATABASE_URL`
- `KORA_MODE=sandbox`
- `KORA_WEBHOOK_ENCRYPTION_KEY`, `KORA_PROVIDER_CALLBACK_SECRET`: independent random secrets
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (rotated, server-only), and `PRIVY_POLICY_ID`
  from `node --import tsx scripts/privy-policy.ts --apply`
- `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET`
- `KORA_MANAGED_TRANSFERS=true` and, if the defaults do not suit,
  `KORA_MANAGED_TRANSFER_MAX_QIE`, `KORA_MANAGED_TRANSFER_DAILY_QIE`,
  `KORA_MANAGED_TRANSFER_MAX_QUSDC`, `KORA_MANAGED_TRANSFER_DAILY_QUSDC`
- `KORA_MANAGED_TRANSFERS_REQUIRE_KYC` (default required); with `false`, unverified
  accounts use `KORA_UNVERIFIED_TRANSFER_*` (defaults 50 per send, 100 a day)
- `FONBNK_CLIENT_ID`, `FONBNK_SIGNATURE_SECRET`, `FONBNK_WEBHOOK_SECRET`,
  `FONBNK_BASE_URL` (`https://api.fonbnk.com` for live), `FONBNK_ASSETS`
- `QIE_RPC_URL` only to override the default QIE Mainnet RPC

`api` only:

- `HOST=0.0.0.0` (Railway supplies `PORT`)
- `KORA_CONSOLE_ORIGINS`: the exact Netlify HTTPS origin
- `KORA_AUTH_SECRET` (at least 32 bytes), `EMAIL_FROM`, `RESEND_API_KEY`
- `KORA_PROXY_SIGNING_SECRET`: same value as in Netlify. With it set, browser routes
  answer only requests the Netlify proxy signed (`KORA_REQUIRE_PROXY_SIGNATURE=false`
  turns this off). Check `https://<site>/personal/api/health` reports
  `"via_signed_proxy": true` before relying on it.
- `KORA_PUBLIC_API_URL`: the public HTTPS origin providers post webhooks to
- `KORA_WEBAUTHN_RP_ID` only if passkeys must work across subdomains
- `KORA_LEGACY_PLATFORM` stays unset (the retired business platform is off in production)
- `KORA_TRUSTED_PROXIES`: Railway's edge is the hop in front of the API. Leave the
  default; with the Netlify signing secret set, the client address comes from
  Netlify's signed header.

## Frontend

Netlify proxies only `/personal/api/*` (signed) to the `api` service's Railway
domain. Register the Didit webhook with `node scripts/setup-didit.mjs`, which uses
`KORA_PUBLIC_API_URL` (default `https://microsendr.xyz`).

`/health` on the API reports `"status": "degraded"` and lists the names of missing
required settings (never their values); the same list is logged at startup.

## Cut-over from the Compose host

1. Back up the Compose database (`pg_dump`) and restore it into Railway PostgreSQL.
2. Deploy `api` and `worker`, then check `/health` on the Railway domain.
3. Switch `netlify.toml` to the Railway domain and redeploy Netlify.
4. Stop the Compose `worker` before Railway's `worker` takes over, so two workers
   never poll the same database at once.
