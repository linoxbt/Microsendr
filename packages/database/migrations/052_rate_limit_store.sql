-- Shared request counters for the general rate limit when the API runs on more than one
-- instance (KORA_RATE_LIMIT_STORE=postgres). Unlogged: counters are disposable, and
-- skipping the write-ahead log keeps each hit cheap.
CREATE UNLOGGED TABLE rate_limit_hits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  window_ends timestamptz NOT NULL
);
CREATE INDEX rate_limit_hits_window ON rate_limit_hits(window_ends);
