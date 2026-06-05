/* =====================================================================
 *  hl-depth.js — ORDER-BOOK DEPTH CHART + LIVE TRADES TAPE (HL parity)
 *  ---------------------------------------------------------------------
 *  Implemented by the DEPTH+TAPE agent. Owns this file and
 *  assets/css/hl-depth.css only. See the original stub header (git
 *  history) for the full integration contract. Summary:
 *
 *   1) cumulative DEPTH CHART  — bids green (left), asks red (right),
 *      mirrored around mid, stepped area fill, hover readout of price
 *      + cumulative size, ±~2% price window around mid.
 *   2) recent-TRADES TAPE      — newest on top, time/price/size,
 *      side-coloured, capped to ~60 rows, gentle flash on new rows.
 *
 *  DATA: keyless HL layer (./hyperliquid.js).
 *    WS:   HL.ws.subscribe({type:"l2Book",coin})  -> push "ws:l2Book"
 *          HL.ws.subscribe({type:"trades",coin})  -> push "ws:trades"
 *    REST: HL.l2Book(coin) snapshot for the initial paint / WS-quiet.
 *
 *  Lifecycle: only active while the trade view is visible. Re-subscribes
 *  on "lz:hl:coin" and "lz:hl:net" (ws reconnect), unsubscribing the old
 *  coin's feeds first. No build, no libs — pure DOM + canvas.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";

(function initHlDepth(){
  const depthMount = document.getElementById("hlDepthMount");
  const tapeMount  = document.getElementById("hlTradesMount");
  if (!depthMount && !tapeMount) return;

  /* ─── small helpers ──────────────────────────────────────── */
  const reduceMotion = (() => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch { return false; }
  })();
  const coinNow = () => {
    try { return (window.LZ && window.LZ.hl && window.LZ.hl.coin && window.LZ.hl.coin()) || "BTC"; }
    catch { return "BTC"; }
  };
  function pxStr(n){
    n = Number(n);
    if (!isFinite(n)) return "—";
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (n >= 1)    return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  function szStr(n){
    n = Number(n);
    if (!isFinite(n)) return "—";
    if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  // brand tokens (resolved once) so the canvas matches the palette.
  const COL = (() => {
    let cs;
    try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
    const g = (k, fb) => { try { return (cs && cs.getPropertyValue(k).trim()) || fb; } catch { return fb; } };
    return {
      long:  g("--long", "#3fb98a"),
      short: g("--short", "#e0556b"),
      text:  g("--text-dim", "#a0a0a8"),
      mute:  g("--text-mute", "#6b6b75"),
    };
  })();
  function withAlpha(hex, a){
    // accepts #rgb / #rrggbb; falls back to the original if it can't parse.
    if (typeof hex !== "string") return hex;
    let h = hex.trim();
    if (h[0] !== "#") return hex;
    h = h.slice(1);
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if ([r, gg, b].some(v => Number.isNaN(v))) return hex;
    return `rgba(${r},${gg},${b},${a})`;
  }

  /* ─── module state ───────────────────────────────────────── */
  let active = false;                 // is the trade view visible
  let coin = coinNow();
  let book = { bids: [], asks: [] };  // each level: { px, sz, n } (strings)
  let trades = [];                    // newest-first, capped
  const TAPE_CAP = 60;

  let perCoinUnsubs = [];             // ws unsubscribe fns for current coin
  let busUnsubs = [];                 // event-bus + window unsubscribe fns
  let snapTimer = null;               // periodic snapshot fallback poll
  let depthRAF = 0;                   // queued depth redraw

  /* ─── DOM scaffold ───────────────────────────────────────── */
  let depthCanvas = null, depthCtx = null, depthReadout = null;
  let depthW = 0, depthH = 0;
  let tapeList = null, tapeSpread = null;

  function buildDepthCard(){
    if (!depthMount) return;
    const card = document.createElement("div");
    card.className = "hl-depth-card book-card";
    card.innerHTML =
      '<div class="book-head">' +
        '<span>Depth</span>' +
        '<span class="hl-depth-readout" id="hlDepthReadout"></span>' +
      '</div>' +
      '<div class="hl-depth-body"><canvas class="hl-depth-canvas"></canvas></div>';
    depthMount.replaceChildren(card);
    depthCanvas = card.querySelector(".hl-depth-canvas");
    depthReadout = card.querySelector(".hl-depth-readout");
    depthCtx = depthCanvas ? depthCanvas.getContext("2d") : null;

    if (depthCanvas){
      depthCanvas.addEventListener("mousemove", onDepthHover);
      depthCanvas.addEventListener("mouseleave", () => { hoverX = -1; queueDepth(); });
    }
    const wrap = card.querySelector(".hl-depth-body");
    if (wrap && typeof ResizeObserver !== "undefined"){
      const ro = new ResizeObserver(() => { if (active) queueDepth(); });
      ro.observe(wrap);
    }
  }

  function buildTapeCard(){
    if (!tapeMount) return;
    const card = document.createElement("div");
    card.className = "hl-tape-card book-card";
    card.innerHTML =
      '<div class="book-head">' +
        '<span>Trades</span>' +
        '<span class="hl-tape-spread" id="hlTapeSpread"></span>' +
      '</div>' +
      '<div class="hl-tape-cols"><span>Price</span><span>Size</span><span>Time</span></div>' +
      '<div class="hl-tape-list" role="log" aria-live="off"></div>';
    tapeMount.replaceChildren(card);
    tapeList = card.querySelector(".hl-tape-list");
    tapeSpread = card.querySelector(".hl-tape-spread");
  }

  /* ─── depth math + drawing ───────────────────────────────── */
  let hoverX = -1;

  function bestPrices(){
    const b = book.bids && book.bids[0] ? Number(book.bids[0].px) : NaN;
    const a = book.asks && book.asks[0] ? Number(book.asks[0].px) : NaN;
    return { bestBid: b, bestAsk: a };
  }

  // Build cumulative ladders within ±WINDOW of mid. Returns sorted-by-distance
  // points: bids accumulate downward from bestBid, asks upward from bestAsk.
  const WINDOW = 0.02;   // ±2% price band around mid
  function buildLadders(mid){
    const lo = mid * (1 - WINDOW), hi = mid * (1 + WINDOW);
    const bidPts = [];   // {px, cum}
    let cum = 0;
    for (const lvl of (book.bids || [])){
      const px = Number(lvl.px), sz = Number(lvl.sz);
      if (!isFinite(px) || !isFinite(sz)) continue;
      cum += sz;
      if (px < lo) { bidPts.push({ px: lo, cum }); break; }
      bidPts.push({ px, cum });
    }
    const askPts = [];
    cum = 0;
    for (const lvl of (book.asks || [])){
      const px = Number(lvl.px), sz = Number(lvl.sz);
      if (!isFinite(px) || !isFinite(sz)) continue;
      cum += sz;
      if (px > hi) { askPts.push({ px: hi, cum }); break; }
      askPts.push({ px, cum });
    }
    return { bidPts, askPts, lo, hi };
  }

  function sizeDepthCanvas(){
    if (!depthCanvas) return false;
    const wrap = depthCanvas.parentElement;
    if (!wrap) return false;
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    depthW = Math.max(120, Math.round(r.width));
    depthH = Math.max(120, Math.round(r.height));
    depthCanvas.width = depthW * dpr;
    depthCanvas.height = depthH * dpr;
    depthCanvas.style.width = depthW + "px";
    depthCanvas.style.height = depthH + "px";
    depthCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function queueDepth(){
    if (depthRAF) return;
    depthRAF = requestAnimationFrame(() => { depthRAF = 0; drawDepth(); });
  }

  function drawDepth(){
    if (!depthCtx || !active) return;
    if (!sizeDepthCanvas()) return;
    const g = depthCtx;
    g.clearRect(0, 0, depthW, depthH);

    const { bestBid, bestAsk } = bestPrices();
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0){
      g.fillStyle = COL.mute;
      g.font = "11px 'Geist Mono', ui-monospace, monospace";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("waiting for book…", depthW / 2, depthH / 2);
      if (depthReadout) depthReadout.textContent = "";
      return;
    }
    const mid = (bestBid + bestAsk) / 2;
    const { bidPts, askPts, lo, hi } = buildLadders(mid);

    const padB = 18, padT = 8;
    const plotH = depthH - padB - padT;
    const halfW = depthW / 2;
    const span = hi - lo;
    const maxCum = Math.max(
      1e-9,
      bidPts.length ? bidPts[bidPts.length - 1].cum : 0,
      askPts.length ? askPts[askPts.length - 1].cum : 0
    );

    // x: price → pixel (mid at centre). y: cumulative size → pixel.
    const xOf = (px) => ((px - lo) / span) * depthW;
    const yOf = (cum) => padT + plotH - (cum / maxCum) * plotH;

    // stepped area for one side. pts must start at the inner edge (mid).
    function drawSide(pts, edgeX, col){
      if (!pts.length) return;
      const fill = withAlpha(col, 0.16);
      g.beginPath();
      g.moveTo(edgeX, padT + plotH);          // bottom at mid
      g.lineTo(edgeX, yOf(pts[0].cum));        // up to first cum at mid
      let prevX = edgeX, prevY = yOf(pts[0].cum);
      for (let i = 0; i < pts.length; i++){
        const x = xOf(pts[i].px);
        const y = yOf(pts[i].cum);
        g.lineTo(x, prevY);                    // horizontal step
        g.lineTo(x, y);                        // vertical step
        prevX = x; prevY = y;
      }
      g.lineTo(prevX, padT + plotH);           // close down to baseline
      g.closePath();
      g.fillStyle = fill; g.fill();

      // crisp outline along the top of the step
      g.beginPath();
      g.moveTo(edgeX, yOf(pts[0].cum));
      prevY = yOf(pts[0].cum);
      for (let i = 0; i < pts.length; i++){
        const x = xOf(pts[i].px), y = yOf(pts[i].cum);
        g.lineTo(x, prevY); g.lineTo(x, y); prevY = y;
      }
      g.strokeStyle = col; g.lineWidth = 1.4; g.stroke();
    }

    drawSide(bidPts, halfW, COL.long);
    drawSide(askPts, halfW, COL.short);

    // mid divider
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(halfW, padT); g.lineTo(halfW, padT + plotH); g.stroke();

    // axis labels: lo, mid, hi
    g.font = "10px 'Geist Mono', ui-monospace, monospace";
    g.fillStyle = COL.mute; g.textBaseline = "alphabetic";
    g.textAlign = "left";   g.fillText(pxStr(lo), 3, depthH - 5);
    g.textAlign = "center"; g.fillText(pxStr(mid), halfW, depthH - 5);
    g.textAlign = "right";  g.fillText(pxStr(hi), depthW - 3, depthH - 5);

    // hover crosshair + readout (price + cumulative size on the hovered side)
    if (hoverX >= 0 && hoverX <= depthW){
      const pxAt = lo + (hoverX / depthW) * span;
      const onBid = hoverX <= halfW;
      const pts = onBid ? bidPts : askPts;
      const col = onBid ? COL.long : COL.short;
      // cumulative size at this price: walk the ladder.
      let cumAt = 0;
      if (onBid){
        for (const p of pts){ if (p.px >= pxAt) cumAt = p.cum; else break; }
      } else {
        for (const p of pts){ if (p.px <= pxAt) cumAt = p.cum; else break; }
      }
      g.strokeStyle = "rgba(255,255,255,.22)"; g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hoverX, padT); g.lineTo(hoverX, padT + plotH); g.stroke();
      g.setLineDash([]);
      const y = yOf(cumAt);
      g.fillStyle = col;
      g.beginPath(); g.arc(hoverX, y, 3, 0, Math.PI * 2); g.fill();
      if (depthReadout){
        depthReadout.innerHTML =
          '<span class="' + (onBid ? "hl-up" : "hl-dn") + '">' +
          pxStr(pxAt) + ' · ' + szStr(cumAt) + ' ' + escapeText(coin) +
          '</span>';
      }
    } else if (depthReadout){
      const spread = bestAsk - bestBid;
      depthReadout.textContent =
        "spread " + pxStr(spread) + " · " + (spread / mid * 1e4).toFixed(1) + " bps";
    }
  }

  function onDepthHover(e){
    if (!depthCanvas) return;
    const r = depthCanvas.getBoundingClientRect();
    hoverX = e.clientX - r.left;
    queueDepth();
  }

  /* ─── trades tape ────────────────────────────────────────── */
  function escapeText(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderTape(){
    if (!tapeList) return;
    if (!trades.length){
      tapeList.innerHTML = '<div class="hl-tape-empty">waiting for trades…</div>';
      return;
    }
    const rows = trades.map((t, i) => {
      const buy = t.side === "B";
      const fresh = (!reduceMotion && i === 0 && t._new) ? " is-new" : "";
      return '<div class="hl-tape-row ' + (buy ? "buy" : "sell") + fresh + '">' +
        '<span class="hl-tp">' + escapeText(pxStr(t.px)) + '</span>' +
        '<span class="hl-ts">' + escapeText(szStr(t.sz)) + '</span>' +
        '<span class="hl-tt">' + escapeText(TIME_FMT.format(t.time)) + '</span>' +
      '</div>';
    });
    tapeList.innerHTML = rows.join("");
    // clear the one-shot "new" marker so re-renders don't re-flash old rows
    for (const t of trades) t._new = false;

    // spread chip from current best book
    if (tapeSpread){
      const { bestBid, bestAsk } = bestPrices();
      if (isFinite(bestBid) && isFinite(bestAsk) && bestBid > 0 && bestAsk > 0){
        const mid = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        tapeSpread.textContent = (spread / mid * 1e4).toFixed(1) + " bps";
      } else tapeSpread.textContent = "";
    }
  }

  function pushTrades(arr){
    const incoming = arr
      .filter(x => x && x.coin === coin)
      .map(x => ({ px: Number(x.px), sz: Number(x.sz), side: x.side, time: Number(x.time) || Date.now(), _new: true }))
      .filter(x => isFinite(x.px) && isFinite(x.sz));
    if (!incoming.length) return;
    // WS pushes oldest→newest within a batch; we want newest on top.
    incoming.reverse();
    trades = incoming.concat(trades).slice(0, TAPE_CAP);
    renderTape();
  }

  /* ─── snapshot fallback ──────────────────────────────────── */
  async function loadSnapshot(){
    const c = coin;
    try {
      const data = await HL.l2Book(c);
      if (c !== coin) return;            // coin changed mid-flight; drop
      if (data && data.levels){
        book = { bids: data.levels[0] || [], asks: data.levels[1] || [] };
        if (active) queueDepth();
      }
    } catch { /* keep last book */ }
  }

  /* ─── WS lifecycle ───────────────────────────────────────── */
  function subscribeCoin(){
    unsubscribeCoin();
    try {
      perCoinUnsubs = [
        HL.ws.subscribe({ type: "l2Book", coin }),
        HL.ws.subscribe({ type: "trades", coin }),
      ];
    } catch { perCoinUnsubs = []; }
  }
  function unsubscribeCoin(){
    perCoinUnsubs.forEach(fn => { try { fn && fn(); } catch {} });
    perCoinUnsubs = [];
  }

  function resubscribe(newCoin){
    if (newCoin) coin = newCoin;
    // fresh state for the new coin so we don't mix books/trades
    book = { bids: [], asks: [] };
    trades = [];
    renderTape();
    queueDepth();
    if (!active) return;
    subscribeCoin();
    loadSnapshot();
  }

  /* ─── activate / deactivate ──────────────────────────────── */
  function activate(){
    if (active) return;
    active = true;
    coin = coinNow();
    subscribeCoin();
    loadSnapshot();
    // periodic snapshot top-up in case the WS book goes quiet
    snapTimer = setInterval(() => { if (active) loadSnapshot(); }, 15_000);
    renderTape();
    queueDepth();
  }
  function deactivate(){
    if (!active) return;
    active = false;
    unsubscribeCoin();
    clearInterval(snapTimer); snapTimer = null;
    if (depthRAF){ cancelAnimationFrame(depthRAF); depthRAF = 0; }
  }

  /* ─── event-bus + window wiring ──────────────────────────── */
  function wireEvents(){
    busUnsubs.push(HL.on("ws:l2Book", (d) => {
      if (!d || d.coin !== coin || !d.levels) return;
      book = { bids: d.levels[0] || [], asks: d.levels[1] || [] };
      if (active) queueDepth();
      // refresh the tape's spread chip cheaply without rebuilding rows
      if (active && tapeSpread){
        const { bestBid, bestAsk } = bestPrices();
        if (isFinite(bestBid) && isFinite(bestAsk) && bestBid > 0 && bestAsk > 0){
          const mid = (bestBid + bestAsk) / 2;
          tapeSpread.textContent = ((bestAsk - bestBid) / mid * 1e4).toFixed(1) + " bps";
        }
      }
    }));
    busUnsubs.push(HL.on("ws:trades", (arr) => {
      if (!Array.isArray(arr) || !arr.length || !active) return;
      pushTrades(arr);
    }));

    const onCoin = (e) => resubscribe((e && e.detail && e.detail.coin) || coinNow());
    const onNet  = () => resubscribe(coinNow());   // ws reconnected on net switch
    const onRoute = (e) => {
      const r = e && e.detail && e.detail.route;
      if (r === "trade") activate(); else deactivate();
    };
    window.addEventListener("lz:hl:coin", onCoin);
    window.addEventListener("lz:hl:net", onNet);
    window.addEventListener("lz:route", onRoute);
    busUnsubs.push(() => window.removeEventListener("lz:hl:coin", onCoin));
    busUnsubs.push(() => window.removeEventListener("lz:hl:net", onNet));
    busUnsubs.push(() => window.removeEventListener("lz:route", onRoute));
  }

  /* ─── boot ───────────────────────────────────────────────── */
  buildDepthCard();
  buildTapeCard();
  renderTape();
  wireEvents();

  // If the app deep-links straight to #/trade, the initial lz:route event
  // already fired before this module loaded — activate now to match.
  const initialRoute = (location.hash || "").replace(/^#\/?/, "").split("/")[0];
  if (initialRoute === "trade") activate();
})();
