# LZidentity v0.5 — Master Plan (swarm-integrated)

Synthesis of the 8 parallel Opus research reports (01–08). Workflow per Elio:
**ricerca → CREA → FIXXA → AUDITA.** Research is done; this is the build plan.

Released baseline: v0.4 (`github.com/elioaalav-code/lzidentity-definitivo-v0.4`).
Target tag: **v0.5 "Refined"**. All work in worktree, no commits until integration + verify.

## Cross-cutting signal (multiple agents converged)
- **XSS** flagged independently by Architecture, Widgets, DAO-social, and Security:
  remote/relay/CoinGecko data hits `innerHTML` un-escaped in `app.js` (coin markets
  ~621-628/667-671) and the **mock chat** (app.js:243). `escapeHtml` already exists in
  `ui.js` but is re-implemented 4× and skipped in app.js. → single fix lane.
- **app.js / app.html are the contention center** — 6 of 8 lanes need them. → the
  coordinator (me) owns all shared-file edits; feature lanes work only on owned files.
- **Duplication everywhere** — escapeHtml ×4, modals ×3, loading ×4, price formatters ×5,
  reveal systems ×2, green/red token systems ×2. → consolidate in the FOUNDATION pass.

## Build order

### PHASE A — FOUNDATION (coordinator, serial; shared files)
The backbone every feature lane depends on. Done first, verified, then unlocks parallel lanes.
1. **Design tokens** (base.css, additive): fluid type scale `--fs-*`; `--on-accent`;
   promote+unify `--long/--short` into base (delete from trade.css after); fix
   `--text-mute` to ≥4.5:1 (WCAG AA); contextual `--focus-ring`; `--r-xs`.
2. **Shared UI primitives** (ui.js/ui.css, additive `window.LZUI`): modal-with-focus-trap
   (+ background `inert`, focus restore); `emptyState` error variant; `html` tag helper;
   keep the single `.toast`. Collapse the 4 local `esc` into `LZUI.escapeHtml`.
3. **Architecture spine**: view lifecycle (`onLeave` + registry so intervals pause on
   inactive route); guarded DOM access; `net.js` (fetch timeout/AbortController + tiny
   cache + retry); **escape all remote data** in app.js.
4. **Motion correctness** (motion.js/css, app.css): unify reveal contract (`.reveal-in`
   vs `.in`), kill double route-anim (`.view{fadeUp}` + View-Transition), add the missing
   reduced-motion guards, wire `tweenNumber` into balances/PnL/KPIs.
5. **Security P0**: stop persisting Nostr secret (`cm:priv`) — in-memory + re-derive,
   `deriveNostr()` output byte-identical; add **CSP** meta to app.html/index.html; SRI/
   vendored crypto pin for @noble/@scure.

### PHASE B — FEATURE LANES (parallel Opus agents; owned files only)
Run after Phase A lands. Each edits only its own files; hands me the app.js/app.html
deltas for integration.
- **Identity/Sigil** — `exportSigil()` (PNG download / `navigator.share` / copy, npub
  footer); richer "born" moment (bloom + spring + caption, reduced-motion safe);
  forming-from-noise during signing; expand traits (more DOF, palette families,
  human-readable fingerprint + aria); add `tests/sigil.test.mjs`.
- **DAO Social** — publish kind-40 channel roots so NIP-28 channels work; **real Nostr
  DMs** to replace the mock chat (NIP-04 first cut → NIP-17/44); kind-0/NIP-05 profiles +
  npub display; NIP-10 reply threading; post-vote tally refresh + "you voted" badge;
  verify/fill or cleanly hide LayerZero.
- **Trading** — new `fmt-num.js` (kill the 5 divergent formatters); connected/wrong-network
  banner (the testnet-zero bug class); honest quick-send (no fake toast); trade-region
  retry states; (P1) WebSocket account/mark streaming, book grouping, slippage+TIF.
- **Widgets/Design adoption** — upgrade raw `<select>`→`CustomSelect`; route all modules
  through shared modal/empty/loading/badge primitives; literal→token CSS sweep.

### PHASE C — FIX (coordinator)
Integrate all lane deltas into app.js/app.html; full-route sweep (all 9 routes render
in-viewport, no console errors, no dup IDs); `node --check`; unit tests
(seedFromNpub, motion, sigil); **HL signing 336/336 must stay green**; verify window.LZ
contracts intact.

### PHASE D — AUDIT (reviewer agent)
Independent Opus reviewer: security re-check (XSS/CSP/key handling), accessibility (WCAG
AA contrast/focus/ARIA), perf (eager-load, timer gating), and regression vs v0.4. Produces
`docs/superpowers/research/09-audit.md`. Fix blockers before any merge/push.

## Scope decision
CREATE targets **all P0 + high-ROI P1**. P2 items (zaps, WebGL sigil finish, margin-mode,
incremental DOM, route-level lazy-load) → backlog unless time allows.

## Preserve (hard constraints, every phase)
Element IDs · `data-view`/`data-route` · `window.LZ.*` / `window.LZUI.*` · HL signing
format (336 assertions) · `deriveNostr()` byte-identical output · obsidian-glass language.
