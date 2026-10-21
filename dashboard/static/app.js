"use strict";
// Live view over /events (Server-Sent Events). The only thing sent back is a change to one of the two daily limits.
// Talks plain or Gen Z: g(plain, genz) picks the words; genz.js has the longer rewordings.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
const isNum = (x) => typeof x === "number" && isFinite(x);
const sol = (x, d = 4) => (isNum(x) ? `${x > 0 ? "+" : ""}${x.toFixed(d)}` : "–");
const amt = (x, d = 4) => (isNum(x) ? x.toFixed(d) : "–");
const pct = (x, d = 1, sign = true) => (isNum(x) ? `${sign && x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "–");
const cls = (x) => (isNum(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : "");
const int = (x) => (isNum(x) ? Math.round(x).toLocaleString() : "–");
const price = (x) => (isNum(x) && x > 0 ? (x * 1e6).toFixed(4) : "–"); // SOL per 1,000,000 coins: no e-notation
const ms = (x) => (isNum(x) ? (Math.abs(x) >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x).toLocaleString()} ms`) : "–");
const bytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
function dur(s) {
  if (!isNum(s)) return "–";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
const ago = (ts) => (ts ? `${dur(Math.max(0, (Date.now() - ts) / 1000))} ago` : "never");
const until = (ts) => (ts ? `in ${dur(Math.max(0, (ts - Date.now()) / 1000))}` : "–");
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "–");
const stamp = (ts) => (ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "–");
const agoSpan = (ts) => `<span data-ago="${ts || ""}">${ago(ts)}</span>`;
const tok = (sym, mint) => (sym ? `$${esc(sym)}` : `<span class="mono">${short(mint)}</span>`);
const table = (head, rows, empty) =>
  rows.length
    ? `<table><thead><tr>${head.map(([h, n]) => `<th class="${n ? "n" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
    : `<div class="empty">${empty}</div>`;

let snap = null;
const feed = new Map(); // id -> item
const PER_CAT = 400;
let filter = "tea"; // our trades, copies, skips and problems first; new coins and trader moves one click away
const expanded = new Set();
const fresh = new Set();
let lastMsg = 0;
let token = null; // proves a settings change comes from this page (sent as a header)
let voice = "plain"; // config notifier.voice (same switch as Telegram), or this viewer's own pick from the header button
const g = (plain, genz) => (voice === "genz" ? genz : plain);
const words = () => (voice === "genz" ? GZ : PLAIN); // the longer rewordings (genz.js)
const VOICE_KEY = "dashboard.voice";

function pickedVoice() {
  try { return localStorage.getItem(VOICE_KEY); } catch { return null; }
}
function setVoice(v, save) {
  voice = v === "genz" ? "genz" : "plain";
  if (save) { try { localStorage.setItem(VOICE_KEY, voice); } catch { /* private window: just this visit */ } }
  document.querySelectorAll("[data-gz]").forEach((el) => {
    if (el.dataset.plain === undefined) el.dataset.plain = el.textContent;
    el.textContent = voice === "genz" ? el.dataset.gz : el.dataset.plain;
  });
  const vb = $("voice");
  vb.textContent = g("plain words", "gen z");
  vb.title = g("Switch to the Gen Z voice", "switch to plain words");
  vb.setAttribute("aria-label", g("Voice: plain words. Switch to Gen Z", "voice: gen z. switch to plain words"));
  if (snap) render(snap);
  renderFeed();
}
$("voice").addEventListener("click", () => setVoice(voice === "genz" ? "plain" : "genz", true));

// ---------------------------------------------------------------- connection

function applyState(d) {
  token = d.control_token || token;
  setVoice(pickedVoice() || d.voice || "plain", false);
  feed.clear();
  addFeed(d.feed, false);
  problem(d.error);
  if (d.snapshot) render(d.snapshot);
}

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("init", (e) => { applyState(JSON.parse(e.data)); seen(); });
  es.addEventListener("snapshot", (e) => { problem(null); render(JSON.parse(e.data)); seen(); });
  es.addEventListener("feed", (e) => { addFeed(JSON.parse(e.data), true); seen(); });
  es.addEventListener("problem", (e) => { problem(JSON.parse(e.data)); seen(); });
  es.addEventListener("ping", seen);
  es.onopen = seen;
  es.onerror = () => setConn(false, g("reconnecting…", "brb, reconnecting…"));
}
function seen() { lastMsg = Date.now(); setConn(true, "live"); }
function setConn(on, text) { const c = $("conn"); c.className = `conn ${on ? "on" : "off"}`; c.textContent = text; }
function problem(msg) { const p = $("problem"); p.hidden = !msg; p.textContent = msg ? `${g("Dashboard can't read the bot's data", "the dashboard can't read the bot's data rn")}: ${msg}` : ""; }

// ---------------------------------------------------------------- render all panels

function render(s) {
  snap = s;
  const m = $("mode");
  m.textContent = s.mode === "UNKNOWN" ? "MODE ?" : s.mode;
  m.className = `mode mode-${s.mode}`;
  renderFlags(s);
  renderAway(s);
  renderServices(s.services);
  renderOkData(s.data);
  renderMoney(s.money);
  renderPositions(s.positions);
  renderClosed(s.closed);
  renderRisk(s.risk);
  renderData(s.data);
  renderWallets(s.wallets);
  renderLatency(s.latency);
  renderLearner(s.learner);
  if (s.madeonsol) renderMadeOnSol(s.madeonsol);
  renderControls(s);
  renderLimits(s);
}

// ---------------------------------------------------------------- the two limits you can change

function renderControls(s) {
  const st = s.settings || {};
  if (st.helius_daily_mb_cap) {
    const c = st.helius_daily_mb_cap, guard = s.data.helius_monthly_guard_mb;
    control($("cap-control"), "helius_daily_mb_cap", g("Daily data limit", "daily data limit"), "MB", c,
      g(`Normal: ${int(c.default)} MB.${isNum(guard) ? ` Whatever you set, today the bot uses at most <b>${int(guard)} MB</b>, so the month's free data can't run out.` : ""}`,
        `normal: ${int(c.default)} MB.${isNum(guard) ? ` whatever you set, today maxes out at <b>${int(guard)} MB</b> so the month's free data can't run out.` : ""}`)
      + (c.overridden ? `<br><span class="flag-inline">${g("raised on the dashboard", "you changed this")}</span>` : ""));
  }
  if (st.madeonsol_stop_pct && s.madeonsol) {
    const c = st.madeonsol_stop_pct, lim = s.madeonsol.limit;
    control($("mos-control"), "madeonsol_stop_pct", g("Daily job stops at", "daily job stops at"), g("% of requests", "% of requests"), c,
      g(`= ${int((lim * c.value) / 100)} of ${int(lim)} requests a day. Normal: ${c.default}%. MadeOnSol never allows more than ${int(lim)}.`,
        `= ${int((lim * c.value) / 100)} of ${int(lim)} requests a day. normal: ${c.default}%. MadeOnSol caps it at ${int(lim)} no matter what.`)
      + (c.overridden ? `<br><span class="flag-inline">${g("changed on the dashboard", "you changed this")}</span>` : ""));
  }
}

function control(el, name, label, unit, c, note) {
  if (!el.dataset.built) {
    el.innerHTML = `<div class="ctl-row"><h3></h3><input type="number"> <span class="muted unit"></span>
      <button class="save"></button><button class="reset"></button></div><div class="ctl-note muted"></div><div class="ctl-msg" role="status"></div>`;
    el.dataset.built = "1";
    const input = el.querySelector("input");
    input.addEventListener("input", () => (input.dataset.dirty = "1"));
    el.querySelector(".save").addEventListener("click", () => saveSetting(el, name, el.dataset.label, el.dataset.unit, Number(input.value)));
    el.querySelector(".reset").addEventListener("click", () => saveSetting(el, name, el.dataset.label, el.dataset.unit, null));
  }
  el.dataset.label = label;
  el.dataset.unit = unit;
  el.querySelector("h3").textContent = label;
  el.querySelector(".unit").textContent = unit;
  el.querySelector(".save").textContent = g("Save", "save");
  el.querySelector(".reset").textContent = g("Back to normal", "back to normal");
  const input = el.querySelector("input");
  input.setAttribute("aria-label", label);
  input.min = c.min;
  input.max = c.max;
  input.step = name === "helius_daily_mb_cap" ? 100 : 1;
  if (document.activeElement !== input && !input.dataset.dirty) input.value = c.value;
  el.querySelector(".ctl-note").innerHTML = note;
  el.querySelector(".reset").disabled = !c.overridden;
}

/** POST one setting (value null = back to normal). Returns the saved state, or throws an Error with words for the page. */
async function postSetting(name, value) {
  let res;
  try {
    res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": token || "" },
      body: JSON.stringify({ setting: name, value }),
    });
  } catch {
    throw new Error(g("Not saved: the dashboard can't be reached.", "didn't save: can't reach the dashboard rn."));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${g("Not saved", "didn't save")}: ${body.error || res.status}`);
  return body;
}

async function saveSetting(el, name, label, unit, value) {
  const msg = el.querySelector(".ctl-msg");
  if (value !== null && !(value > 0)) { msg.textContent = g("Type a number first.", "type a number first bestie"); return; }
  if (!confirm(value === null ? g(`Set "${label}" back to normal?`, `put "${label}" back to normal?`) : g(`Change "${label}" to ${value} ${unit}?`, `change "${label}" to ${value} ${unit}? (you'll get a text)`))) return;
  msg.textContent = g("Saving…", "saving…");
  try {
    const body = await postSetting(name, value);
    delete el.querySelector("input").dataset.dirty;
    el.querySelector("input").value = body.value;
    msg.textContent = g(`Saved: ${body.value} ${unit}${body.overridden ? "" : " (normal)"}. The bot uses it within a few seconds, and you get a Telegram message.`,
      `saved ✅ ${body.value} ${unit}${body.overridden ? "" : " (normal)"}. the bot picks it up in a few secs and you get a text.`);
  } catch (e) {
    msg.textContent = e.message;
  }
}

// ---------------------------------------------------------------- the Limits tab: every limit you can change

// stored value <-> what the box shows (shared/editable-settings.json "show")
const SHOW = {
  percent: { unit: "%", to: (v) => v * 100, from: (x) => x / 100 },
  bps: { unit: "%", to: (v) => v / 100, from: (x) => x * 100 },
  minutes: { unit: "min", to: (v) => v / 60000, from: (x) => x * 60000 },
};
const tidy = (x) => +(+x).toPrecision(10); // 0.07 * 100 = 7.000000000000001 -> 7
const shown = (m, v) => (m.type === "bool" ? v : tidy(SHOW[m.show] ? SHOW[m.show].to(v) : v));
const unitOf = (m) => (SHOW[m.show] ? SHOW[m.show].unit : m.unit || "");
const inWords = (m, v) => (m.type === "bool" ? (v ? g("on", "on") : g("off", "off")) : `${num(shown(m, v))}${unitOf(m) === "%" ? "%" : unitOf(m) ? " " + unitOf(m) : ""}`);
function num(x) {
  return Math.abs(x) >= 1000 && Number.isInteger(x) ? x.toLocaleString("en-US") : String(x);
}

function renderLimits(s) {
  const box = $("limits");
  const meta = s.settings_meta, st = s.settings || {};
  if (!meta || !box) return;
  if (!box.dataset.built) {
    box.innerHTML = meta.groups.map((gr) => `<article class="panel" aria-labelledby="lim-h-${gr.id}">
        <header class="ph"><h2 id="lim-h-${gr.id}"></h2><small class="lim-count"></small></header>
        <p class="hint lim-note"></p><div class="lim-rows" data-group="${gr.id}"></div></article>`).join("");
    for (const m of meta.settings) {
      const rows = box.querySelector(`.lim-rows[data-group="${m.group}"]`);
      if (!rows) continue;
      const row = document.createElement("div");
      row.className = "lim-row";
      row.dataset.name = m.name;
      const id = `lim-${m.name.replace(/[^\w]/g, "-")}`;
      row.innerHTML = `<label for="${id}" class="lim-label"></label>
        <span class="lim-in">${m.type === "bool"
          ? `<input id="${id}" type="checkbox" class="lim-switch">`
          : `<input id="${id}" type="number" inputmode="decimal">`}<span class="muted unit"></span></span>
        <span class="lim-normal muted"></span>
        <span class="lim-btns"><button class="save" type="button"></button><button class="reset" type="button"></button></span>
        <div class="ctl-msg lim-msg" role="status"></div>`;
      const input = row.querySelector("input");
      const dirty = () => { input.dataset.dirty = "1"; row.classList.add("editing"); row.querySelector(".save").disabled = false; };
      input.addEventListener("input", dirty);
      input.addEventListener("change", dirty);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveLimit(row, m, false); });
      row.querySelector(".save").addEventListener("click", () => saveLimit(row, m, false));
      row.querySelector(".reset").addEventListener("click", () => saveLimit(row, m, true));
      rows.appendChild(row);
    }
    box.dataset.built = "1";
  }
  for (const gr of meta.groups) {
    const panel = box.querySelector(`#lim-h-${gr.id}`).closest(".panel");
    panel.querySelector("h2").textContent = g(gr.label, gr.gz);
    panel.querySelector(".lim-note").textContent = gr.note;
    const mine = meta.settings.filter((m) => m.group === gr.id && st[m.name]);
    const changed = mine.filter((m) => st[m.name].overridden).length;
    panel.querySelector(".lim-count").textContent = changed ? g(`${changed} changed by you`, `${changed} changed by you`) : g("all normal", "all normal");
  }
  for (const m of meta.settings) {
    const row = box.querySelector(`.lim-row[data-name="${CSS.escape(m.name)}"]`);
    const c = st[m.name];
    if (!row) continue;
    row.hidden = !c;
    if (!c) continue;
    const label = g(m.label, m.gz || m.label);
    const lab = row.querySelector(".lim-label");
    lab.textContent = label;
    lab.title = m.help || "";
    row.querySelector(".unit").textContent = unitOf(m);
    row.querySelector(".save").textContent = g("Save", "save");
    row.querySelector(".reset").textContent = g("Back to normal", "back to normal");
    row.querySelector(".reset").hidden = !c.overridden; // keeps its space, so the rows stay aligned
    row.classList.toggle("changed", c.overridden);
    const input = row.querySelector("input");
    if (m.type !== "bool") {
      input.min = shown(m, c.min);
      input.max = shown(m, c.max);
      input.step = m.type === "int" && !SHOW[m.show] ? 1 : "any";
    }
    if (document.activeElement !== input && !input.dataset.dirty) {
      if (m.type === "bool") input.checked = !!c.value;
      else input.value = shown(m, c.value);
    }
    row.querySelector(".save").disabled = !input.dataset.dirty;
    row.querySelector(".lim-normal").innerHTML = `${g("normal", "normal")}: ${esc(inWords(m, c.default))}`
      + (m.type === "bool" ? "" : ` <span class="lim-range">· ${g("allowed", "allowed")} ${esc(num(shown(m, c.min)))}–${esc(inWords(m, c.max))}</span>`)
      + (m.help ? ` <span class="lim-help">· ${esc(m.help)}</span>` : "")
      + (c.changed_at ? ` <span class="lim-since${c.trades_since < c.judge_after ? " early" : ""}">· ${tested(c)}</span>` : "");
    row.dataset.since = c.changed_at && c.trades_since < c.judge_after ? String(c.trades_since) : "";
    row.dataset.judge = String(c.judge_after || "");
  }
}

/** Stick to one plan: how far the last change has been tested. */
function tested(c) {
  const when = ago(c.changed_at);
  return c.trades_since < c.judge_after
    ? g(`changed ${when}, ${c.trades_since} of ${c.judge_after} trades since: too early to judge`,
      `changed ${when}, ${c.trades_since}/${c.judge_after} trades since: too early to tell`)
    : g(`changed ${when}, ${c.trades_since} trades since: enough to judge`, `changed ${when}, ${c.trades_since} trades since: enough to tell`);
}

async function saveLimit(row, m, reset) {
  const msg = row.querySelector(".lim-msg");
  const input = row.querySelector("input");
  const label = g(m.label, m.gz || m.label);
  let value = null;
  if (!reset) {
    if (m.type === "bool") value = input.checked;
    else {
      const x = input.value.trim() === "" ? NaN : Number(input.value);
      if (!Number.isFinite(x)) { msg.textContent = g("Type a number first.", "type a number first bestie"); return; }
      value = SHOW[m.show] ? tidy(SHOW[m.show].from(x)) : x;
      if (m.type === "int") value = Math.round(value);
    }
  }
  const what = reset ? null : inWords(m, value);
  // one strategy: changing again before the last change was tested means never knowing which one worked
  const early = row.dataset.since !== "" && row.dataset.since !== undefined
    ? g(`\n\nYou changed this only ${row.dataset.since} trades ago. It takes ${row.dataset.judge} trades to know if a change helped. Change it again anyway?`,
      `\n\nyou changed this only ${row.dataset.since} trades ago. it takes ${row.dataset.judge} trades to know if it helped. change it again anyway?`)
    : "";
  if (!confirm((reset ? g(`Set "${label}" back to normal?`, `put "${label}" back to normal?`)
    : g(`Change "${label}" to ${what}?${m.group === "safety" ? " Practice trades use it right away." : ""}`, `change "${label}" to ${what}? (you'll get a text)`)) + early)) return;
  msg.textContent = g("Saving…", "saving…");
  try {
    const body = await postSetting(m.name, value);
    delete input.dataset.dirty;
    row.classList.remove("editing");
    row.querySelector(".save").disabled = true;
    row.querySelector(".reset").hidden = !body.overridden;
    if (m.type === "bool") input.checked = !!body.value;
    else input.value = shown(m, body.value);
    msg.textContent = g(`Saved: ${inWords(m, body.value)}${body.overridden ? "" : " (normal)"}. The bot uses it within a few seconds.`,
      `saved ✅ ${inWords(m, body.value)}${body.overridden ? "" : " (normal)"}. the bot picks it up in a few secs.`);
    setTimeout(() => { if (msg.textContent.startsWith(g("Saved", "saved"))) msg.textContent = ""; }, 8000);
  } catch (e) {
    msg.textContent = e.message;
  }
}

function renderMadeOnSol(m) {
  const left = Math.max(0, m.limit - m.used_today);
  const job = m.job || {};
  $("madeonsol").innerHTML = `${!m.enabled ? `<div class="muted">${g("Switched off in config.", "turned off in config.")}</div>` : ""}
    ${meter(g("Requests used today", "requests used today"), m.used_today, m.limit, int)}
    <dl class="kv"><dt>${g("budget left", "left today")}</dt><dd>${int(left)} <span class="muted">(${g("the job stops at", "job stops at")} ${int(m.stop_at)}; ${g("resets", "resets")} 00:00 UTC)</span></dd>
      <dt>${g("last success", "last W")}</dt><dd>${agoSpan(m.last_ok_at)}</dd>
      <dt>${g("last error", "last oops")}</dt><dd>${m.last_error_at ? `${agoSpan(m.last_error_at)} · <span class="muted">${esc(m.last_error)}</span>` : g("none", "none 🙌")}</dd>
      <dt>${g("daily job", "daily job")}</dt><dd>${m.job_at ? `${g("ran", "ran")} ${agoSpan(m.job_at)}: ${int(job.coins)} ${g("coins", "coins")}, ${int(job.creators)} ${g("creators", "creators")}, ${int(job.requests)} req`
        : g("not run yet", "hasn't run yet")}${m.next_run_at ? ` · ${g("next", "next")} ${until(m.next_run_at)}` : ""}</dd>
      <dt>${g("stored", "saved")}</dt><dd>${int(m.creators)} ${g("creator records", "creator records")} · ${int(m.candidates_on_trial)} ${g("ranked traders on a 7-day trial watch", "traders on a 7-day tryout")}</dd></dl>
    <div class="muted">${g("Never used while deciding a trade: the bot reads only what this job stored before.", "never used mid-trade: the bot only reads what this job saved earlier.")}</div>`;
}

function renderFlags(s) {
  // the away message carries the state; the title bar only keeps the practice reminder
  $("flags").innerHTML = s.risk.paper_no_limits && s.mode !== "LIVE"
    ? `<span class="flag" title="${g("Practice trading has no limits on trades, size or losses. Switch it under Limits.", "practice trades have no limits. flip it in Limits.")}">${g("practice: limits off", "practice: no limits fr")}</span>` : "";
}

// ---------------------------------------------------------------- away message: the bot's status in one line

const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d; };
const hhmm = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function renderAway(s) {
  const name = (x) => (voice === "genz" ? GZ.svc[x.name] || x.name : PLAIN_PARTS[x.name] || x.name);
  const down = s.services.filter((x) => !x.ok && x.state !== "scheduled");
  const mode = s.data.data_mode;
  const back = `00:00 UTC (${hhmm(nextUtcMidnight())} ${g("your time", "your time")})`;
  let state, msg, pill;
  if (s.risk.killed) {
    state = "busy"; pill = g("stopped", "stopped");
    msg = g("Emergency stop is on, so nothing gets bought. To undo it, type make unkill on the bot's computer.", "emergency stop is ON, nothing gets bought. to undo: make unkill");
  } else if (down.length) {
    state = "busy"; pill = g("needs you", "needs you");
    msg = g(`${down.map(name).join(", ")} ${down.length === 1 ? "is" : "are"} not working. Try make restart on the bot's computer.`,
      `${down.map(name).join(", ")} ${down.length === 1 ? "is" : "are"} down bad. try make restart`);
  } else if (s.risk.halted) {
    state = "away"; pill = g("paused", "chilling");
    msg = g(`Paused for today: the daily loss limit was hit. Back at ${back}.`, `chilling for today: hit the daily loss limit. back at ${back}`);
  } else if (mode === "off" || mode === "positions_only") {
    state = "away"; pill = g(`away till ${hhmm(nextUtcMidnight())}`, `away till ${hhmm(nextUtcMidnight())}`);
    msg = g(`Today's free data is used up, so copying is paused. It starts again at ${back}.`, `brb, today's free data is used up. copying is back at ${back}`);
  } else if (s.data.warnings.length) {
    state = "away"; pill = g("quiet feed", "lowkey sus");
    msg = g("The market feed has gone quiet. The bot waits for data to come back.", "lowkey sus: the market feed went quiet. waiting for it to come back");
  } else {
    state = "online"; pill = g("online", "online");
    const n = s.risk.entries_today ?? 0;
    msg = g(`Online and copying our traders. ${n} trade${n === 1 ? "" : "s"} today${mode && mode !== "normal" ? ", saving data" : ""}.`,
      `online, copying our traders rn · ${n} trade${n === 1 ? "" : "s"} today${mode && mode !== "normal" ? " · saving data" : ""}`);
  }
  const ok = s.services.filter((x) => x.ok || x.state === "scheduled").length;
  const needs = state === "busy";
  $("away").className = `away ${state}`;
  $("away-label").textContent = g("Status:", "away message:");
  if (state === "online") $("away-label").textContent = g("Status:", "status:");
  $("away-msg").textContent = msg;
  $("away-sub").textContent = [
    g(`${ok} of ${s.services.length} parts working`, ok === s.services.length ? "all parts vibing" : `${ok} of ${s.services.length} parts vibing`),
    needs ? g("this needs you", "this one needs you") : g("nothing needs you", "nothing needs you"),
  ].join(" · ");
  $("away-pill").textContent = pill;
  $("away-face").innerHTML = awayFace(state);
}

/** The bot's buddy icon: a 12x12 pixel face whose expression follows the status. */
function awayFace(state) {
  const px = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  const body = state === "busy" ? "#D2353C" : state === "online" ? "#18A866" : "#5B3DF0";
  let face = px(0, 1, 12, 10, body) + px(1, 0, 10, 12, body) + px(5, -1, 2, 2, body);
  if (state === "online") face += px(3, 4, 2, 2, "#B8F53A") + px(7, 4, 2, 2, "#B8F53A") + px(3, 7, 1, 1, "#fff") + px(4, 8, 4, 1, "#fff") + px(8, 7, 1, 1, "#fff");
  else if (state === "busy") face += px(3, 4, 2, 2, "#fff") + px(7, 4, 2, 2, "#fff") + px(4, 7, 4, 1, "#fff") + px(3, 8, 1, 1, "#fff") + px(8, 8, 1, 1, "#fff");
  else face += px(3, 5, 2, 1, "#B8F53A") + px(7, 5, 2, 1, "#B8F53A") + px(5, 8, 2, 1, "#fff");
  return face;
}

/** A buddy icon for a wallet: a symmetric 5x5 pixel pattern in a colour derived from the address. */
function identicon(addr, size) {
  let h = 2166136261;
  for (const ch of String(addr)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const colors = ["#5B3DF0", "#0FA595", "#E0408E", "#E89B00", "#2F6BFF", "#18A866", "#D2353C"];
  const color = colors[h % colors.length];
  let cells = "";
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if ((h >>> (y * 3 + x + 3)) & 1) {
      cells += `<rect x="${x + 1}" y="${y + 1}" width="1" height="1"/>`;
      if (x < 2) cells += `<rect x="${5 - x}" y="${y + 1}" width="1" height="1"/>`;
    }
  }
  return `<svg class="av" width="${size}" height="${size}" viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true"><g fill="${color}">${cells}</g></svg>`;
}

const PLAIN_PARTS = { collector: "data collector", trader: "trading part", notifier: "message part", learner: "learning brain" };
const PLAIN_STATES = { running: "working", active: "working", scheduled: "on schedule", stale: "not checking in", failed: "stopped", stopped: "off", inactive: "off", dead: "stopped" };
function renderServices(list) {
  const okN = list.filter((x) => x.ok || x.state === "scheduled").length;
  $("ok-note").textContent = okN === list.length ? g("yes, all good", "yep, all vibing") : g(`${list.length - okN} need a look`, `${list.length - okN} lowkey sus`);
  $("services").innerHTML = list.map((s) => {
    const cl = s.ok ? "" : s.state === "scheduled" ? "sched" : s.state === "stale" ? "warn" : "bad";
    const name = voice === "genz" ? GZ.svc[s.name] || s.name : PLAIN_PARTS[s.name] || s.name;
    const state = voice === "genz" ? GZ.state[s.state] || s.state : PLAIN_STATES[s.state] || s.state;
    let when = "", detail = "";
    if (s.name === "learner") {
      const next = s.runs.filter((r) => r.next_at).sort((a, b) => a.next_at - b.next_at)[0];
      when = next ? `${esc(next.unit)} ${until(next.next_at)}` : "";
      detail = s.runs.map((r) => `${esc(r.unit)} ${ago(r.last_run_at)}${r.result && r.result !== "success" ? ` (${esc(r.result)})` : ""}`).join(" · ");
    } else {
      when = `${g("checked in", "pinged")} ${agoSpan(s.heartbeat_at)}`;
      const i = s.info || {};
      const crashes = s.crashes_today ? `${int(s.crashes_today)} ${g(`crash${s.crashes_today === 1 ? "" : "es"} today`, `crash${s.crashes_today === 1 ? "" : "es"} today`)} · ` : "";
      if (s.name === "collector") {
        const st = i.streams || {};
        const sv = (k) => `${k} ${st[k] ? "up" : st[k] === false ? "down" : "off"}`;
        detail = `${crashes}${sv("firehose")} · ${sv("targeted")} · ${sv("pumpportal")}`;
      } else if (s.name === "trader") {
        detail = crashes + g(`chances to copy ${int(i.signals)} · copied ${int(i.entered)} · problems ${int(i.errors)} since start`, `chances ${int(i.signals)} · copied ${int(i.entered)} · oopsies ${int(i.errors)} this run`);
      } else if (s.name === "notifier") {
        detail = crashes + g(`Telegram sent ${int(i.sent)} · failed ${int(i.failed)}`, `texts sent ${int(i.sent)} · failed ${int(i.failed)}`);
      } else detail = crashes + `${g("up", "up")} ${s.uptime_s != null ? dur(s.uptime_s) : "–"}`;
    }
    return `<li class="part ${cl}"${s.crash_detail ? ` title="${esc(s.crash_detail)}"` : ""}><i class="led" aria-hidden="true"></i><b>${esc(name)}</b>
      <span class="state">${esc(state)}</span><em>${when}</em>${detail ? `<span class="detail">${detail}</span>` : ""}</li>`;
  }).join("");
}

function renderOkData(d) {
  if (!isNum(d.helius_mb)) { $("ok-data").innerHTML = ""; return; }
  const left = d.helius_mb >= d.helius_cap_mb ? g("limit hit: copying waits for 00:00 UTC", "limit hit, copying waits for 00:00 UTC")
    : d.helius_cap_at ? g(`runs out around ${clock(d.helius_cap_at).slice(0, 5)} at this speed`, `runs out ~${clock(d.helius_cap_at).slice(0, 5)} at this speed`)
    : g("lasts the day at this speed", "lasts all day at this speed");
  $("ok-data").innerHTML = meter(g("Free data used today (MB)", "data used today (MB)"), d.helius_mb, d.helius_cap_mb, (x) => int(x))
    + `<div class="muted" style="font-size:12px">${left}</div>`;
}

function kpi(label, value, sub = "", klass = "", hero = false) {
  return `<div class="kpi${hero ? " hero" : ""}"><div class="l">${label}</div><div class="v num ${klass}">${value}</div><div class="s">${sub}</div></div>`;
}

let shownEquity = null;
function renderMoney(m) {
  if (!m.started) {
    $("bag-figure").innerHTML = "";
    $("bag-delta").textContent = g("Practice trading hasn't started yet.", "practice trading hasn't started yet.");
    $("kpis").innerHTML = "";
    $("equity").innerHTML = "";
    return;
  }
  const fig = $("bag-figure");
  const changed = shownEquity !== null && Math.abs(shownEquity - m.equity) >= 5e-5;
  fig.innerHTML = `<b class="num">${amt(m.equity)}</b><span>SOL</span>`;
  fig.classList.toggle("flip", changed);
  shownEquity = m.equity;
  const all = m.pnl_all / m.start;
  const mood = all >= 0.05 ? g("up nicely", "we're eating") : all > 0.0005 ? g("up a little", "lil W") : all > -0.0005 ? g("flat", "mid, no change")
    : all > -0.05 ? g("down a little", "lowkey mid, not cooked") : all > -0.15 ? g("down", "taking Ls ngl") : g("down a lot", "cooked fr");
  $("bag-delta").innerHTML = `<span class="${cls(m.pnl_all)}">${sol(m.pnl_all)} SOL ${g("all time", "all time")} · ${pct(all)}</span> <span class="mood">· ${mood}</span>`;
  const wins = isNum(m.win_rate) && m.closed ? Math.round(m.win_rate * m.closed) : null;
  const stat = (label, value, sub = "", k = "") => `<div><dt>${label}</dt><dd class="${k}">${value}${sub ? `<small>${sub}</small>` : ""}</dd></div>`;
  const wasOpen = $("kpis-more")?.open;
  $("kpis").innerHTML = [
    stat(g("Today", "today"), sol(m.pnl_today), pct(m.pnl_today / m.start), cls(m.pnl_today)),
    stat(g("Win rate", "W rate"), isNum(m.win_rate) ? pct(m.win_rate, 0, false) : "–", wins !== null ? g(`${wins} of ${int(m.closed)} trades won`, `${wins} W of ${int(m.closed)}`) : ""),
    stat(g("Worst drop", "worst dip"), pct(m.max_drawdown, 1, false), g("from the highest point", "top to bottom"), m.max_drawdown > 0 ? "neg" : ""),
    stat(g("Costs paid", "fees we ate"), amt(m.fees_paid + m.slippage_cost), "SOL"),
  ].join("") + `<details class="more stats-more" id="kpis-more"${wasOpen ? " open" : ""}><summary>${g("More numbers", "more numbers")}</summary><dl class="stats">${[
    stat(g("Last 7 days", "this week"), sol(m.realized_7d), g("closed trades", "locked in"), cls(m.realized_7d)),
    stat(g("Average win", "avg W"), sol(m.avg_win, 3), "SOL", "pos"),
    stat(g("Average loss", "avg L"), sol(m.avg_loss, 3), "SOL", "neg"),
    stat(g("Free balance", "free cash"), amt(m.balance), g("not in any coin", "not in any coin")),
    stat(g("Open trades", "open rn"), sol(m.unrealized), g("not sold yet", "not sold yet"), cls(m.unrealized)),
    stat(g("Fees", "fees"), amt(m.fees_paid, 4), "SOL"),
    stat(g("Price moves", "price moves"), amt(m.slippage_cost, 4), g("paid above the trader", "paid above our trader")),
  ].join("")}</dl></details>`;
  lineChart($("equity"), m.curve, m.start, 130);
}

function renderPositions(ps) {
  $("pos-count").textContent = g(`${ps.length} open`, `${ps.length} rn`);
  $("positions").innerHTML = ps.length ? table(
    g([["Coin"], ["Trader"], ["Paid SOL", 1], ["Worth now", 1], ["Up / down", 1], ["Held", 1], ["Selling"]],
      [["Coin"], ["Trader"], ["Paid SOL", 1], ["Worth rn", 1], ["Up / down", 1], ["Held", 1], ["Selling"]]),
    ps.map((p) => `<tr><td>${tok(p.symbol, p.mint)}</td><td class="mono">${short(p.leader)}</td>
      <td class="n">${amt(p.cost_sol ?? p.size_sol)}</td><td class="n">${amt(p.mark_sol)}</td>
      <td class="n ${cls(p.unrealized_pct)}">${pct(p.unrealized_pct)}</td>
      <td class="n">${p.opened_at ? agoSpan(p.opened_at).replace(" ago", "") : g("buying ", "buying ") + until(p.entry_due_at)}</td>
      <td>${p.exit_trigger ? esc(words().exit(p.exit_trigger)) : ""}</td></tr>`),
    "") : `<div class="empty">${g("Nothing right now. Coins show up here while a copied trade is open.", "not holding anything rn.")}</div>`;
}

function renderClosed(rows) {
  const why = (r) => (r.status === "failed" ? `${g("didn't go through", "didn't go through")}: ${words().missed(r.exit_reason)}` : words().exit(r.exit_reason));
  const whyShort = (r) => (r.status === "failed" ? g("didn't go through", "missed") : ({
    leader_exit: g("trader sold", "trader dipped"), stop_loss: g("auto-sold", "auto-sold"), time_exit: g("30-min limit", "30 min max"), kill_switch: g("emergency stop", "emergency stop"),
  })[r.exit_reason] || why(r));
  // home: the short story of each trade
  $("closed").innerHTML = table(
    g([["When"], ["Coin"], ["Result", 1], ["SOL", 1], ["Why we sold"]], [["When"], ["Coin"], ["W/L", 1], ["SOL", 1], ["Why we sold"]]),
    rows.map((r) => `<tr class="${r.status === "failed" ? "failed" : ""}"><td>${stamp(r.closed_at)}</td><td>${tok(r.symbol, r.mint)}</td>
      <td class="n ${cls(r.pnl_pct)}"><b>${pct(r.pnl_pct)}</b></td><td class="n ${cls(r.pnl_sol)}">${sol(r.pnl_sol)}</td><td class="why" title="${esc(why(r))}">${esc(whyShort(r))}</td></tr>`),
    g("No trades yet.", "no trades yet, stay tuned."),
  );
  // details tab: everything, prices included
  $("closed-full").innerHTML = table(
    [[g("When", "When")], [g("Coin", "Coin")], [g("Trader", "Trader")], [g("Buy price*", "Buy price*"), 1], [g("Sell price*", "Sell price*"), 1], [g("Size SOL", "Size SOL"), 1],
      [g("Result SOL", "W/L SOL"), 1], [g("Result", "W/L"), 1], [g("Held", "Held"), 1], [g("Why we sold", "Why we sold")]],
    rows.map((r) => `<tr class="${r.status === "failed" ? "failed" : ""}"><td>${stamp(r.closed_at)}</td><td>${tok(r.symbol, r.mint)}</td>
      <td class="mono">${short(r.leader_wallet)}</td><td class="n">${price(r.entry_price)}</td><td class="n">${price(r.exit_price)}</td>
      <td class="n">${amt(r.size_sol)}</td><td class="n ${cls(r.pnl_sol)}">${sol(r.pnl_sol)}</td><td class="n ${cls(r.pnl_pct)}">${pct(r.pnl_pct)}</td>
      <td class="n">${r.hold_ms != null ? dur(r.hold_ms / 1000) : "–"}</td><td>${esc(why(r))}</td></tr>`),
    g("No trades yet.", "no trades yet, stay tuned."),
  );
  $("closed-note").textContent = g("* prices in SOL per million coins", "* prices in SOL per million coins");
}

function meter(label, used, cap, fmt) {
  if (cap === null || cap === undefined) {
    return `<div class="meter"><div class="row"><span>${label}</span><span class="num">${fmt(used)} <span class="muted">· ${g("no limit (practice)", "no limit (practice)")}</span></span></div></div>`;
  }
  const frac = isNum(used) && cap ? used / cap : 0;
  const level = frac >= 1 ? "bad" : frac >= 0.6 ? "warn" : "";
  return `<div class="meter ${level}"><div class="row"><span>${label}</span><span class="num">${fmt(used)} / ${fmt(cap)}</span></div>
    <div class="track" role="meter" aria-label="${label}" aria-valuenow="${isNum(used) ? used : 0}" aria-valuemax="${cap}"><div class="fill" style="width:${Math.min(100, frac * 100).toFixed(1)}%"></div></div></div>`;
}

function renderRisk(r) {
  const p0 = (x) => pct(x, 1, false);
  const L = r.limits || {};
  const hold = dur((L.TIME_EXIT_MS || 0) / 1000);
  $("risk").innerHTML = `${r.paper_no_limits ? `<div class="warnbox">${g(`Practice trading without limits: no cap on open trades, trades per day, size or losses. Stop loss, the ${hold} exit and the emergency stop still work. Switch it under Limits.`,
      `practice mode, no limits fr: no cap on trades, size or losses. auto-sell, the ${hold} sell and the emergency stop still work. flip it in Limits.`)}</div>` : ""}
    <div class="state-row">
      <span class="pill ${r.killed ? "bad" : "ok"}">${r.killed ? g("emergency stop ON", "emergency stop ON") : g("emergency stop off", "emergency stop off")}</span>
      <span class="pill ${r.halted ? "warn" : "ok"}">${r.halted ? g("paused for today", "chilling for today") : g("not paused", "not paused")}</span></div>
    ${r.killed ? `<div class="muted">${esc(r.kill_reason || "")} ${r.kill_at ? "· " + stamp(r.kill_at) : ""}</div>` : ""}
    ${meter(g("Daily loss vs cap", "today's L vs limit"), r.daily_loss, r.daily_cap, p0)}
    ${meter(g("Drawdown from start vs cap", "dip from start vs limit"), r.drawdown, r.drawdown_cap, p0)}
    ${meter(g("Open positions", "coins held"), r.open, r.max_open, int)}
    ${meter(g("Entries today", "trades today"), r.entries_today, r.max_entries, int)}
    <dl class="kv"><dt>${g("position size", "trade size")}</dt><dd>${p0(L.MAX_POSITION_PCT)} ${g("of equity", "of the bag")}${r.paper_no_limits ? g(" (no cap in practice)", " (no cap in practice)") : `, max ${L.MAX_POSITION_SOL} SOL`}</dd>
      <dt>${g("stop loss", "auto-sell at")}</dt><dd>−${p0(L.STOP_LOSS_PCT)}</dd><dt>${g("time exit", "max hold")}</dt><dd>${dur(L.TIME_EXIT_MS / 1000)}</dd>
      <dt>${g("reserve", "kept aside")}</dt><dd>${L.MIN_FREE_BALANCE_SOL} SOL ${g("kept free", "")}</dd>
      ${r.size_base ? `<dt>${g("sized from", "sized from")}</dt><dd>${(+r.size_base).toFixed(3)} SOL ${g("proven balance", "proven bag")}${r.size_trial ? g(" (new step, on trial this week)", " (new step, on trial this week)") : ""}
        <br><span class="muted">${g(`not today's balance: it goes up only after ${L.SIZE_STEP_WEEKS} winning weeks in a row`, `not today's bag: it only goes up after ${L.SIZE_STEP_WEEKS} green weeks in a row`)}</span></dd>` : ""}</dl>
    <div class="muted">${g(`Change these under Limits (never past the walls in trader/src/risk/limits.ts). Daily cap resets 00:00 UTC; the kill switch needs <span class="mono">make unkill</span>.`,
      `change these in Limits (never past the walls in limits.ts). daily limit resets 00:00 UTC; emergency stop needs <span class="mono">make unkill</span>.`)}</div>`;
}

function renderData(d) {
  const st = d.streams || {};
  const pill = (k) => `<span class="pill ${st[k] ? "ok" : st[k] === false ? "bad" : ""}">${k} ${st[k] ? "up" : st[k] === false ? "DOWN" : "off"}</span>`;
  $("data").innerHTML = `${d.warnings.map((w) => `<div class="warnbox">${esc(w)}</div>`).join("")}
    <div class="state-row">${pill("firehose")}${pill("targeted")}${pill("pumpportal")}</div>
    ${st.firehoseOff ? `<div class="muted">firehose off: ${esc(st.firehoseOff)}</div>` : ""}
    <dl class="kv"><dt>${g("tokens", "coins")}</dt><dd>${int(d.tokens)} ${g("total", "total")} · ${int(d.tokens_1h)} ${g("last hour", "last hour")}</dd>
      <dt>${g("trades", "trades")}</dt><dd>${int(d.trades)} ${g("total", "total")} · ${int(d.trades_1h)} ${g("last hour", "last hour")}</dd>
      <dt>${g("last event", "last seen")}</dt><dd>${agoSpan(d.last_event_at)} <span class="muted">(${g("trade", "trade")} ${agoSpan(d.last_trade_at)}, ${g("launch", "new coin")} ${agoSpan(d.last_token_at)})</span></dd>
      <dt>${g("database", "database")}</dt><dd>${bytes(d.db_bytes)}</dd>
      ${d.open_gaps.length ? `<dt>${g("open gaps", "feed breaks")}</dt><dd>${d.open_gaps.map((x) => `${esc(x.source)}: ${esc(x.reason)} (${agoSpan(x.started_at)})`).join("<br>")}</dd>` : ""}
    </dl>
    ${isNum(d.helius_mb) ? meter(g("Helius data today (MB)", "data used today (MB)"), d.helius_mb, d.helius_cap_mb, (x) => int(x)) : ""}
    ${isNum(d.helius_mb_per_hour) ? `<dl class="kv"><dt>${g("speed", "speed")}</dt><dd>${int(d.helius_mb_per_hour)} MB/h · ${d.helius_mb >= d.helius_cap_mb ? g("cap reached", "limit hit, done for today")
      : d.helius_cap_at ? g(`cap at ${clock(d.helius_cap_at).slice(0, 5)} at this speed`, `runs out ~${clock(d.helius_cap_at).slice(0, 5)} at this speed`) : g("lasts the day at this speed", "lasts all day at this speed")}</dd>
      <dt>${g("mode", "mode")}</dt><dd>${esc((d.data_mode || "?").replace("_", " "))}${d.budget_steps_pct ? ` <span class="muted">(${g("lighter at", "goes lighter at")} ${d.budget_steps_pct.join(" / ")}%)</span>` : ""}</dd></dl>` : ""}
    <div class="charts2">
      <div><div class="chart-head"><h3>${g("Helius MB / hour", "data per hour (MB)")}</h3><span class="muted">24 h</span></div><div id="hourly-mb" class="chart"></div></div>
      <div><div class="chart-head"><h3>${g("Trades / hour", "trades seen per hour")}</h3><span class="muted">24 h</span></div><div id="hourly" class="chart"></div></div>
    </div>`;
  barChart($("hourly-mb"), d.hourly, "mb", (r) => `<b>${int(r.mb)} MB</b> ${g("from Helius", "of data")}`);
  barChart($("hourly"), d.hourly, "trades", (r) => `<b>${int(r.trades)}</b> ${g("trades", "trades")} · ${int(r.tokens)} ${g("launches", "new coins")}`);
}

function renderWallets(w) {
  $("wallets-note").textContent = `${w.active.length} ${g("followed", "buddies")} · ${g("graded", "last graded")} ${w.last_run_at ? ago(w.last_run_at) : g("never", "never")}`;
  const now = Date.now();
  const status = (x) => (x.last_trade_at && now - x.last_trade_at < 3_600_000 ? "online" : x.last_trade_at && now - x.last_trade_at < 86_400_000 ? "idle" : "away");
  const ranked = [...w.active].sort((a, b) => (b.score ?? -9) - (a.score ?? -9));
  const sizeOf = new Map(ranked.map((x, i) => [x.wallet, Math.max(22, 40 - i * 4)])); // bigger icon = better grade
  const words = { online: g("online", "online"), idle: g("idle", "idle"), away: g("away", "away") };
  const row = (x) => {
    const st = status(x);
    return `<tr><td><div class="buddy ${st}"><span class="av-slot">${identicon(x.wallet, sizeOf.get(x.wallet))}</span><span class="who"><b title="${esc(x.wallet)}">${esc(x.label || short(x.wallet))}</b>
      <small>${words[st]}${x.last_trade_at ? ` · ${g("last trade", "last trade")} ${agoSpan(x.last_trade_at)}` : ""}</small></span></div></td>
      <td class="n">${isNum(x.score) ? x.score.toFixed(3) : "–"}</td><td class="n">${pct(x.confidence, 0, false)}</td>
      <td class="n">${int(x.copy_trades)}${x.copy_missed ? ` <span class="muted">(+${x.copy_missed})</span>` : ""}</td>
      <td class="n ${cls(x.copy_roi)}">${pct(x.copy_roi)}</td><td class="n">${pct(x.copy_win_rate, 0, false)}</td>
      <td class="n">${int(x.trades_24h)}</td><td class="n">${int(x.signals_24h)} <span class="muted">(${int(x.followed_24h)})</span></td>
      <td class="n ${cls(x.paper_pnl)}">${sol(x.paper_pnl)}</td></tr>`;
  };
  const head = g([["Trader"], ["Grade", 1], ["Sure", 1], ["Copyable", 1], ["Copy return", 1], ["Copy win rate", 1], ["Trades 24h", 1], ["Chances 24h (copied)", 1], ["Our result SOL", 1]],
    [["Buddy"], ["Grade", 1], ["Sure", 1], ["Copyable", 1], ["Copy return", 1], ["Copy W rate", 1], ["Trades 24h", 1], ["Chances 24h (copied)", 1], ["Our W/L SOL", 1]]);
  const groups = ["online", "idle", "away"].map((st) => [st, ranked.filter((x) => status(x) === st)]).filter(([, xs]) => xs.length);
  $("wallets").innerHTML = ranked.length
    ? `<table><thead><tr>${head.map(([h, n]) => `<th class="${n ? "n" : ""}">${h}</th>`).join("")}</tr></thead>${groups.map(([st, xs]) =>
      `<tbody><tr class="grp"><th colspan="${head.length}">${words[st]} (${xs.length})</th></tr>${xs.map(row).join("")}</tbody>`).join("")}</table>`
    : `<div class="empty">${g("No traders followed yet: scoring adds them every night at 00:15 UTC.", "no buddies yet: grading adds them daily at 00:15 UTC.")}</div>`;
  $("mini-note").textContent = g(`${groups.map(([st, xs]) => `${xs.length} ${words[st]}`).join(" · ")}`, `${groups.map(([st, xs]) => `${xs.length} ${words[st]}`).join(" · ")}`);
  $("buddies-mini").innerHTML = ranked.length ? ranked.slice(0, 6).map((x) => {
    const st = status(x);
    return `<li class="buddy ${st}" title="${esc(x.wallet)}"><span class="av-slot">${identicon(x.wallet, sizeOf.get(x.wallet) - 8)}</span>
      <span class="who"><b>${esc(x.label || short(x.wallet))}</b><small>${words[st]}${x.last_trade_at ? ` · ${ago(x.last_trade_at)}` : ""}</small></span>
      <span class="ret ${cls(x.copy_roi)}">${pct(x.copy_roi)}<small>${g("copy return", "copy return")}</small></span></li>`;
  }).join("") : `<li class="empty">${g("No traders yet.", "no buddies yet.")}</li>`;
  $("dropped-count").textContent = `(${w.dropped.length})`;
  $("dropped").innerHTML = table(
    g([["Trader"], ["Dropped"], ["Why"], ["Grade then", 1], ["Copyable", 1]], [["Trader"], ["Unfollowed"], ["Why"], ["Grade then", 1], ["Copyable", 1]]),
    w.dropped.map((x) => `<tr><td class="mono" title="${esc(x.wallet)}">${esc(x.label || short(x.wallet))}</td><td>${stamp(x.deactivated_at)}</td>
      <td>${esc(x.deactivated_reason)}</td><td class="n">${isNum(x.score) ? x.score.toFixed(3) : "–"}</td><td class="n">${int(x.copy_trades)}</td></tr>`),
    g("None dropped yet.", "nobody unfollowed yet."),
  );
}

function renderLatency(l) {
  const STAGE = {
    detect: [g("Spot it", "spot it"), g("our trader's trade happens → we see it", "our trader's trade happens → we see it")],
    decide: [g("Decide", "decide"), g("we see it → we decide to copy or skip", "we see it → copy or skip")],
    fill: [g("Buy", "buy"), g("we decide → our practice buy lands", "we decide → our practice buy lands")],
    total: [g("Start to finish", "start to finish"), g("our trader's trade → our buy lands", "their trade → our buy lands")],
  };
  $("latency").innerHTML = table(
    [[g("Stage", "Step")], [g("p50", "usual"), 1], [g("p95", "slow"), 1], ["n", 1]],
    l.stages.map((s) => `<tr><td><b>${esc(STAGE[s.name]?.[0] ?? s.name)}</b><br><span class="muted">${esc(STAGE[s.name]?.[1] ?? s.desc)}</span></td>
      <td class="n">${ms(s.p50)}</td><td class="n">${ms(s.p95)}</td><td class="n">${int(s.n)}</td></tr>`),
    g("No signals yet.", "nothing yet."),
  ) + `<div class="muted">${g("The chain's clock counts whole seconds, so \"spot it\" is rough.", "the chain's clock only counts whole seconds, so \"spot it\" is rough.")} ${g("Practice buys land after a set delay, like a real one would.", "practice buys land after a set delay, like a real one would.")}</div>`;
}

// what each number the brain looks at means (both voices)
const FEATURE_WORDS = {
  leader_buy_sol: "how much our trader bought", token_age_s: "how old the coin was", liquidity_sol: "money in the coin",
  confirmations: "how many of our traders bought", wallet_score: "the trader's grade", top10_pct: "share of the 10 biggest owners",
  dev_hold_pct: "share the creator still holds", dev_sold_frac: "how much the creator sold", dev_tokens_24h: "coins the creator made that day",
  creator_launches: "the creator's past coins", creator_success_rate: "how often the creator's coins took off", early_buyer_score: "early buyers' quality",
  leader_is_dev: "our trader made the coin", mayhem: "chaos-mode coin", token_known: "we saw the coin launch", venue: "bigger market (after the curve)",
};
const featureWords = (n) => FEATURE_WORDS[n] || (n.endsWith("_missing") ? `${FEATURE_WORDS[n.slice(0, -8)] || n.slice(0, -8)} (${g("unknown", "no clue")})` : n);

function examLine(ch) {
  const have = isNum(ch.have) ? ch.have : null;
  const words = {
    enough_signals: [g("studied chances to copy", "chances studied"), `${int(have)} / ${int(ch.need)}`],
    enough_test_trades: [g("trades in its test", "trades in its test"), `${int(have)} / ${int(ch.need)}`],
    keeps_enough: [g("keeps enough trades", "doesn't skip everything"), `${int(have)} / ${int(ch.need)}`],
    skips_losers: [g("what it skips really lost", "what it skips actually flopped"), have === null ? "–" : pct(have)],
    beats_rules: [g("beats our rules", "beats our rules"), `${have === null ? "–" : `${have >= 0 ? "+" : ""}${(have * 100).toFixed(1)}`} / +${(ch.need * 100).toFixed(0)} ${g("points", "pts")}`],
    can_test: [g("enough data for a test", "enough data for a test"), `${int(have)} / ${int(ch.need)}`],
  }[ch.key] || [ch.key, ""];
  return `<li><i class="chk${ch.ok ? " ok" : ""}" aria-label="${ch.ok ? g("passed", "passed") : g("not yet", "not yet")}"></i>${words[0]} <span class="num">${words[1]}</span></li>`;
}

function renderBrain(b) {
  if (!b) return `<div class="empty">${g("The learning brain hasn't studied yet (it starts when the first trades have a result).", "the brain hasn't studied yet (starts once the first trades have a result).")}</div>`;
  const status = b.active
    ? `<span class="pill ok">${g("skipping trades it expects to lose", "auto-skip ON")}</span>`
    : `<span class="pill">${g("studying only, not skipping yet", "just studying for now")}</span>`;
  const exam = b.exam ? `<h3>${g("Its test", "its test")} <span class="muted">${g("must pass every line, re-taken after every trade", "needs every box ticked, retaken after every trade")}</span></h3><ul class="exam">${b.exam.checks.map(examLine).join("")}</ul>` : "";
  const TAG = { confirmed: g("sure", "locked in"), changed_mind: g("changed its mind", "changed its mind"), new: g("new", "new"), fading: g("not sure anymore", "fading") };
  const memLine = (m) => {
    const w = voice === "genz" ? GZ.lessonWords(m.key, m.words) : m.words;
    const pts = `${(Math.abs(m.diff ?? 0) * 100).toFixed(1)} ${g("points", "pts")}`;
    const better = m.direction > 0 ? g("better", "W") : g("worse", "L");
    const what = m.status === "fading" ? g(`when ${esc(w)}, it makes little difference now`, `when ${esc(w)}, it barely matters now`)
      : g(`when ${esc(w)}, copying does ${better} (${pts})`, `when ${esc(w)}, copying = ${better} (${pts})`);
    const nights = m.status === "confirmed" ? ` · ${m.nights_same} ${g("days", "days")}` : "";
    return `<li title="${g("first learned", "first learned")} ${stamp(m.first_seen_at)} · ${g("seen on", "seen on")} ${m.nights_seen} ${g("days", "days")}"><span class="mem-tag ${m.status}">${TAG[m.status] || m.status}${nights}</span><span>${what}</span></li>`;
  };
  const mem = b.memory || [];
  const o = b.own_skips;
  const memory = (mem.length
    ? `<h3>${g("What it remembers", "what it remembers")} <span class="muted">${g("strongest first · hover to see when it learned each", "strongest first · hover for when it learned it")}</span></h3><ul class="lessons">${mem.slice(0, 8).map(memLine).join("")}</ul>`
    : b.lessons.length ? `<h3>${g("What it learned", "what it figured out")}</h3><ul class="lessons">${b.lessons.map((l) => `<li>${voice === "genz" ? GZ.lesson(l) : esc(l.text)}</li>`).join("")}</ul>` : "")
    + (o ? `<div class="muted">${g("Its own skips", "its own skips")}: ${int(o.n)}, ${int(o.losers)} ${g("of them would have lost money", "would've flopped")} (${pct(o.avg)} ${g("on average", "avg")})</div>` : "")
    + (b.diary && b.diary.length ? `<details class="report-box"><summary>${g("Diary: when its mind changed", "diary: when it changed its mind")} (${b.diary.length})</summary><ul class="lessons">${b.diary.map((d) => `<li><span class="muted num">${stamp(d.ts)}</span><span>${esc(d.text)}</span></li>`).join("")}</ul></details>` : "");
  return `<div class="state-row">${status}</div>
    <dl class="kv"><dt>${g("studied", "studied")}</dt><dd>${int(b.studied)} ${g("chances to copy, with what each would have made", "chances to copy + how each one ended")}</dd>
      <dt>${g("last study", "last study sesh")}</dt><dd>${b.studied_at ? agoSpan(b.studied_at) : "–"}${isNum(b.skipped_24h) && b.active ? ` · ${g("skipped", "skipped")} ${int(b.skipped_24h)} ${g("in 24 h", "in 24h")}` : ""}</dd>
      <dt>${g("remembers", "remembers")}</dt><dd>${int(b.nights)} ${g(`day${b.nights === 1 ? "" : "s"} of study`, `day${b.nights === 1 ? "" : "s"} of studying`)} · ${int(b.remembered_total ?? b.lessons_total)} ${g("lessons", "lessons")} · ${g("nothing is ever deleted", "never forgets")}</dd></dl>
    ${exam}<!--split-->${memory}`;
}

// what top traders teach on YouTube, and whether our own trades agree (learner/youtube.py; videos never change trades)
function renderYoutube(y) {
  if (!y) return "";
  const head = `<h3>${g("What top traders teach", "what the pros say")} <span class="muted">${g("from YouTube, checked against our own trades · never changes a trade", "from YouTube, fact-checked on our trades · never changes a trade")}</span></h3>`;
  const heard = y.rules.filter((r) => r.videos > 0);
  if (!heard.length) {
    return head + `<div class="empty">${g("No videos studied yet. It studies every night at 00:20 UTC", "no videos yet. studies every night at 00:20 UTC")} (${g("or", "or")} <span class="mono">make youtube</span>).</div>`;
  }
  const TAG = { agrees: g("our data agrees", "facts ✓"), disagrees: g("our data disagrees", "cap"), no_difference: g("no real difference", "no diff"),
    not_enough_data: g("not enough data yet", "need more data"), untested: g("can't test yet", "can't test"), built_in: g("already does this", "already on it") };
  const line = (r) => {
    const d = r.data || {};
    const who = r.traders.length ? ` (${esc(r.traders.slice(0, 3).join(", "))}${r.traders.length > 3 ? "…" : ""})` : "";
    const tested = ["agrees", "disagrees", "no_difference"].includes(r.verdict) && isNum(d.diff);
    const why = tested ? ` · ${esc(r.test)}: ${(Math.abs(d.diff) * 100).toFixed(1)} ${g("points", "pts")} ${d.diff > 0 ? g("better", "better") : g("worse", "worse")} (${int(d.n)} ${g("trades", "trades")})`
      : r.verdict === "not_enough_data" && isNum(d.n) ? ` · ${int(d.n)} ${g("trades so far", "trades so far")}`
      : ["untested", "built_in"].includes(r.verdict) ? ` · ${esc(r.test)}` : "";
    return `<li title="${g("first heard", "first heard")} ${r.first_heard ? stamp(r.first_heard) : "–"} · ${int(r.mentions)} ${g("mentions", "mentions")}"><span class="mem-tag yt-${r.verdict}">${TAG[r.verdict] || esc(r.verdict)}</span>`
      + `<span>"${esc(r.words)}" <span class="muted">${g("in", "in")} ${int(r.videos)} ${g(`video${r.videos === 1 ? "" : "s"}`, `vid${r.videos === 1 ? "" : "s"}`)}${who}${why}</span></span></li>`;
  };
  const silent = y.rules.length - heard.length;
  return head + `<ul class="lessons">${heard.map(line).join("")}</ul>`
    + `<div class="muted">${int(y.studied)} ${g(`video${y.studied === 1 ? "" : "s"} studied`, `vid${y.studied === 1 ? "" : "s"} studied`)} · ${g("last study", "last study")} ${y.checked_at ? agoSpan(y.checked_at) : "–"}`
    + `${silent ? ` · ${silent} ${g(`rule${silent === 1 ? "" : "s"} not heard yet`, `rule${silent === 1 ? "" : "s"} not heard yet`)}` : ""}</div>`
    + `<div class="muted">${g("It counts what traders talk about, not whether they're for or against it.", "it counts what they talk about, not if they're for or against it.")}</div>`;
}

// veteran habits: practice-traded next to our current rules, never used for real until they prove themselves (learner/veteran.py)
function renderVeteran(v) {
  if (!v) return "";
  const head = `<h3>${g("Trading like a 10-year veteran", "10-year vet mode")} <span class="muted">${g("practice only · each habit vs our current rules, same coins", "practice only · each habit vs our rules, same coins")}</span></h3>`;
  if (!v.habits.length) {
    return head + `<div class="empty">${g("No practice trades yet: they start with the trader's next coin.", "no practice trades yet. they start with the next coin.")}</div>`;
  }
  const TAG = { helps: g("helps", "W habit"), hurts: g("hurts", "L habit"), "no clear difference": g("no clear difference", "no diff"), "too early": g("too early", "too early") };
  const line = (h) => {
    const sofar = h.verdict === "too early"
      ? ` · ${int(h.n)}/${int(v.min_n)} ${g("coins so far", "coins so far")}`
      : ` · ${(Math.abs(h.diff) * 100).toFixed(1)} ${g("points", "pts")} ${h.diff >= 0 ? g("better", "better") : g("worse", "worse")} ${g("per coin", "per coin")} (${int(h.n)} ${g("coins", "coins")})`;
    const trades = h.n ? ` · ${int(h.trades)} ${g("trades vs", "trades vs")} ${int(h.base_trades)}` : "";
    return `<li title="${g("practice variant", "practice variant")} ${esc(h.variant)} · PnL ${sol(h.pnl)} SOL ${g("vs", "vs")} ${sol(h.base_pnl)} SOL${isNum(h.lo) ? ` · ${g("range", "range")} ${pct(h.lo)} ${g("to", "to")} ${pct(h.hi)}` : ""}">`
      + `<span class="mem-tag vet-${h.verdict.replace(/ /g, "_")}">${TAG[h.verdict] || esc(h.verdict)}</span>`
      + `<span>${esc(h.habit)} <span class="muted">${sofar}${trades}</span></span></li>`;
  };
  return head + `<ul class="lessons">${v.habits.map(line).join("")}</ul>`
    + `<div class="muted">${g("Started", "started")} ${v.started_at ? agoSpan(v.started_at) : "–"} · ${g(`A verdict needs ${v.min_n} coins; "helps" only when the whole likely range is better.`, `verdict after ${v.min_n} coins. "W habit" only when it's better for sure-ish.`)}</div>`;
}

function renderJournal(j) {
  if (!j) return "";
  const head = `<h3>${g("Trade journal", "trade diary")} <span class="muted">${g("every trade written down: what went wrong, and what it cost", "every trade written down: what went wrong + what it cost")}</span></h3>`;
  if (!j.trades) return head + `<div class="empty">${g("No closed trades yet.", "no closed trades yet.")}</div>`;
  const TAG = { costly: g("costly", "costly"), "not costly": g("not costly", "fine"), "too early": g("too early", "too early") };
  const cls = { costly: "vet-hurts", "not costly": "vet-helps", "too early": "vet-too_early" };
  const line = (m) => `<li title="${g("avg return", "avg return")} ${pct(m.avg_roi)} ${g("vs", "vs")} ${pct(m.rest_avg_roi)} ${g("for the other trades", "for the rest")}">`
    + `<span class="mem-tag ${cls[m.verdict] || ""}">${TAG[m.verdict] || esc(m.verdict)}</span>`
    + `<span>${esc(m.words)} <span class="muted">· ${int(m.n)} ${g("trades", "trades")}, ${sol(m.pnl)} SOL${m.verdict === "too early" ? ` · ${int(m.n)}/${int(j.min_n)}` : ""}</span></span></li>`;
  return head + `<div class="muted">${int(j.trades)} ${g("trades", "trades")}, ${int(j.clean)} ${g("without a mistake", "clean")}</div>`
    + (j.mistakes.length ? `<ul class="lessons">${j.mistakes.map(line).join("")}</ul>` : "")
    + `<details class="report-box"><summary>${g("Last trades", "last trades")}</summary><ul class="journal">${j.last.map((t) => `<li><span class="muted">${stamp(t.at)}</span> ${esc(t.text)}</li>`).join("")}</ul></details>`
    + `<div class="muted">${g(`"costly" after ${j.min_n} trades, when they did 2+ points worse than the rest. Details: make journal.`, `"costly" after ${j.min_n} trades if they did 2+ pts worse. more: make journal.`)}</div>`;
}

function renderLearner(L) {
  const [left, right] = renderBrain(L.brain).split("<!--split-->");
  let h = "";
  const m = L.model;
  if (m && !m.error) {
    const feats = (m.top_features || []).slice(0, 8);
    const max = Math.max(...feats.map((f) => Math.abs(f[1])), 1e-9);
    h += `<h3>${g("What it pays attention to", "what it pays attention to")} <span class="muted">${g("green: more of it, better results · red: more of it, worse", "green: more = W · red: more = L")}</span></h3>
      <div class="features"><table><tbody>${feats.map(([n, v]) => `<tr><td title="${esc(n)}">${esc(featureWords(n))}</td>
      <td style="width:40%"><div class="bar ${v < 0 ? "neg-bar" : ""}" style="width:${((Math.abs(v) / max) * 100).toFixed(0)}%"></div></td></tr>`).join("")}</tbody></table></div>`;
  } else if (m?.error) {
    h += `<dl class="kv"><dt>model</dt><dd><span class="neg">${esc(m.error)}</span></dd></dl>`;
  }
  const s = L.scoring;
  if (s) {
    h += `<dl class="kv"><dt>${g("wallet scoring", "trader grading")}</dt><dd>${agoSpan(L.scoring_at)} · ${int(s.walletsSeen)} ${g("wallets seen", "traders seen")}, ${int(s.eligible)} ${g("eligible", "good enough")}, ${int(s.tracked)} ${g("tracked", "copied")} (+${int(s.added)} / −${int(s.removed)})</dd></dl>`;
  }
  if (L.report) {
    h += `<details class="report-box"><summary>${esc(L.report.name)} <span class="muted">${stamp(L.report.at)}</span></summary><div class="report">${markdown(L.report.markdown)}</div></details>`;
  } else {
    h += `<div class="empty">${g("No weekly report yet", "no weekly recap yet")} (${g("Sundays", "Sundays")} 01:00 UTC, ${g("or", "or")} <span class="mono">make weekly</span>).</div>`;
  }
  $("learner").innerHTML = `<div class="brain-grid"><div>${left}${h}</div><div>${right ?? ""}${renderVeteran(L.veteran)}${renderJournal(L.journal)}${renderYoutube(L.youtube)}</div></div>`;
}

// Small markdown subset (what learner/weekly_report.py writes): headings, lists, tables, emphasis, code.
function markdown(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<i>$2</i>");
  const out = [];
  let list = false, tbl = null;
  const flush = () => {
    if (list) { out.push("</ul>"); list = false; }
    if (tbl) { out.push(`<table>${tbl.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join("")}</tr>`).join("")}</table>`); tbl = null; }
  };
  for (const line of src.split("\n")) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*\|/.test(line)) {
      if (list) { out.push("</ul>"); list = false; }
      if (/^\s*\|(\s*-+\s*\|)+\s*$/.test(line)) continue;
      (tbl ??= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (tbl) flush();
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    flush();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}

// ---------------------------------------------------------------- charts (hand-rolled SVG + hover tooltip)

const tip = () => $("tip");
function showTip(e, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const w = t.offsetWidth;
  t.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 12)}px`;
  t.style.top = `${e.clientY + 14}px`;
}
const hideTip = () => { tip().hidden = true; };

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0);
  const ticks = [];
  const end = Math.ceil(hi / step - 1e-9) * step; // the top tick always clears the data
  for (let v = Math.floor(lo / step) * step; v <= end + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function lineChart(el, pts, ref, H = 120) {
  if (!pts || pts.length < 2) { el.innerHTML = `<div class="empty">${g("No trades yet.", "no trades yet.")}</div>`; return; }
  const W = el.clientWidth || 600, L = 46, R = 10, T = 6, B = 18;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]).concat([ref]);
  const x0 = xs[0], x1 = Math.max(xs[xs.length - 1], x0 + 1);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0 || y1 * 0.01 || 0.01) * 0.15;
  const ticks = niceTicks(y0 - pad, y1 + pad);
  y0 = ticks[0]; y1 = ticks[ticks.length - 1];
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  let d = `M${X(pts[0][0])},${Y(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0])}V${Y(pts[i][1])}`; // step: equity only moves when a trade closes
  const last = pts[pts.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Equity over time, now ${last[1].toFixed(4)} SOL">
    ${ticks.map((v) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(3)}</text>`).join("")}
    <line class="ref" x1="${L}" x2="${W - R}" y1="${Y(ref)}" y2="${Y(ref)}"/>
    <text class="tick" x="${W - R}" y="${Y(ref) - 4}" text-anchor="end">${g("start", "started")} ${ref}</text>
    <text class="tick" x="${L}" y="${H - 4}">${stamp(x0)}</text><text class="tick" x="${W - R}" y="${H - 4}" text-anchor="end">${g("now", "rn")}</text>
    <path class="line" d="${d}"/>
    <circle class="dot${last[1] >= ref ? " up" : ""}" cx="${X(last[0])}" cy="${Y(last[1])}" r="4"/>
    <line class="cross" id="eq-cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <circle class="dot" id="eq-dot" r="4" visibility="hidden"/>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg>`;
  const svg = el.querySelector("svg"), cross = svg.querySelector("#eq-cross"), dot = svg.querySelector("#eq-dot");
  svg.querySelector(".hit").addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + ((e.clientX - r.left) * (W / r.width) - L) / (W - L - R) * (x1 - x0);
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1][0] <= t) i++;
    const p = pts[i];
    cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(t)); dot.setAttribute("cy", Y(p[1])); dot.setAttribute("visibility", "visible");
    showTip(e, `${stamp(t)}<br><b>${p[1].toFixed(4)} SOL</b> <span class="${cls(p[1] - ref)}">${sol(p[1] - ref)}</span>`);
  });
  svg.querySelector(".hit").addEventListener("mouseleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
}

function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function barChart(el, rows, key, tipText) {
  const W = el.clientWidth || 300, H = 72, L = 34, R = 4, T = 4, B = 16;
  const max = Math.max(1, ...rows.map((r) => r[key]));
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const bw = (W - L - R) / rows.length;
  const Y = (v) => T + (1 - v / top) * (H - T - B);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${key} per hour, last 24 hours">
    ${ticks.map((v) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${v >= 1000 ? `${v / 1000}k` : v}</text>`).join("")}
    ${rows.map((r, i) => {
      const h = Math.max(0, Y(0) - Y(r[key]));
      return `<g data-i="${i}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/>${h > 0 ? `<path class="bar" d="${barPath(L + i * bw + 1, Y(r[key]), Math.max(1, bw - 2), h, 4)}"/>` : ""}</g>`;
    }).join("")}
    <line class="baseline" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>
    <text class="tick" x="${L}" y="${H - 4}">${clock(rows[0].h).slice(0, 5)}</text><text class="tick" x="${W - R}" y="${H - 4}" text-anchor="end">${g("now", "rn")}</text></svg>`;
  el.querySelectorAll("g[data-i]").forEach((g) => {
    const r = rows[+g.dataset.i];
    g.addEventListener("mousemove", (e) => showTip(e, `${clock(r.h).slice(0, 5)}–${clock(r.h + 3600000).slice(0, 5)}<br>${tipText(r)}`));
    g.addEventListener("mouseleave", hideTip);
  });
}

// ---------------------------------------------------------------- live feed

const FILTERS = [
  ["tea", ["Highlights", "the tea"], (i) => ["followed", "rejected", "trade"].includes(i.cat) || (i.cat === "error" && i.kind !== "gap")],
  ["all", ["Everything", "all"], () => true],
  ["followed", ["Copied", "copied"], (i) => i.cat === "followed"],
  ["rejected", ["Skipped", "skipped"], (i) => i.cat === "rejected"],
  ["trades", ["Our trades", "our trades"], (i) => i.cat === "trade"],
  ["errors", ["Problems", "oopsies"], (i) => i.cat === "error"],
  ["wallets", ["Trader moves", "trader moves"], (i) => i.cat === "wallet"],
  ["launches", ["New coins", "new coins"], (i) => i.cat === "launch"],
];
const TAGS = {
  launch: "new coin", wallet_buy: "trader bought", wallet_sell: "trader sold", enter: "copied", reject: "skipped",
  risk_block: "safety limit", paper_buy: "we bought", paper_sell: "we sold", fill_failed: "missed",
  error: "problem", fatal: "stopped working", warn: "warning", info: "note", restart: "restarted", start: "started", stop: "stopped", gap: "data feed",
};
const TAGS_GZ = {
  launch: "new coin", wallet_buy: "trader buy", wallet_sell: "trader sell", enter: "copied", reject: "skipped",
  risk_block: "blocked", paper_buy: "we bought", paper_sell: "we sold", fill_failed: "missed",
  error: "oops", fatal: "down bad", warn: "sus", info: "fyi", restart: "restart", start: "started", stop: "stopped", gap: "feed",
};

function addFeed(items, live) {
  for (const it of items) {
    if (!feed.has(it.id) && live) {
      fresh.add(it.id);
      if (it.kind === "paper_sell") nudge(); // a trade just closed: the bag gets one MSN-style nudge
    }
    feed.set(it.id, it);
  }
  // cap per category, oldest first out
  const byCat = {};
  for (const it of feed.values()) (byCat[it.cat] ??= []).push(it);
  for (const list of Object.values(byCat)) {
    if (list.length > PER_CAT) list.sort((a, b) => a.ts - b.ts).slice(0, list.length - PER_CAT).forEach((i) => feed.delete(i.id));
  }
  renderFeed();
}

function renderFeed() {
  const all = [...feed.values()];
  $("filters").innerHTML = FILTERS.map(([k, [plain, genz], fn]) =>
    `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${g(plain, genz)}<span class="c">${k === "all" ? all.length : all.filter(fn).length}</span></button>`).join("");
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const list = all.filter(fn).sort((a, b) => b.ts - a.ts || (b.id > a.id ? 1 : -1)).slice(0, 300);
  $("feed").innerHTML = list.length ? list.map(feedItem).join("") : `<li class="empty">${g("Nothing here yet.", "nothing here yet.")}</li>`;
  fresh.clear();
}

function feedItem(i) {
  const gz = voice === "genz";
  let body = "";
  if (i.reasons && i.reasons.length) body += `<ul>${i.reasons.map((r) => `<li>${esc(words().skip(r))}</li>`).join("")}</ul>`;
  if (i.kind === "enter" && isNum(i.score)) body += `<div class="muted">${g("trader grade", "trader grade")} ${i.score.toFixed(3)}</div>`;
  if (isNum(i.pnl)) body += `<div>${g("Result", "W/L")} <b class="${cls(i.pnl)}">${sol(i.pnl)} SOL</b> <span class="${cls(i.pnl_pct)}">${pct(i.pnl_pct)}</span></div>`;
  if (i.features) body += `<details data-id="${esc(i.id)}"${expanded.has(i.id) ? " open" : ""}><summary>${g("what the bot saw", "the deets")}</summary><pre>${esc(JSON.stringify(i.features, null, 1))}</pre></details>`;
  return `<li class="ev k-${esc(i.kind)}${i.level ? ` lvl-${esc(i.level)}` : ""}${fresh.has(i.id) ? " new" : ""}">
    <div class="ev-head"><span class="tag">${(gz ? TAGS_GZ : TAGS)[i.kind] || esc(i.kind).toUpperCase()}</span><span class="ev-text" title="${esc(i.text)}">${words().feed(i)}</span>
    <span class="ev-time" title="${new Date(i.ts).toISOString()}">${clock(i.ts)}</span></div>${body}</li>`;
}

$("filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  filter = b.dataset.f;
  renderFeed();
});
$("feed").addEventListener("toggle", (e) => {
  const id = e.target.dataset?.id;
  if (id) e.target.open ? expanded.add(id) : expanded.delete(id);
}, true);

function nudge() {
  const b = $("bag");
  b.classList.remove("nudge");
  void b.offsetWidth; // restart the animation
  b.classList.add("nudge");
}

// ---------------------------------------------------------------- tabs (the last one you used is remembered on this computer)

const TAB_KEY = "dashboard.tab";
const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
function showTab(name, save, focus) {
  if (!tabs.some((t) => t.dataset.tab === name)) name = "home";
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $(`tab-${t.dataset.tab}`).hidden = !on;
    if (on && focus) t.focus();
  }
  document.body.dataset.tab = name;
  if (save) { try { localStorage.setItem(TAB_KEY, name); } catch { /* private window */ } }
  if (snap) render(snap); // charts measure their width, which hidden tabs don't have
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => showTab(t.dataset.tab, true));
  t.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) { e.preventDefault(); showTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true, true); }
  });
});
try { showTab(localStorage.getItem(TAB_KEY) || "home", false); } catch { showTab("home", false); }

// ---------------------------------------------------------------- clocks

setInterval(() => {
  $("clock").textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${new Date().toISOString().slice(11, 16)} UTC`;
  document.querySelectorAll("[data-ago]").forEach((el) => { el.textContent = ago(Number(el.dataset.ago) || 0); });
  if (lastMsg && Date.now() - lastMsg > 40_000) setConn(false, `${g("no update for", "no tea for")} ${dur((Date.now() - lastMsg) / 1000)}`);
}, 1000);
let resizeTimer = 0;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (snap) { renderMoney(snap.money); renderData(snap.data); } }, 120); });

const embedded = document.getElementById("state"); // the state at page load, so the first paint isn't empty
if (embedded) applyState(JSON.parse(embedded.textContent));
connect();
