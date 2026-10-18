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
otherwise uses Privy's app-scoped public JWKS). Enable Privy email
login and identity tokens, and allow the exact Netlify HTTPS origin in Privy.
In the Privy Dashboard, open **User management → Authentication → Advanced**
and turn on **Return user data in an identity token** for the Microsendr app.
This is required even when the email code succeeds: the API accepts only the
signed email claim in that identity token, tied to the Privy access token's
user ID. If the setting is off, the Personal page shows an account setup error
after email login. Refreshing or signing in again cannot resolve that setting.
After saving it, sign out of the incomplete Privy session and sign in again.
Without these settings, sign-in fails closed and the Developer Sandbox remains
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
