/* ============================================================ *
 *  shared.js — wallet connect, nostr derivation, utilities
 * ============================================================ */

let schnorr, sha256, bech32;
let cryptoReady = false;
// Crypto is vendored locally (assets/vendor/crypto.js) — no third-party CDN in
// the signing path. schnorr lives in @noble/curves (it was removed from
// @noble/secp256k1 v2.x, which is why the old esm.sh import yielded `undefined`
// and every derivation threw after the wallet signature).
const cryptoReadyPromise = (async () => {
  try {
    ({ schnorr, sha256, bech32 } = await import("../vendor/crypto.js"));
    cryptoReady = true;
  } catch (e) {
    console.warn("[cm] Nostr crypto libs failed to load:", e);
  }
})();

const LS = {
  ADDR: "cm:addr",
  NPUB: "cm:npub",
  PRIV: "cm:priv",   // kept on-device only; re-derivable from the wallet signature
};

// A derived Nostr private key is exactly 32 bytes of lowercase hex.
const isValidPrivHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isValidNpub    = (s) => typeof s === "string" && /^npub1[0-9a-z]+$/.test(s);

export const state = {
  account: null,
  derived: null, // { addr, sig, priv, npub }
  listeners: new Set(),
};

export function onChange(cb){ state.listeners.add(cb); return () => state.listeners.delete(cb); }
function emit(){ state.listeners.forEach(cb => cb(state)); }

export const shortAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
export const shortNpub = (n) => n ? `${n.slice(0,12)}…${n.slice(-6)}` : "—";

export function hexToBytes(h){
  if (h.startsWith("0x")) h = h.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i=0;i<out.length;i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return out;
}
export const bytesToHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2,"0")).join("");

export async function awaitCrypto(){ await cryptoReadyPromise; return cryptoReady; }

export const DERIVATION_MSG = "LZidentity — derive my Nostr name\n\nBy signing, you let LZidentity turn this signature into a Nostr identity that's the twin of your wallet. Same wallet, same name, every time.\n\nThis is a safe signature — it doesn't move any funds or approve any transaction.";

export async function connectWallet(){
  if (!window.ethereum) throw new Error("no_provider");
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accts || !accts.length) throw new Error("no_account");
  state.account = accts[0];
  localStorage.setItem(LS.ADDR, state.account);
  emit();
  return state.account;
}

export function disconnectWallet(){
  state.account = null;
  state.derived = null;
  localStorage.removeItem(LS.ADDR);
  localStorage.removeItem(LS.NPUB);
  localStorage.removeItem(LS.PRIV);
  emit();
}

export async function deriveNostr(){
  await awaitCrypto();
  if (!cryptoReady) throw new Error("crypto_unavailable");
  if (!state.account) throw new Error("no_account");

  const sig = await window.ethereum.request({
    method: "personal_sign",
    params: [DERIVATION_MSG, state.account],
  });

  const sigBytes = hexToBytes(sig);
  let priv = sha256(sigBytes);
  if (priv[0] === 0) priv = sha256(priv);
  const xOnly = schnorr.getPublicKey(priv);
  const words = bech32.toWords(xOnly);
  const npub = bech32.encode("npub", words, 1000);

  state.derived = { addr: state.account, sig, priv: bytesToHex(priv), npub };
  localStorage.setItem(LS.NPUB, npub);
  localStorage.setItem(LS.PRIV, state.derived.priv);
  emit();
  return state.derived;
}

export async function bootstrapWallet(){
  const savedAddr = localStorage.getItem(LS.ADDR);
  const savedNpub = localStorage.getItem(LS.NPUB);
  const savedPriv = localStorage.getItem(LS.PRIV);
  if (savedAddr){
    state.account = savedAddr;
    if (isValidNpub(savedNpub) && isValidPrivHex(savedPriv)){
      state.derived = { addr: savedAddr, sig: null, priv: savedPriv, npub: savedNpub };
    } else if (savedNpub || savedPriv){
      // Corrupt/tampered storage — drop it rather than feed a bad key to signEvent.
      localStorage.removeItem(LS.NPUB);
      localStorage.removeItem(LS.PRIV);
    }
    emit();
  }
  // re-attach to ethereum events
  if (window.ethereum && window.ethereum.on){
    window.ethereum.on("accountsChanged", (accs) => {
      if (!accs || !accs.length){ disconnectWallet(); return; }
      const next = accs[0];
      if (state.account !== next){
        state.account = next;
        localStorage.setItem(LS.ADDR, next);
        // invalidate derived since address changed
        state.derived = null;
        localStorage.removeItem(LS.NPUB);
        localStorage.removeItem(LS.PRIV);
        emit();
      }
    });
    window.ethereum.on("chainChanged", () => location.reload());
  }
  // probe silently to refresh account if extension is connected
  if (savedAddr && window.ethereum){
    try {
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (!accs || !accs.length){
        // saved but extension says no — clear
        state.account = null;
        localStorage.removeItem(LS.ADDR);
        emit();
      } else if (accs[0].toLowerCase() !== savedAddr.toLowerCase()){
        state.account = accs[0];
        localStorage.setItem(LS.ADDR, accs[0]);
        state.derived = null;
        localStorage.removeItem(LS.NPUB);
        localStorage.removeItem(LS.PRIV);
        emit();
      }
    } catch(_){}
  }
}

/* ----- Toast ----- */
let toastEl, toastMsgEl, toastLabEl;
function ensureToast(){
  if (toastEl) return;
  toastEl = document.querySelector(".toast");
  if (!toastEl){
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.innerHTML = '<span class="lab">LZ</span><span class="msg">—</span>';
    document.body.appendChild(toastEl);
  }
  toastMsgEl = toastEl.querySelector(".msg") || toastEl.querySelector("#toastMsg");
  toastLabEl = toastEl.querySelector(".lab");
}
export function toast(msg, tone="info", duration=3200){
  ensureToast();
  // tolerate toast(msg, durationMs) — several call sites pass a number as the 2nd arg
  if (typeof tone === "number"){ duration = tone; tone = "info"; }
  if (toastMsgEl) toastMsgEl.textContent = msg;
  toastEl.style.borderColor = tone === "ok" ? "rgba(134,239,172,.4)" : tone === "err" ? "rgba(253,164,175,.4)" : "rgba(255,255,255,.16)";
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), Math.max(1500, duration));
}

/* ----- Number formatters ----- */
export const fmt = {
  usd: (n) => n == null ? "—" : n < 0.01 ? `$${n.toFixed(6)}` : n < 1 ? `$${n.toFixed(4)}` : n < 1000 ? `$${n.toFixed(2)}` : n.toLocaleString("en-US", { style:"currency", currency:"USD", maximumFractionDigits: n > 10000 ? 0 : 2 }),
  pct: (n) => n == null ? "—" : `${n >= 0 ? "+" : "−"} ${Math.abs(n).toFixed(2)}%`,
  compact: (n) => n == null ? "—" : Intl.NumberFormat("en-US", { notation:"compact", maximumFractionDigits:1 }).format(n),
  int: (n) => n == null ? "—" : Math.round(n).toLocaleString("en-US"),
};

export function clockTickerUTC(el){
  const tick = () => {
    const d = new Date();
    el.textContent = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")} UTC`;
  };
  tick(); return setInterval(tick, 1000);
}

export async function copyToClipboard(s){
  try { await navigator.clipboard.writeText(s); return true; } catch { return false; }
}
