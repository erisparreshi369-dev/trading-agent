/** Daily MadeOnSol intel job: `node dist/intel/index.js` (systemd timer trading-intel, 00:02 UTC). */
import { env, loadConfig } from "../lib/config.js";
import { heartbeat, openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { runIntel } from "./jobs.js";
import { MadeOnSol } from "./madeonsol.js";

const cfg = loadConfig();
const key = process.env[cfg.madeonsol.key_env]?.trim();
if (!cfg.madeonsol.enabled || !key) {
  log.info({ enabled: cfg.madeonsol.enabled, key: !!key }, "madeonsol intel: off (disabled or no key), nothing to do");
  process.exit(0);
}
const db = openDb(env.dbPath);
const t0 = Date.now();
const api = new MadeOnSol(db, cfg.madeonsol, key);
try {
  const summary = await runIntel(db, cfg.madeonsol, api, t0);
  heartbeat(db, "intel", { ...summary, seconds: +((Date.now() - t0) / 1000).toFixed(1), usedToday: api.usedToday(), limit: cfg.madeonsol.daily_requests });
  log.info(summary, "madeonsol intel done");
} catch (err) {
  // a helper job: report and exit cleanly, the bot doesn't depend on it
  log.error({ err: err instanceof Error ? err.message : String(err) }, "madeonsol intel job failed");
} finally {
  db.close();
}
