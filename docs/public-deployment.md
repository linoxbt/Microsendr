# Microsendr public sandbox deployment

The frontend is published at `https://kora-sandbox-linoxbt.netlify.app` and
proxies API paths to `https://kora-api.13-140-188-185.sslip.io`. The API, worker,
and PostgreSQL run on the Microsendr host with `compose.public.yaml`. The database is
stored in the `kora-public-postgres` Docker volume. All funds and providers in
this deployment are simulated.

## Host configuration

Create an ignored, mode `600` `.env.public` at the repository root. Set
`KORA_PUBLIC_DB_PASSWORD` to a unique random password; set
`KORA_WEBHOOK_ENCRYPTION_KEY` and `KORA_PROVIDER_CALLBACK_SECRET` to independent
random secrets. Set `KORA_CONSOLE_ORIGINS` to the exact Netlify HTTPS origin.
Keep `KORA_MODE=sandbox`, and leave `PAYSTACK_SECRET_KEY` blank for the simulator.
Never commit this file. The Compose file supplies the internal `DATABASE_URL`.
Personal sign-in uses Privy. Set `PRIVY_APP_ID`; optionally set
`PRIVY_CLIENT_ID` and a pinned server-side `PRIVY_VERIFICATION_KEY` (the API
otherwise uses Privy's app-scoped public JWKS). Enable Privy email login and
allow the exact Netlify HTTPS origin in Privy. The API verifies the Privy
access token, then obtains the verified email from a matching signed identity
token when enabled. If identity tokens are unavailable, it uses Privy's
authenticated current-user endpoint with that access token and requires a
matching user ID and verified email timestamp. No browser-supplied email can
create or claim a Personal account. Privy's current-user endpoint is used by
the installed web SDK; monitor this fallback when updating the SDK.
If Privy's current-user lookup is unavailable, the verified Privy user ID can
still create a Personal sandbox account without an email. Email-based receipt
and Paystack test collection stay unavailable until a later login links a
server-verified email. A later signed identity token or successful current-user
lookup links that email to the same account.
Without Privy email login and an allowed origin, sign-in fails closed and the Developer Sandbox remains
available. Legacy email-code sessions can continue only when the optional
SMTP settings are configured; the Personal sign-in page uses Privy.

For Personal identity checks, set `DIDIT_API_KEY` and `DIDIT_WEBHOOK_SECRET` in
`.env.public`. Register `https://kora-api.13-140-188-185.sslip.io/personal/api/webhooks/didit`
as the HTTPS webhook destination in Didit. The selected Free KYC workflow ID is
configured per session in the API code. Both secrets are required before the
verification button appears; the signed webhook is the only source of approval.
Didit approval never turns on real payments in this sandbox.

The HTTPS reverse proxy needs a host entry equivalent to:

```caddyfile
kora-api.13-140-188-185.sslip.io {
    encode gzip
    reverse_proxy 127.0.0.1:4312
}
```

The IP-dependent `sslip.io` hostname must be changed in both Caddy and
`netlify.toml` if the host IP changes. Docker binds port 4312 to loopback only.

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
