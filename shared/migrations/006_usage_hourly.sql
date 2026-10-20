-- 006: Helius/PumpPortal data use per hour (stream_usage is per day), for "MB per hour" and
-- planning against the data budget.
CREATE TABLE stream_usage_hourly (
  hour        INTEGER NOT NULL,          -- start of the UTC hour, epoch ms
  source      TEXT NOT NULL,
  messages    INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, source)
) WITHOUT ROWID;
