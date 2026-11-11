/**
 * Formats an on-chain amount (integer atomic units) for display: en-US grouping in
 * every browser locale, at least two and at most `maxFraction` decimals, and a floor
 * marker instead of "0.00" for amounts too small to show.
 */
export function formatAtomic(atomic: string | bigint, decimals: number, maxFraction = 6): string {
  const value = BigInt(atomic);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = decimals ? (abs % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '') : '';
  if (abs > 0n && whole === 0n && !fraction) return `${sign}<0.${'0'.repeat(Math.max(0, maxFraction - 1))}1`;
  return `${sign}${whole.toLocaleString('en-US')}.${fraction.padEnd(2, '0')}`;
}
