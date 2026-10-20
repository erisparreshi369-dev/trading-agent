import { resolve } from "node:path";
import { env, heliusRpcUrl, loadConfig, ROOT } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { attachAlerts, markStarted, runService } from "../lib/service.js";
import { RpcTokenInfo } from "../signals/token-info.js";
import { SERVICE, Trader } from "./trader.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
attachAlerts(db, SERVICE);
markStarted(db, SERVICE);
if (env.liveTrading) {
  // Phase 5 adds the live executor. Until then refuse to run rather than pretend.
  log.fatal("LIVE_TRADING=true but no live executor exists yet; refusing to start");
  process.exit(1);
}
const rpc = heliusRpcUrl();
if (!rpc) {
  log.fatal("HELIUS_API_KEY is required for the trader's on-chain signal checks");
  process.exit(1);
}
const trader = new Trader(db, cfg, new RpcTokenInfo(rpc), resolve(ROOT, "data/KILL"));
trader.start();
runService(SERVICE, async () => {
  await trader.stop();
  db.close();
}, db);
