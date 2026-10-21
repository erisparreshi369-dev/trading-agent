-- 012: size up after consistency, not after profit (trader/src/risk/size-base.ts). Trades are sized
-- from a proven balance that only steps up after several profitable weeks in a row. NULL = not set
-- yet: the risk manager starts it at the starting balance.
ALTER TABLE risk_state ADD COLUMN size_base REAL;
ALTER TABLE risk_state ADD COLUMN size_base_prev REAL;     -- level before the last step-up, while its first week is on trial
ALTER TABLE risk_state ADD COLUMN size_base_at INTEGER;    -- when it was set or last stepped (ms)
