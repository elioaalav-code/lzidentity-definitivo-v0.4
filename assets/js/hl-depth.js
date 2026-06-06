/* =====================================================================
 *  hl-depth.js — ORDER-BOOK DEPTH CHART + LIVE TRADES TAPE  (v2.2 elevation)
 *  ---------------------------------------------------------------------
 *  Owned by the DEPTH+TAPE agent. Owns this file and
 *  assets/css/hl-depth.css only.
 *
 *  1) cumulative DEPTH CHART  — bids green (left), asks red (right),
 *     mirrored around mid, stepped area fills with horizontal gradient
 *     denser near mid, crisp accent mid-price pill, subtle grid,
 *     cumulative-size axis ticks, hover readout (price · cumsum · % mid).
 *     Depth-zoom pill buttons (±0.5/1/2/5%), persisted in localStorage.
 *     Redraws on lz:hl:addontab { tab:"depth" } and ResizeObserver.
 *
 *  2) recent-TRADES TAPE      — perfectly tabular rows (time · price · size),
 *     side-coloured, directional flash on new rows, thin custom scrollbar,
 *     thin mono header.  Buys / Sells / All filter (tiny toggle).
 *     Capped to ~120 rows.
 *
 *  DATA: keyless HL layer (./hyperliquid.js).
 *    WS:   HL.ws.subscribe({type:"l2Book",coin})  -> push "ws:l2Book"
 *          HL.ws.subscribe({type:"trades",coin})  -> push "ws:trades"
 *    REST: HL.l2Book(coin) snapshot for the initial paint / WS-quiet.
 *
 *  Lifecycle: only active while the trade view is visible. Re-subscribes
 *  on "lz:hl:coin" and "lz:hl:net" (ws reconnect), unsubscribing the old
 *  coin's feeds first. No build, no libs — pure DOM + canvas.
 *
 *  Visibility contract: the coordinator dispatches
 *    window.dispatchEvent(new CustomEvent("lz:hl:addontab",
 *      { detail: { tab: "depth" | "trades" } }))
 *  when a tabbed pane is shown. We listen and redraw if detail.tab==="depth".
 *  ResizeObserver is a fallback.  Zero-size guards prevent degenerate draws.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";

(function initHlDepth(){
  const depthMount = document.getElementById("hlDepthMount");
  const tapeMount  = document.getElementById("hlTradesMount");
  if (!depthMount && !tapeMount) return;

  /* ─── helpers ────────────────────────────────────────────── */
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
    if (n >= 1e6)  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (n >= 1)    return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  function szStr(n){
    n = Number(n);
    if (!isFinite(n)) return "—";
    if (Math.abs(n) >= 1e6)  return (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  const TIME_FMT = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });

  // Resolve design-system colour tokens once.
  const COL = (() => {
    let cs;
    try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
    const g = (k, fb) => { try { return (cs && cs.getPropertyValue(k).trim()) || fb; } catch { return fb; } };
    return {
      long:    g("--long",       "#3fb98a"),
      short:   g("--short",      "#e0556b"),
      accent:  g("--accent",     "#b39aff"),
      accent2: g("--accent-2",   "#5eead4"),
      surface: g("--surface-2",  "#15151a"),
      text:    g("--text-dim",   "#a0a0a8"),
      mute:    g("--text-mute",  "#6b6b75"),
      border:  g("--border",     "rgba(255,255,255,.08)"),
    };
  })();

  function withAlpha(hex, a){
    if (typeof hex !== "string") return hex;
    let h = hex.trim();
    if (h[0] !== "#") return hex;
    h = h.slice(1);
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16),
          gg = parseInt(h.slice(2, 4), 16),
          b  = parseInt(h.slice(4, 6), 16);
    if ([r, gg, b].some(v => Number.isNaN(v))) return hex;
    return `rgba(${r},${gg},${b},${a})`;
  }

  function escapeText(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ─── zoom state ─────────────────────────────────────────── */
  const ZOOM_OPTS = [0.005, 0.01, 0.02, 0.05];
  const ZOOM_LABELS = ["±0.5%", "±1%", "±2%", "±5%"];
  const LS_ZOOM_KEY = "lz_hl_depth_zoom";
  let zoomIdx = (() => {
    try {
      const v = localStorage.getItem(LS_ZOOM_KEY);
      if (v != null){
        const n = parseInt(v, 10);
        if (n >= 0 && n < ZOOM_OPTS.length) return n;
      }
    } catch {}
    return 2; // default ±2%
  })();

  function setZoom(idx){
    if (idx < 0 || idx >= ZOOM_OPTS.length) return;
    zoomIdx = idx;
    try { localStorage.setItem(LS_ZOOM_KEY, String(idx)); } catch {}
    updateZoomButtons();
    if (active) queueDepth();
  }

  let zoomButtons = []; // filled after DOM build
  function updateZoomButtons(){
    zoomButtons.forEach((btn, i) => {
      if (i === zoomIdx) btn.classList.add("on");
      else btn.classList.remove("on");
    });
  }

  /* ─── tape filter state ──────────────────────────────────── */
  const TAPE_FILTERS = ["all", "buy", "sell"];
  let tapeFilter = "all"; // "all" | "buy" | "sell"
  let tapeFilterButtons = [];

  function setTapeFilter(f){
    if (!TAPE_FILTERS.includes(f)) return;
    tapeFilter = f;
    tapeFilterButtons.forEach(btn => {
      btn.classList.toggle("on", btn.dataset.filter === f);
    });
    renderTape();
  }

  /* ─── module state ───────────────────────────────────────── */
  let active = false;
  let coin = coinNow();
  let book = { bids: [], asks: [] };
  let trades = [];
  const TAPE_CAP = 120;

  let perCoinUnsubs = [];
  let busUnsubs = [];
  let snapTimer = null;
  let depthRAF = 0;

  /* ─── DOM refs ────────────────────────────────────────────── */
  let depthCanvas = null, depthCtx = null, depthReadout = null;
  let depthW = 0, depthH = 0;
  let tapeList = null;
  let depthBody = null;
  let depthImbalanceEl = null;  // [ADD] bottom-corner depth imbalance readout
  let tapePressureBar = null;   // [ADD] buy/sell pressure bar element

  /* ─── build DOM ───────────────────────────────────────────── */
  function buildDepthCard(){
    if (!depthMount) return;
    const card = document.createElement("div");
    card.className = "hl-depth-card book-card";

    // Header: thin mono readout strip
    const head = document.createElement("div");
    head.className = "hl-depth-head";

    const headLeft = document.createElement("span");
    headLeft.className = "hl-depth-label";
    headLeft.textContent = "Depth";

    const readout = document.createElement("span");
    readout.className = "hl-depth-readout";

    head.append(headLeft, readout);
    card.appendChild(head);

    // Zoom pill buttons
    const zoomRow = document.createElement("div");
    zoomRow.className = "hl-depth-zoom";
    zoomButtons = [];
    ZOOM_LABELS.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.className = "hl-zoom-btn" + (i === zoomIdx ? " on" : "");
      btn.textContent = label;
      btn.dataset.zoom = String(i);
      btn.addEventListener("click", () => setZoom(i));
      zoomRow.appendChild(btn);
      zoomButtons.push(btn);
    });
    card.appendChild(zoomRow);

    // Canvas body
    const body = document.createElement("div");
    body.className = "hl-depth-body";
    const canvas = document.createElement("canvas");
    canvas.className = "hl-depth-canvas";
    body.appendChild(canvas);

    // [ADD] depth imbalance readout — positioned bottom-right corner of the body
    const imbalEl = document.createElement("div");
    imbalEl.className = "hl-depth-imbal";
    body.appendChild(imbalEl);

    card.appendChild(body);

    depthMount.replaceChildren(card);
    depthCanvas       = canvas;
    depthReadout      = readout;
    depthBody         = body;
    depthImbalanceEl  = imbalEl;   // [ADD]
    depthCtx          = canvas.getContext("2d");

    canvas.addEventListener("mousemove", onDepthHover);
    canvas.addEventListener("mouseleave", () => { hoverX = -1; queueDepth(); });

    if (depthBody && typeof ResizeObserver !== "undefined"){
      const ro = new ResizeObserver(() => {
        if (active) queueDepth();
      });
      ro.observe(depthBody);
    }
  }

  function buildTapeCard(){
    if (!tapeMount) return;
    const card = document.createElement("div");
    card.className = "hl-tape-card book-card";

    // Header
    const head = document.createElement("div");
    head.className = "hl-tape-head";

    const headLabel = document.createElement("span");
    headLabel.className = "hl-tape-label";
    headLabel.textContent = "Trades";

    // Filter toggle: All / Buys / Sells
    const filterRow = document.createElement("div");
    filterRow.className = "hl-tape-filter";
    tapeFilterButtons = [];
    [["all","All"],["buy","Buys"],["sell","Sells"]].forEach(([key, label]) => {
      const btn = document.createElement("button");
      btn.className = "hl-tfilter-btn" + (tapeFilter === key ? " on" : "");
      btn.dataset.filter = key;
      btn.textContent = label;
      btn.addEventListener("click", () => setTapeFilter(key));
      filterRow.appendChild(btn);
      tapeFilterButtons.push(btn);
    });

    head.append(headLabel, filterRow);
    card.appendChild(head);

    // [ADD] buy/sell pressure bar — compact strip between header and col labels
    const pressureWrap = document.createElement("div");
    pressureWrap.className = "hl-tape-pressure";

    const pressureText = document.createElement("span");
    pressureText.className = "hl-tape-pressure-text";

    const pressureTrack = document.createElement("div");
    pressureTrack.className = "hl-tape-pressure-track";

    const pressureFill = document.createElement("div");
    pressureFill.className = "hl-tape-pressure-fill";
    pressureTrack.appendChild(pressureFill);

    pressureWrap.append(pressureText, pressureTrack);
    card.appendChild(pressureWrap);
    tapePressureBar = { text: pressureText, fill: pressureFill };

    // Column header
    const cols = document.createElement("div");
    cols.className = "hl-tape-cols";
    cols.innerHTML =
      "<span>Time</span><span>Price</span><span>Size</span>";
    card.appendChild(cols);

    // Scrollable list
    const list = document.createElement("div");
    list.className = "hl-tape-list";
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "off");
    list.setAttribute("aria-label", "Recent trades");
    card.appendChild(list);

    tapeMount.replaceChildren(card);
    tapeList = list;
  }

  /* ─── depth chart math ───────────────────────────────────── */
  let hoverX = -1;

  function currentWindow(){
    return ZOOM_OPTS[zoomIdx] || 0.02;
  }

  function bestPrices(){
    const b = book.bids && book.bids[0] ? Number(book.bids[0].px) : NaN;
    const a = book.asks && book.asks[0] ? Number(book.asks[0].px) : NaN;
    return { bestBid: b, bestAsk: a };
  }

  /**
   * Build cumulative ladders within ±WINDOW of mid.
   * bidPts: sorted by price descending (nearest mid first).
   * askPts: sorted by price ascending (nearest mid first).
   */
  function buildLadders(mid){
    const w = currentWindow();
    const lo = mid * (1 - w), hi = mid * (1 + w);
    const bidPts = [];
    let cum = 0;
    for (const lvl of (book.bids || [])){
      const px = Number(lvl.px), sz = Number(lvl.sz);
      if (!isFinite(px) || !isFinite(sz) || sz <= 0) continue;
      if (px < lo) { bidPts.push({ px: lo, cum }); break; }
      cum += sz;
      bidPts.push({ px, cum });
    }
    const askPts = [];
    cum = 0;
    for (const lvl of (book.asks || [])){
      const px = Number(lvl.px), sz = Number(lvl.sz);
      if (!isFinite(px) || !isFinite(sz) || sz <= 0) continue;
      if (px > hi) { askPts.push({ px: hi, cum }); break; }
      cum += sz;
      askPts.push({ px, cum });
    }
    return { bidPts, askPts, lo, hi };
  }

  /**
   * Measure the canvas wrapper and set device-pixel-ratio-aware dimensions.
   * Returns false if the container has zero size (do not draw).
   */
  function sizeDepthCanvas(){
    if (!depthCanvas || !depthBody) return false;
    const r = depthBody.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 4 || h < 4) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    depthW = w;
    depthH = h;
    depthCanvas.width  = w * dpr;
    depthCanvas.height = h * dpr;
    depthCanvas.style.width  = w + "px";
    depthCanvas.style.height = h + "px";
    depthCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function queueDepth(){
    if (depthRAF) return;
    depthRAF = requestAnimationFrame(() => { depthRAF = 0; drawDepth(); });
  }

  /* ─── depth chart draw ────────────────────────────────────── */
  function drawDepth(){
    if (!depthCtx || !active) return;
    if (!sizeDepthCanvas()) return;

    const g = depthCtx;
    const W = depthW, H = depthH;
    g.clearRect(0, 0, W, H);

    const { bestBid, bestAsk } = bestPrices();
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0){
      drawEmpty(g, W, H, "waiting for book…");
      if (depthReadout) depthReadout.textContent = "";
      return;
    }

    const mid  = (bestBid + bestAsk) / 2;
    const { bidPts, askPts, lo, hi } = buildLadders(mid);
    updateDepthImbalance(bidPts, askPts); // [ADD]

    const PAD_B = 24; // bottom axis labels
    const PAD_T = 10; // top — room for mid pill
    const PAD_L = 44; // left — cumulative size axis
    const PAD_R = 4;
    const plotH = H - PAD_B - PAD_T;
    const plotW = W - PAD_L - PAD_R;
    const halfX = PAD_L + plotW / 2; // mid x-position
    const span  = hi - lo;

    if (span <= 0 || plotH <= 0) return;

    const maxCum = Math.max(
      1e-9,
      bidPts.length ? bidPts[bidPts.length - 1].cum : 0,
      askPts.length ? askPts[askPts.length - 1].cum : 0
    );

    // Coordinate helpers
    const xOf  = (px)  => PAD_L + ((px - lo) / span) * plotW;
    const yOf  = (cum) => PAD_T + plotH - (cum / maxCum) * plotH;
    const base = PAD_T + plotH; // y baseline

    // ── background fills per side (lighter base) ─────────────
    // Left (bids) background tint
    g.fillStyle = "rgba(63,185,138,.025)";
    g.fillRect(PAD_L, PAD_T, plotW / 2, plotH);
    // Right (asks) background tint
    g.fillStyle = "rgba(224,85,107,.025)";
    g.fillRect(halfX, PAD_T, plotW / 2, plotH);

    // ── subtle horizontal grid + size ticks ──────────────────
    const GRID_LINES = 4;
    g.strokeStyle = "rgba(255,255,255,.04)";
    g.lineWidth   = 1;
    for (let i = 1; i <= GRID_LINES; i++){
      const y = PAD_T + (plotH / GRID_LINES) * i;
      g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(W - PAD_R, y); g.stroke();

      // Cumulative size axis tick + label (on left spine)
      if (i < GRID_LINES){
        const cumVal = maxCum * (1 - i / GRID_LINES);
        const label  = szStr(cumVal);
        g.fillStyle    = COL.mute;
        g.font         = "8.5px 'Geist Mono',ui-monospace,monospace";
        g.textAlign    = "right";
        g.textBaseline = "middle";
        g.fillText(label, PAD_L - 5, y);
      }
    }

    // ── size axis spine ───────────────────────────────────────
    g.strokeStyle = "rgba(255,255,255,.06)";
    g.lineWidth   = 1;
    g.beginPath();
    g.moveTo(PAD_L, PAD_T);
    g.lineTo(PAD_L, base);
    g.stroke();

    // ── stepped area fill + outline for one side ─────────────
    function drawSide(pts, col, isLeft){
      if (!pts.length) return;

      // Horizontal gradient — denser (higher alpha) near mid
      let grad;
      if (isLeft){
        grad = g.createLinearGradient(PAD_L, 0, halfX, 0);
        grad.addColorStop(0, withAlpha(col, 0));
        grad.addColorStop(0.5, withAlpha(col, 0.06));
        grad.addColorStop(1, withAlpha(col, 0.22));
      } else {
        grad = g.createLinearGradient(halfX, 0, W - PAD_R, 0);
        grad.addColorStop(0, withAlpha(col, 0.22));
        grad.addColorStop(0.5, withAlpha(col, 0.06));
        grad.addColorStop(1, withAlpha(col, 0));
      }

      // Area fill path (stepped)
      const innerX = isLeft ? halfX : halfX;
      g.beginPath();
      g.moveTo(innerX, base);
      g.lineTo(innerX, yOf(pts[0].cum));
      let prevY = yOf(pts[0].cum);
      for (let i = 0; i < pts.length; i++){
        const x = xOf(pts[i].px);
        const y = yOf(pts[i].cum);
        g.lineTo(x, prevY);
        g.lineTo(x, y);
        prevY = y;
      }
      const edgeX = isLeft ? PAD_L : W - PAD_R;
      g.lineTo(edgeX, prevY);
      g.lineTo(edgeX, base);
      g.closePath();
      g.fillStyle = grad;
      g.fill();

      // Stroke — crisp stepped curve outline
      g.beginPath();
      g.moveTo(innerX, yOf(pts[0].cum));
      prevY = yOf(pts[0].cum);
      for (let i = 0; i < pts.length; i++){
        const x = xOf(pts[i].px);
        const y = yOf(pts[i].cum);
        g.lineTo(x, prevY);
        g.lineTo(x, y);
        prevY = y;
      }
      g.lineTo(edgeX, prevY);
      g.strokeStyle = withAlpha(col, 0.72);
      g.lineWidth   = 1.25;
      g.stroke();
    }

    drawSide(bidPts, COL.long,  true);
    drawSide(askPts, COL.short, false);

    // ── [ADD] faint solid mid vertical line (sits behind dashed divider) ──
    g.save();
    g.strokeStyle = "rgba(255,255,255,.055)";
    g.lineWidth   = 1;
    g.beginPath(); g.moveTo(halfX, PAD_T); g.lineTo(halfX, base); g.stroke();
    g.restore();

    // ── mid vertical divider (dashed accent, existing) ────────
    g.save();
    g.strokeStyle = withAlpha(COL.accent, 0.28);
    g.lineWidth   = 1;
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(halfX, PAD_T); g.lineTo(halfX, base); g.stroke();
    g.setLineDash([]);
    g.restore();

    // ── mid price pill ────────────────────────────────────────
    const midLabel = pxStr(mid);
    g.font = "10px 'Geist Mono',ui-monospace,monospace";
    const mlW = g.measureText(midLabel).width + 12;
    const mlH = 16;
    const mlY = PAD_T - mlH / 2 - 1;

    // pill fill
    g.fillStyle = withAlpha(COL.accent, 0.14);
    roundRect(g, halfX - mlW / 2, mlY, mlW, mlH, 5);
    g.fill();
    // pill border
    g.strokeStyle = withAlpha(COL.accent, 0.35);
    g.lineWidth = 1;
    roundRect(g, halfX - mlW / 2, mlY, mlW, mlH, 5);
    g.stroke();
    // pill text
    g.fillStyle    = COL.accent;
    g.textAlign    = "center";
    g.textBaseline = "middle";
    g.fillText(midLabel, halfX, mlY + mlH / 2 + 0.5);

    // ── bottom axis price labels ──────────────────────────────
    g.font         = "9px 'Geist Mono',ui-monospace,monospace";
    g.fillStyle    = COL.mute;
    g.textBaseline = "alphabetic";
    g.textAlign    = "left";
    g.fillText(pxStr(lo), PAD_L + 3, H - 6);
    g.textAlign    = "right";
    g.fillText(pxStr(hi), W - PAD_R - 3, H - 6);

    // ── hover crosshair + dot + floating tag ──────────────────
    if (hoverX >= PAD_L && hoverX <= W - PAD_R){
      const pxAt  = lo + ((hoverX - PAD_L) / plotW) * span;
      const onBid = hoverX <= halfX;
      const pts   = onBid ? bidPts : askPts;
      const col   = onBid ? COL.long : COL.short;

      // binary-search cumulative size at this price
      let cumAt = 0;
      if (onBid){
        for (const p of pts){ if (p.px >= pxAt) cumAt = p.cum; else break; }
      } else {
        for (const p of pts){ if (p.px <= pxAt) cumAt = p.cum; else break; }
      }

      const yDot = yOf(cumAt);
      const pctFromMid = ((pxAt - mid) / mid) * 100;

      // vertical dashed crosshair
      g.save();
      g.strokeStyle = "rgba(255,255,255,.14)";
      g.lineWidth   = 1;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hoverX, PAD_T); g.lineTo(hoverX, base); g.stroke();
      g.setLineDash([]);
      g.restore();

      // dot on curve
      g.fillStyle = col;
      g.beginPath(); g.arc(hoverX, yDot, 3.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = withAlpha(col, 0.45);
      g.lineWidth = 1.5;
      g.stroke();

      // Floating tag readout (price · cumsum · % from mid)
      const pctLabel = (pctFromMid >= 0 ? "+" : "") + pctFromMid.toFixed(2) + "%";
      const tagLines = [
        pxStr(pxAt),
        szStr(cumAt) + " " + coin,
        pctLabel,
      ];
      const tagFont = "9.5px 'Geist Mono',ui-monospace,monospace";
      g.font = tagFont;
      const lineH  = 13;
      const tagPad = 7;
      let tagW = 0;
      tagLines.forEach(l => { tagW = Math.max(tagW, g.measureText(l).width); });
      tagW += tagPad * 2;
      const tagH = tagLines.length * lineH + tagPad * 2;

      // Position: right of cursor unless too close to right edge
      let tagX = hoverX + 10;
      if (tagX + tagW > W - 4) tagX = hoverX - tagW - 10;
      let tagY = yDot - tagH / 2;
      tagY = Math.max(PAD_T + 2, Math.min(base - tagH - 2, tagY));

      // tag background
      g.fillStyle = "rgba(21,21,26,.92)";
      roundRect(g, tagX, tagY, tagW, tagH, 5);
      g.fill();
      g.strokeStyle = withAlpha(col, 0.4);
      g.lineWidth   = 1;
      roundRect(g, tagX, tagY, tagW, tagH, 5);
      g.stroke();

      // tag text lines
      tagLines.forEach((line, li) => {
        g.textAlign    = "left";
        g.textBaseline = "top";
        if (li === 0) g.fillStyle = col;
        else if (li === 2) g.fillStyle = COL.mute;
        else g.fillStyle = COL.text;
        g.fillText(line, tagX + tagPad, tagY + tagPad + li * lineH);
      });

      // update DOM readout too
      if (depthReadout){
        depthReadout.innerHTML =
          '<span class="' + (onBid ? "hl-up" : "hl-dn") + '">' +
          escapeText(pxStr(pxAt)) +
          '</span> · ' +
          escapeText(szStr(cumAt)) + " " + escapeText(coin) +
          ' <span class="hl-depth-pct">' +
          escapeText(pctLabel) +
          "</span>";
      }
    } else if (depthReadout){
      // default: spread readout
      const spread = bestAsk - bestBid;
      depthReadout.textContent =
        "spread " + pxStr(spread) + " · " + (spread / mid * 1e4).toFixed(1) + " bps";
    }
  }

  function drawEmpty(g, W, H, msg){
    if (depthImbalanceEl) depthImbalanceEl.textContent = ""; // [ADD] clear on empty
    g.fillStyle    = COL.mute;
    g.font         = "11px 'Geist Mono',ui-monospace,monospace";
    g.textAlign    = "center";
    g.textBaseline = "middle";
    g.fillText(msg, W / 2, H / 2);
  }

  // [ADD] Update the bottom-corner DOM imbalance readout from ladder data.
  function updateDepthImbalance(bidPts, askPts){
    if (!depthImbalanceEl) return;
    const totalBid = bidPts.length ? bidPts[bidPts.length - 1].cum : 0;
    const totalAsk = askPts.length ? askPts[askPts.length - 1].cum : 0;
    const total = totalBid + totalAsk;
    if (!total || !isFinite(total)){
      depthImbalanceEl.textContent = "";
      return;
    }
    const bidPct = Math.round((totalBid / total) * 100);
    const askPct = 100 - bidPct;
    const diff   = bidPct - askPct;
    const sign   = diff > 0 ? "+" : "";
    depthImbalanceEl.textContent =
      "B " + szStr(totalBid) + "  A " + szStr(totalAsk) + "  " + sign + diff + "%";
    // colour the element based on imbalance direction
    if (diff > 2)       depthImbalanceEl.dataset.side = "bid";
    else if (diff < -2) depthImbalanceEl.dataset.side = "ask";
    else                depthImbalanceEl.dataset.side = "neutral";
  }

  /** Minimal roundRect polyfill for older Safari. */
  function roundRect(g, x, y, w, h, r){
    if (g.roundRect){
      g.beginPath(); g.roundRect(x, y, w, h, r); return;
    }
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  function onDepthHover(e){
    if (!depthCanvas) return;
    const r = depthCanvas.getBoundingClientRect();
    hoverX = e.clientX - r.left;
    queueDepth();
  }

  /* ─── trades tape ─────────────────────────────────────────── */
  function filteredTrades(){
    if (tapeFilter === "all") return trades;
    if (tapeFilter === "buy")  return trades.filter(t => t.side === "B");
    if (tapeFilter === "sell") return trades.filter(t => t.side !== "B");
    return trades;
  }

  // [ADD] Update the buy/sell pressure bar from the visible trade set.
  function updatePressureBar(){
    if (!tapePressureBar) return;
    const visible = filteredTrades();
    let buys = 0, sells = 0;
    for (const t of visible){
      if (t.side === "B") buys++; else sells++;
    }
    const total = buys + sells;
    if (!total){
      tapePressureBar.text.textContent = "—";
      tapePressureBar.fill.style.width = "50%";
      return;
    }
    const buyPct  = Math.round((buys  / total) * 100);
    const sellPct = 100 - buyPct;
    tapePressureBar.text.textContent =
      "BUY " + buyPct + "% · SELL " + sellPct + "%";
    tapePressureBar.fill.style.width = buyPct + "%";
  }

  function renderTape(){
    if (!tapeList) return;
    updatePressureBar(); // [ADD] refresh pressure bar on every render
    const visible = filteredTrades();
    if (!visible.length){
      tapeList.innerHTML = '<div class="hl-tape-empty">waiting for trades…</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    visible.forEach((t, i) => {
      const buy   = t.side === "B";
      const fresh = (!reduceMotion && i === 0 && t._new);
      const row   = document.createElement("div");
      row.className = "hl-tape-row " + (buy ? "buy" : "sell") + (fresh ? " is-new" : "");

      // time first in new column order: Time · Price · Size
      const tt = document.createElement("span");
      tt.className = "hl-tt";
      tt.textContent = TIME_FMT.format(t.time);

      const tp = document.createElement("span");
      tp.className = "hl-tp";
      tp.textContent = pxStr(t.px);

      const ts = document.createElement("span");
      ts.className = "hl-ts";
      ts.textContent = szStr(t.sz);

      row.append(tt, tp, ts);
      frag.appendChild(row);
    });
    tapeList.replaceChildren(frag);
    for (const t of trades) t._new = false;
  }

  function pushTrades(arr){
    const incoming = arr
      .filter(x => x && x.coin === coin)
      .map(x => ({
        px:   Number(x.px),
        sz:   Number(x.sz),
        side: x.side,
        time: Number(x.time) || Date.now(),
        _new: true,
      }))
      .filter(x => isFinite(x.px) && isFinite(x.sz));
    if (!incoming.length) return;
    incoming.reverse(); // WS pushes oldest→newest; reverse for newest-on-top
    trades = incoming.concat(trades).slice(0, TAPE_CAP);
    renderTape();
  }

  /* ─── snapshot fallback ──────────────────────────────────── */
  async function loadSnapshot(){
    const c = coin;
    try {
      const data = await HL.l2Book(c);
      if (c !== coin) return; // stale
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
    book   = { bids: [], asks: [] };
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

  /* ─── event bus wiring ───────────────────────────────────── */
  function wireEvents(){
    // HL data events
    busUnsubs.push(HL.on("ws:l2Book", (d) => {
      if (!d || d.coin !== coin || !d.levels) return;
      book = { bids: d.levels[0] || [], asks: d.levels[1] || [] };
      if (active) queueDepth();
    }));
    busUnsubs.push(HL.on("ws:trades", (arr) => {
      if (!Array.isArray(arr) || !arr.length || !active) return;
      pushTrades(arr);
    }));

    // Routing
    const onCoin  = (e) => resubscribe((e && e.detail && e.detail.coin) || coinNow());
    const onNet   = () => resubscribe(coinNow());
    const onRoute = (e) => {
      const r = e && e.detail && e.detail.route;
      if (r === "trade") activate(); else deactivate();
    };

    // Tab visibility: coordinator fires lz:hl:addontab when a pane is revealed.
    // For the depth chart we need to remeasure + redraw because the canvas
    // was sized when display:none (zero dimensions).
    const onAddonTab = (e) => {
      const tab = e && e.detail && e.detail.tab;
      if (tab === "depth" && active){
        // Use rAF so the pane's layout has settled before we measure.
        requestAnimationFrame(() => {
          hoverX = -1;
          queueDepth();
        });
      }
      // trades pane: re-render to apply fresh filter state
      if (tab === "trades"){
        renderTape();
      }
    };

    window.addEventListener("lz:hl:coin",     onCoin);
    window.addEventListener("lz:hl:net",      onNet);
    window.addEventListener("lz:route",       onRoute);
    window.addEventListener("lz:hl:addontab", onAddonTab);

    busUnsubs.push(() => window.removeEventListener("lz:hl:coin",     onCoin));
    busUnsubs.push(() => window.removeEventListener("lz:hl:net",      onNet));
    busUnsubs.push(() => window.removeEventListener("lz:route",       onRoute));
    busUnsubs.push(() => window.removeEventListener("lz:hl:addontab", onAddonTab));
  }

  /* ─── boot ───────────────────────────────────────────────── */
  buildDepthCard();
  buildTapeCard();
  renderTape();
  wireEvents();

  // If the app deep-links straight to #/trade the lz:route event already
  // fired before this module loaded — activate immediately.
  const initialRoute = (location.hash || "").replace(/^#\/?/, "").split("/")[0];
  if (initialRoute === "trade") activate();
})();
