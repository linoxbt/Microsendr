# Deploying the API and worker on Railway

Railway runs the same production image as `compose.public.yaml`, built from the
repository `Dockerfile`. CI builds that image and boots it on every push (the
`image` job in `.github/workflows/ci.yml`), so a green build means it starts.

## Services

| Service | Config file | Notes |
| --- | --- | --- |
| PostgreSQL | Railway PostgreSQL | Provides `DATABASE_URL` |
| `api` | `deploy/railway/api.json` | Runs migrations before each deploy, then the API; health check `/health`; give it a public domain |
| `worker` | `deploy/railway/worker.json` | Background queues; no public domain |

Create both app services from the GitHub repository and set each one's
config file path in its settings. Both deploy from `main`.

## Variables

Set on both `api` and `worker` (Railway variable references keep them in step):

- `DATABASE_URL`: reference the PostgreSQL service's `DATABASE_URL`
- `KORA_MODE=sandbox`
- `KORA_WEBHOOK_ENCRYPTION_KEY`, `KORA_PROVIDER_CALLBACK_SECRET`: independent random secrets
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (rotated, server-only)
- `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET`
- `KORA_MANAGED_TRANSFERS` and its limits, only if account wallet sends are wanted

`api` only:

- `HOST=0.0.0.0` (Railway supplies `PORT`)
- `KORA_CONSOLE_ORIGINS`: the exact Netlify HTTPS origin
- `KORA_AUTH_SECRET` (at least 32 bytes), `EMAIL_FROM`, `RESEND_API_KEY`
- `KORA_PROXY_SIGNING_SECRET`: same value as in Netlify
- `KORA_TRUSTED_PROXIES`: Railway's edge is the hop in front of the API. Leave the
  default; with the Netlify signing secret set, the client address comes from
  Netlify's signed header.

## Frontend

Point the Netlify proxy targets in `netlify.toml` (`/personal/api/*`, `/console/*`,
`/business/api/*`, `/v1/*`, `/openapi.json`, `/reference/*`) at the `api`
service's Railway domain, and register
`https://<api domain>/personal/api/webhooks/didit` in Didit.

## Cut-over from the Compose host

1. Back up the Compose database (`pg_dump`) and restore it into Railway PostgreSQL.
2. Deploy `api` and `worker`, then check `/health` on the Railway domain.
3. Switch `netlify.toml` to the Railway domain and redeploy Netlify.
4. Stop the Compose `worker` before Railway's `worker` takes over, so two workers
   never poll the same database at once.
