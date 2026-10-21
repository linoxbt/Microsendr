import { useId } from 'react';

/** Monogram: an M whose final stroke rises into a send arrow, on a steel-blue tile. */
const strokes = ['M12 35V14l10 11 9.5-10.5', 'M25.5 12.5H35.5V22.5'];

export function MicrosendrMark() {
  const gradient = useId();
  return (
    <svg className="microsendr-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#1f4f78" />
          <stop offset="1" stopColor="#4f93c8" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${gradient})`} />
      {strokes.map((d) => (
        <path key={d} d={d} fill="none" stroke="#f7f3e9" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
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
