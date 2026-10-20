#!/usr/bin/env bash
# Called by systemd (OnFailure=) when a unit fails. systemd also calls this when Restart= is about
# to bring the service straight back, so: wait 20s, then let the Node tool decide (it stays quiet
# about restarts; the notifier groups those into one 🔧 message an hour). Must work even when the
# notifier itself is the one down. Message wording lives in trader/src/notifier/messages.ts.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
unit="${1:-unknown}"
sleep 20
state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
echo "$unit failed; 20s later it is ${state:-unknown}" >&2
NODE="${NODE:-$(command -v node || echo /usr/bin/node)}"  # the unit passes the node install-services found
cd "$ROOT/trader" && "$NODE" dist/tools/notify-failure.js "$unit" "$state" && exit 0

# Last resort: Node itself couldn't run. The only message text outside messages.ts.
[ "$state" = "active" ] && exit 0
get() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
token="$(get TELEGRAM_BOT_TOKEN)"; chat="$(get TELEGRAM_CHAT_ID)"
[ -n "$token" ] && [ -n "$chat" ] || exit 0
msg="BOT HEALTH · A part of the bot is down
What happened: A part of the bot stopped, and the bot cannot even send its normal message.
🚨 Bad: The bot may not be trading or watching the market.
What to do: On the bot's computer, type: make status (this shows which part is down)."
curl -sS -m 15 -o /dev/null "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" || true
