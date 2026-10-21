# Runbook

Grows each phase.

## Is it healthy?

```bash
make status
```

Exit code 0 = every service has a fresh heartbeat and a live process; 2 = something is stale or stopped.
Or open the dashboard, http://localhost:8080: the header turns red/yellow when a service, the kill
switch, the daily cap or the data feed needs attention. If the page says it can't read the bot's
data, check `make logs S=dashboard`; the dashboard being down never affects trading.

## Services

```bash
systemctl --user status trading-collector trading-trader trading-notifier trading-dashboard
systemctl --user restart trading-trader          # safe at any time: state is in SQLite
make logs S=collector
systemctl --user list-timers 'trading-*'
```

Telegram messages are written for a non-technical reader; all wording is in
`trader/src/notifier/messages.ts` (sample of every message: `cd trader && npx tsx test/message-samples.ts`).
What each one means for an operator:

| Telegram message | what happened / what to do |
|---|---|
| 🔧 `X restarted by itself` | crashed or was killed, systemd had it back within 20s. Grouped: at most one per part per hour |
| ⚠️ `X keeps restarting (N times in the last hour)` | 5+ restarts in an hour. `make logs S=X`, `free -h`, `dmesg` |
| 🚨 `X has stopped and hasn't come back` | still down 20s after it stopped (crash loop, systemd gave up, or broken start). `make restart`; then `make logs S=X` |
| 🚨 `X is frozen` | process alive, no heartbeat for 5 min. `make restart` |
| ⚠️ `X is switched off` | stopped cleanly and not started for 5 min (forgotten after maintenance?). `make restart` |
| ⚠️ `X keeps running into problems (N errors in the last hour)` | 10+ error logs in an hour; fewer only show in the daily report. `make logs S=X` |
| ⚠️ `Last night's wallet check failed` / `This week's report couldn't be made` | a timer job failed: `make score` / `make weekly` and read the output |
| no messages at all | `systemctl --user status trading-notifier`; token/chat in `.env`; `cd trader && npm run telegram:setup` re-detects the chat. If the notifier itself is down, `scripts/notify-failure.sh` messages Telegram directly |

systemd runs `trading-failure@` on every crash, even when `Restart=` brings the unit straight back;
`scripts/notify-failure.sh` waits 20s and stays silent if the unit is active again.
`/quiet` holds everything but 🚨 for 8 hours (reports wait, trades are summed up afterwards).

After a reboot everything starts by itself (linger). `make drill` re-verifies recovery end to end.

## Changing limits on the dashboard

Every limit is on the **Limits** tab: trading safety (size, open trades, trades a day, stop loss,
time exit, loss stops, fee reserve, practice-without-limits switch, max price jump), which buys we
copy, which traders we follow (used at the nightly check), and data limits. Changes stay until you
press "Back to normal"; the bot picks them up within ~5 s, no restart. Trading safety values can
never go past the walls in `trader/src/risk/limits.ts`, live or practice. The **Daily data limit**
(also in the Data collection panel) and **Daily job stops at** (also in the MadeOnSol panel) work as
before. A raised data limit is still capped by the monthly guard shown next to it:
using more today leaves less for the following days, and the plan's monthly credits can't run out.
Each change sends a `SETTINGS` Telegram message; `make status` counts how many are changed. To clear them by hand:
`sqlite3 data/trading.db "DELETE FROM kv WHERE key LIKE 'override.%'"`.

## MadeOnSol helper (optional)

| symptom | meaning / fix |
|---|---|
| `DATA HELPER · 70% / 90%` message | the daily job used that share of the 200 free requests; at 90% it stops. Trading is not affected |
| `DATA HELPER · used up` | MadeOnSol refused more requests today (often: requests made by hand). Resets 00:00 UTC |
| dashboard "last error" | `make logs S=intel`. `http 401` = key wrong or missing in `.env`; timeouts = MadeOnSol slow (nothing to do) |
| want it off | `madeonsol.enabled: false` in config, or remove the key from `.env` |

## Collector

| symptom | meaning / fix |
|---|---|
| `firehose=off (off-hours)` | expected outside `collector.firehose.hours_utc` |
| `firehose=off (daily budget used)` | light mode: 70% of the day's Helius budget is used. Resumes next day |
| `mode ESSENTIAL` / `OPEN TRADES ONLY` | 85% / 95% of the day's budget used; at 95% the trader opens nothing new. Resumes 00:00 UTC |
| `targeted=off` and a `daily cap reached` gap | the whole day's cap is spent and no trade is open. Resumes 00:00 UTC. If it happens most days: lower `pool_watch_hours`, or a paid plan + a higher `daily_mb_cap` |
| `this month ~Nk of 1000k` close to 1000k | the monthly Helius credits are nearly gone: past them Helius refuses everything (429) until the month resets. Lower `daily_mb_cap` now |
| `targeted ... [N subs]` lower than wallets + positions | over `max_subscriptions` (lowest priority dropped) or subscribe errors in the log |
| `helius=DOWN` / `targeted=DOWN` for minutes | logs for `ws closed`; `429` = credits exhausted (check the Helius dashboard) |
| `db write failed` then exit | disk full? `df -h`. The process exits on purpose so systemd restarts it clean |
| decode errors / odd prices after a pump.fun upgrade | `make verify-live`; if it fails, compare `trader/src/collector/*-events.ts` with the IDLs in github.com/pump-fun/pump-public-docs |

## Trader

| symptom | meaning / fix |
|---|---|
| 🚨 `Trading has stopped` / `/stop` | positions were flattened. Find out why (`risk_state.kill_reason`, logs). Clear with `make unkill` |
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
