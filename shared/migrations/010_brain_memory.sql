-- 010: the learning brain's long-term memory. One row per thing it has ever noticed (a lesson, or
-- how its own skips turned out), updated every night and never deleted: when it first learned
-- it, how many nights in a row it held, and when it changed its mind. The nightly details stay in
-- brain_notes (kind 'observation' for every lesson every night, 'memory' when its mind changes).
CREATE TABLE brain_memory (
  key            TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,          -- lesson | own_skips
  words          TEXT NOT NULL,          -- plain English: "our trader bought under 0.1 SOL"
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,       -- last night it had enough data to judge it
  nights_seen    INTEGER NOT NULL,
  nights_same    INTEGER NOT NULL,       -- nights in a row its answer pointed the same way
  direction      INTEGER NOT NULL,       -- +1 = better results, -1 = worse, 0 = no real difference
  status         TEXT NOT NULL,          -- new | confirmed | changed_mind | fading | no_difference
  first_diff     REAL,                   -- what it thought the first time (points of follower ROI)
  diff           REAL,                   -- what it thinks now
  with_avg       REAL,
  with_n         INTEGER,
  without_avg    REAL,
  without_n      INTEGER,
  changed_at     INTEGER,                -- last time it changed its mind
  data           TEXT                    -- JSON
) WITHOUT ROWID;
