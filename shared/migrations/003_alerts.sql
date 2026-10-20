-- 003: alert outbox. Any service writes here; the notifier delivers to Telegram.
-- A crashed trader can still have its last error delivered, and nothing is lost if Telegram is down.
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,            -- 'info' | 'warn' | 'error' | 'fatal'
  source      TEXT NOT NULL,            -- service name
  text        TEXT NOT NULL,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_alerts_unsent ON alerts(sent_at) WHERE sent_at IS NULL;
