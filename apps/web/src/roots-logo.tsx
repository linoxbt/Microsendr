/** Layered forward mark: two slanted bars and a rising accent, moving left to right. */
export function RootsMark() {
  return (
    <svg className="roots-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="roots-mark-tile" width="48" height="48" rx="13" />
      <path className="roots-mark-back" d="M9 36 18 12h7l-9 24Z" />
      <path className="roots-mark-front" d="M19 36 28 12h7l-9 24Z" />
      <path className="roots-mark-accent" d="M29 36l5-13.3 3.5 9.3L35.8 36Z" />
    </svg>
  );
}

export function RootsWordmark() {
  return (
    <span className="logo roots-wordmark" role="img" aria-label="Roots">
      <RootsMark />
      <span aria-hidden="true">roots</span>
    </span>
  );
}
