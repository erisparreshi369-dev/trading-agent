import { env, loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { Collector } from "./collector.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
const collector = new Collector({ db, cfg: cfg.collector, heliusApiKey: env.heliusApiKey() });
collector.start();

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  try {
    collector.stop();
    db.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Fail loudly: systemd restarts us; a half-dead collector silently losing data is worse.
process.on("uncaughtException", (err) => {
  log.fatal({ err: err.stack ?? String(err) }, "uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.fatal({ err: String(err) }, "unhandled rejection");
  process.exit(1);
});
