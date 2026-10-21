/** The mark is the plain lowercase letter m, set in the app typeface on a rounded tile. */
export function MicrosendrMark() {
  return (
    <svg className="microsendr-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="10" fill="currentColor" />
      <text x="20" y="28.5" textAnchor="middle" className="microsendr-mark-letter">
        m
      </text>
    </svg>
  );
}

/** The wordmark is the name set in type, with no separate symbol. */
export function MicrosendrWordmark() {
  return (
    <span className="logo microsendr-wordmark" role="img" aria-label="Microsendr">
      <span aria-hidden="true">microsendr</span>
    </span>
  );
}
