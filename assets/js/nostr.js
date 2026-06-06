/* ============================================================ *
 *  nostr.js — Nostr engine (NIP-01 events, signing, relay pool)
 *
 *  Interface (FROZEN — other modules build against this):
 *    PURE  : serializeEvent(evt) -> string
 *            eventId(evt)        -> lowercase hex string (sha256)
 *    BROWSER: getPubkey(privHex) -> x-only schnorr pubkey hex
 *             signEvent(unsigned, privHex) -> signed event
 *             openPool(relays[]) -> { sub, unsub, publish, close }
 *
 *  Connection failures degrade to empty results — never throw to caller.
 *  Reuses the @noble esm.sh imports already used by shared.js.
 * ============================================================ */

/* ─── lazy crypto (mirror shared.js; tolerate import failure) ─── */
let schnorr = null;
let _secp = null;         // full @noble/secp256k1 module (for ECDH getSharedSecret)
let _bech32 = null;       // @scure/base bech32 (npub/nsec encoding — NIP-19)
let _sha256 = null;       // (Uint8Array) -> Uint8Array, synchronous once set
let cryptoReady = false;

const cryptoReadyPromise = (async () => {
  try {
    _secp = await import("https://esm.sh/@noble/secp256k1@2.1.0");
    schnorr = _secp.schnorr;
    const { sha256 } = await import("https://esm.sh/@noble/hashes@1.4.0/sha256");
    _sha256 = sha256;
    try { ({ bech32: _bech32 } = await import("https://esm.sh/@scure/base@1.1.6")); } catch (_) {}
    cryptoReady = true;
  } catch (e) {
    // Browser: esm.sh unavailable -> degrade. Node (tests): fall back to
    // the built-in crypto module so the PURE functions stay usable.
    if (!_sha256 && typeof process !== "undefined" && process?.versions?.node) {
      try {
        const { createHash } = await import("node:crypto");
        _sha256 = (bytes) =>
          new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest());
        cryptoReady = false; // schnorr still unavailable in Node
      } catch (_) {}
    }
    if (typeof console !== "undefined") console.warn("[nostr] crypto libs failed to load:", e?.message || e);
  }
})();

export async function awaitCrypto() { await cryptoReadyPromise; return cryptoReady; }

/* In Node, resolve a synchronous sha256 immediately so eventId() works
   without awaiting (the pure functions are advertised as synchronous). */
if (!_sha256 && typeof process !== "undefined" && process?.versions?.node) {
  try {
    const { createHash } = await import("node:crypto");
    _sha256 = (bytes) =>
      new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest());
  } catch (_) {}
}

/* ─── hex / bytes helpers ─── */
export function hexToBytes(h) {
  if (typeof h !== "string") return new Uint8Array(0);
  if (h.startsWith("0x")) h = h.slice(2);
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (b) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function utf8Bytes(str) {
  if (_enc) return _enc.encode(str);
  return new Uint8Array(Buffer.from(str, "utf8")); // Node fallback
}

/* ─── PURE: NIP-01 serialization & id ─── */

/**
 * NIP-01 canonical serialization:
 *   [0, pubkey, created_at, kind, tags, content]
 * JSON.stringify uses exactly the escaping NIP-01 requires
 * (\", \\, \n, \r, \t, \b, \f, and \u00xx for other control chars),
 * and produces no insignificant whitespace.
 */
export function serializeEvent(evt) {
  return JSON.stringify([
    0,
    evt.pubkey,
    evt.created_at,
    evt.kind,
    evt.tags || [],
    evt.content == null ? "" : evt.content,
  ]);
}

/** lowercase hex sha256 of serializeEvent(evt). Synchronous. */
export function eventId(evt) {
  if (!_sha256) throw new Error("sha256 unavailable");
  return bytesToHex(_sha256(utf8Bytes(serializeEvent(evt))));
}

/* ─── BROWSER: keys & signing ─── */

/** x-only schnorr public key (hex) for a private key (hex). */
export async function getPubkey(privHex) {
  await awaitCrypto();
  if (!schnorr) throw new Error("crypto_unavailable");
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privHex)));
}

/**
 * Sign an unsigned event with a private key (hex).
 * unsigned = { kind, created_at?, tags?, content }
 * returns  = { kind, created_at, tags, content, pubkey, id, sig }
 */
export async function signEvent(unsigned, privHex) {
  await awaitCrypto();
  if (!schnorr) throw new Error("crypto_unavailable");
  const priv = hexToBytes(privHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const evt = {
    kind: unsigned.kind,
    created_at: unsigned.created_at ?? Math.floor(Date.now() / 1000),
    tags: unsigned.tags || [],
    content: unsigned.content == null ? "" : unsigned.content,
    pubkey,
  };
  const id = eventId(evt);
  const sig = bytesToHex(await schnorr.sign(hexToBytes(id), priv));
  return { ...evt, id, sig };
}

/* ─── NIP-19: npub bech32 encoding ─────────────────────────────────
 * x-only hex pubkey (32 bytes) -> npub1… . Degrades to "" if @scure/base
 * isn't loaded. Pure once crypto is ready; callers should await awaitCrypto()
 * (or just fall back to a short hex). */
export function npubEncode(pubHex) {
  try {
    if (!_bech32 || !pubHex) return "";
    const bytes = hexToBytes(pubHex);
    if (bytes.length !== 32) return "";
    return _bech32.encode("npub", _bech32.toWords(bytes), 1000);
  } catch (_) { return ""; }
}

/** "npub1abc…wxyz" short form (12 + 6) from a hex pubkey, or hex fallback. */
export function shortNpubFromHex(pubHex) {
  const n = npubEncode(pubHex);
  if (n) return `${n.slice(0, 12)}…${n.slice(-6)}`;
  if (!pubHex) return "anon";
  return `${pubHex.slice(0, 8)}…${pubHex.slice(-4)}`;
}

/* ─── NIP-04: encrypted direct messages (first-cut DM crypto) ───────
 * Shared secret = ECDH(my priv, their pubkey).x  (32 bytes).
 * Plaintext is AES-256-CBC with a random 16-byte IV; the kind-4 `content`
 * is `${base64(ciphertext)}?iv=${base64(iv)}`. Nostr stores x-only pubkeys,
 * so we prepend the even-Y prefix (0x02) before ECDH. NIP-04 is metadata-
 * leaky (the `p` tag reveals the counterparty); NIP-17/44 gift-wrap is the
 * modern follow-up — see docs/superpowers/integration/dao-social.md. */

function _b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === "function") return btoa(bin);
  return Buffer.from(bytes).toString("base64"); // Node fallback
}
function _b64decode(str) {
  if (typeof atob === "function") {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(str, "base64")); // Node fallback
}

/** ECDH shared X coordinate (32 raw bytes) between my priv and their x-only pub. */
async function nip04SharedKey(myPrivHex, theirPubHex) {
  await awaitCrypto();
  if (!_secp || !_secp.getSharedSecret) throw new Error("crypto_unavailable");
  // their pubkey is x-only (32 bytes) → prefix with 0x02 to make a compressed point
  const theirPub = theirPubHex.length === 64 ? "02" + theirPubHex : theirPubHex;
  const shared = _secp.getSharedSecret(hexToBytes(myPrivHex), hexToBytes(theirPub)); // 33 bytes
  return shared.slice(1, 33); // drop the parity byte → X coordinate
}

/** NIP-04 encrypt: returns the kind-4 content string, or null on failure. */
export async function nip04Encrypt(myPrivHex, theirPubHex, plaintext) {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const keyBytes = await nip04SharedKey(myPrivHex, theirPubHex);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, utf8Bytes(plaintext)));
    return `${_b64encode(ct)}?iv=${_b64encode(iv)}`;
  } catch (_) { return null; }
}

/** NIP-04 decrypt: returns plaintext, or null on failure. */
export async function nip04Decrypt(myPrivHex, theirPubHex, content) {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const m = String(content || "").split("?iv=");
    if (m.length !== 2) return null;
    const ct = _b64decode(m[0]);
    const iv = _b64decode(m[1]);
    const keyBytes = await nip04SharedKey(myPrivHex, theirPubHex);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ct));
    const dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    return dec ? dec.decode(pt) : Buffer.from(pt).toString("utf8");
  } catch (_) { return null; }
}

/* ─── kind-0 profile metadata (NIP-01) ──────────────────────────────
 * Batch-fetch profiles for a set of authors over a relay pool. Resolves
 * pubkey(hex) → { name, display_name, picture, nip05, about } from the
 * newest kind-0 seen. Always resolves (degrades to {} on any failure). */
export function fetchProfiles(pool, pubkeys, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const want = Array.from(new Set((pubkeys || []).filter(Boolean)));
    const out = new Map();
    if (!pool || !pool.sub || !want.length) { resolve(out); return; }
    const newest = new Map(); // pubkey -> created_at
    let done = false, subId = null;
    const finish = () => {
      if (done) return; done = true;
      try { subId != null && pool.unsub && pool.unsub(subId); } catch (_) {}
      resolve(out);
    };
    try {
      subId = pool.sub([{ kinds: [0], authors: want }], {
        onEvent: (evt) => {
          if (!evt || evt.kind !== 0 || !evt.pubkey) return;
          if ((newest.get(evt.pubkey) || 0) >= (evt.created_at || 0)) return;
          newest.set(evt.pubkey, evt.created_at || 0);
          let meta = {};
          try { meta = JSON.parse(evt.content || "{}") || {}; } catch (_) {}
          out.set(evt.pubkey, meta);
        },
        onEose: finish,
      });
    } catch (_) { resolve(out); return; }
    setTimeout(finish, timeout);
  });
}

/* ─── relay pool ─── *
 * One WebSocket per relay, reconnect with backoff (mirrors hyperliquid.js).
 * Subscriptions are tracked so they resubscribe on reconnect. Events are
 * deduped by id across relays. onEose fires once every relay has sent EOSE
 * (or closed/failed) for that sub. All failures degrade to empty results.
 */

const MAX_BACKOFF = 12_000;
const START_BACKOFF = 800;

export function openPool(relays) {
  const urls = Array.isArray(relays) ? relays.slice() : [];
  let closed = false;
  let subSeq = 0;

  // subId -> { filters, onEvent, onEose, seen:Set, eosed:Set, done:bool }
  const subs = new Map();
  // pending publishes keyed by eventId -> { resolvers:Map<relayUrl, fn>, results:[], expected }
  const pubs = new Map();

  // per-relay connection objects
  const conns = urls.map((url) => makeConn(url));

  function makeConn(url) {
    const c = { url, sock: null, alive: false, backoff: START_BACKOFF, timer: null };

    c.send = (arr) => {
      if (c.alive && c.sock && c.sock.readyState === 1) {
        try { c.sock.send(JSON.stringify(arr)); } catch (_) {}
      }
    };

    c.open = () => {
      if (closed) return;
      try {
        c.sock = new WebSocket(url);
      } catch (_) {
        c.markDead();
        return;
      }
      c.sock.onopen = () => {
        c.alive = true;
        c.backoff = START_BACKOFF;
        // (re)send all active REQs
        for (const [subId, s] of subs) {
          if (!s.done) c.send(["REQ", subId, ...s.filters]);
        }
      };
      c.sock.onclose = () => { c.alive = false; c.markDead(); };
      c.sock.onerror = () => { try { c.sock.close(); } catch (_) {} };
      c.sock.onmessage = (ev) => handleMessage(c, ev.data);
    };

    // Connection lost/failed: count it as EOSE for every open sub so onEose
    // is not blocked by a dead relay, fail any pending publishes for it, and
    // schedule a reconnect with backoff.
    c.markDead = () => {
      c.alive = false;
      for (const [subId, s] of subs) if (!s.done) noteEose(subId, url);
      for (const [, p] of pubs) {
        const r = p.resolvers.get(url);
        if (r) { p.resolvers.delete(url); r({ relay: url, ok: false, reason: "disconnected" }); }
      }
      if (!closed) {
        clearTimeout(c.timer);
        c.timer = setTimeout(c.open, c.backoff);
        c.backoff = Math.min(c.backoff * 1.7, MAX_BACKOFF);
      }
    };

    c.close = () => {
      clearTimeout(c.timer);
      try { c.sock && c.sock.close(); } catch (_) {}
      c.sock = null;
      c.alive = false;
    };

    c.open();
    return c;
  }

  function handleMessage(c, data) {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (!Array.isArray(msg) || !msg.length) return;
    const type = msg[0];

    if (type === "EVENT") {
      // ["EVENT", subId, event]
      const subId = msg[1];
      const event = msg[2];
      const s = subs.get(subId);
      if (!s || s.done || !event || !event.id) return;
      if (s.seen.has(event.id)) return; // dedupe across relays
      s.seen.add(event.id);
      try { s.onEvent && s.onEvent(event, c.url); } catch (_) {}
    } else if (type === "EOSE") {
      // ["EOSE", subId]
      noteEose(msg[1], c.url);
    } else if (type === "OK") {
      // ["OK", eventId, ok(bool), message]
      const id = msg[1];
      const p = pubs.get(id);
      if (!p) return;
      const r = p.resolvers.get(c.url);
      if (r) {
        p.resolvers.delete(c.url);
        const res = { relay: c.url, ok: !!msg[2] };
        if (msg[3]) res.reason = String(msg[3]);
        r(res);
      }
    }
    // CLOSED / NOTICE / AUTH are ignored (read-only degrade).
  }

  function noteEose(subId, relayUrl) {
    const s = subs.get(subId);
    if (!s || s.done) return;
    s.eosed.add(relayUrl);
    if (s.eosed.size >= urls.length) {
      s.done = true;
      try { s.onEose && s.onEose(); } catch (_) {}
    }
  }

  return {
    relays: urls,

    sub(filters, { onEvent, onEose } = {}) {
      const subId = "lz" + (++subSeq) + Math.random().toString(36).slice(2, 8);
      const s = {
        filters: Array.isArray(filters) ? filters : [filters],
        onEvent, onEose,
        seen: new Set(),
        eosed: new Set(),
        done: false,
      };
      subs.set(subId, s);
      if (urls.length === 0) {
        // nothing to read from — empty result, fire EOSE next tick
        s.done = true;
        Promise.resolve().then(() => { try { onEose && onEose(); } catch (_) {} });
        return subId;
      }
      for (const c of conns) c.send(["REQ", subId, ...s.filters]);
      return subId;
    },

    unsub(subId) {
      const s = subs.get(subId);
      if (!s) return;
      s.done = true;
      subs.delete(subId);
      for (const c of conns) c.send(["CLOSE", subId]);
    },

    publish(signedEvent) {
      const id = signedEvent && signedEvent.id;
      if (urls.length === 0 || !id) return Promise.resolve([]);

      const resolvers = new Map();
      const promises = [];
      for (const c of conns) {
        promises.push(new Promise((resolve) => {
          let settled = false;
          const wrap = (res) => { if (settled) return; settled = true; resolve(res); };
          resolvers.set(c.url, wrap);
          // timeout: if no OK in 8s, treat as failed for that relay
          setTimeout(() => {
            if (resolvers.get(c.url) === wrap) {
              resolvers.delete(c.url);
              wrap({ relay: c.url, ok: false, reason: "timeout" });
            }
          }, 8_000);
        }));
      }
      pubs.set(id, { resolvers });
      for (const c of conns) c.send(["EVENT", signedEvent]);

      return Promise.all(promises).then((results) => {
        pubs.delete(id);
        return results;
      });
    },

    close() {
      closed = true;
      for (const c of conns) c.close();
      subs.clear();
      pubs.clear();
    },
  };
}

/* ─── self-mount ─── */
if (typeof window !== "undefined") {
  window.LZ = window.LZ || {};
  window.LZ.nostr = {
    openPool, signEvent, getPubkey, eventId, serializeEvent,
    npubEncode, shortNpubFromHex, nip04Encrypt, nip04Decrypt, fetchProfiles, awaitCrypto,
  };
}
