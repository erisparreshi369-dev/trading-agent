import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { log, scrubSecrets } from "../lib/log.js";
import { M } from "./voice.js";

export interface Command {
  name: string; // without the slash, lowercased, @botname stripped
  args: string;
  from: string;
  /** text of the message this command replied to (for /explain) */
  replyText?: string;
}

export interface Button {
  text: string;
  data: string; // comes back in the Tap when pressed (max 64 bytes)
}

/** A reply: plain text, or text with a row of buttons under it. */
export type Reply = string | { text: string; buttons: Button[][] } | null;

/** Someone pressed one of our buttons. */
export interface Tap {
  data: string;
  from: string;
}

/** What to do with the message whose button was pressed: replace its text (the buttons go away). */
export type TapResult = { edit: string } | null;

interface Queued {
  text: string;
  buttons?: Button[][];
  resolve: (ok: boolean) => void;
}

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { username?: string; id: number }; reply_to_message?: { text?: string } };
  callback_query?: { id: string; data?: string; from?: { username?: string; id: number }; message?: { message_id: number; chat: { id: number } } };
};

const MAX_LEN = 4000; // Telegram's limit is 4096

/**
 * Minimal Telegram Bot API client. Messages go through a queue spaced ~1/s (Telegram's per-chat
 * limit) and honour 429 retry_after. Commands are accepted from the configured chat only.
 */
export class Telegram {
  private queue: Queued[] = [];
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
  send(reply: Reply): Promise<boolean> {
    if (!reply) return Promise.resolve(true);
    const { text, buttons } = typeof reply === "string" ? { text: reply, buttons: undefined } : reply;
    const parts = chunk(scrubSecrets(text));
    let last: Promise<boolean> = Promise.resolve(true);
    // buttons go under the last part
    parts.forEach((p, i) => (last = new Promise((resolve) => this.queue.push({ text: p, buttons: i === parts.length - 1 ? buttons : undefined, resolve }))));
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

  /** Long-poll for commands and button presses until stop(). Only the configured chat is listened to. */
  async poll(onCommand: (c: Command) => Promise<Reply>, onTap: (t: Tap) => Promise<TapResult> = async () => null): Promise<void> {
    this.polling = true;
    while (this.polling) {
      try {
        const r = await this.api("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
        for (const u of (r.result ?? []) as Update[]) {
          this.offset = u.update_id + 1;
          if (u.callback_query) await this.handleTap(u.callback_query, onTap);
          const m = u.message;
          if (!m?.text?.startsWith("/")) continue;
          if (!this.ours(m.chat.id)) continue;
          const [head, ...rest] = m.text.trim().split(/\s+/);
          const cmd: Command = {
            name: head!.slice(1).split("@")[0]!.toLowerCase(), args: rest.join(" "), from: m.from?.username ?? String(m.from?.id ?? "?"),
            replyText: m.reply_to_message?.text,
          };
          const reply = await onCommand(cmd).catch((err) => {
            log.error({ err: String(err), cmd: cmd.name }, "telegram command failed");
            return M.commandFailed();
          });
          await this.send(reply);
        }
      } catch (err) {
        if (!this.polling) break;
        log.warn({ err: scrubSecrets(String(err)) }, "telegram poll failed, retrying");
        await sleep(5_000);
      }
    }
  }

  private ours(chat: number | undefined): boolean {
    if (String(chat) === this.chatId) return true;
    this.stats.ignoredChats++;
    log.warn({ chat }, "telegram update from unknown chat ignored");
    return false;
  }

  private async handleTap(q: NonNullable<Update["callback_query"]>, onTap: (t: Tap) => Promise<TapResult>): Promise<void> {
    if (!q.message || !this.ours(q.message.chat.id)) return;
    const result = await onTap({ data: q.data ?? "", from: q.from?.username ?? String(q.from?.id ?? "?") }).catch((err) => {
      log.error({ err: String(err) }, "telegram button failed");
      return null;
    });
    await this.api("answerCallbackQuery", { callback_query_id: q.id }).catch(() => undefined); // stops the button's spinner
    if (result) {
      await this.api("editMessageText", { chat_id: this.chatId, message_id: q.message.message_id, text: scrubSecrets(result.edit).slice(0, MAX_LEN) })
        .catch((err) => log.warn({ err: scrubSecrets(String(err)) }, "telegram edit failed"));
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
            const r = await this.api("sendMessage", {
              chat_id: this.chatId, text: item.text, disable_web_page_preview: true,
              ...(item.buttons ? { reply_markup: { inline_keyboard: item.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
            });
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
