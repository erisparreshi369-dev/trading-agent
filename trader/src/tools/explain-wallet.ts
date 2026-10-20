/** Show every scored position of one wallet, as the leader did it and as we'd have followed it. */
import { env, loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { scoreWallets, type PositionStats } from "../scoring/score.js";

const wallet = process.argv[2];
if (!wallet) throw new Error("usage: explain-wallet <wallet>");
const cfg = loadConfig();
const db = openDb(env.dbPath);
const rows: PositionStats[] = [];
scoreWallets(db, cfg.scoring, cfg.paper, Date.now(), (p) => p.wallet === wallet && rows.push(p));
const f = (x: number) => (x * 1e9).toFixed(1);
for (const p of rows.sort((a, b) => a.entryAt - b.entryAt)) {
  const own = p.closed ? `${(((p.proceeds - p.cost) / p.cost) * 100).toFixed(0)}%` : "open";
  const copy = typeof p.copy === "string" ? p.copy
    : `${(p.copy.roi * 100).toFixed(0)}% (${p.copy.trigger}, ${f(p.copy.entryPrice)} -> ${f(p.copy.exitPrice)}, held ${((p.copy.exitAt - p.copy.entryAt) / 1000).toFixed(0)}s)`;
  console.log(`${p.mint.slice(0, 6)} ${new Date(p.entryAt).toISOString().slice(11, 19)} buy ${p.buySol.toFixed(3)}  leader ${own.padStart(5)}  copy ${copy}`);
}
db.close();
