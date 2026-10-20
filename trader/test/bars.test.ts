import { describe, expect, it } from "vitest";
import { BarAggregator, type BarTrade } from "../src/collector/bars.js";

const cfg = { fine_bucket_ms: 5_000, fine_window_ms: 60_000, coarse_bucket_ms: 30_000, coarse_window_ms: 120_000 };
const T0 = 999_999_990_000; // aligned to every bucket width used below (bars are epoch-aligned)
const M = 1_000_000n; // 1 whole token in raw units

function trade(ts: number, price: number, over: Partial<BarTrade> = {}): BarTrade {
  return { mint: "MINT", wallet: "A", isBuy: true, solLamports: 1_000_000n, tokenAmount: 1000n * M, vSol: 31n, price, ts, ...over };
}

describe("BarAggregator", () => {
  it("builds OHLCV and emits a bar when the next bucket starts", () => {
    const a = new BarAggregator(cfg);
    a.addToken("MINT", T0, "DEV");
    expect(a.onTrade(trade(T0 + 100, 1))).toEqual([]);
    a.onTrade(trade(T0 + 200, 3, { wallet: "B" }));
    a.onTrade(trade(T0 + 300, 0.5, { isBuy: false, tokenAmount: 10n * M }));
    a.onTrade(trade(T0 + 400, 2));
    const [bar] = a.onTrade(trade(T0 + 5_100, 2));
    expect(bar).toMatchObject({ ts: T0, bucket_ms: 5_000, open: 1, high: 3, low: 0.5, close: 2, buys: 3, sells: 1, unique_traders: 2, volume_lamports: 4_000_000 });
  });

  it("tracks holders, top10 and dev share from trades", () => {
    const a = new BarAggregator(cfg);
    a.addToken("MINT", T0, "DEV");
    a.onTrade(trade(T0, 1, { wallet: "DEV", tokenAmount: 50_000_000n * M })); // 5% of supply
    for (let i = 0; i < 12; i++) a.onTrade(trade(T0 + 1 + i, 1, { wallet: `W${i}`, tokenAmount: BigInt(i + 1) * 1_000_000n * M }));
    a.onTrade(trade(T0 + 50, 1, { wallet: "W0", isBuy: false, tokenAmount: 1_000_000n * M })); // W0 fully exits
    const [bar] = a.flush(T0 + 10_000);
    expect(bar!.holders).toBe(12); // DEV + W1..W11
    expect(bar!.dev_pct).toBe(5);
    // top10 = DEV 50M + W11..W3 (12+11+...+4 = 72M) = 122M = 12.2%
    expect(bar!.top10_pct).toBe(12.2);
  });

  it("switches to coarse buckets after the fine window and stops after the coarse window", () => {
    const a = new BarAggregator(cfg);
    a.addToken("MINT", T0, null);
    a.onTrade(trade(T0 + 61_000, 1));
    const [coarse] = a.flush(T0 + 100_000);
    expect(coarse).toMatchObject({ bucket_ms: 30_000, ts: T0 + 60_000, holders: null }); // balances dropped after fine window
    expect(a.onTrade(trade(T0 + 130_000, 1))).toEqual([]);
    expect(a.flush(T0 + 200_000)).toEqual([]);
    expect(a.has("MINT")).toBe(false);
  });

  it("folds a late trade into the open bar instead of reopening a closed bucket", () => {
    const a = new BarAggregator(cfg);
    a.addToken("MINT", T0, null);
    a.onTrade(trade(T0 + 100, 1));
    a.onTrade(trade(T0 + 5_100, 2)); // closes bucket 0
    expect(a.onTrade(trade(T0 + 4_900, 9))).toEqual([]);
    const [bar] = a.flush(T0 + 20_000);
    expect(bar).toMatchObject({ ts: T0 + 5_000, high: 9, buys: 2 });
  });

  it("ignores trades for tokens it was not told about", () => {
    const a = new BarAggregator(cfg);
    expect(a.onTrade(trade(T0, 1))).toEqual([]);
    expect(a.flush(T0 + 100_000)).toEqual([]);
  });
});
