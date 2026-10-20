import * as genz from "./messages-genz.js";
import * as plain from "./messages.js";

/** Every message function, in either voice (the compiler checks Gen Z has them all). */
export type Messages = typeof plain;
export type Voice = "plain" | "genz";
export const VOICES: Record<Voice, Messages> = { plain, genz };

/**
 * The wording in use. Everything that words a message (notifier, data, telegram) reads it from
 * here, so one setting (notifier.voice) switches every message at once.
 */
export let M: Messages = plain;

export function setVoice(v: Voice): void {
  M = VOICES[v];
}
