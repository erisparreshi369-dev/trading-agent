/** The mistake checker: `make check` (systemd timer trading-checker, every 10 minutes). */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { raiseAlert } from "../lib/alerts.js";
import { env, loadConfig, ROOT } from "../lib/config.js";
import { heartbeat, openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { followOverrides } from "../lib/overrides.js";
import { limitsFor } from "../risk/limits.js";
import { findMistakes, KINDS, saveMistakes } from "./checks.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
followOverrides(cfg, db, { everyMs: 0 }); // the owner's limits from the dashboard, once
const now = Date.now();
const run = db.prepare("SELECT changed_at FROM service_runs WHERE service = 'trader' AND state = 'running'").get() as { changed_at: number } | undefined;
const found = findMistakes(db, {
  signals: cfg.signals, paper: cfg.paper, limits: limitsFor("paper", db), now,
  traderStartedAt: run?.changed_at ?? null, configChangedAt: statSync(resolve(ROOT, "config/config.yaml")).mtimeMs,
});
// the first run finds the history: shown on the dashboard, not sent to Telegram
const firstRun = !db.prepare("SELECT 1 FROM kv WHERE key = 'checker.started_at'").get();
const fresh = saveMistakes(db, found, now, !firstRun);
if (firstRun) db.prepare("INSERT INTO kv (key, value) VALUES ('checker.started_at', ?)").run(String(now));
if (fresh.length && !firstRun) {
  const kinds = [...new Set(fresh.map((m) => m.kind))];
  raiseAlert(db, {
    kind: "mistake", source: "checker", level: "warn", text: `${fresh.length} mistake(s): ${fresh.map((m) => m.key).join(", ")}`,
    data: { n: fresh.length, first: KINDS[fresh[0]!.kind], kinds },
  }, now);
}
const summary = { checked: (db.prepare("SELECT count(*) n FROM paper_positions").get() as { n: number }).n, found: found.length, new: fresh.length, firstRun };
heartbeat(db, "checker", summary);
log.info(summary, "mistake check done");
for (const m of fresh) console.log(m.text);
db.close();
