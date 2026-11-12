import { useId } from 'react';

/** Layered forward mark: two slanted bars and a rising accent, moving left to right. */
export function MicrosendrMark() {
  return (
    <svg className="microsendr-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="microsendr-mark-tile" width="48" height="48" rx="13" />
      <path className="microsendr-mark-back" d="M9 36 18 12h7l-9 24Z" />
      <path className="microsendr-mark-front" d="M19 36 28 12h7l-9 24Z" />
      <path className="microsendr-mark-accent" d="M29 36l5-13.3 3.5 9.3L35.8 36Z" />
    </svg>
  );
}

export function MicrosendrWordmark() {
  return (
    <span className="logo microsendr-wordmark" role="img" aria-label="Microsendr">
      <MicrosendrMark />
      <span aria-hidden="true">microsendr</span>
    </span>
  );
}

/**
 * The mark's bars at card scale: a quiet watermark for brand surfaces. Each bar
 * fades toward the card edge so text over it stays readable.
 */
export function MicrosendrWatermark({ className = '' }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`microsendr-watermark ${className}`} viewBox="8 11 31 26" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0" stopColor="#7fb3dd" stopOpacity="0.02" />
          <stop offset="1" stopColor="#7fb3dd" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0" stopColor="#4f93c8" stopOpacity="0.04" />
          <stop offset="1" stopColor="#7fb3dd" stopOpacity="0.26" />
        </linearGradient>
      </defs>
      <path d="M9 36 18 12h7l-9 24Z" fill={`url(#${id}b)`} />
      <path d="M19 36 28 12h7l-9 24Z" fill={`url(#${id}f)`} />
      <path d="M29 36l5-13.3 3.5 9.3L35.8 36Z" fill="#f7f3e9" fillOpacity="0.12" />
    </svg>
  );
}
