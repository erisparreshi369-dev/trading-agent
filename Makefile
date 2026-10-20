SHELL := /bin/bash
PY := .venv/bin/python

.PHONY: install build test migrate collector status

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

collector: build ## run the collector in the foreground (systemd unit comes in Phase 3)
	cd trader && node dist/collector/index.js | npx pino-pretty

status:
	@$(PY) scripts/status.py
