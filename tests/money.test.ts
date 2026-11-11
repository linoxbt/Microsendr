import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAtomic } from '../apps/web/src/money.js';

test('amounts format the same in every locale, with two to six decimals and a dust marker', () => {
  assert.equal(formatAtomic('1234567890000000000000', 18), '1,234.56789');
  assert.equal(formatAtomic('120000000000000000000', 18), '120.00');
  assert.equal(formatAtomic('1500000', 6), '1.50');
  assert.equal(formatAtomic('0', 18), '0.00');
  assert.equal(formatAtomic('1', 18), '<0.000001');
  assert.equal(formatAtomic('1', 18, 8), '<0.00000001');
  assert.equal(formatAtomic(-2500000n, 6), '-2.50');
  assert.equal(formatAtomic('12345', 2), '123.45');
  assert.equal(formatAtomic('4210550000000000000000', 18, 8), '4,210.55');
});
