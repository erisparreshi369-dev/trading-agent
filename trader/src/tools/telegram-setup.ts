/**
 * Find the chat that should receive alerts and write TELEGRAM_CHAT_ID into .env.
 *   1. message your bot anything from your Telegram account
 *   2. npm run telegram:setup
 * Only the TELEGRAM_CHAT_ID line of .env is touched; nothing else is read out or printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../lib/config.js";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");

async function call<T>(method: string): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
  return body.result;
}

const me = await call<{ username: string }>("getMe");
console.log(`bot: @${me.username}`);
const updates = await call<{ message?: { chat: { id: number; type: string; username?: string; first_name?: string; title?: string } } }[]>("getUpdates");
const chats = new Map<number, string>();
for (const u of updates) {
  const c = u.message?.chat;
  if (c) chats.set(c.id, `${c.type} ${c.username ? "@" + c.username : c.first_name ?? c.title ?? ""}`);
}
if (chats.size === 0) {
  console.log(`no messages yet: open https://t.me/${me.username}, press Start / send any message, then run this again`);
  process.exit(1);
}
for (const [id, who] of chats) console.log(`chat ${id}: ${who}`);
const priv = [...chats].filter(([, who]) => who.startsWith("private"));
if (priv.length !== 1) {
  console.log("expected exactly one private chat; set TELEGRAM_CHAT_ID in .env yourself");
  process.exit(1);
}
const id = priv[0]![0];
const envPath = resolve(ROOT, ".env");
const lines = readFileSync(envPath, "utf8").split("\n");
const i = lines.findIndex((l) => l.startsWith("TELEGRAM_CHAT_ID="));
if (i >= 0) lines[i] = `TELEGRAM_CHAT_ID=${id}`;
else lines.push(`TELEGRAM_CHAT_ID=${id}`);
writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
console.log(`TELEGRAM_CHAT_ID=${id} written to .env`);
