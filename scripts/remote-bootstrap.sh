#!/usr/bin/env bash
# Runs ON the server (deploy.sh calls it). Installs prerequisites, builds, tests, starts services.
set -euo pipefail
DIR="${1:-trading-agent}"
cd "$HOME/$DIR"

need_pkgs=()
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  need_pkgs+=(nodejs)
fi
python3 -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null || { echo "need python >= 3.11"; exit 1; }
python3 -m venv --help >/dev/null 2>&1 || need_pkgs+=(python3-venv)
command -v make >/dev/null || need_pkgs+=(make)
command -v g++ >/dev/null || need_pkgs+=(build-essential) # in case better-sqlite3 has no prebuilt binary
command -v logrotate >/dev/null || need_pkgs+=(logrotate)
command -v rsync >/dev/null || need_pkgs+=(rsync)
if [ ${#need_pkgs[@]} -gt 0 ]; then
  echo "== apt install ${need_pkgs[*]}"
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need_pkgs[@]}"
fi

[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "!! created an empty .env: fill it in, then re-run: bash scripts/remote-bootstrap.sh $DIR"; exit 1; }
grep -q '^LIVE_TRADING=true' .env && echo "!! NOTE: LIVE_TRADING=true is set in this server's .env"

echo "== install + test"
make install
make test
echo "== services"
# servers have no lid or suspend to worry about; linger lets services start at boot
sudo loginctl enable-linger "$USER"
bash scripts/install-services.sh
make status || true
