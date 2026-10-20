# Microsendr public sandbox deployment

The frontend is published at `https://kora-sandbox-linoxbt.netlify.app` and
proxies API paths to `https://kora-api.13-140-188-185.sslip.io`. The API, worker,
and PostgreSQL run on the Microsendr host with `compose.public.yaml`. The database is
stored in the `kora-public-postgres` Docker volume. Fiat providers remain in
test mode. Linked native QIEV3 wallets use QIE Mainnet and can move real assets.

## Host configuration

Create an ignored, mode `600` `.env.public` at the repository root. Set
`KORA_PUBLIC_DB_PASSWORD` to a unique random password; set
`KORA_WEBHOOK_ENCRYPTION_KEY` and `KORA_PROVIDER_CALLBACK_SECRET` to independent
random secrets. Set `KORA_CONSOLE_ORIGINS` to the exact Netlify HTTPS origin.
Keep `KORA_MODE=sandbox`, and leave `PAYSTACK_SECRET_KEY` blank for the simulator.
Never commit this file. The Compose file supplies the internal `DATABASE_URL`.
Personal registration and login use email and password with a server-side scrypt
hash. Configure `SMTP_*` and `KORA_AUTH_SECRET` for email verification and
password recovery. A wallet is optional at signup. Later, a user can link an
existing QIE-compatible EVM wallet by signing an account-specific challenge.
The wallet provider holds the signing key; the application never receives it.
Legacy Privy authentication endpoints remain for older accounts but are not used
by new Personal registration.

For Personal identity checks, set `DIDIT_API_KEY` and `DIDIT_WEBHOOK_SECRET` in
`.env.public`. Register `https://kora-api.13-140-188-185.sslip.io/personal/api/webhooks/didit`
as the HTTPS webhook destination in Didit. The selected Free KYC workflow ID is
configured per session in the API code. Both secrets are required before the
verification button appears; the signed webhook is the only source of approval.
Didit approval never turns on real payments in this sandbox.

The Compose `proxy` service runs Caddy with this host entry:

```caddyfile
kora-api.13-140-188-185.sslip.io {
    encode gzip
    reverse_proxy api:4312
}
```

The IP-dependent `sslip.io` hostname must be changed in both
`deploy/caddy/Caddyfile` and `netlify.toml` if the host IP changes. Caddy owns
ports 80 and 443, while Docker binds API port 4312 to loopback only. Its
certificate state persists in the `kora-public-caddy-data` volume.

## Start and update

```sh
docker compose --env-file .env.public -f compose.public.yaml up -d --build
docker compose --env-file .env.public -f compose.public.yaml ps
curl -fsS https://kora-api.13-140-188-185.sslip.io/health
```

The API applies database migrations before it starts. The worker starts after
the API is healthy. Deploy the frontend with the Netlify CLI or the connected
Git integration; the root `netlify.toml` provides the build command, publish
directory, and API proxy rules. Check `/console/session` on the Netlify origin
to confirm the proxy is active, then create a sandbox workspace in the browser.

Back up the `kora-public-postgres` volume before replacing the host or changing
database versions. The volume persists across Compose restarts and image updates,
but not across host loss.
