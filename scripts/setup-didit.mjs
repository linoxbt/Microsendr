// Register or reuse the exact Microsendr webhook destination. Never prints secrets.
// Run after setting DIDIT_API_KEY in .env.local. .env.public is ignored by git.
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });
const key = process.env.DIDIT_API_KEY;
if (!key) throw new Error('Configure DIDIT_API_KEY in .env.local first');
const base = 'https://verification.didit.me/v3';
const url = 'https://kora-api.13-140-188-185.sslip.io/personal/api/webhooks/didit';
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Didit configuration request returned HTTP ${response.status}`);
  return response.json();
}
const workflows = await api('/workflows/');
const list = Array.isArray(workflows) ? workflows : (workflows.results ?? []);
const expected = '5045382d-f318-4cfe-8439-7b3d097adf63';
if (!list.some((w) => w.workflow_id === expected || w.uuid === expected || w.id === expected))
  throw new Error('The configured KYC workflow was not found in this application');
const destinations = await api('/webhook/destinations/');
const existing = destinations.find((d) => d.url === url);
const destination = existing
  ? await api(`/webhook/destinations/${existing.uuid}/`)
  : await api('/webhook/destinations/', 'POST', {
      label: 'Microsendr Personal identity',
      url,
      webhook_version: 'v3',
      subscribed_events: ['status.updated'],
      enabled: true,
    });
if (!destination.secret_shared_key) throw new Error('Didit did not return a signing secret');
if (
  !destination.enabled ||
  destination.webhook_version !== 'v3' ||
  !destination.subscribed_events?.includes('status.updated')
)
  throw new Error('Existing destination requires review; it was not modified');
for (const file of ['.env.local', '.env.public']) {
  const original = readFileSync(file, 'utf8');
  const values = { DIDIT_API_KEY: key, DIDIT_WEBHOOK_SECRET: destination.secret_shared_key };
  const clean = original
    .split('\n')
    .filter((line) => !Object.keys(values).some((name) => line.startsWith(name + '=')))
    .join('\n');
  writeFileSync(
    file,
    clean +
      '\n' +
      Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') +
      '\n',
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
}
console.log(
  'Didit workflow validated; webhook configured; secrets saved only in ignored server environment files.',
);
