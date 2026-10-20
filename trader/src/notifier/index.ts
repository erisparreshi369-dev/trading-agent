import { resolve } from "node:path";
import { env, loadConfig, ROOT } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { attachAlerts, markStarted, runService } from "../lib/service.js";
import { Notifier, SERVICE } from "./notifier.js";
import { solUsd } from "./price.js";
import { Telegram } from "./telegram.js";

const token = env.telegramToken(), chatId = env.telegramChatId();
if (!token || !chatId) {
  log.fatal("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env (npm run telegram:setup finds the chat id)");
  process.exit(1);
}
const cfg = loadConfig();
const db = openDb(env.dbPath);
attachAlerts(db, SERVICE);
const previous = markStarted(db, SERVICE);
const notifier = new Notifier({
  db, cfg, telegram: new Telegram(token, chatId), killFile: resolve(ROOT, "data/KILL"), reportsDir: resolve(ROOT, "reports"),
  usdPrice: cfg.notifier.usd_prices ? solUsd : undefined,
});
notifier.start(previous);
runService(SERVICE, () => {
  notifier.stop();
  db.close();
}, db);
