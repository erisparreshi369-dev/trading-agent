import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { log, scrubSecrets } from "../lib/log.js";

export interface Command {
  name: string; // without the slash, lowercased, @botname stripped
  args: string;
  from: string;
}

const MAX_LEN = 4000; // Telegram's limit is 4096

/**
 * Minimal Telegram Bot API client. Messages go through a queue spaced ~1/s (Telegram's per-chat
 * limit) and honour 429 retry_after. Commands are accepted from the configured chat only.
 */
export class Telegram {
  private queue: { text: string; resolve: (ok: boolean) => void }[] = [];
  private sending = false;
  private offset = 0;
  private polling = false;
  stats = { sent: 0, failed: 0, ignoredChats: 0 };

  constructor(
    private token: string,
    private chatId: string,
    private apiBase = "https://api.telegram.org",
    private spacingMs = 1_100,
  ) {}

  /** Queue a message. Resolves true once delivered, false if it ultimately failed. */
  send(text: string): Promise<boolean> {
    const parts = chunk(scrubSecrets(text));
    let last: Promise<boolean> = Promise.resolve(true);
    for (const p of parts) last = new Promise((resolve) => this.queue.push({ text: p, resolve }));
    void this.drain();
    return last;
  }

  async sendDocument(path: string, caption: string): Promise<boolean> {
    const form = new FormData();
    form.set("chat_id", this.chatId);
    form.set("caption", scrubSecrets(caption).slice(0, 1000));
    form.set("document", new Blob([readFileSync(path)]), basename(path));
    try {
      const r = await this.api("sendDocument", form);
      return r.ok;
    } catch (err) {
      log.warn({ err: scrubSecrets(String(err)) }, "telegram sendDocument failed");
      return false;
    }
  }

  /** Long-poll for commands until stop(). */
  async poll(onCommand: (c: Command) => Promise<string | null>): Promise<void> {
    this.polling = true;
    while (this.polling) {
      try {
        const r = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
        for (const u of (r.result ?? []) as { update_id: number; message?: { chat: { id: number }; text?: string; from?: { username?: string; id: number } } }[]) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text?.startsWith("/")) continue;
          if (String(m.chat.id) !== this.chatId) {
            this.stats.ignoredChats++;
            log.warn({ chat: m.chat.id }, "telegram command from unknown chat ignored");
            continue;
          }
          const [head, ...rest] = m.text.trim().split(/\s+/);
          const cmd: Command = { name: head!.slice(1).split("@")[0]!.toLowerCase(), args: rest.join(" "), from: m.from?.username ?? String(m.from?.id ?? "?") };
          const reply = await onCommand(cmd).catch((err) => `error: ${String(err).slice(0, 200)}`);
          if (reply) await this.send(reply);
        }
      } catch (err) {
        if (!this.polling) break;
        log.warn({ err: scrubSecrets(String(err)) }, "telegram poll failed, retrying");
        await sleep(5_000);
      }
    }
  }

  stop(): void {
    this.polling = false;
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0]!;
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          try {
            const r = await this.api("sendMessage", { chat_id: this.chatId, text: item.text, disable_web_page_preview: true });
            if (r.ok) ok = true;
            else if (r.error_code === 429) await sleep(((r.parameters?.retry_after as number) ?? 5) * 1000);
            else {
              log.warn({ code: r.error_code, desc: r.description }, "telegram rejected message");
              break;
            }
          } catch (err) {
            log.warn({ err: scrubSecrets(String(err)) }, "telegram send failed");
            await sleep(2_000 * (attempt + 1));
          }
        }
        this.queue.shift();
        if (ok) this.stats.sent++;
        else this.stats.failed++;
        item.resolve(ok);
        await sleep(this.spacingMs);
      }
    } finally {
      this.sending = false;
    }
  }

  private async api(method: string, body: Record<string, unknown> | FormData, timeoutMs = 15_000) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: Record<string, unknown> };
  }
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    const cut = rest.lastIndexOf("\n", MAX_LEN) > MAX_LEN / 2 ? rest.lastIndexOf("\n", MAX_LEN) : MAX_LEN;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
