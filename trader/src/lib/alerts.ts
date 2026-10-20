import type { DB } from "./db.js";

export type AlertLevel = "info" | "warn" | "error" | "fatal";

const DEDUPE_MS = 10 * 60_000;

/**
 * Queue an alert for the notifier. The same text from the same source is suppressed for 10
 * minutes, so a reconnect loop can't flood the chat.
 */
export function raiseAlert(db: DB, level: AlertLevel, source: string, text: string, now = Date.now()): boolean {
  const recent = db.prepare("SELECT 1 FROM alerts WHERE source = ? AND text = ? AND ts > ? LIMIT 1").get(source, text, now - DEDUPE_MS);
  if (recent) return false;
  db.prepare("INSERT INTO alerts (ts, level, source, text) VALUES (?, ?, ?, ?)").run(now, level, source, text.slice(0, 3500));
  return true;
}
