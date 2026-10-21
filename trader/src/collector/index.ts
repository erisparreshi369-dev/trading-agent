import { env, loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { followOverrides } from "../lib/overrides.js";
import { attachAlerts, markStarted, runService } from "../lib/service.js";
import { Collector, SERVICE } from "./collector.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
attachAlerts(db, SERVICE);
markStarted(db, SERVICE);
followOverrides(cfg, db); // the owner's limits from the dashboard, kept in step every few seconds
const collector = new Collector({ db, cfg: cfg.collector, providers: cfg.providers, heliusApiKey: env.heliusApiKey() });
collector.start();
runService(SERVICE, () => {
  collector.stop();
  db.close();
}, db);
