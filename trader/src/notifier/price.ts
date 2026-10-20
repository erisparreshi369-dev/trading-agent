import { log } from "../lib/log.js";

/** SOL in US dollars from CoinGecko's free endpoint (no key). Null on any failure: messages then show SOL only. */
export async function solUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8_000) });
    const v = ((await res.json()) as { solana?: { usd?: number } }).solana?.usd;
    return typeof v === "number" && v > 0 ? v : null;
  } catch (err) {
    log.warn({ err: String(err) }, "SOL price fetch failed");
    return null;
  }
}
