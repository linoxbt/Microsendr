-- Didit decisions are distinct from sandbox access and never grant money movement.
CREATE TABLE personal_didit_sessions (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  provider_session_id text UNIQUE,
  verification_url text,
  status text NOT NULL DEFAULT 'creating',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_didit_sessions_user ON personal_didit_sessions(personal_user_id,created_at DESC);
CREATE UNIQUE INDEX personal_didit_one_active ON personal_didit_sessions(personal_user_id)
  WHERE status IN ('creating','Not Started','In Progress','Awaiting User','In Review','Resubmitted');

CREATE TABLE personal_didit_events (
  event_id text PRIMARY KEY,
  provider_session_id text NOT NULL,
  status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
