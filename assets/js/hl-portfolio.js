/* =====================================================================
 *  hl-portfolio.js — ACCOUNT / PORTFOLIO ANALYTICS (Hyperliquid parity)
 *  ---------------------------------------------------------------------
 *  Owned by the PORTFOLIO agent. Renders inside #hlPortfolioMount:
 *    1) Summary KPI cards (account value, uPnL, realized PnL, margin used,
 *       maint margin, margin ratio, cross leverage, funding paid).
 *    2) Equity curve (SVG area line): cumulative realized PnL − fees from
 *       userFills, blended with sampled accountValue points persisted in
 *       localStorage keyed by account+network.
 *    3) Fills-history table (newest first, capped ~100, scrollable).
 *    4) Per-position management: market reduceOnly Close / Close-50%, with
 *       a confirm step (real funds on mainnet) → HL.placeOrder → refreshUser.
 *
 *  Polls clearinghouse+fills every ~6s only while the trade view is visible
 *  AND an account is connected. Reacts to lz:hl:net and shared onChange.
 *
 *  No build, no npm, no external libs. Every DOM/window.LZ/state access is
 *  guarded so nothing crashes when the account is null. All injected strings
 *  are escaped; numbers are formatted in-module.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";
import { state, onChange, toast, shortAddr } from "./shared.js";

/* ─── module state ─────────────────────────────────────────── */
let mount = null;
let active = false;          // trade view visible
let pollTimer = null;
let booted = false;          // one-time DOM scaffold built
let ch = null;               // last clearinghouse snapshot
let fills = [];              // userFills (newest first)
let busyKey = null;          // coin currently being closed (locks its buttons)
let pendingClose = null;     // { coin, pct, isBuy, sz } awaiting confirm
let loadSeq = 0;             // guards against out-of-order async loads

const POLL_MS = 6000;
const MAX_FILLS = 100;
const EQ_MAX_POINTS = 240;   // persisted sampled accountValue points cap

/* ─── tiny helpers ─────────────────────────────────────────── */
const $ = (id) => (mount ? mount.querySelector(id) : null);

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  return (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const D = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
  const T = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${D} ${T}`;
}

/* ─── equity-curve persistence (sampled accountValue) ──────── */
function eqKey(account){ return `lz.hl.equity:${(account || "").toLowerCase()}:${net()}`; }
function loadEqSamples(account){
  if (!account) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(eqKey(account)) || "[]");
    return Array.isArray(raw) ? raw.filter(p => p && isFinite(p.t) && isFinite(p.v)) : [];
  } catch { return []; }
}
function sampleEquity(account, accountValue){
  const v = num(accountValue);
  if (!account || v == null) return;
  try {
    const arr = loadEqSamples(account);
    const last = arr[arr.length - 1];
    const now = Date.now();
    // de-dupe: skip if <30s since last and value barely moved
    if (last && now - last.t < 30000 && Math.abs(last.v - v) < 1e-6) return;
    arr.push({ t: now, v });
    while (arr.length > EQ_MAX_POINTS) arr.shift();
    localStorage.setItem(eqKey(account), JSON.stringify(arr));
  } catch { /* storage full / blocked — non-fatal */ }
}

/* Build the equity series. Prefer sampled accountValue history (real equity
 * over time); fall back to a cumulative realized-PnL curve derived from
 * fills (closedPnl − fee, oldest→newest) when we have too few samples. */
function buildEquitySeries(account){
  const samples = loadEqSamples(account);
  if (samples.length >= 2){
    return { mode: "equity", pts: samples.map(p => ({ t: p.t, v: p.v })) };
  }
  // cumulative realized PnL from fills (chronological)
  const chrono = fills.slice().sort((a, b) => Number(a.time) - Number(b.time));
  if (chrono.length >= 2){
    let cum = 0;
    const pts = chrono.map(f => {
      cum += (num(f.closedPnl) || 0) - (num(f.fee) || 0);
      return { t: Number(f.time), v: cum };
    });
    return { mode: "pnl", pts };
  }
  if (samples.length === 1) return { mode: "equity", pts: samples.map(p => ({ t: p.t, v: p.v })) };
  return { mode: "empty", pts: [] };
}

/* ─── one-time scaffold ────────────────────────────────────── */
function ensureScaffold(){
  if (booted || !mount) return;
  booted = true;
  mount.classList.add("hl-pf");
  mount.innerHTML = `
    <div class="pf-head">
      <h3 class="pf-title">Portfolio</h3>
      <span class="pf-net" id="pfNet">${esc(net())}</span>
    </div>
    <div id="pfBody"></div>`;
  // delegated handlers (survive re-renders of #pfBody)
  mount.addEventListener("click", onMountClick);
}

function onMountClick(e){
  const closeBtn = e.target.closest && e.target.closest("[data-pf-close]");
  if (closeBtn){
    const coin = closeBtn.getAttribute("data-pf-close");
    const pct = Number(closeBtn.getAttribute("data-pf-pct")) || 1;
    requestClose(coin, pct);
    return;
  }
  if (e.target.closest && e.target.closest("[data-pf-confirm]")){ confirmClose(); return; }
  if (e.target.closest && e.target.closest("[data-pf-cancel]")){ cancelClose(); return; }
  // backdrop click closes the confirm sheet
  if (e.target.classList && e.target.classList.contains("pf-confirm-back")){ cancelClose(); return; }
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round" width="34" height="34">
            <path d="M3 17l5-5 4 4 8-8M21 8v4h-4"/></svg>
        </div>
        <div class="pf-empty-t">Connect a wallet</div>
        <div class="pf-empty-b">Your account value, equity curve, PnL summary and
          fills history will appear here once a wallet is connected.</div>
      </div>`;
    return;
  }

  body.innerHTML = `
    ${renderKpis()}
    ${renderEquity()}
    ${renderManage()}
    ${renderFills()}
    ${pendingClose ? renderConfirm() : ""}`;
}

function renderKpis(){
  const ms = (ch && ch.marginSummary) || {};
  const cms = (ch && ch.crossMarginSummary) || {};
  const accountValue = num(ms.accountValue);
  const maintMargin = num(ch && ch.crossMaintenanceMarginUsed);
  const marginUsed = num(ms.totalMarginUsed);
  const ntlPos = num(ms.totalNtlPos);

  // unrealized PnL = sum across positions
  let uPnl = 0, haveU = false;
  let funding = 0, haveF = false;
  for (const ap of (ch && ch.assetPositions) || []){
    const p = ap && ap.position;
    if (!p) continue;
    const u = num(p.unrealizedPnl); if (u != null){ uPnl += u; haveU = true; }
    const cf = p.cumFunding && num(p.cumFunding.sinceOpen);
    if (cf != null){ funding += cf; haveF = true; }
  }
  // realized PnL = sum of closedPnl across loaded fills (− fees informational)
  let realized = 0, haveR = false;
  for (const f of fills){ const c = num(f.closedPnl); if (c != null){ realized += c; haveR = true; } }

  const marginRatio = (maintMargin != null && accountValue) ? (maintMargin / accountValue) * 100 : null;
  // cross account leverage = total notional / account value
  const crossLev = (ntlPos != null && accountValue) ? (ntlPos / accountValue) : null;
  // cumFunding.sinceOpen is funding *received* in HL convention; "paid" = −that
  const fundingPaid = haveF ? -funding : null;

  const cards = [
    { lab: "Account value", v: usd(accountValue) },
    { lab: "Unrealized PnL", v: haveU ? signedUsd(uPnl) : "—", tone: haveU ? (uPnl >= 0 ? "pos" : "neg") : "" },
    { lab: "Realized PnL", v: haveR ? signedUsd(realized) : "—", tone: haveR ? (realized >= 0 ? "pos" : "neg") : "" },
    { lab: "Margin used", v: usd(marginUsed) },
    { lab: "Maint. margin", v: usd(maintMargin) },
    { lab: "Margin ratio", v: marginRatio != null ? marginRatio.toFixed(2) + "%" : "—",
      tone: marginRatio != null && marginRatio >= 50 ? "neg" : "" },
    { lab: "Cross leverage", v: crossLev != null ? crossLev.toFixed(2) + "×" : "—" },
    { lab: "Funding paid", v: fundingPaid != null ? signedUsd(-Math.abs(fundingPaid)) === "−$0.00" ? signedUsd(fundingPaid) : signedUsd(fundingPaid) : "—",
      tone: fundingPaid != null ? (fundingPaid <= 0 ? "neg" : "pos") : "" },
  ];

  return `<div class="pf-kpis">
    ${cards.map(c => `<div class="pf-kpi">
      <span class="lab">${esc(c.lab)}</span>
      <span class="v ${c.tone || ""}">${c.v}</span>
    </div>`).join("")}
  </div>`;
}

function renderEquity(){
  const series = buildEquitySeries(state.account);
  const label = series.mode === "pnl" ? "Cumulative realized PnL"
              : series.mode === "equity" ? "Account value over time"
              : "Equity curve";
  if (series.pts.length < 2){
    return `<div class="pf-panel pf-equity">
      <div class="pf-panel-head"><span>${esc(label)}</span><span class="pf-hint">sampling…</span></div>
      <div class="pf-eq-empty">Not enough history yet — keep this page open to build your
        equity curve, or place trades to populate realized PnL.</div>
    </div>`;
  }
  const last = series.pts[series.pts.length - 1].v;
  const first = series.pts[0].v;
  const delta = last - first;
  const tone = delta >= 0 ? "pos" : "neg";
  return `<div class="pf-panel pf-equity">
    <div class="pf-panel-head">
      <span>${esc(label)}</span>
      <span class="pf-eq-last ${tone}">${series.mode === "pnl" ? signedUsd(last) : usd(last)}
        <em>${signedUsd(delta)}</em></span>
    </div>
    <div class="pf-eq-chart">${equitySVG(series.pts)}</div>
  </div>`;
}

/* Area + line SVG, mirrors the sparkSVG style in app.js (preserveAspectRatio
 * none, gradient fill). Includes min/max y-axis labels and a last-value dot. */
function equitySVG(pts){
  const w = 600, h = 150, padR = 54, padB = 16, padT = 8;
  const plotW = w - padR, plotH = h - padB - padT;
  const xs = pts.map(p => p.t);
  const ys = pts.map(p => p.v);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY){ minY -= 1; maxY += 1; }
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const X = (t) => ((t - minX) / spanX) * plotW;
  const Y = (v) => padT + (1 - (v - minY) / spanY) * plotH;
  const up = ys[ys.length - 1] >= ys[0];
  const col = up ? "var(--long)" : "var(--short)";
  const gid = "pfEqGrad";

  const linePts = pts.map(p => `${X(p.t).toFixed(2)},${Y(p.v).toFixed(2)}`).join(" ");
  const areaPts = `0,${(padT + plotH).toFixed(2)} ${linePts} ${X(maxX).toFixed(2)},${(padT + plotH).toFixed(2)}`;
  const lastX = X(maxX), lastY = Y(ys[ys.length - 1]);

  // zero baseline (useful for the PnL curve)
  let zeroLine = "";
  if (minY < 0 && maxY > 0){
    const zy = Y(0).toFixed(2);
    zeroLine = `<line x1="0" y1="${zy}" x2="${plotW}" y2="${zy}"
      stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }
  const fmtAxis = (v) => (Math.abs(v) >= 1000 ? (v/1000).toFixed(1) + "k" : v.toFixed(0));

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none"
      role="img" aria-label="equity curve">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    ${zeroLine}
    <polygon points="${areaPts}" fill="url(#${gid})" stroke="none"/>
    <polyline points="${linePts}" fill="none" stroke="${col}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="2.6" fill="${col}"/>
    <text x="${plotW + 6}" y="${(padT + 9).toFixed(2)}" class="pf-eq-ax">${esc(fmtAxis(maxY))}</text>
    <text x="${plotW + 6}" y="${(padT + plotH).toFixed(2)}" class="pf-eq-ax">${esc(fmtAxis(minY))}</text>
  </svg>`;
}

function openPositions(){
  return ((ch && ch.assetPositions) || [])
    .map(ap => ap && ap.position)
    .filter(p => p && num(p.szi) != null && Number(p.szi) !== 0);
}

function renderManage(){
  const pos = openPositions();
  if (!pos.length){
    return `<div class="pf-panel">
      <div class="pf-panel-head"><span>Manage positions</span></div>
      <div class="pf-eq-empty">No open positions on ${esc(net())}.</div>
    </div>`;
  }
  return `<div class="pf-panel">
    <div class="pf-panel-head"><span>Manage positions</span></div>
    <div class="pf-pos-table">
      <div class="pf-pos-head">
        <span>Coin</span><span>Side</span><span>Size</span><span>Entry</span>
        <span>uPnL</span><span>ROE</span><span class="pf-pos-act">Close</span>
      </div>
      ${pos.map(p => {
        const szi = Number(p.szi);
        const long = szi > 0;
        const pnl = num(p.unrealizedPnl);
        const roe = num(p.returnOnEquity);
        const locked = busyKey === p.coin;
        return `<div class="pf-pos-row">
          <span class="c">${esc(p.coin)}</span>
          <span class="${long ? "long" : "short"}">${long ? "Long" : "Short"}</span>
          <span>${szStr(szi)}</span>
          <span>${pxStr(p.entryPx)}</span>
          <span class="${pnl != null && pnl >= 0 ? "long" : "short"}">${pnl != null ? signedUsd(pnl) : "—"}</span>
          <span class="${roe != null && roe >= 0 ? "long" : "short"}">${roe != null ? pctStr(roe * 100) : "—"}</span>
          <span class="pf-pos-act">
            <button type="button" class="pf-btn half" data-pf-close="${esc(p.coin)}" data-pf-pct="0.5"
              ${locked ? "disabled" : ""}>50%</button>
            <button type="button" class="pf-btn close" data-pf-close="${esc(p.coin)}" data-pf-pct="1"
              ${locked ? "disabled" : ""}>${locked ? "…" : "Close"}</button>
          </span>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function renderFills(){
  if (!fills.length){
    return `<div class="pf-panel">
      <div class="pf-panel-head"><span>Fills history</span></div>
      <div class="pf-eq-empty">No fills yet on ${esc(net())}.</div>
    </div>`;
  }
  const rows = fills.slice(0, MAX_FILLS);
  return `<div class="pf-panel">
    <div class="pf-panel-head"><span>Fills history</span><span class="pf-hint">${rows.length} most recent</span></div>
    <div class="pf-fills-scroll">
      <div class="pf-fills-table">
        <div class="pf-fills-head">
          <span>Time</span><span>Coin</span><span>Side</span><span>Price</span>
          <span>Size</span><span>Notional</span><span>Closed PnL</span><span>Fee</span>
        </div>
        ${rows.map(f => {
          const buy = f.side === "B";
          const px = num(f.px), sz = num(f.sz);
          const notional = (px != null && sz != null) ? px * Math.abs(sz) : null;
          const cp = num(f.closedPnl);
          const fee = num(f.fee);
          return `<div class="pf-fills-row">
            <span class="t">${esc(timeStr(f.time))}</span>
            <span class="c">${esc(f.coin)}</span>
            <span class="${buy ? "long" : "short"}">${buy ? "Buy" : "Sell"}</span>
            <span>${pxStr(px)}</span>
            <span>${szStr(sz)}</span>
            <span>${notional != null ? usd(notional) : "—"}</span>
            <span class="${cp != null && cp >= 0 ? "long" : "short"}">${cp != null && cp !== 0 ? signedUsd(cp) : "—"}</span>
            <span class="fee">${fee != null ? usd(fee) : "—"}</span>
          </div>`;
        }).join("")}
      </div>
    </div>
  </div>`;
}

function renderConfirm(){
  const o = pendingClose;
  const mainnet = (() => { try { return HL.isMainnet(); } catch { return net() === "mainnet"; } })();
  const verb = o.pct >= 1 ? "Close" : `Close ${Math.round(o.pct * 100)}% of`;
  return `<div class="pf-confirm-back" role="dialog" aria-modal="true" aria-label="Confirm close">
    <div class="pf-confirm">
      <div class="pf-confirm-h">${esc(verb)} ${esc(o.coin)} position</div>
      <div class="pf-confirm-rows">
        <div class="rv-row"><span>Action</span><b>Market ${o.isBuy ? "buy" : "sell"} · reduce-only</b></div>
        <div class="rv-row"><span>Coin</span><b>${esc(o.coin)}-PERP</b></div>
        <div class="rv-row"><span>Size to close</span><b>${szStr(o.sz)} ${esc(o.coin)}</b></div>
      </div>
      <div class="pf-confirm-net ${mainnet ? "main" : "test"}">
        ${mainnet
          ? "⚠ Mainnet — this signs a real reduce-only market order with real funds."
          : "Testnet — paper funds. Signs against the Hyperliquid testnet."}
      </div>
      <div class="pf-confirm-actions">
        <button type="button" class="pf-btn ghost" data-pf-cancel>Cancel</button>
        <button type="button" class="pf-btn close" data-pf-confirm>${o.pct >= 1 ? "Close position" : "Close 50%"} ▸</button>
      </div>
    </div>
  </div>`;
}

/* ─── close flow (funds-moving) ────────────────────────────── */
function requestClose(coin, pct){
  if (!state.account){ toast("connect a wallet first", "err"); return; }
  if (busyKey){ return; }
  const p = openPositions().find(x => x.coin === coin);
  if (!p){ toast("position not found — refresh", "err"); return; }
  const szi = Number(p.szi);
  if (!isFinite(szi) || szi === 0){ toast("nothing to close", "err"); return; }
  // closing reduces the position: opposite side of szi
  const isBuy = szi < 0;                 // short → buy to close; long → sell to close
  const sz = Math.abs(szi) * pct;
  if (!(sz > 0)){ toast("size must be greater than zero", "err"); return; }
  pendingClose = { coin, pct, isBuy, sz };
  render();
}
function cancelClose(){
  pendingClose = null;
  render();
}
async function confirmClose(){
  const o = pendingClose;
  if (!o) return;
  if (!state.account){ toast("connect a wallet first", "err"); cancelClose(); return; }
  busyKey = o.coin;
  pendingClose = null;
  // lock the confirm button by re-rendering (busyKey disables row buttons)
  const confirmBtn = $("[data-pf-confirm]");
  if (confirmBtn){ confirmBtn.setAttribute("disabled", ""); confirmBtn.textContent = "Sign in wallet…"; }
  try {
    await HL.placeOrder({
      account: state.account,
      coin: o.coin,
      isBuy: o.isBuy,
      sz: o.sz,
      type: "market",
      reduceOnly: true,
    });
    toast(`position ${o.pct >= 1 ? "closed" : "reduced"} · ${o.coin}`, "ok");
    // refresh the native trade panel, then our own data
    try { if (window.LZ && window.LZ.hl && window.LZ.hl.refreshUser) window.LZ.hl.refreshUser(); } catch {}
    busyKey = null;
    await load(true);
  } catch (e){
    busyKey = null;
    toast("close failed · " + ((e && e.message) || e), "err", 4500);
    render();
  }
}

/* ─── data load + polling ──────────────────────────────────── */
async function load(force){
  if (!state.account){ ch = null; fills = []; render(); return; }
  const seq = ++loadSeq;
  const account = state.account;
  try {
    const [c, f] = await Promise.all([
      HL.clearinghouse(account).catch(() => null),
      HL.userFills(account).catch(() => []),
    ]);
    if (seq !== loadSeq) return;          // a newer load superseded us
    if (account !== state.account) return; // account changed mid-flight
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

/* ─── lifecycle wiring ─────────────────────────────────────── */
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

  // route changes from the app shell
  window.addEventListener("lz:route", (e) => {
    const route = e && e.detail && e.detail.route;
    if (route === "trade") activate(); else deactivate();
  });
  // network change → wipe state and reload for the new host
  window.addEventListener("lz:hl:net", () => {
    ch = null; fills = []; busyKey = null; pendingClose = null;
    render();
    if (active && state.account) load(true);
  });
  // wallet connect/disconnect
  onChange(() => {
    ch = null; fills = []; busyKey = null; pendingClose = null;
    render();
    if (active) startPolling();
  });

  // deep-link straight to #/trade (route event may have fired before load)
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
