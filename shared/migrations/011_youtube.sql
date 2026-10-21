-- 011: the brain studies YouTube (learner/youtube.py, nightly 00:20 UTC). It watches talks and
-- interviews of well-known traders (subtitles only, no AI, free), counts which trading rules they
-- talk about, and checks each rule against our own results. Videos never change what the bot
-- does; only the brain's exam on real results can. Nothing here is ever deleted.

-- Every video it ever looked at, with the full transcript.
CREATE TABLE yt_videos (
  id          TEXT PRIMARY KEY,          -- YouTube video id
  search      TEXT NOT NULL,             -- the search that found it
  trader      TEXT,                      -- the trader the search was about (NULL = a topic search)
  title       TEXT,
  channel     TEXT,
  duration_s  REAL,
  found_at    INTEGER NOT NULL,
  status      TEXT NOT NULL,             -- ok | no_subs | blocked (retried once) | refused (blocked twice: given up)
  words       INTEGER,                   -- transcript length
  transcript  TEXT,
  rules       TEXT                       -- JSON {rule: mentions}
) WITHOUT ROWID;

-- One row per trading rule: how often top traders talk about it, and what our data says.
CREATE TABLE yt_rules (
  key         TEXT PRIMARY KEY,
  words       TEXT NOT NULL,             -- "cut your losses fast"
  videos      INTEGER NOT NULL,          -- videos that mention it
  mentions    INTEGER NOT NULL,
  traders     TEXT NOT NULL,             -- JSON list of the traders who said it
  first_heard INTEGER,
  last_heard  INTEGER,
  verdict     TEXT NOT NULL,             -- agrees | disagrees | no_difference | not_enough_data | untested
  test        TEXT,                      -- how our data checks it, in words
  data        TEXT,                      -- JSON: the numbers behind the verdict
  checked_at  INTEGER NOT NULL
) WITHOUT ROWID;
