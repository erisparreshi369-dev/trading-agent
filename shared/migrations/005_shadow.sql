-- 005: shadow variants, hindsight outcomes of every signal, per-trade cost breakdown,
-- out-of-sample wallet checks, database size history.

-- Every signal under every shadow variant (config `shadow.variants`). Settled from the recorded
-- tape once the outcome is known; 'gap' = a collector outage overlapped, so it's left out.
CREATE TABLE shadow_trades (
  signal_id       INTEGER NOT NULL REFERENCES signals(id),
  variant         TEXT NOT NULL,
  mint            TEXT NOT NULL,
  leader_wallet   TEXT NOT NULL,
  signal_at       INTEGER NOT NULL,     -- leader's trade (received_at)
  status          TEXT NOT NULL,        -- 'filtered' | 'pending' | 'missed' | 'closed' | 'gap'
  reasons         TEXT,                 -- JSON: why the variant's filters rejected it / why the fill missed
  size_sol        REAL NOT NULL,
  entry_at        INTEGER,
  exit_at         INTEGER,
  exit_reason     TEXT,
  entry_price     REAL,
  exit_price      REAL,
  slippage_bps    REAL,                 -- our entry vs the leader's price
  pnl_sol         REAL,
  roi             REAL,
  platform_fee_sol REAL,                -- costs of the round trip (see sim/market.ts CostBreakdown)
  executor_fee_sol REAL,
  priority_fee_sol REAL,
  slippage_sol    REAL,
  rent_sol        REAL,
  delay_sol       REAL,                 -- price drift during the execution delay (not a fee; can be negative)
  settled_at      INTEGER,
  PRIMARY KEY (signal_id, variant)
);
CREATE INDEX idx_shadow_pending ON shadow_trades(signal_at) WHERE status = 'pending';
CREATE INDEX idx_shadow_variant_mint ON shadow_trades(variant, mint, signal_at);

-- What the market did after every signal, accepted or rejected: did each filter help?
-- Prices are spot (SOL per token) at the leader's trade + delay (= where we'd have bought) and after.
CREATE TABLE signal_outcomes (
  signal_id       INTEGER PRIMARY KEY REFERENCES signals(id),
  status          TEXT NOT NULL,        -- 'ok' | 'gap' | 'no_data'
  leader_price    REAL,
  entry_spot      REAL,                 -- leader's trade + execution delay
  price_1m        REAL,                 -- leader's trade + 1 / 5 / 30 minutes
  price_5m        REAL,
  price_30m       REAL,
  min_30m         REAL,
  max_30m         REAL,
  settled_at      INTEGER NOT NULL
);

ALTER TABLE paper_fills ADD COLUMN platform_fee_sol REAL;
ALTER TABLE paper_fills ADD COLUMN executor_fee_sol REAL;
ALTER TABLE paper_fills ADD COLUMN priority_fee_sol REAL;
ALTER TABLE paper_fills ADD COLUMN slippage_sol REAL;
ALTER TABLE paper_fills ADD COLUMN rent_sol REAL;
ALTER TABLE paper_fills ADD COLUMN delay_sol REAL;

-- Out-of-sample check, every scoring run: wallets scored on [lookback start, split) and measured on [split, run).
CREATE TABLE wallet_oos (
  run_at          INTEGER NOT NULL,
  wallet          TEXT NOT NULL,
  split_at        INTEGER NOT NULL,
  is_trades       INTEGER NOT NULL,     -- in-sample simulated follower trades
  is_roi          REAL,
  is_score        REAL,
  is_eligible     INTEGER NOT NULL,
  is_rank         INTEGER,              -- rank among eligible wallets in-sample (1 = best)
  oos_trades      INTEGER NOT NULL,
  oos_roi         REAL,
  oos_pnl_sol     REAL,
  PRIMARY KEY (run_at, wallet)
) WITHOUT ROWID;

-- Database file size, sampled by the collector: growth per day.
CREATE TABLE db_size_log (
  day             TEXT PRIMARY KEY,     -- YYYY-MM-DD (UTC)
  bytes           INTEGER NOT NULL,     -- latest sample that day (db + wal)
  ts              INTEGER NOT NULL
);
