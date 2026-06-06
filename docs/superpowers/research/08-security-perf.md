# 08 — Wallet / Recovery / Network + Cross-Cutting Security & Performance

Research phase (read-only). Scope: wallet-actions, recovery flow, risk/risk-watch,
network switching, plus an app-wide AUDIT lens on XSS, key/seed handling, CSP /
supply-chain, relay/RPC trust, load performance, and memory leaks. No build step.

---

## 1. Current state (file:line)

### Wallet actions (`assets/js/wallet-actions.js`, 947 lines)
- Receive / Swap / Bridge via LI.FI keyless HTTP API (`LIFI = "https://li.quest/v1"`, line 29).
- Self-contained QR encoder (lines 105-388) — no external QR service, good.
- All funds-moving steps are explicit + user-signed: switchChain → allowance check →
  approve → `eth_sendTransaction` → poll status (lines 820-901).
- Has a local `esc()` HTML-escaper (lines 61-63) and uses it consistently in modal markup.
- LI.FI quote forwards `txReq.to`/`data`/`value` straight to the wallet (lines 874-879) — trusts the LI.FI response as the tx target.
- Token symbols/names from LI.FI are escaped before render (`tokenOptions`, lines 619-624).

### Recovery flow (`assets/js/pillars.js`, 507 lines)
- 100% **mock / simulated** social-recovery UX (header comment lines 1-20): guardians,
  threshold stepper, per-chain chips, drill animation, activity feed. No contracts, no keys.
- Has a local `esc()` (line 153); guardian names/types are escaped (lines 140-146, 286, 297).
- `addFeedEvent(whatHtml,...)` (line 454) inserts `whatHtml` as **raw HTML** by design;
  every caller passes only escaped or static strings — currently safe but fragile.
- `recoveryInviteLink` is a hard-coded placeholder (`https://lz.id/g/inv-...`, app.html:460).

### Risk engine (`assets/js/risk.js` 70 ln, `assets/js/risk-watch.js` 83 ln)
- `risk.js` is pure/keyless/no-DOM/no-network — clean, testable. Good separation.
- `risk-watch.js` polls HL clearinghouse + meta every `pollMs=25000` (risk.js:8), gates on
  `document.hidden` (risk-watch.js:64) — the **only** module that pauses when tab hidden.
- Singleton interval with `start`/`stop` guards (lines 71-72); failures degrade silently.

### Network switching
- In-app chain switch: `wallet-actions.js:459 switchChain()` — `wallet_switchEthereumChain`,
  rejects 4001, verifies post-switch chainId (lines 471-472). Solid.
- `shared.js:117` `chainChanged → location.reload()` — heavy but safe.
- The "Network" *view* (`app.js:709-781`) is a **simulated stream** (random hashes/routes),
  unrelated to real chain switching; a `setInterval` every 2.2s rebuilds the list innerHTML.

### Key / seed handling (`assets/js/shared.js`, 183 lines)
- EVM connect is non-custodial (wallet holds key). Nostr key is **derived** from a
  `personal_sign` signature → `sha256` → schnorr (lines 67-89). Deterministic, documented.
- HL trading signs via `eth_signTypedData_v4` through the wallet (`hyperliquid.js:207-227`) —
  **no private key ever held in JS**. This is the correct pattern; preserve it.

### Loading (`app.html`)
- **25 CSS** `<link>` in `<head>` (lines 15-38), all render-blocking, all eager.
- **~20 ES modules** loaded eagerly at body end (lines 706-724), every route's JS on every page.
- Vendored `lightweight-charts` classic `<script>` (line 706) blocks parse before modules.
- Cache-bust via `?v=3` query — fine for a no-build app.

---

## 2. Findings

### SECURITY

**[HIGH] S1 — Nostr private key persisted in `localStorage`.**
`shared.js:21,86,98` store `cm:priv` (the derived Nostr secret key, 32-byte hex) in
`localStorage` and rehydrate it on boot (`bootstrapWallet`, lines 92-98). `localStorage` is
readable by any script on the origin and survives indefinitely. The comment even says
"never sent off-device; treat as a session key" — but a session key should not live in
persistent, JS-readable storage. Any XSS (see S3) or malicious dependency (see S5) can
exfiltrate it, and it grants full ability to **sign Nostr events as the user** (post,
react, DM). This is the single most impactful issue in scope.

**[HIGH] S2 — Anthropic API key in `localStorage` + browser-direct calls.**
`assistant.js:45,648-650,1061` keep the user's Anthropic key in `localStorage` and send it
via `x-api-key` + `anthropic-dangerous-direct-browser-access: true` straight from the
browser (model `claude-sonnet-4-6`, line 25). This is a deliberate "bring-your-own-key"
design, but the key is XSS-exfiltratable and exposed to every relay/RPC-loaded script on
the origin. At minimum it deserves an explicit in-UI warning and a "this stays in your
browser, never proxied" note (the code comment claims this but the user can't see it).

**[MED] S3 — DOM-based self-XSS in mock chat.**
`app.js:243` renders message text raw (`<div>${m.text}</div>`) and `sendChatMsg`
(lines 264-292) feeds unescaped user input into `THREADS` then re-renders via `innerHTML`.
It's "self" XSS (user types into their own thread) and the data is non-persistent, but it's
a real injection sink that becomes critical the moment chat is wired to Nostr/relays. The
social modules already do this correctly (`communities.js linkifySafe`, `escapeHtml`) —
chat is the outlier.

**[LOW] S4 — No Content-Security-Policy; no Subresource Integrity.**
No CSP meta/header anywhere (`app.html`, `index.html`). The app pulls runtime code from
**`esm.sh`** (crypto libs, S5) and data from ~25 external origins (CoinGecko, LI.FI,
Hyperliquid, Snapshot, llama.fi, blockscout, publicnode RPCs, Nostr relays). With keys in
`localStorage` (S1/S2), the absence of a CSP means one injected script can read everything
and beacon it out. A CSP is the highest-leverage single mitigation.

**[MED] S5 — Supply-chain: unpinned-by-hash crypto from `esm.sh`.**
`shared.js:9-11` and `nostr.js:22-23` import `@noble/secp256k1@2.1.0`,
`@noble/hashes@1.4.0`, `@scure/base@1.1.6` from `esm.sh` at runtime. Versions are pinned
(good) but there is **no SRI / no integrity hash** — `esm.sh` (or a MITM of it) can serve
altered crypto that leaks the derived seed or forges signatures. These libs guard the
identity seed and Nostr signing, so they are the crown-jewel dependency.

**[LOW] S6 — LI.FI response is a trusted tx target.**
`wallet-actions.js:832,874-879` send `approvalAddress` and `transactionRequest.to/data` from
the LI.FI quote without independent validation. A compromised/spoofed LI.FI response (no SRI
on the API, S4) could direct an approval/tx to an attacker. The user still sees the wallet
confirmation, so it's mitigated, but the review modal shows route/amounts, not the raw `to`.

**[INFO] S7 — Mock send is labelled as signed.**
`app.js:493-502` "Quick send" toasts `signed · {amt} {asset} → {to}` but performs **no real
transaction**. Honest-UX risk: a user may believe funds moved. Other mock surfaces (txs,
recovery) are explicitly labelled "isn't wired"; this one is not.

### PERFORMANCE

**[MED] P1 — All route JS/CSS loaded eagerly.**
25 render-blocking CSS + ~20 ES modules + lightweight-charts load on every page regardless
of route (`app.html:15-38,706-724`). The wallet/chat landing route pays for trade, charts,
governance, communities, coin-page, all HL modules. No code-splitting per route.

**[MED] P2 — Background intervals never pause on hidden tab or inactive route.**
- `app.js:749` network-stream interval (2.2s) rebuilds `#streamList` innerHTML forever, even
  when the Network view is not active and even when the tab is hidden.
- `app.js:20` + `shared.js:178` 1s clock ticks always.
- `pillars.js:484,488` recovery feed (14s) + last-test counter (5s) run forever regardless of
  route.
- Only `risk-watch.js:64` and `sigil.js:176-182` respect `document.hidden`.
This is constant wasted layout/GC on hidden tabs and battery drain on mobile.

**[LOW] P3 — Full-list `innerHTML` rebuilds on each tick.**
Network stream (`app.js:734-745`) and recovery feed re-`innerHTML` the whole list each
interval rather than prepending one node and trimming. Causes layout thrash + drops any
in-progress CSS animation state.

**[LOW] P4 — `chainChanged` does a full `location.reload()`** (`shared.js:117`) — drops all
in-memory state and re-fetches everything; acceptable but heavy.

**[INFO] P5 — Memory leak surface is mostly clean.**
Nostr `openPool` tracks subs/pubs and `close()` clears them + closes sockets
(`nostr.js:312-318`); HL ws has ping timer + backoff. Sigil RAF stops on
visibility/disconnect. The leaks that exist are the never-cleared global intervals (P2),
not socket/RAF leaks.

---

## 3. Prioritized fixes

### P0 — do first
- **S1: Stop persisting the Nostr secret key.** Keep `cm:priv` in memory only
  (`state.derived.priv`); on reload, re-derive via one `personal_sign` (the message is
  already deterministic, `shared.js:46`). If persistence is required for UX, store only
  `npub` (public) and re-derive the secret on demand. *Files: shared.js. Effort: S (~30 min).*
- **S4: Add a Content-Security-Policy.** Meta tag in `app.html`/`index.html` allowlisting
  exactly the known origins (`esm.sh`, the API hosts, `connect-src` for RPCs/relays/ws,
  `font-src` Google). `script-src 'self' https://esm.sh`; no `unsafe-eval`; `object-src
  'none'`. *Files: app.html, index.html. Effort: M (~1-2h incl. tightening to pass).*

### P1 — soon
- **S5: Pin crypto deps by SRI/hash or vendor them.** Either vendor `@noble`/`@scure` into
  `assets/vendor/` (like lightweight-charts already is) and import locally, or use
  `esm.sh` pinned URLs with an integrity-checked import map. Vendoring also removes a runtime
  network dependency for identity derivation. *Files: shared.js, nostr.js, app.html (importmap),
  assets/vendor/. Effort: M.*
- **S2: Surface a visible "key stays local" warning + scope note in the copilot settings UI;**
  consider sessionStorage instead of localStorage so it clears on tab close.
  *Files: assistant.js, app.html. Effort: S.*
- **S3: Escape chat message text.** Reuse `escapeHtml` from `ui.js` at `app.js:243` and on
  `m.meta`. *Files: app.js. Effort: S.*
- **P2: Gate background intervals on route + visibility.** Start/stop the network-stream and
  recovery-feed timers on `lz:route` enter/leave (the event already exists, `app.js:87`) and on
  `visibilitychange`. *Files: app.js, pillars.js. Effort: S-M. Target: 0 timers firing on hidden/inactive routes.*

### P2 — nice to have
- **P1: Lazy-load per-route modules** via dynamic `import()` inside `ONROUTE` hooks
  (`app.js:963`) — load trade/charts/coin/communities/governance/HL modules on first route
  entry, not at boot. Keep wallet/chat/identity eager. *Files: app.html (drop most static
  module tags), app.js (dynamic import in route hooks). Effort: M. Target: initial JS payload
  cut to the boot-critical set.* NOTE: must preserve `window.LZ` self-mount ordering.
- **P3: Incremental DOM for streams** — prepend one node + trim, instead of full innerHTML.
  *Files: app.js, pillars.js. Effort: S.*
- **S6: Show the resolved tx `to`/spender in the review modal** so the user can sanity-check
  the LI.FI target. *Files: wallet-actions.js (renderReview). Effort: S.*
- **S7: Relabel mock "Quick send"** to make clear it's a demo (match the honest txs/recovery
  copy). *Files: app.js, app.html. Effort: XS.*

---

## 4. External best practices (validated against current code)

- **Web Crypto / key handling:** never persist secret key material in `localStorage`
  (JS-readable, no expiry). Prefer in-memory + on-demand re-derivation; if storage is
  unavoidable, `sessionStorage` (clears on tab close) or non-extractable `CryptoKey` via
  WebCrypto `importKey`/`subtle` (note: schnorr/secp256k1 is not in WebCrypto, so non-extractable
  isn't an option here — strengthens the "in-memory only" recommendation). The app already
  does the right thing for the EVM key (wallet-held) and HL signing (`signTypedData`).
- **XSS in vanilla DOM apps:** treat *all* relay/on-chain/API strings as untrusted; escape at
  the boundary (the `escapeHtml`/`esc`/`linkifySafe` pattern is correct — apply it uniformly,
  the chat view is the one gap). Prefer `textContent` over `innerHTML` for pure-text nodes.
- **CSP for static SPAs:** even without a server you can ship a `<meta http-equiv>` CSP;
  `connect-src` must enumerate every fetch/ws origin (this app has ~25 + relays). Add
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'none'`.
- **Supply chain:** pin CDN modules and add SRI, or vendor. An import map with hashed URLs is
  the no-build-friendly option. Crypto libs especially should not be hot-loaded unpinned.
- **Browser-direct LLM keys:** Anthropic's `anthropic-dangerous-direct-browser-access` is
  explicitly a convenience-with-risk flag; for production a thin proxy that holds the key
  server-side is the recommended pattern, but for a bring-your-own-key personal tool the
  current approach is acceptable *with* a clear user warning.
- **Perf without a build:** route-level dynamic `import()`, `rel=preload`/`modulepreload` for
  the boot-critical few, defer non-critical CSS, and pause timers/RAF on `visibilitychange` —
  all available natively, no bundler needed.

---

## 5. FILE OWNERSHIP (for CREATE phase)

**Files I would edit (primary owner):**
- `assets/js/shared.js` — S1 (stop persisting secret key), key-handling hardening.
- `assets/js/pillars.js` — P2/P3 (gate + incremental feed timers).
- `assets/js/risk.js`, `assets/js/risk-watch.js` — in scope; likely no security edits needed,
  possible tuning only.
- `assets/js/wallet-actions.js` — S6 (show tx target in review), minor.
- `assets/js/assistant.js` — S2 (key warning, sessionStorage option). *Likely SHARED with the
  copilot/assistant swarm agent — coordinate.*

**SHARED files — must coordinate (do NOT edit unilaterally):**
- **`app.html`** — CSP meta (S4), per-route lazy-load module tag removal (P1), preload hints.
  Touched by nearly every agent. **HIGH-contention.**
- **`index.html`** — CSP meta (S4). Landing page; likely owned by a landing/design agent.
- **`assets/js/app.js`** — S3 (chat escape), P2 (network-stream timer gating), P1 (dynamic
  import in `ONROUTE` hooks), S7 (mock send label). Central router + `window.LZ` surface —
  **HIGH-contention**, almost every agent reads/needs it.
- **`assets/js/nostr.js`** — S5 (vendored crypto import) only; otherwise FROZEN interface,
  shared with the communities/social agent.
- **`assets/vendor/`** (new) — vendored `@noble`/`@scure` for S5; coordinate with whoever owns
  the import map in `app.html`.

**Hard constraints to preserve (per swarm brief):** element IDs, `data-view`/`data-route`,
`window.LZ` API, HL signing format (`tests/signing-format.test.mjs`, 336 assertions), Nostr
derivation (`shared.js:46-89`). The S1 fix must keep `deriveNostr()` output identical (same
seed → same npub); it only changes *where the secret lives*, not how it's computed.
