# Living Identity — v0.3 Graphics Overhaul (A + C)

**Date:** 2026-06-06
**Goal:** Raise the app's visual quality from a self-rated 5/10 toward 9/10 with
*innovative, Apple-tier* design — without breaking any working functionality.
**Direction approved by Elio:** A (signature concept) + C (motion as connective tissue).

## Why

The current UI is coherent and "techy" but static: cards on black, no motion as
narrative, no signature "wow" moment. The weakest spot is the **Identity** view,
whose central panel renders as a raw monospace text blob (`.mb-flow` filled by
`setMB()`), making the flagship "derive your identity" moment look unfinished.

The leap to Apple-tier comes from three things this app lacks: **motion as
storytelling, spatial depth, and one signature artifact.**

## Non-negotiable constraints

- **No build step.** Plain HTML/CSS/ESM only.
- **Zero new runtime dependencies.** Use native WebGL/Canvas and the existing
  `assets/js/shader.js`.
- **Preserve all element IDs** (`deriveBtn`, `npubOut`, `idNpub`, `hashOut`,
  `resetBtn`, copy targets), `data-view` / `data-route` attributes, and `window.LZ`.
- **Never break** Hyperliquid order signing, Nostr derivation (`deriveNostr()` →
  `state.derived = {priv, npub}`), or copilot tool use.
- Honor `prefers-reduced-motion` and `prefers-reduced-transparency` everywhere.
- Respect existing perf guardrails (fps caps, `contain:paint`, pause on
  `document.hidden`). New CSS lives in isolated scoped files following the
  established `*-pro.css` pattern; new JS in isolated ESM modules.

## Components

### 1. The Sigil — generative identity artifact

A deterministic generative artwork seeded by the user's `npub`. Same wallet →
same sigil, forever. This is the visual face of "one you, every chain."

- **New file `assets/js/sigil.js`**, ESM module exporting:
  - `mountSigil(canvas, npub, opts?)` → starts a WebGL flow-field/aurora render
    seeded by a hash of `npub`; returns `{ stop() }`. Built on the same WebGL
    setup style as `shader.js`. Seed derives: hue/secondary-hue, current density,
    rotation, flow signature.
  - `sigilDataURL(npub, size)` → static canvas-2D render of the same seed for use
    as a small avatar (header, lists). No WebGL required.
  - `seedFromNpub(npub)` → pure function: npub string → numeric seed params
    `{h1, h2, density, rot, warp}`. **Unit-testable in isolation (TDD).**
- **Fallback:** if WebGL is unavailable OR `prefers-reduced-motion`, render the
  static canvas-2D sigil (still deterministic, still beautiful, no animation).
- **New file `assets/css/sigil.css`** for sigil container framing/glow.

**What it does / how to use / depends on:** Renders a unique living artwork from
an npub. Consumers call `mountSigil` (animated, large) or `sigilDataURL` (static,
small). Depends only on the npub string and a `<canvas>`.

### 2. Identity view — cinematic 3-act sequence

Replace the `.mb-flow` monospace blob with a vertical cinematic timeline. The
existing derivation logic and element IDs are reused unchanged; only presentation
and animation change.

- **Act 1 — Connect:** wallet card lights up on connected state.
- **Act 2 — Sign:** `deriveBtn` (ID preserved) triggers a "signing" animation —
  hash characters streaming, glass pulse — while `deriveNostr()` runs.
- **Act 3 — Born:** the Sigil materializes (spring + glow); npub / keys
  (`npubOut`, `idNpub`, `hashOut`) appear in clean glass cards beside it. State is
  driven by the same `state.derived` flags already in `app.js`.
- Markup lives in `app.html` under `data-view="identity"`; styles extend
  `identity`-scoped CSS. The `setMB()` text-flow function is retired (or reduced
  to an a11y-only live-region announcer).

### 3. Motion system — the connective tissue (C)

A small, coherent motion layer applied app-wide.

- **New file `assets/js/motion.js`** — ESM, self-mounting helpers:
  - Spring hover/lift on `[data-motion="lift"]` (cards, buttons).
  - Light magnetic effect on `[data-motion="magnet"]` (primary buttons).
  - `tweenNumber(el, from, to)` count-up for KPI values (Recovery / Network /
    Trade). **Pure tween core unit-testable.**
  - `revealOnEnter()` via IntersectionObserver with stagger for cards.
  - View Transitions API wrapper around route changes in `app.js`
    (`document.startViewTransition` if present; no-op fallback otherwise).
- **New file `assets/css/motion.css`** — easing tokens (physical cubic-beziers),
  lift/reveal/transition keyframes, all gated behind `prefers-reduced-motion`.
- Wiring: add `data-motion` attributes to existing elements; call the route
  transition wrapper at the existing route-switch point in `app.js`.

### 4. Sigil as avatar

Reuse the Sigil as the user's avatar across the app once derived:
- Top-bar identity indicator, Recovery "you" context, Chat "you" bubbles avatar.
- Uses `sigilDataURL(npub, size)`; falls back to current placeholder when not
  yet derived.

## Data flow

`deriveNostr()` (unchanged) → `state.derived.npub` → `seedFromNpub(npub)` →
`mountSigil` (Identity hero) and `sigilDataURL` (avatars). Route changes in
`app.js` pass through the View Transitions wrapper. KPI renders call
`tweenNumber` instead of writing values directly.

## Error handling

- No WebGL / context loss → static canvas-2D sigil, log once, no throw.
- `npub` missing/invalid → avatars show the existing placeholder; Identity stays
  in Act 1/2.
- View Transitions / IntersectionObserver absent → graceful no-op, content still
  renders.
- Reduced motion / transparency → static, solid fallbacks throughout.

## Testing

- **Unit (Node, TDD):** `seedFromNpub` (determinism, distribution, valid ranges),
  `tweenNumber` core (start/end/clamp/easing values). Tests in the job tmp dir,
  following the existing risk.js test pattern.
- **Visual (headless Chromium):** before/after screenshots of Identity (all 3
  acts), and each touched section, at 1440×900. Verify the Sigil is deterministic
  (same npub → identical render).
- **Integrity:** `node --check` on every changed JS; HL signing test still
  passes; no duplicate element IDs; all assets 200; confirm `deriveBtn` /
  `npubOut` / derivation still function end-to-end (keyless path).
- **Perf:** Trade and Identity at 4× CPU throttle hold the existing budget
  (p50 ≈ 16–17ms, no long-task regressions); sigil WebGL fps-capped, paused on
  `document.hidden`.

## Scope & sequence (incremental, screenshot-verified each step)

1. **Sigil engine** (`sigil.js` + tests + `sigil.css`) — unlocks everything.
2. **Identity cinematic** — the wow + repairs the weakest view.
3. **Motion system** (`motion.js` + `motion.css`) — app-wide uplift.
4. **Sigil avatars** — header / Recovery / Chat.
5. **Polish + perf pass** — final verification.

## Out of scope (YAGNI)

- Direction B (editorial product-page rebuild of landing).
- The keyed-LLM Risk Copilot end-to-end test (separate track, needs API key).
- Any change to trading/signing logic, market data, or copilot tool schemas.
