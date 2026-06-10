/* ============================================================ *
 *  chat-nostr.js — real Nostr direct messages for the classic chat.
 *
 *  Replaces the hardcoded CONVS/THREADS mock in app.js with live
 *  Nostr DMs: kind-4 NIP-04 encrypted messages over the relay pool.
 *  (NIP-04 is a first cut — metadata-leaky; NIP-17/44 gift-wrap is
 *  the planned follow-up, see docs/superpowers/integration/dao-social.md.)
 *
 *  Renders into the existing chat skeleton (IDs preserved):
 *    #chatItems  — conversation list (distinct counterparties)
 *    #chatThread — the open conversation + composer
 *    #chatSearch — filter (npub / hex / known name)
 *
 *  Reading needs a derived key (DMs are encrypted to you). With no key
 *  the view shows an honest derive CTA. Sending is gated on the key,
 *  awaits async signEvent/getPubkey before publish, and reflects
 *  optimistically.
 *
 *  Public API:
 *    window.LZ.chatNostr = { init, teardown, openConversation }
 * ============================================================ */

import { state, toast } from "./shared.js";
import { skeleton, emptyState, escapeHtml } from "./ui.js";
import { sigilDataURL } from "./sigil.js";
import { npubEncode } from "./nostr.js";

/* default DM relays (same reliable public set as daos.js) */
const DM_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

const $ = (id) => document.getElementById(id);

const ICN = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  send:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-7z"/></svg>`,
  lock:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  plus:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
};

/* ── read-state (REAL unread counts — v0.6) ─────────────────────── */
const READ_KEY = "lz:chat:lastRead";
function loadLastRead() {
  try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function saveLastRead() {
  try { localStorage.setItem(READ_KEY, JSON.stringify(S.lastRead)); } catch (_) {}
}

/* ── module state ───────────────────────────────────────────────── */
const S = {
  pool: null,
  sub: null,
  myPub: null,
  convs: new Map(),   // counterpartyPubHex → { last, lastAt, msgs:[{id,from,to,text,at,pending,failed}] }
  active: null,       // counterparty pubkey hex
  profiles: new Map(),// pubkey → { name, picture, nip05 }
  sigils: new Map(),  // pubkey → sigil data-URL (cached; deterministic per key)
  lastRead: loadLastRead(), // pubkey → unix sec of last read message
  filter: "",
  booted: false,
  _redraw: null,
  _statTick: null,
};

const nostr = () => (window.LZ && window.LZ.nostr) || null;
function canPost() {
  return !!(state && state.derived && state.derived.priv && nostr() && nostr().signEvent);
}

/* relTime (mirror communities.js) */
function relTime(sec) {
  if (!sec) return "";
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 45) return "now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d`;
  try { return new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function monogram(s = "?") {
  const t = String(s).replace(/[^a-zA-Z0-9]/g, "");
  return (t.slice(0, 2) || "?").toUpperCase();
}

function displayName(pub) {
  const p = S.profiles.get(pub);
  if (p && (p.display_name || p.name)) return String(p.display_name || p.name).slice(0, 40);
  const n = nostr();
  if (n && n.shortNpubFromHex) { try { return n.shortNpubFromHex(pub); } catch (_) {} }
  return pub ? `${pub.slice(0, 8)}…${pub.slice(-4)}` : "anon";
}

/* Every contact gets THEIR generative sigil as avatar — deterministic from
   their real pubkey (npub-seeded, same artifact as Identity), cached per key.
   Falls back to the old monogram if the sigil can't render. */
function avatarHTML(pub, size = 40) {
  let url = S.sigils.get(pub);
  if (url === undefined) {
    url = "";
    try {
      let np = "";
      try { np = npubEncode(pub) || ""; } catch (_) {}
      url = sigilDataURL(np || pub, size * 2) || "";
    } catch (_) { url = ""; }
    S.sigils.set(pub, url);
  }
  if (url) return `<img class="av av--sigil" src="${url}" alt="" width="${size}" height="${size}" decoding="async" />`;
  return `<div class="av">${escapeHtml(monogram(displayName(pub)))}</div>`;
}

function unreadCount(pub, conv) {
  const t = S.lastRead[pub] || 0;
  let n = 0;
  for (const m of conv.msgs || []) if (m.from === "them" && (m.at || 0) > t) n++;
  return n;
}

/* "Today" / "Yesterday" / "Mar 4" — day divider labels for the thread */
function dayLabel(sec) {
  try {
    const d = new Date(sec * 1000), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch (_) { return ""; }
}

/* live relay census in the list head (replaces the old hardcoded "6 active") */
function relayStatus() {
  const el = $("chatRelayStat");
  if (!el) return;
  let on = 0, total = DM_RELAYS.length;
  if (S.pool && S.pool.status) { const st = S.pool.status(); on = st.connected || 0; total = st.total || total; }
  el.classList.toggle("live", on > 0);
  el.innerHTML = `<span class="dot" aria-hidden="true"></span>${on}/${total} relays`;
}
function startStatusTicker() {
  stopStatusTicker();
  S._statTick = setInterval(() => {
    const el = $("chatRelayStat");
    if (document.hidden || !el || el.offsetParent === null) return; // gated: hidden tab / inactive route
    relayStatus();
  }, 12000);
}
function stopStatusTicker() {
  if (S._statTick) { clearInterval(S._statTick); S._statTick = null; }
}

/* npub / hex / "npub1…" → x-only hex pubkey, or "" if invalid. */
function toPubHex(input) {
  const s = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (s.startsWith("npub1")) {
    // decode via @scure bech32 through nostr.js is not exposed; do a tiny inline decode
    try {
      const dec = bech32Decode(s);
      if (dec && dec.prefix === "npub" && dec.bytes && dec.bytes.length === 32) {
        return Array.from(dec.bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) {}
  }
  return "";
}

/* minimal bech32 decode (npub only) — avoids a new crypto import. */
const B32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Decode(str) {
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1) return null;
  const prefix = lower.slice(0, pos);
  const dataPart = lower.slice(pos + 1);
  const data = [];
  for (const ch of dataPart) {
    const v = B32_CHARS.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  // drop the 6-char checksum, convert 5-bit → 8-bit
  const words = data.slice(0, -6);
  const bytes = convertBits(words, 5, 8, false);
  return bytes ? { prefix, bytes: new Uint8Array(bytes) } : null;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

/* ── live message ingest ────────────────────────────────────────── */

async function ingestDM(evt) {
  if (!evt || evt.kind !== 4 || !evt.id || !evt.pubkey) return;
  const n = nostr();
  // counterparty: if I sent it, it's the p-tag recipient; else it's the author
  const pTag = (evt.tags || []).find((t) => t[0] === "p");
  const recipient = pTag && pTag[1];
  const mine = evt.pubkey === S.myPub;
  const counterparty = mine ? recipient : evt.pubkey;
  if (!counterparty) return;
  // only DMs that involve me
  if (!mine && recipient !== S.myPub) return;
  // decrypt against the counterparty
  let text = "";
  try {
    text = await n.nip04Decrypt(state.derived.priv, counterparty, evt.content);
  } catch (_) { text = ""; }
  if (text == null) text = "[encrypted message]";

  const conv = S.convs.get(counterparty) || { msgs: [], seen: new Set() };
  if (conv.seen.has(evt.id)) return;
  conv.seen.add(evt.id);
  conv.msgs.push({ id: evt.id, from: mine ? "you" : "them", text, at: evt.created_at || 0 });
  conv.msgs.sort((a, b) => (a.at || 0) - (b.at || 0));
  const lastMsg = conv.msgs[conv.msgs.length - 1];
  conv.last = lastMsg.text;
  conv.lastAt = lastMsg.at;
  S.convs.set(counterparty, conv);
  // messages landing in the OPEN conversation are read by definition
  if (counterparty === S.active && conv.lastAt > (S.lastRead[counterparty] || 0)) {
    S.lastRead[counterparty] = conv.lastAt;
    saveLastRead();
  }
  scheduleRedraw();
  // warm a profile for the counterparty
  fetchProfile(counterparty);
}

function scheduleRedraw() {
  if (S._redraw) return;
  S._redraw = setTimeout(() => { S._redraw = null; renderList(); if (S.active) renderThread(); }, 120);
}

async function fetchProfile(pub) {
  const n = nostr();
  if (!n || !n.fetchProfiles || !S.pool || S.profiles.has(pub)) return;
  S.profiles.set(pub, { _pending: true });
  try {
    const map = await n.fetchProfiles(S.pool, [pub]);
    S.profiles.set(pub, map.get(pub) || {});
    scheduleRedraw();
  } catch (_) { S.profiles.set(pub, {}); }
}

/* ── rendering ──────────────────────────────────────────────────── */

function renderList() {
  const items = $("chatItems");
  if (!items) return;
  relayStatus();
  if (!canPost()) {
    // ONE underived state (was two lock cards): ghost rows behind frosted
    // glass — the promise, visibly skeletons — plus a single derive CTA.
    items.replaceChildren(emptyState({
      icon: ICN.lock, title: "Your inbox is waiting",
      body: "Direct messages travel encrypted over Nostr. Derive your identity once and they appear here — on every device, forever.",
      hero: true, ring: true, ghost: "chat",
      actionLabel: "Derive your identity →", ctaHref: "#/identity",
    }));
    return;
  }
  const convs = Array.from(S.convs.entries())
    .map(([pub, c]) => ({ pub, ...c }))
    .filter((c) => {
      if (!S.filter) return true;
      const q = S.filter.toLowerCase();
      return c.pub.includes(q) || displayName(c.pub).toLowerCase().includes(q);
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  if (!convs.length) {
    items.replaceChildren(emptyState({
      icon: ICN.search, title: S.filter ? "No matches" : "No conversations yet",
      body: S.filter ? `Nothing matches “${S.filter}”.` : "Know someone's npub? Start an encrypted conversation.",
      actionLabel: S.filter ? "" : "New message",
      onAction: S.filter ? null : promptNewConversation,
    }));
    return;
  }
  items.innerHTML = convs.map((c, i) => {
    const un = unreadCount(c.pub, c);
    return `
    <div class="chat-item${c.pub === S.active ? " active" : ""}" data-pub="${escapeHtml(c.pub)}" style="--i:${i}">
      ${avatarHTML(c.pub)}
      <div class="col">
        <div class="top"><span class="name">${escapeHtml(displayName(c.pub))}</span><span class="time">${escapeHtml(relTime(c.lastAt))}</span></div>
        <span class="msg">${escapeHtml(String(c.last || "").slice(0, 80))}</span>
        <div class="meta-row"><span class="tag nostr">NOSTR · NIP-04</span>${un ? `<span class="unread">${un > 9 ? "9+" : un}</span>` : ""}</div>
      </div>
    </div>`; }).join("");
  items.querySelectorAll(".chat-item").forEach((el) =>
    el.addEventListener("click", () => openConversation(el.dataset.pub)));
}

function renderThread() {
  const root = $("chatThread");
  if (!root) return;
  if (!canPost()) {
    // quiet companion pane — the single CTA lives in the list (no second lock card)
    root.innerHTML = `
      <div class="chat-void">
        <span class="cv-ring" aria-hidden="true"></span>
        <p>One key. Every conversation.</p>
      </div>`;
    return;
  }
  if (!S.active) {
    root.replaceChildren(emptyState({
      icon: ICN.send, title: "Select a conversation",
      body: "Pick a conversation on the left, or start a new one with an npub.",
    }));
    return;
  }
  const conv = S.convs.get(S.active) || { msgs: [] };
  let lastDay = "";
  const msgsHTML = conv.msgs.map((m) => {
    const day = dayLabel(m.at);
    const divider = day && day !== lastDay ? `<div class="day-divider" aria-hidden="true"><span>${escapeHtml(day)}</span></div>` : "";
    lastDay = day || lastDay;
    return `${divider}
        <div class="msg-bubble ${m.from} ${m.pending ? "inflight" : ""} ${m.failed ? "failed" : ""}">
          <div>${escapeHtml(m.text)}</div>
          <div class="meta"><span class="enc" aria-hidden="true">${ICN.lock}</span><span>${escapeHtml(relTime(m.at))}${m.pending ? " · sending…" : m.failed ? " · failed" : ""}</span></div>
        </div>`;
  }).join("");
  root.innerHTML = `
    <div class="thread-head">
      <div class="who">
        ${avatarHTML(S.active, 36)}
        <div class="info"><span class="nm">${escapeHtml(displayName(S.active))}</span><span class="sub">${escapeHtml(shortNpub(S.active))} · encrypted · NIP-04</span></div>
      </div>
      <div class="meta"><span class="tag nostr">NIP-04</span></div>
    </div>
    <div class="thread-body" id="chatNostrBody">
      ${conv.msgs.length ? msgsHTML
        : `<div class="chat-nostr-empty">No messages yet — say hello. Messages are end-to-end encrypted (NIP-04).</div>`}
    </div>
    <div class="thread-compose">
      <input type="text" id="chatNostrInput" placeholder="Encrypted message via Nostr…" autocomplete="off" />
      <button class="send-btn" id="chatNostrSend" aria-label="Send" title="Send">${ICN.send}</button>
    </div>`;
  const input = $("chatNostrInput");
  const sendBtn = $("chatNostrSend");
  const fire = () => sendMessage(input);
  sendBtn.addEventListener("click", fire);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } });
  const body = $("chatNostrBody"); if (body) body.scrollTop = body.scrollHeight;
}

function shortNpub(pub) {
  const n = nostr();
  if (n && n.shortNpubFromHex) { try { return n.shortNpubFromHex(pub); } catch (_) {} }
  return pub ? `${pub.slice(0, 8)}…${pub.slice(-4)}` : "";
}

/* ── send (optimistic, awaits async sign) ───────────────────────── */

async function sendMessage(input) {
  if (!input) return;
  const text = input.value.trim();
  if (!text || !S.active) return;
  if (!canPost()) { toast("Derive your identity to send", "err"); return; }
  input.value = "";
  const n = nostr();
  const at = Math.floor(Date.now() / 1000);
  const localId = "local:" + Math.random().toString(36).slice(2);
  const conv = S.convs.get(S.active) || { msgs: [], seen: new Set() };
  conv.msgs.push({ id: localId, from: "you", text, at, pending: true });
  conv.last = text; conv.lastAt = at;
  S.convs.set(S.active, conv);
  renderThread(); renderList();

  const mark = (patch) => {
    const m = conv.msgs.find((x) => x.id === localId);
    if (m) Object.assign(m, patch);
    renderThread();
  };

  try {
    const cipher = await n.nip04Encrypt(state.derived.priv, S.active, text);
    if (!cipher) { mark({ pending: false, failed: true }); toast("Could not encrypt message", "err"); return; }
    // signEvent + getPubkey are ASYNC — always await before publish.
    const signed = await n.signEvent(
      { kind: 4, content: cipher, created_at: at, tags: [["p", S.active]] },
      state.derived.priv
    );
    if (conv.seen) conv.seen.add(signed.id);
    const res = await S.pool.publish(signed);
    const ok = !Array.isArray(res) || res.some((r) => r && r.ok);
    if (ok) mark({ pending: false, id: signed.id });
    else { mark({ pending: false, failed: true }); toast("Relays rejected the message", "err"); }
  } catch (e) {
    console.warn("[chat-nostr] send failed:", e);
    mark({ pending: false, failed: true });
    toast("Send failed — relay unreachable", "err");
  }
}

/* ── new conversation (by npub / hex) ───────────────────────────── */

function promptNewConversation() {
  const ui = window.LZUI;
  const bodyHTML = `
    <p class="chat-nostr-modal-hint">Enter an npub or hex public key to start an encrypted conversation.</p>
    <input type="text" id="chatNewPub" class="chat-nostr-modal-input" placeholder="npub1… or 64-char hex" autocomplete="off" />
    <button type="button" class="btn accent" id="chatNewGo">Start conversation</button>
    <p class="chat-nostr-modal-err" id="chatNewErr" hidden></p>`;
  let m;
  const start = () => {
    const val = document.getElementById("chatNewPub").value;
    const hex = toPubHex(val);
    const err = document.getElementById("chatNewErr");
    if (!hex) { if (err) { err.hidden = false; err.textContent = "That doesn't look like a valid npub or hex key."; } return; }
    if (!S.convs.has(hex)) S.convs.set(hex, { msgs: [], seen: new Set(), last: "", lastAt: 0 });
    if (m) m.close();
    openConversation(hex);
    fetchProfile(hex);
  };
  if (ui && ui.modal) {
    m = ui.modal({ title: "New message", body: bodyHTML, width: "min(420px, 92vw)" });
    m.body.querySelector("#chatNewGo").addEventListener("click", start);
    m.body.querySelector("#chatNewPub").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); start(); } });
    m.body.querySelector("#chatNewPub").focus();
  } else {
    const val = prompt("Enter an npub or hex public key:");
    const hex = toPubHex(val);
    if (hex) { if (!S.convs.has(hex)) S.convs.set(hex, { msgs: [], seen: new Set(), last: "", lastAt: 0 }); openConversation(hex); }
  }
}

/* ── public API ─────────────────────────────────────────────────── */

export function openConversation(pub) {
  S.active = pub;
  // opening a conversation reads it — the unread badge is REAL, so clear it
  const conv = S.convs.get(pub);
  const lastAt = conv && conv.lastAt ? conv.lastAt : Math.floor(Date.now() / 1000);
  if ((S.lastRead[pub] || 0) < lastAt) { S.lastRead[pub] = lastAt; saveLastRead(); }
  renderList();
  renderThread();
}

/* Called by the coordinator from the chat route (ONROUTE.chat). Idempotent;
   re-entrant safe — re-renders if already booted. */
export async function init() {
  // wire the search box + a "new conversation" affordance once
  if (!S.booted) {
    const search = $("chatSearch");
    if (search) search.addEventListener("input", (e) => { S.filter = e.target.value || ""; renderList(); });
    wireNewButton();
    S.booted = true;
  }
  startStatusTicker();

  if (!canPost()) { renderList(); renderThread(); return; }

  const n = nostr();
  if (!n || !n.openPool) {
    const items = $("chatItems");
    if (items) items.replaceChildren(emptyState({ icon: ICN.lock, title: "Nostr engine loading", body: "The relay engine isn't ready yet." }));
    return;
  }

  // resolve my pubkey (async) before subscribing
  try { S.myPub = await n.getPubkey(state.derived.priv); } catch (_) { S.myPub = null; }
  if (!S.myPub) { renderList(); renderThread(); return; }

  // open the pool + subscribe to DMs to AND from me
  if (!S.pool) {
    try { S.pool = n.openPool(DM_RELAYS); } catch (_) { S.pool = null; }
  }
  if (!S.pool || !S.pool.sub) {
    const items = $("chatItems");
    if (items) items.replaceChildren(emptyState({ icon: ICN.lock, title: "Couldn't connect", body: "Relay connection failed. Try again shortly." }));
    return;
  }

  const items = $("chatItems");
  if (items && !S.convs.size) items.innerHTML = skeleton({ rows: 4, height: 64 });

  try {
    // idempotent: drop any prior subscription before re-subscribing so repeated
    // chat-route entries don't stack subs on the pool (relay-leak fix).
    if (S.sub != null && S.pool.unsub){ try { S.pool.unsub(S.sub); } catch (_) {} S.sub = null; }
    // received DMs (#p = me) + sent DMs (authors = me)
    S.sub = S.pool.sub([
      { kinds: [4], "#p": [S.myPub], limit: 200 },
      { kinds: [4], authors: [S.myPub], limit: 200 },
    ], {
      onEvent: (evt) => { ingestDM(evt); },
      onEose: () => { renderList(); if (S.active) renderThread(); },
    });
  } catch (_) {}

  renderList();
  renderThread();
}

function wireNewButton() {
  // add a + button into the chat-list head if not present
  const head = document.querySelector('[data-view="chat"] .chat-list-head');
  if (head && !head.querySelector(".chat-nostr-new")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-nostr-new";
    btn.setAttribute("aria-label", "New message");
    btn.innerHTML = ICN.plus;
    btn.addEventListener("click", promptNewConversation);
    head.appendChild(btn);
  }
}

export function teardown() {
  try { if (S.sub != null && S.pool && S.pool.unsub) S.pool.unsub(S.sub); } catch (_) {}
  try { if (S.pool && S.pool.close) S.pool.close(); } catch (_) {}
  S.pool = null; S.sub = null;
  stopStatusTicker();
  clearTimeout(S._redraw); S._redraw = null;
}

/* ── self-mount ─────────────────────────────────────────────────── */
window.LZ = window.LZ || {};
window.LZ.chatNostr = { init, teardown, openConversation };

export { S as _state };
