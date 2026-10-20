-- 004: alerts carry a kind + data so the notifier can word them for a human (the raw text stays
-- for the logs), and each service's run state gets its pid so the notifier can tell "crashed"
-- from "restarting" from "stopped on purpose".
ALTER TABLE alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'error';
ALTER TABLE alerts ADD COLUMN data TEXT;                 -- JSON
-- everything already queued was worded the old way: don't send it in the new format
UPDATE alerts SET sent_at = COALESCE(sent_at, ts);

CREATE TABLE service_runs (
  service     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,              -- 'running' | 'stopped' | 'crashed'
  pid         INTEGER,
  changed_at  INTEGER NOT NULL,
  detail      TEXT                        -- what it crashed on (first fatal log line), for the alert
);
INSERT INTO service_runs (service, state, changed_at)
  SELECT substr(key, 11), value, 0 FROM kv WHERE key LIKE 'run_state.%';
DELETE FROM kv WHERE key LIKE 'run_state.%' OR key LIKE 'crashes.%' OR key = 'notifier.restarts';
