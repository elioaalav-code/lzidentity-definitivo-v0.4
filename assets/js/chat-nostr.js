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
import { status as keyStatus, unlock as keyUnlock } from "./keystore.js";

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
  pen:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  bell:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
};

/* ── read-state (REAL unread counts — v0.6) ─────────────────────── */
const READ_KEY = "lz:chat:lastRead";
function loadLastRead() {
  try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function saveLastRead() {
  try { localStorage.setItem(READ_KEY, JSON.stringify(S.lastRead)); } catch (_) {}
}

/* ── contacts (petnames, local-only) + DM notifications — v0.7 F2 ── */
const CONTACTS_KEY = "lz:contacts";
const NOTIF_KEY = "lz:chat:notify";
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function saveContacts() {
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(S.contacts)); } catch (_) {}
}
function notifyEnabled() {
  return localStorage.getItem(NOTIF_KEY) === "on"
    && typeof Notification !== "undefined" && Notification.permission === "granted";
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
  contacts: loadContacts(), // pubkey → { name, addedAt } (petnames, local-only)
  filter: "",
  booted: false,
  _redraw: null,
  _statTick: null,
  _notifGate: 0,      // only DMs created AFTER this notify (kills backfill storms)
  _notifLast: new Map(), // pubkey → last notification ms (per-conv throttle)
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
  const c = S.contacts[pub];
  if (c && c.name) return String(c.name).slice(0, 40); // petname wins over kind-0
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
/* one Notification per live DM, throttled per conversation; never for
   backfill (the initial sub replays up to 200 stored DMs) */
function maybeNotify(pub, text, at) {
  if (!notifyEnabled()) return;
  if (!at || at <= S._notifGate) return;            // stored history, not live
  const last = S._notifLast.get(pub) || 0;
  if (Date.now() - last < 15000) return;
  S._notifLast.set(pub, Date.now());
  try {
    let icon;
    try { let np = ""; try { np = npubEncode(pub) || ""; } catch (_) {} icon = sigilDataURL(np || pub, 64) || undefined; } catch (_) {}
    const n = new Notification(displayName(pub), {
      body: String(text || "").slice(0, 90),
      tag: "lz-dm-" + pub.slice(0, 16),
      icon,
    });
    n.onclick = () => {
      try { window.focus(); } catch (_) {}
      location.hash = "#/chat";
      openConversation(pub);
    };
  } catch (_) {}
}

async function toggleNotify() {
  if (localStorage.getItem(NOTIF_KEY) === "on") {
    localStorage.setItem(NOTIF_KEY, "off");
    toast("DM notifications off");
  } else if (typeof Notification === "undefined") {
    toast("Notifications aren't supported here", "err");
  } else {
    let perm = Notification.permission;
    if (perm === "default") { try { perm = await Notification.requestPermission(); } catch (_) { perm = "denied"; } }
    if (perm === "granted") { localStorage.setItem(NOTIF_KEY, "on"); toast("DM notifications on", "ok"); }
    else { localStorage.setItem(NOTIF_KEY, "off"); toast("Notification permission denied", "err"); }
  }
  reflectBell();
}
function reflectBell() {
  const b = document.querySelector('[data-view="chat"] .chat-nostr-bell');
  if (b) b.classList.toggle("on", localStorage.getItem(NOTIF_KEY) === "on" && (typeof Notification === "undefined" || Notification.permission === "granted"));
}

/* save / rename / remove a contact (petname) */
function editContact(pub) {
  const ui = window.LZUI;
  const existing = S.contacts[pub];
  const apply = (name) => {
    const clean = String(name || "").trim().slice(0, 40);
    if (clean) S.contacts[pub] = { name: clean, addedAt: existing?.addedAt || Math.floor(Date.now() / 1000) };
    else delete S.contacts[pub];
    saveContacts();
    renderList(); if (S.active) renderThread();
  };
  if (!ui || !ui.modal) { apply(prompt("Contact name (empty to remove):", existing?.name || "")); return; }
  const m = ui.modal({
    title: existing ? "Edit contact" : "Save contact",
    width: "min(420px, 92vw)",
    body: `
      <p class="chat-nostr-modal-hint">${escapeHtml(shortNpub(pub))} — a local petname, shown instead of the npub. Only you see it.</p>
      <input type="text" id="chatCName" class="chat-nostr-modal-input" placeholder="Name" autocomplete="off" value="${escapeHtml(existing?.name || "")}" />
      <div class="chat-contact-actions">
        <button type="button" class="btn accent sm" id="chatCSave">Save</button>
        ${existing ? `<button type="button" class="btn ghost sm" id="chatCRemove">Remove</button>` : ``}
      </div>`,
  });
  m.body.querySelector("#chatCSave").addEventListener("click", () => { apply(m.body.querySelector("#chatCName").value); m.close(); });
  m.body.querySelector("#chatCRemove")?.addEventListener("click", () => { apply(""); m.close(); });
  const inp = m.body.querySelector("#chatCName");
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(inp.value); m.close(); } });
  inp.focus();
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
  // notify for live incoming DMs when the user isn't looking at them
  if (!mine && (document.hidden || !document.hasFocus() || counterparty !== S.active)) {
    maybeNotify(counterparty, text, evt.created_at || 0);
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
    // glass — the promise, visibly skeletons — plus a single CTA. When the
    // key exists but is encrypted at rest, the CTA unlocks instead.
    const locked = keyStatus() === "locked";
    items.replaceChildren(emptyState({
      icon: ICN.lock,
      title: locked ? "Inbox locked" : "Your inbox is waiting",
      body: locked
        ? "Your key is protected at rest. Unlock it to read and send encrypted messages."
        : "Direct messages travel encrypted over Nostr. Derive your identity once and they appear here — on every device, forever.",
      hero: true, ring: true, ghost: "chat",
      actionLabel: locked ? "Unlock →" : "Derive your identity →",
      ...(locked ? { onAction: () => keyUnlock() } : { ctaHref: "#/identity" }),
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
      <div class="meta">
        <span class="idlink-slot" id="chatIdLink"></span>
        <button type="button" class="chat-contact-btn" id="chatContactBtn" aria-label="${S.contacts[S.active] ? "Edit contact" : "Save contact"}" title="${S.contacts[S.active] ? "Edit contact" : "Save contact"}">${ICN.pen}</button>
        <span class="tag nostr">NIP-04</span>
      </div>
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
  $("chatContactBtn")?.addEventListener("click", () => editContact(S.active));
  fillIdLink(S.active);
  const body = $("chatNostrBody"); if (body) body.scrollTop = body.scrollHeight;
}

/* Identity Link in the thread head: verified npub↔EVM → ✓ chip + Send
   (prefills the wallet quick-send with the ATTESTED address) */
async function fillIdLink(pub) {
  const slot = $("chatIdLink");
  if (!slot) return;
  try {
    const { fetchLink } = await import("./idlink.js");
    const link = await fetchLink(pub);
    if (S.active !== pub) return;                 // user moved on meanwhile
    const cur = $("chatIdLink");
    if (!cur) return;
    if (link && link.state === "verified") {
      const short = `${link.addr.slice(0, 6)}…${link.addr.slice(-4)}`;
      cur.innerHTML = `
        <span class="tag lz idlink-ok" title="npub ↔ EVM attestation verified">✓ ${escapeHtml(short)}</span>
        <button type="button" class="btn ghost sm idlink-pay" id="chatPayBtn">Send</button>`;
      cur.querySelector("#chatPayBtn")?.addEventListener("click", () => {
        location.hash = "#/wallet";
        const who = displayName(pub);
        setTimeout(() => {
          const to = document.getElementById("sendTo");
          if (to) { to.value = link.addr; to.focus(); }
          toast(`Quick send → ${who} (${short}) · verified link`, "ok", 4200);
        }, 350);
      });
    } else {
      cur.innerHTML = "";
    }
  } catch (_) {}
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
  const saved = Object.entries(S.contacts)
    .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
  const contactsHTML = saved.length ? `
    <div class="chat-contact-list" role="list">
      ${saved.map(([pub, c]) => `
        <button type="button" class="chat-contact-row" data-pub="${escapeHtml(pub)}" role="listitem">
          <b>${escapeHtml(c.name)}</b><small>${escapeHtml(shortNpub(pub))}</small>
        </button>`).join("")}
    </div>
    <div class="chat-contact-or">or</div>` : "";
  const bodyHTML = `
    ${contactsHTML}
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
    m.body.querySelectorAll(".chat-contact-row").forEach((row) =>
      row.addEventListener("click", () => {
        const hex = row.dataset.pub;
        if (!S.convs.has(hex)) S.convs.set(hex, { msgs: [], seen: new Set(), last: "", lastAt: 0 });
        m.close();
        openConversation(hex);
        fetchProfile(hex);
      }));
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
    // key unlocked → boot the real inbox (only if the chat view is on screen)
    window.addEventListener("lz:keys-unlocked", () => {
      const items = $("chatItems");
      if (items && items.offsetParent !== null) init();
    });
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
    // notifications: everything the sub replays from history is older than NOW
    S._notifGate = Math.floor(Date.now() / 1000);
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
  // add bell (notifications) + new-message buttons into the chat-list head
  const head = document.querySelector('[data-view="chat"] .chat-list-head');
  if (head && !head.querySelector(".chat-nostr-bell")) {
    const bell = document.createElement("button");
    bell.type = "button";
    bell.className = "chat-nostr-new chat-nostr-bell";
    bell.setAttribute("aria-label", "DM notifications");
    bell.title = "DM notifications";
    bell.innerHTML = ICN.bell;
    bell.addEventListener("click", toggleNotify);
    head.appendChild(bell);
    reflectBell();
  }
  if (head && !head.querySelector(".chat-nostr-plus")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-nostr-new chat-nostr-plus";
    btn.setAttribute("aria-label", "New message");
    btn.title = "New message";
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
