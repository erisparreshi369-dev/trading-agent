"use strict";
// Read-only view. Everything arrives over /events (Server-Sent Events); nothing is ever sent back.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
const isNum = (x) => typeof x === "number" && isFinite(x);
const sol = (x, d = 4) => (isNum(x) ? `${x > 0 ? "+" : ""}${x.toFixed(d)}` : "–");
const amt = (x, d = 4) => (isNum(x) ? x.toFixed(d) : "–");
const pct = (x, d = 1, sign = true) => (isNum(x) ? `${sign && x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "–");
const cls = (x) => (isNum(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : "");
const int = (x) => (isNum(x) ? Math.round(x).toLocaleString() : "–");
const price = (x) => (isNum(x) && x > 0 ? x.toExponential(3) : "–");
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
let filter = "all";
const expanded = new Set();
const fresh = new Set();
let lastMsg = 0;

// ---------------------------------------------------------------- connection

function applyState(d) {
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
  es.onerror = () => setConn(false, "reconnecting…");
}
function seen() { lastMsg = Date.now(); setConn(true, "live"); }
function setConn(on, text) { const c = $("conn"); c.className = `conn ${on ? "on" : "off"}`; c.textContent = text; }
function problem(msg) { const p = $("problem"); p.hidden = !msg; p.textContent = msg ? `Dashboard can't read the bot's data: ${msg}` : ""; }

// ---------------------------------------------------------------- render all panels

function render(s) {
  snap = s;
  const m = $("mode");
  m.textContent = s.mode === "UNKNOWN" ? "MODE ?" : s.mode;
  m.className = `mode mode-${s.mode}`;
  renderFlags(s);
  renderServices(s.services);
  renderMoney(s.money);
  renderPositions(s.positions);
  renderClosed(s.closed);
  renderRisk(s.risk);
  renderData(s.data);
  renderWallets(s.wallets);
  renderLatency(s.latency);
  renderLearner(s.learner);
  if (s.madeonsol) renderMadeOnSol(s.madeonsol);
}

function renderMadeOnSol(m) {
  const left = Math.max(0, m.limit - m.used_today);
  const job = m.job || {};
  $("madeonsol").innerHTML = `${!m.enabled ? `<div class="muted">Switched off in config.</div>` : ""}
    ${meter("Requests used today", m.used_today, m.limit, int)}
    <dl class="kv"><dt>budget left</dt><dd>${int(left)} today <span class="muted">(the job stops at ${int(m.stop_at)}; resets 00:00 UTC)</span></dd>
      <dt>last success</dt><dd>${agoSpan(m.last_ok_at)}</dd>
      <dt>last error</dt><dd>${m.last_error_at ? `${agoSpan(m.last_error_at)} · <span class="muted">${esc(m.last_error)}</span>` : "none"}</dd>
      <dt>daily job</dt><dd>${m.job_at ? `ran ${agoSpan(m.job_at)}: ${int(job.coins)} coins, ${int(job.creators)} creators, ${int(job.requests)} requests` : "not run yet"}
        ${m.next_run_at ? ` · next ${until(m.next_run_at)}` : ""}</dd>
      <dt>stored</dt><dd>${int(m.creators)} creator records · ${int(m.candidates_on_trial)} ranked traders on a 7-day trial watch</dd></dl>
    <div class="muted">Never used while deciding a trade: the bot reads only what this job stored before.</div>`;
}

function renderFlags(s) {
  const f = [];
  if (s.risk.killed) f.push(`<span class="flag bad">⛔ KILL SWITCH ON</span>`);
  if (s.risk.halted) f.push(`<span class="flag warn">⏸ HALTED until 00:00 UTC</span>`);
  if (s.risk.paper_no_limits && s.mode !== "LIVE") f.push(`<span class="flag warn">practice: limits off</span>`);
  const down = s.services.filter((x) => !x.ok).map((x) => x.name);
  if (down.length) f.push(`<span class="flag bad">✖ ${esc(down.join(", "))} not OK</span>`);
  if (s.data.warnings.length) f.push(`<span class="flag warn">⚠ feed quiet</span>`);
  if (!f.length) f.push(`<span class="flag ok">✔ all systems normal</span>`);
  $("flags").innerHTML = f.join("");
}

function renderServices(list) {
  $("services").innerHTML = list.map((s) => {
    const cl = s.ok ? "ok" : s.state === "stale" || s.state === "scheduled" ? "warn" : "bad";
    let rows = "";
    let extra = "";
    if (s.name === "learner") {
      rows = s.runs.map((r) => `<dt>${esc(r.unit)}</dt><dd title="${esc(r.label)}">last ${agoSpan(r.last_run_at)}${r.result && r.result !== "success" ? ` <b class="neg">${esc(r.result)}</b>` : ""} · next ${until(r.next_at)}</dd>`).join("");
      rows += `<dt>restarts</dt><dd>${int(s.restarts)}</dd>`;
    } else {
      rows = `<dt>uptime</dt><dd>${s.uptime_s != null ? dur(s.uptime_s) : "–"}</dd>
        <dt>heartbeat</dt><dd>${agoSpan(s.heartbeat_at)}</dd>
        <dt>restarts</dt><dd>${int(s.restarts)} by systemd · ${int(s.crashes_today)} crash${s.crashes_today === 1 ? "" : "es"} today</dd>
        ${s.crash_detail ? `<dt>last crash</dt><dd title="${esc(s.crash_detail)}">${esc(s.crash_detail)}</dd>` : ""}`;
      const i = s.info || {};
      if (s.name === "collector") {
        const st = i.streams || {};
        const sv = (k) => `${k} ${st[k] ? "up" : st[k] === null || st[k] === undefined ? "off" : "DOWN"}`;
        extra = `${sv("firehose")}${st.firehoseOff ? ` (${esc(st.firehoseOff)})` : ""} · ${sv("targeted")} [${int(st.targetedSubs)} subs] · ${sv("pumpportal")}`;
      } else if (s.name === "trader") {
        extra = `signals ${int(i.signals)} · entered ${int(i.entered)} · errors ${int(i.errors)} (this run)`;
      } else if (s.name === "notifier") {
        extra = `Telegram sent ${int(i.sent)} · failed ${int(i.failed)}`;
      }
    }
    return `<div class="svc ${cl}"><div class="svc-head"><span class="svc-name">${esc(s.name)}</span>
      <span class="svc-state">${s.ok ? "●" : "○"} ${esc(s.state)}</span></div><dl>${rows}</dl>${extra ? `<div class="extra">${extra}</div>` : ""}</div>`;
  }).join("");
}

function kpi(label, value, sub = "", klass = "", hero = false) {
  return `<div class="kpi${hero ? " hero" : ""}"><div class="l">${label}</div><div class="v num ${klass}">${value}</div><div class="s">${sub}</div></div>`;
}

function renderMoney(m) {
  if (!m.started) {
    $("kpis").innerHTML = `<div class="empty">Paper trading hasn't started yet.</div>`;
    $("equity").innerHTML = "";
    return;
  }
  const wl = isNum(m.avg_win) && isNum(m.avg_loss) && m.avg_loss !== 0 ? `ratio ${(m.avg_win / -m.avg_loss).toFixed(2)}` : "";
  $("kpis").innerHTML = [
    kpi("Equity, SOL", `${amt(m.equity)}`, `start ${amt(m.start, 2)} · unrealized <span class="${cls(m.unrealized)}">${sol(m.unrealized)}</span>`, "", true),
    kpi("Free balance", `${amt(m.balance)}`, "SOL not in positions"),
    kpi("PnL today", sol(m.pnl_today), `realized ${sol(m.realized_today)} · ${pct(m.pnl_today / m.start)}`, cls(m.pnl_today)),
    kpi("PnL 7 days", sol(m.realized_7d), "realized", cls(m.realized_7d)),
    kpi("PnL all time", sol(m.pnl_all), `${pct(m.pnl_all / m.start)} incl. open`, cls(m.pnl_all)),
    kpi("Win rate", isNum(m.win_rate) ? pct(m.win_rate, 0, false) : "–", `${int(m.closed)} closed · ${int(m.failed_fills)} failed fills`),
    kpi("Avg win / loss", `<span class="pos">${sol(m.avg_win)}</span> <span class="muted">/</span> <span class="neg">${sol(m.avg_loss)}</span>`, wl),
    kpi("Max drawdown", pct(m.max_drawdown, 1, false), "peak to trough", m.max_drawdown > 0 ? "neg" : ""),
    kpi("Costs paid", `${amt(m.fees_paid + m.slippage_cost)}`, `fees ${amt(m.fees_paid)} · slippage ≈${amt(m.slippage_cost)}`),
  ].join("");
  $("curve-note").textContent = "steps at each closed trade; last point is marked-to-market now";
  lineChart($("equity"), m.curve, m.start);
}

function renderPositions(ps) {
  $("pos-count").textContent = `${ps.length} live`;
  $("positions").innerHTML = table(
    [["Token"], ["Status"], ["Leader"], ["Cost SOL", 1], ["Entry px", 1], ["Last px", 1], ["Value SOL", 1], ["Unrealized SOL", 1], ["Unrl. %", 1], ["Age", 1], ["Exit"]],
    ps.map((p) => `<tr><td>${tok(p.symbol, p.mint)}</td><td>${esc(p.status)}</td><td class="mono">${short(p.leader)}</td>
      <td class="n">${amt(p.cost_sol ?? p.size_sol)}</td><td class="n">${price(p.entry_price)}</td><td class="n">${price(p.last_price)}</td>
      <td class="n">${amt(p.mark_sol)}</td><td class="n ${cls(p.unrealized_sol)}">${sol(p.unrealized_sol)}</td><td class="n ${cls(p.unrealized_pct)}">${pct(p.unrealized_pct)}</td>
      <td class="n">${p.opened_at ? agoSpan(p.opened_at).replace(" ago", "") : "fill due " + until(p.entry_due_at)}</td>
      <td>${p.exit_trigger ? `exiting: ${esc(p.exit_trigger)}` : ""}</td></tr>`),
    "No open positions.",
  );
}

function renderClosed(rows) {
  $("closed").innerHTML = table(
    [["Closed"], ["Token"], ["Leader"], ["Entry px", 1], ["Exit px", 1], ["Size SOL", 1], ["PnL SOL", 1], ["PnL %", 1], ["Hold", 1], ["Exit reason"]],
    rows.map((r) => `<tr class="${r.status === "failed" ? "failed" : ""}"><td>${stamp(r.closed_at)}</td><td>${tok(r.symbol, r.mint)}</td>
      <td class="mono">${short(r.leader_wallet)}</td><td class="n">${price(r.entry_price)}</td><td class="n">${price(r.exit_price)}</td>
      <td class="n">${amt(r.size_sol)}</td><td class="n ${cls(r.pnl_sol)}">${sol(r.pnl_sol)}</td><td class="n ${cls(r.pnl_pct)}">${pct(r.pnl_pct)}</td>
      <td class="n">${r.hold_ms != null ? dur(r.hold_ms / 1000) : "–"}</td>
      <td>${r.status === "failed" ? `fill failed: ${esc(r.exit_reason)}` : esc(r.exit_reason)}</td></tr>`),
    "No closed trades yet.",
  );
}

function meter(label, used, cap, fmt) {
  if (cap === null || cap === undefined) {
    return `<div class="meter"><div class="row"><span>${label}</span><span class="num">${fmt(used)} <span class="muted">· no limit (practice)</span></span></div></div>`;
  }
  const frac = isNum(used) && cap ? used / cap : 0;
  const level = frac >= 1 ? "bad" : frac >= 0.6 ? "warn" : "";
  return `<div class="meter ${level}"><div class="row"><span>${label}</span><span class="num">${fmt(used)} / ${fmt(cap)}</span></div>
    <div class="track" role="meter" aria-label="${label}" aria-valuenow="${isNum(used) ? used : 0}" aria-valuemax="${cap}"><div class="fill" style="width:${Math.min(100, frac * 100).toFixed(1)}%"></div></div></div>`;
}

function renderRisk(r) {
  const p0 = (x) => pct(x, 1, false);
  const L = r.limits || {};
  $("risk").innerHTML = `${r.paper_no_limits ? `<div class="warnbox">Practice trading without limits: no cap on open trades, trades per day, size or losses. Real-money limits stay locked. Stop loss, 30-min exit and the emergency stop still work.</div>` : ""}
    <div class="state-row">
      <span class="pill ${r.killed ? "bad" : "ok"}">${r.killed ? "⛔ kill switch ON" : "✔ kill switch off"}</span>
      <span class="pill ${r.halted ? "warn" : "ok"}">${r.halted ? "⏸ halted for today" : "✔ not halted"}</span></div>
    ${r.killed ? `<div class="muted">${esc(r.kill_reason || "")} ${r.kill_at ? "· " + stamp(r.kill_at) : ""}</div>` : ""}
    ${meter("Daily loss vs cap", r.daily_loss, r.daily_cap, p0)}
    ${meter("Drawdown from start vs cap", r.drawdown, r.drawdown_cap, p0)}
    ${meter("Open positions", r.open, r.max_open, int)}
    ${meter("Entries today", r.entries_today, r.max_entries, int)}
    <dl class="kv"><dt>position size</dt><dd>${p0(L.MAX_POSITION_PCT)} of equity${r.paper_no_limits ? " (no cap in practice)" : `, max ${L.MAX_POSITION_SOL} SOL`}</dd>
      <dt>stop loss</dt><dd>−${p0(L.STOP_LOSS_PCT)}</dd><dt>time exit</dt><dd>${dur(L.TIME_EXIT_MS / 1000)}</dd>
      <dt>reserve</dt><dd>${L.MIN_FREE_BALANCE_SOL} SOL kept free</dd></dl>
    <div class="muted">${r.paper_no_limits ? "Real-money limits (locked, used for live trading)" : "Hard limits"} from trader/src/risk/limits.ts. Daily cap resets 00:00 UTC; the kill switch needs <span class="mono">make unkill</span>.</div>`;
}

function renderData(d) {
  const st = d.streams || {};
  const pill = (k) => `<span class="pill ${st[k] ? "ok" : st[k] === false ? "bad" : ""}">${k} ${st[k] ? "up" : st[k] === false ? "DOWN" : "off"}</span>`;
  $("data").innerHTML = `${d.warnings.map((w) => `<div class="warnbox">${esc(w)}</div>`).join("")}
    <div class="state-row">${pill("firehose")}${pill("targeted")}${pill("pumpportal")}</div>
    ${st.firehoseOff ? `<div class="muted">firehose off: ${esc(st.firehoseOff)}</div>` : ""}
    <dl class="kv"><dt>tokens</dt><dd>${int(d.tokens)} total · ${int(d.tokens_1h)} last hour</dd>
      <dt>trades</dt><dd>${int(d.trades)} total · ${int(d.trades_1h)} last hour</dd>
      <dt>last event</dt><dd>${agoSpan(d.last_event_at)} <span class="muted">(trade ${agoSpan(d.last_trade_at)}, launch ${agoSpan(d.last_token_at)})</span></dd>
      <dt>database</dt><dd>${bytes(d.db_bytes)}</dd>
      ${d.open_gaps.length ? `<dt>open gaps</dt><dd>${d.open_gaps.map((g) => `${esc(g.source)}: ${esc(g.reason)} (${agoSpan(g.started_at)})`).join("<br>")}</dd>` : ""}
    </dl>
    ${isNum(d.helius_mb) ? meter("Helius data today (MB)", d.helius_mb, d.helius_cap_mb, (x) => int(x)) : ""}
    ${isNum(d.helius_mb_per_hour) ? `<dl class="kv"><dt>speed</dt><dd>${int(d.helius_mb_per_hour)} MB/h · ${d.helius_mb >= d.helius_cap_mb ? "cap reached"
      : d.helius_cap_at ? `cap at ${clock(d.helius_cap_at).slice(0, 5)} at this speed` : "lasts the day at this speed"}</dd>
      <dt>mode</dt><dd>${esc((d.data_mode || "?").replace("_", " "))}${d.budget_steps_pct ? ` <span class="muted">(lighter at ${d.budget_steps_pct.join(" / ")}%)</span>` : ""}</dd></dl>` : ""}
    <div class="chart-head"><h3>Helius MB per hour</h3><span class="muted">last 24 h</span></div>
    <div id="hourly-mb" class="chart"></div>
    <div class="chart-head"><h3>Trades collected per hour</h3><span class="muted">last 24 h</span></div>
    <div id="hourly" class="chart"></div>`;
  barChart($("hourly-mb"), d.hourly, "mb", (r) => `<b>${int(r.mb)} MB</b> from Helius`);
  barChart($("hourly"), d.hourly, "trades", (r) => `<b>${int(r.trades)}</b> trades · ${int(r.tokens)} launches`);
}

function renderWallets(w) {
  $("wallets-note").textContent = `${w.active.length} active · last scored ${w.last_run_at ? ago(w.last_run_at) : "never"}`;
  $("wallets").innerHTML = table(
    [["Wallet"], ["Score", 1], ["Confidence", 1], ["Copyable", 1], ["Copy ROI", 1], ["Copy win", 1], ["Trades 24h", 1], ["Last trade", 1], ["Signals 24h", 1], ["Paper PnL", 1]],
    w.active.map((x) => `<tr><td class="mono" title="${esc(x.wallet)}">${esc(x.label || short(x.wallet))}</td>
      <td class="n">${isNum(x.score) ? x.score.toFixed(3) : "–"}</td><td class="n">${pct(x.confidence, 0, false)}</td>
      <td class="n">${int(x.copy_trades)}${x.copy_missed ? ` <span class="muted">(+${x.copy_missed} missed)</span>` : ""}</td>
      <td class="n ${cls(x.copy_roi)}">${pct(x.copy_roi)}</td><td class="n">${pct(x.copy_win_rate, 0, false)}</td>
      <td class="n">${int(x.trades_24h)}</td><td class="n">${agoSpan(x.last_trade_at)}</td>
      <td class="n">${int(x.signals_24h)} <span class="muted">(${int(x.followed_24h)} followed)</span></td>
      <td class="n ${cls(x.paper_pnl)}">${sol(x.paper_pnl)}</td></tr>`),
    "No wallets tracked yet: scoring adds them (make score, daily at 00:15 UTC).",
  );
  $("dropped-count").textContent = `(${w.dropped.length})`;
  $("dropped").innerHTML = table(
    [["Wallet"], ["Dropped"], ["Why"], ["Score then", 1], ["Copyable", 1]],
    w.dropped.map((x) => `<tr><td class="mono" title="${esc(x.wallet)}">${esc(x.label || short(x.wallet))}</td><td>${stamp(x.deactivated_at)}</td>
      <td>${esc(x.deactivated_reason)}</td><td class="n">${isNum(x.score) ? x.score.toFixed(3) : "–"}</td><td class="n">${int(x.copy_trades)}</td></tr>`),
    "None dropped yet.",
  );
}

function renderLatency(l) {
  $("latency").innerHTML = table(
    [["Stage"], ["p50", 1], ["p95", 1], ["n", 1]],
    l.stages.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="muted">${esc(s.desc)}</span></td>
      <td class="n">${ms(s.p50)}</td><td class="n">${ms(s.p95)}</td><td class="n">${int(s.n)}</td></tr>`),
    "No signals yet.",
  ) + `<div class="muted">${esc(l.note)}. Paper fills land after the configured execution delay.</div>`;
}

function renderLearner(L) {
  let h = "";
  const m = L.model;
  if (m && !m.error) {
    const feats = (m.top_features || []).slice(0, 10);
    const max = Math.max(...feats.map((f) => Math.abs(f[1])), 1e-9);
    h += `<dl class="kv"><dt>model</dt><dd><b>${esc(m.version)}</b></dd><dt>last retrain</dt><dd>${stamp(m.trained_at)} (${agoSpan(m.trained_at)})</dd>
      ${m.metrics ? Object.entries(m.metrics).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(isNum(v) ? v.toFixed(4) : v)}</dd>`).join("") : ""}</dl>
      <h3>Top features</h3><div class="features"><table><tbody>${feats.map(([n, v]) => `<tr><td>${esc(n)}</td>
      <td class="n">${isNum(v) ? v.toFixed(3) : esc(v)}</td><td style="width:45%"><div class="bar" style="width:${((Math.abs(v) / max) * 100).toFixed(0)}%"></div></td></tr>`).join("")}</tbody></table></div>`;
  } else {
    h += `<dl class="kv"><dt>model</dt><dd>${m?.error ? `<span class="neg">${esc(m.error)}</span>` : "none yet: the Phase 4 learner writes models/current.json"}</dd></dl>`;
  }
  const s = L.scoring;
  if (s) {
    h += `<dl class="kv"><dt>wallet scoring</dt><dd>${agoSpan(L.scoring_at)} · ${int(s.walletsSeen)} wallets seen, ${int(s.eligible)} eligible, ${int(s.tracked)} tracked (+${int(s.added)} / −${int(s.removed)})</dd></dl>`;
  }
  if (L.report) {
    h += `<h3>${esc(L.report.name)} <span class="muted">${stamp(L.report.at)}</span></h3><div class="report">${markdown(L.report.markdown)}</div>`;
  } else {
    h += `<div class="empty">No weekly report yet (Sundays 01:00 UTC, or <span class="mono">make weekly</span>).</div>`;
  }
  $("learner").innerHTML = h;
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

function lineChart(el, pts, ref) {
  if (!pts || pts.length < 2) { el.innerHTML = `<div class="empty">No trades yet.</div>`; return; }
  const W = el.clientWidth || 600, H = 180, L = 52, R = 12, T = 8, B = 22;
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
    <text class="tick" x="${W - R}" y="${Y(ref) - 4}" text-anchor="end">start ${ref}</text>
    <text class="tick" x="${L}" y="${H - 6}">${stamp(x0)}</text><text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">now</text>
    <path class="line" d="${d}"/>
    <circle class="dot" cx="${X(last[0])}" cy="${Y(last[1])}" r="4"/>
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
  const W = el.clientWidth || 300, H = 110, L = 44, R = 4, T = 6, B = 18;
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
    <text class="tick" x="${L}" y="${H - 4}">${clock(rows[0].h).slice(0, 5)}</text><text class="tick" x="${W - R}" y="${H - 4}" text-anchor="end">now</text></svg>`;
  el.querySelectorAll("g[data-i]").forEach((g) => {
    const r = rows[+g.dataset.i];
    g.addEventListener("mousemove", (e) => showTip(e, `${clock(r.h).slice(0, 5)}–${clock(r.h + 3600000).slice(0, 5)}<br>${tipText(r)}`));
    g.addEventListener("mouseleave", hideTip);
  });
}

// ---------------------------------------------------------------- live feed

const FILTERS = [
  ["all", "All", () => true],
  ["followed", "Followed", (i) => i.cat === "followed"],
  ["rejected", "Rejected", (i) => i.cat === "rejected"],
  ["trades", "Trades", (i) => i.cat === "trade"],
  ["errors", "Errors", (i) => i.cat === "error"],
  ["wallets", "Wallet trades", (i) => i.cat === "wallet"],
  ["launches", "Launches", (i) => i.cat === "launch"],
];
const TAGS = {
  launch: "LAUNCH", wallet_buy: "WALLET BUY", wallet_sell: "WALLET SELL", enter: "FOLLOWED", reject: "REJECTED",
  risk_block: "RISK BLOCK", paper_buy: "PAPER BUY", paper_sell: "PAPER SELL", fill_failed: "FILL FAILED",
  error: "ERROR", fatal: "FATAL", warn: "WARN", info: "INFO", restart: "RESTART", start: "STARTED", stop: "STOPPED", gap: "STREAM",
};

function addFeed(items, live) {
  for (const it of items) {
    if (!feed.has(it.id) && live) fresh.add(it.id);
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
  $("filters").innerHTML = FILTERS.map(([k, label, fn]) =>
    `<button role="tab" data-f="${k}" aria-selected="${filter === k}">${label}<span class="c">${k === "all" ? all.length : all.filter(fn).length}</span></button>`).join("");
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const list = all.filter(fn).sort((a, b) => b.ts - a.ts || (b.id > a.id ? 1 : -1)).slice(0, 300);
  $("feed").innerHTML = list.length ? list.map(feedItem).join("") : `<li class="empty">Nothing here yet.</li>`;
  fresh.clear();
}

function feedItem(i) {
  let body = "";
  if (i.reasons && i.reasons.length) body += `<ul>${i.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  if (i.kind === "enter" && isNum(i.score)) body += `<div class="muted">score ${i.score.toFixed(3)}</div>`;
  if (isNum(i.pnl)) body += `<div>PnL <b class="${cls(i.pnl)}">${sol(i.pnl)} SOL</b> <span class="${cls(i.pnl_pct)}">${pct(i.pnl_pct)}</span></div>`;
  if (i.features) body += `<details data-id="${esc(i.id)}"${expanded.has(i.id) ? " open" : ""}><summary>features</summary><pre>${esc(JSON.stringify(i.features, null, 1))}</pre></details>`;
  return `<li class="ev k-${esc(i.kind)}${i.level ? ` lvl-${esc(i.level)}` : ""}${fresh.has(i.id) ? " new" : ""}">
    <div class="ev-head"><span class="tag">${TAGS[i.kind] || esc(i.kind).toUpperCase()}</span><span class="ev-text">${esc(i.text)}</span>
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

// ---------------------------------------------------------------- clocks

setInterval(() => {
  $("clock").textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${new Date().toISOString().slice(11, 16)} UTC`;
  document.querySelectorAll("[data-ago]").forEach((el) => { el.textContent = ago(Number(el.dataset.ago) || 0); });
  if (lastMsg && Date.now() - lastMsg > 40_000) setConn(false, `no update for ${dur((Date.now() - lastMsg) / 1000)}`);
}, 1000);
window.addEventListener("resize", () => { if (snap) { renderMoney(snap.money); renderData(snap.data); } });

const embedded = document.getElementById("state"); // the state at page load, so the first paint isn't empty
if (embedded) applyState(JSON.parse(embedded.textContent));
connect();
