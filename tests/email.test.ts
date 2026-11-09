import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeMessage, mailer } from '../services/api/src/email.js';

const keys = ['EMAIL_FROM', 'SMTP_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT'] as const;
async function withEnv(values: Partial<Record<(typeof keys)[number], string>>, run: () => Promise<void>) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}

test('Resend delivery sends the code from the configured sender, as text and HTML', async () => {
  await withEnv({ EMAIL_FROM: 'Microsendr <codes@example.test>', RESEND_API_KEY: 're_test_key' }, async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const send = mailer(async (url, init) => { sent.push({ url: String(url), init }); return Response.json({ id: 'email_1' }); });
    assert.ok(send);
    await send('person@example.test', '042917');
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal((sent[0].init?.headers as Record<string, string>).authorization, 'Bearer re_test_key');
    const body = JSON.parse(String(sent[0].init?.body));
    assert.deepEqual(body.to, ['person@example.test']);
    assert.equal(body.from, 'Microsendr <codes@example.test>');
    assert.equal(body.subject, '042917 is your Microsendr code');
    assert.match(body.text, /042917/);
    assert.match(body.html, /042917/);
  });
});

test('a provider rejection is an error, and delivery is off without a sender', async () => {
  await withEnv({ EMAIL_FROM: 'codes@example.test', RESEND_API_KEY: 're_test_key' }, async () => {
    const send = mailer(async () => new Response('{}', { status: 422 }));
    await assert.rejects(send!('person@example.test', '123456'), /email_provider_status_422/);
  });
  await withEnv({ RESEND_API_KEY: 're_test_key' }, async () => assert.equal(mailer(), undefined));
  await withEnv({ SMTP_FROM: 'codes@example.test', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' }, async () => assert.equal(typeof mailer(), 'function'));
  await withEnv({ SMTP_FROM: 'codes@example.test' }, async () => assert.equal(mailer(), undefined));
});

test('codes are six digits and never injected into HTML', () => {
  assert.throws(() => codeMessage('<b>1</b>'));
  const message = codeMessage('000001');
  assert.equal(message.subject, '000001 is your Microsendr code');
  assert.doesNotMatch(message.html, /<script/i);
});
