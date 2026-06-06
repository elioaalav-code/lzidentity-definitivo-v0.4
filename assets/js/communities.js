/* ============================================================ *
 *  communities.js — the Communities social view controller
 *
 *  Renders the DAO / Nostr-group social experience into the
 *  coordinator-provided container skeleton inside the chat view:
 *
 *    #commLayout  → #commList (left rail) + #commMain
 *    #commMain    → #commHeader + #commTabs + #commPanel
 *
 *  Tabs: feed (kind-1), channels (kind-42 / NIP-28), governance
 *  (delegated to window.LZ.gov). Reading works with no wallet;
 *  posting/reacting/sending is gated on a derived Nostr key.
 *
 *  Public API (frozen):
 *    window.LZ.communities = { init, openCommunity, setTab }
 *
 *  Extra exports (for isolated headless testing — drive the view
 *  WITHOUT importing daos.js):
 *    renderList, renderCommunity, renderTab, mountSkeleton, _state
 *
 *  Everything is guarded: window.LZ?.nostr / window.LZ?.gov may be
 *  undefined; relays may fail. Never throws. Subs are cleaned up on
 *  every community/tab switch so we don't leak relay subscriptions.
 * ============================================================ */

import { state, shortNpub, toast, fmt } from "./shared.js";
import { skeleton, emptyState, escapeHtml } from "./ui.js";

/* ── module state ─────────────────────────────────────────────── */
const _state = {
  communities: [],       // [community]
  view: "discover",      // 'discover' (home) | 'community'
  active: null,          // community object
  tab: "feed",           // 'feed' | 'channels' | 'governance'
  activeChannel: null,   // channel id within active community
  pool: null,            // current open pool
  subs: [],              // [subId] currently live on `pool`
  events: new Map(),     // id → event (current feed/channel buffer)
  reactions: new Map(),  // postId → Map(emoji → Set(reactorPubkey)) (kind-7)
  profiles: new Map(),   // pubkey(hex) → { name, picture, nip05, npub, nip05ok }
  replyTo: null,         // post id we're composing a reply to (feed)
  _redrawTimer: null,
  _profTimer: null,
};

const reduce = () =>
  !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

const $ = (id) => document.getElementById(id);

/* small inline icon set (stroke = currentColor) */
const ICN = {
  feed:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h10"/></svg>`,
  channels:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H7l-3 3z"/></svg>`,
  gov:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="M5 10v6l7 4 7-4v-6"/></svg>`,
  heart:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.5-9.2-9C1.3 8 3 4.5 6.5 4.5 9 4.5 12 7 12 7s3-2.5 5.5-2.5C21 4.5 22.7 8 21.2 11 19 15.5 12 20 12 20z"/></svg>`,
  send:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-7z"/></svg>`,
  relay:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2"/><path d="M6 6a8 8 0 0 0 0 12M18 6a8 8 0 0 1 0 12"/></svg>`,
  warn:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>`,
  reply:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/></svg>`,
  check:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
};

/* extra emoji offered in the feed reaction picker (NIP-25) */
const REACT_EMOJI = ["❤️", "🔥", "👍", "😂", "🚀"];

/* ── helpers ──────────────────────────────────────────────────── */

/** Deterministic 2-char monogram from a name. */
function monogram(name = "?") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** x-only hex pubkey → readable short id. Prefers a cached npub (NIP-19),
   falls back to short hex when crypto/bech32 isn't ready yet. */
function shortAuthor(pubkey = "") {
  if (!pubkey) return "anon";
  const nostr = window.LZ && window.LZ.nostr;
  if (nostr && nostr.shortNpubFromHex) {
    try { const s = nostr.shortNpubFromHex(pubkey); if (s) return s; } catch (_) {}
  }
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/** Best display name for an author: kind-0 name → npub-short → hex-short. */
function displayName(pubkey = "") {
  const p = _state.profiles.get(pubkey);
  if (p && (p.display_name || p.name)) return String(p.display_name || p.name).slice(0, 48);
  return shortAuthor(pubkey);
}

/** NIP-05 verified handle (only if it verified against the pubkey). */
function nip05Handle(pubkey = "") {
  const p = _state.profiles.get(pubkey);
  return p && p.nip05ok ? String(p.nip05) : "";
}

/* Batch-fetch kind-0 profiles for visible authors and verify NIP-05.
   Debounced; on completion repaints whichever stream is live. */
function scheduleProfileFetch(redraw) {
  clearTimeout(_state._profTimer);
  _state._profTimer = setTimeout(() => fetchVisibleProfiles(redraw), 220);
}
async function fetchVisibleProfiles(redraw) {
  const nostr = window.LZ && window.LZ.nostr;
  if (!nostr || !nostr.fetchProfiles || !_state.pool) return;
  const authors = Array.from(new Set(
    Array.from(_state.events.values()).map((e) => e.pubkey).filter(Boolean)
  )).filter((pk) => !_state.profiles.has(pk));
  if (!authors.length) return;
  // mark as in-flight so we don't refetch every redraw
  for (const pk of authors) _state.profiles.set(pk, { _pending: true });
  let map;
  try { map = await nostr.fetchProfiles(_state.pool, authors); } catch (_) { map = new Map(); }
  for (const pk of authors) {
    const meta = map.get(pk) || {};
    const npub = nostr.npubEncode ? nostr.npubEncode(pk) : "";
    _state.profiles.set(pk, { ...meta, npub, nip05ok: false });
  }
  // verify NIP-05 (best-effort, non-blocking) then repaint
  for (const pk of authors) verifyNip05(pk, redraw);
  if (typeof redraw === "function") redraw();
}

/* NIP-05: GET https://<domain>/.well-known/nostr.json?name=<local> and confirm
   names[local] === pubkey. Uses window.LZ.net.fetchJSON for timeout/retry. */
async function verifyNip05(pubkey, redraw) {
  const prof = _state.profiles.get(pubkey);
  if (!prof || !prof.nip05 || prof.nip05ok) return;
  const at = String(prof.nip05).split("@");
  if (at.length !== 2) return;
  const [local, domain] = at;
  const net = window.LZ && window.LZ.net;
  if (!net || !net.fetchJSON) return;
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
    const j = await net.fetchJSON(url, { timeout: 4000, retries: 0, cache: 600000 });
    if (j && j.names && String(j.names[local] || "").toLowerCase() === pubkey.toLowerCase()) {
      prof.nip05ok = true;
      _state.profiles.set(pubkey, prof);
      if (typeof redraw === "function") redraw();
    }
  } catch (_) {}
}

/** seconds-epoch → "just now / 3m / 2h / 4d / Jun 6" */
function relTime(sec) {
  if (!sec) return "";
  const now = Date.now() / 1000;
  const d = Math.max(0, now - sec);
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d`;
  try {
    return new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return ""; }
}

/** A small avatar element coloured by the community accent. */
function avatarHTML(seed, accent, size = 38) {
  const a = accent || "var(--accent)";
  return `<span class="comm-av" aria-hidden="true" style="--av-size:${size}px;--av-accent:${escapeHtml(a)}">${escapeHtml(monogram(seed))}</span>`;
}

/** Apply the active community accent to the layout as a CSS var. */
function applyAccent(accent) {
  const root = $("commLayout");
  if (root) root.style.setProperty("--comm-accent", accent || "var(--accent)");
}

/** Tear down every live subscription + close the pool. */
function teardownSubs() {
  const pool = _state.pool;
  if (pool) {
    try {
      for (const id of _state.subs) {
        try { pool.unsub && pool.unsub(id); } catch (_) {}
      }
      try { pool.close && pool.close(); } catch (_) {}
    } catch (_) {}
  }
  _state.subs = [];
  _state.pool = null;
  _state.events = new Map();
  _state.reactions = new Map();
  _state.replyTo = null;
  clearTimeout(_state._redrawTimer);
  _state._redrawTimer = null;
  clearTimeout(_state._profTimer);
  _state._profTimer = null;
}

/** Are we able to sign / publish? */
function canPost() {
  return !!(state && state.derived && state.derived.priv && window.LZ && window.LZ.nostr && window.LZ.nostr.signEvent);
}

/* getPubkey is async (awaits crypto load); cache the hex once so render/reaction
   code can use it synchronously. Self-warms; ready on the next redraw. */
let _myPubkey = null;
async function myPubkey() {
  if (_myPubkey) return _myPubkey;
  try {
    if (state && state.derived && state.derived.priv && window.LZ && window.LZ.nostr && window.LZ.nostr.getPubkey) {
      _myPubkey = await window.LZ.nostr.getPubkey(state.derived.priv);
    }
  } catch (_) {}
  return _myPubkey;
}

/* ── list (left rail) ─────────────────────────────────────────── */

/**
 * Render the community list into a target (default #commList).
 * Pass an explicit `communities` array to drive it in tests.
 */
/* daos.js module ref (loaded lazily in init) — gives us allCommunities /
   isUserCommunity / removeUserCommunity for the rail's add/remove affordances. */
let _daos = null;

export function renderList(communities, target) {
  const list = target || $("commList");
  if (!list) return;
  const items = communities || _state.communities || [];
  const headHTML = `
    <div class="comm-list-head">
      <span class="comm-list-title">Communities</span>
      <span class="comm-list-n">${items.length}</span>
    </div>
    <button type="button" class="comm-discover-btn${_state.view === "discover" ? " active" : ""}" id="commDiscoverBtn" data-motion="lift">
      <span class="comm-disc-icn" aria-hidden="true">✦</span> Discover · hot DAOs &amp; votes
    </button>
    <button type="button" class="comm-add-btn" id="commAddBtn" data-motion="lift">
      <span class="comm-add-plus">＋</span> Search &amp; add a DAO
    </button>`;
  if (!items.length) {
    list.innerHTML = headHTML + `<div class="comm-list-scroll"></div>`;
    list.querySelector(".comm-list-scroll").appendChild(
      emptyState({ icon: ICN.relay, title: "No communities", body: "Add a DAO or Nostr group to get started." })
    );
    wireListHead(list);
    return;
  }
  list.innerHTML = headHTML + `
    <div class="comm-list-scroll" role="list">
      ${items.map((c, i) => {
        const kind = c.kind === "dao" ? "DAO" : "Group";
        const active = _state.active && _state.active.id === c.id;
        const removable = !!(_daos && _daos.isUserCommunity && _daos.isUserCommunity(c.id));
        return `
        <button type="button" role="listitem" class="comm-item${active ? " active" : ""}"
          data-id="${escapeHtml(c.id)}" style="--i:${i};--row-accent:${escapeHtml(c.accent || "var(--accent)")}">
          ${avatarHTML(c.name, c.accent, 40)}
          <span class="comm-item-col">
            <span class="comm-item-top">
              <span class="comm-item-name">${escapeHtml(c.name || c.id)}</span>
              <span class="comm-item-kind ${c.kind === "dao" ? "is-dao" : "is-group"}">${kind}</span>
            </span>
            <span class="comm-item-handle">${escapeHtml(c.handle || "")}</span>
          </span>
          ${removable ? `<span class="comm-item-x" role="button" tabindex="0" data-x="${escapeHtml(c.id)}" title="Remove community" aria-label="Remove community">✕</span>` : ""}
        </button>`;
      }).join("")}
    </div>`;
  list.querySelectorAll(".comm-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      const x = e.target.closest(".comm-item-x");
      if (x) { e.stopPropagation(); removeCommunity(x.dataset.x); return; }
      openCommunity(el.dataset.id);
    });
  });
  wireListHead(list);
}

/* wire the rail head buttons (Discover home + Search & add modal) */
function wireListHead(list){
  const btn = list.querySelector("#commAddBtn");
  if (btn) btn.addEventListener("click", () => {
    if (window.LZ && window.LZ.communityAdd) window.LZ.communityAdd.open({ onAdded: onCommunityAdded });
  });
  const disc = list.querySelector("#commDiscoverBtn");
  if (disc) disc.addEventListener("click", () => renderDiscover());
}
function refreshList(){
  if (_daos && _daos.allCommunities) _state.communities = _daos.allCommunities();
  renderList(_state.communities);
}
function onCommunityAdded(c){
  refreshList();
  if (c && c.id) openCommunity(c.id);
}
function removeCommunity(id){
  if (_daos && _daos.removeUserCommunity) _daos.removeUserCommunity(id);
  const wasActive = _state.active && _state.active.id === id;
  refreshList();
  if (wasActive && _state.communities.length) openCommunity(_state.communities[0].id);
}

/* ── community header + tabs ──────────────────────────────────── */

const TABS = [
  { id: "feed", label: "Feed", icon: ICN.feed },
  { id: "channels", label: "Channels", icon: ICN.channels },
  { id: "governance", label: "Governance", icon: ICN.gov },
];

/**
 * Render header + tab bar for a community (default targets the
 * #commHeader / #commTabs containers). Exported so tests can drive it.
 */
export function renderCommunity(community, opts = {}) {
  const c = community || _state.active;
  if (!c) return;
  const header = opts.header || $("commHeader");
  const tabs = opts.tabs || $("commTabs");
  const relays = (c.nostr && c.nostr.relays) || [];
  const relayCount = relays.length;
  const govLabel = c.gov ? (c.gov.adapter === "layerzero" ? "LayerZero referendum" : "On-chain governance") : "No governance";

  if (header) {
    header.innerHTML = `
      <div class="comm-head-main">
        ${avatarHTML(c.name, c.accent, 46)}
        <div class="comm-head-id">
          <div class="comm-head-name">${escapeHtml(c.name || c.id)}
            <span class="comm-kind-pill ${c.kind === "dao" ? "is-dao" : "is-group"}">${c.kind === "dao" ? "DAO" : "Nostr group"}</span>
          </div>
          <div class="comm-head-handle">${escapeHtml(c.handle || "")}</div>
        </div>
      </div>
      <div class="comm-head-status">
        <span class="comm-status-chip" title="${escapeHtml(relays.join(", ") || "no relays configured")}">
          ${ICN.relay}<span>${relayCount} relay${relayCount === 1 ? "" : "s"}</span>
        </span>
        <span class="comm-status-chip ${c.gov ? "is-gov" : "is-muted"}">${ICN.gov}<span>${escapeHtml(govLabel)}</span></span>
      </div>`;
  }

  if (tabs) {
    tabs.innerHTML = TABS.map((t) =>
      `<button type="button" class="comm-tab${_state.tab === t.id ? " active" : ""}" data-tab="${t.id}">
        <span class="comm-tab-icn">${t.icon}</span><span>${t.label}</span>
       </button>`
    ).join("");
    tabs.setAttribute("role", "tablist");
    tabs.querySelectorAll(".comm-tab").forEach((el) => {
      el.addEventListener("click", () => setTab(el.dataset.tab));
    });
  }
}

/* ── tab rendering ────────────────────────────────────────────── */

/**
 * Render the active tab into a panel (default #commPanel).
 * `tab` + `community` can be supplied for isolated tests.
 */
export function renderTab(tab, community, panelEl) {
  const c = community || _state.active;
  const panel = panelEl || $("commPanel");
  if (!panel) return;
  // switching tab/community → stop any prior relay subs
  teardownSubs();
  panel.scrollTop = 0;

  if (!c) {
    panel.replaceChildren(emptyState({ title: "Select a community", body: "Pick a community on the left to get started." }));
    return;
  }
  if (tab === "channels") return renderChannelsTab(c, panel);
  if (tab === "governance") return renderGovernanceTab(c, panel);
  return renderFeedTab(c, panel);
}

/* ── FEED (kind-1) ────────────────────────────────────────────── */

function renderFeedTab(c, panel) {
  const n = (c.nostr) || {};
  panel.innerHTML = `
    <div class="comm-feed">
      <div class="comm-feed-stream" id="commFeedStream">${skeleton({ rows: 4, height: 76 })}</div>
      <div class="comm-composer-slot" id="commComposerSlot"></div>
    </div>`;
  const stream = panel.querySelector("#commFeedStream");
  const slot = panel.querySelector("#commComposerSlot");

  mountComposer(slot, {
    placeholder: "Share something with the community…",
    onSend: (text) => publishKind1(c, text),
  });

  const nostr = window.LZ && window.LZ.nostr;
  if (!nostr || !nostr.openPool) {
    stream.replaceChildren(emptyState({
      icon: ICN.warn, title: "Nostr engine loading",
      body: "The relay engine isn't ready yet. The feed will appear once it connects.",
    }));
    return;
  }
  if (!(n.relays && n.relays.length)) {
    stream.replaceChildren(emptyState({ icon: ICN.relay, title: "No relays", body: "This community has no relays configured." }));
    return;
  }

  let pool;
  try { pool = nostr.openPool(n.relays); } catch (_) { pool = null; }
  if (!pool || !pool.sub) {
    stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Couldn't connect", body: "Relay connection failed. Try again shortly." }));
    return;
  }
  _state.pool = pool;

  const filter = { kinds: [1], limit: 50 };
  if (n.feedAuthors && n.feedAuthors.length) filter.authors = n.feedAuthors;
  if (n.feedHashtag) filter["#t"] = [String(n.feedHashtag).replace(/^#/, "")];

  let gotAny = false;
  const onEvent = (evt) => {
    if (!evt || evt.kind == null) return;
    if (evt.kind === 7) { collectReaction(evt); scheduleFeedRedraw(stream); return; }
    if (evt.kind !== 1) return;
    if (!evt.id || _state.events.has(evt.id)) return;
    _state.events.set(evt.id, evt);
    gotAny = true;
    scheduleFeedRedraw(stream);
    scheduleProfileFetch(() => drawFeed(stream));
  };
  const onEose = () => {
    if (!gotAny) {
      stream.replaceChildren(emptyState({
        icon: ICN.feed, title: "No posts yet",
        body: "Be the first to post — or check back once the relays sync.",
      }));
    }
  };

  try {
    const subId = pool.sub([filter, { kinds: [7], limit: 200 }], { onEvent, onEose });
    if (subId != null) _state.subs.push(subId);
  } catch (_) {
    stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Subscription failed", body: "Couldn't subscribe to the feed." }));
  }
}

/* NIP-25: kind-7 reaction. content "" or "+" → ♥; "-" → 👎; anything else is
   the literal emoji. Keyed by target post → emoji → set of reactor pubkeys. */
function collectReaction(evt) {
  // react to the LAST e-tag (NIP-25: the event being reacted to)
  const eTags = (evt.tags || []).filter((t) => t[0] === "e" && t[1]);
  if (!eTags.length) return;
  const postId = eTags[eTags.length - 1][1];
  let emoji = String(evt.content || "").trim();
  if (emoji === "" || emoji === "+") emoji = "❤️";
  else if (emoji === "-") emoji = "👎";
  else emoji = Array.from(emoji)[0] || "❤️"; // first glyph only
  const byEmoji = _state.reactions.get(postId) || new Map();
  const set = byEmoji.get(emoji) || new Set();
  set.add(evt.pubkey || postId);
  byEmoji.set(emoji, set);
  _state.reactions.set(postId, byEmoji);
}

/** Did I react to this post with this emoji? */
function iReacted(postId, emoji) {
  const byEmoji = _state.reactions.get(postId);
  return !!(byEmoji && byEmoji.get(emoji) && _myPubkey && byEmoji.get(emoji).has(_myPubkey));
}

function scheduleFeedRedraw(stream) {
  if (_state._redrawTimer) return;
  _state._redrawTimer = setTimeout(() => {
    _state._redrawTimer = null;
    drawFeed(stream);
  }, 80);
}

/* NIP-10: the root post id this kind-1 replies to, if any.
   Prefers an explicit "root" marker; else the first e-tag; else "". */
function replyRootOf(evt) {
  const eTags = (evt.tags || []).filter((t) => t[0] === "e" && t[1]);
  if (!eTags.length) return "";
  const root = eTags.find((t) => t[3] === "root");
  if (root) return root[1];
  // marked "reply" without root, or legacy positional: use the first
  return eTags[0][1];
}

function drawFeed(stream) {
  if (!stream || !stream.isConnected) return;
  const all = Array.from(_state.events.values()).filter((e) => e.kind === 1);
  if (!all.length) return;
  // group replies under their root; top-level = posts that aren't replies
  // (or whose root isn't in our buffer)
  const ids = new Set(all.map((e) => e.id));
  const childrenOf = new Map();
  const tops = [];
  for (const e of all) {
    const root = replyRootOf(e);
    if (root && root !== e.id && ids.has(root)) {
      const arr = childrenOf.get(root) || []; arr.push(e); childrenOf.set(root, arr);
    } else {
      tops.push(e);
    }
  }
  tops.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!_myPubkey && state && state.derived && state.derived.priv) myPubkey(); // warm async
  const renderNode = (p, depth) => {
    const kids = (childrenOf.get(p.id) || []).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return postCardHTML(p, depth) + (kids.length
      ? `<div class="comm-thread-kids">${kids.map((k) => renderNode(k, depth + 1)).join("")}</div>`
      : "");
  };
  stream.innerHTML = tops.map((p) => renderNode(p, 0)).join("");

  // reaction buttons (emoji picker reveal)
  stream.querySelectorAll(".comm-post-react").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const emoji = btn.dataset.emoji;
      if (emoji) { reactToPost(_state.active, btn.dataset.id, emoji, stream); return; }
      // toggle the picker on the bare react button
      const pick = btn.parentElement.querySelector(".comm-react-pick");
      if (pick) pick.classList.toggle("open");
    });
  });
  // reply buttons → open inline composer for that post
  stream.querySelectorAll(".comm-post-reply").forEach((btn) => {
    btn.addEventListener("click", () => openReplyComposer(btn.dataset.id, stream));
  });
}

function reactionSummary(postId) {
  const byEmoji = _state.reactions.get(postId);
  if (!byEmoji || !byEmoji.size) return "";
  const entries = Array.from(byEmoji.entries())
    .map(([emoji, set]) => ({ emoji, n: set.size, mine: iReacted(postId, emoji) }))
    .sort((a, b) => b.n - a.n);
  return entries.map((e) =>
    `<button type="button" class="comm-react-chip${e.mine ? " mine" : ""}" data-id="${escapeHtml(postId)}" data-emoji="${escapeHtml(e.emoji)}"
       aria-pressed="${e.mine}" ${canPost() ? "" : "disabled"}>${escapeHtml(e.emoji)} ${e.n}</button>`
  ).join("");
}

function postCardHTML(p, depth = 0) {
  const prof = _state.profiles.get(p.pubkey);
  const name = displayName(p.pubkey);
  const nip05 = nip05Handle(p.pubkey);
  const avatar = prof && prof.picture
    ? `<img class="comm-av comm-av-img" src="${escapeHtml(prof.picture)}" alt="" loading="lazy" style="--av-size:34px" />`
    : avatarHTML(p.pubkey || "?", _state.active && _state.active.accent, 34);
  const reactPicker = REACT_EMOJI.map((em) =>
    `<button type="button" class="comm-react-opt" data-id="${escapeHtml(p.id)}" data-emoji="${escapeHtml(em)}">${escapeHtml(em)}</button>`).join("");
  return `
    <article class="comm-post${depth ? " is-reply" : ""}" style="--i:0">
      <div class="comm-post-head">
        ${avatar}
        <div class="comm-post-meta">
          <span class="comm-post-author">${escapeHtml(name)}${nip05 ? ` <span class="comm-nip05" title="NIP-05 verified ${escapeHtml(nip05)}">${ICN.check}</span>` : ""}</span>
          <span class="comm-post-time">${escapeHtml(relTime(p.created_at))}</span>
        </div>
      </div>
      <div class="comm-post-body">${linkifySafe(p.content || "")}</div>
      <div class="comm-react-row">${reactionSummary(p.id)}</div>
      <div class="comm-post-actions">
        <div class="comm-react-wrap">
          <button type="button" class="comm-post-react" data-id="${escapeHtml(p.id)}"
            ${canPost() ? "" : "disabled title=\"Derive your identity to react\""} aria-label="Add reaction">
            ${ICN.heart}<span>React</span>
          </button>
          <div class="comm-react-pick" role="menu">${reactPicker}</div>
        </div>
        <button type="button" class="comm-post-reply" data-id="${escapeHtml(p.id)}"
          ${canPost() ? "" : "disabled title=\"Derive your identity to reply\""} aria-label="Reply">
          ${ICN.reply}<span>Reply</span>
        </button>
      </div>
      <div class="comm-reply-slot" data-reply-slot="${escapeHtml(p.id)}"></div>
    </article>`;
}

/* Inline reply composer under a post (NIP-10 marked reply). */
function openReplyComposer(rootId, stream) {
  if (!canPost()) { toast("Derive your identity to reply", "err"); return; }
  const slot = stream.querySelector(`[data-reply-slot="${cssEscape(rootId)}"]`);
  if (!slot) return;
  if (slot.dataset.open === "1") { slot.dataset.open = "0"; slot.innerHTML = ""; return; }
  slot.dataset.open = "1";
  mountComposer(slot, {
    placeholder: "Write a reply…",
    compact: true,
    onSend: (text) => publishReply(_state.active, rootId, text, stream),
  });
  const ta = slot.querySelector(".comm-composer-input");
  if (ta) ta.focus();
}

/* minimal CSS.escape fallback for attribute selectors on hex ids */
function cssEscape(s) {
  return (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** escape, then make bare URLs clickable (safe — operates on escaped text). */
function linkifySafe(text) {
  const esc = escapeHtml(text);
  return esc.replace(/(https?:\/\/[^\s<]+)/g, (m) =>
    `<a href="${m}" target="_blank" rel="noopener noreferrer nofollow" class="comm-link">${m}</a>`);
}

async function publishKind1(c, text) {
  if (!canPost()) { toast("Derive your identity to post", "err"); return false; }
  const nostr = window.LZ.nostr;
  const tags = [];
  if (c.nostr && c.nostr.feedHashtag) tags.push(["t", String(c.nostr.feedHashtag).replace(/^#/, "")]);
  return signAndPublish({ kind: 1, content: text, tags }, "Posted to feed");
}

/* NIP-10 reply: tag the root with a "root" marker + p-tag the author. */
async function publishReply(c, rootId, text, stream) {
  if (!canPost()) { toast("Derive your identity to reply", "err"); return false; }
  const root = _state.events.get(rootId);
  const tags = [["e", rootId, "", "root"]];
  if (root && root.pubkey) tags.push(["p", root.pubkey]);
  if (c && c.nostr && c.nostr.feedHashtag) tags.push(["t", String(c.nostr.feedHashtag).replace(/^#/, "")]);
  const ok = await signAndPublish({ kind: 1, content: text, tags }, "Reply posted");
  if (ok) {
    // optimistic local reflect
    try {
      const me = await myPubkey();
      if (me) {
        const id = "local:" + Math.random().toString(36).slice(2);
        _state.events.set(id, { id, kind: 1, pubkey: me, content: text, created_at: Math.floor(Date.now() / 1000), tags });
        drawFeed(stream);
      }
    } catch (_) {}
  }
  return ok;
}

/* NIP-25 reaction: kind-7 with the emoji as content, e-tag the post. */
async function reactToPost(c, postId, emoji, stream) {
  if (!canPost()) { toast("Derive your identity to react", "err"); return; }
  const content = emoji === "❤️" ? "+" : emoji; // "+" is the canonical like
  const ok = await signAndPublish({ kind: 7, content, tags: [["e", postId]] }, null, true);
  if (ok) {
    try {
      const me = await myPubkey();
      if (me) {
        const byEmoji = _state.reactions.get(postId) || new Map();
        const set = byEmoji.get(emoji) || new Set();
        set.add(me); byEmoji.set(emoji, set);
        _state.reactions.set(postId, byEmoji);
        drawFeed(stream);
      }
    } catch (_) {}
  }
}

/* ── CHANNELS (kind-42, NIP-28) ───────────────────────────────── */

function renderChannelsTab(c, panel) {
  const channels = (c.nostr && c.nostr.channels) || [];
  if (!channels.length) {
    panel.replaceChildren(emptyState({ icon: ICN.channels, title: "No channels", body: "This community hasn't set up any channels." }));
    return;
  }
  // default selection
  if (!_state.activeChannel || !channels.some((ch) => ch.id === _state.activeChannel)) {
    _state.activeChannel = channels[0].id;
  }
  panel.innerHTML = `
    <div class="comm-channels">
      <div class="comm-chan-rail" role="tablist" aria-label="Channels">
        ${channels.map((ch) =>
          `<button type="button" class="comm-chan-btn${ch.id === _state.activeChannel ? " active" : ""}" data-ch="${escapeHtml(ch.id)}">
            <span class="comm-chan-hash">#</span>${escapeHtml(ch.name || ch.id)}
           </button>`
        ).join("")}
      </div>
      <div class="comm-chan-view">
        <div class="comm-chan-stream" id="commChanStream">${skeleton({ rows: 5, height: 40 })}</div>
        <div class="comm-composer-slot" id="commChanComposer"></div>
      </div>
    </div>`;

  panel.querySelectorAll(".comm-chan-btn").forEach((btn) => {
    btn.addEventListener("click", () => { _state.activeChannel = btn.dataset.ch; renderChannelsTab(c, panel); });
  });

  const ch = channels.find((x) => x.id === _state.activeChannel);
  const stream = panel.querySelector("#commChanStream");
  const slot = panel.querySelector("#commChanComposer");

  mountComposer(slot, {
    placeholder: `Message #${ch && ch.name ? ch.name : "channel"}…`,
    compact: true,
    onSend: (text) => publishKind42(c, ch, text),
  });

  const nostr = window.LZ && window.LZ.nostr;
  if (!nostr || !nostr.openPool) {
    stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Nostr engine loading", body: "Messages appear once the relay engine connects." }));
    return;
  }
  const relays = (c.nostr && c.nostr.relays) || [];
  if (!relays.length) { stream.replaceChildren(emptyState({ icon: ICN.relay, title: "No relays", body: "No relays configured." })); return; }

  let pool;
  try { pool = nostr.openPool(relays); } catch (_) { pool = null; }
  if (!pool || !pool.sub) { stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Couldn't connect", body: "Relay connection failed." })); return; }
  _state.pool = pool;

  // NIP-28: a channel needs a kind-40 root before kind-42 messages can be
  // tagged/queried. If none is minted yet, offer to create it (needs a key);
  // read-only users see an honest "not set up" note.
  if (!ch || !ch.root) {
    renderChannelMintState(c, ch, panel, stream);
    return;
  }

  let gotAny = false;
  const onEvent = (evt) => {
    if (!evt || evt.kind !== 42 || !evt.id || _state.events.has(evt.id)) return;
    _state.events.set(evt.id, evt);
    gotAny = true;
    scheduleChanRedraw(stream);
    scheduleProfileFetch(() => drawChannel(stream));
  };
  const onEose = () => {
    if (!gotAny) stream.replaceChildren(emptyState({ icon: ICN.channels, title: "No messages yet", body: "Start the conversation below." }));
  };

  try {
    const subId = pool.sub([{ kinds: [42], "#e": [ch.root], limit: 100 }], { onEvent, onEose });
    if (subId != null) _state.subs.push(subId);
  } catch (_) {
    stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Subscription failed", body: "Couldn't load this channel." }));
  }
}

function scheduleChanRedraw(stream) {
  if (_state._redrawTimer) return;
  _state._redrawTimer = setTimeout(() => {
    _state._redrawTimer = null;
    drawChannel(stream);
  }, 80);
}

function drawChannel(stream) {
  if (!stream || !stream.isConnected) return;
  const msgs = Array.from(_state.events.values())
    .filter((e) => e.kind === 42)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // chat = oldest first
  if (!msgs.length) return;
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  stream.innerHTML = msgs.map((m) => `
    <div class="comm-chan-msg">
      ${avatarHTML(m.pubkey || "?", _state.active && _state.active.accent, 28)}
      <div class="comm-chan-msg-col">
        <div class="comm-chan-msg-meta">
          <span class="comm-chan-msg-author">${escapeHtml(displayName(m.pubkey))}</span>
          <span class="comm-chan-msg-time">${escapeHtml(relTime(m.created_at))}</span>
        </div>
        <div class="comm-chan-msg-body">${linkifySafe(m.content || "")}</div>
      </div>
    </div>`).join("");
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

async function publishKind42(c, ch, text) {
  if (!canPost()) { toast("Derive your identity to send", "err"); return false; }
  if (!ch || !ch.root) { toast("Channel not ready", "err"); return false; }
  // NIP-28 kind-42: e-tag the root with a "root" marker.
  return signAndPublish({ kind: 42, content: text, tags: [["e", ch.root, (c.nostr && c.nostr.relays && c.nostr.relays[0]) || "", "root"]] }, "Message sent");
}

/* Read-only / mint-prompt state for a channel with no NIP-28 root yet. */
function renderChannelMintState(c, ch, panel, stream) {
  if (!canPost()) {
    stream.replaceChildren(emptyState({
      icon: ICN.channels, title: "Channel not set up yet",
      body: "No one has created this NIP-28 channel yet. Derive your identity to be the one who opens it.",
    }));
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "comm-chan-mint";
  wrap.innerHTML = `
    <div class="comm-chan-mint-icn">${ICN.channels}</div>
    <h3>Open #${escapeHtml(ch && ch.name ? ch.name : "channel")}</h3>
    <p>This channel doesn't exist on the relays yet. Publish its NIP-28 root (a kind-40 event) to bring it to life — anyone can then post here.</p>
    <button type="button" class="btn accent" id="commMintBtn">Create channel</button>`;
  stream.replaceChildren(wrap);
  wrap.querySelector("#commMintBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Publishing…";
    const root = await ensureChannelRoot(c, ch);
    if (root) {
      ch.root = root;
      toast("Channel created", "ok");
      renderChannelsTab(c, panel); // re-render now that the root exists
    } else {
      btn.disabled = false; btn.textContent = "Create channel";
      toast("Couldn't create channel — relay unreachable", "err");
    }
  });
}

/* Publish a kind-40 channel-create event, persist its id as the channel root,
   and return the new root id (or null on failure). Uses the live pool. */
async function ensureChannelRoot(c, ch) {
  if (ch && ch.root) return ch.root;
  if (!canPost() || !ch) return null;
  const meta = JSON.stringify({
    name: ch.name || ch.id,
    about: `${c.name || c.id} · #${ch.name || ch.id}`,
    relays: (c.nostr && c.nostr.relays) || [],
  });
  // sign + publish kind-40; the signed event's id IS the channel root.
  const nostr = window.LZ && window.LZ.nostr;
  if (!nostr || !nostr.signEvent || !_state.pool || !_state.pool.publish) return null;
  let signed;
  try {
    signed = await nostr.signEvent(
      { kind: 40, content: meta, created_at: Math.floor(Date.now() / 1000), tags: [] },
      state.derived.priv
    );
  } catch (e) { console.warn("[communities] kind-40 sign failed:", e); return null; }
  try {
    const res = await _state.pool.publish(signed);
    const ok = !Array.isArray(res) || res.some((r) => r && r.ok);
    if (!ok) return null;
  } catch (e) { console.warn("[communities] kind-40 publish failed:", e); return null; }
  // persist via daos.js so the root survives reloads + fills the registry
  try { if (_daos && _daos.setChannelRoot) _daos.setChannelRoot(c.id, ch.id, signed.id); } catch (_) {}
  return signed.id;
}

/* ── GOVERNANCE (delegated) ───────────────────────────────────── */

function renderGovernanceTab(c, panel) {
  const gov = window.LZ && window.LZ.gov;
  if (gov && typeof gov.renderGovernance === "function") {
    try {
      gov.renderGovernance(panel, c.gov);
      return;
    } catch (e) {
      console.warn("[communities] gov.renderGovernance threw:", e);
      panel.replaceChildren(emptyState({ icon: ICN.warn, title: "Governance error", body: "The governance module failed to render." }));
      return;
    }
  }
  panel.replaceChildren(emptyState({
    icon: ICN.gov,
    title: "Governance module loading",
    body: c.gov ? "Proposals will appear once the governance engine is ready." : "This community has no on-chain governance.",
  }));
}

/* ── composer (shared by feed + channels) ─────────────────────── */

function mountComposer(slot, { placeholder, onSend, compact } = {}) {
  if (!slot) return;
  if (!canPost()) {
    slot.innerHTML = `
      <button type="button" class="comm-derive-cta" id="commDeriveCta">
        <div class="comm-derive-icn">${ICN.relay}</div>
        <div class="comm-derive-txt">
          <strong>Derive your identity to post →</strong>
          <span>${state && state.account ? "Sign once to create your Nostr name." : "Connect your wallet, then derive your Nostr name."}</span>
        </div>
      </button>`;
    slot.querySelector("#commDeriveCta")?.addEventListener("click", () => {
      if (window.LZ && window.LZ.navigate) window.LZ.navigate("identity");
      else location.hash = "#/identity";
    });
    return;
  }
  slot.innerHTML = `
    <form class="comm-composer${compact ? " compact" : ""}">
      <textarea class="comm-composer-input" rows="1" placeholder="${escapeHtml(placeholder || "Write a message…")}" maxlength="2000"></textarea>
      <button type="submit" class="btn accent sm comm-composer-send" disabled>${ICN.send}<span>${compact ? "Send" : "Post"}</span></button>
    </form>`;
  const form = slot.querySelector("form");
  const input = slot.querySelector(".comm-composer-input");
  const send = slot.querySelector(".comm-composer-send");

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    send.disabled = !input.value.trim();
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (compact || e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault(); form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true; input.disabled = true;
    const ok = await Promise.resolve(onSend ? onSend(text) : false);
    input.disabled = false;
    if (ok) { input.value = ""; autosize(); }
    else { send.disabled = false; }
    input.focus();
  });
}

/* ── sign + publish (guarded) ─────────────────────────────────── */

async function signAndPublish(unsigned, okMsg, silent) {
  const nostr = window.LZ && window.LZ.nostr;
  if (!nostr || !nostr.signEvent || !_state.pool || !_state.pool.publish) {
    if (!silent) toast("Can't publish right now", "err");
    return false;
  }
  let signed;
  try {
    // signEvent is async (it awaits the lazy @noble crypto load) — MUST await,
    // otherwise publish() receives a Promise and the send silently fails.
    signed = await nostr.signEvent(
      Object.assign({ created_at: Math.floor(Date.now() / 1000), tags: [] }, unsigned),
      state.derived.priv
    );
  } catch (e) {
    console.warn("[communities] signEvent failed:", e);
    if (!silent) toast("Couldn't sign event", "err");
    return false;
  }
  try {
    const res = await _state.pool.publish(signed);
    const ok = !Array.isArray(res) || res.some((r) => r && r.ok);
    if (ok) { if (okMsg) toast(okMsg, "ok"); return true; }
    if (!silent) toast("Relays rejected the event", "err");
    return false;
  } catch (e) {
    console.warn("[communities] publish failed:", e);
    if (!silent) toast("Publish failed — relay unreachable", "err");
    return false;
  }
}

/* ── public API ───────────────────────────────────────────────── */

/** Ensure the container skeleton exists (coordinator usually provides it). */
export function mountSkeleton() {
  let layout = $("commLayout");
  if (layout) return layout;
  const host = document.querySelector('[data-view="chat"]') || document.body;
  layout = document.createElement("div");
  layout.id = "commLayout";
  layout.innerHTML = `
    <aside id="commList"></aside>
    <section id="commMain">
      <header id="commHeader"></header>
      <nav id="commTabs"></nav>
      <div id="commPanel"></div>
    </section>`;
  host.appendChild(layout);
  return layout;
}

export function setTab(tab) {
  _state.tab = (tab === "channels" || tab === "governance") ? tab : "feed";
  // reflect active tab button without re-subscribing the header
  const tabs = $("commTabs");
  if (tabs) {
    tabs.querySelectorAll(".comm-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === _state.tab));
  }
  renderTab(_state.tab, _state.active);
}

export function openCommunity(id) {
  const c = _state.communities.find((x) => x.id === id) || (typeof id === "object" ? id : null);
  if (!c) return;
  _state.view = "community";
  _state.active = c;
  _state.activeChannel = null;
  _state.tab = "feed";
  applyAccent(c.accent);
  // reflect active row in the list; leave the Discover home button
  const list = $("commList");
  if (list){
    list.querySelectorAll(".comm-item").forEach((el) =>
      el.classList.toggle("active", el.dataset.id === c.id));
    list.querySelector("#commDiscoverBtn")?.classList.remove("active");
  }
  renderCommunity(c);
  setTab("feed");
}

/* ── Discover home — most-followed DAOs + hottest live votes ──── */
function fmtNum(n){
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}
function fmtCountdown(ms){
  if (!ms) return "";
  const d = ms - Date.now();
  if (d <= 0) return "ended";
  const h = d / 3.6e6;
  if (h >= 48) return Math.round(h / 24) + "d left";
  if (h >= 1)  return Math.round(h) + "h left";
  return Math.max(1, Math.round(d / 6e4)) + "m left";
}
/* add (if needed) + open a Snapshot space as a community, on a given tab */
function openSnapshotDao(spaceId, spaceName, tab){
  if (!_daos || !_daos.communityFromSnapshot || !spaceId) return;
  const c = _daos.communityFromSnapshot({ id: spaceId, name: spaceName || spaceId });
  if (_daos.addUserCommunity) _daos.addUserCommunity(c);
  refreshList();
  openCommunity(c.id);
  if (tab) setTab(tab);
}

export async function renderDiscover(){
  _state.view = "discover";
  _state.active = null;
  teardownSubs();
  applyAccent(null);
  renderList(_state.communities); // reflect discover-active in the rail

  const header = $("commHeader"), tabs = $("commTabs"), panel = $("commPanel");
  if (tabs) tabs.innerHTML = "";
  if (header){
    header.innerHTML = `
      <div class="cd-hero">
        <h2 class="cd-hero-title">Discover</h2>
        <p class="cd-hero-sub">The most-followed DAOs and the hottest live votes on Snapshot — keyless, real-time.</p>
      </div>`;
  }
  if (!panel) return;
  panel.scrollTop = 0;
  panel.innerHTML = `
    <div class="cd-wrap">
      <section class="cd-sec">
        <div class="cd-sec-head"><h3 class="cd-sec-title"><span class="cd-fire" aria-hidden="true">🔥</span> Hot votes</h3><span class="cd-sec-sub">live · most active</span></div>
        <div class="cd-hot" id="cdHot">${skeleton({ rows: 4, height: 62 })}</div>
      </section>
      <section class="cd-sec">
        <div class="cd-sec-head"><h3 class="cd-sec-title">Famous DAOs</h3><span class="cd-sec-sub">most followed</span></div>
        <div class="cd-daos" id="cdDaos">${skeleton({ rows: 3, height: 64 })}</div>
      </section>
    </div>`;

  const gov = window.LZ && window.LZ.gov;

  (async () => {
    const hot = gov && gov.hotProposals ? await gov.hotProposals(10).catch(() => []) : [];
    const el = $("cdHot");
    if (!el || _state.view !== "discover") return;
    if (!hot.length){ el.replaceChildren(emptyState({ title: "No live votes right now", body: "Active proposals across Snapshot will show up here." })); return; }
    el.innerHTML = hot.map((p) => `
      <div class="cd-hot-item">
        <div class="cd-hot-main">
          <span class="cd-hot-space">${escapeHtml(p.spaceName || p.spaceId)}</span>
          <span class="cd-hot-title">${escapeHtml(p.title)}</span>
          <span class="cd-hot-meta">${escapeHtml(fmtNum(p.voters))} votes${p.endsAt ? " · " + escapeHtml(fmtCountdown(p.endsAt)) : ""}</span>
        </div>
        <button type="button" class="btn accent sm cd-vote" data-space="${escapeHtml(p.spaceId)}" data-name="${escapeHtml(p.spaceName || p.spaceId)}">Vote →</button>
      </div>`).join("");
    el.querySelectorAll(".cd-vote").forEach((b) =>
      b.addEventListener("click", () => openSnapshotDao(b.dataset.space, b.dataset.name, "governance")));
  })();

  (async () => {
    const spaces = gov && gov.featuredSpaces ? await gov.featuredSpaces(12).catch(() => []) : [];
    const el = $("cdDaos");
    if (!el || _state.view !== "discover") return;
    if (!spaces.length){ el.replaceChildren(emptyState({ title: "Couldn't load DAOs", body: "Snapshot didn't respond — try again shortly." })); return; }
    el.innerHTML = spaces.map((s) => `
      <button type="button" class="cd-dao" data-space="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" data-network="${escapeHtml(s.network || "")}">
        ${avatarHTML(s.name, null, 38)}
        <span class="cd-dao-col">
          <span class="cd-dao-name">${escapeHtml(s.name)}</span>
          <span class="cd-dao-meta">${escapeHtml(fmtNum(s.followers))} followers${s.proposals ? " · " + escapeHtml(fmtNum(s.proposals)) + " proposals" : ""}</span>
        </span>
        <span class="cd-dao-open">Open</span>
      </button>`).join("");
    el.querySelectorAll(".cd-dao").forEach((b) =>
      b.addEventListener("click", () => openSnapshotDao(b.dataset.space, b.dataset.name, "governance")));
  })();
}

export async function init() {
  mountSkeleton();
  // Load the registry; tolerate it being absent during isolated tests.
  if (!_daos) {
    try { _daos = await import("./daos.js"); }
    catch (e) { console.warn("[communities] daos.js unavailable:", e); }
  }
  if (_daos && _daos.allCommunities) _state.communities = _daos.allCommunities();
  else if (_daos && _daos.COMMUNITIES) _state.communities = _daos.COMMUNITIES;
  renderList(_state.communities);
  // Open on the Discover home (famous DAOs + hot votes) rather than auto-
  // opening a single community — works even with an empty registry.
  renderDiscover();
}

/* allow tests to inject a fixture list without daos.js */
export function _setCommunities(list) { _state.communities = list || []; }

/* ── self-mount the frozen public API ─────────────────────────── */
window.LZ = window.LZ || {};
/* CSP-safe broken-avatar fallback (replaces the old inline onerror=, which a
 * strict script-src blocks). `error` doesn't bubble, so listen in capture phase. */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img && img.tagName === "IMG" && img.classList.contains("comm-av-img")){
    const span = document.createElement("span");
    span.className = "comm-av"; span.textContent = "·";
    img.replaceWith(span);
  }
}, true);

window.LZ.communities = { init, openCommunity, setTab };

export { _state };
