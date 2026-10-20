# pump.fun copy-trading agent

Tracks pump.fun wallets, scores them, learns which of their trades are worth following,
and copies them in **paper mode**. Live trading is off unless the owner sets `LIVE_TRADING=true` in `.env`.

| Phase | Scope | State |
|---|---|---|
| 1 | Project setup, SQLite schema, data collector | **done** |
| 2 | PumpSwap post-migration trades, wallet scoring, signal engine, paper trader (1 SOL), risk manager | next |
| 3 | Telegram bot, systemd services, heartbeat watchdog, health checks, timers, deploy script | |
| 4 | Learner: datasets, model, walk-forward backtest, weekly retrain + report | |
| 5 | Live executor (still disabled by default) | |

## Architecture

```
            Helius WS (logsSubscribe on pump program)      PumpPortal WS (free: new tokens, migrations)
                         │  every bonding-curve trade/create/complete      │
                         └──────────────────┬──────────────────────────────┘
                                            ▼
                               ┌────────────────────────┐
                               │ collector  (trader/)   │  decode Anchor events, dedupe,
                               │ 24/7, auto-reconnect   │  5s/60s bars, holder balances,
                               └───────────┬────────────┘  RPC holder checks, gaps, usage
                                           ▼
                         ┌───────────────────────────────────┐
                         │  SQLite (WAL)  data/trading.db     │  schema: shared/migrations
                         └──┬──────────────┬──────────────┬──┘
                daily       │              │              │  weekly
          ┌─────────────────▼──┐   ┌───────▼───────┐   ┌──▼───────────────────────┐
          │ wallet scoring (P2)│   │ trader (P2)   │   │ learner (P4, Python)     │
          │ PnL, win rate,     │   │ signal engine │◄──┤ labels, LightGBM, walk-  │
          │ hold time, exclude │   │ → RISK MGR    │   │ forward backtest; ships  │
          │ snipers/bundlers   │   │ (hardcoded)   │   │ a scoring model only if  │
          └────────────────────┘   │ → paper fills │   │ it beats the current one │
                                   │ → [live exec, │   └──────────────────────────┘
                                   │   P5, off]    │
                                   └───────┬───────┘
                                           ▼
                                  Telegram (P3): alerts, /stop /status /pnl, daily PnL,
                                  weekly report, heartbeat watchdog
```

The model only adjusts **signal scores**. The risk manager is plain code with constants;
no config file, model output, or Telegram command can loosen it (`/stop` can only halt).

## Layout

```
shared/migrations/   SQL schema, applied in order by both runners (TS + shared/migrate.py)
trader/src/lib/      config, db, logging (secret redaction), reconnecting websocket
trader/src/collector pump.fun event decoder, bars, store, holder checks, collector service
trader/test/         vitest suites
learner/             Python pipeline (Phase 4)
config/config.yaml   tunables (collector now, signal filters in Phase 2) — no secrets, no risk limits
scripts/status.py    `make status`
docs/                this file, runbook.md
data/ logs/          runtime, git-ignored
```

## Setup

Requires Node 20+ and Python 3.11+.

```bash
make install        # npm deps, .venv, creates .env (chmod 600) from .env.example
$EDITOR .env        # set HELIUS_API_KEY
make test
make collector      # foreground run with pretty logs; Ctrl-C to stop
make status         # in another terminal
```

Without `HELIUS_API_KEY` the collector still runs but only records new tokens and migrations
(PumpPortal's free streams). Trades, bars and holder data need the Helius firehose.

## Data sources and cost

- **Helius `logsSubscribe`** on the pump.fun program gives every bonding-curve trade with slot
  and on-chain timestamp (needed to tell snipers/bundlers apart from copyable wallets).
  Helius meters websocket traffic at ~20 credits/MB. The collector records MB/day in
  `stream_usage` and pauses the firehose at `collector.helius_daily_mb_cap`
  (default 1500 MB ≈ the Free plan's 1M credits/month), resuming at 00:00 UTC. Pauses are logged as gaps.
- **PumpPortal** free streams (new tokens, migrations) are a redundant token source. Its
  per-token/per-wallet trade streams are paid (0.01 SOL / 10k messages) and are not used.
- **Holder checks**: `getTokenLargestAccounts` at 1/5/15/30/60 min for tokens with ≥25 trades,
  capped at 30/min. These catch tokens moved by plain transfers, which trade data can't see.

## What gets stored (Phase 1)

| table | contents |
|---|---|
| `tokens` | every launch: creator (dev), curve, slot, initial dev buy, completion/migration time |
| `trades` | every SOL-quoted bonding-curve trade: wallet, side, amounts, reserves, price, slot, `is_dev` |
| `token_bars` | OHLCV + buys/sells/unique traders; holders/top-10%/dev% (trade-derived) on 5s bars |
| `token_holders` | net trade-derived balance per wallet per token |
| `holder_snapshots` | on-chain top-20 accounts and top-10% at fixed ages |
| `dev_trades` (view) | trades by the token's creator with ms since launch |
| `collector_gaps` | stream outages, restarts, cap pauses, so the learner can drop affected windows |
| `stream_usage`, `service_heartbeats` | cost and liveness |

Known limits: trades after migration (PumpSwap) are not collected yet; Phase 2 adds them so
wallet PnL includes exits made after migration. Non-SOL-quoted
curves are skipped. Trade-derived holder counts miss plain token transfers (holder checks cover that).
