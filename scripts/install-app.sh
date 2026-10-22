#!/usr/bin/env bash
# Adds a "Trading Dashboard" launcher (its own window, not a browser) to the app menu and the desktop, and opens it at login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPS="$HOME/.local/share/applications"
FILE="$APPS/trading-dashboard.desktop"
mkdir -p "$APPS"
cat > "$FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Trading Dashboard
Comment=The trading bot's live dashboard in its own window
Exec=/usr/bin/python3 $ROOT/dashboard/app.py
Icon=utilities-system-monitor
Terminal=false
Categories=Office;Finance;
StartupWMClass=trading-dashboard
StartupNotify=true
DESKTOP
chmod +x "$FILE"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESK" ]; then
  cp "$FILE" "$DESK/trading-dashboard.desktop"
  chmod +x "$DESK/trading-dashboard.desktop"
  gio set "$DESK/trading-dashboard.desktop" metadata::trusted true 2>/dev/null || true
  gio set "$DESK/trading-dashboard.desktop" metadata::xfce-exe-checksum "$(sha256sum "$DESK/trading-dashboard.desktop" | cut -d' ' -f1)" 2>/dev/null || true
fi
update-desktop-database "$APPS" 2>/dev/null || true
# Open it at login too, so the live feed is always on screen (closing the window still stops it).
mkdir -p "$HOME/.config/autostart"
cp "$FILE" "$HOME/.config/autostart/trading-dashboard.desktop"
echo "Added: app menu → Trading Dashboard${DESK:+, an icon on the desktop}, and it opens at login"
