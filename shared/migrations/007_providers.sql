-- 007: which data provider delivered each trade, and a log of provider switches.

-- helius | drpc | ankr (the provider whose copy arrived first; arrival time is received_at).
-- NULL for trades saved before this column existed.
ALTER TABLE trades ADD COLUMN data_source TEXT;

-- One row every time a job (following, discovery, lookups, history) changes provider.
-- to_provider NULL = no usable provider for that job at that moment.
CREATE TABLE provider_events (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,
  job           TEXT NOT NULL,
  from_provider TEXT,
  to_provider   TEXT,
  reason        TEXT NOT NULL
);
CREATE INDEX idx_provider_events_ts ON provider_events(ts);
