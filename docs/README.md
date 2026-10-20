# pump.fun copy-trading agent

Tracks pump.fun wallets, scores them by what a *follower* would have made, and copies the best
in **paper mode**. Live trading is off unless the owner sets `LIVE_TRADING=true` in `.env`
(and even then the trader refuses to start until the Phase 5 executor exists).

| Phase | Scope | State |
|---|---|---|
| 1 | Project setup, SQLite schema, data collector | done |
| 2 | PumpSwap trades, Helius budget + targeted streams, wallet scoring, signal engine, paper trader, risk manager | **done** |
| 3 | Telegram bot, systemd services, heartbeat watchdog, health checks, timers, deploy script | next |
| 4 | Learner: datasets, model, walk-forward backtest, weekly retrain + report | |
| 5 | Live executor (still disabled by default) | |

## Architecture

```
  Helius WS ─ firehose: logsSubscribe(pump program)  ─┐   budgeted: discovery only
  Helius WS ─ targeted: logsSubscribe(one address)   ─┤   always on: tracked wallets,
               × tracked wallets, watched curves/pools │   tokens they trade, our positions
  PumpPortal WS (free) ─ new tokens, migrations       ─┤
                                                       ▼
                                 ┌──────────────────────────────┐
                                 │ collector                    │ decode pump + PumpSwap events,
                                 │ budget/schedule, dedupe      │ dedupe across streams, bars,
                                 └──────────────┬───────────────┘ holders, pools, gaps, usage
                                                ▼
                       ┌─────────────────────────────────────────────┐
                       │ SQLite (WAL) data/trading.db — also the bus │◄── watchlist (trader → collector)
                       └──┬───────────────────┬────────────────────┬─┘
                daily     │                   │ polls new trades   │ weekly (P4)
        ┌─────────────────▼──┐   ┌────────────▼──────────────┐   ┌─▼──────────────────────┐
        │ wallet scoring     │   │ trader                    │   │ learner (Python)       │
        │ replays every      │   │ signal engine (filters,   │   │ may scale signal score │
        │ position as a      │──►│  on-chain checks) ──────► │◄──┤ only; never sizes,     │
        │ delayed follower   │   │ RISK MANAGER (constants)  │   │ never touches risk     │
        │ → tracked_wallets  │   │ → paper engine (fills at  │   └────────────────────────┘
        └────────────────────┘   │   delayed market, costs)  │
                                 └───────────────────────────┘
```

## Data strategy (and why)

Measured on 2026-10-20: the full pump.fun stream is **~35 GB/day** of websocket traffic
(~40 trades/s plus failed transactions). Helius bills ~20 credits/MB, so following everything
would be ~21M credits/month (Free plan: 1M; Developer: 10M). Free public RPC endpoints were
tested and are lossy (they delivered 0–43% of the trades Helius did), so they are not used.

Copy-trading doesn't need every trade all day:

| stream | what | when | cost |
|---|---|---|---|
| firehose | every pump.fun trade/launch/migration | `firehose.hours_utc` until its share of the daily budget is spent | most of the budget |
| targeted | one subscription per tracked wallet, per token they trade, per position, per migrated pool | always | small |
| PumpPortal | every launch (creator, dev buy), every migration | always | free |
| RPC | holder concentration + dev balance per signal | per signal | 2 calls |

`collector.helius.daily_mb_cap` caps **all** Helius traffic per UTC day; `targeted_reserve_mb`
is kept back so following keeps working after discovery stops. Upgrading the Helius plan means
raising the cap (and widening `hours_utc`), nothing else. Every period without full coverage is
recorded in `collector_gaps`, and scoring ignores positions it didn't fully observe.

## Trading pipeline

**Wallet scoring** (`make score`, daily). Each wallet's positions over 7 days are replayed as a
follower would trade them: enter 1.5s after their buy at the market as it then was, exit on
their first sell / stop loss / 30-min time exit, paying every fee. Ranking uses that *follower*
ROI, capped at +100% per trade so one lucky 10x can't carry a losing wallet, and shrunk toward
zero for small samples. Rejected: <8 fully observed positions, >300 tokens/day (bots), >50% of
profit from entries within 2 slots of launch (snipers/bundlers), median hold <20s, follower
ROI ≤ 0. The top 25 are tracked; wallets that go cold (48h) or stop qualifying are dropped.

**Signal engine.** When a tracked wallet buys: venue, leader size, token age, mayhem mode,
serial-launcher dev, curve SOL, re-entry cooldown, confirmations from other tracked wallets
(all from the DB), then, only if those pass, on-chain top-10 holder concentration and the dev's
remaining balance vs their launch buy. RPC failures reject (fail closed). Every decision is
stored in `signals` with its reasons and features. Thresholds: `signals:` in `config/config.yaml`.

**Risk manager** (`trader/src/risk/limits.ts`, constants, no setters, not in config; tests
enforce all of this):

| limit | value |
|---|---|
| position size | 2% of equity, max 0.05 SOL, skip below 0.01 SOL |
| open positions / entries per day | 5 / 40 |
| stop loss / time exit | −25% from entry / 30 min |
| daily loss cap | −5% equity from UTC day start → no entries until next day |
| max drawdown | −30% from starting balance → kill switch (needs a human to clear) |
| free balance reserve | 0.05 SOL |
| kill switch | `make kill`, `touch data/KILL`, or (Phase 3) Telegram `/stop` → flatten all, no entries |

**Paper engine.** Orders fill at the market state `execution_delay_ms` after the leader's trade
(constant-product on the real reserves, so price impact included), plus: pump fees as charged on
that trade (~1.25%), PumpPortal's 0.5% executor fee, a priority fee per tx, extra slippage, token
account rent (refunded on exit). Orders worse than `max_slippage_bps` vs the leader's price fail
and cost the network fee, like a live slippage limit. Exits follow the leader's first sell, the
stop loss, the time exit, or the kill switch, with the same delay.

What this means at a 1 SOL balance: positions are 0.02 SOL and a round trip costs ~6–7% before
any price movement. The stop loss realises worse than −25% (prices move during the 1.5s exit).

## Layout

```
shared/migrations/   SQL schema (001 market data, 002 trading), applied by TS and shared/migrate.py
trader/src/collector streams, decoders (pump + PumpSwap), budget, targeted subs, bars, store
trader/src/sim       trade-cost model shared by paper engine and scoring
trader/src/scoring   follower-replay wallet scoring
trader/src/signals   filters + on-chain checks
trader/src/risk      HARD limits + risk manager
trader/src/paper     paper engine
trader/src/trader    trading loop service
trader/src/tools     verify-live, explain-wallet, kill switch
config/config.yaml   tunables — no secrets, no risk limits
scripts/status.py    `make status`
```

## Setup and commands

Requires Node 20+ and Python 3.11+.

```bash
make install        # npm deps, .venv, .env (chmod 600) from .env.example
$EDITOR .env        # HELIUS_API_KEY
make test           # 74 tests
make collector      # terminal 1
make trader         # terminal 2 (paper only)
make score          # after some data has been collected; re-run daily (timer in Phase 3)
make status         # health, data, paper PnL
make explain WALLET=<address>   # why a wallet scores the way it does
make kill / make unkill
make verify-live    # after any pump.fun program upgrade
```

## What gets stored

| table | contents |
|---|---|
| `tokens` | every launch: creator, curve, slot, dev buy, completion/migration time |
| `trades` | curve + PumpSwap trades (`venue`), amounts, reserves, fees, price, slot, `is_dev` |
| `pools` | PumpSwap pool → token |
| `token_bars`, `token_holders`, `holder_snapshots` | 5s/60s OHLCV with holder stats; balances; on-chain top holders |
| `wallet_scores`, `tracked_wallets` | every scoring run; the current tracked set with why wallets left |
| `signals` | every decision with reasons and features (learner input) |
| `paper_positions`, `paper_fills`, `paper_account` | paper trading |
| `risk_state` | kill switch, daily loss cap state |
| `watchlist` | addresses the collector should follow |
| `collector_gaps`, `stream_usage`, `service_heartbeats` | coverage, cost, liveness |

Known limits: mayhem-mode tokens use different curve parameters (excluded from trading by
default); non-SOL-quoted curves and pools are skipped; trade-derived holder counts miss plain
transfers (the on-chain checks cover that).
