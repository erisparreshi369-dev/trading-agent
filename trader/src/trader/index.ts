import { resolve } from "node:path";
import { env, heliusRpcUrl, loadConfig, ROOT } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { RpcTokenInfo } from "../signals/token-info.js";
import { Trader } from "./trader.js";

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

const cfg = loadConfig();
const db = openDb(env.dbPath);
const trader = new Trader(db, cfg, new RpcTokenInfo(rpc), resolve(ROOT, "data/KILL"));
trader.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  try {
    await trader.stop();
    db.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log.fatal({ err: err.stack ?? String(err) }, "uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.fatal({ err: String(err) }, "unhandled rejection");
  process.exit(1);
});
