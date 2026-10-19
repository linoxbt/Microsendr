/** An open, geometric M: the two forward strokes are Microsendr's signature. */
export const microsendrMarkPath = 'M2 30 8 2h5l5 15L23 2h5l6 28h-6l-3-17-5 14h-4l-5-14-3 17Z';

export function MicrosendrMark() {
  return (
    <svg viewBox="0 0 36 32" aria-hidden="true" focusable="false">
      <path d={microsendrMarkPath} fill="currentColor" />
    </svg>
  );
}

export function MicrosendrWordmark() {
  return (
    <span className="logo microsendr-wordmark" role="img" aria-label="Microsendr">
      <MicrosendrMark />
      <span aria-hidden="true">ICROSENDR</span>
    </span>
  );
}
