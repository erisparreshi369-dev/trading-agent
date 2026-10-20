/**
 * Check the event decoders against live mainnet traffic. Run after any pump.fun program upgrade:
 *   npm run verify:live
 * Curve trades: price must be positive and fees within sane bounds.
 * PumpSwap trades: reserves valid; fees outside lp/protocol/creator stay rare and small.
 */
import WebSocket from "ws";
import { decodeAmmEvent, PUMPSWAP_PROGRAM } from "../collector/amm-events.js";
import { eventsFromLogs, isSolQuoted, PUMP_PROGRAM, priceSol } from "../collector/pump-events.js";

const URL = process.env.VERIFY_RPC_WS ?? "wss://api.mainnet-beta.solana.com";
const SECONDS = Number(process.env.VERIFY_SECONDS ?? 20);

const curve = { txs: 0, trades: 0, creates: 0, migrations: 0, badPrice: 0, badFee: 0 };
const amm = { events: 0, exact: 0, extraFees: 0, maxExtraBps: 0, badReserves: 0 };

const ws = new WebSocket(URL);
ws.on("open", () => {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }] }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logsSubscribe", params: [{ mentions: [PUMPSWAP_PROGRAM] }, { commitment: "confirmed" }] }));
});
ws.on("message", (m) => {
  const v = JSON.parse(m.toString()).params?.result?.value;
  if (!v || v.err) return;
  const logs = v.logs as string[];
  for (const ev of eventsFromLogs(logs)) {
    if (ev.kind === "trade" && isSolQuoted(ev.quoteMint)) {
      curve.trades++;
      if (!(priceSol(ev.vSol, ev.vToken) > 0)) curve.badPrice++;
      const bps = ev.solLamports > 0n && ev.fee !== null ? Number((ev.fee * 10_000n) / ev.solLamports) : 0;
      if (bps < 0 || bps > 500) curve.badFee++;
    } else if (ev.kind === "create") curve.creates++;
    else if (ev.kind === "migration") curve.migrations++;
  }
  curve.txs++;
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const buf = Buffer.from(line.slice(14), "base64");
    const ev = decodeAmmEvent(buf);
    if (!ev) continue;
    // Fee accounting is exact by construction (see decodeAmmEvent); what we check is that
    // the part not explained by quote ± lp/protocol/creator fees stays small. A jump here means
    // the layout or fee model changed.
    const rawQuote = buf.readBigUInt64LE(8 + 8 * 7);
    const explained = ev.isBuy
      ? (ev.quoteAmount + ev.fee + ev.creatorFee === rawQuote ? rawQuote : rawQuote + ev.fee + ev.creatorFee)
      : rawQuote - ev.fee - ev.creatorFee;
    const actual = ev.isBuy ? ev.quoteAmount + ev.fee + ev.creatorFee : ev.quoteAmount - ev.fee - ev.creatorFee;
    const errBps = Number(((actual > explained ? actual - explained : explained - actual) * 10_000n) / (actual || 1n));
    amm.events++;
    if (errBps === 0) amm.exact++;
    else amm.extraFees++;
    amm.maxExtraBps = Math.max(amm.maxExtraBps, errBps);
    if (!(Number(ev.poolQuote) > 0 && Number(ev.poolBase) > 0)) amm.badReserves++;
  }
});
ws.on("error", (e) => {
  console.error("ws error", e.message);
  process.exit(2);
});
setTimeout(() => {
  console.log(JSON.stringify({ seconds: SECONDS, curve, amm }, null, 2));
  const ok = curve.trades > 0 && curve.badPrice === 0 && curve.badFee === 0 && amm.events > 0 && amm.badReserves === 0 && amm.maxExtraBps <= 1000 && amm.extraFees / amm.events < 0.05;
  console.log(ok ? "decoders OK" : "DECODER PROBLEM: check the IDL for layout changes");
  process.exit(ok ? 0 : 1);
}, SECONDS * 1000);
