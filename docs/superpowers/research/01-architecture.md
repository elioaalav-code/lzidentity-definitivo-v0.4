# Research 01 — Architecture, Routing & App Shell

Scope: `assets/js/app.js`, `app.html`, `shared.js`, `shader.js`, `pillars.js`, `ui.js`,
and how modules are loaded/wired. READ-ONLY research; no code changed.

---

## 1. Current state (with file:line refs)

### 1.1 Shell & module loading
- The app is two static HTML surfaces (`index.html` landing, `app.html` app) over a shared
  design system and one identity primitive (EVM signature → deterministic Nostr npub).
- `app.html` loads **24 CSS files** in `<head>` (`app.html:15-38`) and **~17 ES modules** as
  `<script type="module">` near the end of `<body>` (`app.html:39, 706-724`). `ui.js` is loaded
  early in `<head>` (`app.html:39`); everything else loads after the markup.
- Module load order is **declaration order in the HTML**, but actual init order is governed by
  each module self-mounting at evaluation time. There is no central bootstrap — every module is
  its own entry point and pokes `window.LZ.*` (`app.js:1008`, `nostr.js:323`, `governance.js:1115`,
  `communities.js:735`, `trade.js:1211`, `coin-page.js:636`, `motion.js:116`, `risk-watch.js:35`,
  `community-add.js:179`, `assistant.js:369/1082`). `ui.js` also exposes `window.LZUI` (`ui.js:554`).
- Cache-busting is a hand-maintained `?v=3` query string on every asset URL (`app.html:15-724`).
- A vendored, non-module global script (`lightweight-charts`) loads before the modules
  (`app.html:706`).
- An inline IIFE hides the preloader on `load` (with a 2.5s hard fallback) (`app.html:51-58`).

### 1.2 Router (hash-based)
- Routes are a flat array `ROUTES` (`app.js:25`); view elements are resolved once into a `views`
  map by `data-view` (`app.js:26`). `getRoute()`/`getRouteParam()` parse `#/seg1/seg2`
  (`app.js:53-62`).
- `setActive(route)` toggles `.active` on each view, runs the per-route `ONROUTE[route]` hook,
  updates nav link state, moves the sliding nav pill, updates the breadcrumb + `document.title`,
  and dispatches a `lz:route` `CustomEvent` (`app.js:63-88`).
- Navigation is driven entirely by `location.hash` + a `hashchange` listener (`app.js:89`),
  with a default of `#/chat` (`app.js:95`). External callers navigate via `window.LZ.navigate()`
  (`app.js:1010-1014`).
- View swaps are wrapped in `withViewTransition()` (`motion.js`), which uses the native
  View Transitions API when present and falls back to a plain call otherwise (`motion.js:withViewTransition`).

### 1.3 State management
- Global app state lives in a single module-scoped object `state = { account, derived, listeners }`
  in `shared.js:24-28`, with a hand-rolled observer (`onChange`/`emit`, `shared.js:30-31`).
- Wallet/identity is persisted to `localStorage` under `cm:addr|npub|priv` (`shared.js:18-22`),
  re-hydrated by `bootstrapWallet()` (`shared.js:91-138`), which also re-attaches `accountsChanged`
  / `chainChanged` provider listeners (`chainChanged` does a full `location.reload()`,
  `shared.js:117`).
- **View-local state is a scatter of module-level `let`s** in `app.js`: chat (`activeConv`,
  `composeLayer`, `app.js:194-195`), wallet (`walletTokens`, `walletLoading`, `ethPrice`,
  `walletRendered`, `app.js:309-320`), markets (`marketsRows`, `marketsLoaded`, `marketsDemo`,
  `marketsView`, `app.js:507-535`), network stream (`stream`, `streamPaused`, `streamRendered`,
  `app.js:731-746`). No single source of truth; render functions read these globals directly.

### 1.4 Per-view rendering & data
- Each view has a render function that builds HTML strings and assigns `innerHTML`
  (chat `app.js:197-262`, wallet `app.js:423-473`, markets `app.js:590-630`, network `app.js:734-745`).
- Real data: wallet reads on-chain balances via Blockscout v2 with an RPC fallback
  (`app.js:322-392`); markets pull CoinGecko with a static `DEMO_MARKETS` fallback on failure
  (`app.js:525-588`). Both degrade gracefully to honest empty/demo states using
  `skeleton()`/`emptyState()` from `ui.js`.
- Chat (`CONVS`/`THREADS`, `app.js:165-292`) and network stream (`app.js:712-781`) are
  **fully mock/simulated** with `setInterval` loops and random replies.

### 1.5 ui.js / shared.js / pillars.js / shader.js
- `ui.js` is a dependency-free primitive kit: `CustomSelect` (accessible combobox over a hidden
  native `<select>`, `ui.js:278-495`), `coinAvatar`/`coinAvatarHTML` (deterministic brand avatars,
  `ui.js:188-231`), `magnetic`, `initButtonFX`, `skeleton`, `emptyState`, `fuzzyScore`, `escapeHtml`.
  It self-inits ripple FX and publishes `window.LZUI` (`ui.js:553-554`).
- `shared.js` is the wallet/Nostr/util core: lazy CDN import of `@noble/secp256k1`, `@noble/hashes`,
  `@scure/base` behind `awaitCrypto()` (`shared.js:5-44`), `deriveNostr()` (the signing-format-
  sensitive derivation, `shared.js:67-89`), toast, number formatters, clipboard.
- `pillars.js` drives the **Recovery** tab only — a self-contained mock state machine (guardians,
  threshold stepper, drill animation, activity feed). It self-inits at module load (`pillars.js:502`)
  and re-syncs KPIs on `lz:route === "recovery"` (`pillars.js:504-506`).
- `shader.js` (`mountShader`) is a WebGL neural-mesh background. **It is only used by `landing.js`**
  (`landing.js:1,65`) — it is *not* part of the app shell at all, despite being in scope. It has
  proper teardown (`stop()`), an IntersectionObserver pause, reduced-motion handling and a DPR cap
  (`shader.js:109-172`).

---

## 2. Gaps & weaknesses (honest)

### G1 — One monolithic `app.js` (1044 lines) mixing shell + five feature views
Router, wallet RPC logic, chat mock, markets fetch, network simulation and identity DOM wiring
all live in one file with module-level mutable state. Hard to test, hard to reason about lifecycle,
and the natural place every new feature gets bolted on. (`app.js` whole file.)

### G2 — No lifecycle / teardown for views; timers run forever
`setInterval`s for the network stream (`app.js:749`), recovery feed + last-test clock
(`pillars.js:484,488`), and the clock (`app.js:20`) start at module load and never stop, regardless
of which view is active. The network simulation keeps mutating DOM and re-rendering even when the
user is on Wallet or Trade. Views are shown/hidden via `.active` class only — nothing is mounted/
unmounted, so `onEnter` (`ONROUTE`) has no `onLeave` counterpart. (`app.js:963-971`.)

### G3 — Fragile top-level DOM coupling (no guards)
Many shell elements are grabbed at module top with bare `getElementById` and used unguarded:
`clockEl` (`app.js:15-18`), `crumbHere` (`app.js:78-82`), `connectBtn`/`connLabel`/`connDot`
(`app.js:100-156`), plus `getElementById(...).addEventListener`/`.value` inside render functions
(`app.js:256,259,260,494-501`). If any ID is renamed/removed, the entire shell throws at import
and the app is blank. This silently couples app.js to dozens of IDs in app.html (the HARD-CONSTRAINT
"preserve IDs" exists precisely because of this fragility).

### G4 — `innerHTML` + interpolated data = latent XSS surface
Render functions interpolate values straight into `innerHTML`. Today's data is mostly mock or
numeric, but markets injects `c.symbol`/`c.name` from CoinGecko (`app.js:621-628`) and the coin menu
injects `row.dataset.name` (`app.js:667-671`) without `escapeHtml()` — even though `escapeHtml`
exists in `ui.js`. `pillars.js` correctly escapes (`esc()`); `app.js` does not. Inconsistent.

### G5 — Distributed, implicit module wiring via `window.LZ`
There is no manifest of what's on `window.LZ`. Modules guard defensively
(`window.LZ && window.LZ.nostr`, `communities.js:313`) because load/eval order isn't guaranteed.
`bootCommunities()` exists *only* because `app.js` evaluates before `communities.js` self-mounts,
so init is deferred to `window 'load'` + every route enter and gated by a `commBooted` flag
(`app.js:979-984`). This idempotency dance is a symptom of having no real bootstrap sequencing.
The contract between app.js and feature modules is the untyped `lz:route` event + ad-hoc
`window.LZ.*` methods — easy to break silently.

### G6 — Trade/markets-adjacent views have no `onEnter` parity
`ONROUTE` (`app.js:963-971`) has hooks for chat/communities/wallet/markets/identity/coin, but
**no `trade` or `network` entry** — trade relies entirely on the `lz:route` event picked up inside
`trade.js`/`hl-*.js`. So there are *two* parallel route-reaction mechanisms (the `ONROUTE` table in
app.js and `lz:route` listeners in feature modules), with no single place that describes a view's
full enter behavior.

### G7 — Resilience gaps on RPC/relays
Wallet fetch is solid (Promise.all with per-chain try/catch + RPC fallback, `app.js:384-387`) and
markets has a demo fallback. But: no timeouts/AbortController on any `fetch` (a hung Blockscout or
CoinGecko request leaves the skeleton spinning indefinitely), no retry/backoff, no caching between
route switches (every `wallet`/`markets` enter refetches), and CoinGecko price/global calls can
rate-limit silently (`app.js:379-381,572-583`). Nostr relay resilience lives in `nostr.js`
(out of this scope) but the shell gives it no health signal.

### G8 — Hard-coded cache-busting + huge CSS/JS waterfall
`?v=3` is manual on ~45 asset URLs; bumping it is error-prone and all-or-nothing (`app.html`).
24 separate CSS files and 17 module scripts mean a large request waterfall with no preload hints
beyond fonts; module dependency graph (`app.js → shared/ui/sigil/motion`) is only discoverable by
reading imports.

### G9 — Documentation drift
`docs/ARCHITECTURE.md` still describes retired routes (`/#/karma`, `/#/doppel`, `/#/vault`,
"Doppelgänger", "Vault") and a `base.js` that no longer matches `ROUTES`
(`app.js:25` = chat/communities/wallet/markets/trade/network/identity/recovery/coin). The console
banner still says `v2.1` (`app.js:1040`). Newcomers will be misled.

### G10 — Minor dead/loose ends
`prefersReduced()` is defined in `app.js:9-10` but the file relies on per-module reduced-motion
checks elsewhere — verify usage. `reflectWalletButton()` calls four `reflect*()` identity functions
on every wallet change (`app.js:117-120`) even when the identity view is not mounted — cheap but
unnecessary work. No retired DM mock found in scope (the chat *is* the mock); the simulated reply
logic (`app.js:279-291`) is intentional demo behavior, not dead code.

---

## 3. Prioritized improvements

### P0 — High value, low risk, respects all hard constraints

**P0-1. Introduce a tiny view-lifecycle registry (mount/unmount) without changing routing semantics.**
- *What*: Extend the `ONROUTE` table into a `VIEWS` registry of `{ onEnter, onLeave }`. In
  `setActive`, call the previous route's `onLeave` before activating the next. Keep `lz:route` for
  external modules (back-compat).
- *How*: New file `assets/js/router.js` exporting `registerView(route, {onEnter,onLeave})`,
  `navigate`, `currentRoute`, `getRouteParam`; app.js imports it and registers its views. Move the
  network-stream interval and recovery timers behind `onEnter`/`onLeave` so they pause off-view.
- *Targets*: `app.js:63-95` (setActive/getRoute), `app.js:749` (stream interval),
  `pillars.js:484-492`. *Effort*: ~0.5–1 day.

**P0-2. Centralize and guard shell DOM access.**
- *What*: Add a small `$(id)` helper that warns once if an expected ID is missing, and make all
  top-level shell handlers no-op safely. Preserves every ID (just stops the app from hard-crashing
  if one is absent).
- *How*: Helper in `shared.js` or a new `dom.js`; replace bare `getElementById(...).x` chains in
  `app.js` shell code with guarded reads.
- *Targets*: `app.js:15-18, 78-82, 100-156, 256-261, 494-501`. *Effort*: ~0.5 day.

**P0-3. Escape interpolated remote data in app.js render paths.**
- *What*: Route CoinGecko/`dataset` strings through the existing `escapeHtml` before `innerHTML`.
- *How*: Import `escapeHtml` from `ui.js` (already exported, `ui.js:548`); wrap `c.symbol`,
  `c.name`, `row.dataset.name` in markets + coin menu.
- *Targets*: `app.js:621-628, 659-671`. *Effort*: ~1 hour.

**P0-4. Add fetch timeouts + light caching.**
- *What*: Wrap network calls in an `AbortController` timeout helper; cache markets + wallet results
  briefly (e.g. 30–60s) so re-entering a view doesn't refetch.
- *How*: A `fetchJSON(url, {timeout})` util in `shared.js`; memo keyed by URL/account with a TTL.
- *Targets*: `app.js:322-392 (wallet), 560-588 (markets)`, `shared.js`. *Effort*: ~0.5 day.

### P1 — Structural, moderate effort

**P1-1. Split `app.js` into shell + per-view modules.**
- *What*: Extract `views/chat.js`, `views/wallet.js`, `views/markets.js`, `views/network.js`,
  `views/identity.js`; `app.js` becomes only shell + router wiring + `window.LZ` surface.
- *How*: Each view exports `{ mount, onEnter, onLeave, render }` and registers via P0-1's registry.
  Keep all element IDs and `window.LZ` API identical.
- *Targets*: `app.js` whole. *Effort*: ~2–3 days.

**P1-2. Formalize the `window.LZ` contract + ready signaling.**
- *What*: Document the namespace and add an `LZ.ready` promise / `lz:ready` event so modules stop
  guarding with `window.LZ && window.LZ.x`. Replace the `bootCommunities()` idempotency hack with a
  clean "register + boot when ready" pattern.
- *How*: A small `lz-bus.js` that owns `window.LZ`, exposes `LZ.on`, `LZ.ready`, and a typed-ish
  JSDoc surface. `communities.js` registers an init that the bus calls once.
- *Targets*: `app.js:979-984, 1008-1035`, all `window.LZ` self-mounts. *Effort*: ~1–1.5 days.

**P1-3. Unify route reactions.**
- *What*: Eliminate the dual mechanism (ONROUTE table vs `lz:route` listeners). Either give every
  view an `onEnter` in the registry (incl. trade/network) or have the registry *emit* `lz:route`
  as the single channel. Pick one direction.
- *Targets*: `app.js:963-971`, `trade.js:1189`, `hl-*.js`, `pillars.js:504`. *Effort*: ~1 day.

### P2 — Polish / longer horizon

**P2-1. Automate cache-busting.** Replace manual `?v=3` with a content-hash injected by a tiny
prebuild *script that emits static HTML* (still no bundler/runtime). Or adopt an import-map +
versioned dir. *Targets*: `app.html`. *Effort*: ~0.5 day.

**P2-2. Reduce request waterfall.** Add `<link rel="modulepreload">` for `shared.js`/`ui.js`,
consider concatenating the 24 CSS into a few logical bundles via the same prebuild step.
*Targets*: `app.html:15-39`. *Effort*: ~0.5 day.

**P2-3. Refresh `docs/ARCHITECTURE.md`** to match real `ROUTES`, drop Karma/Doppel/Vault, fix the
`v2.1` banner string (`app.js:1040`). *Effort*: ~1 hour.

**P2-4. Optional: a 3KB reactive `store`** to replace the scattered `let`s + `onChange` set, giving
views derived/subscribed state instead of reading globals. Only worth it after P1-1.
*Effort*: ~1–2 days.

---

## 4. External best practices worth adopting (no build step)

- **Import maps** (`<script type="importmap">`) to pin esm.sh deps centrally and version them in one
  place — removes per-file CDN URLs/versions from `shared.js:9-11` and enables `modulepreload`.
- **`modulepreload`** for the critical module graph (shared/ui) to flatten the discovery waterfall.
- **View Transitions API** is already used (`motion.js`); pair it with per-view `::view-transition`
  named elements for cheaper, more deliberate cross-fades.
- **AbortController + `Promise.race` timeouts** as the standard pattern for all browser `fetch`
  to public RPC/relays — the single biggest resilience win for a keyless dApp.
- **A minimal "islands"/registry pattern** (mount/unmount per route) — the de-facto way to get
  framework-like lifecycle in vanilla ESM without adopting a framework.
- **`stale-while-revalidate` caching** in-memory (and optionally a Service Worker for the static
  shell) so route switches feel instant and survive flaky relays.
- **HTML escaping discipline**: a single `html` tagged-template helper that auto-escapes
  interpolations, eliminating the manual `escapeHtml` call sites entirely.

---

## 5. FILE OWNERSHIP (CREATE phase)

### Files I would CREATE (architecture-owned, low conflict)
- `assets/js/router.js` — view registry + mount/unmount lifecycle (P0-1, P1-3).
- `assets/js/lz-bus.js` — owns `window.LZ`, `LZ.ready`/`lz:ready`, documented surface (P1-2).
- `assets/js/dom.js` — guarded `$()` / `$$()` helpers + `html` escaping template (P0-2, P0-3).
- `assets/js/views/chat.js`, `views/wallet.js`, `views/markets.js`, `views/network.js`,
  `views/identity.js` — extracted from `app.js` (P1-1).
- `assets/js/net.js` — `fetchJSON` with timeout + SWR cache (P0-4).
- (docs) `docs/ARCHITECTURE.md` rewrite (P2-3) — owned, but coordinate since other research streams
  may also touch docs.

### SHARED files I would EDIT (⚠ coordinate — high contention)
- ⚠ **`app.html`** — script/link tags for new modules, `modulepreload`, importmap, cache-busting
  (P0-1, P1-1, P2-1, P2-2). *Many streams touch this.*
- ⚠ **`app.js`** — becomes the shell; router/lifecycle wiring, escaping, guarded DOM, `window.LZ`
  surface. *Heaviest contention file in the repo.*
- ⚠ **`assets/js/shared.js`** — add `fetchJSON`/cache helpers, possibly guarded-DOM helper home
  (P0-2, P0-4). Touches wallet/Nostr core — coordinate with identity/Nostr stream.
- ⚠ **`assets/js/ui.js`** — likely only ADD an exported `html` template helper; otherwise leave the
  `coinAvatar`/`CustomSelect` public contracts untouched.
- ⚠ **`assets/js/pillars.js`** — wire recovery timers into `onEnter`/`onLeave` (P0-1).
- `assets/js/motion.js` — read-only dependency (`withViewTransition`); no edits expected.
- `assets/js/shader.js` — **out of practical scope**: landing-only, already well-built; no edits.
- **Do NOT touch** without cross-stream sign-off: `base.css`, `glass.css` (design tokens),
  `nostr.js` derivation, Hyperliquid signing in `trade.js`/`hyperliquid.js`.

### Hard-constraint guardrails respected
All proposals preserve element IDs, `data-view`/`data-route` attrs, the `window.LZ` API surface,
the Nostr derivation (`shared.js:67-89`), and the Hyperliquid signing format (untouched —
out of scope). Routing semantics (hash + `lz:route` event) stay backward-compatible.
