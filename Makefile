SHELL := /bin/bash
PY := .venv/bin/python

.PHONY: install build test migrate collector trader notifier dashboard app install-app brain youtube intel score weekly status health logs kill unkill verify-live explain costs install-services uninstall-services restart deploy drill

install: ## install all dependencies
	cd trader && npm ci
	test -d .venv || python3 -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r learner/requirements.txt
	@test -f .env || (cp .env.example .env && chmod 600 .env && echo "created .env from .env.example; fill in keys")

build:
	cd trader && npm run -s build

test:
	cd trader && npx vitest run
	$(PY) -m unittest discover -s dashboard
	$(PY) -m unittest discover -s learner

migrate:
	$(PY) shared/migrate.py

# Foreground runs with readable logs. systemd units replace these in Phase 3.
collector: build
	cd trader && node dist/collector/index.js | npx pino-pretty

trader: build
	cd trader && node dist/trader/index.js | npx pino-pretty

notifier: build
	cd trader && node dist/notifier/index.js | npx pino-pretty

dashboard: ## run the read-only dashboard in the foreground (systemd runs it as trading-dashboard on :8080)
	$(PY) dashboard/server.py --port $(or $(PORT),8080)

app: ## open the dashboard in its own window (not a browser tab)
	/usr/bin/python3 dashboard/app.py --port $(or $(PORT),8080) &

install-app: ## add "Trading Dashboard" to the app menu and the desktop
	bash scripts/install-app.sh

intel: build ## MadeOnSol daily job now: creator records, early-buyer scores, candidate wallets (systemd runs it 00:02 UTC)
	cd trader && node dist/intel/index.js

score: build ## re-score wallets and update the tracked set (systemd runs it daily at 00:15 UTC)
	cd trader && node dist/scoring/index.js

brain: ## learning brain: study every signal once now (the trading-brain service studies after every trade result)
	$(PY) learner/brain.py

youtube: ## the brain studies YouTube: top traders' rules vs our data (systemd runs it daily at 00:20 UTC)
	$(PY) learner/youtube.py

weekly: ## write this week's report into reports/ (systemd runs it Sundays 01:00 UTC; the notifier sends it)
	$(PY) learner/weekly_report.py

# ---- running as services ----
install-services: ## install + start the systemd user services and timers
	bash scripts/install-services.sh

restart: ## (re)start the collector, trader, notifier and learning brain, including ones systemd gave up on
	systemctl --user reset-failed 'trading-*' 2>/dev/null || true
	systemctl --user restart trading-collector trading-trader trading-notifier trading-brain
	@sleep 3 && systemctl --user is-active trading-collector trading-trader trading-notifier trading-brain

uninstall-services:
	bash scripts/install-services.sh --uninstall

logs: ## make logs S=trader  (collector|trader|notifier|dashboard|score|weekly|intel|brain|youtube)
	tail -n 200 -F logs/$(or $(S),trader).log | (cd trader && npx pino-pretty)

health: ## one line, exit code 0/2: for scripts and cron
	@$(PY) scripts/status.py --check

deploy: ## make deploy TARGET=user@host [ARGS="--with-env --with-data"]
	bash scripts/deploy.sh $(TARGET) $(ARGS)

status:
	@$(PY) scripts/status.py

kill: ## trip the kill switch: flatten all positions, no new entries
	cd trader && npm run -s kill -- "make kill"

unkill: ## clear the kill switch (deliberate human action)
	cd trader && npm run -s unkill -- --yes

verify-live: ## check event decoders against live mainnet traffic (run after pump.fun upgrades)
	cd trader && npm run -s verify:live

explain: ## make explain WALLET=<address>: every scored position, leader vs follower
	cd trader && npx tsx src/tools/explain-wallet.ts $(WALLET)

costs: ## does a bigger position cut the cost share? replays every copyable position at several sizes
	cd trader && npx tsx src/tools/cost-by-size.ts $(SIZES)

drill: ## restart + kill -9 every service, verify recovery and alerts (takes a few minutes)
	bash scripts/drill.sh
