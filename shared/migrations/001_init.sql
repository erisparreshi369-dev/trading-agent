-- 001: core market data collected by the collector.
-- Conventions: timestamps are unix epoch milliseconds (INTEGER).
-- SOL amounts are lamports, token amounts are raw units (pump.fun tokens have 6 decimals).

CREATE TABLE tokens (
  mint                TEXT PRIMARY KEY,
  name                TEXT,
  symbol              TEXT,
  uri                 TEXT,
  creator             TEXT,              -- dev wallet
  bonding_curve       TEXT,
  token_program       TEXT,
  quote_mint          TEXT,              -- NULL/So111... = SOL-quoted
  created_slot        INTEGER,
  created_at          INTEGER NOT NULL,  -- on-chain timestamp if known, else first-seen
  first_seen_at       INTEGER NOT NULL,
  create_signature    TEXT,
  initial_buy_lamports INTEGER,          -- dev's buy in the create tx (PumpPortal)
  initial_buy_tokens  INTEGER,
  is_mayhem_mode      INTEGER,
  completed_at        INTEGER,           -- bonding curve filled
  migrated_at         INTEGER,
  migration_pool      TEXT,
  source              TEXT NOT NULL      -- 'helius' | 'pumpportal'
);
CREATE INDEX idx_tokens_created_at ON tokens(created_at);
CREATE INDEX idx_tokens_creator ON tokens(creator);

-- Every pump.fun bonding-curve trade seen on the firehose.
CREATE TABLE trades (
  id                  INTEGER PRIMARY KEY,
  signature           TEXT NOT NULL,
  ev_index            INTEGER NOT NULL,  -- event index within the tx (one tx can hold several trades)
  slot                INTEGER,
  block_time          INTEGER,           -- on-chain timestamp (ms)
  received_at         INTEGER NOT NULL,  -- local receive time (ms)
  mint                TEXT NOT NULL,
  wallet              TEXT NOT NULL,
  is_buy              INTEGER NOT NULL,
  sol_lamports        INTEGER NOT NULL,
  token_amount        INTEGER NOT NULL,
  v_sol_reserves      INTEGER,
  v_token_reserves    INTEGER,
  real_sol_reserves   INTEGER,
  real_token_reserves INTEGER,
  fee_lamports        INTEGER,
  creator_fee_lamports INTEGER,
  price_sol           REAL,              -- SOL per whole token after this trade
  is_dev              INTEGER NOT NULL DEFAULT 0,
  ix_name             TEXT,
  source              TEXT NOT NULL,
  UNIQUE(signature, ev_index)
);
CREATE INDEX idx_trades_mint_time ON trades(mint, block_time);
CREATE INDEX idx_trades_wallet_time ON trades(wallet, block_time);
CREATE INDEX idx_trades_received ON trades(received_at);

-- OHLCV bars per token: 5s for the first hour, 60s after (configurable).
CREATE TABLE token_bars (
  mint            TEXT NOT NULL,
  bucket_ms       INTEGER NOT NULL,      -- bar width
  ts              INTEGER NOT NULL,      -- bar start
  open            REAL NOT NULL,
  high            REAL NOT NULL,
  low             REAL NOT NULL,
  close           REAL NOT NULL,
  volume_lamports INTEGER NOT NULL,
  buys            INTEGER NOT NULL,
  sells           INTEGER NOT NULL,
  unique_traders  INTEGER NOT NULL,
  v_sol_reserves  INTEGER,
  holders         INTEGER,               -- wallets with positive balance (trade-derived)
  top10_pct       REAL,                  -- % of total supply held by top 10 wallets (trade-derived)
  dev_pct         REAL,                  -- % of total supply held by the dev wallet
  PRIMARY KEY (mint, bucket_ms, ts)
) WITHOUT ROWID;

-- Net position per wallet per token, derived from trades (ignores plain transfers).
CREATE TABLE token_holders (
  mint        TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  balance     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (mint, wallet)
) WITHOUT ROWID;

-- On-chain holder check via RPC (catches transfers / bundled wallets the trade view misses).
CREATE TABLE holder_snapshots (
  mint            TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  age_s           INTEGER NOT NULL,
  top_accounts    TEXT NOT NULL,         -- JSON [[address, uiAmount], ...] (largest 20 token accounts)
  top10_pct       REAL,                  -- % of total supply, excluding the bonding curve account
  PRIMARY KEY (mint, ts)
) WITHOUT ROWID;

-- Wallets we follow (populated by wallet scoring in Phase 2, or seeded manually).
CREATE TABLE tracked_wallets (
  wallet      TEXT PRIMARY KEY,
  label       TEXT,
  added_at    INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL              -- 'manual' | 'scoring'
);

-- Periods where a stream was down; the learner uses this to drop affected windows.
CREATE TABLE collector_gaps (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  reason      TEXT
);

-- Liveness for every service; the Phase 3 watchdog alerts if one goes quiet.
CREATE TABLE service_heartbeats (
  service     TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  pid         INTEGER,
  info        TEXT                       -- JSON stats
);

-- Daily stream usage, so data costs are visible before they surprise anyone.
CREATE TABLE stream_usage (
  day         TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  source      TEXT NOT NULL,
  messages    INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
) WITHOUT ROWID;

-- Dev behaviour is derived from trades (is_dev=1) plus tokens.creator.
CREATE VIEW dev_trades AS
  SELECT t.*, k.created_at AS token_created_at, (t.block_time - k.created_at) AS ms_after_create
  FROM trades t JOIN tokens k ON k.mint = t.mint
  WHERE t.is_dev = 1;
