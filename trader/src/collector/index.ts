import { env, loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { attachAlerts, markStarted, runService } from "../lib/service.js";
import { Collector, SERVICE } from "./collector.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
attachAlerts(db, SERVICE);
markStarted(db, SERVICE);
const collector = new Collector({ db, cfg: cfg.collector, providers: cfg.providers, heliusApiKey: env.heliusApiKey() });
collector.start();
runService(SERVICE, () => {
  collector.stop();
  db.close();
}, db);
