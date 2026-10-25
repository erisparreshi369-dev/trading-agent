-- 014: indexes for brain study speed, dashboard queries, shadow variants, and collector performance
-- Brain study: ORDER BY ts on signals + JOIN shadow_trades
CREATE INDEX IF NOT EXISTS idx_signals_ts_taken ON signals(ts) WHERE decision = 'enter';

-- Shadow trades: brain's load_examples() joins signals + shadow_trades on variant + status
CREATE INDEX IF NOT EXISTS idx_shadow_variant_status_signal ON shadow_trades(variant, status, signal_at);

-- Brain models: dashboard reads latest active model
CREATE INDEX IF NOT EXISTS idx_brain_models_active_time ON brain_models(active, trained_at DESC);

-- Brain notes: dashboard reads latest notes per model
CREATE INDEX IF NOT EXISTS idx_brain_notes_model_kind ON brain_notes(model_id, kind);

-- Collector: trades by mint + time for gap detection
CREATE INDEX IF NOT EXISTS idx_trades_mint_received ON trades(mint, received_at);

-- Paper positions: dashboard queries by status + closed_at
CREATE INDEX IF NOT EXISTS idx_paper_positions_status_closed ON paper_positions(status, closed_at);

-- Wallet scores: re-scoring queries
CREATE INDEX IF NOT EXISTS idx_wallet_scores_run ON wallet_scores(run_at DESC);

-- Service heartbeats: dashboard status
CREATE INDEX IF NOT EXISTS idx_service_heartbeats_service ON service_heartbeats(service);