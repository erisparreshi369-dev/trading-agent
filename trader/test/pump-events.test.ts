import { describe, expect, it } from "vitest";
import { decodeEvent, encodeCreate, encodeTrade, eventsFromLogs, priceSol, PUMP_PROGRAM } from "../src/collector/pump-events.js";
import { key, sampleTrade } from "./helpers.js";

describe("pump event decoding", () => {
  it("round-trips a TradeEvent including the trailing quote mint", () => {
    const t = sampleTrade();
    const ev = decodeEvent(encodeTrade(t));
    expect(ev).toEqual({ kind: "trade", ...t });
  });

  it("decodes an older, shorter TradeEvent with only the leading fields", () => {
    const t = sampleTrade();
    const full = encodeTrade(t);
    const short = full.subarray(0, 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 * 4);
    const ev = decodeEvent(short);
    expect(ev).toMatchObject({ kind: "trade", mint: t.mint, user: t.user, solLamports: t.solLamports, fee: null, quoteMint: null });
  });

  it("decodes a CreateEvent", () => {
    const c = { name: "Doge 🐶", symbol: "DOGE", uri: "https://x/y.json", mint: key(), bondingCurve: key(), user: key(), creator: key(), timestamp: 1_760_000_123 };
    expect(decodeEvent(encodeCreate(c))).toMatchObject({ kind: "create", ...c });
  });

  it("ignores unknown discriminators and truncated required fields", () => {
    expect(decodeEvent(Buffer.alloc(40))).toBeNull();
    expect(() => decodeEvent(encodeTrade(sampleTrade()).subarray(0, 20))).toThrow(/truncated/);
  });

  it("only takes Program data emitted by the pump program, across CPI nesting", () => {
    const t = sampleTrade();
    const data = encodeTrade(t).toString("base64");
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
      `Program data: ${data}`, // emitted by the aggregator, not pump: ignore
      `Program ${PUMP_PROGRAM} invoke [2]`,
      "Program log: Instruction: Buy",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      `Program data: ${data}`, // pump: take
      `Program ${PUMP_PROGRAM} consumed 40000 of 200000 compute units`,
      `Program ${PUMP_PROGRAM} success`,
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
    ];
    const evs = eventsFromLogs(logs);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "trade", mint: t.mint });
  });

  it("computes price in SOL per token from virtual reserves", () => {
    // pump.fun initial curve: 30 SOL / 1.073B tokens
    expect(priceSol(30_000_000_000n, 1_073_000_000_000_000n)).toBeCloseTo(2.796e-8, 10);
  });
});
