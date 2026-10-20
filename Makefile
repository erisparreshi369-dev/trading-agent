SHELL := /bin/bash
PY := .venv/bin/python

.PHONY: install build test migrate collector trader score status kill unkill verify-live explain

install: ## install all dependencies
	cd trader && npm ci
	test -d .venv || python3 -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	@test -f .env || (cp .env.example .env && chmod 600 .env && echo "created .env from .env.example; fill in keys")

build:
	cd trader && npm run -s build

test:
	cd trader && npx vitest run

migrate:
	$(PY) shared/migrate.py

# Foreground runs with readable logs. systemd units replace these in Phase 3.
collector: build
	cd trader && node dist/collector/index.js | npx pino-pretty

trader: build
	cd trader && node dist/trader/index.js | npx pino-pretty

score: build ## re-score wallets and update the tracked set (daily timer in Phase 3)
	cd trader && node dist/scoring/index.js

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
