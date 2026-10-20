#!/usr/bin/env bash
# Install/refresh the systemd user units and start everything. Safe to re-run.
#   scripts/install-services.sh            install + enable + start
#   scripts/install-services.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE="$(command -v node)"
SERVICES=(collector trader notifier dashboard)
TIMERS=(score weekly logrotate)

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now $(printf 'trading-%s.service ' "${SERVICES[@]}") $(printf 'trading-%s.timer ' "${TIMERS[@]}") 2>/dev/null || true
  rm -f "$UNIT_DIR"/trading-*
  systemctl --user daemon-reload
  echo "uninstalled"
  exit 0
fi

[ -x "$NODE" ] || { echo "node not found"; exit 1; }
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; exit 1; }
[ -x "$ROOT/.venv/bin/python" ] || { echo "run make install first"; exit 1; }
grep -qE '^TELEGRAM_CHAT_ID=.+' "$ROOT/.env" || { echo "TELEGRAM_CHAT_ID missing in .env (cd trader && npm run telegram:setup)"; exit 1; }

# a second copy started by hand would double Helius usage and trade twice
manual=$(pgrep -f "node dist/(collector|trader|notifier)/index.js" | while read -r pid; do
  [ "$(cat /proc/$pid/cgroup 2>/dev/null | grep -c 'trading-')" -eq 0 ] && echo "$pid"; done || true)
if [ -n "$manual" ]; then
  echo "stopping copies started outside systemd: $manual"
  kill -TERM $manual; for _ in $(seq 20); do kill -0 $manual 2>/dev/null || break; sleep 1; done
fi

(cd "$ROOT/trader" && npm run -s build)
mkdir -p "$UNIT_DIR" "$ROOT/logs" "$ROOT/reports"
chmod 750 "$ROOT/logs" # logrotate skips directories other users can write to
chmod +x "$ROOT/scripts/notify-failure.sh"
for f in "$ROOT"/deploy/systemd/*; do
  sed -e "s|@ROOT@|$ROOT|g" -e "s|@NODE@|$NODE|g" "$f" > "$UNIT_DIR/$(basename "$f")"
done
sed "s|@ROOT@|$ROOT|g" "$ROOT/deploy/logrotate.conf" > "$ROOT/logs/.logrotate.conf"
systemctl --user daemon-reload
for s in "${SERVICES[@]}"; do systemctl --user enable "trading-$s.service" >/dev/null; systemctl --user restart "trading-$s.service"; done
for t in "${TIMERS[@]}"; do systemctl --user enable --now "trading-$t.timer" >/dev/null; done

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null && echo "linger enabled" || \
    echo "NOTE: services stop at logout and won't start at boot until linger is on: sudo loginctl enable-linger $USER"
fi
systemctl --user --no-pager list-units 'trading-*' --all
systemctl --user --no-pager list-timers 'trading-*'
