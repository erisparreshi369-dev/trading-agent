#!/usr/bin/env bash
# One-time host setup that needs root. Review, then run:  sudo bash scripts/setup-host.sh
# Undo: sudo bash scripts/setup-host.sh --undo
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
USER_NAME="${SUDO_USER:?run via sudo from your normal account}"
SLEEP_TARGETS="sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target"
DROPIN=/etc/systemd/logind.conf.d/90-trading-agent.conf

if [ "${1:-}" = "--undo" ]; then
  systemctl unmask $SLEEP_TARGETS
  rm -f "$DROPIN"; systemctl kill -s HUP systemd-logind
  echo "sleep re-enabled, lid handling back to defaults (linger left on: loginctl disable-linger $USER_NAME)"
  exit 0
fi

echo "1/4 never sleep, suspend or hibernate"
systemctl mask $SLEEP_TARGETS

echo "2/4 lid close, idle and suspend keys do nothing"
mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<CONF
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
CONF
# HUP reloads logind's config without ending the desktop session (a restart could log you out)
systemctl kill -s HUP systemd-logind

echo "3/4 start $USER_NAME's services at boot without logging in"
loginctl enable-linger "$USER_NAME"

echo "4/4 sqlite3 CLI for debugging"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 >/dev/null || echo "  (apt install sqlite3 failed; optional)"

echo "done:"
systemctl is-enabled $SLEEP_TARGETS | paste -sd' '
loginctl show-user "$USER_NAME" -p Linger
