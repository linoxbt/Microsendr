/** Two connected ribbons form an M and point toward the next payment. */
export const microsendrMarkPath =
  'M4 29 10 7c.4-1.4 2.2-1.7 3-.5l6.9 11L27 6.5c.8-1.2 2.6-.9 3 .5l6 22h-6.2l-3.7-13.7-4.7 7.4a2 2 0 0 1-3.4 0l-4.7-7.4L9.6 29Z';

export function MicrosendrMark() {
  return (
    <svg viewBox="0 0 40 36" aria-hidden="true" focusable="false">
      <path d={microsendrMarkPath} fill="currentColor" />
      <path d="M29.8 29h6.4l-4.6 4.1h-6.4Z" fill="currentColor" opacity=".62" />
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
