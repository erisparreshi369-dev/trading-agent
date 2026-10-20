# Runbook

Grows each phase. Systemd units, Telegram alerts and the VPS deploy script arrive in Phase 3.

## Is it healthy?

```bash
make status
```

Exit code 0 = every service has a heartbeat newer than 5 min; 2 = something is stale.

## Collector

| symptom | check | fix |
|---|---|---|
| `helius=off` | `HELIUS_API_KEY` set in `.env`? | add key, restart collector |
| `helius PAUSED (daily cap)` | `stream_usage` for today | expected; resumes 00:00 UTC. Raise `collector.helius_daily_mb_cap` only if your Helius plan covers it |
| `helius=DOWN` for minutes | logs for `ws closed` / `429` | 429 = credits exhausted (Helius dashboard). Otherwise it retries with backoff up to 30s |
| trades but no bars | token created before the collector started | expected; bars only exist for launches seen live |
| `db write failed` then exit | disk full? `df -h` | the process exits on purpose so systemd restarts it clean |

Gaps (outages, restarts, cap pauses) are in `collector_gaps`.

## Disk

Raw trades older than `retention.raw_trades_days` (30) are pruned hourly, except trades by
tracked wallets. Bars, tokens and holder snapshots are kept.
