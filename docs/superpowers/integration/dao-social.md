# Integration — DAO Social (chat-nostr, communities, governance)

All edits below are in the SHARED spine (`app.js`, `app.html`) that this lane does
NOT own. Apply them verbatim. The feature code (communities.js, governance.js,
daos.js, nostr.js, community-add.js, and the NEW chat-nostr.js + chat-nostr.css)
is already done and `node --check`-clean.

---

## 1. app.html — load the two new assets

The new chat engine ships as `assets/js/chat-nostr.js` + `assets/css/chat-nostr.css`.

**a) CSS** — next to the other DAO-social stylesheets (near line 36-38):

```html
<link rel="stylesheet" href="/assets/css/communities.css?v=3" />
<link rel="stylesheet" href="/assets/css/governance.css?v=3" />
<link rel="stylesheet" href="/assets/css/community-add.css?v=3" />
<link rel="stylesheet" href="/assets/css/chat-nostr.css?v=3" />   <!-- ADD -->
```

**b) Script** — chat-nostr.js depends on `nostr.js` and `ui.js`. Add it right
after `communities.js` in the module block (near line 723):

```html
<script type="module" src="/assets/js/communities.js?v=3"></script>
<script type="module" src="/assets/js/community-add.js?v=3"></script>
<script type="module" src="/assets/js/chat-nostr.js?v=3"></script>   <!-- ADD -->
```

No markup changes are required in the chat view: chat-nostr.js renders into the
existing `#chatItems` / `#chatThread` / `#chatSearch` (IDs preserved) and injects
its own "new message" (+) button into `.chat-list-head` on init. You MAY drop the
hardcoded `<span class="tag peer">6 active</span>` in the chat-list head (app.html
~line 157) since the count is now dynamic, but it is harmless to leave.

---

## 2. app.js — REMOVE the mock chat (THIS IS THE LOAD-BEARING DELETION)

Delete the entire mock-chat block. In the current file this is the CHAT VIEW
section, **app.js lines ~165 through ~294**, i.e. everything from:

```js
const CONVS = [
  { id:"maya",   name:"Maya Chen", ... },
  ...
];
```

…down to and including the trailing search listener:

```js
document.getElementById("chatSearch")?.addEventListener("input", (e) => renderChatList(e.target.value));
```

That covers ALL of: `CONVS`, `THREADS`, `activeConv`, `composeLayer`,
`renderChatList()`, `renderThread()`, `sendChatMsg()`, and the `#chatSearch`
listener. Leave the `/* CHAT VIEW */` banner comment if you like; remove the body.

These mock functions also XSS-inject relay-shaped data straight into `innerHTML`
(`renderThread` interpolates `m.text` and `c.name` unescaped) — deleting the block
resolves that finding from the master plan; chat-nostr.js escapes everything via
`ui.js#escapeHtml`.

---

## 3. app.js — rewire the chat route to chat-nostr.js

**a) ONROUTE.chat** (app.js ~line 969). Replace:

```js
  chat: () => { renderChatList(""); renderThread(); },
```

with:

```js
  chat: () => { window.LZ?.chatNostr?.init(); },
```

**b) Boot calls** (app.js ~line 990-991). Replace:

```js
renderChatList("");
renderThread();
```

with:

```js
if (getRoute() === "chat") window.LZ?.chatNostr?.init();
```

(`init()` is idempotent and re-entrant — safe to call on every chat-route enter.
It self-heals once the user derives a key: with no key it shows an honest derive
CTA in both panes; after derivation, the next chat-route enter opens the live
inbox.)

**c) Optional but recommended** — if app.js has an `onLeave`/view-lifecycle
registry (FOUNDATION added one), pause the relay sub when leaving chat:

```js
// wherever onLeave hooks are registered:
chat: () => { window.LZ?.chatNostr?.teardown(); },
```

If there is no onLeave registry, skip this — the sub is a single relay
subscription and is replaced (not duplicated) on the next `init()`.

---

## 4. No changes needed to communities wiring

`bootCommunities()` and the communities route are unchanged. communities.js,
governance.js, daos.js all keep their frozen `window.LZ.{communities,gov,
communityAdd}` surfaces and element IDs.

---

## 5. What landed in the owned files (FYI for the coordinator/auditor)

- **nostr.js** (additive only; frozen exports preserved): `npubEncode`,
  `shortNpubFromHex` (NIP-19), `nip04Encrypt`/`nip04Decrypt` (NIP-04 ECDH +
  WebCrypto AES-256-CBC), `fetchProfiles` (kind-0), `awaitCrypto`. `eventId`/
  `serializeEvent` stay SYNC; `signEvent`/`getPubkey` stay ASYNC.
- **daos.js**: `setChannelRoot`/`getChannelRoot` + `allCommunities()` now merges
  persisted NIP-28 roots (localStorage `lz:channelRoots`). Seed channels still
  ship `root:""` and are minted on first use.
- **communities.js**: NIP-28 kind-40 mint flow (clears "Channel not ready"; read-
  only users get an honest note), kind-0/NIP-05 profiles + npub display, NIP-10
  reply threading, NIP-25 multi-emoji reactions.
- **governance.js**: post-vote single-card refresh + persistent "✓ Voted X" badge
  (localStorage `lz:gov:voted`, keyed across governor/snapshot/layerzero), quorum +
  countdown context, Governor block→timestamp mapping. LayerZero with an unset
  `voteContract` now shows an honest **read-only** note instead of the inert vote
  UI (daos.js:54 still `voteContract:""` — fill it when the real address is
  published; the adapter + UI light up automatically).

## 6. Follow-ups noted (NOT built this pass)
- **NIP-17 / NIP-44 v2 gift-wrapped DMs** — chat-nostr.js uses NIP-04 as a first
  cut (metadata-leaky: the `p` tag reveals the counterparty). Upgrade path: add
  NIP-44 v2 encrypt/decrypt + kind-1059 gift-wrap to nostr.js, swap in chat-nostr.js.
- **LayerZero voteContract** still unverified (daos.js:54). Selectors in
  governance.js are best-guess; verify against deployed bytecode before filling.
- The coordinator's separate task to relocate the Nostr key out of localStorage
  (`cm:priv`) does not conflict with this lane — chat-nostr.js / communities.js
  read `state.derived.priv` through shared.js, which is the right seam.
