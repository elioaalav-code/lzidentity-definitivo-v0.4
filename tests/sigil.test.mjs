/* =====================================================================
 *  sigil.test.mjs — unit tests for the generative-identity seed engine
 *  (assets/js/sigil.js).
 *
 *  seedFromNpub() is the SINGLE source of a key's visual identity and the
 *  brand promise is "same wallet -> same sigil, forever". These tests pin:
 *    1. determinism (same npub == identical seed, every field)
 *    2. v1 BACKWARD-COMPAT (the original five fields are byte-frozen — a
 *       hard constraint: existing npubs must not visually drift)
 *    3. v2 trait ranges + curated-vocabulary membership
 *    4. fingerprint determinism + format
 *    5. distinctness (different npubs differ)
 *
 *  Run:  node tests/sigil.test.mjs   (no framework, exit 1 on failure)
 * ===================================================================== */

import { seedFromNpub, fingerprint } from "../assets/js/sigil.js";

let passed = 0, failed = 0;
const fails = [];
function eq(actual, expected, msg){
  if (Object.is(actual, expected)){ passed++; }
  else { failed++; fails.push(`✗ ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}
function ok(cond, msg){
  if (cond){ passed++; } else { failed++; fails.push(`✗ ${msg}`); }
}

/* A small fixed corpus of plausible npubs + edge inputs. */
const NPUBS = [
  "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m",
  "npub1z  fake but stable string",
  "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsl6w0pu",
  "npub1abcdefghijklmnopqrstuvwxyz0123456789",
  "",            // empty
  "x",           // tiny
];

/* ── 1. determinism: same npub -> identical seed object ──────── */
for (const n of NPUBS){
  const a = seedFromNpub(n), b = seedFromNpub(n);
  eq(JSON.stringify(a), JSON.stringify(b), `seed deterministic for ${JSON.stringify(n)}`);
}

/* String/non-string coercion is stable (npub is always stringified). */
eq(JSON.stringify(seedFromNpub(123)), JSON.stringify(seedFromNpub("123")), "numeric npub coerces to string seed");
eq(JSON.stringify(seedFromNpub(null)), JSON.stringify(seedFromNpub("")), "null npub coerces to empty-string seed");

/* ── 2. v1 BACKWARD-COMPAT: the original five fields are frozen ──
 * Re-derive v1 exactly as the original implementation did and assert the
 * current seed still produces those identical values. If anyone ever
 * reorders the v1 PRNG draws, existing sigils silently change — this fails. */
function xfnv1a(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function v1Reference(npub){
  const rnd = mulberry32(xfnv1a(String(npub || "") + "::lz-sigil"));
  const h1 = rnd() * 360;
  const h2 = (h1 + 90 + rnd() * 180) % 360;
  const density = 3 + Math.floor(rnd() * 7);
  const rot = rnd() * Math.PI * 2;
  const warp = rnd();
  return { h1, h2, density, rot, warp };
}
for (const n of NPUBS){
  const cur = seedFromNpub(n);
  const ref = v1Reference(n);
  eq(cur.h1, ref.h1, `v1 frozen h1 for ${JSON.stringify(n)}`);
  eq(cur.h2, ref.h2, `v1 frozen h2 for ${JSON.stringify(n)}`);
  eq(cur.density, ref.density, `v1 frozen density for ${JSON.stringify(n)}`);
  eq(cur.rot, ref.rot, `v1 frozen rot for ${JSON.stringify(n)}`);
  eq(cur.warp, ref.warp, `v1 frozen warp for ${JSON.stringify(n)}`);
}

/* ── 3. invariants across a large random-ish sweep ──────────── */
const SILS = ["disc", "faceted", "bloom", "orbit"];
const LINES = ["solid", "filament", "dust"];
let rareCount = 0, total = 0;
const symHist = {3:0,4:0,5:0,6:0};
for (let i = 0; i < 400; i++){
  const n = "npub1" + (i * 2654435761 >>> 0).toString(36) + "k" + i;
  const s = seedFromNpub(n); total++;
  // v1 ranges
  ok(s.h1 >= 0 && s.h1 < 360, `h1 in [0,360) (${s.h1})`);
  ok(s.h2 >= 0 && s.h2 < 360, `h2 in [0,360) (${s.h2})`);
  const hueGap = Math.min(Math.abs(s.h1 - s.h2), 360 - Math.abs(s.h1 - s.h2));
  ok(hueGap >= 89, `hues distinct (>=~90° apart): gap ${hueGap.toFixed(1)}`);
  ok(Number.isInteger(s.density) && s.density >= 3 && s.density <= 9, `density 3..9 (${s.density})`);
  ok(s.rot >= 0 && s.rot < Math.PI * 2, `rot in [0,2π) (${s.rot})`);
  ok(s.warp >= 0 && s.warp < 1, `warp in [0,1) (${s.warp})`);
  // v2 traits
  eq(s.v, 2, "seed version is 2");
  ok(Number.isInteger(s.symmetry) && s.symmetry >= 3 && s.symmetry <= 6, `symmetry 3..6 (${s.symmetry})`);
  symHist[s.symmetry]++;
  ok(SILS.includes(s.silhouette), `silhouette is curated (${s.silhouette})`);
  ok(LINES.includes(s.lineStyle), `lineStyle is curated (${s.lineStyle})`);
  ok(s.palette && typeof s.palette.name === "string" && s.palette.sat > 0, `palette family present (${s.palette?.name})`);
  ok(typeof s.rare === "boolean", "rare is boolean");
  if (s.rare) rareCount++;
}
// rarity should be uncommon but present (target ~1-in-12 ≈ 8%); allow slack.
ok(rareCount > 0 && rareCount < total * 0.25, `rare accent is uncommon (${rareCount}/${total})`);
// every symmetry order should actually occur across 400 samples
ok(symHist[3] && symHist[4] && symHist[5] && symHist[6], `all symmetry orders occur (${JSON.stringify(symHist)})`);

/* ── 4. fingerprint: deterministic + well-formed ────────────── */
for (const n of NPUBS){
  const a = fingerprint(n), b = fingerprint(n);
  eq(a.code, b.code, `fingerprint code deterministic for ${JSON.stringify(n)}`);
  eq(a.label, b.label, `fingerprint label deterministic for ${JSON.stringify(n)}`);
  ok(/^[0-9a-f]{6}$/.test(a.code), `fingerprint code is 6 hex (${a.code})`);
  ok(a.words.length === 3 && a.words.every(Boolean), `fingerprint has 3 words (${a.label})`);
  ok(a.words[1] !== a.words[2], `fingerprint nouns not duplicated (${a.label})`);
}

/* ── 5. distinctness: different npubs -> different seeds/fingerprints ── */
const a = seedFromNpub("npub1aaaa"), b = seedFromNpub("npub1bbbb");
ok(JSON.stringify(a) !== JSON.stringify(b), "different npubs produce different seeds");
ok(fingerprint("npub1aaaa").code !== fingerprint("npub1bbbb").code, "different npubs produce different fingerprints");
// fingerprint uniqueness across the sweep should be high (no trivial collisions)
const codes = new Set();
for (let i = 0; i < 400; i++) codes.add(fingerprint("npub1" + i + "z").code);
ok(codes.size >= 395, `fingerprint codes are near-unique across 400 (${codes.size}/400)`);

/* ── report ──────────────────────────────────────────────────── */
console.log(`\nsigil: ${passed} passed, ${failed} failed`);
if (failed){ console.log("\n" + fails.join("\n")); process.exit(1); }
console.log("✓ seedFromNpub determinism, v1 freeze, v2 traits & fingerprint all hold");
