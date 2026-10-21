import * as genz from "./messages-genz.js";
import * as plain from "./messages.js";
import { shorten } from "./messages-short.js";

/** Every message function, in either voice (the compiler checks Gen Z has them all). */
export type Messages = typeof plain;
/** "-short": one line per message (messages-short.ts), in that voice's words for everything else. */
export type Voice = "plain" | "genz" | "plain-short" | "genz-short";
export const VOICES: Record<"plain" | "genz", Messages> = { plain, genz };

/**
 * The wording in use. Everything that words a message (notifier, data, telegram) reads it from
 * here, so one setting (notifier.voice) switches every message at once.
 */
export let M: Messages = plain;

export function setVoice(v: Voice): void {
  M = v.endsWith("-short") ? shorten(VOICES[v.replace("-short", "") as "plain" | "genz"]) : VOICES[v as "plain" | "genz"];
}
