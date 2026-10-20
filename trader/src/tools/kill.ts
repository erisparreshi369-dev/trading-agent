/**
 * Operator kill switch.
 *   npm run kill -- "reason"      trip it (the trader flattens everything and stops entering)
 *   npm run unkill -- --yes       clear it: a deliberate human action, never automatic
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { env, ROOT } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { RiskManager } from "../risk/risk-manager.js";

const KILL_FILE = resolve(ROOT, "data/KILL");
const [cmd, ...rest] = process.argv.slice(2);
const db = openDb(env.dbPath);

if (cmd === "kill") {
  new RiskManager(db, KILL_FILE).kill(rest.join(" ") || "manual");
  console.log("kill switch ON");
} else if (cmd === "unkill") {
  if (!rest.includes("--yes")) {
    console.error("refusing: pass --yes to clear the kill switch");
    process.exit(1);
  }
  db.prepare("UPDATE risk_state SET kill_switch = 0, kill_reason = NULL, kill_at = NULL WHERE id = 1").run();
  if (existsSync(KILL_FILE)) unlinkSync(KILL_FILE);
  console.log("kill switch cleared");
} else {
  const r = db.prepare("SELECT kill_switch, kill_reason, kill_at FROM risk_state WHERE id = 1").get();
  console.log(r, existsSync(KILL_FILE) ? `(+ ${KILL_FILE} exists)` : "");
}
db.close();
