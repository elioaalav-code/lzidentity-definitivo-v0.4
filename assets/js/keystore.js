/* ============================================================ *
 *  keystore.js — protect the derived Nostr key at rest (v0.7 F1).
 *
 *  The identity card used to warn: "The derived private key is held
 *  in localStorage for this demo… Production builds should wrap it
 *  with a WebAuthn PRF passkey or NIP-49 encryption." This module IS
 *  that wrap:
 *
 *    · protectWithPasskey()     WebAuthn PRF → HKDF-SHA256 → AES-GCM-256
 *    · protectWithPassphrase()  scrypt (NIP-49 params, log_n 16) → AES-GCM-256
 *    · unlock() / lock()        ciphertext ↔ in-memory state.derived.priv
 *
 *  Storage: cm:keystore JSON {v, kind, npub, iv, ct, credId+prfSalt | salt}.
 *  Plaintext cm:priv is DELETED on protect. Legacy plaintext keys keep
 *  working ("unprotected" + upgrade CTA on the Identity card). The
 *  keystore is bound to the npub it encrypted — deriving a different
 *  wallet invalidates it (handled on lz:derived).
 *
 *  Honesty note: the passphrase path uses NIP-49's scrypt parameters
 *  but stores a plain AES-GCM blob, not the NIP-49 ncryptsec container.
 *
 *  Also owns the #idProtection card on the Identity view.
 *  Public API: window.LZ.keys = { status, unlock, lock,
 *                                 protectWithPasskey, protectWithPassphrase }
 * ============================================================ */

import { state, onChange, toast, pokeListeners } from "./shared.js";

const KS = "cm:keystore";
const PRIV = "cm:priv";
const HKDF_SALT = new TextEncoder().encode("lz-keystore-v1");

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function readKS() {
  try { return JSON.parse(localStorage.getItem(KS) || "null"); } catch (_) { return null; }
}

export function status() {
  const ks = readKS();
  if (ks) return state.derived && state.derived.priv ? "unlocked" : "locked";
  if (state.derived && state.derived.priv) return "unprotected";
  return "none";
}

/* ── crypto primitives (WebCrypto only; scrypt lazily from esm.sh) ── */
async function aesKeyFromBits(bits) {
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function hkdf(bits) {
  const km = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new Uint8Array(0) }, km, 256);
}
async function prfBits(credIdBytes, prfSaltBytes) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: "public-key", id: credIdBytes }],
    userVerification: "required",
    timeout: 60000,
    extensions: { prf: { eval: { first: prfSaltBytes } } },
  } });
  const out = assertion && assertion.getClientExtensionResults
    ? assertion.getClientExtensionResults().prf?.results?.first : null;
  if (!out) throw new Error("prf_failed");
  return hkdf(out);
}
let _scrypt = null;
async function pwBits(pw, saltBytes) {
  if (!_scrypt) ({ scrypt: _scrypt } = await import("https://esm.sh/@noble/hashes@1.4.0/scrypt"));
  // NIP-49 default parameters (log_n=16, r=8, p=1) — ~300ms, deliberate
  return _scrypt(new TextEncoder().encode(String(pw).normalize("NFKC")), saltBytes, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 });
}
async function encryptPriv(aesKey, privHex) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(privHex));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptPriv(aesKey, ks) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(ks.iv) }, aesKey, ub64(ks.ct));
  const priv = new TextDecoder().decode(pt);
  if (!/^[0-9a-f]{64}$/.test(priv)) throw new Error("bad_decrypt");
  return priv;
}

/* ── protect ── */
export async function protectWithPasskey() {
  if (!state.derived || !state.derived.priv) throw new Error("no_key");
  if (!window.PublicKeyCredential) throw new Error("prf_unsupported");
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "LZidentity" },
    user: {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: (state.derived.npub || "lzidentity").slice(0, 28),
      displayName: "LZidentity key",
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: 60000,
    extensions: { prf: {} },
  } });
  const enabled = cred && cred.getClientExtensionResults && cred.getClientExtensionResults().prf?.enabled;
  if (!enabled) throw new Error("prf_unsupported");
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const aes = await aesKeyFromBits(await prfBits(new Uint8Array(cred.rawId), prfSalt));
  const { iv, ct } = await encryptPriv(aes, state.derived.priv);
  localStorage.setItem(KS, JSON.stringify({ v: 1, kind: "prf", npub: state.derived.npub, credId: b64(cred.rawId), prfSalt: b64(prfSalt), iv, ct }));
  localStorage.removeItem(PRIV);
  renderCard(); pokeListeners();
  toast("Key protected by passkey", "ok");
  return true;
}

export async function protectWithPassphrase(pw) {
  if (!state.derived || !state.derived.priv) throw new Error("no_key");
  if (!pw || String(pw).length < 8) throw new Error("weak_passphrase");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aes = await aesKeyFromBits(await pwBits(pw, salt));
  const { iv, ct } = await encryptPriv(aes, state.derived.priv);
  localStorage.setItem(KS, JSON.stringify({ v: 1, kind: "pw", npub: state.derived.npub, salt: b64(salt), iv, ct }));
  localStorage.removeItem(PRIV);
  renderCard(); pokeListeners();
  toast("Key protected by passphrase", "ok");
  return true;
}

/* ── lock / unlock ── */
export function lock() {
  if (!readKS()) return false; // nothing protects the key at rest — refuse to drop it
  if (state.derived) state.derived.priv = null;
  renderCard(); pokeListeners();
  return true;
}

let _unlocking = null;
export function unlock() {
  if (_unlocking) return _unlocking;
  _unlocking = _unlock().finally(() => { _unlocking = null; });
  return _unlocking;
}
async function _unlock() {
  const ks = readKS();
  if (!ks) return false;
  if (state.derived && state.derived.priv) return true;
  if (ks.npub && state.derived && state.derived.npub && ks.npub !== state.derived.npub) {
    toast("Keystore belongs to a different identity — derive and protect again", "err");
    return false;
  }
  let priv;
  try {
    if (ks.kind === "prf") {
      priv = await decryptPriv(await aesKeyFromBits(await prfBits(ub64(ks.credId), ub64(ks.prfSalt))), ks);
    } else {
      const pw = await askPassphrase("Unlock your identity", "Enter the passphrase that protects your key.");
      if (pw == null) return false;
      priv = await decryptPriv(await aesKeyFromBits(await pwBits(pw, ub64(ks.salt))), ks);
    }
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return false; // user cancelled
    toast(ks.kind === "pw" ? "Wrong passphrase" : "Unlock failed", "err");
    return false;
  }
  state.derived = Object.assign(state.derived || { addr: state.account, sig: null, npub: ks.npub }, { priv });
  window.dispatchEvent(new CustomEvent("lz:keys-unlocked"));
  renderCard(); pokeListeners();
  toast("Identity unlocked", "ok");
  return true;
}

/* ── passphrase modals (LZUI.modal; prompt() fallback) ── */
function askPassphrase(title, hint, confirmField = false) {
  const ui = window.LZUI;
  if (!ui || !ui.modal) {
    const pw = prompt(hint);
    return Promise.resolve(pw == null || pw === "" ? null : pw);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = ui.modal({
      title,
      width: "min(420px, 92vw)",
      onClose: () => done(null),
      body: `
        <p class="ks-hint">${hint}</p>
        <input type="password" id="ksPw" class="ks-input" placeholder="Passphrase (min 8 chars)" autocomplete="off" />
        ${confirmField ? `<input type="password" id="ksPw2" class="ks-input" placeholder="Repeat passphrase" autocomplete="off" />` : ``}
        <p class="ks-err" id="ksErr" hidden></p>
        <button type="button" class="btn accent" id="ksGo">Continue</button>`,
    });
    const go = () => {
      const pw = m.body.querySelector("#ksPw").value;
      const err = m.body.querySelector("#ksErr");
      if (!pw || pw.length < 8) { err.hidden = false; err.textContent = "At least 8 characters."; return; }
      if (confirmField && pw !== m.body.querySelector("#ksPw2").value) { err.hidden = false; err.textContent = "Passphrases don't match."; return; }
      done(pw); m.close();
    };
    m.body.querySelector("#ksGo").addEventListener("click", go);
    m.body.querySelectorAll(".ks-input").forEach((i) =>
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }));
    m.body.querySelector("#ksPw").focus();
  });
}

/* protect flow from the card: passkey first, passphrase as honest fallback */
async function protectFlow() {
  try {
    await protectWithPasskey();
    return;
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return; // user cancelled the passkey sheet
    if (!(e && (e.message === "prf_unsupported" || e.message === "prf_failed"))) {
      console.warn("[keystore] passkey protect failed:", e);
    }
  }
  const pw = await askPassphrase("Protect with a passphrase",
    "This browser/authenticator doesn't support PRF passkeys. Your key will be encrypted with scrypt + AES-GCM instead.", true);
  if (pw == null) return;
  try { await protectWithPassphrase(pw); }
  catch (e) { toast("Could not protect the key", "err"); console.warn("[keystore]", e); }
}

/* ── re-derive while protected: re-encrypt the NEW key, or fall back ── */
window.addEventListener("lz:derived", async () => {
  const ks = readKS();
  if (!ks || !state.derived || !state.derived.priv) return;
  try {
    if (ks.kind === "prf") {
      const aes = await aesKeyFromBits(await prfBits(ub64(ks.credId), ub64(ks.prfSalt)));
      const { iv, ct } = await encryptPriv(aes, state.derived.priv);
      localStorage.setItem(KS, JSON.stringify({ ...ks, npub: state.derived.npub, iv, ct }));
      toast("New key protected by your passkey", "ok");
    } else {
      const pw = await askPassphrase("Re-protect your new key", "You re-derived your identity. Enter your passphrase to protect the new key.");
      if (pw == null) throw new Error("cancelled");
      const aes = await aesKeyFromBits(await pwBits(pw, ub64(ks.salt)));
      const { iv, ct } = await encryptPriv(aes, state.derived.priv);
      localStorage.setItem(KS, JSON.stringify({ ...ks, npub: state.derived.npub, iv, ct }));
      toast("New key protected", "ok");
    }
  } catch (_) {
    // do not strand the user: drop the stale keystore, keep the session key plaintext (legacy mode)
    localStorage.removeItem(KS);
    try { localStorage.setItem(PRIV, state.derived.priv); } catch (_) {}
    toast("Protection was reset for the new key — protect it again from Identity", "err");
  }
  renderCard();
});

/* ── the #idProtection card on the Identity view ── */
const ICN_SHIELD = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/></svg>`;

function renderCard() {
  const el = document.getElementById("idProtection");
  if (!el) return;
  const st = status();
  const lab = (color, text) => `<div class="lab" style="color:${color}">${ICN_SHIELD} ${text}</div>`;
  if (st === "unlocked" || st === "locked") {
    const ks = readKS() || {};
    const how = ks.kind === "prf" ? "passkey" : "passphrase";
    el.innerHTML = `
      ${lab("var(--success)", `SECURITY · PROTECTED`)}
      <div class="v prose">Your key is encrypted at rest (${how === "passkey" ? "WebAuthn PRF passkey" : "scrypt passphrase"} + AES-GCM)${st === "locked" ? " and currently locked." : "."}</div>
      <div class="ks-row">
        ${st === "locked"
          ? `<button type="button" class="btn accent sm" id="ksUnlockBtn">Unlock with ${how} →</button>`
          : `<button type="button" class="btn ghost sm" id="ksLockBtn">Lock now</button>`}
      </div>`;
    el.querySelector("#ksUnlockBtn")?.addEventListener("click", () => unlock());
    el.querySelector("#ksLockBtn")?.addEventListener("click", () => lock());
  } else if (st === "unprotected") {
    el.innerHTML = `
      ${lab("var(--warn)", "SECURITY · UNPROTECTED")}
      <div class="v prose">The derived private key sits in plain localStorage so the dApp can sign without re-prompting. Wrap it with a passkey — unlock with Touch ID instead.</div>
      <div class="ks-row"><button type="button" class="btn accent sm" id="ksProtectBtn">Protect with passkey →</button></div>`;
    el.querySelector("#ksProtectBtn")?.addEventListener("click", protectFlow);
  } else {
    el.innerHTML = `
      ${lab("var(--text-mute)", "SECURITY · KEY PROTECTION")}
      <div class="v prose">Derive your identity first — then protect the key with a passkey (Touch ID) so it never sits in plain storage.</div>`;
  }
}

onChange(renderCard);
renderCard();

/* ── self-mount ── */
window.LZ = window.LZ || {};
window.LZ.keys = { status, unlock, lock, protectWithPasskey, protectWithPassphrase };
