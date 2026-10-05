export const STATE_V1 = `-- nightshift runtime state (SQLite, WAL mode). Linear holds durable work state; everything here can be
-- rebuilt or discarded.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id     TEXT PRIMARY KEY,                -- ULID
  ts     TEXT NOT NULL,                   -- RFC 3339, UTC
  type   TEXT NOT NULL,
  issue  TEXT,                            -- Linear identifier, e.g. XXX-42
  run    TEXT REFERENCES runs(id),
  data   TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX IF NOT EXISTS events_issue ON events(issue, id);
CREATE INDEX IF NOT EXISTS events_run   ON events(run, id);
CREATE INDEX IF NOT EXISTS events_type  ON events(type, id);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,           -- ULID
  issue       TEXT NOT NULL,
  agent       TEXT NOT NULL,
  profile     TEXT NOT NULL,
  model       TEXT NOT NULL,              -- concrete model pinned at dispatch
  repository  TEXT NOT NULL,
  base_sha    TEXT NOT NULL,
  attempt     INTEGER NOT NULL CHECK (attempt >= 1),
  state       TEXT NOT NULL CHECK (state IN ('queued','starting','running','finishing','gating','reviewing','done','failed','stopped')),
  sandbox     TEXT,                       -- driver-specific id
  session     TEXT,                       -- OpenCode session id
  head_sha    TEXT,                       -- worker result commit, once fetched
  finish      TEXT CHECK (finish IS NULL OR json_valid(finish)),
  failure     TEXT,                       -- failure class once classified
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS runs_issue ON runs(issue, attempt);
CREATE INDEX IF NOT EXISTS runs_active ON runs(state) WHERE state NOT IN ('done','failed','stopped');

CREATE TABLE IF NOT EXISTS leases (
  issue       TEXT PRIMARY KEY,
  run         TEXT NOT NULL REFERENCES runs(id),
  holder      TEXT NOT NULL,              -- supervisor instance id
  expires_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS questions (
  comment     TEXT PRIMARY KEY,           -- Linear comment id of the question
  issue       TEXT NOT NULL,
  run         TEXT REFERENCES runs(id),
  asked_to    TEXT NOT NULL CHECK (asked_to IN ('lead','user')),
  asked_at    TEXT NOT NULL,
  answered_at TEXT,
  answer      TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS session_choices (
  project     TEXT NOT NULL,              -- Linear project id
  key         TEXT NOT NULL CHECK (key IN ('merge_mode','profile')),
  value       TEXT NOT NULL,
  chosen_at   TEXT NOT NULL,
  PRIMARY KEY (project, key)
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;                                 -- schema_version, instance id, last Linear sync cursor
`

export const STATE_V2 = `-- Compact snapshot of the managed Linear issues, rewritten by the supervisor each tick for read commands.
CREATE TABLE IF NOT EXISTS issues (
  identifier  TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  project     TEXT,
  stage       TEXT,
  lifecycle   TEXT,
  status      TEXT NOT NULL,
  blockers    TEXT NOT NULL CHECK (json_valid(blockers)),
  waiting     TEXT,
  updated_at  TEXT NOT NULL
) STRICT;
`
