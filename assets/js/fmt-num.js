/* =====================================================================
 *  fmt-num.js — ONE canonical set of *display* number formatters.
 *  ---------------------------------------------------------------------
 *  Kills the ~5 divergent price/size/usd/pct formatters that used to live
 *  in trade.js, hl-markets.js, hl-depth.js, hl-portfolio.js & coin-page.js
 *  (each with subtly different sig-fig / decimal / $-prefix rules — the
 *  same coin could render differently across panes).
 *
 *  THIS IS DISPLAY ONLY. The LOAD-BEARING wire formatters that get hashed
 *  and signed live in hl-format.js (`formatPrice`/`formatSize`) and MUST
 *  NOT be touched — do not route signing through this module.
 *
 *  Pure, zero-deps, no globals required — safe to import in Node or the
 *  browser. Also mirrored on window.LZ.fmt for non-module callers.
 *
 *    price(n, {coin, decimals})  → "1,234.5" / "0.04212"  (no $)
 *    usd(n, {sign})              → "$1,234.50" / "−$3.40"  ($-prefixed)
 *    usdCompact(n)               → "$1.2B" / "$910.0K"     (axis / KPI)
 *    size(n, {coin, decimals})   → "0.0123"               (szDecimals-aware)
 *    pct(n, {sign, decimals})    → "+1.20%" / "−0.04%"
 *    compact(n)                  → "1.2B" (no $, e.g. volume counts)
 *    signedUsd(n)                → "+$12.00" / "−$3.40"
 *  Convention: non-finite / null → DASH ("—").
 * ===================================================================== */

const DASH = "—";
const PLUS = "+";
const MINUS = "−"; // U+2212 minus, matches the rest of the UI

const toNum = (v) => {
  if (v == null || v === "") return null;   // null/undefined/"" → DASH, never 0
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* szDecimals lookup so price()/size() can honour per-coin precision when
 * a coin symbol is passed. Populated from HL meta via setUniverse(); falls
 * back gracefully (sig-fig rules) when the coin is unknown. */
let _szByCoin = Object.create(null);
export function setUniverse(universe){
  if (!Array.isArray(universe)) return;
  const next = Object.create(null);
  for (const u of universe){
    if (u && u.name != null && Number.isFinite(Number(u.szDecimals))){
      next[u.name] = Number(u.szDecimals);
    }
  }
  _szByCoin = next;
}
const szForCoin = (coin) => (coin != null && coin in _szByCoin) ? _szByCoin[coin] : null;

const grp = (n, opt) => n.toLocaleString("en-US", opt);

/* ── price: no currency prefix. Sig-fig driven so micro-caps keep
 *    precision and large caps stay readable. A coin's szDecimals (perps
 *    MAX_DECIMALS=6) caps the small-number decimals when known. ────── */
export function price(v, { coin, decimals } = {}){
  const n = toNum(v);
  if (n == null) return DASH;
  const a = Math.abs(n);
  if (a === 0) return "0";
  let maxFrac;
  if (decimals != null){
    maxFrac = decimals;
  } else {
    if (a >= 1000)      maxFrac = 1;
    else if (a >= 100)  maxFrac = 2;
    else if (a >= 1)    maxFrac = 4;
    else if (a >= 0.01) maxFrac = 6;
    else                maxFrac = 8;
    // honour per-coin precision cap when available (perps: 6 - szDecimals)
    const sz = szForCoin(coin);
    if (sz != null) maxFrac = Math.min(maxFrac, Math.max(0, 6 - sz) + 2);
  }
  return grp(n, { maximumFractionDigits: maxFrac });
}

/* ── usd: currency prefix, sign as leading −. Money/PnL display. ──── */
export function usd(v, { sign = false } = {}){
  const n = toNum(v);
  if (n == null) return DASH;
  const a = Math.abs(n);
  let opt;
  if (a >= 10000)   opt = { maximumFractionDigits: 0 };
  else if (a >= 1)  opt = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  else if (a >= 0.01) opt = { minimumFractionDigits: 2, maximumFractionDigits: 4 };
  else              opt = { maximumFractionDigits: 6 };
  const prefix = n < 0 ? MINUS + "$" : (sign ? PLUS + "$" : "$");
  return prefix + grp(a, opt);
}

/* ── signedUsd: always shows the sign (for PnL deltas). ──────────── */
export function signedUsd(v){ return usd(v, { sign: true }); }

/* ── usdCompact: $1.2B / $910.0K — KPIs, OI, volume in $. ────────── */
export function usdCompact(v){
  const n = toNum(v);
  if (n == null) return DASH;
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  if (a >= 1e12) return s + "$" + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9)  return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6)  return s + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3)  return s + "$" + (a / 1e3).toFixed(1) + "K";
  return s + "$" + a.toFixed(2);
}

/* ── compact: 1.2B without $ — counts (supply, contracts). ───────── */
export function compact(v){
  const n = toNum(v);
  if (n == null) return DASH;
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/* ── size: position/order size, szDecimals-aware when coin known. ── */
export function size(v, { coin, decimals } = {}){
  const n = toNum(v);
  if (n == null) return DASH;
  let dp = decimals != null ? decimals : szForCoin(coin);
  if (dp == null) dp = Math.abs(n) >= 1 ? 4 : 6;
  dp = Math.max(0, Math.min(8, dp));
  return grp(Math.abs(n), { maximumFractionDigits: dp });
}

/* ── pct: "+1.20%" / "−0.04%". sign=false drops the leading +. ───── */
export function pct(v, { sign = true, decimals = 2 } = {}){
  const n = toNum(v);
  if (n == null) return DASH;
  const head = n >= 0 ? (sign ? PLUS : "") : MINUS;
  return head + Math.abs(n).toFixed(decimals) + "%";
}

export const fmt = { price, usd, signedUsd, usdCompact, compact, size, pct, setUniverse, DASH };

if (typeof window !== "undefined"){
  window.LZ = window.LZ || {};
  window.LZ.fmt = fmt;
}

export default fmt;
