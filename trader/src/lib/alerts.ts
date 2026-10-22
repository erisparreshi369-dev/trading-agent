import type { DB } from "./db.js";

export type AlertLevel = "info" | "warn" | "error" | "fatal";

/**
 * What happened, so the notifier can pick the wording (notifier/messages.ts). Raised by:
 *   kill_switch, daily_loss_cap  risk manager          helius_cap       collector
 *   madeonsol_budget             intel job (70% / 90% of the day's requests, and when they run out)
 *   setting_changed              dashboard (a limit raised or set back)
 *   mistake                      mistake checker (the trader broke one of its own rules)
 *   startup_blocked              a service refusing to start (missing key, LIVE_TRADING)
 *   error                        any other error log (grouped hourly)
 *   restart                      markStarted(): the previous run crashed or was killed
 *   job_failed, service_failed   scripts/notify-failure.sh (systemd OnFailure)
 */
export type AlertKind = "kill_switch" | "daily_loss_cap" | "helius_cap" | "startup_blocked" | "error" | "restart" | "job_failed" | "service_failed" | "madeonsol_budget" | "setting_changed" | "size_step" | "mistake";

export interface Alert {
  kind: AlertKind;
  source: string; // service name
  text: string; // technical one-liner for the logs and the database; never sent to Telegram
  data?: Record<string, unknown>;
  level?: AlertLevel;
}

const DEDUPE_MS = 10 * 60_000;
/** Every one of these counts (restart totals are reported), so they are never deduped. */
const NO_DEDUPE: AlertKind[] = ["restart"];

/**
 * Queue an alert for the notifier. The same kind + text from the same source is suppressed for
 * 10 minutes, so a reconnect loop can't flood the chat.
 */
export function raiseAlert(db: DB, a: Alert, now = Date.now()): boolean {
  if (!NO_DEDUPE.includes(a.kind)) {
    const recent = db.prepare("SELECT 1 FROM alerts WHERE source = ? AND kind = ? AND text = ? AND ts > ? LIMIT 1").get(a.source, a.kind, a.text, now - DEDUPE_MS);
    if (recent) return false;
  }
  db.prepare("INSERT INTO alerts (ts, level, kind, source, text, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, a.level ?? "error", a.kind, a.source, a.text.slice(0, 3500), a.data ? JSON.stringify(a.data) : null);
  return true;
}
