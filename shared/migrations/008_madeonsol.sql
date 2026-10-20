-- 008: MadeOnSol, an optional helper used only by the daily intel job (never while deciding a
-- trade). Every row records its source and when we fetched it: a decision may only use rows
-- fetched before it (no future information).

-- A creator's launch record as MadeOnSol saw it when we asked.
CREATE TABLE creator_reputation (
  creator           TEXT NOT NULL,
  fetched_at        INTEGER NOT NULL,
  tier              TEXT,
  total_deployed    INTEGER,
  total_bonded      INTEGER,               -- launches that filled their bonding curve
  recent_bond_rate  REAL,
  history_status    TEXT,
  source            TEXT NOT NULL DEFAULT 'madeonsol',
  PRIMARY KEY (creator, fetched_at)
) WITHOUT ROWID;

-- Per coin: early-buyer quality and launch facts (fetched after the fact: for analysis, and for
-- decisions only when fetched before them).
CREATE TABLE token_intel (
  mint                    TEXT NOT NULL,
  fetched_at              INTEGER NOT NULL,
  creator                 TEXT,
  early_buyer_score       REAL,            -- 0-100
  early_buyer_confidence  TEXT,
  early_buyer_signal      TEXT,
  bundle_buyers           INTEGER,
  launch_cohort_size      INTEGER,
  is_blacklisted          INTEGER,
  source                  TEXT NOT NULL DEFAULT 'madeonsol',
  PRIMARY KEY (mint, fetched_at)
) WITHOUT ROWID;

-- Ranked wallets from MadeOnSol's lists: candidates for OUR scorer, never followed for being listed.
CREATE TABLE candidate_wallets (
  wallet      TEXT NOT NULL,
  list        TEXT NOT NULL,                 -- 'alpha' | 'kol'
  fetched_at  INTEGER NOT NULL,
  rank        INTEGER,
  stats       TEXT,                          -- JSON, as listed
  source      TEXT NOT NULL DEFAULT 'madeonsol',
  PRIMARY KEY (wallet, list, fetched_at)
) WITHOUT ROWID;

-- Candidates whose trades the collector watches (one trial each), so scoring has full data for them.
CREATE TABLE candidate_watch (
  wallet  TEXT PRIMARY KEY,
  since   INTEGER NOT NULL,
  until   INTEGER NOT NULL,
  source  TEXT NOT NULL DEFAULT 'madeonsol'
);

-- Every request to a helper API: the daily budget, the dashboard panel, debugging.
CREATE TABLE intel_requests (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  provider     TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  status       INTEGER,                      -- HTTP status; NULL = no answer (timeout, network)
  ms           INTEGER,
  items        INTEGER,
  error        TEXT,                         -- secrets scrubbed
  remote_used  INTEGER                       -- the provider's own count for today, when it says
);
CREATE INDEX idx_intel_requests_ts ON intel_requests(provider, ts);
