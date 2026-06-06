/* =================================================================== *
 *  coin-page.js — internal market detail page (proprietary, no redirect)
 * ===================================================================
 *  CONTRACT (set by app.js scaffolding — do not change these anchors):
 *   · Route "coin" exists. Hash form: #/coin/<coingecko-id-or-symbol>.
 *   · The view is <section data-view="coin"> with an empty <div id="coinPage">.
 *   · app.js calls  window.LZ.coinPage.render(<id>)  on entering the route
 *     (ONROUTE.coin → getRouteParam()). So this module MUST set
 *     window.LZ.coinPage = { render }.
 *   · Market data helpers live in ./marketdata.js (keyless CoinGecko +
 *     DefiLlama): cgMarketData(id), cgChart(id, days), cgTopCoins, etc.
 *   · Navigate elsewhere with window.LZ.navigate("markets" | "trade").
 *   · Reuse the candle/line rendering style from trade.js (canvas) and the
 *     sparkline look from app.js — no external chart libraries, no build.
 *   · Style goes in assets/css/coin-page.css.
 * =================================================================== */

import * as MD from "./marketdata.js";
import * as fmt from "./fmt-num.js";

/* ─── Colour palette (resolved once from CSS vars) ─────────────── */
const COL = (() => {
  if (typeof document === "undefined") return {
    long: "#3fb98a", short: "#e0556b", accent: "#b39aff", ink: "#0a0a0c",
    mute: "rgba(160,160,168,.8)", grid: "rgba(255,255,255,.05)",
  };
  const cs = getComputedStyle(document.documentElement);
  const g = (k, fb) => (cs.getPropertyValue(k).trim() || fb);
  return {
    long:   g("--long",  "#3fb98a"),
    short:  g("--short", "#e0556b"),
    accent: g("--accent","#b39aff"),
    ink:    "#0a0a0c",
    mute:   "rgba(160,160,168,.8)",
    grid:   "rgba(255,255,255,.05)",
  };
})();

/* ─── Number formatters (all via the shared fmt-num.js module) ──── */
const fmtUSD    = (n) => fmt.usdCompact(n);   // market cap / volume / TVL
const fmtPct    = (n) => fmt.pct(n);
const fmtSupply = (n) => fmt.compact(n);
const fmtPx     = (n) => fmt.usd(n);          // $-prefixed price

/* ─── Chart range config ────────────────────────────────────────── */
const RANGES = [
  { label: "24h",  days: 1   },
  { label: "7d",   days: 7   },
  { label: "30d",  days: 30  },
  { label: "90d",  days: 90  },
  { label: "1y",   days: 365 },
];

/* ─── Module-level chart state ──────────────────────────────────── */
let _cv = null, _ctx = null, _candles = [], _rangeDays = 7;
let _chartW = 0, _chartH = 0;
let _hoverIdx = -1, _hoverY = -1;

const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/* ─── Canvas chart (mirrors trade.js drawChart approach) ─────────── */
function sizeCanvas() {
  if (!_cv) return;
  const wrap = _cv.parentElement;
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  _chartW = Math.max(300, r.width);
  _chartH = Math.max(220, r.height);
  _cv.width  = _chartW * dpr;
  _cv.height = _chartH * dpr;
  _cv.style.width  = _chartW + "px";
  _cv.style.height = _chartH + "px";
  _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawChart() {
  if (!_ctx) return;
  sizeCanvas();
  const g = _ctx;
  g.clearRect(0, 0, _chartW, _chartH);

  if (!_candles.length) {
    g.fillStyle = COL.mute;
    g.font = "12px 'Geist Mono', monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("No chart data available", _chartW / 2, _chartH / 2);
    return;
  }

  const padR = 68, padB = 24, padT = 12, padL = 10;
  const plotW = _chartW - padR - padL;
  const plotH = _chartH - padB - padT;

  const view = _candles.slice(-Math.min(_candles.length, 120));
  const n = view.length;

  let lo = Infinity, hi = -Infinity;
  for (const c of view) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
  lo -= pad; hi += pad;

  const yOf = (p) => padT + (hi - p) / (hi - lo) * plotH;
  const cw = plotW / n;
  const bodyW = Math.max(1, Math.min(14, cw * 0.65));

  /* grid + price axis */
  g.font = "10px 'Geist Mono', monospace";
  g.textBaseline = "middle";
  const lines = 5;
  for (let i = 0; i <= lines; i++) {
    const p = hi - (hi - lo) * (i / lines);
    const y = yOf(p);
    g.strokeStyle = COL.grid;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
    g.fillStyle = COL.mute;
    g.textAlign = "left";
    g.fillText(fmtPx(p), padL + plotW + 6, y);
  }

  /* time axis */
  const intraday = _rangeDays <= 1;
  const ticks = Math.min(6, n);
  g.fillStyle = "rgba(160,160,168,.7)";
  g.textBaseline = "alphabetic";
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round((i / (ticks - 1 || 1)) * (n - 1));
    const c = view[idx];
    if (!c) continue;
    const x = padL + idx * cw + cw / 2;
    g.textAlign = i === 0 ? "left" : (i === ticks - 1 ? "right" : "center");
    const lab = intraday ? TIME_FMT.format(new Date(c.t)) : DATE_FMT.format(new Date(c.t));
    g.fillText(lab, Math.max(padL, Math.min(padL + plotW, x)), _chartH - 7);
  }

  /* candles */
  for (let i = 0; i < n; i++) {
    const c = view[i];
    const x = padL + i * cw + cw / 2;
    const up = c.c >= c.o;
    const col = up ? COL.long : COL.short;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
    /* wick */
    g.beginPath(); g.moveTo(x, yOf(c.h)); g.lineTo(x, yOf(c.l)); g.stroke();
    /* body */
    const yO = yOf(c.o), yC = yOf(c.c);
    const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
    g.fillRect(x - bodyW / 2, top, bodyW, h);
  }

  /* last-price line + tag */
  const lastC = view[n - 1];
  if (lastC) {
    const lp = lastC.c;
    const y = yOf(lp);
    g.strokeStyle = "rgba(179,154,255,.5)"; g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
    g.setLineDash([]);
    /* pill tag */
    const tag = fmtPx(lp);
    g.fillStyle = COL.accent;
    g.fillRect(padL + plotW, yOf(lp) - 8, padR, 16);
    g.fillStyle = COL.ink;
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(tag, padL + plotW + 6, yOf(lp));
  }

  /* crosshair + readout */
  const readoutEl = _cv?.parentElement?.querySelector(".cp-readout");
  if (_hoverIdx >= 0 && _hoverIdx < n) {
    const c = view[_hoverIdx];
    const x = padL + _hoverIdx * cw + cw / 2;
    g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + plotH); g.stroke();
    if (_hoverY >= padT && _hoverY <= padT + plotH) {
      g.beginPath(); g.moveTo(padL, _hoverY); g.lineTo(padL + plotW, _hoverY); g.stroke();
      const pAt = hi - (_hoverY - padT) / plotH * (hi - lo);
      /* crosshair price tag */
      g.fillStyle = "rgba(20,20,26,.96)";
      g.fillRect(padL + plotW, _hoverY - 8, padR, 16);
      g.fillStyle = "#e8e8ee"; g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText(fmtPx(pAt), padL + plotW + 6, _hoverY);
    }
    g.setLineDash([]);

    if (readoutEl) {
      const up = c.c >= c.o;
      const dv = c.o ? ((c.c - c.o) / c.o * 100) : 0;
      readoutEl.innerHTML = `<span class="${up ? "cp-up" : "cp-dn"}">O ${fmtPx(c.o)} · H ${fmtPx(c.h)} · L ${fmtPx(c.l)} · C ${fmtPx(c.c)} · ${fmtPct(dv)}</span>`;
    }
  } else if (readoutEl) {
    readoutEl.textContent = "";
  }
}

/* ─── Wire canvas mouse events ──────────────────────────────────── */
function wireChartEvents(canvas) {
  if (!canvas) return;
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const padL = 10, padR = 68, padT = 12, padB = 24;
    const plotW = _chartW - padR - padL;
    const plotH = _chartH - padB - padT;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) {
      _hoverIdx = -1; _hoverY = -1;
    } else {
      const n = Math.min(_candles.length, 120);
      const cw = plotW / (n || 1);
      _hoverIdx = Math.max(0, Math.min(n - 1, Math.floor((mx - padL) / cw)));
      _hoverY = my;
    }
    drawChart();
  });
  canvas.addEventListener("mouseleave", () => {
    _hoverIdx = -1; _hoverY = -1; drawChart();
  });
}

/* ─── Load chart data for a range ──────────────────────────────── */
async function loadChart(coinId, days, retries = 2) {
  const chartEl = _cv;
  if (!chartEl) return;
  try {
    const data = await MD.cgChart(coinId, days);
    _candles = (data.candles || []);
    _rangeDays = days;
    drawChart();
  } catch (err) {
    if (retries > 0 && err.message && err.message.includes("429")) {
      await delay(4000);
      return loadChart(coinId, days, retries - 1);
    }
    _candles = [];
    drawChart();
  }
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

/* ─── Retry-aware market data fetch ─────────────────────────────── */
async function fetchMarketData(coinId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await MD.cgMarketData(coinId);
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.includes("429") && i < retries - 1) {
        await delay(5000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

/* ─── Resolve symbol to coingecko id using top coins list ────────── */
async function resolveId(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  /* If it looks like a CG slug (contains hyphen or is clearly an id) try it directly */
  /* We always try cgTopCoins first to map common symbols */
  try {
    const top = await MD.cgTopCoins(50);
    const hit = top.coins.find(c =>
      c.symbol.toLowerCase() === s ||
      (c.id && c.id.toLowerCase() === s) ||
      c.name.toLowerCase() === s
    );
    if (hit?.id) return hit.id;
  } catch (_) { /* ignore */ }
  /* Fall back — treat input as a CG id directly */
  return s;
}

/* ─── Try DefiLlama TVL lookup ──────────────────────────────────── */
async function tryDlTvl(symbol, name) {
  /* Try both symbol and name as the DL slug */
  for (const slug of [name, symbol]) {
    try {
      const d = await MD.dlProtocol(slug);
      if (d && d.tvl_usd) return d;
    } catch (_) { /* not a protocol */ }
  }
  return null;
}

/* ─── HTML helpers ──────────────────────────────────────────────── */
function statCard(label, value, extra = "") {
  return `<div class="cp-stat">
    <div class="cp-stat-lab">${label}</div>
    <div class="cp-stat-val">${value}</div>
    ${extra ? `<div class="cp-stat-sub">${extra}</div>` : ""}
  </div>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

/* 24h low → high bar with the current price marked. */
function rangeBar(low, cur, hi) {
  if (low == null || hi == null || cur == null || hi <= low) return "";
  const pct = Math.max(0, Math.min(100, ((cur - low) / (hi - low)) * 100));
  return `<div class="cp-mini cp-range">
    <div class="cp-mini-head"><span>24h range</span></div>
    <div class="cp-range-row">
      <span class="cp-range-cap">${fmtPx(low)}</span>
      <div class="cp-range-track"><i style="width:${pct.toFixed(1)}%"></i><b style="left:${pct.toFixed(1)}%"></b></div>
      <span class="cp-range-cap">${fmtPx(hi)}</span>
    </div>
  </div>`;
}

/* Circulating-vs-max supply progress. */
function supplyBar(circ, max, sym) {
  if (!circ || !max || max <= 0) return "";
  const pct = Math.max(0, Math.min(100, (circ / max) * 100));
  return `<div class="cp-mini cp-supplybar">
    <div class="cp-mini-head"><span>Circulating supply</span><b>${pct.toFixed(1)}%</b></div>
    <div class="cp-supply-track"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="cp-mini-sub">${fmtSupply(circ)} / ${fmtSupply(max)} ${esc(sym || "")}</div>
  </div>`;
}

/* About card: description + categories + external links (best-effort). */
function aboutCard(md) {
  const raw = md.description ? String(md.description).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
  const desc = raw.length > 420 ? raw.slice(0, 420).replace(/\s+\S*$/, "") + "…" : raw;
  const cats = (md.categories || []).map(c => `<span class="cp-cat">${esc(c)}</span>`).join("");
  const links = [];
  if (md.homepage) links.push(`<a class="cp-link" href="${esc(md.homepage)}" target="_blank" rel="noopener noreferrer">Website<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3 13 13 3M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`);
  if (md.explorer) links.push(`<a class="cp-link" href="${esc(md.explorer)}" target="_blank" rel="noopener noreferrer">Explorer<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3 13 13 3M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`);
  if (!desc && !cats && !links.length) return "";
  return `<div class="cp-about">
    <div class="cp-about-head">About ${esc(md.name || "")}</div>
    ${cats ? `<div class="cp-cats">${cats}</div>` : ""}
    ${desc ? `<p class="cp-about-text">${esc(desc)}</p>` : ""}
    ${links.length ? `<div class="cp-links">${links.join("")}</div>` : ""}
  </div>`;
}

function buildPage(root, md) {
  const up24 = (md.change_24h_pct || 0) >= 0;
  const up7   = (md.change_7d_pct  || 0) >= 0;
  const up30  = (md.change_30d_pct || 0) >= 0;
  const upAth = (md.ath_change_pct || 0) >= 0;

  const iconHTML = md.image
    ? `<img class="cp-icon-img" id="cpIcon" src="${esc(md.image)}" alt="${esc(md.symbol || "")}" loading="lazy" />`
    : `<span class="cp-icon" id="cpIcon">${(md.symbol || "?").slice(0, 1).toUpperCase()}</span>`;

  root.innerHTML = `
    <div class="cp-wrap">

      <!-- back -->
      <div class="cp-back">
        <button class="cp-back-btn" id="cpBack" aria-label="Back to Markets">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13L5 8l5-5"/></svg>
          Markets
        </button>
      </div>

      <!-- header -->
      <div class="cp-header">
        <div class="cp-title-row">
          ${iconHTML}
          <div class="cp-title-info">
            <div class="cp-name-row">
              <h1 class="cp-name">${esc(md.name || md.id)}</h1>
              <span class="cp-sym">${esc(md.symbol || "")}</span>
              ${md.market_cap_rank ? `<span class="cp-rank">#${esc(md.market_cap_rank)}</span>` : ""}
            </div>
            <div class="cp-price-row">
              <span class="cp-price">${fmtPx(md.price_usd)}</span>
              <span class="cp-ch ${up24 ? "cp-up" : "cp-dn"}">${fmtPct(md.change_24h_pct)}</span>
              <span class="cp-period-label">24h</span>
            </div>
          </div>
        </div>
        <button class="cp-trade-btn" id="cpTradeBtn">
          Trade ${esc(md.symbol || "")} on Hyperliquid
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13 13 3M6 3h7v7"/></svg>
        </button>
      </div>

      ${(rangeBar(md.low_24h_usd, md.price_usd, md.high_24h_usd) || supplyBar(md.circulating_supply, md.max_supply, md.symbol))
        ? `<div class="cp-subbar">
            ${rangeBar(md.low_24h_usd, md.price_usd, md.high_24h_usd)}
            ${supplyBar(md.circulating_supply, md.max_supply, md.symbol)}
          </div>` : ""}

      <!-- chart section -->
      <div class="cp-chart-card">
        <div class="cp-chart-toolbar">
          <div class="cp-range-picker" id="cpRangePicker">
            ${RANGES.map(r => `<button class="cp-range-btn${r.days === _rangeDays ? " on" : ""}" data-days="${r.days}">${r.label}</button>`).join("")}
          </div>
          <div class="cp-readout" id="cpReadout"></div>
        </div>
        <div class="cp-chart-wrap" id="cpChartWrap">
          <canvas id="cpCanvas" class="cp-canvas"></canvas>
        </div>
      </div>

      <!-- stat cards -->
      <div class="cp-stats-grid">
        ${statCard("Market Cap", fmtUSD(md.market_cap_usd))}
        ${statCard("24h Volume", fmtUSD(md.volume_24h_usd))}
        ${statCard("Circ. Supply", fmtSupply(md.circulating_supply), md.symbol || "")}
        ${statCard("Total Supply", md.total_supply ? fmtSupply(md.total_supply) : "∞", md.symbol || "")}
        ${statCard("All-Time High", fmtPx(md.ath_usd), `<span class="${upAth ? "cp-up" : "cp-dn"}">${fmtPct(md.ath_change_pct)} from ATH</span>`)}
        ${statCard("Change 7d", `<span class="${up7 ? "cp-up" : "cp-dn"}">${fmtPct(md.change_7d_pct)}</span>`)}
        ${statCard("Change 30d", `<span class="${up30 ? "cp-up" : "cp-dn"}">${fmtPct(md.change_30d_pct)}</span>`)}
        ${statCard("CMC Rank", md.market_cap_rank ? `#${md.market_cap_rank}` : "—")}
      </div>

      <!-- DeFiLlama TVL placeholder (filled async) -->
      <div id="cpDlSection" class="cp-dl-section" hidden></div>

      <!-- about / categories / links -->
      ${aboutCard(md)}

    </div>
  `;

  /* back button */
  root.querySelector("#cpBack")?.addEventListener("click", () => {
    window.LZ?.navigate?.("markets");
  });

  /* trade button */
  root.querySelector("#cpTradeBtn")?.addEventListener("click", () => {
    window.LZ?.navigate?.("trade");
    const sym = (md.symbol || "").toUpperCase();
    if (sym && window.LZ?.hl?.setCoin) {
      window.LZ.hl.setCoin(sym);
    }
  });

  /* load coin icon from CoinGecko image (best-effort) — only when the
     market-data response didn't already give us one (avoids a 2nd request). */
  if (!md.image) loadCoinIcon(md.id, md.symbol, root.querySelector("#cpIcon"));

  /* wire chart range picker */
  const picker = root.querySelector("#cpRangePicker");
  if (picker) {
    picker.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-days]");
      if (!btn) return;
      const days = Number(btn.dataset.days);
      picker.querySelectorAll(".cp-range-btn").forEach(b => b.classList.toggle("on", b === btn));
      _rangeDays = days;
      _candles = [];
      drawChart();
      loadChart(md.id, days);
    });
  }
}

/* ─── Load coin icon from CoinGecko ─────────────────────────────── */
function loadCoinIcon(id, symbol, el) {
  if (!el || !id) return;

  /* Attempt a better URL via a separate known pattern */
  const tryAlt = (url) => {
    const i2 = new Image();
    i2.crossOrigin = "anonymous";
    i2.src = url;
    i2.onload = () => {
      const parent = el.parentElement;
      if (!parent || !document.contains(el)) return;
      const imgEl = document.createElement("img");
      imgEl.src = url;
      imgEl.alt = symbol || id;
      imgEl.className = "cp-icon-img";
      el.replaceWith(imgEl);
    };
  };

  /* The real CoinGecko coin detail response contains image.thumb — since we
     already called cgMarketData which fetches the full /coins/:id endpoint,
     the image is available in the raw response. However our helper strips it.
     Use a separate lightweight fetch for the thumb URL. */
  fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, {
    headers: { accept: "application/json" },
  })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      const thumbUrl = d?.image?.thumb || d?.image?.small;
      if (thumbUrl && document.contains(el)) tryAlt(thumbUrl);
    })
    .catch(() => {});
}

/* ─── Render DeFiLlama TVL section ──────────────────────────────── */
function renderDlSection(container, dl) {
  if (!dl || !dl.tvl_usd) { container.hidden = true; return; }

  const chains = dl.by_chain || {};
  const chainRows = Object.entries(chains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([chain, tvl]) => `<div class="cp-dl-chain">
      <span class="cp-dl-chain-name">${chain}</span>
      <span class="cp-dl-chain-tvl">${fmtUSD(tvl)}</span>
    </div>`)
    .join("");

  container.hidden = false;
  container.innerHTML = `
    <div class="cp-dl-card">
      <div class="cp-dl-header">
        <span class="cp-dl-title">DeFiLlama TVL</span>
        <span class="cp-dl-badge">${dl.category || "Protocol"}</span>
      </div>
      <div class="cp-dl-total">${fmtUSD(dl.tvl_usd)}</div>
      ${chainRows ? `<div class="cp-dl-chains">${chainRows}</div>` : ""}
    </div>
  `;
}

/* ─── Main render ────────────────────────────────────────────────── */
async function render(id) {
  const root = document.getElementById("coinPage");
  if (!root) return;

  /* Reset chart state */
  _cv = null; _ctx = null; _candles = []; _hoverIdx = -1; _hoverY = -1;
  _rangeDays = 7;

  /* Show loading state */
  root.innerHTML = `<div class="cp-loading">
    <div class="cp-loading-ring"></div>
    <div class="cp-loading-label">Loading ${id || "coin"}…</div>
  </div>`;

  if (!id) {
    root.innerHTML = `<div class="cp-error">
      <div class="cp-error-icon">⚠</div>
      <div class="cp-error-msg">No coin specified. <button class="cp-link" id="cpErrBack">Back to Markets</button></div>
    </div>`;
    root.querySelector("#cpErrBack")?.addEventListener("click", () => window.LZ?.navigate?.("markets"));
    return;
  }

  /* Resolve id (handles symbols and CG slugs) */
  let coinId;
  try {
    coinId = await resolveId(id);
  } catch (_) {
    coinId = id.toLowerCase().trim();
  }

  /* Fetch market data */
  let md;
  try {
    md = await fetchMarketData(coinId);
  } catch (err) {
    const msg = String(err?.message || "");
    const is429 = msg.includes("429") || msg.includes("rate");
    root.innerHTML = `<div class="cp-error">
      <div class="cp-error-icon">⚠</div>
      <div class="cp-error-msg">
        ${is429
          ? "CoinGecko rate limit reached. Please wait a moment and try again."
          : `Could not load data for <strong>${id}</strong>. It may not be available on CoinGecko's free tier.`
        }
      </div>
      <div class="cp-error-actions">
        <button class="cp-btn-secondary" id="cpRetry">Retry</button>
        <button class="cp-btn-secondary" id="cpBack2">Back to Markets</button>
      </div>
    </div>`;
    root.querySelector("#cpRetry")?.addEventListener("click", () => render(id));
    root.querySelector("#cpBack2")?.addEventListener("click", () => window.LZ?.navigate?.("markets"));
    return;
  }

  /* Build the page HTML */
  buildPage(root, md);

  /* Wire up canvas */
  _cv  = root.querySelector("#cpCanvas");
  _ctx = _cv ? _cv.getContext("2d") : null;
  wireChartEvents(_cv);

  /* Attach the readout element reference so drawChart() can reach it */
  /* (done via parentElement query inside drawChart) */

  /* Initial chart load */
  loadChart(md.id || coinId, _rangeDays);

  /* Responsive: re-draw on resize */
  const ro = new ResizeObserver(() => { if (_cv) drawChart(); });
  const wrap = root.querySelector("#cpChartWrap");
  if (wrap) ro.observe(wrap);

  /* Async: DeFiLlama TVL (non-blocking) */
  const dlSection = root.querySelector("#cpDlSection");
  if (dlSection) {
    tryDlTvl(md.symbol || "", md.name || "").then(dl => {
      /* Only update if the section is still in the DOM (user may have navigated away) */
      if (document.contains(dlSection)) renderDlSection(dlSection, dl);
    }).catch(() => {});
  }
}

/* ─── Export to global window.LZ.coinPage ───────────────────────── */
window.LZ = window.LZ || {};
window.LZ.coinPage = { render };

/* Deep-link safety: if this module finished loading AFTER the router already
   dispatched the initial route (e.g. a hard refresh / shared link straight to
   #/coin/<id>), render now — the early ONROUTE.coin call would have no-op'd
   because window.LZ.coinPage wasn't ready yet. */
if (typeof location !== "undefined" && location.hash.startsWith("#/coin/")) {
  const id = decodeURIComponent(location.hash.split("/")[2] || "");
  const root = typeof document !== "undefined" && document.getElementById("coinPage");
  if (id && root && !root.querySelector(".cp-wrap")) render(id);
}
