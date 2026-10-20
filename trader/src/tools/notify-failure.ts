/**
 * Called by scripts/notify-failure.sh when systemd reports a unit as failed (OnFailure=), 20s
 * after the fact, with whether the unit is active again:
 *   node dist/tools/notify-failure.js trading-trader.service active|inactive
 *
 * systemd fires OnFailure on every crash, even when Restart= brings the service straight back,
 * so most calls end here silently: the restart was recorded by markStarted() and the notifier
 * sends the grouped 🔧 message. This only speaks up when nobody else can:
 *   - a scheduled job failed (wallet scoring, weekly report, log clean-up)  -> ⚠️ via the notifier
 *   - a service is still down and the notifier itself is down             -> 🚨 straight to Telegram
 */
import { env, loadConfig } from "../lib/config.js";
import { raiseAlert } from "../lib/alerts.js";
import { openDb } from "../lib/db.js";
import { partHealth } from "../notifier/data.js";
import { partDown, type Ctx } from "../notifier/messages.js";

const [unit = "", state = "inactive"] = process.argv.slice(2);
const name = unit.replace(/^trading-/, "").replace(/\.service$/, "");
const SERVICES = ["collector", "trader", "notifier"];
const now = Date.now();
const cfg = loadConfig();
const db = openDb(env.dbPath);

const notifierUp = () => {
  const h = partHealth(db, "notifier", now, 90_000).health;
  return h === "up" || h === "starting";
};

async function sendDirect(text: string): Promise<void> {
  const token = env.telegramToken(), chat = env.telegramChatId();
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
}

if (!SERVICES.includes(name)) {
  // a timer job: it doesn't restart, so a failure is always worth a (non-urgent) message
  raiseAlert(db, { kind: "job_failed", source: name, level: "error", text: `${unit} failed`, data: { job: name } }, now);
  // if the notifier is down too, the alert waits in the outbox until it's back
} else if (state !== "active" && (name === "notifier" || !notifierUp() || !cfg.notifier.watch_services.includes(name))) {
  const ctx: Ctx = { mode: "paper", tz: cfg.notifier.timezone, usd: null, now };
  const run = db.prepare("SELECT changed_at, detail FROM service_runs WHERE service = ?").get(name) as { changed_at: number; detail: string | null } | undefined;
  await sendDirect(partDown(ctx, name, Math.min(run?.changed_at || now - 20_000, now - 20_000), run?.detail ?? null));
}
db.close();
