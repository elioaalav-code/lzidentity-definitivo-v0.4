/* =====================================================================
 *  hl-format.js — Hyperliquid wire number formatting (pure, testable)
 *  ---------------------------------------------------------------------
 *  Extracted verbatim from hyperliquid.js so the LOAD-BEARING formatting
 *  rules (the exact decimal strings that get hashed + signed) can be unit
 *  tested in Node without the module's browser/remote-ESM dependencies.
 *
 *  Hyperliquid wire rules:
 *   · Sizes round to szDecimals.
 *   · Prices: integers always allowed; otherwise 5 significant figures AND
 *     ≤ (MAX_DECIMALS - szDecimals) decimals (MAX_DECIMALS = 6 perps, 8 spot).
 *   · Output is the minimal decimal string — the exact same string is
 *     hashed and sent, so any change here changes the signature.
 *  No imports, no globals — safe to import anywhere (browser or Node).
 * ===================================================================== */

export function trimNum(s){
  if (s.indexOf(".") === -1) return s;
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-" ? "0" : s;
}

export function formatSize(sz, szDecimals){
  return trimNum(Number(sz).toFixed(Math.max(0, szDecimals)));
}

export function formatPrice(px, szDecimals, isPerp = true){
  px = Number(px);
  if (!isFinite(px) || px <= 0) return "0";
  if (Number.isInteger(px)) return String(px);
  const maxDecimals = isPerp ? 6 : 8;
  const decimals = Math.max(0, maxDecimals - szDecimals);
  let v = Number(px.toPrecision(5));      // 5 significant figures
  v = Number(v.toFixed(decimals));        // decimal-place cap
  if (Number.isInteger(v)) return String(v);
  return trimNum(v.toFixed(decimals));
}
