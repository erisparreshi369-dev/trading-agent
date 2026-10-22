-- 013: the mistake checker (trader/src/checker): every time the paper trader broke one of its own
-- rules (bought what its filters reject, sold late, held too long, money that doesn't add up...).
-- One row per problem, never re-reported. Rows found on the checker's first run are history:
-- shown on the dashboard, never sent to Telegram.
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,            -- "<check>:<position id>": a problem is found once
  found_at INTEGER NOT NULL,           -- ms
  position_id INTEGER,                 -- NULL for account-wide problems
  kind TEXT NOT NULL,                  -- see checker/checks.ts KINDS
  text TEXT NOT NULL,                  -- plain-words description
  data TEXT,                           -- JSON facts behind it
  alerted INTEGER NOT NULL DEFAULT 0   -- 1 = queued for Telegram, 0 = history from the first run
);
CREATE INDEX IF NOT EXISTS mistakes_found ON mistakes(found_at);
