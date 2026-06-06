/* =====================================================================
 *  hl-markets.js — COMPACT TRIGGER + DRAWER MARKETS BROWSER  v2
 *  ---------------------------------------------------------------------
 *  Owned by the MARKETS agent. Edit ONLY this file and hl-markets.css.
 *
 *  Architecture:
 *   · #hlMarketsMount  → compact single-row trigger bar (top movers)
 *   · .hlmd-overlay    → fixed-position drawer (appended to <body>)
 *
 *  Public events:
 *   · listens: lz:hl:coin, lz:hl:net, lz:route
 *   · emits:   none (selects via window.LZ.hl.setCoin)
 * ===================================================================== */

import * as HL from "./hyperliquid.js";
import * as fmt from "./fmt-num.js";
import { coinAvatarHTML } from "./ui.js";

/* ── constants ──────────────────────────────────────────────────────── */

const POLL_INTERVAL    = 5_000;
const TOP_MOVERS_COUNT = 5;
const FAV_KEY          = "lz.hl.favorites";
const PREFS_KEY        = "lz.hl.markets.prefs";
const DENSITY_KEY      = "lz.hl.markets.density"; // "comfortable" | "compact"

/* ── module state ───────────────────────────────────────────────────── */

/** @type {Array<{name:string,maxLev:number,markPx:number,prevDayPx:number,
 *   chgPct:number,fund8h:number,oi:number,vol:number,sector:string}>} */
let _rows        = [];
let _filtered    = [];
let _sortCol     = "vol";
let _sortAsc     = false;
let _query       = "";
let _filterChip  = "all";   // "all" | "fav" | "topvol" | "gainers" | "losers" | sector key
let _pollTimer   = null;
let _drawerOpen  = false;
let _initialized = false;
let _lastUpd     = 0;
let _kbIdx       = -1;      // keyboard-nav highlighted row index in _filtered
let _density     = "comfortable"; // "comfortable" | "compact"

/* cached DOM refs */
let _mount       = null;
let _trigger     = null;
let _overlay     = null;
let _drawerEl    = null;
let _bodyEl      = null;
let _searchEl    = null;
let _countEl     = null;
let _liveEl      = null;
let _moversEl    = null;
let _statStripEl = null;   // header stat strip
let _glCountEl   = null;   // gainers/losers in trigger

/* ── persistence helpers ────────────────────────────────────────────── */

function loadPrefs(){
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (p.sortCol)   _sortCol   = p.sortCol;
    if (p.sortAsc != null) _sortAsc = !!p.sortAsc;
    if (p.filterChip) _filterChip = p.filterChip;
  } catch {}
}

function savePrefs(){
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      sortCol: _sortCol, sortAsc: _sortAsc, filterChip: _filterChip
    }));
  } catch {}
}

function loadDensity(){
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === "compact" || v === "comfortable") _density = v;
  } catch {}
}

function saveDensity(){
  try { localStorage.setItem(DENSITY_KEY, _density); } catch {}
}

function applyDensity(){
  if (!_drawerEl) return;
  _drawerEl.classList.toggle("hlmd-compact", _density === "compact");
  if (_drawerEl){
    _drawerEl.querySelectorAll(".hlmd-density-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.density === _density);
    });
  }
}

/* ── formatters ─────────────────────────────────────────────────────── */

function esc(s){
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

/* Number formatting delegates to the shared fmt-num.js module so every
 * pane renders the same coin identically. (fmtPx returns no $ prefix.) */
const fmtUsd  = (n) => fmt.usdCompact(n);
const fmtPx   = (n) => fmt.price(n);
const fmtPct  = (n, decimals = 2) => fmt.pct(n, { decimals });
const fmtFund = (n) => fmt.pct(n, { decimals: 4 });
/** Compact OI label: shows $ value */
const fmtOI   = (n) => fmt.usdCompact(n);

function activeCoin(){
  try { return window.LZ?.hl?.coin?.() || ""; } catch { return ""; }
}

function getFavs(){
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); } catch { return []; }
}

function setFavs(arr){
  try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); } catch {}
}

function isFav(sym){
  return getFavs().includes(sym);
}

function toggleFav(sym){
  const favs = getFavs();
  const idx  = favs.indexOf(sym);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(sym);
  setFavs(favs);
  return idx < 0;
}

function sectorOf(name){
  const n = name.toUpperCase();
  if (["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","ATOM","NEAR","FTM","OP","ARB","MATIC","TRX","LTC","BCH","ETC","LINK","UNI","AAVE","MKR","CRV","SNX","COMP"].includes(n)) return "L1/L2";
  if (["DOGE","SHIB","PEPE","BONK","WIF","FLOKI","MEME","TURBO","NEIRO","PNUT","FARTCOIN","GOAT","MOG","POPCAT"].includes(n)) return "Meme";
  if (["BNB","FTT","OKB","CRO","HT","KCS"].includes(n)) return "Exchange";
  if (["AAVE","COMP","MKR","SNX","UNI","CRV","BAL","SUSHI","YFI","CVX","FXS","LDO","RPL","PENDLE","EIGEN","USUAL","ETHFI","ONDO"].includes(n)) return "DeFi";
  if (["AXS","SAND","MANA","ENJ","GALA","IMX","MAGIC","GMT","BLUR","LOOKS","X2Y2"].includes(n)) return "Gaming/NFT";
  if (["FIL","AR","STORJ","GRT","API3","BAND","LINK","PYTH","TIA","CELR"].includes(n)) return "Infra";
  return "Alt";
}

function tradeViewVisible(){
  return !!document.querySelector('[data-view="trade"].active');
}

/* ── data fetch + merge ─────────────────────────────────────────────── */

async function fetchData(){
  let raw;
  try { raw = await HL.metaAndCtxs(); }
  catch (err){ console.error("[hl-markets] fetch error:", err); return; }

  const [meta, ctxs] = Array.isArray(raw) ? raw : [null, null];
  if (!meta || !Array.isArray(meta.universe) || !Array.isArray(ctxs)){
    console.warn("[hl-markets] unexpected shape:", raw);
    return;
  }

  _rows = [];
  for (let i = 0; i < ctxs.length; i++){
    const u   = meta.universe[i];
    const ctx = ctxs[i];
    if (!u || !ctx) continue;

    const markPx    = parseFloat(ctx.markPx)      || 0;
    const prevDayPx = parseFloat(ctx.prevDayPx)   || 0;
    const funding1h = parseFloat(ctx.funding)      || 0;
    const oi        = parseFloat(ctx.openInterest) || 0;
    const vol       = parseFloat(ctx.dayNtlVlm)    || 0;

    _rows.push({
      name:     u.name,
      maxLev:   u.maxLeverage || 1,
      markPx,
      prevDayPx,
      chgPct:   prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0,
      fund8h:   funding1h * 8 * 100,
      oi:       oi * markPx,
      vol,
      sector:   sectorOf(u.name),
    });
  }

  _lastUpd = Date.now();
  applyFilterAndSort();

  if (_drawerOpen) renderRows();
  renderTopMovers();
  updateCount();
  updateStatStrip();
}

/* ── filter / sort ──────────────────────────────────────────────────── */

function applyFilterAndSort(){
  const q    = _query.trim().toLowerCase();
  const favs = getFavs();
  let base   = _rows.slice();

  if (_filterChip === "fav"){
    base = base.filter(r => favs.includes(r.name));
  } else if (_filterChip === "topvol"){
    const top20 = new Set(_rows.slice().sort((a,b) => b.vol - a.vol).slice(0,20).map(r => r.name));
    base = base.filter(r => top20.has(r.name));
  } else if (_filterChip === "gainers"){
    // sort by best % (handled below), optionally keep positive only
    base = base.filter(r => r.chgPct > 0);
    if (!q) { base.sort((a,b) => b.chgPct - a.chgPct); _filtered = q ? base.filter(r => r.name.toLowerCase().includes(q)) : base; return; }
  } else if (_filterChip === "losers"){
    base = base.filter(r => r.chgPct < 0);
    if (!q) { base.sort((a,b) => a.chgPct - b.chgPct); _filtered = q ? base.filter(r => r.name.toLowerCase().includes(q)) : base; return; }
  } else if (_filterChip !== "all"){
    base = base.filter(r => r.sector === _filterChip);
  }

  if (q) base = base.filter(r => r.name.toLowerCase().includes(q));

  const KEY = {
    sym:  r => r.name,
    px:   r => r.markPx,
    chg:  r => r.chgPct,
    fund: r => r.fund8h,
    oi:   r => r.oi,
    vol:  r => r.vol,
    lev:  r => r.maxLev,
  };
  const key = KEY[_sortCol] || KEY.vol;
  base.sort((a, b) => {
    const va = key(a), vb = key(b);
    if (typeof va === "string") return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return _sortAsc ? va - vb : vb - va;
  });

  _filtered = base;
}

function uniqueSectors(){
  const seen = new Set();
  for (const r of _rows) seen.add(r.sector);
  return [...seen].sort();
}

/* ── TOP MOVERS strip ───────────────────────────────────────────────── */

function renderTopMovers(){
  if (!_moversEl) return;
  if (!_rows.length){ _moversEl.innerHTML = ""; return; }

  // Pick largest absolute movers; include both gainers and losers
  const sorted = _rows.slice().sort((a,b) => Math.abs(b.chgPct) - Math.abs(a.chgPct));
  const top    = sorted.slice(0, TOP_MOVERS_COUNT);
  let html = "";
  for (const r of top){
    const up = r.chgPct >= 0;
    html += `<button class="hlmd-mover${up?" up":" dn"}" data-coin="${esc(r.name)}" aria-label="${esc(r.name)} ${esc(fmtPct(r.chgPct))}">
      ${coinAvatarHTML(r.name, 16)}
      <span class="hlmd-mover-sym">${esc(r.name)}</span>
      <span class="hlmd-mover-pct">${esc(fmtPct(r.chgPct))}</span>
    </button>`;
  }
  _moversEl.innerHTML = html;

  _moversEl.querySelectorAll(".hlmd-mover").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const coin = btn.dataset.coin;
      if (coin) selectCoin(coin);
    });
  });
}

/* ── TRIGGER build ──────────────────────────────────────────────────── */

function buildTrigger(){
  _mount = document.getElementById("hlMarketsMount");
  if (!_mount) return;

  _trigger = document.createElement("div");
  _trigger.className = "hlmd-trigger";
  _trigger.setAttribute("role", "button");
  _trigger.setAttribute("tabindex", "0");
  _trigger.setAttribute("aria-label", "Open markets browser");
  _trigger.setAttribute("aria-haspopup", "dialog");

  _trigger.innerHTML = `
    <button class="hlmd-open-btn" aria-label="Browse all markets" tabindex="-1">
      <svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="1" y="1" width="7" height="7" rx="1.5"/><rect x="10" y="1" width="7" height="7" rx="1.5"/>
        <rect x="1" y="10" width="7" height="7" rx="1.5"/><rect x="10" y="10" width="7" height="7" rx="1.5"/>
      </svg>
      <span>Markets</span>
    </button>
    <div class="hlmd-trigger-sep" aria-hidden="true"></div>
    <div class="hlmd-movers" aria-label="Top movers" role="list"></div>
    <span class="hlmd-count" aria-live="polite">—</span>
    <span class="hlmd-gl-count" aria-live="polite"></span>`;

  _mount.appendChild(_trigger);

  _moversEl  = _trigger.querySelector(".hlmd-movers");
  _countEl   = _trigger.querySelector(".hlmd-count");
  _glCountEl = _trigger.querySelector(".hlmd-gl-count");

  _trigger.addEventListener("click", openDrawer);
  _trigger.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openDrawer(); }
  });
}

function computeStats(){
  let totalVol = 0, gainers = 0, losers = 0;
  for (const r of _rows){
    totalVol += r.vol;
    if (r.chgPct > 0) gainers++;
    else if (r.chgPct < 0) losers++;
  }
  return { totalVol, gainers, losers };
}

function updateCount(){
  if (!_rows.length){ if (_countEl) _countEl.textContent = "—"; return; }
  const { gainers, losers } = computeStats();
  const glText = gainers || losers ? ` · ▲${gainers} / ▼${losers}` : "";
  if (_countEl) _countEl.textContent = _rows.length + " perps" + glText;
  if (_glCountEl) _glCountEl.textContent = gainers || losers ? `▲${gainers} / ▼${losers}` : "";
}

function updateStatStrip(){
  if (!_statStripEl || !_rows.length) return;
  const { totalVol, gainers, losers } = computeStats();
  _statStripEl.querySelector(".hlmd-stat-vol").textContent  = fmtUsd(totalVol);
  _statStripEl.querySelector(".hlmd-stat-gain").textContent = "▲" + gainers;
  _statStripEl.querySelector(".hlmd-stat-lose").textContent = "▼" + losers;
}

/* ── DRAWER build ───────────────────────────────────────────────────── */

function buildDrawer(){
  if (_overlay) return;

  _overlay = document.createElement("div");
  _overlay.className = "hlmd-overlay";
  _overlay.setAttribute("aria-hidden", "true");
  _overlay.innerHTML = `<div class="hlmd-backdrop" aria-hidden="true"></div>`;

  _drawerEl = document.createElement("div");
  _drawerEl.className  = "hlmd-drawer";
  _drawerEl.setAttribute("role", "dialog");
  _drawerEl.setAttribute("aria-modal", "true");
  _drawerEl.setAttribute("aria-label", "Markets browser");
  _drawerEl.tabIndex   = -1;

  _drawerEl.innerHTML = `
    <div class="hlmd-dhead">
      <div class="hlmd-dhead-left">
        <svg class="hlmd-dhead-icon" viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="1" y="1" width="7" height="7" rx="1.5"/><rect x="10" y="1" width="7" height="7" rx="1.5"/>
          <rect x="1" y="10" width="7" height="7" rx="1.5"/><rect x="10" y="10" width="7" height="7" rx="1.5"/>
        </svg>
        <span class="hlmd-dtitle">Perp Markets</span>
        <span class="hlmd-live hlmd-live-el" aria-label="Live data"><span class="dot" aria-hidden="true"></span><span class="hlmd-live-txt">Live</span></span>
      </div>
      <div class="hlmd-dhead-right">
        <div class="hlmd-stat-strip" aria-label="Market summary">
          <span class="hlmd-stat-item">
            <span class="hlmd-stat-label">24h Vol</span>
            <span class="hlmd-stat-vol hlmd-stat-value">—</span>
          </span>
          <span class="hlmd-stat-sep" aria-hidden="true"></span>
          <span class="hlmd-stat-item hlmd-stat-gl">
            <span class="hlmd-stat-gain up" aria-label="Gainers">▲0</span>
            <span class="hlmd-stat-slash" aria-hidden="true">/</span>
            <span class="hlmd-stat-lose dn" aria-label="Losers">▼0</span>
          </span>
        </div>
        <div class="hlmd-density-wrap" role="group" aria-label="Row density">
          <button class="hlmd-density-btn active" data-density="comfortable" aria-label="Comfortable density">Comfy</button>
          <button class="hlmd-density-btn" data-density="compact" aria-label="Compact density">Compact</button>
        </div>
        <span class="hlmd-dcount" aria-live="polite">—</span>
        <button class="hlmd-close" aria-label="Close markets browser">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <div class="hlmd-toolbar">
      <div class="hlmd-search-wrap">
        <svg class="hlmd-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" class="hlmd-search" placeholder="Search symbol… ( / )" aria-label="Search markets" autocomplete="off" spellcheck="false" />
        <button class="hlmd-clr" aria-label="Clear search" hidden>
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M8 6.94 13.47 1.47a.75.75 0 1 1 1.06 1.06L9.06 8l5.47 5.47a.75.75 0 0 1-1.06 1.06L8 9.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L6.94 8 1.47 2.53A.75.75 0 0 1 2.53 1.47L8 6.94Z"/></svg>
        </button>
      </div>
      <div class="hlmd-chips" role="group" aria-label="Filter and sort markets">
        <button class="hlmd-chip active" data-chip="all">All</button>
        <button class="hlmd-chip chip-gain" data-chip="gainers">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M4 1 7.5 6.5H.5z"/></svg>Gainers
        </button>
        <button class="hlmd-chip chip-loss" data-chip="losers">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M4 7 .5 1.5h7z"/></svg>Losers
        </button>
        <button class="hlmd-chip" data-chip="fav">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>Favs
        </button>
        <button class="hlmd-chip" data-chip="topvol">Top Vol</button>
      </div>
    </div>

    <div class="hlmd-thead" role="row">
      <div class="hlmd-th hlmd-sym-col" data-col="sym" role="columnheader" aria-sort="none">Symbol<span class="sa" aria-hidden="true"></span></div>
      <div class="hlmd-th num" data-col="px"   role="columnheader" aria-sort="none">Last<span class="sa" aria-hidden="true"></span></div>
      <div class="hlmd-th num" data-col="chg"  role="columnheader" aria-sort="none">24h %<span class="sa" aria-hidden="true"></span></div>
      <div class="hlmd-th num" data-col="vol"  role="columnheader" aria-sort="none">Vol<span class="sa" aria-hidden="true"></span></div>
      <div class="hlmd-th num hlmd-th-fund" data-col="fund" role="columnheader" aria-sort="none">Fund 8h<span class="sa" aria-hidden="true"></span></div>
      <div class="hlmd-th num hlmd-th-oi" data-col="oi"   role="columnheader" aria-sort="none">OI<span class="sa" aria-hidden="true"></span></div>
    </div>

    <div class="hlmd-body" role="listbox" aria-label="Markets list">
      <div class="hlmd-body-rows" id="hlmdBodyRows"></div>
    </div>

    <div class="hlmd-dfooter">
      <span class="hlmd-fcount" aria-live="polite">Loading…</span>
      <span class="hlmd-kbd-hint" aria-hidden="true">↑↓ navigate · Enter select · / search · Esc close</span>
      <span class="hlmd-lupd"></span>
    </div>`;

  _overlay.appendChild(_drawerEl);
  document.body.appendChild(_overlay);

  _searchEl    = _drawerEl.querySelector(".hlmd-search");
  _liveEl      = _drawerEl.querySelector(".hlmd-live-el");
  _bodyEl      = _drawerEl.querySelector(".hlmd-body-rows");
  _statStripEl = _drawerEl.querySelector(".hlmd-stat-strip");

  // density toggle buttons
  _drawerEl.querySelector(".hlmd-density-wrap").addEventListener("click", e => {
    const btn = e.target.closest(".hlmd-density-btn");
    if (!btn) return;
    _density = btn.dataset.density;
    saveDensity();
    applyDensity();
  });

  // close button
  _drawerEl.querySelector(".hlmd-close").addEventListener("click", closeDrawer);

  // backdrop click
  _overlay.querySelector(".hlmd-backdrop").addEventListener("click", closeDrawer);

  // search input
  const clrBtn = _drawerEl.querySelector(".hlmd-clr");
  _searchEl.addEventListener("input", () => {
    _query = _searchEl.value;
    clrBtn.hidden = !_query;
    _kbIdx = -1;
    applyFilterAndSort();
    renderRows();
    updateDrawerFooter();
  });
  clrBtn.addEventListener("click", () => {
    _searchEl.value = "";
    _query = "";
    clrBtn.hidden = true;
    _kbIdx = -1;
    applyFilterAndSort();
    renderRows();
    updateDrawerFooter();
    _searchEl.focus();
  });

  // chip filters
  const chipWrap = _drawerEl.querySelector(".hlmd-chips");
  chipWrap.addEventListener("click", e => {
    const chip = e.target.closest(".hlmd-chip");
    if (!chip) return;
    chipWrap.querySelectorAll(".hlmd-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    _filterChip = chip.dataset.chip;
    _kbIdx = -1;
    savePrefs();
    applyFilterAndSort();
    renderRows();
    updateDrawerFooter();
  });

  // column sort headers
  _drawerEl.querySelector(".hlmd-thead").addEventListener("click", e => {
    const th = e.target.closest("[data-col]");
    if (!th || !th.dataset.col) return;
    const col = th.dataset.col;
    if (_sortCol === col) _sortAsc = !_sortAsc;
    else { _sortCol = col; _sortAsc = col === "sym"; }
    _kbIdx = -1;
    savePrefs();
    syncSortHeaders();
    applyFilterAndSort();
    renderRows();
  });

  // keyboard nav (arrow keys + enter + / for search focus)
  _drawerEl.addEventListener("keydown", handleDrawerKey);

  // global "/" shortcut while drawer is open
  syncSortHeaders();
  applyDensity();
}

/* ── sync sort header visual state ─────────────────────────────────── */

function syncSortHeaders(){
  if (!_drawerEl) return;
  _drawerEl.querySelectorAll(".hlmd-th[data-col]").forEach(el => {
    const isCur = el.dataset.col === _sortCol;
    el.classList.toggle("active", isCur);
    el.setAttribute("aria-sort", isCur ? (_sortAsc ? "ascending" : "descending") : "none");
  });
}

/* ── DRAWER sector chips ────────────────────────────────────────────── */

function renderSectorChips(){
  if (!_drawerEl) return;
  const chipWrap = _drawerEl.querySelector(".hlmd-chips");
  chipWrap.querySelectorAll(".hlmd-chip[data-sector]").forEach(c => c.remove());

  for (const sec of uniqueSectors()){
    const btn = document.createElement("button");
    btn.className      = "hlmd-chip";
    btn.dataset.chip   = sec;
    btn.dataset.sector = "1";
    btn.textContent    = sec;
    if (_filterChip === sec) btn.classList.add("active");
    chipWrap.appendChild(btn);
  }
}

/* ── restore active chip UI from prefs ─────────────────────────────── */

function syncChipUI(){
  if (!_drawerEl) return;
  const chipWrap = _drawerEl.querySelector(".hlmd-chips");
  if (!chipWrap) return;
  chipWrap.querySelectorAll(".hlmd-chip").forEach(c => {
    c.classList.toggle("active", c.dataset.chip === _filterChip);
  });
}

/* ── DRAWER row rendering ───────────────────────────────────────────── */

function renderRows(){
  if (!_bodyEl) return;
  _kbIdx = -1;

  if (!_rows.length){
    _bodyEl.innerHTML = `<div class="hlmd-loading" aria-label="Loading markets">${buildSkel(10)}</div>`;
    return;
  }

  if (!_filtered.length){
    const msg = _query
      ? `No results for "<strong>${esc(_query)}</strong>"`
      : (_filterChip === "fav"
          ? "No favorites yet — star a coin to add it."
          : _filterChip === "gainers"
          ? "No gainers right now."
          : _filterChip === "losers"
          ? "No losers right now."
          : "No markets match this filter.");
    _bodyEl.innerHTML = `<div class="hlmd-empty" role="status">${msg}</div>`;
    return;
  }

  const active = activeCoin();
  const favs   = new Set(getFavs());
  const frag   = document.createDocumentFragment();

  _filtered.forEach((r, i) => {
    const up      = r.chgPct >= 0;
    const fundUp  = r.fund8h >= 0;
    const fav     = favs.has(r.name);
    const sel     = r.name === active;
    const fundAbs = Math.abs(r.fund8h);
    const fundHigh = fundAbs >= 0.05; // highlight when funding is notable

    const row = document.createElement("div");
    row.className = "hlmd-row" + (sel ? " selected" : "");
    row.dataset.coin  = r.name;
    row.dataset.idx   = String(i);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(sel));
    row.setAttribute("tabindex", "-1");
    // stagger delay for entrance animation (cap at 40 rows for perf)
    if (i < 40) row.style.setProperty("--row-i", String(i));

    row.innerHTML = `
      <div class="hlmd-cell hlmd-sym-col">
        <div class="hlmd-avatar">${coinAvatarHTML(r.name, 26)}</div>
        <div class="hlmd-sym-info">
          <span class="hlmd-sym">${esc(r.name)}</span>
          <span class="hlmd-tag">${esc(r.sector)}</span>
        </div>
        <button class="hlmd-star${fav?" on":""}" data-coin="${esc(r.name)}" aria-label="${fav?"Remove from":"Add to"} favorites" aria-pressed="${fav}" tabindex="-1">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="${fav?"currentColor":"none"}" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
        </button>
      </div>
      <div class="hlmd-cell num px">${esc(fmtPx(r.markPx))}</div>
      <div class="hlmd-cell num chg ${up?"up":"dn"}">${esc(fmtPct(r.chgPct))}</div>
      <div class="hlmd-cell num vol">${esc(fmtUsd(r.vol))}</div>
      <div class="hlmd-cell num fund ${fundUp?"up":"dn"}${fundHigh?" high":""}" title="8h funding: ${esc(fmtFund(r.fund8h))}">
        <span class="fund-sign" aria-hidden="true">${fundUp?"▲":"▼"}</span>${esc(fmtFund(r.fund8h))}
      </div>
      <div class="hlmd-cell num oi">${esc(fmtOI(r.oi))}</div>`;

    row.addEventListener("click", e => {
      if (e.target.closest(".hlmd-star")) return;
      selectCoin(row.dataset.coin);
    });

    row.querySelector(".hlmd-star").addEventListener("click", e => {
      e.stopPropagation();
      const coin  = e.currentTarget.dataset.coin;
      const nowOn = toggleFav(coin);
      const btn   = e.currentTarget;
      btn.classList.toggle("on", nowOn);
      btn.setAttribute("aria-pressed", String(nowOn));
      btn.setAttribute("aria-label", (nowOn ? "Remove from" : "Add to") + " favorites");
      const svgEl = btn.querySelector("svg");
      if (svgEl) svgEl.setAttribute("fill", nowOn ? "currentColor" : "none");
      if (_filterChip === "fav"){ applyFilterAndSort(); renderRows(); updateDrawerFooter(); }
    });

    frag.appendChild(row);
  });

  _bodyEl.innerHTML = "";
  _bodyEl.appendChild(frag);
}

/* ── price snapshot for flash detection ────────────────────────────── */

/** @type {Map<string, number>} coin → previous markPx */
const _prevPx = new Map();

/* ── in-place price patch (smooth for 100+ rows) ───────────────────── */

function patchPrices(){
  if (!_bodyEl) return;
  const active = activeCoin();
  for (const r of _rows){
    const row = _bodyEl.querySelector(`.hlmd-row[data-coin="${CSS.escape(r.name)}"]`);
    if (!row) continue;
    const cells = row.querySelectorAll(".hlmd-cell");
    // 0=sym, 1=px, 2=chg, 3=vol, 4=fund, 5=oi

    if (cells[1]){
      const prev = _prevPx.get(r.name);
      const newVal = fmtPx(r.markPx);
      const oldTxt = cells[1].textContent;
      // Only flash if the formatted price actually changed (avoids spurious flashes)
      if (prev !== undefined && newVal !== oldTxt){
        const dir = r.markPx > prev ? "up" : "dn";
        cells[1].textContent = newVal;
        // Remove any prior flash class, then re-add to retrigger animation
        cells[1].classList.remove("hlmd-flash-up", "hlmd-flash-dn");
        // Force reflow so re-adding works
        void cells[1].offsetWidth; // eslint-disable-line no-void
        cells[1].classList.add("hlmd-flash-" + dir);
      } else {
        cells[1].textContent = newVal;
      }
    }

    if (cells[2]){
      const up = r.chgPct >= 0;
      cells[2].textContent = fmtPct(r.chgPct);
      cells[2].className = "hlmd-cell num chg " + (up ? "up" : "dn");
    }
    if (cells[3]) cells[3].textContent = fmtUsd(r.vol);
    if (cells[4]){
      const fundUp  = r.fund8h >= 0;
      const fundHigh = Math.abs(r.fund8h) >= 0.05;
      // rebuild funding cell content
      cells[4].innerHTML = `<span class="fund-sign" aria-hidden="true">${fundUp?"▲":"▼"}</span>${esc(fmtFund(r.fund8h))}`;
      cells[4].className = "hlmd-cell num fund " + (fundUp ? "up" : "dn") + (fundHigh ? " high" : "");
      cells[4].title = "8h funding: " + fmtFund(r.fund8h);
    }
    if (cells[5]) cells[5].textContent = fmtOI(r.oi);

    const sel = r.name === active;
    row.classList.toggle("selected", sel);
    row.setAttribute("aria-selected", String(sel));

    // Update snapshot after patching
    _prevPx.set(r.name, r.markPx);
  }
}

/* Snapshot prices before first patch so flash only fires on genuine changes */
function snapshotPrices(){
  for (const r of _rows) _prevPx.set(r.name, r.markPx);
}

function updateHighlight(coin){
  if (!_bodyEl) return;
  _bodyEl.querySelectorAll(".hlmd-row").forEach(el => {
    const match = el.dataset.coin === coin;
    el.classList.toggle("selected", match);
    el.setAttribute("aria-selected", String(match));
    if (match) el.scrollIntoView({ block: "nearest" });
  });
}

function updateDrawerFooter(){
  if (!_drawerEl) return;
  const fc = _drawerEl.querySelector(".hlmd-fcount");
  const lu = _drawerEl.querySelector(".hlmd-lupd");
  const dc = _drawerEl.querySelector(".hlmd-dcount");
  if (fc) fc.textContent = `${_filtered.length} / ${_rows.length} markets`;
  if (dc) dc.textContent = _rows.length ? _rows.length + " perps" : "";
  if (lu && _lastUpd){
    const d = new Date(_lastUpd);
    lu.textContent = "Updated " +
      String(d.getUTCHours()).padStart(2,"0")   + ":" +
      String(d.getUTCMinutes()).padStart(2,"0") + ":" +
      String(d.getUTCSeconds()).padStart(2,"0") + " UTC";
  }
}

/* ── skeleton rows ──────────────────────────────────────────────────── */

function buildSkel(n){
  let h = "";
  for (let i = 0; i < n; i++){
    const w = 40 + Math.round(Math.random() * 40);
    h += `<div class="hlmd-skel-row">
      <div class="hlmd-skel-cell wide"></div>
      <div class="hlmd-skel-cell" style="width:${w}%"></div>
      <div class="hlmd-skel-cell" style="width:${w}%"></div>
      <div class="hlmd-skel-cell" style="width:${w}%"></div>
      <div class="hlmd-skel-cell" style="width:${w}%"></div>
      <div class="hlmd-skel-cell" style="width:${w}%"></div>
    </div>`;
  }
  return h;
}

/* ── keyboard navigation ────────────────────────────────────────────── */

function handleDrawerKey(e){
  // Esc: close
  if (e.key === "Escape"){ e.preventDefault(); closeDrawer(); return; }

  // "/" focuses search (unless already in input)
  if (e.key === "/" && document.activeElement !== _searchEl){
    e.preventDefault();
    _searchEl?.focus();
    return;
  }

  // Arrow up/down nav
  if (e.key === "ArrowDown" || e.key === "ArrowUp"){
    e.preventDefault();
    if (!_filtered.length) return;
    if (e.key === "ArrowDown"){
      _kbIdx = Math.min(_kbIdx + 1, _filtered.length - 1);
    } else {
      _kbIdx = Math.max(_kbIdx - 1, 0);
    }
    applyKbFocus();
    return;
  }

  // Enter selects kb-highlighted row
  if (e.key === "Enter"){
    if (_kbIdx >= 0 && _kbIdx < _filtered.length){
      e.preventDefault();
      selectCoin(_filtered[_kbIdx].name);
    }
    return;
  }
}

function applyKbFocus(){
  if (!_bodyEl || _kbIdx < 0) return;
  _bodyEl.querySelectorAll(".hlmd-row").forEach((el, i) => {
    el.classList.toggle("kb-focus", i === _kbIdx);
  });
  const target = _bodyEl.querySelector(`.hlmd-row[data-idx="${_kbIdx}"]`);
  if (target) target.scrollIntoView({ block: "nearest" });
}

/* ── open / close drawer ────────────────────────────────────────────── */

function openDrawer(){
  if (_drawerOpen) return;
  if (!_overlay) buildDrawer();

  _drawerOpen = true;
  _kbIdx      = -1;
  _overlay.setAttribute("aria-hidden", "false");
  _overlay.classList.add("open");

  // sync active chip with prefs
  syncChipUI();
  syncSortHeaders();

  if (_rows.length){
    renderSectorChips();
    applyFilterAndSort();
    renderRows();
    updateDrawerFooter();
    updateStatStrip();
    snapshotPrices();
  } else {
    if (_bodyEl) _bodyEl.innerHTML = `<div class="hlmd-loading">${buildSkel(12)}</div>`;
    fetchData().then(() => {
      renderSectorChips();
      syncChipUI();
      applyFilterAndSort();
      renderRows();
      updateDrawerFooter();
      updateStatStrip();
      snapshotPrices();
    });
  }

  startPolling();

  requestAnimationFrame(() => { _searchEl?.focus(); });

  document.addEventListener("keydown", _trapFocus);
  document.body.style.overflow = "hidden";
}

function closeDrawer(){
  if (!_drawerOpen) return;
  _drawerOpen = false;
  _overlay.classList.remove("open");
  _overlay.setAttribute("aria-hidden", "true");

  stopPolling();
  document.removeEventListener("keydown", _trapFocus);
  document.body.style.overflow = "";
  _trigger?.querySelector(".hlmd-open-btn")?.focus();
}

/* ── focus trap ─────────────────────────────────────────────────────── */

function _trapFocus(e){
  if (e.key === "Escape"){ closeDrawer(); return; }
  if (e.key !== "Tab" || !_drawerEl) return;

  const focusable = _drawerEl.querySelectorAll(
    "button:not([disabled]),input,[tabindex='0']"
  );
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  if (e.shiftKey){
    if (document.activeElement === first){ e.preventDefault(); last?.focus(); }
  } else {
    if (document.activeElement === last){ e.preventDefault(); first?.focus(); }
  }
}

/* ── coin selection ─────────────────────────────────────────────────── */

function selectCoin(sym){
  if (!sym) return;
  try { window.LZ?.hl?.setCoin?.(sym); } catch (err){ console.warn("[hl-markets] setCoin:", err); }
  updateHighlight(sym);
  closeDrawer();
  document.querySelector(".ticket-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ── polling ────────────────────────────────────────────────────────── */

function startPolling(){
  if (_pollTimer) return;
  _liveEl?.classList.add("on");
  _pollTimer = setInterval(async () => {
    if (!tradeViewVisible() || !_drawerOpen){ stopPolling(); return; }
    await fetchData();
    if (_drawerOpen){ patchPrices(); updateStatStrip(); }
    else renderTopMovers();
    updateDrawerFooter();
  }, POLL_INTERVAL);
}

function stopPolling(){
  if (_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  _liveEl?.classList.remove("on");
}

/* ── global event listeners ─────────────────────────────────────────── */

function bindEvents(){
  window.addEventListener("lz:hl:coin", e => {
    const coin = e?.detail?.coin;
    if (coin) updateHighlight(coin);
  });

  window.addEventListener("lz:hl:net", () => {
    _rows = [];
    _filtered = [];
    if (_bodyEl) _bodyEl.innerHTML = buildSkel(8);
    if (_drawerOpen){
      fetchData().then(() => {
        renderSectorChips();
        applyFilterAndSort();
        renderRows();
        updateDrawerFooter();
      });
    } else {
      fetchData();
    }
  });

  window.addEventListener("lz:route", e => {
    const route = e?.detail?.route;
    if (route !== "trade") stopPolling();
    else if (_drawerOpen) startPolling();
  });
}

/* ── init ───────────────────────────────────────────────────────────── */

(function initHlMarkets(){
  const mount = document.getElementById("hlMarketsMount");
  if (!mount) return;
  if (_initialized) return;
  _initialized = true;

  loadPrefs();
  loadDensity();
  buildTrigger();
  bindEvents();

  fetchData().then(() => {
    renderTopMovers();
    updateCount();
  });
})();
