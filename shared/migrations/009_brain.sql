-- 009: the learning brain (learner/brain.py). Every night it studies every signal ever recorded
-- and keeps everything: each model it ever built and each lesson it ever wrote stay here for good.
-- The trader reads the newest model; it can only make the bot skip more, never trade more.

-- One row per nightly study. `model` is the full model as JSON (features, scaling, weights).
CREATE TABLE brain_models (
  id            INTEGER PRIMARY KEY,
  trained_at    INTEGER NOT NULL,
  version       TEXT NOT NULL,
  active        INTEGER NOT NULL,        -- 1 = passed its exam: the trader may skip what it predicts will lose
  threshold     REAL NOT NULL,           -- skip when the predicted follower ROI is below this
  studied       INTEGER NOT NULL,        -- signals with a known outcome it learned from
  model         TEXT NOT NULL,           -- JSON
  exam          TEXT NOT NULL            -- JSON: the held-out test and each pass/fail check
);
CREATE INDEX idx_brain_models_time ON brain_models (trained_at);

-- What it learned, in words, one row per lesson per night. Never deleted.
CREATE TABLE brain_notes (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  model_id   INTEGER REFERENCES brain_models (id),
  kind       TEXT NOT NULL,              -- lesson | study | exam
  text       TEXT NOT NULL,              -- plain English (the dashboard rewords it for the Gen Z voice from data)
  data       TEXT                        -- JSON
);
CREATE INDEX idx_brain_notes_time ON brain_notes (ts);
