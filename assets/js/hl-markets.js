/* =====================================================================
 *  hl-markets.js — ALL-PERPS MARKETS EXPLORER (Hyperliquid parity)
 *  ---------------------------------------------------------------------
 *  STATUS: STUB. You (the MARKETS-EXPLORER agent) implement this file
 *  and assets/css/hl-markets.css ONLY. Do not touch any other file.
 *
 *  GOAL: a sortable, searchable table of EVERY Hyperliquid perp — the
 *  equivalent of Hyperliquid's perps directory — mounted in the trade view.
 *
 *  MOUNT POINT (already in app.html, inside <section data-view="trade">):
 *      <div id="hlMarketsMount"></div>
 *  Render your whole UI inside it. It should be collapsible (a header bar
 *  with a chevron) so it doesn't crowd the trade screen; default collapsed
 *  or compact is fine.
 *
 *  COLUMNS (match Hyperliquid): Symbol · Mark/Last px · 24h change % ·
 *  8h funding % · Open interest ($) · 24h volume ($) · a tiny sparkline.
 *  Make every column sortable (click header toggles asc/desc). Add a
 *  search/filter <input> that filters by symbol. Highlight the row of the
 *  currently-selected coin. Clicking a row selects that market and scrolls
 *  the ticket into view (see INTEGRATION).
 *
 *  DATA — import the keyless HL layer:
 *      import * as HL from "./hyperliquid.js";
 *    · HL.metaAndCtxs() -> [meta, assetCtxs]
 *        meta.universe[i] = { name, szDecimals, maxLeverage }
 *        assetCtxs[i]     = { markPx, oraclePx, midPx, prevDayPx, funding,
 *                             openInterest, dayNtlVlm, premium, ... }   (strings)
 *        24h change % = (markPx - prevDayPx) / prevDayPx * 100
 *        funding is the 1h rate as a decimal string; HL shows 8h ≈ funding*8*100 %.
 *        OI ($) ≈ openInterest * markPx.  volume ($) = dayNtlVlm.
 *    · For sparklines: HL.candleSnapshot(coin, "1h", startMs, endMs) -> [{t,o,h,l,c,v}].
 *      Fetch lazily / cache; don't hammer the API for 100+ coins at once
 *      (e.g. only fetch sparkline data for visible rows, or skip if costly).
 *    · Poll HL.metaAndCtxs() every ~5s to keep prices live (only while the
 *      trade view is active AND your panel is expanded — check document
 *      .querySelector('[data-view="trade"]').classList or the mount being
 *      visible; stop polling when hidden to save the API).
 *
 *  INTEGRATION SURFACE (read-only helpers, already provided):
 *    · window.LZ.hl.setCoin("ETH")  -> switches the active trade market.
 *    · window.LZ.hl.coin()          -> current selected coin (string).
 *    · window.LZ.hl.universe()      -> [{name, szDecimals, maxLeverage}].
 *    · Listen for coin changes to move the row highlight:
 *        window.addEventListener("lz:hl:coin", (e) => { e.detail.coin });
 *    · Listen for network changes to reload everything:
 *        window.addEventListener("lz:hl:net", (e) => { e.detail.network });
 *    · On row click: window.LZ.hl.setCoin(sym); then
 *        document.querySelector(".ticket-card")?.scrollIntoView({behavior:"smooth"});
 *
 *  STYLE: dark aesthetic. Mirror the markets table + .kpi conventions in
 *  assets/css/app.css and the trade tables in assets/css/trade.css. Put all
 *  styling in assets/css/hl-markets.css. Reuse base.css tokens (--accent,
 *  --long/--short or --up/--down, --border, --surface, --mono, --text-dim).
 *
 *  HARD CONSTRAINTS: no build, no npm, no external chart/table libs. Pure
 *  DOM + canvas/SVG. Escape any text you inject as HTML. Guard every
 *  window.LZ / DOM access (the mount may not exist on non-trade pages).
 *  `node --check assets/js/hl-markets.js` must pass.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";

/* ── constants ──────────────────────────────────────────────────────── */

const POLL_INTERVAL   = 5_000;    // ms between metaAndCtxs polls
const SPARK_HOURS     = 24;       // hours of history for sparklines
const SPARK_INTERVAL  = "1h";     // candle interval for sparklines
const SPARK_BATCH     = 6;        // fetch sparklines N at a time to avoid hammering
const SPARK_BATCH_DELAY = 200;    // ms between batches

/* ── module state ───────────────────────────────────────────────────── */

/** @type {Array<{name:string,szDecimals:number,maxLeverage:number,
 *   markPx:number,prevDayPx:number,funding:number,
 *   openInterest:number,dayNtlVlm:number,chgPct:number,
 *   oi:number,fund8h:number}>} */
let _rows       = [];          // merged meta + ctx rows
let _filtered   = [];          // after search filter
let _sortCol    = "vol";       // default sort column
let _sortAsc    = false;       // descending by default
let _query      = "";          // search query
let _pollTimer  = null;        // setInterval handle
let _isOpen     = false;       // panel expanded?

/** spark cache: coin -> SVG string (or "" if failed) */
const _sparkCache = new Map();
/** which coins are currently being fetched */
const _sparkFetching = new Set();

/* ── helpers ────────────────────────────────────────────────────────── */

/** Safely escape a string for innerHTML injection */
function esc(s){
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

/** Compact dollar formatter — e.g. 1.23B, 456M, 1.2K */
function fmtUsd(n){
  if (!isFinite(n)) return "—";
  if (n >= 1e9)  return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6)  return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3)  return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

/** Format a price number with up to 6 sig-figs, trimming trailing zeros */
function fmtPx(n){
  if (!isFinite(n) || n <= 0) return "—";
  if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)     return n.toPrecision(6).replace(/\.?0+$/, "");
  return n.toPrecision(4).replace(/\.?0+$/, "");
}

/** Format a percentage with sign and 4 decimal places for funding */
function fmtPct(n, decimals = 2){
  if (!isFinite(n)) return "—";
  const s = (n >= 0 ? "+" : "") + n.toFixed(decimals) + "%";
  return s;
}

/** Build a sparkline SVG from an array of close prices */
function sparkSVG(closes, up){
  if (!closes || closes.length < 2) return "";
  const W = 72, H = 22;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const pts = closes.map((v, i) =>
    `${((i / (closes.length - 1)) * W).toFixed(1)},${(H - ((v - min) / range) * H).toFixed(1)}`
  ).join(" ");
  const color = up ? "var(--long)" : "var(--short)";
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>` +
    `</svg>`;
}

/** Check if the trade view is currently visible */
function tradeViewVisible(){
  return !!document.querySelector('[data-view="trade"].active');
}

/** Get current selected coin from window.LZ (guarded) */
function activeCoin(){
  try { return window.LZ?.hl?.coin?.() || ""; } catch { return ""; }
}

/* ── sparkline lazy-fetch ───────────────────────────────────────────── */

/**
 * Fetches sparklines for a batch of coins that are visible in the table.
 * Respects the per-batch limit to avoid hammering the API.
 */
async function fetchSparklinesForVisible(){
  if (!_filtered.length) return;

  // Collect coins not yet cached and not already being fetched
  const needed = _filtered
    .map(r => r.name)
    .filter(c => !_sparkCache.has(c) && !_sparkFetching.has(c))
    .slice(0, SPARK_BATCH);

  if (!needed.length) return;

  needed.forEach(c => _sparkFetching.add(c));

  const now     = Date.now();
  const startMs = now - SPARK_HOURS * 3_600_000;

  for (let i = 0; i < needed.length; i++){
    const coin = needed[i];
    try {
      const candles = await HL.candleSnapshot(coin, SPARK_INTERVAL, startMs, now);
      if (Array.isArray(candles) && candles.length >= 2){
        const closes = candles.map(c => parseFloat(c.c));
        const up = closes[0] <= closes[closes.length - 1];
        _sparkCache.set(coin, sparkSVG(closes, up));
      } else {
        _sparkCache.set(coin, "");
      }
    } catch {
      _sparkCache.set(coin, "");
    }
    _sparkFetching.delete(coin);
    // inject the sparkline into the existing DOM row if present
    injectSparkInRow(coin);
    // small delay between each request
    if (i < needed.length - 1){
      await new Promise(r => setTimeout(r, SPARK_BATCH_DELAY));
    }
  }
}

/** Update just the sparkline cell in a rendered row, without full re-render */
function injectSparkInRow(coin){
  const row = document.querySelector(`.hlm-row[data-coin="${CSS.escape(coin)}"] .spark`);
  if (!row) return;
  const svg = _sparkCache.get(coin);
  row.innerHTML = svg || "";
}

/* ── data fetch + merge ─────────────────────────────────────────────── */

async function fetchData(){
  let raw;
  try {
    raw = await HL.metaAndCtxs();
  } catch (err){
    console.error("[hl-markets] metaAndCtxs error:", err);
    return;
  }

  // metaAndCtxs returns [meta, assetCtxs]
  // meta.universe[i] has perp assets; assetCtxs[i] matches by index.
  // Spot assets appear only in meta, not ctxs — so we use the ctxs length.
  const [meta, ctxs] = Array.isArray(raw) ? raw : [null, null];
  if (!meta || !Array.isArray(meta.universe) || !Array.isArray(ctxs)){
    console.warn("[hl-markets] unexpected metaAndCtxs shape:", raw);
    return;
  }

  _rows = [];
  for (let i = 0; i < ctxs.length; i++){
    const u   = meta.universe[i];
    const ctx = ctxs[i];
    if (!u || !ctx) continue;

    const markPx    = parseFloat(ctx.markPx)      || 0;
    const prevDayPx = parseFloat(ctx.prevDayPx)   || 0;
    const funding1h = parseFloat(ctx.funding)      || 0;   // 1h rate
    const oi        = parseFloat(ctx.openInterest) || 0;   // in base units
    const vol       = parseFloat(ctx.dayNtlVlm)    || 0;   // already in USD

    const chgPct  = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;
    const fund8h  = funding1h * 8 * 100;       // convert 1h decimal → 8h %
    const oiUsd   = oi * markPx;               // OI in USD

    _rows.push({
      name:       u.name,
      maxLev:     u.maxLeverage || 1,
      markPx,
      prevDayPx,
      chgPct,
      fund8h,
      oi:         oiUsd,
      vol,
    });
  }

  applyFilterAndSort();
  renderRows();
  updateFooter();
  // kick off lazy sparkline fetching for newly visible rows
  fetchSparklinesForVisible();
}

/* ── filter + sort ──────────────────────────────────────────────────── */

function applyFilterAndSort(){
  const q = _query.trim().toLowerCase();
  _filtered = q
    ? _rows.filter(r => r.name.toLowerCase().includes(q))
    : _rows.slice();

  // sort
  const COL_KEY = {
    sym:  r => r.name,
    px:   r => r.markPx,
    chg:  r => r.chgPct,
    fund: r => r.fund8h,
    oi:   r => r.oi,
    vol:  r => r.vol,
  };
  const key = COL_KEY[_sortCol] || COL_KEY.vol;
  _filtered.sort((a, b) => {
    const va = key(a), vb = key(b);
    // string sort for symbol
    if (typeof va === "string") return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return _sortAsc ? va - vb : vb - va;
  });
}

/* ── DOM building ───────────────────────────────────────────────────── */

let _mount   = null;   // #hlMarketsMount
let _panel   = null;   // .hlm-panel
let _scrollEl= null;   // .hlm-scroll
let _tableEl = null;   // .hlm-table (rows only)
let _countEl = null;   // .hlm-count
let _footerEl= null;   // .hlm-footer
let _liveEl  = null;   // .hlm-live
let _lastUpd = 0;      // timestamp of last successful update

function buildPanel(){
  _mount = document.getElementById("hlMarketsMount");
  if (!_mount) return;

  _panel = document.createElement("div");
  _panel.className = "hlm-panel";   // default: collapsed

  // ── header ──
  const header = document.createElement("div");
  header.className = "hlm-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");
  header.setAttribute("aria-label", "All-perps markets explorer — click to expand");
  header.innerHTML = `
    <span class="hlm-title">All Perps</span>
    <span class="hlm-count hlm-count-el">—</span>
    <span class="hlm-live hlm-live-el"><span class="dot"></span>Live</span>
    <svg class="hlm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>`;

  header.addEventListener("click", togglePanel);
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); togglePanel(); }
  });

  // ── body ──
  const body = document.createElement("div");
  body.className = "hlm-body";

  // toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "hlm-toolbar";
  toolbar.innerHTML = `
    <div class="hlm-search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="search" class="hlm-search" placeholder="Filter by symbol…"
             aria-label="Filter markets by symbol" autocomplete="off" spellcheck="false"/>
      <span class="hlm-clear" aria-label="Clear search" role="button" tabindex="0">×</span>
    </div>
    <span class="hlm-sort-label">Sort: <span class="hlm-sort-col">Volume ↓</span></span>`;

  // table (header row + scroll area for data rows)
  const tableWrap = document.createElement("div");
  tableWrap.className = "hlm-table";

  const thead = buildTableHead();
  const scroll = document.createElement("div");
  scroll.className = "hlm-scroll";

  const tbody = document.createElement("div");
  tbody.className = "hlm-tbody";
  // initial skeleton
  tbody.innerHTML = buildSkeleton(12);

  scroll.appendChild(tbody);
  tableWrap.appendChild(thead);
  tableWrap.appendChild(scroll);

  // footer
  const footer = document.createElement("div");
  footer.className = "hlm-footer";
  footer.innerHTML = `<span class="hlm-row-count"></span><span class="last-upd"></span>`;

  body.appendChild(toolbar);
  body.appendChild(tableWrap);
  body.appendChild(footer);

  _panel.appendChild(header);
  _panel.appendChild(body);
  _mount.appendChild(_panel);

  // cache refs
  _countEl  = _panel.querySelector(".hlm-count-el");
  _liveEl   = _panel.querySelector(".hlm-live-el");
  _scrollEl = scroll;
  _tableEl  = tbody;
  _footerEl = footer;

  // wire up search input
  const inp  = toolbar.querySelector(".hlm-search");
  const clr  = toolbar.querySelector(".hlm-clear");
  inp.addEventListener("input", () => {
    _query = inp.value;
    clr.classList.toggle("vis", !!_query);
    applyFilterAndSort();
    renderRows();
    updateFooter();
    fetchSparklinesForVisible();
  });
  clr.addEventListener("click", () => {
    inp.value = "";
    _query = "";
    clr.classList.remove("vis");
    applyFilterAndSort();
    renderRows();
    updateFooter();
  });
  clr.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") clr.click();
  });
}

function buildTableHead(){
  const head = document.createElement("div");
  head.className = "hlm-head";

  const COLS = [
    { id: "sym",  label: "Symbol"   },
    { id: "px",   label: "Mark px"  },
    { id: "chg",  label: "24h %"    },
    { id: "fund", label: "8h Fund"  },
    { id: "oi",   label: "OI"       },
    { id: "vol",  label: "Volume"   },
    { id: "",     label: "Spark",   noSort: true },
  ];

  COLS.forEach(col => {
    const btn = document.createElement("button");
    btn.className = "hlm-th" + (col.id === _sortCol ? " active " + (_sortAsc ? "asc" : "desc") : "");
    btn.dataset.col = col.id;
    btn.setAttribute("aria-label", col.noSort ? col.label : `Sort by ${col.label}`);
    if (col.noSort) btn.style.cursor = "default";
    btn.innerHTML = esc(col.label) + (col.noSort ? "" : `<span class="sort-arrow"></span>`);

    if (!col.noSort){
      btn.addEventListener("click", () => {
        if (_sortCol === col.id){
          _sortAsc = !_sortAsc;
        } else {
          _sortCol = col.id;
          _sortAsc = col.id === "sym";   // symbol sorts A→Z by default
        }
        // update all th states
        head.querySelectorAll(".hlm-th").forEach(el => {
          el.classList.remove("active","asc","desc");
          if (el.dataset.col === _sortCol){
            el.classList.add("active", _sortAsc ? "asc" : "desc");
          }
        });
        // update sort label
        const lbl = _panel?.querySelector(".hlm-sort-col");
        if (lbl) lbl.textContent = col.label + (_sortAsc ? " ↑" : " ↓");

        applyFilterAndSort();
        renderRows();
      });
    }
    head.appendChild(btn);
  });

  return head;
}

function buildSkeleton(n){
  let html = "";
  for (let i = 0; i < n; i++){
    html += `<div class="hlm-skel-row">
      <div class="hlm-skel-cell wide"></div>
      <div class="hlm-skel-cell narrow"></div>
      <div class="hlm-skel-cell narrow"></div>
      <div class="hlm-skel-cell narrow"></div>
      <div class="hlm-skel-cell narrow"></div>
      <div class="hlm-skel-cell narrow"></div>
      <div class="hlm-skel-cell narrow"></div>
    </div>`;
  }
  return html;
}

/* ── row rendering ──────────────────────────────────────────────────── */

function renderRows(){
  if (!_tableEl) return;

  if (!_filtered.length){
    _tableEl.innerHTML = `<div class="hlm-empty">${_query ? "No coins match “" + esc(_query) + "”" : "No data yet"}</div>`;
    return;
  }

  const active = activeCoin();
  let html = "";

  for (const r of _filtered){
    const chgUp  = r.chgPct >= 0;
    const fundUp = r.fund8h >= 0;
    const spark  = _sparkCache.get(r.name) || "";
    const isActive = r.name === active;

    html += `<div class="hlm-row${isActive ? " selected" : ""}"
      data-coin="${esc(r.name)}"
      role="button"
      tabindex="0"
      aria-label="${esc(r.name)} — click to trade"
      aria-pressed="${isActive}">
      <div class="hlm-cell hlm-sym-cell">
        <span class="hlm-sym">${esc(r.name)}-PERP</span>
        <span class="hlm-max-lev">${esc(String(r.maxLev))}x max</span>
      </div>
      <div class="hlm-cell num px">${esc(fmtPx(r.markPx))}</div>
      <div class="hlm-cell num chg ${chgUp ? "up" : "dn"}">${esc(fmtPct(r.chgPct))}</div>
      <div class="hlm-cell num fund ${fundUp ? "up" : "dn"}">${esc(fmtPct(r.fund8h, 4))}</div>
      <div class="hlm-cell num oi">${esc(fmtUsd(r.oi))}</div>
      <div class="hlm-cell num vol">${esc(fmtUsd(r.vol))}</div>
      <div class="hlm-cell spark">${spark}</div>
    </div>`;
  }

  _tableEl.innerHTML = html;

  // wire click + keyboard on each row
  _tableEl.querySelectorAll(".hlm-row").forEach(el => {
    el.addEventListener("click",   () => selectCoin(el.dataset.coin));
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " "){ e.preventDefault(); selectCoin(el.dataset.coin); }
    });
  });
}

/** Update just the highlight without a full re-render */
function updateHighlight(coin){
  if (!_tableEl) return;
  _tableEl.querySelectorAll(".hlm-row").forEach(el => {
    const match = el.dataset.coin === coin;
    el.classList.toggle("selected", match);
    el.setAttribute("aria-pressed", match ? "true" : "false");
  });
}

function updateFooter(){
  if (!_footerEl) return;
  const countEl  = _footerEl.querySelector(".hlm-row-count");
  const updEl    = _footerEl.querySelector(".last-upd");
  if (countEl) countEl.textContent = `${_filtered.length} / ${_rows.length} markets`;
  if (updEl && _lastUpd){
    const d = new Date(_lastUpd);
    updEl.textContent = "Updated " + String(d.getUTCHours()).padStart(2,"0") + ":" +
      String(d.getUTCMinutes()).padStart(2,"0") + ":" +
      String(d.getUTCSeconds()).padStart(2,"0") + " UTC";
  }
}

/* ── panel open / close ─────────────────────────────────────────────── */

function togglePanel(){
  _isOpen = !_isOpen;
  _panel.classList.toggle("open", _isOpen);
  const header = _panel.querySelector(".hlm-header");
  if (header) header.setAttribute("aria-expanded", _isOpen ? "true" : "false");

  if (_isOpen){
    startPolling();
    if (!_rows.length) fetchData();
    else fetchSparklinesForVisible();
  } else {
    stopPolling();
  }
}

/* ── polling ────────────────────────────────────────────────────────── */

function startPolling(){
  if (_pollTimer) return;
  _liveEl?.classList.add("on");
  _pollTimer = setInterval(async () => {
    if (!tradeViewVisible() || !_isOpen){
      stopPolling();
      return;
    }
    await fetchData();
    _lastUpd = Date.now();
    updateFooter();
  }, POLL_INTERVAL);
}

function stopPolling(){
  if (_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  _liveEl?.classList.remove("on");
}

/* ── coin selection ─────────────────────────────────────────────────── */

function selectCoin(sym){
  if (!sym) return;
  try {
    window.LZ?.hl?.setCoin?.(sym);
  } catch (err){
    console.warn("[hl-markets] setCoin error:", err);
  }
  updateHighlight(sym);
  // scroll the order ticket into view
  document.querySelector(".ticket-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ── count badge update ─────────────────────────────────────────────── */

function updateCount(){
  if (_countEl) _countEl.textContent = _rows.length ? String(_rows.length) : "—";
}

/* ── event listeners ────────────────────────────────────────────────── */

function bindEvents(){
  // another module changed the active coin
  window.addEventListener("lz:hl:coin", e => {
    const coin = e?.detail?.coin;
    if (coin) updateHighlight(coin);
  });

  // network changed — flush all cached data and re-fetch
  window.addEventListener("lz:hl:net", () => {
    _rows         = [];
    _filtered     = [];
    _sparkCache.clear();
    _sparkFetching.clear();
    if (_tableEl) _tableEl.innerHTML = buildSkeleton(8);
    if (_isOpen) fetchData();
  });

  // route changes — start/stop polling when the trade view is entered/left
  window.addEventListener("lz:route", e => {
    const route = e?.detail?.route;
    if (route === "trade"){
      if (_isOpen) startPolling();
    } else {
      stopPolling();
    }
  });
}

/* ── init ───────────────────────────────────────────────────────────── */

(function initHlMarkets(){
  const mount = document.getElementById("hlMarketsMount");
  if (!mount) return;

  buildPanel();
  bindEvents();

  // do a silent initial fetch so the count badge populates even when collapsed
  fetchData().then(() => {
    _lastUpd = Date.now();
    updateCount();
    updateFooter();
  });
})();
