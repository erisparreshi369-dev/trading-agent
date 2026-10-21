import { resolve } from "node:path";
import { env, heliusRpcUrl, loadConfig, ROOT } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { followOverrides } from "../lib/overrides.js";
import { attachAlerts, markStarted, refuseToStart, runService } from "../lib/service.js";
import { RpcTokenInfo } from "../signals/token-info.js";
import { SERVICE, Trader } from "./trader.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
attachAlerts(db, SERVICE);
markStarted(db, SERVICE);
if (env.liveTrading) {
  // Phase 5 adds the live executor. Until then refuse to run rather than pretend.
  refuseToStart("live_not_ready", "LIVE_TRADING=true but no live executor exists yet; refusing to start");
}
const rpc = heliusRpcUrl();
if (!rpc) {
  refuseToStart("helius_key_missing", "HELIUS_API_KEY is required for the trader's on-chain signal checks");
}
const trader = new Trader(db, cfg, new RpcTokenInfo(rpc), resolve(ROOT, "data/KILL"));
followOverrides(cfg, db, { onChange: () => trader.settingsChanged() }); // the owner's limits from the dashboard, kept in step
trader.start();
runService(SERVICE, async () => {
  await trader.stop();
  db.close();
}, db);
