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
  active: null,          // community object
  tab: "feed",           // 'feed' | 'channels' | 'governance'
  activeChannel: null,   // channel id within active community
  pool: null,            // current open pool
  subs: [],              // [subId] currently live on `pool`
  events: new Map(),     // id → event (current feed/channel buffer)
  reactions: new Map(),  // postId → Set(reactorPubkey) (kind-7 ♥)
  _redrawTimer: null,
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
};

/* ── helpers ──────────────────────────────────────────────────── */

/** Deterministic 2-char monogram from a name. */
function monogram(name = "?") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** x-only hex pubkey → readable short id (npub-ish, no crypto needed). */
function shortAuthor(pubkey = "") {
  if (!pubkey) return "anon";
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
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
  clearTimeout(_state._redrawTimer);
  _state._redrawTimer = null;
}

/** Are we able to sign / publish? */
function canPost() {
  return !!(state && state.derived && state.derived.priv && window.LZ && window.LZ.nostr && window.LZ.nostr.signEvent);
}

/* ── list (left rail) ─────────────────────────────────────────── */

/**
 * Render the community list into a target (default #commList).
 * Pass an explicit `communities` array to drive it in tests.
 */
export function renderList(communities, target) {
  const list = target || $("commList");
  if (!list) return;
  const items = communities || _state.communities || [];
  if (!items.length) {
    list.replaceChildren(
      emptyState({ icon: ICN.relay, title: "No communities", body: "The registry is empty." })
    );
    return;
  }
  list.innerHTML = `
    <div class="comm-list-head">
      <span class="comm-list-title">Communities</span>
      <span class="comm-list-n">${items.length}</span>
    </div>
    <div class="comm-list-scroll" role="list">
      ${items.map((c, i) => {
        const kind = c.kind === "dao" ? "DAO" : "Group";
        const active = _state.active && _state.active.id === c.id;
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
        </button>`;
      }).join("")}
    </div>`;
  list.querySelectorAll(".comm-item").forEach((el) => {
    el.addEventListener("click", () => openCommunity(el.dataset.id));
  });
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

function collectReaction(evt) {
  const eTag = (evt.tags || []).find((t) => t[0] === "e");
  if (!eTag || !eTag[1]) return;
  const set = _state.reactions.get(eTag[1]) || new Set();
  set.add(evt.pubkey || eTag[1]);
  _state.reactions.set(eTag[1], set);
}

function scheduleFeedRedraw(stream) {
  if (_state._redrawTimer) return;
  _state._redrawTimer = setTimeout(() => {
    _state._redrawTimer = null;
    drawFeed(stream);
  }, 80);
}

function drawFeed(stream) {
  if (!stream || !stream.isConnected) return;
  const posts = Array.from(_state.events.values())
    .filter((e) => e.kind === 1)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!posts.length) return;
  stream.innerHTML = posts.map((p) => postCardHTML(p)).join("");
  // wire reaction buttons
  stream.querySelectorAll(".comm-post-react").forEach((btn) => {
    btn.addEventListener("click", () => reactToPost(_state.active, btn.dataset.id, stream));
  });
}

function postCardHTML(p) {
  const likes = _state.reactions.get(p.id);
  const likeN = likes ? likes.size : 0;
  const mine = likes && state && state.derived && window.LZ && window.LZ.nostr && window.LZ.nostr.getPubkey;
  let liked = false;
  if (mine) {
    try { liked = likes.has(window.LZ.nostr.getPubkey(state.derived.priv)); } catch (_) {}
  }
  return `
    <article class="comm-post" style="--i:0">
      <div class="comm-post-head">
        ${avatarHTML(p.pubkey || "?", _state.active && _state.active.accent, 34)}
        <div class="comm-post-meta">
          <span class="comm-post-author">${escapeHtml(shortAuthor(p.pubkey))}</span>
          <span class="comm-post-time">${escapeHtml(relTime(p.created_at))}</span>
        </div>
      </div>
      <div class="comm-post-body">${linkifySafe(p.content || "")}</div>
      <div class="comm-post-actions">
        <button type="button" class="comm-post-react${liked ? " liked" : ""}" data-id="${escapeHtml(p.id)}"
          aria-pressed="${liked}" ${canPost() ? "" : "disabled title=\"Derive your identity to react\""}>
          ${ICN.heart}<span>${likeN || ""}</span>
        </button>
      </div>
    </article>`;
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

async function reactToPost(c, postId, stream) {
  if (!canPost()) { toast("Derive your identity to react", "err"); return; }
  const ok = await signAndPublish({ kind: 7, content: "+", tags: [["e", postId]] }, null, true);
  if (ok) {
    // optimistic local reflect
    try {
      const me = window.LZ.nostr.getPubkey(state.derived.priv);
      const set = _state.reactions.get(postId) || new Set();
      set.add(me); _state.reactions.set(postId, set);
      drawFeed(stream);
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

  if (!ch || !ch.root) {
    stream.replaceChildren(emptyState({ icon: ICN.warn, title: "Channel not ready", body: "This channel has no NIP-28 root event yet." }));
    return;
  }
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

  let gotAny = false;
  const onEvent = (evt) => {
    if (!evt || evt.kind !== 42 || !evt.id || _state.events.has(evt.id)) return;
    _state.events.set(evt.id, evt);
    gotAny = true;
    scheduleChanRedraw(stream);
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
          <span class="comm-chan-msg-author">${escapeHtml(shortAuthor(m.pubkey))}</span>
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
  return signAndPublish({ kind: 42, content: text, tags: [["e", ch.root, "", "root"]] }, "Message sent");
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
      <div class="comm-derive-cta">
        <div class="comm-derive-icn">${ICN.relay}</div>
        <div class="comm-derive-txt">
          <strong>Derive your identity to post</strong>
          <span>${state && state.account ? "Sign once to create your Nostr name." : "Connect your wallet, then derive your Nostr name."}</span>
        </div>
      </div>`;
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
    signed = nostr.signEvent(
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
  _state.active = c;
  _state.activeChannel = null;
  _state.tab = "feed";
  applyAccent(c.accent);
  // reflect active row in the list
  const list = $("commList");
  if (list) list.querySelectorAll(".comm-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.id === c.id));
  renderCommunity(c);
  setTab("feed");
}

export async function init() {
  mountSkeleton();
  // Load the registry; tolerate it being absent during isolated tests.
  if (!_state.communities.length) {
    try {
      const mod = await import("./daos.js");
      _state.communities = (mod && mod.COMMUNITIES) || [];
    } catch (e) {
      console.warn("[communities] daos.js unavailable:", e);
      _state.communities = [];
    }
  }
  renderList(_state.communities);
  if (_state.communities.length) openCommunity(_state.communities[0].id);
  else {
    const panel = $("commPanel");
    if (panel) panel.replaceChildren(emptyState({ icon: ICN.relay, title: "No communities", body: "The registry hasn't loaded yet." }));
  }
}

/* allow tests to inject a fixture list without daos.js */
export function _setCommunities(list) { _state.communities = list || []; }

/* ── self-mount the frozen public API ─────────────────────────── */
window.LZ = window.LZ || {};
window.LZ.communities = { init, openCommunity, setTab };

export { _state };
