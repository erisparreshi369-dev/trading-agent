import { raiseAlert } from "./alerts.js";
import type { DB } from "./db.js";
import { log, scrubSecrets, setAlertSink } from "./log.js";

/** Wire a service's error logs into the alert outbox. */
export function attachAlerts(db: DB, service: string): void {
  setAlertSink((level, obj, msg) => {
    const detail = obj.err ?? obj.error ?? obj.reason ?? "";
    const text = scrubSecrets(`${msg}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`).slice(0, 600);
    raiseAlert(db, level, service, text);
  });
}

type RunState = "running" | "stopped" | "crashed";

function setState(db: DB, service: string, state: RunState): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`run_state.${service}`, state);
}

/**
 * Record that `service` is starting. If its previous run never reached a clean shutdown or a
 * logged crash, it died hard (kill -9, out of memory, power loss): alert about that.
 */
export function markStarted(db: DB, service: string, now = Date.now()): void {
  const prev = (db.prepare("SELECT value FROM kv WHERE key = ?").get(`run_state.${service}`) as { value: string } | undefined)?.value;
  if (prev === "running" || prev === "crashed") {
    // count per day: every crash gets reported (a count makes each alert distinct, so the outbox
    // dedupe can't swallow a repeat), and a rising count is itself the signal
    const key = `crashes.${service}.${new Date(now).toISOString().slice(0, 10)}`;
    db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(key);
    const n = Number((db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string }).value);
    const nth = `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
    if (prev === "running") raiseAlert(db, "error", service, `${service} restarted after dying without a clean shutdown (killed, out of memory, or power loss), ${nth} time today`, now);
    else raiseAlert(db, "info", service, `${service} is back up after the crash (${nth} today)`, now);
  }
  setState(db, service, "running");
}

/**
 * Standard process lifecycle: graceful SIGINT/SIGTERM, crash loudly (systemd restarts us).
 * Pass the db to record clean/unclean exits for markStarted().
 */
export function runService(name: string, stop: () => void | Promise<void>, db?: DB): void {
  let stopping = false;
  const mark = (s: RunState) => {
    try {
      if (db?.open) setState(db, name, s);
    } catch {
      // best effort: we're on the way out
    }
  };
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, `${name} shutting down`);
    mark("stopped");
    try {
      await stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log.fatal({ err: err.stack ?? String(err) }, `${name} crashed`); // alerted via the sink
    mark("crashed");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log.fatal({ err: String(err) }, `${name} crashed (unhandled rejection)`);
    mark("crashed");
    process.exit(1);
  });
}
