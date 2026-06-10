/* ============================================================ *
 *  idlink.js — Identity Link: a verifiable npub ↔ EVM attestation
 *  (v0.7 F3). "One you, every chain", made functional.
 *
 *  The artifact is a Nostr kind-30078 (NIP-78 app data, parameterized
 *  replaceable) event with ["d","lz:idlink"], authored BY the npub,
 *  whose content carries an EIP-191 personal_sign FROM the EVM address
 *  over a message naming both. Two signatures, two directions:
 *    · the Nostr event sig proves the npub said it
 *    · the recovered EVM sig proves the address agreed
 *  No server, no registry — any client can verify it from relays.
 *
 *  Used by: the Identity view card (#idLink), the chat thread head
 *  (verified ✓ + Send), and the wallet quick-send npub resolution.
 *
 *  Public API: window.LZ.idlink = { publishLink, fetchLink,
 *                                   resolveNpubAddress, myLink }
 * ============================================================ */

import { state, onChange, toast, hexToBytes, bytesToHex, shortAddr } from "./shared.js";
import { openPool, signEvent, npubEncode, eventId, awaitCrypto } from "./nostr.js";

const LINK_D = "lz:idlink";
const LINK_KIND = 30078;
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

/* crypto for EIP-191 recovery + schnorr — exact same esm.sh builds the app
   already ships (hyperliquid.js / shared.js / nostr.js), warm CDN cache.
   NOTE: @noble/secp256k1 v2 = ECDSA recovery; schnorr = @noble/curves. */
let _keccak = null, _secp = null, _schnorr = null;
async function cryptoBits() {
  if (!_keccak) ({ keccak_256: _keccak } = await import("https://esm.sh/@noble/hashes@1.4.0/sha3"));
  if (!_secp) _secp = await import("https://esm.sh/@noble/secp256k1@2.1.0");
  if (!_schnorr) ({ schnorr: _schnorr } = await import("https://esm.sh/@noble/curves@1.4.0/secp256k1"));
  return { keccak: _keccak, secp: _secp, schnorr: _schnorr };
}

const S = {
  pool: null,
  cache: new Map(), // pubHex → { state:"verified"|"none", addr?, at? } | Promise
  mine: null,       // my own verified link {addr,at} | null | "unknown"
};

function pool() {
  if (!S.pool) { try { S.pool = openPool(RELAYS); } catch (_) { S.pool = null; } }
  return S.pool;
}

export function linkMessage(npub, addr) {
  return `LZidentity link v1: ${npub} <-> ${String(addr).toLowerCase()}`;
}

/* EIP-191 digest of a plain ASCII message */
async function eip191Digest(msg) {
  const { keccak } = await cryptoBits();
  const body = new TextEncoder().encode(msg);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const full = new Uint8Array(prefix.length + body.length);
  full.set(prefix); full.set(body, prefix.length);
  return keccak(full);
}

/* verify one kind-30078 lz:idlink event → {addr,at} or null.
   BOTH layers are checked: the Nostr schnorr signature (otherwise a hostile
   relay could attribute an attacker-signed link to the victim's pubkey and
   misdirect payments) and the recovered EIP-191 wallet signature. */
export async function verifyLinkEvent(evt) {
  try {
    if (!evt || evt.kind !== LINK_KIND || !evt.pubkey || !evt.id || !evt.sig) return null;
    const c = JSON.parse(evt.content || "{}");
    if (c.v !== 1 || !c.addr || !c.sig) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.addr)) return null;
    await awaitCrypto();
    // layer 1: the event really is by evt.pubkey (id recompute + schnorr)
    if (eventId(evt) !== evt.id) return null;
    const { schnorr } = await cryptoBits();
    let sigOk = false;
    try { sigOk = schnorr.verify(hexToBytes(evt.sig), hexToBytes(evt.id), hexToBytes(evt.pubkey)); }
    catch (_) { sigOk = false; }
    if (!sigOk) return null;
    const npub = npubEncode(evt.pubkey);
    if (!npub) return null;
    const digest = await eip191Digest(linkMessage(npub, c.addr));
    const { keccak, secp } = await cryptoBits();
    const sigBytes = hexToBytes(c.sig);
    if (sigBytes.length !== 65) return null;
    const v = sigBytes[64];
    const rec = v >= 27 ? v - 27 : v;
    if (rec !== 0 && rec !== 1) return null;
    const sig = secp.Signature.fromCompact(sigBytes.slice(0, 64)).addRecoveryBit(rec);
    const raw = sig.recoverPublicKey(digest).toRawBytes(false); // 04 || x || y
    const addr = "0x" + bytesToHex(keccak(raw.slice(1)).slice(-20));
    return addr === c.addr.toLowerCase()
      ? { addr: c.addr.toLowerCase(), at: evt.created_at || 0 }
      : null;
  } catch (_) { return null; }
}

/* publish (or replace) MY link — wallet personal_sign + nostr signEvent */
export async function publishLink() {
  if (!state.account) throw new Error("no_account");
  if (!state.derived || !state.derived.npub) throw new Error("no_identity");
  if (!state.derived.priv) throw new Error("locked");
  if (!window.ethereum) throw new Error("no_provider");
  const addr = state.account.toLowerCase();
  const msg = linkMessage(state.derived.npub, addr);
  const sig = await window.ethereum.request({ method: "personal_sign", params: [msg, state.account] });
  // self-check before publishing — never put an unverifiable link on relays
  const evtDraft = {
    kind: LINK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", LINK_D]],
    content: JSON.stringify({ v: 1, addr, sig }),
  };
  const signed = await signEvent(evtDraft, state.derived.priv);
  const ok = await verifyLinkEvent(signed);
  if (!ok) throw new Error("self_verify_failed");
  const p = pool();
  if (!p) throw new Error("relays_unreachable");
  const res = await p.publish(signed);
  const accepted = !Array.isArray(res) || res.some((r) => r && r.ok);
  if (!accepted) throw new Error("relays_rejected");
  S.mine = ok;
  S.cache.set(signed.pubkey, { state: "verified", ...ok });
  renderCard();
  return ok;
}

/* fetch + verify someone's link (cached; resolves "none" after EOSE/timeout) */
export function fetchLink(pubHex) {
  const hit = S.cache.get(pubHex);
  if (hit) return Promise.resolve(hit).then((v) => v);
  const p = pool();
  if (!p || !p.sub) return Promise.resolve({ state: "none" });
  const prom = new Promise((resolve) => {
    let best = null, done = false;
    const finish = async () => {
      if (done) return; done = true;
      try { p.unsub(sub); } catch (_) {}
      const ok = best ? await verifyLinkEvent(best) : null;
      const val = ok ? { state: "verified", ...ok } : { state: "none" };
      S.cache.set(pubHex, val);
      resolve(val);
    };
    const sub = p.sub(
      [{ kinds: [LINK_KIND], authors: [pubHex], "#d": [LINK_D], limit: 3 }],
      {
        onEvent: (evt) => { if (!best || (evt.created_at || 0) > (best.created_at || 0)) best = evt; },
        onEose: finish,
      }
    );
    setTimeout(finish, 6000);
  });
  S.cache.set(pubHex, prom);
  return prom;
}

/* npub or hex → verified {addr} or null (quick-send resolution) */
export async function resolveNpubAddress(input) {
  const hex = toPubHex(String(input || "").trim());
  if (!hex) return null;
  const link = await fetchLink(hex);
  return link && link.state === "verified" ? link : null;
}

export function myLink() { return S.mine; }

/* ── minimal bech32 npub→hex (mirror of the chat-nostr.js inline decoder;
      kept local so quick-send doesn't pull the whole chat module) ── */
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function toPubHex(s) {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (!s.startsWith("npub1")) return "";
  try {
    const lower = s.toLowerCase();
    const data = [];
    for (const ch of lower.slice(5)) { const v = B32.indexOf(ch); if (v === -1) return ""; data.push(v); }
    const words = data.slice(0, -6);
    let acc = 0, bits = 0; const out = [];
    for (const value of words) {
      acc = (acc << 5) | value; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
    }
    if (out.length !== 32) return "";
    return out.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_) { return ""; }
}

/* ── the #idLink card on the Identity view ── */
const ICN_LINK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`;

async function refreshMine() {
  if (!state.derived || !state.derived.npub) { S.mine = null; renderCard(); return; }
  // resolve my own pub hex from the keystore-independent npub
  const hex = toPubHex(state.derived.npub);
  if (!hex) { S.mine = null; renderCard(); return; }
  S.mine = "checking";
  renderCard();
  const link = await fetchLink(hex);
  S.mine = link && link.state === "verified" ? link : null;
  renderCard();
}

function renderCard() {
  const el = document.getElementById("idLink");
  if (!el) return;
  const lab = (color, text) => `<div class="lab" style="color:${color}">${ICN_LINK} ${text}</div>`;
  if (!state.derived) {
    el.innerHTML = `${lab("var(--text-mute)", "IDENTITY LINK")}
      <div class="v prose">Derive your identity, then link your EVM address to it — signed both ways, verifiable by anyone, so people can pay your npub.</div>`;
    return;
  }
  if (S.mine && S.mine !== "checking" && S.mine.addr) {
    el.innerHTML = `${lab("var(--success)", "IDENTITY LINK · VERIFIED")}
      <div class="v prose">This npub is publicly linked to <b class="idlink-addr">${shortAddr(S.mine.addr)}</b> — contacts see a verified badge and can send funds to your name.</div>
      <div class="ks-row"><button type="button" class="btn ghost sm" id="idLinkRe">Re-link</button></div>`;
    el.querySelector("#idLinkRe")?.addEventListener("click", doPublish);
    return;
  }
  if (S.mine === "checking") {
    el.innerHTML = `${lab("var(--text-mute)", "IDENTITY LINK")}
      <div class="v prose">Checking relays for an existing link…</div>`;
    return;
  }
  const locked = !state.derived.priv;
  el.innerHTML = `${lab("var(--warn)", "IDENTITY LINK · NOT LINKED")}
    <div class="v prose">Publish a two-way signed attestation (wallet signature + Nostr event) so anyone can verify this npub and ${state.account ? shortAddr(state.account) : "your address"} are the same you${locked ? ". Unlock your key first." : "."}</div>
    <div class="ks-row"><button type="button" class="btn accent sm" id="idLinkGo" ${locked || !state.account ? "disabled" : ""}>Link EVM address →</button></div>`;
  el.querySelector("#idLinkGo")?.addEventListener("click", doPublish);
}

async function doPublish() {
  try {
    toast("Sign the link message in your wallet…");
    const ok = await publishLink();
    toast(`Linked to ${shortAddr(ok.addr)} — published to relays`, "ok");
  } catch (e) {
    const m = String(e && e.message || e);
    toast(
      m === "locked" ? "Unlock your key first" :
      m === "no_account" ? "Connect a wallet first" :
      m === "no_identity" ? "Derive your identity first" :
      e && e.code === 4001 ? "Signature rejected" :
      "Could not publish the link", "err");
  }
}

if (!window.__lzIdlinkBooted) {
  window.__lzIdlinkBooted = true;
  onChange(() => { renderCard(); });
  window.addEventListener("lz:keys-unlocked", renderCard);
  window.addEventListener("lz:derived", () => { S.mine = null; refreshMine(); });
  renderCard();
  refreshMine();
}

/* ── self-mount ── */
window.LZ = window.LZ || {};
window.LZ.idlink = { publishLink, fetchLink, resolveNpubAddress, myLink };

export { S as _state };
