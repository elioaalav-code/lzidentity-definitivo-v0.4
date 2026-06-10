/* ============================================================ *
 *  trade.js — Hyperliquid Trading tab
 *
 *  Live market data (WebSocket: allMids · l2Book · trades · candle),
 *  a canvas candlestick chart, a live order book, real on-chain
 *  order placement (signed in hyperliquid.js), and positions/orders/
 *  balance polled from the user's clearinghouse state.
 * ============================================================ */

import * as HL from "./hyperliquid.js";
import { state, onChange, connectWallet, toast, shortAddr } from "./shared.js";
import * as fmt from "./fmt-num.js";
import { withTimeout } from "./net.js";
import { CustomSelect, coinAvatarHTML, skeleton, emptyState } from "./ui.js";

/* ─── module state ─────────────────────────────────────────── */

let active = false;          // is the Trading tab currently shown
let booted = false;          // one-time async boot done
let coin = "BTC";
let interval = "15m";
// restore the last market + interval the user looked at (best-dapp memory)
try {
  const lc = localStorage.getItem("lz.hl.lastCoin"); if (lc) coin = lc;
  const li = localStorage.getItem("lz.hl.lastIv");   if (li && ["1m","5m","15m","1h","4h","1d"].includes(li)) interval = li;
} catch {}
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
let midTab = "book";         // book | depth | trades (centre column tabbed card)
let userData = null;         // clearinghouse state
let userOrders = [];         // open orders
let hovering = false;        // crosshair currently over the chart
let prevLast = null;         // for the price-flash micro-interaction

let perCoinUnsubs = [];      // ws unsubscribe fns for coin-scoped subs
let midsUnsub = null;
let userPollTimer = null, ctxTimer = null, chartTimer = null;

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

/* ─── number formatting (all via the shared fmt-num.js module) ── */
const pxStr = (n) => fmt.price(n, { coin });
const usd = (n) => fmt.usd(Number(n));
const compact = (n) => fmt.compact(Number(n));
const TAKER_FEE = 0.00035;          // ≈ HL taker fee, for the ticket fee estimate
const pct = (n) => fmt.pct(n);

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
    fmt.setUniverse(universe);
    const sel = $("hlCoin");
    if (sel){
      sel.innerHTML = universe.map(u => `<option${u.name===coin?" selected":""}>${u.name}</option>`).join("");
    }
    applyCoinMeta();
    await refreshCtxs();
    initMarketSelect();      // build the rich switcher (after ctxs so volume/price are present)
    // load chart + book independently so one failing doesn't kill the other;
    // each renders its own inline retry panel on failure (showRegionError).
    await Promise.allSettled([loadCandles(), loadBook()]);
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
  initChart();
  document.querySelector(".trade-view")?.classList.add("lz-revealed");   // one-time staggered entrance
  await boot();
  subscribeMarket();
  ctxTimer = setInterval(refreshCtxs, 10_000);
  // 1s tick keeps the idle OHLC readout's candle-close countdown live
  chartTimer = setInterval(() => { if (!active) return; tickFunding(); if (!hovering) renderIdleReadout(); }, 1000);
  startUserPolling();
  if (chartReady && candles.length) setChartData();
}
function deactivate(){
  if (!active) return;
  active = false;
  unsubscribeMarket();
  clearInterval(ctxTimer); ctxTimer = null;
  clearInterval(chartTimer); chartTimer = null;
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
  chartUpdateLast(k);
});

/* ─── data loads (REST) ────────────────────────────────────── */
async function refreshCtxs(){
  try {
    const [m, ctxs] = await HL.metaAndCtxs();
    universe = m.universe;
    fmt.setUniverse(universe);
    ctxByCoin = {};
    m.universe.forEach((u, i) => { ctxByCoin[u.name] = ctxs[i]; });
    renderStats();
    renderSymbol();
    refreshMarketItems();           // groups/volume/price reflect the fresh ctx
  } catch (e){ /* keep last */ }
}
// Inline "couldn't load — retry" panel in a market region (chart / book),
// instead of a silently dead pane on a failed/timed-out load.
function showRegionError(host, label, onRetry){
  if (!host) return;
  let p = host.querySelector(":scope > .hl-region-err");
  if (!p){ p = document.createElement("div"); p.className = "hl-region-err"; host.appendChild(p); }
  p.innerHTML = `<span class="hre-txt">Couldn’t load ${label}.</span><button type="button" class="btn ghost xs hre-act">Retry</button>`;
  p.querySelector(".hre-act").onclick = () => { p.remove(); onRetry(); };
}
function clearRegionError(host){ host?.querySelector(":scope > .hl-region-err")?.remove(); }

async function loadCandles(){
  const host = $("hlChart");
  const ld = $("hlChartLoading"); if (ld) ld.classList.remove("hidden");
  const end = Date.now();
  const start = end - 200 * (INTERVAL_MS[interval] || 9e5);
  try {
    const data = await withTimeout(HL.candleSnapshot(coin, interval, start, end), 9000);
    candles = (data || []).map(c => ({ t:c.t, o:+c.o, h:+c.h, l:+c.l, c:+c.c, v:+c.v }));
    clearRegionError(host);
    setChartData();
  } catch (e){
    if (ld) ld.classList.add("hidden");
    if (!candles.length) showRegionError(host, "the chart", loadCandles);
    throw e;
  }
}
async function loadBook(){
  const host = document.querySelector('[data-view="trade"] .mid-pane[data-pane="book"]') || $("hlBids")?.parentElement;
  try {
    const data = await withTimeout(HL.l2Book(coin), 9000);
    if (data && data.levels) book = { bids: data.levels[0] || [], asks: data.levels[1] || [] };
    clearRegionError(host);
    if (active) renderBook();
  } catch {
    if (!book.bids.length && !book.asks.length) showRegionError(host, "the order book", loadBook);
  }
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
    chEl.innerHTML = `<span class="arr">${ch >= 0 ? "▲" : "▼"}</span>${Math.abs(ch).toFixed(2)}% <em>24h</em>`;
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
// countdown to the next hourly funding (paid on the hour, HL convention)
function tickFunding(){
  const el = $("hlFundCd");
  if (!el) return;
  const now = new Date();
  const ms = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000;
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  el.textContent = `· ${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
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
  // bid/ask pressure (imbalance) bar
  const tot = bidTot + askTot;
  const bidPct = tot > 0 ? (bidTot / tot) * 100 : 50;
  const fill = $("hlImbFill"), bEl = $("hlImbB"), aEl = $("hlImbA");
  if (fill) fill.style.width = bidPct.toFixed(1) + "%";
  if (bEl) bEl.textContent = bidPct.toFixed(0) + "%";
  if (aEl) aEl.textContent = (100 - bidPct).toFixed(0) + "%";
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

/* ─── centre column tabs: Book / Depth / Trades ────────────────
 * The book pane is owned here; the depth + trades panes are owned by
 * hl-depth.js (it renders into #hlDepthMount / #hlTradesMount). Those
 * canvases can't size while display:none, so when a pane is shown we
 * emit `lz:hl:addontab` and hl-depth.js re-measures + redraws.        */
function setMidTab(t){
  midTab = t;
  document.querySelectorAll("#hlMidTabs button").forEach(b => {
    const on = b.dataset.mid === t;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".trade-mid-card .mid-pane").forEach(p => { p.hidden = p.dataset.pane !== t; });
  if (t === "depth" || t === "trades"){
    try { window.dispatchEvent(new CustomEvent("lz:hl:addontab", { detail: { tab: t } })); } catch {}
  }
}

/* ─── candlestick chart — TradingView lightweight-charts, our theme ───
 * Real pan / zoom / crosshair from TradingView's official library (vendored
 * locally in assets/vendor — no build step, offline at runtime). We feed it
 * HL candles + a volume histogram and drive the #hlReadout OHLC strip off the
 * crosshair. Falls back gracefully (no chart) if the lib didn't load.        */
let chart = null, candleSeries = null, volSeries = null, chartReady = false;
let maFastSeries = null, maSlowSeries = null;   // EMA overlays (TradingView-style)
let maFastData = [], maSlowData = [];           // cached {time,value} for legend lookup
let lastEmaFast = null, lastEmaSlow = null;
const MA_FAST = 9, MA_SLOW = 21;
let maOn = (() => { try { return (localStorage.getItem("lz.hl.ma") ?? "1") === "1"; } catch { return true; } })();
let posPriceLines = [];      // entry / liq price lines for the current coin's position

// mm:ss (or Hh MMm for long intervals) remaining until a candle closes
function fmtCountdown(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m`;
  return `${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
}

const toSec = (t) => Math.floor(t / 1000);
const VOL_UP = "rgba(63,185,138,.45)", VOL_DN = "rgba(224,85,107,.45)";
const candlePoint = (c) => ({ time: toSec(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
const volPoint    = (c) => ({ time: toSec(c.t), value: c.v || 0, color: c.c >= c.o ? VOL_UP : VOL_DN });

function initChart(){
  if (chart || !window.LightweightCharts) return;
  const el = $("hlChart");
  if (!el) return;
  const LWC = window.LightweightCharts;
  chart = LWC.createChart(el, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: "#9a9aa3",
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,.04)" },
      horzLines: { color: "rgba(255,255,255,.05)" },
    },
    crosshair: {
      mode: LWC.CrosshairMode ? LWC.CrosshairMode.Normal : 0,
      vertLine: { color: "rgba(179,154,255,.55)", width: 1, style: 3, labelBackgroundColor: "#2a2540" },
      horzLine: { color: "rgba(179,154,255,.55)", width: 1, style: 3, labelBackgroundColor: "#2a2540" },
    },
    rightPriceScale: { borderColor: "rgba(255,255,255,.08)", scaleMargins: { top: 0.06, bottom: 0.26 } },
    timeScale: { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
    handleScroll: true, handleScale: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#3fb98a", downColor: "#e0556b",
    borderUpColor: "#3fb98a", borderDownColor: "#e0556b",
    wickUpColor: "#5fcfa4", wickDownColor: "#ec6b80",
    priceLineColor: "rgba(179,154,255,.7)", priceLineStyle: 2,
  });
  volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", color: VOL_UP, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  // EMA overlays — thin lines, no own price label / crosshair marker
  const maOpts = { lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  maFastSeries = chart.addLineSeries({ ...maOpts, color: "rgba(179,154,255,.95)" });
  maSlowSeries = chart.addLineSeries({ ...maOpts, color: "rgba(94,234,212,.9)" });
  chart.subscribeCrosshairMove(onCrosshair);
  chartReady = true;
  if (candles.length) setChartData();
}

// match the price-scale precision to the coin's magnitude
function applyPricePrecision(){
  if (!candleSeries) return;
  const px = lastPx ?? mids[coin] ?? (ctxByCoin[coin] ? +ctxByCoin[coin].markPx : 0);
  let precision = 2, minMove = 0.01;
  if (px && px < 1){ precision = 6; minMove = 1e-6; }
  else if (px && px < 100){ precision = 4; minMove = 1e-4; }
  candleSeries.applyOptions({ priceFormat: { type: "price", precision, minMove } });
}
// EMA over the close series → array of {time,value}, warmed up over `period` bars
function emaSeries(period){
  const out = []; let prev = null; const k = 2 / (period + 1);
  for (let i = 0; i < candles.length; i++){
    const c = candles[i].c;
    prev = prev === null ? c : (c * k + prev * (1 - k));
    if (i >= period - 1) out.push({ time: toSec(candles[i].t), value: prev });
  }
  return out;
}
function renderMAs(){
  if (!maFastSeries || !maSlowSeries) return;
  if (maOn && candles.length){
    maFastData = emaSeries(MA_FAST); maSlowData = emaSeries(MA_SLOW);
    maFastSeries.setData(maFastData); maSlowSeries.setData(maSlowData);
    lastEmaFast = maFastData.length ? maFastData[maFastData.length-1].value : null;
    lastEmaSlow = maSlowData.length ? maSlowData[maSlowData.length-1].value : null;
  } else {
    maFastData = []; maSlowData = [];
    maFastSeries.setData([]); maSlowSeries.setData([]);
    lastEmaFast = lastEmaSlow = null;
  }
  updateChartLegend();
}
// legend chip top-left of the chart; `vals` overrides with hovered EMA values
function updateChartLegend(vals){
  const el = $("hlChartLegend"); if (!el) return;
  if (!maOn){ el.innerHTML = ""; return; }
  const f = vals && vals.f != null ? vals.f : lastEmaFast;
  const s = vals && vals.s != null ? vals.s : lastEmaSlow;
  el.innerHTML =
    `<span class="cl-ma f">EMA ${MA_FAST}<b>${f != null ? pxStr(f) : "—"}</b></span>` +
    `<span class="cl-ma s">EMA ${MA_SLOW}<b>${s != null ? pxStr(s) : "—"}</b></span>`;
}
function setChartData(){
  if (!chartReady || !candleSeries) return;
  candleSeries.setData(candles.map(candlePoint));
  volSeries.setData(candles.map(volPoint));
  renderMAs();
  applyPricePrecision();
  syncPositionLines();
  // default view: focus on the most recent ~90 bars so the price autoscale
  // zooms into current action (user can pan left for history). Like a real desk.
  try {
    if (chart && candles.length > 12){
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 90), to: candles.length + 4 });
    }
  } catch {}
  const ld = $("hlChartLoading"); if (ld && candles.length) ld.classList.add("hidden");
}
function chartUpdateLast(c){
  if (!chartReady || !candleSeries || !c) return;
  candleSeries.update(candlePoint(c));
  volSeries.update(volPoint(c));
  renderMAs();   // EMAs are cheap to recompute over the in-memory candle buffer
}
function toggleMA(){
  maOn = !maOn;
  try { localStorage.setItem("lz.hl.ma", maOn ? "1" : "0"); } catch {}
  const btn = $("hlIndMA"); if (btn){ btn.classList.toggle("on", maOn); btn.setAttribute("aria-pressed", String(maOn)); }
  renderMAs();
}
// Draw the open position's entry + liquidation as horizontal lines on the
// chart for the coin currently shown (like the pro perps DEXes).
function syncPositionLines(){
  if (!chartReady || !candleSeries) return;
  posPriceLines.forEach(l => { try { candleSeries.removePriceLine(l); } catch {} });
  posPriceLines = [];
  const p = (userData?.assetPositions || []).find(a => a.position.coin === coin && Number(a.position.szi) !== 0);
  if (!p) return;
  const szi = Number(p.position.szi);
  const entry = Number(p.position.entryPx);
  const liq = Number(p.position.liquidationPx);
  const long = szi > 0;
  if (isFinite(entry) && entry > 0){
    posPriceLines.push(candleSeries.createPriceLine({
      price: entry, color: long ? "#3fb98a" : "#e0556b", lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: `${long ? "Long" : "Short"} ${Math.abs(szi)}`,
    }));
  }
  if (isFinite(liq) && liq > 0){
    posPriceLines.push(candleSeries.createPriceLine({
      price: liq, color: "#e0556b", lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: "Liq.",
    }));
  }
}

function onCrosshair(param){
  const ro = $("hlReadout");
  if (!ro) return;
  if (!param || !param.time || !param.point || !candleSeries){ hovering = false; renderIdleReadout(); return; }
  const c = param.seriesData.get(candleSeries);
  if (!c){ hovering = false; renderIdleReadout(); return; }
  hovering = true;
  const up = c.close >= c.open;
  const dv = c.open ? (c.close - c.open) / c.open * 100 : 0;
  const v = volSeries ? param.seriesData.get(volSeries) : null;
  ro.innerHTML = `<span class="${up?'up':'dn'}">O ${pxStr(c.open)} · H ${pxStr(c.high)} · L ${pxStr(c.low)} · C ${pxStr(c.close)} · ${pct(dv)}${v?` · V ${compact(v.value)}`:''}</span>`;
  // mirror the EMA values at the hovered bar into the legend
  if (maOn){
    const mf = maFastSeries ? param.seriesData.get(maFastSeries) : null;
    const ms = maSlowSeries ? param.seriesData.get(maSlowSeries) : null;
    updateChartLegend({ f: mf ? mf.value : null, s: ms ? ms.value : null });
  }
}
function renderIdleReadout(){
  const ro = $("hlReadout");
  if (!ro) return;
  const lastC = candles[candles.length - 1];
  if (!lastC){ ro.textContent = ""; return; }
  const up = lastC.c >= lastC.o;
  const spanMs = INTERVAL_MS[interval] || 9e5;
  const intraday = spanMs < 86400e3;
  const remain = intraday ? lastC.t + spanMs - Date.now() : 0;
  const cd = (intraday && remain > 0) ? ` · close ${fmtCountdown(remain)}` : "";
  ro.innerHTML = `<span class="${up?'up':'dn'}">O ${pxStr(lastC.o)} · H ${pxStr(lastC.h)} · L ${pxStr(lastC.l)} · C ${pxStr(lastC.c)} · V ${compact(lastC.v||0)}</span><span class="cd">${cd}</span>`;
  updateChartLegend();   // legend back to latest EMA values when not hovering
}

/* ─── order ticket ─────────────────────────────────────────── */
function setSide(s){
  side = s;
  const wrap = $("hlSide");
  if (wrap) wrap.dataset.on = s;              // drives the sliding indicator (CSS)
  document.querySelectorAll("#hlSide button").forEach(b => b.classList.toggle("on", b.dataset.side === s));
  updateSubmitLabel();
  renderNotional();   // refresh the est. liq. price for the new side
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
  const valid = sz > 0 && isFinite(px) && px > 0;
  const notional = valid ? sz * px : 0;
  const lev = Number($("hlLev")?.value) || 1;
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set("hlNotional", valid ? usd(notional) : "—");
  set("hlMargin",   valid ? usd(notional / lev) : "—");
  set("hlFees",     valid ? usd(notional * TAKER_FEE) : "—");
  /* Est. liquidation price (isolated, first-order: maintenance margin ≈ 0).
   * long liquidates below entry, short above — by ~1/leverage. Labelled an
   * estimate; real liq also depends on maintenance margin, fees and funding. */
  const isLong = side === "buy";
  const liqEl = $("hlLiq"); const liqSideEl = $("hlLiqSide");
  if (liqSideEl) liqSideEl.textContent = isLong ? "long" : "short";
  if (liqEl){
    const liq = valid && lev > 0 ? px * (1 + (isLong ? -1 : 1) / lev) : NaN;
    liqEl.textContent = (valid && lev > 0 && liq > 0) ? usd(liq) : "—";
  }
  const wd = Number(userData?.withdrawable);
  set("hlAvail", isFinite(wd) ? usd(wd) : (state.account ? "—" : "connect wallet"));
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
let placing = false;   // in-flight guard: blocks a second signature while one is open
function openReview(o){
  pendingOrder = o;
  const notional = o.sz * o.px;
  const isMain = HL.isMainnet();
  const closing = o.reduceOnly && o.otype === "market";
  const titleEl = $("hlModalTitle");
  if (titleEl) titleEl.textContent = closing ? `Close ${o.coin} position` : "Review order";
  $("hlReview").innerHTML = `
    <div class="rv-row"><span>Market</span><b>${o.coin}-PERP</b></div>
    <div class="rv-row"><span>Side</span><b class="${o.side==='buy'?'long':'short'}">${o.side==='buy'?'Buy / Long':'Sell / Short'}</b></div>
    <div class="rv-row"><span>Type</span><b>${o.otype==='market'?'Market (IOC)':'Limit (GTC)'}</b></div>
    <div class="rv-row"><span>Size</span><b>${o.sz} ${o.coin}</b></div>
    <div class="rv-row"><span>${o.otype==='market'?'Est. price':'Limit price'}</span><b>${pxStr(o.px)}${o.otype==='market'?' <em>±5% slippage</em>':''}</b></div>
    <div class="rv-row"><span>Notional</span><b>${usd(notional)}</b></div>
    <div class="rv-row"><span>Est. fees</span><b>${usd(notional * TAKER_FEE)} <em>taker</em></b></div>
    ${o.reduceOnly ? `<div class="rv-row"><span>Flag</span><b>Reduce only</b></div>` : ``}`;
  $("hlModalNet").className = "hl-modal-net " + (isMain ? "main" : "test");
  $("hlModalNet").innerHTML = isMain
    ? `⚠ <b>Mainnet</b> — this signs a real order with real funds.`
    : `<b>Testnet</b> — paper funds. Signs against the Hyperliquid testnet.`;
  $("hlModal").hidden = false;
}
function closeReview(){ $("hlModal").hidden = true; pendingOrder = null; }
async function confirmOrder(){
  if (!pendingOrder || placing) return;   // ignore double-clicks during signing
  placing = true;
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
    placing = false;
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
  userLoadError = false;
  userData = null;
  if (!state.account) { firstUserPoll = true; renderPositions(); renderAccountBanner(); return; }
  firstUserPoll = true;
  renderPositions();          // paints a skeleton while the first poll is in flight
  renderAccountBanner();
  pollUser();
  userPollTimer = setInterval(pollUser, 4500);
}
function stopUserPolling(){ clearInterval(userPollTimer); userPollTimer = null; }
async function pollUser(){
  if (!state.account){ userData = null; userOrders = []; renderPositions(); renderAccountBanner(); return; }
  try {
    const [ch, oo] = await Promise.all([HL.clearinghouse(state.account), HL.openOrders(state.account)]);
    userData = ch; userOrders = oo || [];
    firstUserPoll = false;
    userLoadError = false;
    renderPositions();
    updateSizeChipState();
    renderNotional();
    syncPositionLines();
  } catch (e){ firstUserPoll = false; userLoadError = true; renderPositions(); }
  renderAccountBanner();
}

/* ── Connected-but-empty / load-error banner ──────────────────
 * The historical "testnet-zero" bug class: a wallet is connected but the
 * clearinghouse on the *current* HL network has no account value, so the
 * positions/account tables silently show all zeros and the user thinks
 * the app is broken. Surface an explicit, actionable banner instead.
 * Injected into the existing .trade-positions container (no app.html edit). */
let userLoadError = false;
function accountIsEmpty(){
  if (!userData) return false;
  const av = Number(userData?.marginSummary?.accountValue);
  const wd = Number(userData?.withdrawable);
  const hasPos = (userData.assetPositions || []).some(p => Number(p.position.szi) !== 0);
  return (!av && !wd && !hasPos);
}
function renderAccountBanner(){
  const host = document.querySelector('[data-view="trade"] .trade-positions');
  if (!host) return;
  let el = document.getElementById("hlAcctBanner");
  let kind = null;                 // "error" | "empty" | null
  if (state.account){
    if (userLoadError) kind = "error";
    else if (accountIsEmpty()) kind = "empty";
  }
  if (!kind){ if (el) el.remove(); return; }
  const net = (() => { try { return HL.getNetwork(); } catch { return "mainnet"; } })();
  if (!el){
    el = document.createElement("div");
    el.id = "hlAcctBanner";
    el.className = "hl-acct-banner";
    el.setAttribute("role", "status");
    host.insertBefore(el, host.firstChild);
  }
  el.dataset.kind = kind;
  if (kind === "error"){
    el.innerHTML =
      `<span class="hab-ic" aria-hidden="true">!</span>
       <span class="hab-txt"><b>Couldn’t load your Hyperliquid account.</b> Network or rate-limit issue on ${net}.</span>
       <button type="button" class="btn ghost xs hab-act">Retry</button>`;
    el.querySelector(".hab-act").onclick = () => { userLoadError = false; renderAccountBanner(); pollUser(); };
  } else {
    el.innerHTML =
      `<span class="hab-ic" aria-hidden="true">○</span>
       <span class="hab-txt"><b>No Hyperliquid account on ${net}.</b> Market data is live, but you have no balance here — deposit on app.hyperliquid.xyz${net === "testnet" ? " (testnet)" : ""} or switch network.</span>
       <a class="btn ghost xs hab-act" href="https://app.hyperliquid.xyz/${net === "testnet" ? "?testnet" : ""}" target="_blank" rel="noopener">Open Hyperliquid ↗</a>`;
  }
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

// open positions with a non-zero size, newest API order preserved
function openPositions(){
  return (userData?.assetPositions || []).filter(p => Number(p.position.szi) !== 0);
}
// keep the tab counters + contextual actions (e.g. Cancel all) in sync
function updatePosMeta(){
  const posN = state.account ? openPositions().length : 0;
  const ordN = state.account ? userOrders.length : 0;
  const pc = $("hlPosCount"), oc = $("hlOrdCount");
  if (pc){ pc.textContent = posN; pc.hidden = !posN; }
  if (oc){ oc.textContent = ordN; oc.hidden = !ordN; }
  const act = $("hlPosActions");
  if (act){
    if (posTab === "orders" && ordN > 0){
      act.innerHTML = `<button class="btn ghost xs" id="hlCancelAll">Cancel all</button>`;
      on($("hlCancelAll"), "click", cancelAll);
    } else { act.innerHTML = ""; }
  }
  // aggregate unrealized PnL across open positions
  const agg = $("hlPosAgg");
  if (agg){
    if (state.account && posN > 0){
      let up = 0; for (const p of openPositions()){ const v = Number(p.position.unrealizedPnl); if (isFinite(v)) up += v; }
      agg.innerHTML = `<span class="k">Total uPnL</span> <b class="${up>=0?'long':'short'}">${up>=0?'+':'−'}${usd(Math.abs(up))}</b>`;
      agg.hidden = false;
    } else { agg.hidden = true; }
  }
}

function renderPositions(){
  const body = $("hlPosBody");
  updatePosMeta();
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
    const pos = openPositions();
    if (!pos.length){
      paintEmpty(body, { icon: ICON_POS, title: "No open positions",
        body: `You have no open positions on ${HL.getNetwork()}.` });
      return;
    }
    body.innerHTML = `<div class="pos-table positions">
      <div class="pt-head"><span>Coin</span><span>Side</span><span>Size</span><span>Entry</span><span>Mark</span><span>uPnL</span><span>Liq.</span><span class="pt-act">Close</span></div>
      ${pos.map(p => {
        const s = Number(p.position.szi);
        const pnl = Number(p.position.unrealizedPnl);
        const roe = Number(p.position.returnOnEquity);
        const mark = midOf(p.position.coin);
        const c = p.position.coin;
        return `<div class="pt-row" data-coin="${c}">
          <span class="c is-pickable" data-go-coin="${c}" role="button" tabindex="0" aria-label="Open ${c} market">${c}</span>
          <span class="${s>0?'long':'short'}">${s>0?'Long':'Short'}</span>
          <span>${Math.abs(s)}</span>
          <span>${pxStr(p.position.entryPx)}</span>
          <span>${isFinite(mark)?pxStr(mark):'—'}</span>
          <span class="${pnl>=0?'long':'short'}">${pnl>=0?'+':'−'}${usd(Math.abs(pnl))}${isFinite(roe)?` <em>${pct(roe*100)}</em>`:''}</span>
          <span>${p.position.liquidationPx ? pxStr(p.position.liquidationPx) : '—'}</span>
          <span class="pt-act">
            <button class="btn ghost xs" data-close="${c}:0.5">50%</button>
            <button class="btn ghost xs danger" data-close="${c}:1">Close</button>
          </span>
        </div>`;
      }).join("")}
    </div>`;
    body.querySelectorAll(".is-pickable[data-go-coin]").forEach(r => {
      const go = () => goToMarket(r.dataset.goCoin);
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); } });
    });
    body.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const [c, fr] = b.dataset.close.split(":");
      closePosition(c, Number(fr));
    }));
  } else if (posTab === "orders"){
    if (!userOrders.length){
      paintEmpty(body, { icon: ICON_ORDERS, title: "No open orders",
        body: "Resting limit orders you place will appear here." });
      return;
    }
    body.innerHTML = `<div class="pos-table orders">
      <div class="pt-head"><span>Coin</span><span>Side</span><span>Size</span><span>Price</span><span class="pt-act"></span></div>
      ${userOrders.map(o => `<div class="pt-row">
        <span class="c">${o.coin}</span>
        <span class="${o.side==='B'?'long':'short'}">${o.side==='B'?'Buy':'Sell'}</span>
        <span>${o.sz}</span>
        <span>${pxStr(o.limitPx)}</span>
        <span class="pt-act"><button class="btn ghost xs" data-cancel="${o.coin}:${o.oid}">Cancel</button></span>
      </div>`).join("")}
    </div>`;
    body.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => cancel(b.dataset.cancel)));
  } else {
    const ms = userData?.marginSummary || {};
    const av = Number(ms.accountValue) || 0;
    const used = Number(ms.totalMarginUsed) || 0;
    const ntl = Number(ms.totalNtlPos) || 0;
    const maint = Number(userData?.crossMaintenanceMarginUsed);
    const usage = av > 0 ? (used / av * 100) : 0;
    const ratio = (isFinite(maint) && av > 0) ? (maint / av * 100) : null;
    const lev = av > 0 ? (ntl / av) : 0;
    const tone = usage >= 80 ? "hot" : usage >= 50 ? "warn" : "";
    body.innerHTML = `
      <div class="acct-usage">
        <div class="au-head"><span>Margin usage</span><span class="${tone}">${usage.toFixed(1)}%</span></div>
        <div class="au-bar"><i class="${tone}" style="width:${Math.min(100, usage).toFixed(1)}%"></i></div>
      </div>
      <div class="acct-grid">
        <div class="acct"><span class="k">Account value</span><span class="v">${usd(av)}</span></div>
        <div class="acct"><span class="k">Withdrawable</span><span class="v">${usd(userData?.withdrawable||0)}</span></div>
        <div class="acct"><span class="k">Margin used</span><span class="v">${usd(used)}</span></div>
        <div class="acct"><span class="k">Position value</span><span class="v">${usd(ntl)}</span></div>
        <div class="acct"><span class="k">Margin ratio</span><span class="v ${ratio!=null&&ratio>=50?'dn':''}">${ratio!=null?ratio.toFixed(2)+'%':'—'}</span></div>
        <div class="acct"><span class="k">Account leverage</span><span class="v">${lev?lev.toFixed(2)+'×':'—'}</span></div>
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
async function cancelAll(){
  if (!userOrders.length) return;
  const orders = userOrders.slice();
  toast(`cancelling ${orders.length} order${orders.length>1?'s':''}…`, "ok");
  let ok = 0;
  for (const o of orders){
    try { await HL.cancelOrder({ account: state.account, coin: o.coin, oid: Number(o.oid) }); ok++; }
    catch (e){ /* keep going */ }
  }
  toast(ok === orders.length ? `all orders cancelled` : `cancelled ${ok}/${orders.length}`, ok ? "ok" : "err");
  setTimeout(pollUser, 500);
}
// Close (or partially close) a position by signing a reduce-only market
// order on the opposite side — routed through the same review→sign modal as
// a normal order, so the user always confirms before any funds move.
function closePosition(c, frac){
  const p = openPositions().find(x => x.position.coin === c);
  if (!p){ toast("position not found — refresh", "err"); return; }
  const szi = Number(p.position.szi);
  if (!isFinite(szi) || szi === 0){ toast("nothing to close", "err"); return; }
  const u = universe.find(x => x.name === c);
  const dp = Math.max(0, Math.min(8, u ? u.szDecimals : szDecimals));
  const sz = Number((Math.abs(szi) * (frac || 1)).toFixed(dp));
  if (!(sz > 0)){ toast("size too small to close", "err"); return; }
  const px = midOf(c);
  openReview({ coin: c, side: szi > 0 ? "sell" : "buy", otype: "market", sz, px, reduceOnly: true });
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
  emitNet();
  // reset + reload all data on the new host
  ctxByCoin = {}; mids = {}; lastPx = null; candles = []; book = { bids:[], asks:[] };
  userData = null; userLoadError = false; renderAccountBanner();
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
    try { localStorage.setItem("lz.hl.lastCoin", coin); } catch {}
    applyCoinMeta();
    lastPx = null; prevLast = null; candles = []; book = { bids:[], asks:[] };
    renderSymbol(); renderStats(); updateTriggerPx();
    updateSizeChipState();
    if (active){ subscribeCoin(); }
    await Promise.all([loadCandles(), loadBook()]);
    updateSubmitLabel();
    emitCoin();
  });
  $("hlIv").querySelectorAll("button").forEach(b => on(b, "click", async () => {
    interval = b.dataset.iv;
    try { localStorage.setItem("lz.hl.lastIv", interval); } catch {}
    $("hlIv").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    candles = [];
    if (active){ subscribeCoin(); }
    await loadCandles();
  }));
  // reflect a restored interval onto the picker (HTML defaults to 15m)
  $("hlIv").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.iv === interval));
  // EMA overlay toggle
  { const mb = $("hlIndMA"); if (mb){ mb.classList.toggle("on", maOn); mb.setAttribute("aria-pressed", String(maOn)); on(mb, "click", toggleMA); } }
  $("hlSide").querySelectorAll("button").forEach(b => on(b, "click", () => setSide(b.dataset.side)));
  $("hlType").querySelectorAll("button").forEach(b => on(b, "click", () => setType(b.dataset.type)));
  on($("hlSize"), "input", () => {
    renderNotional();
    const chips = $("hlSizeChips");
    if (chips) chips.querySelectorAll("button.on").forEach(b => b.classList.remove("on"));
  });
  on($("hlPrice"), "input", () => { renderNotional(); updateTriggerPx(); });
  on($("hlLev"), "input", () => { renderLev(); renderNotional(); });
  on($("hlLevApply"), "click", applyLeverage);
  // size quick-chips (25/50/75/Max of withdrawable buying power at leverage)
  const chips = $("hlSizeChips");
  if (chips) chips.querySelectorAll("button").forEach(b => on(b, "click", () => applySizeChip(b.dataset.pct)));
  on($("hlSubmit"), "click", onSubmit);
  $("hlPosTabs").querySelectorAll("button").forEach(b => on(b, "click", () => {
    posTab = b.dataset.tab;
    $("hlPosTabs").querySelectorAll("button").forEach(x => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-selected", x === b ? "true" : "false");
    });
    renderPositions();
  }));
  const midTabs = $("hlMidTabs");
  if (midTabs) midTabs.querySelectorAll("button").forEach(b => on(b, "click", () => setMidTab(b.dataset.mid)));
  document.querySelectorAll("#hlNetToggle button").forEach(b => on(b, "click", () => switchNetwork(b.dataset.net)));
  on($("hlCancel"), "click", closeReview);
  on($("hlConfirm"), "click", confirmOrder);
  on($("hlModal"), "click", (e) => { if (e.target === $("hlModal")) closeReview(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("hlModal").hidden) closeReview(); });

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

/* ─── integration events for add-on modules (markets/depth/portfolio/pro) ──
 * These let independently-loaded modules react to coin/network changes
 * without reaching into this file's internals. Detail carries the bits a
 * consumer needs; consumers can also read the getters on window.LZ.hl. */
function emitCoin(){
  try { window.dispatchEvent(new CustomEvent("lz:hl:coin", { detail: { coin, szDecimals, universe } })); } catch {}
}
function emitNet(){
  try { window.dispatchEvent(new CustomEvent("lz:hl:net", { detail: { network: HL.getNetwork() } })); } catch {}
}

/* expose helpers for the AI copilot and the add-on modules */
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
    // live getters for add-on modules (read-only views of trade state)
    coin: () => coin,
    account: () => state.account || null,
    szDecimals: () => szDecimals,
    universe: () => universe.map(u => ({ ...u })),
    // let a module force a refresh of the user panel after it acts (e.g. close)
    refreshUser: () => { try { if (active) pollUser(); } catch {} },
  },
});
