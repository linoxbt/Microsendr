# @roots/sdk

TypeScript client for the authenticated Roots REST API. This workspace package targets Node.js 22+ and modern browsers; it is not published to npm. Run `pnpm sdk:build` at the repository root to emit ESM and types.

```ts
import { Roots, RootsError } from '@roots/sdk';

const client = new Roots({
  baseUrl: 'http://127.0.0.1:4310',
  apiKey: process.env.ROOTS_API_KEY,
});

try {
  const balances = await client.listBalances();
  console.log(balances);
} catch (error) {
  if (error instanceof RootsError) {
    console.error(error.code, error.status, error.requestId);
  }
  throw error;
}
```

Amounts are integer strings. Use a stable idempotency key for mutations and reuse it with the same body after an uncertain result. The client does not automatically retry mutations. Server API keys never belong in browser bundles; a console session can instead use a CSRF token.

Verify signed webhooks with the unmodified raw body and deduplicate by event ID:

```ts
import { verifyWebhook } from '@roots/sdk/webhooks';

if (!verifyWebhook(rawBody, signatureHeader, endpointSecret)) {
  throw new Error('Invalid webhook signature');
}
```

Generated `components`, `operations` and `paths` types map to [the OpenAPI contract](../../specs/openapi/roots.json). Historical Business and Stellar methods remain for sandbox modules. See [current settlement status](../../docs/roots-settlement-status.md) before integrating money movement.
