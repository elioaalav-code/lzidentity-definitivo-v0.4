/* =================================================================== *
 *  wallet-actions.js — Receive / Swap / Bridge (REAL on-chain)
 * ===================================================================
 *  CONTRACT (set by app.js + app.html scaffolding — keep these anchors):
 *   · Buttons in the wallet view (give them handlers here):
 *       #walletReceive  · show the connected address + a QR to receive
 *       #walletSwap     · same-chain token swap
 *       #walletBridge   · cross-chain bridge (and bridge+swap)
 *       #walletSendTop  · optional: focus the existing Quick-send card
 *   · Connected EOA:      window.LZ.account()            → "0x…" | null
 *   · Provider:           window.ethereum (EIP-1193).
 *   · Chains the wallet uses: window.LZ.walletChains() →
 *       [{ key:"eth"|"arb"|"op"|"base", name, rpc, usdc }]
 *       chainIds: eth=1, arb=42161, op=10, base=8453.
 *   · After a swap/bridge confirms: window.LZ.reloadWallet().
 *   · Toasts: window.LZ.toast(msg, "ok"|"err").
 *
 *  Implementation: LI.FI API (https://li.quest/v1) — keyless, no SDK.
 *    GET /v1/tokens   → token selectors per chain
 *    GET /v1/quote    → swap (same chain) + bridge (cross chain); returns a
 *                       ready-to-send `transactionRequest` and an `estimate`.
 *    GET /v1/status   → poll a submitted tx until DONE / FAILED.
 *  Flow: quote → review modal → (ERC-20) allowance check + approve tx →
 *    wallet_switchEthereumChain → eth_sendTransaction(transactionRequest) →
 *    poll status → toast + window.LZ.reloadWallet(). Every funds-moving step
 *    is explicit and user-signed.
 * =================================================================== */

const LIFI = "https://li.quest/v1";
const NATIVE = "0x0000000000000000000000000000000000000000";

/* chainKey → numeric chainId (matches LI.FI + the app's wallet chains) */
const CHAIN_ID = { eth: 1, arb: 42161, op: 10, base: 8453 };
const ID_TO_KEY = { 1: "eth", 42161: "arb", 10: "op", 8453: "base" };

/* Stargate brand mark — vendored inline SVG recreation (network-free; no
   hotlink to stargate.finance). A ringed-portal/planet, Stargate's motif. */
const STARGATE_MARK = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="sgGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#9be8ff"/><stop offset="1" stop-color="#1f8fff"/></linearGradient></defs><ellipse cx="16" cy="16" rx="14.5" ry="5.4" transform="rotate(-24 16 16)" stroke="url(#sgGrad)" stroke-width="2"/><circle cx="16" cy="16" r="7.6" fill="url(#sgGrad)"/><circle cx="16" cy="16" r="7.6" fill="none" stroke="#fff" stroke-opacity=".45"/><circle cx="13" cy="13" r="2.2" fill="#fff" fill-opacity=".6"/></svg>`;

/* ─── tiny safe accessors for the app surface ─────────────────────── */
const LZ = () => (typeof window !== "undefined" && window.LZ) ? window.LZ : null;
const account = () => { try { return LZ()?.account?.() || null; } catch { return null; } };
const toast = (m, tone) => { try { LZ()?.toast?.(m, tone); } catch { console.log("[wallet]", tone, m); } };
const reloadWallet = () => { try { LZ()?.reloadWallet?.(); } catch {} };
function walletChains(){
  try {
    const c = LZ()?.walletChains?.();
    if (Array.isArray(c) && c.length) return c;
  } catch {}
  // fallback so the UI still works if app.js hasn't populated the surface
  return [
    { key: "eth",  name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { key: "arb",  name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    { key: "op",   name: "Optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
    { key: "base", name: "Base",     usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ];
}
const provider = () => (typeof window !== "undefined") ? window.ethereum : null;

const shortAddr = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

async function ensureAccount(){
  let a = account();
  if (a) return a;
  const p = provider();
  if (!p) { toast("No wallet provider found", "err"); return null; }
  try {
    const accs = await p.request({ method: "eth_requestAccounts" });
    if (accs && accs.length) return accs[0];
  } catch (e) {
    toast(e?.code === 4001 ? "Connection rejected" : "Could not connect wallet", "err");
    return null;
  }
  toast("Connect a wallet first", "err");
  return null;
}

/* ─── big-number helpers (no libs; amounts are decimal strings) ───── */
function toBaseUnits(amountStr, decimals){
  const s = String(amountStr).trim();
  if (!s || isNaN(Number(s)) || Number(s) < 0) return null;
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole.replace(/^0+(?=\d)/, "") + fracPadded).replace(/^0+(?=\d)/, "");
  try { return BigInt(combined || "0"); } catch { return null; }
}
function fromBaseUnits(baseStr, decimals, maxFrac = 6){
  let v;
  try { v = BigInt(baseStr); } catch { return "0"; }
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* =================================================================== *
 *  Self-contained QR encoder (byte mode, no external service).
 *  Supports versions 1-10, error-correction level L/M. Enough for an
 *  Ethereum address (42 chars). Returns a 2D boolean matrix.
 * =================================================================== */
const QR = (() => {
  // Galois field tables for Reed-Solomon over GF(256), generator 0x11d.
  const EXP = new Array(512), LOG = new Array(256);
  (function initGF(){
    let x = 1;
    for (let i = 0; i < 255; i++){ EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function rsGenPoly(n){
    let poly = [1];
    for (let i = 0; i < n; i++){
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++){
        next[j] ^= gfMul(poly[j], 1);
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, ecLen){
    const gen = rsGenPoly(ecLen);
    const res = new Array(data.length + ecLen).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++){
      const coef = res[i];
      if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // Per-version capacity (byte mode) + EC block structure, level M.
  // [version]: { ecPerBlock, group1Blocks, group1Words, group2Blocks, group2Words }
  const VERSIONS = {
    1:  { ec: 10, g1: 1, w1: 16,  g2: 0, w2: 0 },
    2:  { ec: 16, g1: 1, w1: 28,  g2: 0, w2: 0 },
    3:  { ec: 26, g1: 1, w1: 44,  g2: 0, w2: 0 },
    4:  { ec: 18, g1: 2, w1: 32,  g2: 0, w2: 0 },
    5:  { ec: 24, g1: 2, w1: 43,  g2: 0, w2: 0 },
    6:  { ec: 16, g1: 4, w1: 27,  g2: 0, w2: 0 },
    7:  { ec: 18, g1: 4, w1: 31,  g2: 0, w2: 0 },
    8:  { ec: 22, g1: 2, w1: 38,  g2: 2, w2: 39 },
    9:  { ec: 22, g1: 3, w1: 36,  g2: 2, w2: 37 },
    10: { ec: 26, g1: 4, w1: 43,  g2: 1, w2: 44 },
  };
  const dataCapacity = (v) => { const s = VERSIONS[v]; return s.g1 * s.w1 + s.g2 * s.w2; };

  // alignment-pattern center coordinates per version
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  function pickVersion(byteLen){
    // byte mode header in v1-9 = 4 (mode) + 8 (count) bits = 2 bytes overhead.
    for (let v = 1; v <= 10; v++){
      const overhead = 2; // mode nibble + 8-bit count fit in 12 bits ~ <=2 bytes after padding
      if (byteLen + overhead <= dataCapacity(v)) return v;
    }
    return null;
  }

  function buildBitStream(bytes, version){
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);                 // byte mode
    push(bytes.length, 8);           // char count (8 bits for v1-9, fine for our sizes)
    for (const b of bytes) push(b, 8);
    const cap = dataCapacity(version) * 8;
    // terminator
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    // pad bytes
    const pads = [0xec, 0x11]; let pi = 0;
    while (bits.length < cap){ push(pads[pi++ % 2], 8); }
    // to bytes
    const data = [];
    for (let i = 0; i < bits.length; i += 8){
      let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    return data;
  }

  function structure(dataWords, version){
    const s = VERSIONS[version];
    const blocks = [];
    let idx = 0;
    for (let i = 0; i < s.g1; i++){ blocks.push(dataWords.slice(idx, idx + s.w1)); idx += s.w1; }
    for (let i = 0; i < s.g2; i++){ blocks.push(dataWords.slice(idx, idx + s.w2)); idx += s.w2; }
    const ecBlocks = blocks.map((b) => rsEncode(b, s.ec));
    // interleave data
    const maxData = Math.max(...blocks.map((b) => b.length));
    const out = [];
    for (let c = 0; c < maxData; c++) for (const b of blocks) if (c < b.length) out.push(b[c]);
    for (let c = 0; c < s.ec; c++) for (const eb of ecBlocks) out.push(eb[c]);
    return out;
  }

  function newMatrix(size){
    const m = []; for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }
  function placeFinder(m, r, c){
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++){
      const rr = r + i, cc = c + j;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                 (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                 (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  }
  function placeAlign(m, cx, cy){
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++){
      const on = Math.max(Math.abs(i), Math.abs(j)) !== 1;
      m[cy + i][cx + j] = on ? 1 : 0;
    }
  }

  function reserved(m, version){
    const size = m.length;
    const res = newMatrix(size).map((row) => row.map(() => false));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
    // finders + separators (8x8 each corner)
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]])
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) mark(r + i, c + j);
    // timing
    for (let i = 0; i < size; i++){ mark(6, i); mark(i, 6); }
    // alignment
    const centers = ALIGN[version];
    for (const a of centers) for (const b of centers){
      if ((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) mark(a + i, b + j);
    }
    // format info areas
    for (let i = 0; i < 9; i++){ mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++){ mark(8, size - 1 - i); mark(size - 1 - i, 8); }
    mark(size - 8, 8); // dark module
    return res;
  }

  function buildBase(version){
    const size = version * 4 + 17;
    const m = newMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    // alignment
    const centers = ALIGN[version];
    for (const a of centers) for (const b of centers){
      if ((a === 6 && b === 6) || (a === 6 && b === size - 7) || (a === size - 7 && b === 6)) continue;
      placeAlign(m, b, a);
    }
    // timing
    for (let i = 8; i < size - 8; i++){ const v = (i % 2 === 0) ? 1 : 0; if (m[6][i] === null) m[6][i] = v; if (m[i][6] === null) m[i][6] = v; }
    // dark module
    m[size - 8][8] = 1;
    return m;
  }

  function placeData(m, res, codewords){
    const size = m.length;
    const bits = [];
    for (const w of codewords) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
    let bi = 0, upward = true;
    for (let col = size - 1; col > 0; col -= 2){
      if (col === 6) col--; // skip timing column
      const range = upward ? rangeDown(size) : rangeUp(size);
      for (const row of range){
        for (let c = 0; c < 2; c++){
          const cc = col - c;
          if (res[row][cc]) continue;
          m[row][cc] = bi < bits.length ? bits[bi++] : 0;
        }
      }
      upward = !upward;
    }
  }
  const rangeDown = (n) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(i); return a; };
  const rangeUp = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; };

  function applyMask(m, res, mask){
    const fn = [
      (r, c) => (r + c) % 2 === 0,
      (r, c) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
      (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
      (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0,
    ][mask];
    const out = m.map((row) => row.slice());
    for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++){
      if (!res[r][c] && fn(r, c)) out[r][c] ^= 1;
    }
    return out;
  }

  // format info (level M = 00) BCH + mask
  function formatBits(mask){
    const fmt = (0b00 << 3) | mask; // EC level M = 00
    let v = fmt << 10;
    const g = 0b10100110111;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= g << (i - 10);
    let bits = ((fmt << 10) | v) ^ 0b101010000010010;
    return bits & 0x7fff;
  }
  function placeFormat(m, mask){
    const size = m.length;
    const bits = formatBits(mask);
    const get = (i) => (bits >> i) & 1;
    // around top-left
    for (let i = 0; i <= 5; i++) m[8][i] = get(i);
    m[8][7] = get(6); m[8][8] = get(7); m[7][8] = get(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);
    // around the other two finders
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = get(i);
    m[size - 8][8] = 1;
  }

  function penalty(m){
    const n = m.length; let score = 0;
    // rule 1: runs of 5+
    for (let r = 0; r < n; r++){
      let run = 1; for (let c = 1; c < n; c++){ if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; }
    }
    for (let c = 0; c < n; c++){
      let run = 1; for (let r = 1; r < n; r++){ if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; }
    }
    // rule 2: 2x2 blocks
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++){
      const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
    return score;
  }

  function buildReserved(version){
    const size = version * 4 + 17;
    const dummy = newMatrix(size);
    return reserved(dummy, version);
  }
  function generate(text){
    const bytes = Array.from(new TextEncoder().encode(text));
    const version = pickVersion(bytes.length);
    if (!version) throw new Error("data too long for QR");
    const dataWords = buildBitStream(bytes, version);
    const full = structure(dataWords, version);
    const baseRes = buildReserved(version);
    const base = buildBase(version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++){
      const filled = base.map((row) => row.slice());
      placeData(filled, baseRes, full);
      const normalized = filled.map((row) => row.map((v) => v === null ? 0 : v));
      const masked = applyMask(normalized, baseRes, mask);
      placeFormat(masked, mask);
      const sc = penalty(masked);
      if (sc < bestScore){ bestScore = sc; best = masked; }
    }
    return best;
  }

  return { generate };
})();

function qrToSvg(matrix, px = 200){
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const cell = px / total;
  let rects = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++){
    if (matrix[r][c]) {
      const x = (c + quiet) * cell, y = (r + quiet) * cell;
      rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cell + 0.5).toFixed(2)}" height="${(cell + 0.5).toFixed(2)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges" role="img" aria-label="Wallet address QR code"><rect width="${px}" height="${px}" fill="#ffffff" rx="8"/><g fill="#0a0a0c">${rects}</g></svg>`;
}

/* =================================================================== *
 *  LI.FI HTTP layer
 * =================================================================== */
async function lifiGet(path, params){
  const url = new URL(LIFI + path);
  if (params) for (const [k, v] of Object.entries(params)){
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => { if (x != null && x !== "") url.searchParams.append(k, x); });
    else url.searchParams.set(k, v);
  }
  let r;
  try {
    r = await fetch(url.toString(), { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error("network error reaching LI.FI");
  }
  if (r.status === 429) throw new Error("LI.FI rate limit — try again in a moment");
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok){
    const msg = body && (body.message || body.error) ? (body.message || body.error) : `LI.FI error ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

/* token list cache: chainKey → [{address,symbol,decimals,name,logoURI,priceUSD}] */
let _tokensCache = null;
let _tokensAt = 0;
async function getTokens(){
  if (_tokensCache && Date.now() - _tokensAt < 10 * 60_000) return _tokensCache;
  const ids = Object.values(CHAIN_ID).join(",");
  const res = await lifiGet("/tokens", { chains: ids });
  const byKey = {};
  const tokensByChain = (res && res.tokens) || {};
  for (const [key, id] of Object.entries(CHAIN_ID)){
    const list = tokensByChain[id] || tokensByChain[String(id)] || [];
    // de-dupe + keep ones with symbols; native first
    const seen = new Set();
    byKey[key] = list.filter((t) => {
      if (!t || !t.address || !t.symbol) return false;
      const a = t.address.toLowerCase();
      if (seen.has(a)) return false;
      seen.add(a);
      return true;
    });
  }
  _tokensCache = byKey;
  _tokensAt = Date.now();
  return byKey;
}

/* normalize native address coming back from LI.FI to lowercase compare */
const isNative = (addr) => {
  const a = (addr || "").toLowerCase();
  return a === NATIVE || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
};

/* =================================================================== *
 *  On-chain primitives via window.ethereum (raw EIP-1193)
 * =================================================================== */
const toHexChain = (id) => "0x" + Number(id).toString(16);

async function currentChainId(){
  const p = provider();
  if (!p) return null;
  try { return parseInt(await p.request({ method: "eth_chainId" }), 16); } catch { return null; }
}

async function switchChain(targetId){
  const p = provider();
  if (!p) throw new Error("no wallet provider");
  const cur = await currentChainId();
  if (cur === targetId) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHexChain(targetId) }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error("Network switch rejected");
    throw new Error("Could not switch network — add it in your wallet first");
  }
  // verify
  const after = await currentChainId();
  if (after !== targetId) throw new Error("Wallet is on the wrong network");
}

/* eth_call helper (read-only). data is the encoded calldata. */
async function ethCall(to, data){
  const p = provider();
  return p.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}

/* ERC-20 allowance(owner,spender) — selector 0xdd62ed3e */
async function erc20Allowance(token, owner, spender){
  const data = "0xdd62ed3e" + owner.slice(2).padStart(64, "0").toLowerCase() + spender.slice(2).padStart(64, "0").toLowerCase();
  const res = await ethCall(token, data);
  try { return BigInt(res); } catch { return 0n; }
}

/* ERC-20 approve(spender,amount) calldata — selector 0x095ea7b3 */
function erc20ApproveData(spender, amount){
  const amt = BigInt(amount).toString(16).padStart(64, "0");
  return "0x095ea7b3" + spender.slice(2).padStart(64, "0").toLowerCase() + amt;
}

async function sendTx(tx){
  const p = provider();
  if (!p) throw new Error("no wallet provider");
  try {
    return await p.request({ method: "eth_sendTransaction", params: [tx] });
  } catch (e) {
    if (e?.code === 4001) throw new Error("Transaction rejected");
    throw new Error(e?.message ? e.message.split("\n")[0] : "Transaction failed");
  }
}

/* wait for a tx receipt on the active chain (best-effort) */
async function waitReceipt(hash, timeoutMs = 90_000){
  const p = provider();
  const start = Date.now();
  while (Date.now() - start < timeoutMs){
    let rec = null;
    try { rec = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }); } catch {}
    if (rec && rec.blockNumber){
      if (rec.status && Number(rec.status) === 0) throw new Error("Transaction reverted on-chain");
      return rec;
    }
    await sleep(2500);
  }
  throw new Error("Timed out waiting for confirmation");
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* =================================================================== *
 *  Modal framework — mirrors the app's .hl-modal visual language but
 *  scoped with .wa- classes (styled in wallet-actions.css). Appends to
 *  <body>, dismissible by backdrop click, Esc, and a close button.
 * =================================================================== */
let _openModal = null;

function closeModal(){
  if (!_openModal) return;
  const { el, onKey } = _openModal;
  document.removeEventListener("keydown", onKey);
  el.classList.remove("show");
  setTimeout(() => { try { el.remove(); } catch {} }, 180);
  _openModal = null;
}

function openModal({ title, bodyHtml, onMount, cardClass = "" }){
  closeModal();
  const el = document.createElement("div");
  el.className = "wa-modal";
  el.innerHTML = `
    <div class="wa-card ${esc(cardClass)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="wa-head">
        <h3>${esc(title)}</h3>
        <button class="wa-x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="wa-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(el);
  const card = el.querySelector(".wa-card");
  el.addEventListener("mousedown", (e) => { if (e.target === el) closeModal(); });
  el.querySelector(".wa-x").addEventListener("click", closeModal);
  const onKey = (e) => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);
  _openModal = { el, onKey };
  // animate in
  requestAnimationFrame(() => el.classList.add("show"));
  if (onMount) onMount(card);
  return card;
}

/* =================================================================== *
 *  RECEIVE — address + copyable string + offline QR
 * =================================================================== */
async function openReceive(){
  const addr = await ensureAccount();
  if (!addr) return;
  const chains = walletChains();

  let qrSvg = "";
  try { qrSvg = qrToSvg(QR.generate(addr), 220); }
  catch (e) { qrSvg = `<div class="wa-qr-fail">QR unavailable</div>`; }

  const chainChips = chains.map((c) => `<span class="wa-recv-chip">${esc(c.name)}</span>`).join("");
  const card = openModal({
    title: "Receive",
    cardClass: "wa-receivemodal",
    bodyHtml: `
      <div class="wa-receive">
        <div class="wa-swap-banner wa-recv-banner">
          <span class="wa-swap-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></span>
          <span class="wa-swap-txt"><b>Receive assets</b><em>one address · every EVM chain you hold</em></span>
        </div>
        <div class="wa-qr">${qrSvg}</div>
        <div class="wa-addr-box">
          <div class="wa-addr-lab">your address</div>
          <div class="wa-addr-val" id="waAddrVal">${esc(addr)}</div>
          <button class="btn ghost sm" id="waCopy" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy address</button>
        </div>
        <div class="wa-recv-chains">${chainChips}</div>
        <p class="wa-hint">Only send assets on these EVM networks.</p>
      </div>`,
  });

  const copyBtn = card.querySelector("#waCopy");
  copyBtn?.addEventListener("click", async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(addr); ok = true; } catch {}
    if (!ok){
      // fallback selection-copy
      try {
        const r = document.createRange();
        r.selectNodeContents(card.querySelector("#waAddrVal"));
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        ok = document.execCommand("copy"); sel.removeAllRanges();
      } catch {}
    }
    toast(ok ? "Address copied" : "Copy failed — select it manually", ok ? "ok" : "err");
  });
}

/* =================================================================== *
 *  EXCHANGE (Swap = same chain · Bridge = cross chain) — LI.FI quote
 * =================================================================== */
const SLIPPAGE = 0.005; // 0.5%

function tokenOptions(list, selectedAddr){
  return list.map((t) => {
    const sel = selectedAddr && t.address.toLowerCase() === selectedAddr.toLowerCase() ? " selected" : "";
    return `<option value="${esc(t.address)}"${sel}>${esc(t.symbol)}</option>`;
  }).join("");
}
function chainOptions(chains, selectedKey){
  return chains.map((c) => `<option value="${esc(c.key)}"${c.key === selectedKey ? " selected" : ""}>${esc(c.name)}</option>`).join("");
}
function findToken(list, addr){ return list.find((t) => t.address.toLowerCase() === (addr || "").toLowerCase()); }

async function openExchange(mode){
  // mode: "swap" (same chain) | "bridge" (cross chain)
  const addr = await ensureAccount();
  if (!addr) return;

  const chains = walletChains();
  let tokens;
  // show modal with a loading state while tokens load
  const card = openModal({
    title: mode === "bridge" ? "Bridge" : "Swap",
    cardClass: mode === "bridge" ? "wa-stargate" : "wa-swapmodal",
    bodyHtml: `<div class="wa-loading"><span class="wa-spin"></span> Loading tokens…</div>`,
  });

  try { tokens = await getTokens(); }
  catch (e) {
    if (card.querySelector(".wa-body"))
      card.querySelector(".wa-body").innerHTML = `<div class="wa-error">${esc(e.message || "Could not load tokens")}</div>`;
    return;
  }
  if (!_openModal) return; // user closed it while loading

  // sensible defaults: from = native of first chain, to = USDC of (other) chain
  const fromChainKey = chains[0].key;
  const toChainKey = mode === "bridge" ? (chains[1]?.key || chains[0].key) : fromChainKey;
  const fromList = tokens[fromChainKey] || [];
  const toList = tokens[toChainKey] || [];
  const defFrom = (fromList.find((t) => isNative(t.address)) || fromList[0])?.address;
  const usdcAddr = chains.find((c) => c.key === toChainKey)?.usdc;
  const defTo = (findToken(toList, usdcAddr) || toList.find((t) => !isNative(t.address)) || toList[0])?.address;

  card.querySelector(".wa-body").innerHTML = renderExchangeForm({ mode, chains, fromChainKey, toChainKey, fromList, toList, defFrom, defTo });
  wireExchangeForm(card, { mode, addr, chains, tokens });
}

function renderExchangeForm({ mode, chains, fromChainKey, toChainKey, fromList, toList, defFrom, defTo }){
  const crossChain = mode === "bridge";
  const banner = crossChain
    ? `<div class="wa-sg-banner"><span class="wa-sg-logo">${STARGATE_MARK}</span>
         <span class="wa-sg-txt"><b>Cross-chain bridge</b><em>powered by Stargate</em></span>
         <span class="wa-sg-badge">STG</span></div>`
    : `<div class="wa-swap-banner"><span class="wa-swap-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l4 4-4 4"/><path d="M21 7H7"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h14"/></svg></span>
         <span class="wa-swap-txt"><b>Instant swap</b><em>same chain · best rate via LI.FI</em></span></div>`;
  return `
    <div class="wa-ex ${crossChain ? "wa-ex-bridge" : "wa-ex-swap"}" data-mode="${mode}">
      ${banner}
      <div class="wa-leg">
        <div class="wa-leg-head"><span>From</span></div>
        <div class="wa-leg-row">
          ${crossChain ? `<select class="wa-sel" id="waFromChain">${chainOptions(chains, fromChainKey)}</select>` : `<input class="wa-sel wa-fixedchain" id="waFromChain" value="${esc(chains.find(c=>c.key===fromChainKey)?.name||"")}" data-key="${esc(fromChainKey)}" readonly />`}
          <select class="wa-sel" id="waFromToken">${tokenOptions(fromList, defFrom)}</select>
        </div>
        <input class="wa-amount" id="waAmount" type="text" inputmode="decimal" placeholder="0.0" autocomplete="off" />
      </div>

      <div class="wa-arrow" aria-hidden="true">↓</div>

      <div class="wa-leg">
        <div class="wa-leg-head"><span>To</span></div>
        <div class="wa-leg-row">
          ${crossChain ? `<select class="wa-sel" id="waToChain">${chainOptions(chains, toChainKey)}</select>` : `<input class="wa-sel wa-fixedchain" id="waToChain" value="${esc(chains.find(c=>c.key===toChainKey)?.name||"")}" data-key="${esc(toChainKey)}" readonly />`}
          <select class="wa-sel" id="waToToken">${tokenOptions(toList, defTo)}</select>
        </div>
        <div class="wa-receive-est" id="waEst">—</div>
      </div>

      <div class="wa-quote-meta" id="waQuoteMeta" hidden></div>

      <button class="btn accent wa-cta" id="waQuoteBtn" type="button">Get quote</button>
    </div>`;
}

function selectedChainKey(el){ return el ? (el.tagName === "SELECT" ? el.value : el.getAttribute("data-key")) : null; }

function wireExchangeForm(card, { mode, addr, chains, tokens }){
  const $ = (sel) => card.querySelector(sel);
  const fromChainEl = $("#waFromChain");
  const toChainEl = $("#waToChain");
  const fromTokenEl = $("#waFromToken");
  const toTokenEl = $("#waToToken");
  const amountEl = $("#waAmount");
  const estEl = $("#waEst");
  const metaEl = $("#waQuoteMeta");
  const ctaEl = $("#waQuoteBtn");

  let lastQuote = null;

  const repopulate = (chainEl, tokenEl, preferUsdc) => {
    const key = selectedChainKey(chainEl);
    const list = tokens[key] || [];
    let pref;
    if (preferUsdc){
      const usdc = chains.find((c) => c.key === key)?.usdc;
      pref = (findToken(list, usdc) || list.find((t) => !isNative(t.address)) || list[0])?.address;
    } else {
      pref = (list.find((t) => isNative(t.address)) || list[0])?.address;
    }
    tokenEl.innerHTML = tokenOptions(list, pref);
  };

  const resetQuote = () => {
    lastQuote = null;
    metaEl.hidden = true; metaEl.innerHTML = "";
    estEl.textContent = "—";
    ctaEl.textContent = "Get quote";
    ctaEl.classList.remove("wa-ready");
  };

  if (fromChainEl?.tagName === "SELECT") fromChainEl.addEventListener("change", () => { repopulate(fromChainEl, fromTokenEl, false); resetQuote(); });
  if (toChainEl?.tagName === "SELECT") toChainEl.addEventListener("change", () => { repopulate(toChainEl, toTokenEl, true); resetQuote(); });
  [fromTokenEl, toTokenEl].forEach((el) => el.addEventListener("change", resetQuote));
  amountEl.addEventListener("input", resetQuote);

  ctaEl.addEventListener("click", async () => {
    if (lastQuote){ await executeQuote(card, lastQuote, addr, () => { lastQuote = null; }); return; }

    const fromKey = selectedChainKey(fromChainEl);
    const toKey = selectedChainKey(toChainEl);
    const fromToken = fromTokenEl.value;
    const toToken = toTokenEl.value;
    const fromList = tokens[fromKey] || [];
    const fromTok = findToken(fromList, fromToken);
    if (!fromTok){ toast("Pick a token to send", "err"); return; }

    const amt = toBaseUnits(amountEl.value, fromTok.decimals);
    if (amt == null || amt <= 0n){ toast("Enter an amount", "err"); return; }

    if (mode === "swap" && fromToken.toLowerCase() === toToken.toLowerCase() && fromKey === toKey){
      toast("Choose two different tokens", "err"); return;
    }

    ctaEl.disabled = true; ctaEl.textContent = "Finding route…";
    try {
      const q = await lifiGet("/quote", {
        fromChain: CHAIN_ID[fromKey],
        toChain: CHAIN_ID[toKey],
        fromToken,
        toToken,
        fromAmount: amt.toString(),
        fromAddress: addr,
        slippage: SLIPPAGE,
        // Bridge mode routes exclusively through Stargate so "powered by
        // Stargate" is literally true (covers ETH/USDC on eth/arb/op/base).
        ...(mode === "bridge" ? { allowBridges: ["stargate", "stargateV2"] } : {}),
      });
      if (!q || !q.transactionRequest || !q.estimate) throw new Error("No route available");
      lastQuote = q;
      renderReview(q, { estEl, metaEl, ctaEl });
    } catch (e) {
      const m = (e.message || "").toLowerCase();
      if (m.includes("no available") || m.includes("no route") || m.includes("404")) toast("No route for that pair", "err");
      else toast(e.message || "Quote failed", "err");
      resetQuote();
    } finally {
      ctaEl.disabled = false;
    }
  });
}

function renderReview(q, { estEl, metaEl, ctaEl }){
  const est = q.estimate || {};
  const action = q.action || {};
  const toTok = action.toToken || {};
  const fromTok = action.fromToken || {};
  const toAmount = fromBaseUnits(est.toAmount || "0", toTok.decimals || 18, 6);
  const toMin = fromBaseUnits(est.toAmountMin || est.toAmount || "0", toTok.decimals || 18, 6);
  const routeName = q.toolDetails?.name || q.tool || "LI.FI route";

  // sum gas + fee costs in USD when LI.FI provides them
  const sumUsd = (arr) => (arr || []).reduce((s, x) => s + (parseFloat(x.amountUSD || x.amountUsd || 0) || 0), 0);
  const gasUsd = sumUsd(est.gasCosts);
  const feeUsd = sumUsd(est.feeCosts);
  const secs = est.executionDuration || 0;
  const eta = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`;

  estEl.textContent = `≈ ${toAmount} ${toTok.symbol || ""}`;
  metaEl.hidden = false;
  metaEl.innerHTML = `
    <div class="wa-q-row"><span>Route</span><b>${esc(routeName)}</b></div>
    <div class="wa-q-row"><span>You send</span><b>${esc(fromBaseUnits(est.fromAmount || action.fromAmount || "0", fromTok.decimals || 18, 6))} ${esc(fromTok.symbol || "")}</b></div>
    <div class="wa-q-row"><span>Min received</span><b>${esc(toMin)} ${esc(toTok.symbol || "")}</b></div>
    <div class="wa-q-row"><span>Network fee</span><b>${gasUsd ? "$" + gasUsd.toFixed(2) : "—"}</b></div>
    <div class="wa-q-row"><span>Protocol fee</span><b>${feeUsd ? "$" + feeUsd.toFixed(2) : "—"}</b></div>
    <div class="wa-q-row"><span>Slippage</span><b>${(SLIPPAGE * 100).toFixed(1)}%</b></div>
    <div class="wa-q-row"><span>Est. time</span><b>${esc(eta)}</b></div>`;
  ctaEl.textContent = "Confirm & sign ▸";
  ctaEl.classList.add("wa-ready");
}

/* drive the signed, on-chain execution of a LI.FI quote */
async function executeQuote(card, quote, addr, onDone){
  const ctaEl = card.querySelector("#waQuoteBtn");
  const metaEl = card.querySelector("#waQuoteMeta");
  const action = quote.action || {};
  const est = quote.estimate || {};
  const txReq = quote.transactionRequest || {};
  const fromChainId = action.fromChainId || Number(txReq.chainId);
  const toChainId = action.toChainId || fromChainId;
  const fromToken = action.fromToken || {};
  const fromAmount = BigInt(est.fromAmount || action.fromAmount || "0");
  // spender for approve() is LI.FI's canonical approvalAddress (the router/
  // diamond that pulls the tokens); fall back to the tx `to` if absent.
  const spender = est.approvalAddress || txReq.to;

  const setStatus = (msg) => {
    metaEl.hidden = false;
    let line = card.querySelector("#waStatus");
    if (!line){
      line = document.createElement("div");
      line.id = "waStatus";
      line.className = "wa-status";
      metaEl.appendChild(line);
    }
    line.innerHTML = `<span class="wa-spin"></span> ${esc(msg)}`;
  };

  ctaEl.disabled = true;
  try {
    // 1. switch to the source chain first
    setStatus("Switching network…");
    await switchChain(fromChainId);

    // 2. ERC-20 approval if needed (native token needs none)
    if (!isNative(fromToken.address)){
      setStatus("Checking allowance…");
      const allowance = await erc20Allowance(fromToken.address, addr, spender);
      if (allowance < fromAmount){
        setStatus("Approve token spend in your wallet…");
        const approveTx = {
          from: addr,
          to: fromToken.address,
          data: erc20ApproveData(spender, fromAmount.toString()),
        };
        const approveHash = await sendTx(approveTx);
        setStatus("Waiting for approval to confirm…");
        await waitReceipt(approveHash);
        toast("Token approved", "ok");
      }
    }

    // 3. send the LI.FI transactionRequest
    setStatus("Confirm the transaction in your wallet…");
    // Forward to/data/value from LI.FI; let the wallet estimate gas itself so
    // we don't mix legacy gasPrice with EIP-1559 wallets or send a stale limit.
    const tx = {
      from: addr,
      to: txReq.to,
      data: txReq.data,
      value: txReq.value || "0x0",
    };
    const txHash = await sendTx(tx);
    toast("Transaction submitted", "ok");

    // 4. poll LI.FI status until DONE / FAILED
    setStatus(fromChainId === toChainId ? "Settling swap…" : "Bridging — this can take a few minutes…");
    const result = await pollStatus(txHash, fromChainId, toChainId);

    if (result === "DONE"){
      toast("Done — funds delivered", "ok");
      reloadWallet();
      closeModal();
    } else {
      toast("Transfer failed on-chain", "err");
      ctaEl.disabled = false;
    }
    if (onDone) onDone();
  } catch (e) {
    toast(e.message || "Transaction failed", "err");
    const s = card.querySelector("#waStatus"); if (s) s.remove();
    ctaEl.disabled = false;
  }
}

async function pollStatus(txHash, fromChainId, toChainId, timeoutMs = 8 * 60_000){
  const start = Date.now();
  let delay = 4000;
  while (Date.now() - start < timeoutMs){
    try {
      const s = await lifiGet("/status", { txHash, fromChain: fromChainId, toChain: toChainId });
      const status = s && s.status;
      if (status === "DONE") return "DONE";
      if (status === "FAILED") return "FAILED";
      // NOT_FOUND / PENDING → keep polling
    } catch (_){ /* transient — keep polling */ }
    await sleep(delay);
    delay = Math.min(delay * 1.3, 12000);
  }
  return "PENDING";
}

/* =================================================================== *
 *  WIRE BUTTONS
 * =================================================================== */
function focusQuickSend(){
  const card = document.querySelector(".send-card");
  const input = document.querySelector("#sendTo");
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (input) setTimeout(() => { try { input.focus(); } catch {} }, 350);
}

function bind(id, handler){
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", (e) => { e.preventDefault(); handler(); });
}

function initWalletActions(){
  bind("walletReceive", () => openReceive().catch((e) => toast(e?.message || "Error", "err")));
  bind("walletSwap",    () => openExchange("swap").catch((e) => toast(e?.message || "Error", "err")));
  bind("walletBridge",  () => openExchange("bridge").catch((e) => toast(e?.message || "Error", "err")));
  bind("walletSendTop", focusQuickSend);
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", initWalletActions);
} else {
  initWalletActions();
}

