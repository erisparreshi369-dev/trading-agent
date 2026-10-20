#!/usr/bin/env bash
# Move the whole system to a Linux server (Ubuntu/Debian) with one command.
#
#   scripts/deploy.sh user@host                       code only (put .env there yourself)
#   scripts/deploy.sh user@host --with-env            also copy .env (scp, chmod 600)
#   scripts/deploy.sh user@host --with-env --with-data  also move the database: stops the
#                                                     local services first so the copy is
#                                                     consistent and nothing runs twice
#   scripts/deploy.sh user@host --dry-run             print what would happen
#
# The remote user needs sudo for the one-time package install (Node 20+, python3-venv, build tools).
# Never leave both machines running: that doubles Helius usage and paper-trades twice.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: scripts/deploy.sh user@host [--with-env] [--with-data] [--dry-run]}"
shift
WITH_ENV=0 WITH_DATA=0 DRY=0
for a in "$@"; do
  case "$a" in
    --with-env) WITH_ENV=1 ;;
    --with-data) WITH_DATA=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option $a"; exit 1 ;;
  esac
done
REMOTE_DIR="trading-agent"
run() { echo "+ $*"; [ "$DRY" -eq 1 ] || "$@"; }

echo "== preflight"
run ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" "uname -a && cat /etc/os-release | head -2"

if [ "$WITH_DATA" -eq 1 ]; then
  echo "== stopping local services (data move)"
  run systemctl --user stop trading-collector trading-trader trading-notifier trading-score.timer trading-weekly.timer || true
  echo "== consistent database snapshot"
  run "$ROOT/.venv/bin/python" -c "import sqlite3; s=sqlite3.connect('$ROOT/data/trading.db'); d=sqlite3.connect('$ROOT/data/deploy-snapshot.db'); s.backup(d); d.close()"
fi

echo "== code"
run rsync -az --delete \
  --exclude .git/ --exclude node_modules/ --exclude .venv/ --exclude trader/dist/ \
  --exclude data/ --exclude logs/ --exclude reports/ --exclude models/ --exclude .env \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

if [ "$WITH_ENV" -eq 1 ]; then
  echo "== secrets"
  run ssh "$TARGET" "mkdir -p $REMOTE_DIR && umask 077 && touch $REMOTE_DIR/.env"
  run scp -q "$ROOT/.env" "$TARGET:$REMOTE_DIR/.env"
  run ssh "$TARGET" "chmod 600 $REMOTE_DIR/.env"
fi

if [ "$WITH_DATA" -eq 1 ]; then
  echo "== data"
  run ssh "$TARGET" "mkdir -p $REMOTE_DIR/data"
  run rsync -az "$ROOT/data/deploy-snapshot.db" "$TARGET:$REMOTE_DIR/data/trading.db"
  run rsync -az --ignore-missing-args "$ROOT/reports/" "$TARGET:$REMOTE_DIR/reports/"
  run rm -f "$ROOT/data/deploy-snapshot.db"
fi

echo "== remote bootstrap"
run ssh -t "$TARGET" "bash $REMOTE_DIR/scripts/remote-bootstrap.sh $REMOTE_DIR"

if [ "$WITH_DATA" -eq 1 ]; then
  echo "== local services stay stopped. When the server looks healthy, disable them here:"
  echo "   scripts/install-services.sh --uninstall"
fi
echo "== done. On the server: cd $REMOTE_DIR && make status"
