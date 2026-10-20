-- 002: PumpSwap trades, wallet scoring, signals, paper trading, risk state.

-- Trades now come from two venues: the bonding curve and, after migration, the PumpSwap pool.
-- For 'amm' rows, v_sol_reserves / v_token_reserves hold the pool's quote/base reserves.
-- Both venues: buy cost = sol_lamports + fee_lamports + creator_fee_lamports,
--              sell proceeds = sol_lamports - fee_lamports - creator_fee_lamports.
ALTER TABLE trades ADD COLUMN venue TEXT NOT NULL DEFAULT 'curve';
-- "market state at time t" lookups for fills and the copy simulation
CREATE INDEX idx_trades_mint_recv ON trades(mint, received_at);

CREATE TABLE pools (
  pool        TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  quote_mint  TEXT,
  created_at  INTEGER NOT NULL,
  source      TEXT NOT NULL
);
CREATE INDEX idx_pools_mint ON pools(mint);
CREATE INDEX idx_pools_created ON pools(created_at);

-- One row per wallet per scoring run (history kept for the learner and for debugging).
CREATE TABLE wallet_scores (
  run_at            INTEGER NOT NULL,
  wallet            TEXT NOT NULL,
  tokens_traded     INTEGER NOT NULL,
  closed_positions  INTEGER NOT NULL,
  realized_pnl_sol  REAL NOT NULL,     -- the wallet's own result, after pump fees
  win_rate          REAL,
  median_hold_s     REAL,
  avg_buy_sol       REAL,
  snipe_frac        REAL,              -- share of entries within the launch's first slots
  snipe_pnl_frac    REAL,              -- share of positive PnL that came from those entries
  copy_trades       INTEGER NOT NULL,  -- entries we could have followed
  copy_missed       INTEGER NOT NULL,  -- entries where our delayed order would have hit the slippage limit
  copy_pnl_sol      REAL,              -- simulated follower PnL (delay, slippage, all costs)
  copy_roi          REAL,              -- mean simulated follower ROI per trade, each capped at scoring.copy_roi_cap
  copy_win_rate     REAL,
  last_trade_at     INTEGER,
  score             REAL,
  eligible          INTEGER NOT NULL,
  reject_reason     TEXT,
  PRIMARY KEY (run_at, wallet)
) WITHOUT ROWID;
CREATE INDEX idx_wallet_scores_wallet ON wallet_scores(wallet, run_at);

ALTER TABLE tracked_wallets ADD COLUMN score REAL;
ALTER TABLE tracked_wallets ADD COLUMN last_scored_at INTEGER;
ALTER TABLE tracked_wallets ADD COLUMN deactivated_at INTEGER;
ALTER TABLE tracked_wallets ADD COLUMN deactivated_reason TEXT;

-- Every decision the signal engine makes, accepted or not, with its reasons.
CREATE TABLE signals (
  id              INTEGER PRIMARY KEY,
  ts              INTEGER NOT NULL,
  wallet          TEXT NOT NULL,
  mint            TEXT NOT NULL,
  leader_trade_id INTEGER NOT NULL,
  venue           TEXT NOT NULL,
  score           REAL,
  decision        TEXT NOT NULL,        -- 'enter' | 'reject' | 'risk_block'
  reasons         TEXT NOT NULL,        -- JSON array of strings
  features        TEXT NOT NULL         -- JSON snapshot of everything the filters looked at
);
CREATE INDEX idx_signals_ts ON signals(ts);
CREATE INDEX idx_signals_mint ON signals(mint);

CREATE TABLE paper_positions (
  id              INTEGER PRIMARY KEY,
  signal_id       INTEGER NOT NULL REFERENCES signals(id),
  mint            TEXT NOT NULL,
  leader_wallet   TEXT NOT NULL,
  status          TEXT NOT NULL,        -- 'pending' | 'open' | 'closed' | 'failed'
  size_sol        REAL NOT NULL,        -- reserved from the balance when the signal was accepted
  leader_price    REAL NOT NULL,        -- spot price right after the leader's buy
  entry_due_at    INTEGER NOT NULL,     -- leader's trade + execution delay
  exit_due_at     INTEGER,              -- set when an exit is triggered
  exit_trigger    TEXT,
  leader_exited_at INTEGER,
  opened_at       INTEGER,
  cost_sol        REAL,                 -- everything spent: SOL in + fees + priority fee + rent
  tokens          INTEGER,              -- raw units held
  entry_price     REAL,                 -- SOL per whole token, effective
  last_price      REAL,
  last_price_at   INTEGER,
  peak_price      REAL,
  closed_at       INTEGER,
  exit_reason     TEXT,
  proceeds_sol    REAL,
  pnl_sol         REAL
);
CREATE INDEX idx_paper_positions_status ON paper_positions(status);

CREATE TABLE paper_fills (
  id              INTEGER PRIMARY KEY,
  position_id     INTEGER NOT NULL REFERENCES paper_positions(id),
  ts              INTEGER NOT NULL,
  side            TEXT NOT NULL,        -- 'buy' | 'sell'
  venue           TEXT NOT NULL,
  ok              INTEGER NOT NULL,
  sol             REAL,                 -- SOL spent (buy, incl. all costs) or received (sell, net)
  tokens          INTEGER,
  price           REAL,                 -- effective SOL per whole token
  ref_price       REAL,                 -- price the leader got / price at decision time
  slippage_bps    REAL,
  delay_ms        INTEGER,
  fees_sol        REAL,
  reason          TEXT
);
CREATE INDEX idx_paper_fills_pos ON paper_fills(position_id);

-- Single-row state tables.
CREATE TABLE paper_account (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  balance_sol     REAL NOT NULL,        -- free SOL (excludes capital in open positions)
  start_balance   REAL NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE risk_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch     INTEGER NOT NULL DEFAULT 0,
  kill_reason     TEXT,
  kill_at         INTEGER,
  day             TEXT,                 -- UTC day the fields below refer to
  day_start_equity REAL,
  halted_day      TEXT                  -- set when the daily loss cap trips
);
INSERT INTO risk_state (id) VALUES (1);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Addresses the collector should follow with targeted subscriptions (beyond tracked wallets).
-- Written by the collector (tokens tracked wallets trade, migrated pools) and the trader (positions).
CREATE TABLE watchlist (
  address     TEXT PRIMARY KEY,         -- bonding curve, pool, or wallet
  kind        TEXT NOT NULL,            -- 'curve' | 'pool' | 'wallet'
  mint        TEXT,
  until       INTEGER NOT NULL,
  priority    INTEGER NOT NULL,         -- lower = kept first when over the subscription cap
  reason      TEXT
);
CREATE INDEX idx_watchlist_until ON watchlist(until);
