import { raiseAlert, type AlertKind } from "./alerts.js";
import type { DB } from "./db.js";
import { log, scrubSecrets, setAlertSink } from "./log.js";

/**
 * Wire a service's error logs into the alert outbox. A log names its alert with `alert: "<kind>"`;
 * other errors become kind "error". A fatal log means the process is about to die: it is recorded
 * as the crash cause instead of being sent on its own (the notifier decides whether a crash is
 * worth a message once it sees whether the service came back).
 */
export function attachAlerts(db: DB, service: string): void {
  setAlertSink((level, obj, msg) => {
    const detail = obj.err ?? obj.error ?? obj.reason ?? "";
    const text = scrubSecrets(`${msg}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`).slice(0, 600);
    const kind = typeof obj.alert === "string" ? (obj.alert as AlertKind) : level === "fatal" ? null : "error";
    if (level === "fatal") {
      db.prepare("UPDATE service_runs SET state = 'crashed', detail = ?, changed_at = ? WHERE service = ? AND state = 'running'")
        .run(kind ? `${kind}: ${text}` : text, Date.now(), service);
    }
    if (kind) {
      const { alert: _, err: __, ...data } = obj;
      raiseAlert(db, { kind, source: service, text, data, level });
    }
  });
}

export type RunState = "running" | "stopped" | "crashed";

function setState(db: DB, service: string, state: RunState, now = Date.now()): void {
  db.prepare(`INSERT INTO service_runs (service, state, pid, changed_at, detail) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(service) DO UPDATE SET state = excluded.state, pid = excluded.pid, changed_at = excluded.changed_at,
    detail = CASE WHEN excluded.state = 'running' THEN NULL ELSE service_runs.detail END`).run(service, state, process.pid, now);
}

/**
 * Record that `service` is starting. If its previous run crashed, or never reached a clean
 * shutdown (kill -9, out of memory, power loss), queue a "restart" event: the notifier groups these.
 * Returns the previous state (null on the very first start).
 */
export function markStarted(db: DB, service: string, now = Date.now()): RunState | null {
  const prev = db.prepare("SELECT state, detail FROM service_runs WHERE service = ?").get(service) as { state: RunState; detail: string | null } | undefined;
  if (prev && prev.state !== "stopped") {
    const cause = prev.state === "crashed" ? "crash" : "killed";
    raiseAlert(db, { kind: "restart", source: service, level: "warn", text: `${service} restarted after ${cause === "crash" ? `a crash: ${prev.detail ?? "?"}` : "dying without a clean shutdown"}`,
      data: { cause, detail: prev.detail } }, now);
  }
  setState(db, service, "running", now);
  return prev?.state ?? null;
}

/**
 * A service that can't run with the current settings: tell the human what's missing, and exit.
 * (systemd keeps retrying; the notifier stays quiet about those restarts.)
 */
export function refuseToStart(why: string, text: string): never {
  log.fatal({ alert: "startup_blocked", why }, text);
  process.exit(1);
}

/**
 * Standard process lifecycle: graceful SIGINT/SIGTERM, crash loudly (systemd restarts us).
 * Pass the db to record clean/unclean exits for markStarted().
 */
export function runService(name: string, stop: () => void | Promise<void>, db?: DB): void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, `${name} shutting down`);
    try {
      if (db?.open) setState(db, name, "stopped");
    } catch {
      // best effort: we're on the way out
    }
    try {
      await stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // the fatal log marks the run as crashed (see attachAlerts)
  process.on("uncaughtException", (err) => {
    log.fatal({ err: err.stack ?? String(err) }, `${name} crashed`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log.fatal({ err: String(err) }, `${name} crashed (unhandled rejection)`);
    process.exit(1);
  });
}
