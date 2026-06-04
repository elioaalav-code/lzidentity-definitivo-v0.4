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

const INTERVAL_MS = { "1m":60e3, "5m":300e3, "15m":900e3, "1h":3600e3, "4h":14400e3, "1d":86400e3 };

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
});
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
function renderBook(){
  const N = 11;
  const asks = book.asks.slice(0, N);
  const bids = book.bids.slice(0, N);
  const maxSz = Math.max(1e-9, ...asks.map(l => +l.sz), ...bids.map(l => +l.sz));
  const row = (l, kind) => {
    const depth = Math.min(100, (+l.sz / maxSz) * 100);
    return `<div class="lvl ${kind}" data-px="${l.px}">
      <i style="width:${depth}%"></i>
      <span class="p">${pxStr(l.px)}</span><span class="s">${(+l.sz).toLocaleString("en-US",{maximumFractionDigits:4})}</span>
    </div>`;
  };
  $("hlAsks").innerHTML = asks.slice().reverse().map(l => row(l, "ask")).join("");
  $("hlBids").innerHTML = bids.map(l => row(l, "bid")).join("");
  const bestAsk = asks[0] ? +asks[0].px : null;
  const bestBid = bids[0] ? +bids[0].px : null;
  if (bestAsk && bestBid){
    const mid = (bestAsk + bestBid) / 2;
    const spread = bestAsk - bestBid;
    $("hlBookMid").textContent = pxStr(mid);
    $("hlSpread").textContent = `${pxStr(spread)} · ${(spread/mid*1e4).toFixed(1)} bps`;
  }
  // click a level → prefill limit price
  document.querySelectorAll("#hlAsks .lvl, #hlBids .lvl").forEach(el => {
    el.addEventListener("click", () => {
      setType("limit");
      $("hlPrice").value = el.dataset.px;
      renderNotional();
    });
  });
}

/* ─── render: candlestick chart (canvas) ───────────────────── */
const cv = $("hlChart");
const ctx2d = cv ? cv.getContext("2d") : null;
let chartW = 0, chartH = 0;

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

  // candles
  for (let i = 0; i < n; i++){
    const c = view[i];
    const x = padL + i * cw + cw / 2;
    const up = c.c >= c.o;
    const col = up ? "#3fb98a" : "#e0556b";
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, yOf(c.h)); g.lineTo(x, yOf(c.l)); g.stroke();
    const yO = yOf(c.o), yC = yOf(c.c);
    const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
    g.fillRect(x - bodyW / 2, top, bodyW, h);
  }

  // last price line
  const lastC = view[n - 1];
  if (lastC){
    const y = yOf(lastPx ?? lastC.c);
    g.strokeStyle = "rgba(179,154,255,.65)"; g.lineWidth = 1;
    g.setLineDash([4, 4]); g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#b39aff"; g.fillRect(padL + plotW, y - 8, padR, 16);
    g.fillStyle = "#0a0a0c"; g.textAlign = "left";
    g.fillText(pxStr(lastPx ?? lastC.c), padL + plotW + 6, y);
  }

  // crosshair + readout
  const ro = $("hlReadout");
  if (hoverIdx >= 0 && hoverIdx < n){
    const c = view[hoverIdx];
    const x = padL + hoverIdx * cw + cw / 2;
    g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 1; g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + plotH); g.stroke(); g.setLineDash([]);
    if (ro){
      const up = c.c >= c.o;
      ro.innerHTML = `<span class="${up?'up':'dn'}">O ${pxStr(c.o)} · H ${pxStr(c.h)} · L ${pxStr(c.l)} · C ${pxStr(c.c)}</span>`;
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
    drawChart();
  });
  cv.addEventListener("mouseleave", () => { hoverIdx = -1; drawChart(); });
  new ResizeObserver(() => { if (active) drawChart(); }).observe(cv.parentElement);
}

/* ─── order ticket ─────────────────────────────────────────── */
function setSide(s){
  side = s;
  document.querySelectorAll("#hlSide button").forEach(b => b.classList.toggle("on", b.dataset.side === s));
  updateSubmitLabel();
}
function setType(t){
  otype = t;
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
  if (!state.account){ btn.textContent = "Connect wallet"; btn.className = "btn accent ticket-submit"; return; }
  const verb = side === "buy" ? "Buy" : "Sell";
  btn.textContent = `${verb} ${coin} · ${otype}`;
  btn.className = "btn ticket-submit " + (side === "buy" ? "long" : "short");
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
  btn.disabled = true; btn.textContent = "Sign in your wallet…";
  try {
    await HL.placeOrder({
      account: state.account, coin: o.coin, isBuy: o.side === "buy",
      sz: o.sz, px: o.px, type: o.otype, reduceOnly: o.reduceOnly,
    });
    toast(`order placed · ${o.side} ${o.sz} ${o.coin}`, "ok");
    $("hlSize").value = "";
    renderNotional();
    closeReview();
    setTimeout(pollUser, 600);
  } catch (e){
    toast("order rejected · " + (e?.message || e), "err", 4500);
  } finally {
    btn.disabled = false; btn.textContent = "Sign & place ▸";
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
  if (!state.account) { renderPositions(); return; }
  pollUser();
  userPollTimer = setInterval(pollUser, 4500);
}
function stopUserPolling(){ clearInterval(userPollTimer); userPollTimer = null; }
async function pollUser(){
  if (!state.account){ userData = null; userOrders = []; renderPositions(); return; }
  try {
    const [ch, oo] = await Promise.all([HL.clearinghouse(state.account), HL.openOrders(state.account)]);
    userData = ch; userOrders = oo || [];
    renderPositions();
  } catch (e){ /* keep last */ }
}
function renderPositions(){
  const body = $("hlPosBody");
  if (!state.account){ body.innerHTML = `<div class="pos-empty">Connect a wallet to see your positions and balance.</div>`; return; }
  if (posTab === "positions"){
    const pos = (userData?.assetPositions || []).filter(p => Number(p.position.szi) !== 0);
    if (!pos.length){ body.innerHTML = `<div class="pos-empty">No open positions on ${HL.getNetwork()}.</div>`; return; }
    body.innerHTML = `<div class="pos-table">
      <div class="pt-head"><span>Coin</span><span>Side</span><span>Size</span><span>Entry</span><span>uPnL</span><span>Liq.</span></div>
      ${pos.map(p => {
        const s = Number(p.position.szi);
        const pnl = Number(p.position.unrealizedPnl);
        return `<div class="pt-row">
          <span class="c">${p.position.coin}</span>
          <span class="${s>0?'long':'short'}">${s>0?'Long':'Short'}</span>
          <span>${Math.abs(s)}</span>
          <span>${pxStr(p.position.entryPx)}</span>
          <span class="${pnl>=0?'long':'short'}">${pnl>=0?'+':'−'}${usd(Math.abs(pnl))}</span>
          <span>${p.position.liquidationPx ? pxStr(p.position.liquidationPx) : '—'}</span>
        </div>`;
      }).join("")}
    </div>`;
  } else if (posTab === "orders"){
    if (!userOrders.length){ body.innerHTML = `<div class="pos-empty">No open orders.</div>`; return; }
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
    renderSymbol(); renderStats();
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
  on($("hlSize"), "input", renderNotional);
  on($("hlPrice"), "input", renderNotional);
  on($("hlLev"), "input", () => { $("hlLevVal").textContent = $("hlLev").value + "×"; });
  on($("hlLevApply"), "click", applyLeverage);
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

  onChange(() => { updateSubmitLabel(); if (active){ startUserPolling(); } });
  reflectNetwork();
  setSide("buy"); setType("market");
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
    setCoin(c){ const sel = $("hlCoin"); if (sel){ sel.value = c; sel.dispatchEvent(new Event("change")); } },
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
