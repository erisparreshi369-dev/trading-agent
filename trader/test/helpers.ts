import { Keypair } from "@solana/web3.js";
import { encodeTrade, WSOL_MINT } from "../src/collector/pump-events.js";

export const key = () => Keypair.generate().publicKey.toBase58();

export function sampleTrade(over: Partial<Parameters<typeof encodeTrade>[0]> = {}) {
  return {
    mint: key(), solLamports: 500_000_000n, tokenAmount: 17_000_000_000_000n, isBuy: true, user: key(),
    timestamp: 1_760_000_000, vSol: 30_500_000_000n, vToken: 1_055_000_000_000_000n, realSol: 500_000_000n,
    realToken: 776_000_000_000_000n, fee: 4_750_000n, creator: key(), creatorFee: 250_000n, ixName: "buy", quoteMint: WSOL_MINT,
    ...over,
  };
}
