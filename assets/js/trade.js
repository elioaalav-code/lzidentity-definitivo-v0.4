/* ============================================================ *
 *  trade.js — Hyperliquid Trading tab
 *
 *  Live market data (WebSocket: allMids · l2Book · trades · candle),
 *  a canvas candlestick chart, a live order book, real on-chain
 *  order placement (signed in hyperliquid.js), and positions/orders/
 *  balance polled from the user's clearinghouse state.
 * ============================================================ */

import * as HL from "./hyperliquid.js";
import { state, onChange, connectWallet, toast, fmt, shortAddr } from "./shared.js";
import { CustomSelect, coinAvatarHTML, skeleton, emptyState } from "./ui.js";

/* ─── module state ─────────────────────────────────────────── */

let active = false;          // is the Trading tab currently shown
let booted = false;          // one-time async boot done
let coin = "BTC";
let interval = "15m";
let szDecimals = 5;
let maxLeverage = 20;
let universe = [];           // [{name, szDecimals, maxLeverage}]
let ctxByCoin = {};          // coin -> asset ctx (mark, funding, oi, prevDayPx, dayNtlVlm)
let mids = {};               // coin -> mid (number)
let lastPx = null;           // last trade price (number)
let candles = [];            // [{t,o,h,l,c,v}]
let book = { bids: [], asks: [] };
let side = "buy";            // buy | sell
let otype = "market";        // market | limit
let posTab = "positions";
let userData = null;         // clearinghouse state
let userOrders = [];         // open orders
let hoverIdx = -1;
let prevLast = null;         // for the price-flash micro-interaction

let perCoinUnsubs = [];      // ws unsubscribe fns for coin-scoped subs
let midsUnsub = null;
let userPollTimer = null, ctxTimer = null;

let marketSelect = null;     // CustomSelect instance over #hlCoin
let firstUserPoll = true;    // show a skeleton until the first poll lands
let lastListRefresh = 0;     // throttle marketSelect.refresh() on allMids ticks

const INTERVAL_MS = { "1m":60e3, "5m":300e3, "15m":900e3, "1h":3600e3, "4h":14400e3, "1d":86400e3 };

/* ─── curated sector map ────────────────────────────────────────
 * Hyperliquid's API exposes no categories or icons, so we maintain a
 * static symbol→sector map. Anything unmapped falls into "Others".
 * Favorites (★, localStorage) and a computed "Top volume" group are
 * injected dynamically at build time and always sort first.            */
const SECTORS = {
  Majors:   ["BTC","ETH","SOL","BNB","XRP","DOGE"],
  "Layer 1":["APT","SUI","AVAX","NEAR","TIA","SEI","ADA","DOT","ATOM","INJ","FTM","KAS","TON","TRX","ALGO","HBAR","EGLD","FLOW","KAVA","ROSE","CELO","XLM"],
  "Layer 2":["ARB","OP","MATIC","STRK","ZK","MANTA","METIS","BLAST","MODE","SCR","TAIKO","ZRO"],
  DeFi:     ["AAVE","UNI","LDO","MKR","CRV","ENA","PENDLE","COMP","SNX","SUSHI","DYDX","GMX","JUP","RUNE","CAKE","MORPHO","ETHFI","EIGEN"],
  AI:       ["FET","RENDER","TAO","WLD","AI16Z","GRASS","NEAR","ARC","VIRTUAL","IO","AKT","NMR","GOAT","ZEREBRO","AIXBT","GRIFFAIN"],
  Memecoins:["WIF","PEPE","BONK","FLOKI","POPCAT","MEW","SHIB","BRETT","MOG","TRUMP","NEIRO","PNUT","CHILLGUY","MOODENG","TURBO","DOGE","SPX","FARTCOIN","PENGU","kPEPE","kBONK","kSHIB","kFLOKI","kNEIRO"],
};
const SECTOR_OF = (() => {
  const m = {};
  // later groups don't override an earlier assignment (Majors wins ties)
  for (const [sector, list] of Object.entries(SECTORS))
    for (const sym of list) if (!(sym in m)) m[sym] = sector;
  return m;
})();
const GROUP_ORDER = ["Favorites","Top volume","Majors","Layer 1","Layer 2","DeFi","AI","Memecoins","Others"];

/* ─── favorites (localStorage) ──────────────────────────────────── */
const FAV_KEY = "lz.hl.favorites";
function loadFavs(){
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
  catch { return new Set(); }
}
let favorites = loadFavs();
function saveFavs(){ try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch {} }
function toggleFav(sym){
  if (favorites.has(sym)) favorites.delete(sym); else favorites.add(sym);
  saveFavs();
}

/* ─── tiny DOM helpers ─────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

/* ─── number formatting ────────────────────────────────────── */
function pxStr(n){
  n = Number(n);
  if (!isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1)    return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
const usd = (n) => fmt.usd(Number(n));
const compact = (n) => fmt.compact(Number(n));
const pct = (n) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";

/* ─── boot (first time the tab is shown) ───────────────────── */
async function boot(){
  if (booted) return;
  booted = true;
  // verify the order-signing path matches the official SDK byte-for-byte
  try {
    const t = HL.selfTest();
    console.log(`%c[HL] order-signing self-test: ${t.ok ? "PASS ✓" : "FAIL ✗"}`,
      `color:${t.ok ? "#86efac" : "#fda4af"};font-family:monospace`);
    if (!t.ok) console.warn("[HL] self-test mismatch", t);
  } catch (e){ console.warn("[HL] self-test could not run", e); }

  try {
    const m = await HL.meta();
    universe = m.universe;
    const sel = $("hlCoin");
    if (sel){
      sel.innerHTML = universe.map(u => `<option${u.name===coin?" selected":""}>${u.name}</option>`).join("");
    }
    applyCoinMeta();
    await refreshCtxs();
    initMarketSelect();      // build the rich switcher (after ctxs so volume/price are present)
    await loadCandles();
    await loadBook();
  } catch (e){
    console.error("[HL] boot failed", e);
    toast("hyperliquid data unavailable — check connection", "err");
  }
}

function applyCoinMeta(){
  const u = universe.find(x => x.name === coin);
  if (u){ szDecimals = u.szDecimals; maxLeverage = u.maxLeverage || 20; }
  const lev = $("hlLev");
  if (lev){ lev.max = String(maxLeverage); if (Number(lev.value) > maxLeverage){ lev.value = String(Math.min(5, maxLeverage)); } }
  $("hlLevVal").textContent = $("hlLev").value + "×";
  $("hlSzUnit").textContent = coin;
  renderLev();
}

/* ─── leverage slider visuals (gradient fill + value bubble) ───── */
function renderLev(){
  const lev = $("hlLev");
  if (!lev) return;
  const min = Number(lev.min) || 1, max = Number(lev.max) || maxLeverage;
  const v = Number(lev.value);
  const frac = max > min ? (v - min) / (max - min) : 0;
  lev.style.setProperty("--lev-fill", (frac * 100).toFixed(1) + "%");
  const bubble = $("hlLevBubble");
  if (bubble){
    bubble.textContent = v + "×";
    // keep the bubble centred over the thumb (thumb is 16px wide)
    bubble.style.left = `calc(${(frac * 100).toFixed(1)}% + ${(8 - frac * 16).toFixed(1)}px)`;
  }
  const valEl = $("hlLevVal");
  if (valEl) valEl.textContent = v + "×";
}

/* ─── market switcher (CustomSelect over #hlCoin) ──────────────── */

// live mid for a coin, falling back to ctx mark.
function midOf(name){
  const m = mids[name];
  if (m != null && isFinite(m)) return m;
  const c = ctxByCoin[name];
  return c ? Number(c.markPx) : NaN;
}
function volOf(name){ const c = ctxByCoin[name]; return c ? Number(c.dayNtlVlm) || 0 : 0; }
function changeOf(name){
  const c = ctxByCoin[name];
  const px = midOf(name);
  if (!c || !isFinite(px) || !Number(c.prevDayPx)) return null;
  return (px - Number(c.prevDayPx)) / Number(c.prevDayPx) * 100;
}

// Build the rich items array consumed by CustomSelect. Each item carries
// the static fields; live price / change / volume are read fresh in
// renderRow so refresh() reflects ticks without rebuilding the array.
function buildMarketItems(){
  // top-6 by 24h notional volume
  const topVol = universe.slice()
    .sort((a, b) => volOf(b.name) - volOf(a.name))
    .slice(0, 6).map(u => u.name);
  const topSet = new Set(topVol);
  return universe.map(u => {
    const name = u.name;
    let group;
    if (favorites.has(name)) group = "Favorites";
    else if (topSet.has(name)) group = "Top volume";
    else group = SECTOR_OF[name] || "Others";
    return {
      value: name, label: name, group,
      sector: SECTOR_OF[name] || "Perp",
      maxLev: u.maxLeverage || 20,
      _vol: volOf(name),           // snapshot for in-group sort
    };
  }).sort((a, b) => b._vol - a._vol);  // volume desc within every group
}

function changeChipHTML(ch){
  if (ch == null || !isFinite(ch)) return `<span class="mk-chip">—</span>`;
  return `<span class="mk-chip ${ch >= 0 ? "up" : "dn"}">${pct(ch)}</span>`;
}

function marketRowHTML(it){
  const px = midOf(it.value);
  const ch = changeOf(it.value);
  const fav = favorites.has(it.value);
  return `<span class="mk-av">${coinAvatarHTML(it.value, 28)}</span>
    <span class="mk-id">
      <span class="mk-sym">${it.value}</span>
      <span class="mk-tag">${it.sector}</span>
    </span>
    <span class="mk-meta">
      <span class="mk-px">${isFinite(px) ? pxStr(px) : "—"}</span>
      ${changeChipHTML(ch)}
    </span>
    <span class="mk-lev">${it.maxLev}×</span>
    <span class="mk-vol">${it._vol ? compact(it._vol) : "—"}</span>
    <button type="button" class="mk-star${fav ? " on" : ""}" data-star="${it.value}"
      aria-pressed="${fav}" aria-label="${fav ? "Unstar" : "Star"} ${it.value}" tabindex="-1">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.6l2.5 5.1 5.6.8-4 3.9.95 5.6L12 16.4 6.95 19l.95-5.6-4-3.9 5.6-.8z" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
    </button>`;
}

function marketTriggerHTML(it){
  const px = midOf(it.value);
  const ch = changeOf(it.value);
  // the chevron is provided by CustomSelect outside the trig body, so we
  // don't add one here (avoids a duplicate caret).
  return `<span class="mk-trig-av">${coinAvatarHTML(it.value, 30)}</span>
    <span class="mk-trig-sym">${it.value}</span>
    <span class="mk-trig-px" id="hlTrigPx">${isFinite(px) ? pxStr(px) : "—"}</span>
    ${changeChipHTML(ch)}`;
}

function initMarketSelect(){
  const sel = $("hlCoin");
  if (!sel || marketSelect) return;
  marketSelect = new CustomSelect({
    select: sel,
    items: buildMarketItems(),
    groupOrder: GROUP_ORDER,
    searchable: true,
    searchKeys: ["value", "sector"],
    title: "Select market",
    bottomSheet: true,
    renderRow: marketRowHTML,
    renderTrigger: marketTriggerHTML,
  });
  // star toggles inside the list: stop the row-select, flip favorite,
  // rebuild groups so the coin hops into / out of Favorites live.
  marketSelect.el.list.addEventListener("click", (e) => {
    const star = e.target.closest(".mk-star");
    if (!star) return;
    e.stopPropagation();
    e.preventDefault();
    toggleFav(star.dataset.star);
    marketSelect.setItems(buildMarketItems());
  }, true);
}

// Rebuild the items (groups can shift as volume moves) then refresh the
// open list + trigger. Cheap enough for the 10s ctx cadence. Don't rebuild
// mid-search (it would reset scroll/active row under the user's cursor) —
// just refresh prices in place instead.
function refreshMarketItems(){
  if (!marketSelect) return;
  const searching = marketSelect.open_ && marketSelect.el.input && marketSelect.el.input.value.trim();
  if (searching){ marketSelect.refresh(); return; }
  marketSelect.setItems(buildMarketItems());   // setItems calls refresh()
}

/* ─── activate / deactivate on route change ────────────────── */
async function activate(){
  if (active) return;
  active = true;
  await boot();
  subscribeMarket();
  ctxTimer = setInterval(refreshCtxs, 10_000);
  startUserPolling();
  requestAnimationFrame(drawChart);
}
function deactivate(){
  if (!active) return;
  active = false;
  unsubscribeMarket();
  clearInterval(ctxTimer); ctxTimer = null;
  stopUserPolling();
}

/* ─── websocket subscriptions ──────────────────────────────── */
function subscribeMarket(){
  if (!midsUnsub){
    midsUnsub = HL.ws.subscribe({ type: "allMids" });
  }
  subscribeCoin();
}
function unsubscribeMarket(){
  perCoinUnsubs.forEach(fn => fn && fn());
  perCoinUnsubs = [];
  if (midsUnsub){ midsUnsub(); midsUnsub = null; }
}
function subscribeCoin(){
  perCoinUnsubs.forEach(fn => fn && fn());
  perCoinUnsubs = [
    HL.ws.subscribe({ type: "l2Book", coin }),
    HL.ws.subscribe({ type: "trades", coin }),
    HL.ws.subscribe({ type: "candle", coin, interval }),
  ];
}

HL.on("ws:allMids", (data) => {
  if (!data || !data.mids) return;
  mids = Object.assign(mids, Object.fromEntries(Object.entries(data.mids).map(([k,v]) => [k, Number(v)])));
  if (lastPx == null && mids[coin]) { lastPx = mids[coin]; renderSymbol(); }
  // keep the switcher's prices live, throttled to ~1/sec while it's open
  if (marketSelect){
    updateTriggerPx();
    const now = Date.now();
    if (marketSelect.open_ && now - lastListRefresh > 1000){
      lastListRefresh = now;
      marketSelect.refresh();
    }
  }
});

// Light-touch trigger price update (avoids a full re-render on every tick).
function updateTriggerPx(){
  const px = midOf(coin);
  const el = $("hlTrigPx");
  if (el) el.textContent = isFinite(px) ? pxStr(px) : "—";
}
HL.on("ws:l2Book", (data) => {
  if (!data || data.coin !== coin || !data.levels) return;
  book = { bids: data.levels[0] || [], asks: data.levels[1] || [] };
  if (active) renderBook();
});
HL.on("ws:trades", (data) => {
  if (!Array.isArray(data) || !data.length) return;
  const t = data.filter(x => x.coin === coin).pop();
  if (t){ lastPx = Number(t.px); renderSymbol(); }
});
HL.on("ws:candle", (c) => {
  if (!c || c.s !== coin || c.i !== interval) return;
  const k = { t: c.t, o:+c.o, h:+c.h, l:+c.l, c:+c.c, v:+c.v };
  const last = candles[candles.length - 1];
  if (last && last.t === k.t) candles[candles.length - 1] = k;
  else candles.push(k);
  if (candles.length > 400) candles.shift();
  if (active) drawChart();
});

/* ─── data loads (REST) ────────────────────────────────────── */
async function refreshCtxs(){
  try {
    const [m, ctxs] = await HL.metaAndCtxs();
    universe = m.universe;
    ctxByCoin = {};
    m.universe.forEach((u, i) => { ctxByCoin[u.name] = ctxs[i]; });
    renderStats();
    renderSymbol();
    refreshMarketItems();           // groups/volume/price reflect the fresh ctx
  } catch (e){ /* keep last */ }
}
async function loadCandles(){
  const end = Date.now();
  const start = end - 200 * (INTERVAL_MS[interval] || 9e5);
  const data = await HL.candleSnapshot(coin, interval, start, end);
  candles = (data || []).map(c => ({ t:c.t, o:+c.o, h:+c.h, l:+c.l, c:+c.c, v:+c.v }));
  if (active) drawChart();
}
async function loadBook(){
  try {
    const data = await HL.l2Book(coin);
    if (data && data.levels) book = { bids: data.levels[0] || [], asks: data.levels[1] || [] };
    if (active) renderBook();
  } catch {}
}

/* ─── render: symbol header + stats ────────────────────────── */
function renderSymbol(){
  const px = lastPx ?? mids[coin];
  const lastEl = $("hlLast");
  lastEl.textContent = px != null ? pxStr(px) : "—";
  if (px != null && prevLast != null && px !== prevLast){
    lastEl.classList.remove("flash-up", "flash-dn");
    void lastEl.offsetWidth;                 // restart the animation
    lastEl.classList.add(px > prevLast ? "flash-up" : "flash-dn");
  }
  if (px != null) prevLast = px;
  const ctx = ctxByCoin[coin];
  const prev = ctx ? Number(ctx.prevDayPx) : null;
  const chEl = $("hlChange");
  if (px != null && prev){
    const ch = (px - prev) / prev * 100;
    chEl.textContent = pct(ch);
    chEl.className = "ch " + (ch >= 0 ? "up" : "dn");
  } else { chEl.textContent = "—"; chEl.className = "ch"; }
  renderNotional();
}
function renderStats(){
  const ctx = ctxByCoin[coin];
  if (!ctx) return;
  $("hlMark").textContent   = pxStr(ctx.markPx);
  $("hlOracle").textContent = pxStr(ctx.oraclePx);
  const f = Number(ctx.funding) * 100;
  const fe = $("hlFunding");
  fe.textContent = (f >= 0 ? "+" : "−") + Math.abs(f).toFixed(4) + "%";
  fe.className = "v " + (f >= 0 ? "up" : "dn");
  $("hlOI").textContent  = usd(Number(ctx.openInterest) * Number(ctx.markPx));
  $("hlVol").textContent = usd(Number(ctx.dayNtlVlm));
}

/* ─── render: order book ───────────────────────────────────── */
// Reconcile a book side into its container, reusing rows so the depth
// bars can animate their width instead of snapping on every tick.
function renderBookSide(el, levels, kind, maxSz, total){
  let running = 0;
  const want = levels.length;
  // trim extra rows
  while (el.children.length > want) el.lastChild.remove();
  for (let i = 0; i < want; i++){
    const l = levels[i];
    const sz = +l.sz;
    running += sz;
    const depth = Math.min(100, (sz / maxSz) * 100);
    const cum = Math.min(100, (running / Math.max(1e-9, total)) * 100);
    let row = el.children[i];
    if (!row){
      row = document.createElement("div");
      row.className = `lvl ${kind}`;
      row.innerHTML = `<i></i><span class="p"></span><span class="s"></span>`;
      el.appendChild(row);
    }
    row.dataset.px = l.px;
    row.style.setProperty("--depth", depth + "%");
    row.style.setProperty("--cum", cum + "%");
    const p = row.children[1], s = row.children[2];
    const pxNew = pxStr(l.px);
    if (p.textContent !== pxNew) p.textContent = pxNew;
    s.textContent = (sz).toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
}

let prevBookMid = null;
function renderBook(){
  const N = 11;
  const asks = book.asks.slice(0, N);
  const bids = book.bids.slice(0, N);
  const maxSz = Math.max(1e-9, ...asks.map(l => +l.sz), ...bids.map(l => +l.sz));
  const askTot = asks.reduce((a, l) => a + +l.sz, 0);
  const bidTot = bids.reduce((a, l) => a + +l.sz, 0);
  // asks render top→bottom as best-ask-at-bottom (reversed)
  renderBookSide($("hlAsks"), asks.slice().reverse(), "ask", maxSz, askTot);
  renderBookSide($("hlBids"), bids, "bid", maxSz, bidTot);
  const bestAsk = asks[0] ? +asks[0].px : null;
  const bestBid = bids[0] ? +bids[0].px : null;
  if (bestAsk && bestBid){
    const mid = (bestAsk + bestBid) / 2;
    const spread = bestAsk - bestBid;
    const midEl = $("hlBookMid");
    midEl.textContent = pxStr(mid);
    if (prevBookMid != null && mid !== prevBookMid){
      midEl.classList.remove("up", "dn");
      void midEl.offsetWidth;
      midEl.classList.add(mid > prevBookMid ? "up" : "dn");
    }
    prevBookMid = mid;
    $("hlSpread").textContent = `${pxStr(spread)} · ${(spread/mid*1e4).toFixed(1)} bps`;
  }
}
// click a level → prefill limit price (delegated once; survives reconciles)
function wireBookClicks(){
  const handler = (e) => {
    const el = e.target.closest(".lvl");
    if (!el || !el.dataset.px) return;
    setType("limit");
    $("hlPrice").value = el.dataset.px;
    renderNotional();
    el.classList.remove("picked"); void el.offsetWidth; el.classList.add("picked");
  };
  on($("hlAsks"), "click", handler);
  on($("hlBids"), "click", handler);
}

/* ─── render: candlestick chart (canvas) ───────────────────── */
const cv = $("hlChart");
const ctx2d = cv ? cv.getContext("2d") : null;
let chartW = 0, chartH = 0;
let hoverY = -1;             // cursor y within the canvas (for the crosshair price tag)

// resolve brand tokens once so the canvas stays on-palette.
const CHART_COL = (() => {
  const cs = getComputedStyle(document.documentElement);
  const g = (k, fb) => (cs.getPropertyValue(k).trim() || fb);
  return {
    long:  g("--long", "#3fb98a"),
    short: g("--short", "#e0556b"),
    accent:g("--accent", "#b39aff"),
    ink:   "#0a0a0c",
  };
})();
const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function sizeCanvas(){
  if (!cv) return;
  const wrap = cv.parentElement;
  const r = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  chartW = Math.max(320, r.width);
  chartH = Math.max(260, r.height);
  cv.width = chartW * dpr; cv.height = chartH * dpr;
  cv.style.width = chartW + "px"; cv.style.height = chartH + "px";
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawChart(){
  if (!ctx2d) return;
  sizeCanvas();
  const g = ctx2d;
  g.clearRect(0, 0, chartW, chartH);
  if (!candles.length) return;

  const padR = 64, padB = 22, padT = 10, padL = 8;
  const plotW = chartW - padR - padL, plotH = chartH - padB - padT;
  const view = candles.slice(-Math.min(candles.length, 120));
  const n = view.length;
  let lo = Infinity, hi = -Infinity;
  for (const c of view){ lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad; hi += pad;
  const yOf = (p) => padT + (hi - p) / (hi - lo) * plotH;
  const cw = plotW / n;
  const bodyW = Math.max(1, Math.min(14, cw * 0.62));

  // grid + price axis
  g.font = "10px 'Geist Mono', monospace";
  g.textBaseline = "middle";
  const lines = 5;
  for (let i = 0; i <= lines; i++){
    const p = hi - (hi - lo) * (i / lines);
    const y = yOf(p);
    g.strokeStyle = "rgba(255,255,255,.05)";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
    g.fillStyle = "rgba(160,160,168,.8)";
    g.textAlign = "left";
    g.fillText(pxStr(p), padL + plotW + 6, y);
  }

  // time axis (a few evenly-spaced labels along the bottom)
  const spanMs = INTERVAL_MS[interval] || 9e5;
  const intraday = spanMs < 86400e3;
  const ticks = Math.min(6, n);
  g.fillStyle = "rgba(160,160,168,.7)"; g.textBaseline = "alphabetic";
  for (let i = 0; i < ticks; i++){
    const idx = Math.round((i / (ticks - 1 || 1)) * (n - 1));
    const c = view[idx];
    if (!c) continue;
    const x = padL + idx * cw + cw / 2;
    g.textAlign = i === 0 ? "left" : (i === ticks - 1 ? "right" : "center");
    const lab = intraday ? TIME_FMT.format(c.t) : DATE_FMT.format(c.t);
    g.fillText(lab, Math.max(padL, Math.min(padL + plotW, x)), chartH - 7);
  }

  // candles
  for (let i = 0; i < n; i++){
    const c = view[i];
    const x = padL + i * cw + cw / 2;
    const up = c.c >= c.o;
    const col = up ? CHART_COL.long : CHART_COL.short;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, yOf(c.h)); g.lineTo(x, yOf(c.l)); g.stroke();
    const yO = yOf(c.o), yC = yOf(c.c);
    const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
    g.fillRect(x - bodyW / 2, top, bodyW, h);
  }

  // helper: a pill-shaped price tag in the right gutter
  const priceTag = (y, text, bg, fg) => {
    const ty = Math.max(padT + 8, Math.min(padT + plotH - 8, y));
    g.fillStyle = bg; g.fillRect(padL + plotW, ty - 8, padR, 16);
    g.fillStyle = fg; g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(text, padL + plotW + 6, ty);
  };

  // last price line + tag
  const lastC = view[n - 1];
  if (lastC){
    const lp = lastPx ?? lastC.c;
    const y = yOf(lp);
    g.strokeStyle = "rgba(179,154,255,.55)"; g.lineWidth = 1;
    g.setLineDash([4, 4]); g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
    priceTag(y, pxStr(lp), CHART_COL.accent, CHART_COL.ink);
  }

  // crosshair (vertical + horizontal) + OHLC readout + price tag at cursor
  const ro = $("hlReadout");
  if (hoverIdx >= 0 && hoverIdx < n){
    const c = view[hoverIdx];
    const x = padL + hoverIdx * cw + cw / 2;
    g.strokeStyle = "rgba(255,255,255,.2)"; g.lineWidth = 1; g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + plotH); g.stroke();
    if (hoverY >= padT && hoverY <= padT + plotH){
      g.beginPath(); g.moveTo(padL, hoverY); g.lineTo(padL + plotW, hoverY); g.stroke();
      const pAt = hi - (hoverY - padT) / plotH * (hi - lo);
      priceTag(hoverY, pxStr(pAt), "rgba(20,20,26,.96)", "#e8e8ee");
    }
    g.setLineDash([]);
    // time tag for the hovered candle
    g.fillStyle = "rgba(20,20,26,.96)";
    const lab = intraday ? TIME_FMT.format(c.t) : DATE_FMT.format(c.t);
    const tw = g.measureText(lab).width + 14;
    let tx = Math.max(padL, Math.min(padL + plotW - tw, x - tw / 2));
    g.fillRect(tx, chartH - 17, tw, 15);
    g.fillStyle = "#e8e8ee"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(lab, tx + tw / 2, chartH - 9.5);
    if (ro){
      const up = c.c >= c.o;
      const dv = ((c.c - c.o) / c.o * 100);
      ro.innerHTML = `<span class="${up?'up':'dn'}">O ${pxStr(c.o)} · H ${pxStr(c.h)} · L ${pxStr(c.l)} · C ${pxStr(c.c)} · ${pct(dv)}</span>`;
    }
  } else if (ro){ ro.textContent = ""; }
}
if (cv){
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const padL = 8, padR = 64;
    const plotW = chartW - padR - padL;
    const view = Math.min(candles.length, 120);
    const cw = plotW / view;
    const idx = Math.floor((e.clientX - r.left - padL) / cw);
    hoverIdx = (idx >= 0 && idx < view) ? idx : -1;
    hoverY = e.clientY - r.top;
    drawChart();
  });
  cv.addEventListener("mouseleave", () => { hoverIdx = -1; hoverY = -1; drawChart(); });
  new ResizeObserver(() => { if (active) drawChart(); }).observe(cv.parentElement);
}

/* ─── order ticket ─────────────────────────────────────────── */
function setSide(s){
  side = s;
  const wrap = $("hlSide");
  if (wrap) wrap.dataset.on = s;              // drives the sliding indicator (CSS)
  document.querySelectorAll("#hlSide button").forEach(b => b.classList.toggle("on", b.dataset.side === s));
  updateSubmitLabel();
}
function setType(t){
  otype = t;
  const wrap = $("hlType");
  if (wrap) wrap.dataset.on = t;              // drives the sliding indicator (CSS)
  document.querySelectorAll("#hlType button").forEach(b => b.classList.toggle("on", b.dataset.type === t));
  $("hlPriceField").hidden = t !== "limit";
  renderNotional();
}
function ticketPrice(){
  if (otype === "limit") return Number($("hlPrice").value);
  return lastPx ?? mids[coin] ?? (ctxByCoin[coin] ? +ctxByCoin[coin].markPx : NaN);
}
function renderNotional(){
  const sz = Number($("hlSize").value);
  const px = ticketPrice();
  const el = $("hlNotional");
  if (sz > 0 && isFinite(px) && px > 0) el.textContent = usd(sz * px);
  else el.textContent = "—";
}
function updateSubmitLabel(){
  const btn = $("hlSubmit");
  if (btn.dataset.busy === "1") return;            // don't clobber the placing micro-state
  if (!state.account){ btn.textContent = "Connect wallet"; btn.className = "btn accent ticket-submit"; return; }
  const verb = side === "buy" ? "Buy" : "Sell";
  btn.textContent = `${verb} ${coin} · ${otype}`;
  btn.className = "btn ticket-submit " + (side === "buy" ? "long" : "short");
}

/* ─── size quick-chips ─────────────────────────────────────────── */
// Withdrawable USD × leverage = buying power; chip% of that ÷ price = size.
function buyingPower(){
  const wd = Number(userData?.withdrawable);
  if (!isFinite(wd) || wd <= 0) return NaN;
  const lev = Number($("hlLev")?.value) || 1;
  return wd * lev;
}
function applySizeChip(pct){
  const bp = buyingPower();
  const px = ticketPrice();
  if (!isFinite(bp) || !isFinite(px) || px <= 0){
    toast(state.account ? "no withdrawable balance" : "connect a wallet first", "err");
    return;
  }
  const frac = pct === "max" ? 0.995 : Number(pct) / 100;   // tiny buffer on Max
  const sz = (bp * frac) / px;
  const dp = Math.max(0, Math.min(8, szDecimals));
  $("hlSize").value = sz > 0 ? sz.toFixed(dp) : "";
  renderNotional();
  const chips = $("hlSizeChips");
  if (chips) chips.querySelectorAll("button").forEach(b =>
    b.classList.toggle("on", b.dataset.pct === pct));
}
function updateSizeChipState(){
  const chips = $("hlSizeChips");
  if (!chips) return;
  const has = isFinite(buyingPower());
  chips.classList.toggle("disabled", !has);
  chips.querySelectorAll("button").forEach(b => { b.disabled = !has; b.classList.remove("on"); });
}

async function onSubmit(){
  if (!state.account){
    try { await connectWallet(); } catch { toast("connect rejected", "err"); }
    return;
  }
  const sz = Number($("hlSize").value);
  if (!(sz > 0)){ toast("enter a size", "err"); return; }
  const px = ticketPrice();
  if (otype === "limit" && !(px > 0)){ toast("enter a limit price", "err"); return; }
  const reduceOnly = $("hlReduce").checked;
  openReview({ coin, side, otype, sz, px, reduceOnly });
}

/* ─── review modal ─────────────────────────────────────────── */
let pendingOrder = null;
function openReview(o){
  pendingOrder = o;
  const notional = o.sz * o.px;
  const isMain = HL.isMainnet();
  $("hlReview").innerHTML = `
    <div class="rv-row"><span>Market</span><b>${o.coin}-PERP</b></div>
    <div class="rv-row"><span>Side</span><b class="${o.side==='buy'?'long':'short'}">${o.side==='buy'?'Buy / Long':'Sell / Short'}</b></div>
    <div class="rv-row"><span>Type</span><b>${o.otype==='market'?'Market (IOC)':'Limit (GTC)'}</b></div>
    <div class="rv-row"><span>Size</span><b>${o.sz} ${o.coin}</b></div>
    <div class="rv-row"><span>${o.otype==='market'?'Est. price':'Limit price'}</span><b>${pxStr(o.px)}${o.otype==='market'?' <em>±5% slippage</em>':''}</b></div>
    <div class="rv-row"><span>Notional</span><b>${usd(notional)}</b></div>
    ${o.reduceOnly ? `<div class="rv-row"><span>Flag</span><b>Reduce only</b></div>` : ``}`;
  $("hlModalNet").className = "hl-modal-net " + (isMain ? "main" : "test");
  $("hlModalNet").innerHTML = isMain
    ? `⚠ <b>Mainnet</b> — this signs a real order with real funds.`
    : `<b>Testnet</b> — paper funds. Signs against the Hyperliquid testnet.`;
  $("hlModal").hidden = false;
}
function closeReview(){ $("hlModal").hidden = true; pendingOrder = null; }
async function confirmOrder(){
  if (!pendingOrder) return;
  const o = pendingOrder;
  const btn = $("hlConfirm");
  const submit = $("hlSubmit");
  btn.disabled = true; btn.dataset.state = "signing";
  btn.innerHTML = `<span class="bt-spin" aria-hidden="true"></span>Sign in wallet…`;
  if (submit){ submit.dataset.busy = "1"; submit.classList.add("is-signing"); submit.textContent = "Sign in wallet…"; }
  try {
    await HL.placeOrder({
      account: state.account, coin: o.coin, isBuy: o.side === "buy",
      sz: o.sz, px: o.px, type: o.otype, reduceOnly: o.reduceOnly,
    });
    btn.dataset.state = "placed";
    btn.innerHTML = `<span class="bt-check" aria-hidden="true">✓</span>Order placed`;
    if (submit){ submit.classList.remove("is-signing"); submit.classList.add("is-placed"); submit.textContent = "Order placed ✓"; }
    toast(`order placed · ${o.side} ${o.sz} ${o.coin}`, "ok");
    $("hlSize").value = "";
    renderNotional();
    setTimeout(() => {
      closeReview();
      if (submit){ submit.dataset.busy = ""; submit.classList.remove("is-placed"); updateSubmitLabel(); }
    }, 850);
    setTimeout(pollUser, 600);
  } catch (e){
    toast("order rejected · " + (e?.message || e), "err", 4500);
    if (submit){ submit.dataset.busy = ""; submit.classList.remove("is-signing","is-placed"); updateSubmitLabel(); }
  } finally {
    btn.disabled = false;
    if (btn.dataset.state !== "placed"){ btn.dataset.state = ""; btn.textContent = "Sign & place ▸"; }
    setTimeout(() => { if (btn.dataset.state === "placed"){ btn.dataset.state = ""; btn.textContent = "Sign & place ▸"; } }, 900);
  }
}

/* ─── leverage ─────────────────────────────────────────────── */
async function applyLeverage(){
  if (!state.account){ toast("connect a wallet first", "err"); return; }
  const lev = Number($("hlLev").value);
  const btn = $("hlLevApply");
  btn.disabled = true;
  try {
    await HL.updateLeverage({ account: state.account, coin, leverage: lev, isCross: true });
    toast(`leverage set · ${lev}× cross on ${coin}`, "ok");
  } catch (e){
    toast("leverage update failed · " + (e?.message || e), "err", 4000);
  } finally { btn.disabled = false; }
}

/* ─── user data (positions / orders / balance) ─────────────── */
function startUserPolling(){
  stopUserPolling();
  if (!state.account) { firstUserPoll = true; renderPositions(); return; }
  firstUserPoll = true;
  renderPositions();          // paints a skeleton while the first poll is in flight
  pollUser();
  userPollTimer = setInterval(pollUser, 4500);
}
function stopUserPolling(){ clearInterval(userPollTimer); userPollTimer = null; }
async function pollUser(){
  if (!state.account){ userData = null; userOrders = []; renderPositions(); return; }
  try {
    const [ch, oo] = await Promise.all([HL.clearinghouse(state.account), HL.openOrders(state.account)]);
    userData = ch; userOrders = oo || [];
    firstUserPoll = false;
    renderPositions();
    updateSizeChipState();
  } catch (e){ firstUserPoll = false; renderPositions(); }
}
const ICON_WALLET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/></svg>`;
const ICON_POS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8M21 8v4h-4"/></svg>`;
const ICON_ORDERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`;

// emptyState(...) returns an element; swap it into the body cleanly.
function paintEmpty(body, opts){ body.replaceChildren(emptyState(opts)); }

/* jump the terminal to a coin's market (used by clickable position rows) */
function goToMarket(c){
  const sel = $("hlCoin");
  if (!sel) return;
  if (![...sel.options].some(o => o.value === c)){ toast(`${c} isn’t listed on Hyperliquid`, "err"); return; }
  if (sel.value !== c){ sel.value = c; sel.dispatchEvent(new Event("change")); }
  if (marketSelect) marketSelect.setValue(c);
  document.querySelector(".trade-top")?.scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`market · ${c}`, "ok");
}

function renderPositions(){
  const body = $("hlPosBody");
  if (!state.account){
    paintEmpty(body, {
      icon: ICON_WALLET,
      title: "No wallet connected",
      body: "Connect a wallet to see your positions, open orders and account balance.",
      actionLabel: "Connect wallet",
      onAction: () => connectWallet().catch(() => toast("connect rejected", "err")),
    });
    return;
  }
  if (firstUserPoll && !userData){ body.innerHTML = skeleton({ rows: 4, height: 38 }); return; }
  if (posTab === "positions"){
    const pos = (userData?.assetPositions || []).filter(p => Number(p.position.szi) !== 0);
    if (!pos.length){
      paintEmpty(body, { icon: ICON_POS, title: "No open positions",
        body: `You have no open positions on ${HL.getNetwork()}.` });
      return;
    }
    body.innerHTML = `<div class="pos-table">
      <div class="pt-head"><span>Coin</span><span>Side</span><span>Size</span><span>Entry</span><span>uPnL</span><span>Liq.</span></div>
      ${pos.map(p => {
        const s = Number(p.position.szi);
        const pnl = Number(p.position.unrealizedPnl);
        return `<div class="pt-row is-pickable" data-go-coin="${p.position.coin}" role="button" tabindex="0" aria-label="Open ${p.position.coin} market">
          <span class="c">${p.position.coin}</span>
          <span class="${s>0?'long':'short'}">${s>0?'Long':'Short'}</span>
          <span>${Math.abs(s)}</span>
          <span>${pxStr(p.position.entryPx)}</span>
          <span class="${pnl>=0?'long':'short'}">${pnl>=0?'+':'−'}${usd(Math.abs(pnl))}</span>
          <span>${p.position.liquidationPx ? pxStr(p.position.liquidationPx) : '—'}</span>
        </div>`;
      }).join("")}
    </div>`;
    body.querySelectorAll(".pt-row[data-go-coin]").forEach(r => {
      const go = () => goToMarket(r.dataset.goCoin);
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); } });
    });
  } else if (posTab === "orders"){
    if (!userOrders.length){
      paintEmpty(body, { icon: ICON_ORDERS, title: "No open orders",
        body: "Resting limit orders you place will appear here." });
      return;
    }
    body.innerHTML = `<div class="pos-table orders">
      <div class="pt-head"><span>Coin</span><span>Side</span><span>Size</span><span>Price</span><span></span></div>
      ${userOrders.map(o => `<div class="pt-row">
        <span class="c">${o.coin}</span>
        <span class="${o.side==='B'?'long':'short'}">${o.side==='B'?'Buy':'Sell'}</span>
        <span>${o.sz}</span>
        <span>${pxStr(o.limitPx)}</span>
        <span><button class="btn ghost xs" data-cancel="${o.coin}:${o.oid}">Cancel</button></span>
      </div>`).join("")}
    </div>`;
    body.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => cancel(b.dataset.cancel)));
  } else {
    const ms = userData?.marginSummary || {};
    body.innerHTML = `<div class="acct-grid">
      <div class="acct"><span class="k">Account value</span><span class="v">${usd(ms.accountValue||0)}</span></div>
      <div class="acct"><span class="k">Withdrawable</span><span class="v">${usd(userData?.withdrawable||0)}</span></div>
      <div class="acct"><span class="k">Margin used</span><span class="v">${usd(ms.totalMarginUsed||0)}</span></div>
      <div class="acct"><span class="k">Position value</span><span class="v">${usd(ms.totalNtlPos||0)}</span></div>
      <div class="acct wide"><span class="k">Account · ${HL.getNetwork()}</span><span class="v mono">${shortAddr(state.account)}</span></div>
    </div>`;
  }
}
async function cancel(key){
  const [c, oid] = key.split(":");
  try {
    await HL.cancelOrder({ account: state.account, coin: c, oid: Number(oid) });
    toast(`order cancelled · ${c}`, "ok");
    setTimeout(pollUser, 500);
  } catch (e){ toast("cancel failed · " + (e?.message || e), "err", 4000); }
}

/* ─── network toggle ───────────────────────────────────────── */
function reflectNetwork(){
  const net = HL.getNetwork();
  document.querySelectorAll("#hlNetToggle button").forEach(b => b.classList.toggle("on", b.dataset.net === net));
  $("hlMainnetWarn").hidden = net !== "mainnet";
  $("hlSubtitle").textContent = `Hyperliquid perps · ${net}`;
}
function switchNetwork(net){
  if (net === HL.getNetwork()) return;
  if (net === "mainnet" && !confirm("Switch to Hyperliquid MAINNET? Orders you sign will use real funds.")) return;
  HL.setNetwork(net);
  reflectNetwork();
  // reset + reload all data on the new host
  ctxByCoin = {}; mids = {}; lastPx = null; candles = []; book = { bids:[], asks:[] };
  booted = false;
  (async () => {
    await boot();
    if (active){ unsubscribeMarket(); subscribeMarket(); }
    pollUser();
  })();
}

/* ─── wire static controls ─────────────────────────────────── */
function wire(){
  on($("hlCoin"), "change", async (e) => {
    coin = e.target.value;
    applyCoinMeta();
    lastPx = null; prevLast = null; candles = []; book = { bids:[], asks:[] };
    renderSymbol(); renderStats(); updateTriggerPx();
    updateSizeChipState();
    if (active){ subscribeCoin(); }
    await Promise.all([loadCandles(), loadBook()]);
    updateSubmitLabel();
  });
  $("hlIv").querySelectorAll("button").forEach(b => on(b, "click", async () => {
    interval = b.dataset.iv;
    $("hlIv").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    candles = [];
    if (active){ subscribeCoin(); }
    await loadCandles();
  }));
  $("hlSide").querySelectorAll("button").forEach(b => on(b, "click", () => setSide(b.dataset.side)));
  $("hlType").querySelectorAll("button").forEach(b => on(b, "click", () => setType(b.dataset.type)));
  on($("hlSize"), "input", () => {
    renderNotional();
    const chips = $("hlSizeChips");
    if (chips) chips.querySelectorAll("button.on").forEach(b => b.classList.remove("on"));
  });
  on($("hlPrice"), "input", () => { renderNotional(); updateTriggerPx(); });
  on($("hlLev"), "input", renderLev);
  on($("hlLevApply"), "click", applyLeverage);
  // size quick-chips (25/50/75/Max of withdrawable buying power at leverage)
  const chips = $("hlSizeChips");
  if (chips) chips.querySelectorAll("button").forEach(b => on(b, "click", () => applySizeChip(b.dataset.pct)));
  on($("hlSubmit"), "click", onSubmit);
  $("hlPosTabs").querySelectorAll("button").forEach(b => on(b, "click", () => {
    posTab = b.dataset.tab;
    $("hlPosTabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    renderPositions();
  }));
  document.querySelectorAll("#hlNetToggle button").forEach(b => on(b, "click", () => switchNetwork(b.dataset.net)));
  on($("hlCancel"), "click", closeReview);
  on($("hlConfirm"), "click", confirmOrder);
  on($("hlModal"), "click", (e) => { if (e.target === $("hlModal")) closeReview(); });

  onChange(() => { updateSubmitLabel(); updateSizeChipState(); if (active){ startUserPolling(); } });
  wireBookClicks();
  reflectNetwork();
  setSide("buy"); setType("market");
  renderLev();
  updateSizeChipState();
}

/* ─── route wiring ─────────────────────────────────────────── */
window.addEventListener("lz:route", (e) => {
  if (e.detail.route === "trade") activate();
  else deactivate();
});

wire();
// if the app deep-links straight to #/trade, activate now (the initial
// route event fired before this module's listener was attached).
if ((location.hash || "").replace(/^#\/?/, "").split("/")[0] === "trade") activate();

/* expose a couple of helpers for the AI copilot */
window.LZ = Object.assign(window.LZ || {}, {
  hl: {
    setCoin(c){
      const sel = $("hlCoin");
      if (!sel) return;
      sel.value = c;
      sel.dispatchEvent(new Event("change"));
      if (marketSelect) marketSelect.setValue(c);   // reflect into the rich trigger
    },
    prefillOrder({ side: s, type: t, size, price } = {}){
      if (s) setSide(s);
      if (t) setType(t);
      if (size != null) $("hlSize").value = String(size);
      if (price != null){ setType("limit"); $("hlPrice").value = String(price); }
      renderNotional();
    },
    network: HL.getNetwork,
  },
});
