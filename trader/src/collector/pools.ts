import { PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM } from "./amm-events.js";
import { PUMP_PROGRAM, WSOL_MINT } from "./pump-events.js";

const PUMP = new PublicKey(PUMP_PROGRAM);
const AMM = new PublicKey(PUMPSWAP_PROGRAM);

/** Canonical PumpSwap pool a pump.fun token migrates into (index 0, quote = WSOL). */
export function canonicalPool(mint: string, quoteMint = WSOL_MINT): string {
  const m = new PublicKey(mint);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), m.toBuffer()], PUMP);
  const index = Buffer.alloc(2); // u16 LE 0
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, authority.toBuffer(), m.toBuffer(), new PublicKey(quoteMint).toBuffer()],
    AMM,
  )[0].toBase58();
}

/** Bonding curve PDA for a mint. */
export function bondingCurve(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP)[0].toBase58();
}
