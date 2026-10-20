#!/usr/bin/env bash
# Recovery drill: for each service, a clean restart and a hard crash (kill -9), checking that
# systemd brings it back, its heartbeat resumes, and the notifier reports it as a 🔧 restart
# (never a 🚨: it was back within 20s).
#   scripts/drill.sh [collector trader notifier]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/trading.db"
SERVICES=("${@:-collector trader notifier}")
[ $# -eq 0 ] && SERVICES=(collector trader notifier)
q() { sqlite3 -cmd ".timeout 10000" "$DB" "$1"; }
ms() { date +%s%3N; }
prop() { systemctl --user show "trading-$1" -p "$2" --value; }
wait_for() { # seconds, description, command...
  local t=$1 what=$2; shift 2
  for _ in $(seq "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "    FAIL: $what (waited ${t}s)"; return 1
}
# a heartbeat written by the CURRENT process (a stopping process also writes a final one)
hb_after() { [ "$(q "SELECT ts > $2 AND pid = $(prop "$1" MainPID) FROM service_heartbeats WHERE service = '$1'")" = 1 ]; }
# the restart is recorded, and the notifier has either sent its 🔧 message or (one per part per
# hour) is holding it to group with the next ones
restart_seen() { [ "$(q "SELECT count(*) FROM alerts WHERE ts > $2 AND kind = 'restart' AND source = '$1'")" -ge 1 ]; }
restart_handled() { [ "$(q "SELECT count(*) FROM alerts WHERE ts > $2 AND kind = 'restart' AND source = '$1' AND sent_at IS NOT NULL")" -ge 1 ] \
  || [ "$(q "SELECT COALESCE(MAX(value), 0) FROM kv WHERE key = 'notifier.restart_msg.$1'")" -gt $(( $(ms) - 3600000 )) ]; }
no_alert() { [ "$(q "SELECT count(*) FROM alerts WHERE ts > $2 AND source = '$1' AND (kind = 'restart' OR level IN ('error', 'fatal'))")" -eq 0 ]; }
FAILS=0

for s in "${SERVICES[@]}"; do
  echo "== $s"
  # ---- clean restart ----
  r0=$(prop "$s" NRestarts); t0=$(ms); pid0=$(prop "$s" MainPID)
  systemctl --user restart "trading-$s"
  ok=1
  wait_for 20 "active after restart" systemctl --user is-active --quiet "trading-$s" || ok=0
  wait_for 45 "fresh heartbeat after restart" hb_after "$s" "$t0" || ok=0
  [ "$(prop "$s" NRestarts)" -le "$r0" ] || { echo "    FAIL: clean restart counted as a crash"; ok=0; }
  [ "$(prop "$s" MainPID)" != "$pid0" ] || { echo "    FAIL: same pid"; ok=0; }
  no_alert "$s" "$t0" || { echo "    FAIL: a clean restart raised an error alert"; ok=0; }
  echo "  restart: $([ $ok = 1 ] && echo OK || echo FAILED) (pid $pid0 -> $(prop "$s" MainPID), $(( ($(ms) - t0) / 1000 ))s)"
  [ $ok = 1 ] || FAILS=$((FAILS + 1))

  # ---- hard crash ----
  r0=$(prop "$s" NRestarts); t0=$(ms); pid0=$(prop "$s" MainPID)
  kill -9 "$pid0"
  ok=1
  wait_for 30 "restarted by systemd" bash -c "[ \"\$(systemctl --user show trading-$s -p MainPID --value)\" != $pid0 ] && [ \"\$(systemctl --user show trading-$s -p MainPID --value)\" != 0 ]" || ok=0
  [ "$(prop "$s" NRestarts)" -gt "$r0" ] || { echo "    FAIL: NRestarts did not increase"; ok=0; }
  wait_for 45 "fresh heartbeat after crash" hb_after "$s" "$t0" || ok=0
  wait_for 30 "restart recorded" restart_seen "$s" "$t0" || ok=0
  wait_for 90 "🔧 message sent (or grouped into this hour's)" restart_handled "$s" "$t0" || ok=0
  echo "  crash:   $([ $ok = 1 ] && echo OK || echo FAILED) (kill -9 $pid0 -> pid $(prop "$s" MainPID), restarts $r0 -> $(prop "$s" NRestarts), $(( ($(ms) - t0) / 1000 ))s incl. alert)"
  [ $ok = 1 ] || FAILS=$((FAILS + 1))
done
echo "== $([ $FAILS = 0 ] && echo "ALL OK" || echo "$FAILS FAILED")"
exit $FAILS
