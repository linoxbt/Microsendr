import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiditWebhook } from '../services/api/src/didit.js';

test('Didit webhook accepts canonical signed body within five minutes', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const body = { timestamp: now / 1000, status: 'Approved', decision: { z: ['España', { b: 2, a: 1 }], a: true } };
  const canonical = JSON.stringify({ decision: { a: true, z: ['España', { a: 1, b: 2 }] }, status: 'Approved', timestamp: now / 1000 });
  const secret = 'test-signing-secret';
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  assert.equal(verifyDiditWebhook(body, signature, secret, now), true);
  assert.equal(verifyDiditWebhook(body, signature, secret, now + 301_000), false);
  assert.equal(verifyDiditWebhook({ ...body, status: 'Declined' }, signature, secret, now), false);
  assert.equal(verifyDiditWebhook(body, '0'.repeat(64), secret, now), false);
  assert.equal(verifyDiditWebhook(body, signature, '', now), false);
});
