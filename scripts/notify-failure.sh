#!/usr/bin/env bash
# Called by systemd (OnFailure=) when a unit gives up or a timer job fails.
# Sends straight to Telegram with curl: it must work even when the notifier itself is the one down.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
unit="${1:-unknown}"
get() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
token="$(get TELEGRAM_BOT_TOKEN)"; chat="$(get TELEGRAM_CHAT_ID)"
name="${unit#trading-}"; name="${name%.service}"
tail="$(tail -n 5 "$ROOT/logs/$name.log" 2>/dev/null | cut -c1-300 || true)"
msg="🚨 systemd: $unit FAILED on $(hostname) and was not restarted (crash loop or job error).
Check: systemctl --user status $unit
$tail"
echo "$msg" >&2
[ -n "$token" ] && [ -n "$chat" ] || exit 0
curl -sS -m 15 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg:0:3900}" || true
