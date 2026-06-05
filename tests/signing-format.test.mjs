/* =====================================================================
 *  signing-format.test.mjs — unit tests for the Hyperliquid wire number
 *  formatting that is LOAD-BEARING for order signatures (assets/js/hl-format.js).
 *
 *  These strings are hashed and signed verbatim, so a formatting regression
 *  silently changes the signature / the order the exchange receives. Run:
 *      node tests/signing-format.test.mjs
 *  No test framework — plain assertions, exit code 1 on failure.
 * ===================================================================== */

import { formatPrice, formatSize, trimNum } from "../assets/js/hl-format.js";

let passed = 0, failed = 0;
const fails = [];
function eq(actual, expected, msg){
  if (actual === expected){ passed++; }
  else { failed++; fails.push(`✗ ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}
function ok(cond, msg){
  if (cond){ passed++; } else { failed++; fails.push(`✗ ${msg}`); }
}

/* ── trimNum ─────────────────────────────────────────────────── */
eq(trimNum("1.2300"), "1.23", "trimNum strips trailing zeros");
eq(trimNum("5.000"), "5", "trimNum strips to integer");
eq(trimNum("100"), "100", "trimNum leaves integers untouched");
eq(trimNum("0.0"), "0", "trimNum 0.0 -> 0");

/* ── formatSize: rounds to szDecimals, trims ─────────────────── */
eq(formatSize(1.23456, 3), "1.235", "size rounds to 3 dp");
eq(formatSize(1.2, 5), "1.2", "size trims trailing zeros");
eq(formatSize(5, 0), "5", "size with 0 decimals");
eq(formatSize(0, 5), "0", "zero size");
eq(formatSize(0.1 + 0.2, 4), "0.3", "size kills float dust (0.1+0.2)");

/* ── formatPrice: concrete cases (perps, MAX_DECIMALS=6) ─────── */
eq(formatPrice(100, 5), "100", "integer price returns plain integer");
eq(formatPrice(65000, 5), "65000", "large integer price");
eq(formatPrice(0, 5), "0", "zero price -> 0");
eq(formatPrice(-5, 2), "0", "negative price -> 0");
eq(formatPrice(NaN, 2), "0", "NaN price -> 0");
eq(formatPrice(Infinity, 2), "0", "Infinity price -> 0");
eq(formatPrice(1234.56, 2), "1234.6", "5 sig figs caps 1234.56 -> 1234.6");
eq(formatPrice(2.34567, 3), "2.346", "decimal cap 6-3=3 -> 2.346");
eq(formatPrice(1.5, 2), "1.5", "simple decimal kept");

/* ── formatPrice: INVARIANTS over a sweep of inputs ──────────── */
const szSet = [0, 1, 2, 3, 4, 5];
const pxSet = [0.0001234, 0.5, 1.5, 3.14159, 42.42, 123.456, 1234.5678,
               65432.1, 99999.9, 100000, 250000.7];
for (const sz of szSet){
  const maxDec = 6 - sz;               // perps
  for (const px of pxSet){
    const out = formatPrice(px, sz, true);
    // 1) parses back to a finite, non-negative number
    ok(isFinite(Number(out)) && Number(out) >= 0, `price ${px}@sz${sz} parses (${out})`);
    if (out === "0") continue;
    // never emit a negative zero
    ok(out !== "-0", `price ${px}@sz${sz} not -0`);
    const isInteger = !out.includes(".");
    const [, frac = ""] = out.split(".");
    // 2) decimal places never exceed 6 - szDecimals
    ok(frac.length <= Math.max(0, maxDec), `price ${px}@sz${sz} <= ${maxDec} dp (got ${out})`);
    // 3) at most 5 significant figures — HL exempts INTEGER prices (always allowed)
    if (!isInteger){
      const digits = out.replace("-", "").replace(".", "").replace(/^0+/, "");
      ok(digits.length <= 5, `price ${px}@sz${sz} <= 5 sig figs (got ${out})`);
    }
    // 4) no trailing zero in a fractional part, no trailing dot
    ok(!/\.\d*0$/.test(out) && !out.endsWith("."), `price ${px}@sz${sz} trimmed (got ${out})`);
  }
}

/* ── formatSize INVARIANT: never more than szDecimals dp ──────── */
for (const sz of szSet){
  for (const s of [0.123456789, 1.000004, 9999.99999, 0.5]){
    const out = formatSize(s, sz);
    const [, frac = ""] = out.split(".");
    ok(frac.length <= sz, `size ${s}@sz${sz} <= ${sz} dp (got ${out})`);
  }
}

/* ── report ──────────────────────────────────────────────────── */
console.log(`\nsigning-format: ${passed} passed, ${failed} failed`);
if (failed){ console.log("\n" + fails.join("\n")); process.exit(1); }
console.log("✓ all signing wire-format assertions hold");
