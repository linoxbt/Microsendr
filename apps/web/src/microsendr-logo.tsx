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
