/**
 * `make costs`: does a bigger position cut the cost share? Replays every copyable position in the
 * scoring window (all wallets, not just tracked ones) at several sizes with the paper cost model
 * and prints the average cost per round trip by kind, and ROI.
 * Usage: tsx src/tools/cost-by-size.ts [sizes...]   (default 0.01 0.02 0.05 0.1 0.25 0.5)
 */
import { env, loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { scoreWallets } from "../scoring/score.js";
import { totalCost, type CostBreakdown } from "../sim/market.js";

const cfg = loadConfig();
const db = openDb(env.dbPath);
const sizes = process.argv.slice(2).map(Number).filter((x) => x > 0);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`.padStart(8);

console.log(`copyable positions over the last ${cfg.scoring.lookback_days} days; costs per round trip as % of size\n`);
console.log("size SOL   trades  platform  executor  priority  slippage     total   fixed SOL  mean ROI  median ROI");
for (const size of sizes.length ? sizes : [0.01, 0.02, 0.05, 0.1, 0.25, 0.5]) {
  const costs: CostBreakdown[] = [];
  const rois: number[] = [];
  scoreWallets(db, { ...cfg.scoring, copy_size_sol: size }, cfg.paper, Date.now(), (p) => {
    if (typeof p.copy === "string") return;
    costs.push(p.copy.costs);
    rois.push(p.copy.roi);
  });
  if (!costs.length) continue;
  const avg = (k: keyof CostBreakdown) => costs.reduce((a, c) => a + c[k], 0) / costs.length / size;
  rois.sort((a, b) => a - b);
  console.log(`${String(size).padEnd(9)} ${String(costs.length).padStart(7)} ${pct(avg("platformSol"))}  ${pct(avg("executorSol"))}  ${pct(avg("prioritySol"))}  ` +
    `${pct(avg("slippageSol"))}  ${pct(costs.reduce((a, c) => a + totalCost(c), 0) / costs.length / size)}  ${(2 * cfg.paper.priority_fee_sol).toFixed(4).padStart(10)}  ` +
    `${pct(rois.reduce((a, r) => a + r, 0) / rois.length)}  ${pct(rois[Math.floor(rois.length / 2)]!)}`);
}
db.close();
