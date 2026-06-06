/* =====================================================================
 *  hl-portfolio.js — PORTFOLIO ANALYTICS  (Portfolio agent — v2 elevated)
 *  ---------------------------------------------------------------------
 *  Renders inside #hlPortfolioMount:
 *    1) KPI stat grid — premium cards with hierarchy, tone chips, top-rule
 *       grouping labels. Includes "Today's PnL" KPI.
 *    2) Per-coin realized PnL breakdown — top 3 coins by |realized|, mini bars.
 *    3) Equity curve SVG — gridlines, gradient area, refined floating tooltip
 *       with time + value + crosshair, min/mid/max axis labels, pill toggles.
 *    4) Fills history — tabular-num alignment, sticky header, color-coded side
 *       + closedPnl, custom scrollbar, graceful empty state.
 *
 *  Polls clearinghouse + fills every ~6 s only while the trade view is
 *  visible AND an account is connected. Reacts to lz:route, lz:hl:net,
 *  shared onChange. No build, no npm, no external libs.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";
import { state, onChange, toast, shortAddr } from "./shared.js";

/* ─── module state ─────────────────────────────────────────── */
let mount    = null;
let active   = false;
let pollTimer = null;
let booted   = false;
let ch       = null;      // last clearinghouse snapshot
let fills    = [];        // userFills (newest first)
let loadSeq  = 0;         // guards out-of-order async loads
let eqPeriod = "all";     // "all" | "7d" | "30d" | "24h"

const POLL_MS       = 6000;
const MAX_FILLS     = 100;
const EQ_MAX_POINTS = 240;

/* ─── tiny helpers ─────────────────────────────────────────── */
const $ = (sel) => (mount ? mount.querySelector(sel) : null);

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };

function usd(v){
  const n = num(v);
  if (n == null) return "—";
  const abs = Math.abs(n);
  const opt = abs >= 10000 ? { maximumFractionDigits: 0 }
            : abs >= 1     ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            :                { maximumFractionDigits: 4 };
  return (n < 0 ? "−$" : "$") + abs.toLocaleString("en-US", opt);
}
function signedUsd(v){
  const n = num(v);
  if (n == null) return "—";
  const abs = Math.abs(n);
  const str = abs.toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? "+" : "−") + "$" + str;
}
function pxStr(v){
  const n = num(v);
  if (n == null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1)    return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function szStr(v){
  const n = num(v);
  if (n == null) return "—";
  return Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function pctStr(v){
  const n = num(v);
  if (n == null) return "—";
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";
}
function net(){
  try { return HL.getNetwork(); } catch { return "testnet"; }
}
function timeStr(ms){
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "—";
  const D = new Intl.DateTimeFormat("en-US",
    { month: "short", day: "numeric" }).format(d);
  const T = new Intl.DateTimeFormat("en-US",
    { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${D} ${T}`;
}
function timeShort(ms){
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      hour12: false }).format(d);
}

/* ─── Today's PnL helper ───────────────────────────────────── */
function todayPnl(){
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const cutoff = midnight.getTime();
  let total = 0, have = false;
  for (const f of fills){
    if (Number(f.time) < cutoff) continue;
    const cp  = num(f.closedPnl);
    const fee = num(f.fee);
    if (cp != null || fee != null){
      total += (cp || 0) - (fee || 0);
      have = true;
    }
  }
  return have ? total : null;
}

/* ─── Trading stats computation ────────────────────────────── */
function buildTradingStats(){
  // Only closing fills (closedPnl != 0) are counted as "trades"
  const closing = fills.filter(f => {
    const cp = num(f.closedPnl);
    return cp != null && cp !== 0;
  });

  if (!closing.length) return null;

  let wins = 0, losses = 0;
  let sumWin = 0, sumLoss = 0;
  let bestPnl = -Infinity, bestCoin = null;
  let worstPnl = Infinity, worstCoin = null;
  let totalFees = 0;

  for (const f of closing){
    const cp  = num(f.closedPnl);
    const fee = num(f.fee) || 0;
    totalFees += fee;
    const net_ = cp - fee;

    if (net_ >= 0){
      wins++;
      sumWin += net_;
    } else {
      losses++;
      sumLoss += net_;
    }

    // best/worst by raw closedPnl (before fee, matches user expectations on HL)
    if (cp > bestPnl){ bestPnl = cp; bestCoin = f.coin || "?"; }
    if (cp < worstPnl){ worstPnl = cp; worstCoin = f.coin || "?"; }
  }

  const total     = closing.length;
  const winRate   = total > 0 ? (wins / total) * 100 : null;
  const avgWin    = wins   > 0 ? sumWin  / wins   : null;
  const avgLoss   = losses > 0 ? sumLoss / losses  : null;
  const profitFactor = losses > 0 && sumLoss !== 0
    ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? Infinity : null);

  return {
    total,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    bestPnl:  bestPnl  === -Infinity ? null : bestPnl,
    bestCoin,
    worstPnl: worstPnl ===  Infinity ? null : worstPnl,
    worstCoin,
    totalFees,
  };
}

/* ─── Trading stats panel render ────────────────────────────── */
function renderTradingStats(){
  const s = buildTradingStats();

  if (!fills.length){
    return `<div class="pf-panel pf-stats-panel">
      <div class="pf-panel-head">
        <span class="pf-panel-title">Trading stats</span>
      </div>
      <div class="pf-fills-empty">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"
             width="16" height="16" aria-hidden="true">
          <path d="M10 3v14M3 10h14" stroke-linecap="round"/>
        </svg>
        No closing fills yet.
      </div>
    </div>`;
  }

  if (!s){
    return `<div class="pf-panel pf-stats-panel">
      <div class="pf-panel-head">
        <span class="pf-panel-title">Trading stats</span>
        <span class="pf-hint">based on closing fills</span>
      </div>
      <div class="pf-fills-empty">No closed trades recorded.</div>
    </div>`;
  }

  /* Win-rate ratio bar */
  const wrPct  = s.winRate != null ? s.winRate.toFixed(1) + "%" : "—";
  const wrFill = s.winRate != null ? s.winRate.toFixed(2) : "0";
  const lrFill = s.winRate != null ? (100 - s.winRate).toFixed(2) : "0";

  /* Profit factor display */
  let pfStr = "—";
  if (s.profitFactor === Infinity){ pfStr = "∞"; }
  else if (s.profitFactor != null){ pfStr = s.profitFactor.toFixed(2); }

  /* Best / worst tags */
  const bestStr  = s.bestPnl  != null ? signedUsd(s.bestPnl)  : "—";
  const worstStr = s.worstPnl != null ? signedUsd(s.worstPnl) : "—";

  const pfTone = s.profitFactor == null ? "mute"
    : s.profitFactor >= 1.5 ? "pos"
    : s.profitFactor >= 1   ? ""
    : "neg";

  return `<div class="pf-panel pf-stats-panel">
    <div class="pf-panel-head">
      <span class="pf-panel-title">Trading stats</span>
      <span class="pf-hint">closing fills · net of fees</span>
    </div>
    <div class="pf-stats-grid">

      <!-- Win rate -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Win rate</span>
        <span class="pf-stat-val ${s.winRate != null && s.winRate >= 50 ? "pos" : "neg"}">${wrPct}</span>
        <span class="pf-stat-sub">${s.wins}W · ${s.losses}L of ${s.total} trades</span>
        <div class="pf-wr-bar" role="meter" aria-valuenow="${wrFill}" aria-valuemin="0" aria-valuemax="100">
          <div class="pf-wr-win"  style="width:${wrFill}%"></div>
          <div class="pf-wr-loss" style="width:${lrFill}%"></div>
        </div>
      </div>

      <!-- Avg win / loss + profit factor -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Avg win</span>
        <span class="pf-stat-val pos">${s.avgWin != null ? signedUsd(s.avgWin) : "—"}</span>
        <span class="pf-stat-sub pf-stat-sub--row">
          <span class="pf-stat-sub-item">
            <span class="pf-stat-sub-lab">avg loss</span>
            <span class="neg">${s.avgLoss != null ? signedUsd(s.avgLoss) : "—"}</span>
          </span>
        </span>
      </div>

      <!-- Profit factor -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Profit factor</span>
        <span class="pf-stat-val ${pfTone}">${pfStr}</span>
        <span class="pf-stat-sub">sum wins / |sum losses|</span>
      </div>

      <!-- Best trade -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Best trade</span>
        <span class="pf-stat-val pos">${bestStr}</span>
        ${s.bestCoin ? `<span class="pf-stat-coin-tag">${esc(s.bestCoin)}</span>` : ""}
      </div>

      <!-- Worst trade -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Worst trade</span>
        <span class="pf-stat-val neg">${worstStr}</span>
        ${s.worstCoin ? `<span class="pf-stat-coin-tag">${esc(s.worstCoin)}</span>` : ""}
      </div>

      <!-- Total trades + fees -->
      <div class="pf-stat-card">
        <span class="pf-stat-lab">Total fees paid</span>
        <span class="pf-stat-val mute">${usd(s.totalFees)}</span>
        <span class="pf-stat-sub">${s.total} closed trades</span>
      </div>

    </div>
  </div>`;
}

/* ─── Per-coin realized PnL breakdown ─────────────────────── */
function buildCoinPnl(){
  const map = new Map(); // coin -> { realized, fee }
  for (const f of fills){
    const cp  = num(f.closedPnl);
    const fee = num(f.fee);
    if ((cp == null || cp === 0) && (fee == null || fee === 0)) continue;
    const coin = f.coin || "?";
    if (!map.has(coin)) map.set(coin, { realized: 0, fee: 0 });
    const entry = map.get(coin);
    entry.realized += (cp  || 0);
    entry.fee      += (fee || 0);
  }
  const entries = [];
  for (const [coin, d] of map){
    const net_ = d.realized - d.fee;
    entries.push({ coin, net: net_, realized: d.realized, fee: d.fee });
  }
  // sort by |net|, take top 3
  entries.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return entries.slice(0, 3);
}

/* ─── equity-curve persistence (sampled accountValue) ──────── */
function eqKey(account){
  return `lz.hl.equity:${(account||"").toLowerCase()}:${net()}`;
}
function loadEqSamples(account){
  if (!account) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(eqKey(account)) || "[]");
    return Array.isArray(raw)
      ? raw.filter(p => p && isFinite(p.t) && isFinite(p.v))
      : [];
  } catch { return []; }
}
function sampleEquity(account, accountValue){
  const v = num(accountValue);
  if (!account || v == null) return;
  try {
    const arr = loadEqSamples(account);
    const last = arr[arr.length - 1];
    const now  = Date.now();
    if (last && now - last.t < 30000 && Math.abs(last.v - v) < 1e-6) return;
    arr.push({ t: now, v });
    while (arr.length > EQ_MAX_POINTS) arr.shift();
    localStorage.setItem(eqKey(account), JSON.stringify(arr));
  } catch { /* storage full — non-fatal */ }
}

/* Build the equity series.  Prefer sampled accountValue history; fall
 * back to cumulative realized-PnL from fills when < 2 samples.
 * Applies the active eqPeriod filter. */
function buildEquitySeries(account){
  const now    = Date.now();
  const cutoff = eqPeriod === "24h" ? now - 86400000
               : eqPeriod === "7d"  ? now - 7  * 86400000
               : eqPeriod === "30d" ? now - 30 * 86400000
               : 0;

  const allSamples = loadEqSamples(account);
  const samples = cutoff ? allSamples.filter(p => p.t >= cutoff) : allSamples;

  if (samples.length >= 2){
    return { mode: "equity", pts: samples.map(p => ({ t: p.t, v: p.v })) };
  }
  // cumulative realized PnL from fills (chronological)
  const chrono = fills.slice().sort((a,b) => Number(a.time) - Number(b.time));
  const chronoF = cutoff ? chrono.filter(f => Number(f.time) >= cutoff) : chrono;
  if (chronoF.length >= 2){
    let cum = 0;
    const pts = chronoF.map(f => {
      cum += (num(f.closedPnl)||0) - (num(f.fee)||0);
      return { t: Number(f.time), v: cum };
    });
    return { mode: "pnl", pts };
  }
  if (samples.length === 1) return { mode:"equity", pts: samples.map(p=>({t:p.t,v:p.v})) };
  return { mode: "empty", pts: [] };
}

/* ─── one-time scaffold ────────────────────────────────────── */
function ensureScaffold(){
  if (booted || !mount) return;
  booted = true;
  mount.classList.add("hl-pf");
  mount.innerHTML = `
    <div class="pf-head">
      <div class="pf-title-row">
        <span class="pf-section-label">Portfolio</span>
        <span class="pf-title-sep" aria-hidden="true">·</span>
        <span class="pf-section-sub">Analytics</span>
        <span class="pf-net" id="pfNet">${esc(net())}</span>
      </div>
    </div>
    <div id="pfBody"></div>`;
  mount.addEventListener("click", onMountClick);
  // tooltip container (shared for equity chart)
  const tip = document.createElement("div");
  tip.className = "pf-eq-tip";
  tip.id = "pfEqTip";
  tip.hidden = true;
  document.body.appendChild(tip);
}

function onMountClick(e){
  const periodBtn = e.target.closest && e.target.closest("[data-eq-period]");
  if (periodBtn){
    eqPeriod = periodBtn.getAttribute("data-eq-period");
    renderEquitySection();
    return;
  }
}

/* ─── render ───────────────────────────────────────────────── */
function render(){
  if (!mount) return;
  ensureScaffold();
  const netEl = $("#pfNet");
  if (netEl) netEl.textContent = net();
  const body = $("#pfBody");
  if (!body) return;

  if (!state.account){
    body.innerHTML = `
      <div class="pf-empty">
        <div class="pf-empty-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"
               stroke-linecap="round" stroke-linejoin="round" width="28" height="28">
            <path d="M3 17l5-5 4 4 8-8M21 8v4h-4"/>
          </svg>
        </div>
        <div class="pf-empty-t">Connect a wallet</div>
        <div class="pf-empty-b">Account value, equity curve, PnL summary and
          fills history appear here once a wallet is connected.</div>
      </div>`;
    return;
  }

  body.innerHTML =
    renderKpis() +
    renderCoinPnl() +
    renderTradingStats() +
    renderEquity() +
    renderFills();

  wireEquityHover();
}

/* Re-render only the equity panel (period switch) without touching KPIs/fills */
function renderEquitySection(){
  if (!mount) return;
  const existing = mount.querySelector(".pf-equity");
  if (!existing) { render(); return; }
  const tmp = document.createElement("div");
  tmp.innerHTML = renderEquity();
  const next = tmp.firstElementChild;
  if (next) existing.replaceWith(next);
  wireEquityHover();
}

/* ─── KPI stat grid ────────────────────────────────────────── */
function renderKpis(){
  const ms  = (ch && ch.marginSummary) || {};
  const accountValue  = num(ms.accountValue);
  const maintMargin   = num(ch && ch.crossMaintenanceMarginUsed);
  const marginUsed    = num(ms.totalMarginUsed);
  const ntlPos        = num(ms.totalNtlPos);

  let uPnl = 0, haveU = false;
  let fundingReceived = 0, haveF = false;
  for (const ap of (ch && ch.assetPositions) || []){
    const p = ap && ap.position;
    if (!p) continue;
    const u = num(p.unrealizedPnl);
    if (u != null){ uPnl += u; haveU = true; }
    const cf = p.cumFunding && num(p.cumFunding.sinceOpen);
    if (cf != null){ fundingReceived += cf; haveF = true; }
  }

  let realized = 0, haveR = false;
  for (const f of fills){
    const c = num(f.closedPnl);
    if (c != null){ realized += c; haveR = true; }
  }

  const tPnl = todayPnl();

  const marginRatio = (maintMargin != null && accountValue)
    ? (maintMargin / accountValue) * 100 : null;
  const crossLev = (ntlPos != null && accountValue)
    ? (ntlPos / accountValue) : null;
  const fundingPaid = haveF ? -fundingReceived : null;

  const mrTone = marginRatio == null ? ""
    : marginRatio >= 80 ? "neg"
    : marginRatio >= 50 ? "warn"
    : "";

  /* helper: build a card object */
  const card = (lab, v, tone, sub, hint) => ({ lab, v, tone: tone || "", sub: sub || "", hint: hint || "" });

  const groups = [
    {
      label: "Account",
      accent: "accent",
      cards: [
        card("Account value",  usd(accountValue), ""),
        card("Unrealized PnL", haveU ? signedUsd(uPnl)    : "—",
             haveU ? (uPnl     >= 0 ? "pos" : "neg") : "mute"),
        card("Realized PnL",   haveR ? signedUsd(realized) : "—",
             haveR ? (realized >= 0 ? "pos" : "neg") : "mute"),
        card("Today's PnL",    tPnl  != null ? signedUsd(tPnl) : "—",
             tPnl  != null ? (tPnl  >= 0 ? "pos" : "neg") : "mute",
             "net of fees"),
        card("Funding paid",
             fundingPaid != null ? signedUsd(fundingPaid) : "—",
             fundingPaid != null ? (fundingPaid > 0 ? "neg" : fundingPaid < 0 ? "pos" : "") : "mute"),
      ],
    },
    {
      label: "Margin",
      accent: "accent-2",
      cards: [
        card("Margin used",   usd(marginUsed),  ""),
        card("Maint. margin", usd(maintMargin), ""),
        card("Margin ratio",
             marginRatio != null ? marginRatio.toFixed(2) + "%" : "—",
             mrTone,
             "",
             marginRatio != null && marginRatio >= 50
               ? marginRatio >= 80 ? "⚠ Liquidation risk" : "Elevated risk" : ""),
        card("Cross leverage",
             crossLev != null ? crossLev.toFixed(2) + "×" : "—",
             crossLev != null && crossLev >= 10 ? "warn" : ""),
      ],
    },
  ];

  const groupHtml = groups.map(g => `
    <div class="pf-kpi-group">
      <div class="pf-kgi-label pf-kgi-label--${esc(g.accent)}">${esc(g.label)}</div>
      <div class="pf-kpis">
        ${g.cards.map(c => `
          <div class="pf-kpi${c.tone ? " pf-kpi--"+c.tone : ""}">
            <span class="pf-kpi-lab">${esc(c.lab)}</span>
            <span class="pf-kpi-val${c.tone ? " "+c.tone : ""}">${c.v}</span>
            ${c.sub  ? `<span class="pf-kpi-sub">${esc(c.sub)}</span>` : ""}
            ${c.hint ? `<span class="pf-kpi-hint ${esc(c.tone)}">${esc(c.hint)}</span>` : ""}
          </div>`).join("")}
      </div>
    </div>`).join("");

  return `<div class="pf-kpi-wrap">${groupHtml}</div>`;
}

/* ─── per-coin realized PnL mini breakdown ─────────────────── */
function renderCoinPnl(){
  const coins = buildCoinPnl();
  if (!coins.length) return "";

  const maxAbs = Math.max(...coins.map(c => Math.abs(c.net)), 1);

  const rows = coins.map(c => {
    const pct   = (Math.abs(c.net) / maxAbs) * 100;
    const tone  = c.net >= 0 ? "pos" : "neg";
    const color = c.net >= 0 ? "var(--long)" : "var(--short)";
    return `<div class="pf-cpnl-row">
      <span class="pf-cpnl-coin">${esc(c.coin)}</span>
      <div class="pf-cpnl-bar-wrap">
        <div class="pf-cpnl-bar" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      </div>
      <span class="pf-cpnl-val ${tone}">${signedUsd(c.net)}</span>
    </div>`;
  }).join("");

  return `<div class="pf-panel pf-cpnl-panel">
    <div class="pf-panel-head">
      <span class="pf-panel-title">Top realized</span>
      <span class="pf-hint">by coin · net of fees</span>
    </div>
    <div class="pf-cpnl-list">${rows}</div>
  </div>`;
}

/* ─── equity curve ─────────────────────────────────────────── */
function renderEquity(){
  const series = buildEquitySeries(state.account);
  const label = series.mode === "pnl"    ? "Cumul. realized PnL"
              : series.mode === "equity" ? "Account value"
              : "Equity curve";

  const periods = ["24h","7d","30d","all"];
  const periodBtns = periods.map(p =>
    `<button class="pf-period-btn${eqPeriod===p?" on":""}" data-eq-period="${p}"
      aria-pressed="${eqPeriod===p}">${p}</button>`
  ).join("");

  if (series.pts.length < 2){
    return `<div class="pf-panel pf-equity">
      <div class="pf-panel-head">
        <span class="pf-panel-title">${esc(label)}</span>
        <div class="pf-period-row" role="group" aria-label="Period">${periodBtns}</div>
        <span class="pf-hint pf-eq-sampling">sampling&hellip;</span>
      </div>
      <div class="pf-eq-empty">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"
             width="18" height="18" aria-hidden="true">
          <path d="M3 15l4-4 3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Not enough history yet — keep this page open to build your equity curve,
        or place trades to populate realized PnL.
      </div>
    </div>`;
  }

  const last  = series.pts[series.pts.length - 1].v;
  const first = series.pts[0].v;
  const delta = last - first;
  const pctChg = first !== 0 ? (delta / Math.abs(first)) * 100 : null;
  const tone  = delta >= 0 ? "pos" : "neg";
  const valueDisplay = series.mode === "pnl" ? signedUsd(last) : usd(last);
  const deltaDisplay = signedUsd(delta);

  return `<div class="pf-panel pf-equity">
    <div class="pf-panel-head">
      <span class="pf-panel-title">${esc(label)}</span>
      <div class="pf-period-row" role="group" aria-label="Period">${periodBtns}</div>
      <div class="pf-eq-summary">
        <span class="pf-eq-last ${tone}">${valueDisplay}</span>
        <span class="pf-eq-delta ${tone}">${deltaDisplay}${pctChg != null
          ? ` <em>${pctChg >= 0 ? "+" : "−"}${Math.abs(pctChg).toFixed(2)}%</em>` : ""}</span>
      </div>
    </div>
    <div class="pf-eq-chart" id="pfEqChart">${equitySVG(series.pts, series.mode)}</div>
  </div>`;
}

/* Interactive SVG: gridlines, gradient area + line, axis labels, hover crosshair. */
function equitySVG(pts, mode){
  const w = 640, h = 170, padL = 4, padR = 66, padB = 24, padT = 12;
  const plotW = w - padL - padR;
  const plotH = h - padB - padT;
  const xs = pts.map(p => p.t);
  const ys = pts.map(p => p.v);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const yPad = (maxY - minY) * 0.1 || 1;
  if (minY === maxY){ minY -= 1; maxY += 1; }
  else { minY -= yPad; maxY += yPad; }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const X = (t) => padL + ((t - minX) / spanX) * plotW;
  const Y = (v) => padT + (1 - (v - minY) / spanY) * plotH;
  const up  = ys[ys.length - 1] >= ys[0];
  const col = up ? "var(--long)" : "var(--short)";
  const colHex = up ? "#3fb98a" : "#e0556b";
  const gid = "pfEqGrad";
  const ggrid = "pfEqGridX";

  const linePts = pts.map(p => `${X(p.t).toFixed(2)},${Y(p.v).toFixed(2)}`).join(" ");
  const baseY   = (padT + plotH).toFixed(2);
  const areaPts = `${padL},${baseY} ${linePts} ${X(maxX).toFixed(2)},${baseY}`;
  const lastX   = X(maxX), lastY = Y(ys[ys.length - 1]);

  /* Horizontal gridlines (4 levels) */
  const gridLevels = 4;
  let gridLines = "";
  for (let i = 0; i <= gridLevels; i++){
    const gy = padT + (i / gridLevels) * plotH;
    gridLines += `<line x1="${padL}" y1="${gy.toFixed(2)}"
      x2="${(padL + plotW).toFixed(2)}" y2="${gy.toFixed(2)}"
      stroke="rgba(255,255,255,.045)" stroke-width="1"/>`;
  }

  /* Zero baseline for PnL mode or when y-range straddles 0 */
  let zeroLine = "";
  if (mode === "pnl" || (minY < 0 && maxY > 0)){
    const zy = Y(0).toFixed(2);
    zeroLine = `<line x1="${padL}" y1="${zy}" x2="${(padL+plotW).toFixed(2)}" y2="${zy}"
      stroke="rgba(255,255,255,.22)" stroke-width="1" stroke-dasharray="4 5"/>`;
  }

  /* Y-axis ticks (max, mid, min) */
  const fmtAx = (v) =>
    Math.abs(v) >= 1000000 ? (v/1000000).toFixed(1)+"M"
  : Math.abs(v) >= 1000    ? (v/1000).toFixed(1)+"k"
  : v.toFixed(0);

  const midY = (maxY + minY) / 2;
  const axTicks = [
    { v: maxY, y: padT + 8 },
    { v: midY, y: padT + plotH / 2 + 4 },
    { v: minY, y: padT + plotH - 2 },
  ];
  const axLabels = axTicks.map(t =>
    `<text x="${(padL + plotW + 6).toFixed(2)}" y="${t.y.toFixed(2)}"
      class="pf-eq-ax">${esc(fmtAx(t.v))}</text>`
  ).join("");

  /* X-axis time ticks (first + last) */
  const fmtDate = (ms) => new Intl.DateTimeFormat("en-US",
    { month:"short", day:"numeric" }).format(new Date(ms));

  const xLabels = `
    <text x="${padL.toFixed(2)}" y="${(padT+plotH+16).toFixed(2)}"
      class="pf-eq-ax pf-eq-ax-x">${esc(fmtDate(minX))}</text>
    <text x="${(padL+plotW).toFixed(2)}" y="${(padT+plotH+16).toFixed(2)}"
      class="pf-eq-ax pf-eq-ax-x" text-anchor="end">${esc(fmtDate(maxX))}</text>`;

  /* Invisible hit-area rects */
  const hitW = plotW / pts.length;
  const hits = pts.map((p, i) =>
    `<rect class="pf-eq-hit" x="${(padL + i*hitW).toFixed(2)}" y="${padT}"
      width="${hitW.toFixed(2)}" height="${plotH}"
      data-v="${p.v.toFixed(4)}" data-t="${p.t}"
      fill="transparent" stroke="none"/>`
  ).join("");

  /* Crosshair group */
  const crosshair = `<g id="pfEqCross" class="pf-eq-cross" style="display:none">
    <line class="pf-eq-vline" x1="0" y1="${padT}" x2="0" y2="${(padT+plotH).toFixed(2)}"
      stroke="rgba(255,255,255,.3)" stroke-width="1" stroke-dasharray="3 3"/>
    <circle class="pf-eq-dot" r="3.5" fill="${col}" stroke="var(--bg)" stroke-width="2"/>
  </g>`;

  const ptsJson = JSON.stringify(pts.map(p => [p.t, +p.v.toFixed(4)]));

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%"
      preserveAspectRatio="none" role="img" aria-label="equity curve"
      data-eq-pts='${esc(ptsJson)}' data-eq-min-x="${minX}" data-eq-max-x="${maxX}"
      data-eq-min-y="${minY.toFixed(4)}" data-eq-max-y="${maxY.toFixed(4)}"
      data-pad-l="${padL}" data-pad-r="${padR}" data-pad-t="${padT}" data-pad-b="${padB}"
      data-plot-w="${plotW}" data-plot-h="${plotH}">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${colHex}" stop-opacity="0.28"/>
        <stop offset="72%"  stop-color="${colHex}" stop-opacity="0.06"/>
        <stop offset="100%" stop-color="${colHex}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines}
    ${zeroLine}
    <polygon points="${areaPts}" fill="url(#${gid})" stroke="none"/>
    <polyline points="${linePts}" fill="none" stroke="${col}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${axLabels}
    ${xLabels}
    <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.5" fill="${col}"
      stroke="var(--bg)" stroke-width="2"/>
    ${crosshair}
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"
      fill="transparent" class="pf-eq-overlay" id="pfEqOverlay"
      data-eq-mode="${mode}"/>
    ${hits}
  </svg>`;
}

/* Wire hover tooltip on the equity chart (called after render). */
function wireEquityHover(){
  const chart = mount && mount.querySelector("#pfEqChart");
  if (!chart) return;
  const svg = chart.querySelector("svg");
  if (!svg) return;
  const tip    = document.getElementById("pfEqTip");
  const cross  = svg.querySelector("#pfEqCross");
  const vline  = cross && cross.querySelector(".pf-eq-vline");
  const dot    = cross && cross.querySelector(".pf-eq-dot");
  if (!tip || !cross) return;

  const padL  = +svg.getAttribute("data-pad-l");
  const padT  = +svg.getAttribute("data-pad-t");
  const padB  = +svg.getAttribute("data-pad-b");
  const plotW = +svg.getAttribute("data-plot-w");
  const plotH = +svg.getAttribute("data-plot-h");
  const minX  = +svg.getAttribute("data-eq-min-x");
  const maxX  = +svg.getAttribute("data-eq-max-x");
  const minY  = +svg.getAttribute("data-eq-min-y");
  const maxY  = +svg.getAttribute("data-eq-max-y");
  const mode  = svg.querySelector("#pfEqOverlay") &&
                svg.querySelector("#pfEqOverlay").getAttribute("data-eq-mode");

  let ptsArr = [];
  try { ptsArr = JSON.parse(svg.getAttribute("data-eq-pts") || "[]"); } catch {}

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  function onMove(e){
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rx = clientX - rect.left;
    // map to SVG coordinates (preserveAspectRatio="none")
    const svgW = +svg.getAttribute("viewBox").split(" ")[2];
    const svgH = +svg.getAttribute("viewBox").split(" ")[3];
    const sx = (rx / rect.width) * svgW;

    const frac = Math.max(0, Math.min(1, (sx - padL) / plotW));
    const tAtCursor = minX + frac * spanX;
    let best = ptsArr[0], bestDist = Infinity;
    for (const p of ptsArr){
      const d = Math.abs(p[0] - tAtCursor);
      if (d < bestDist){ bestDist = d; best = p; }
    }
    if (!best) return;

    const [pt, pv] = best;
    const px = padL + ((pt - minX) / spanX) * plotW;
    const py = padT + (1 - (pv - minY) / spanY) * plotH;

    cross.style.display = "";
    if (vline){
      vline.setAttribute("x1", px.toFixed(2));
      vline.setAttribute("x2", px.toFixed(2));
    }
    if (dot){
      dot.setAttribute("cx", px.toFixed(2));
      dot.setAttribute("cy", py.toFixed(2));
    }

    const valStr = mode === "pnl" ? signedUsd(pv) : usd(pv);
    const tone   = pv >= 0 ? "pos" : "neg";
    tip.innerHTML = `
      <span class="pf-tip-time">${esc(timeShort(pt))}</span>
      <span class="pf-tip-val ${tone}">${esc(valStr)}</span>`;
    tip.hidden = false;
    const tipW = 170, tipH = 52;
    let tx = clientX + 14, ty = clientY - 34;
    if (tx + tipW > window.innerWidth - 8)  tx = clientX - tipW - 8;
    if (ty < 8) ty = clientY + 14;
    tip.style.left = tx + "px";
    tip.style.top  = ty + "px";
  }
  function onLeave(){
    cross.style.display = "none";
    tip.hidden = true;
  }

  svg.addEventListener("mousemove",  onMove);
  svg.addEventListener("touchmove",  onMove, { passive: true });
  svg.addEventListener("mouseleave", onLeave);
  svg.addEventListener("touchend",   onLeave);
}

/* ─── fills history ────────────────────────────────────────── */
function renderFills(){
  if (!fills.length){
    return `<div class="pf-panel">
      <div class="pf-panel-head">
        <span class="pf-panel-title">Fills history</span>
      </div>
      <div class="pf-fills-empty">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"
             width="16" height="16" aria-hidden="true">
          <rect x="3" y="4" width="14" height="13" rx="2"/>
          <path d="M7 8h6M7 12h4" stroke-linecap="round"/>
        </svg>
        No fills recorded on ${esc(net())}.
      </div>
    </div>`;
  }
  const rows = fills.slice(0, MAX_FILLS);
  return `<div class="pf-panel">
    <div class="pf-panel-head">
      <span class="pf-panel-title">Fills history</span>
      <span class="pf-hint">${rows.length} most recent</span>
    </div>
    <div class="pf-fills-scroll" role="region" aria-label="Fills history">
      <table class="pf-fills-table" role="table">
        <thead>
          <tr>
            <th>Time</th><th>Coin</th><th>Side</th><th class="r">Price</th>
            <th class="r">Size</th><th class="r">Notional</th>
            <th class="r">Closed PnL</th><th class="r">Fee</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(f => {
            const buy  = f.side === "B";
            const px   = num(f.px), sz = num(f.sz);
            const notl = (px != null && sz != null) ? px * Math.abs(sz) : null;
            const cp   = num(f.closedPnl);
            const fee  = num(f.fee);
            const cpTone = cp != null && cp !== 0 ? (cp >= 0 ? " pos" : " neg") : " mute";
            return `<tr>
              <td class="t">${esc(timeStr(f.time))}</td>
              <td class="c">${esc(f.coin)}</td>
              <td><span class="pf-side-chip ${buy ? "long" : "short"}">${buy ? "Buy" : "Sell"}</span></td>
              <td class="r">${pxStr(px)}</td>
              <td class="r">${szStr(sz)}</td>
              <td class="r mute">${notl != null ? usd(notl) : "—"}</td>
              <td class="r${cpTone}">${cp != null && cp !== 0 ? signedUsd(cp) : "—"}</td>
              <td class="r fee">${fee != null ? usd(fee) : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ─── data load + polling ──────────────────────────────────── */
async function load(){
  if (!state.account){ ch = null; fills = []; render(); return; }
  const seq     = ++loadSeq;
  const account = state.account;
  try {
    const [c, f] = await Promise.all([
      HL.clearinghouse(account).catch(() => null),
      HL.userFills(account).catch(() => []),
    ]);
    if (seq !== loadSeq)          return;
    if (account !== state.account) return;
    if (c){
      ch = c;
      const av = c.marginSummary && c.marginSummary.accountValue;
      sampleEquity(account, av);
    }
    fills = Array.isArray(f) ? f : [];
    render();
  } catch {
    if (seq === loadSeq) render();
  }
}

function startPolling(){
  stopPolling();
  if (!active || !state.account) return;
  load();
  pollTimer = setInterval(load, POLL_MS);
}
function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}

/* ─── lifecycle ────────────────────────────────────────────── */
function activate(){
  if (active) return;
  active = true;
  render();
  startPolling();
}
function deactivate(){
  active = false;
  stopPolling();
}

function init(){
  mount = document.getElementById("hlPortfolioMount");
  if (!mount) return;
  ensureScaffold();
  render();

  window.addEventListener("lz:route", (e) => {
    const route = e && e.detail && e.detail.route;
    if (route === "trade") activate(); else deactivate();
  });
  window.addEventListener("lz:hl:net", () => {
    ch = null; fills = [];
    render();
    if (active && state.account) load();
  });
  onChange(() => {
    ch = null; fills = [];
    render();
    if (active) startPolling();
  });

  try {
    const r = (location.hash || "").replace(/^#\/?/, "").split("/")[0];
    if (r === "trade") activate();
  } catch {}
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
