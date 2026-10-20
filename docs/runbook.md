# Runbook

Grows each phase.

## Is it healthy?

```bash
make status
```

Exit code 0 = every service has a fresh heartbeat and a live process; 2 = something is stale or stopped.

## Services

```bash
systemctl --user status trading-collector trading-trader trading-notifier
systemctl --user restart trading-trader          # safe at any time: state is in SQLite
make logs S=collector
systemctl --user list-timers 'trading-*'
```

| Telegram alert | meaning / what to do |
|---|---|
| `X has not reported for 5 min` | hung or stopped. `systemctl --user status trading-X`, `make logs S=X` |
| `X restarted after dying without a clean shutdown` | killed / out of memory / power loss; systemd already restarted it. Several per day: check `make logs`, `free -h`, `dmesg` |
| `systemd: trading-X FAILED ... not restarted` | crash loop (20 in 10 min) or a timer job failed. Fix the cause, then `systemctl --user reset-failed trading-X && systemctl --user start trading-X` |
| `Helius daily cap reached: ... following is OFF` | see Collector below |
| no messages at all | `systemctl --user status trading-notifier`; token/chat in `.env`; `cd trader && npm run telegram:setup` re-detects the chat |

After a reboot everything starts by itself (linger). `make drill` re-verifies recovery end to end.

## Collector

| symptom | meaning / fix |
|---|---|
| `firehose=off (off-hours)` | expected outside `collector.firehose.hours_utc` |
| `firehose=off (daily budget used)` | expected on the Free plan, usually within the first hour of the window. Resumes next day |
| `targeted=off` and a `daily cap reached` gap | **following has stopped**: the whole Helius cap is spent. Raise `targeted_reserve_mb` or lower firehose usage; resumes 00:00 UTC |
| `targeted ... [N subs]` lower than wallets + positions | over `max_subscriptions` (lowest priority dropped) or subscribe errors in the log |
| `helius=DOWN` / `targeted=DOWN` for minutes | logs for `ws closed`; `429` = credits exhausted (check the Helius dashboard) |
| `db write failed` then exit | disk full? `df -h`. The process exits on purpose so systemd restarts it clean |
| decode errors / odd prices after a pump.fun upgrade | `make verify-live`; if it fails, compare `trader/src/collector/*-events.ts` with the IDLs in github.com/pump-fun/pump-public-docs |

## Trader

| symptom | meaning / fix |
|---|---|
| `KILL SWITCH ON` | positions were flattened. Find out why (`risk_state.kill_reason`, logs). Clear with `make unkill` |
| `halted today (daily loss cap)` | no entries until 00:00 UTC; exits still run |
| `tracked=0` | run `make score` (needs firehose data first: a few days for a meaningful set) |
| signals all rejected | `make status` shows the top reasons; tune `signals:` in config (never the risk limits) |
| refuses to start: `LIVE_TRADING=true` | expected until Phase 5 |

Paper positions, pending fills and the balance are all in SQLite: restarting the trader is safe
at any time. Tracked-wallet buys older than 5s when read (e.g. after a restart) are skipped, not acted on.

## Wallet scoring

`make score` prints the tracked set. `make explain WALLET=<addr>` replays one wallet position by
position (leader result vs follower result and why the follower exited). Use it before trusting
a surprising score.

## Disk

Raw trades older than `retention.raw_trades_days` (30) are pruned hourly, except trades by
tracked wallets. Bars, tokens, scores, signals and paper history are kept.
