# 04 · Motion & Interaction Design — Research (READ-ONLY)

Scope: `motion.js`, `motion.css`, `anima.js`, `anima.css` + how transitions and
micro-interactions are applied across the dApp (app.html) and landing (index.html).
Goal: make the app feel alive and Apple-tier through motion as connective tissue,
at 60fps, GPU-friendly, reduced-motion-safe everywhere.

---

## 1. Current motion system

### Core motion layer — `assets/js/motion.js`
- Pure, Node-testable helpers: `lerp` (L15), `easeOutCubic` (L16), `tweenValueAt` (L19-23).
- `tweenNumber(el, from, to, opts)` — count-up KPI animation, reduced-motion jumps to target (L38-51).
- `withViewTransition(apply)` — wraps a DOM mutation in `document.startViewTransition`, graceful fallback, never throws (L58-63).
- `initMagnet(root)` — pointer-follow on `[data-motion="magnet"]`, fine-pointer + motion-on only, STR 0.28 / MAX 6px (L67-83).
- `initReveal(root)` — IntersectionObserver stagger-reveal of `[data-reveal]`, adds `.reveal-in`, delay `(i%6)*55ms`, threshold 0.08 (L87-105).
- Self-mount (L108-118): adds `.motion-ready` to `<html>`, boots `initMagnet`+`initReveal` once on DOMContentLoaded, exposes `window.LZ.motion`.
- Loaded into app.html transitively: app.html has **no** `<script motion.js>`, but `app.js` does `import { withViewTransition } from "./motion.js"` (app.js:7) and app.js is `type=module` (app.html:707), so the module + self-mount run.

### Core motion CSS — `assets/css/motion.css`
- View-transition keyframes `lz-vt-in` (fade+10px rise, .36s) / `lz-vt-out` (fade, .22s) on `::view-transition-new/old(root)` (L8-12).
- Micro-interactions gated on `.motion-ready` + `@media (hover:hover)`: `[data-motion="lift"]` / `.id-row` hover translateY(-3px)+shadow (L15-24); `.btn:active` scale(.97) press (L26-27).
- `[data-reveal]` hidden-state + `.reveal-in` un-hide, delay var `--reveal-delay` (L31-39).
- Reduced-motion kills view-transition anims (L41-44).

### Landing motion — `assets/js/anima.js` + `assets/css/anima.css`
- anima.js (index.html:599): IntersectionObserver at threshold 0.3 adds `.in` to `.anima-manifest/.pillars [data-reveal]` (L10-22); pillar breath phase-offset stagger (L26-32); scroll parallax on `.par`/`.am-quote` via rAF-throttled `translate3d`, reduced-motion-guarded (L38-70).
- anima.css: pillar `anima-breathe`/`anima-drift`/`anima-trace` keyframes (L28-39); ambient blurred glow `::before` on `.tribe-pulse` 4s loop (L252-269); hover translateY(-3px) on `.pillar` (L244); CTA gap-grow hover (L360-375).

### Route / shell motion — `assets/js/app.js` + `assets/css/app.css`
- Route swap wrapped in `withViewTransition` (app.js:65-68); per-route `ONROUTE[route]?.()` runs inside the same callback (app.js:963-971).
- Sliding nav pill: single `.side-nav-pill` element translated/sized to the active link (app.js:34-51); CSS spring transition (app.css:237-245); re-aligned on resize + `fonts.ready` (app.js:91-94, 989-1001).
- Crumb swap: `.swap` class + reflow restart → `crumbSwap` blur/rise keyframe (app.js:78-83; app.css:267-272).
- `.view{animation:fadeUp .35s}` on every show (app.css:41); nav-icon hover/active micro-motion (app.css:251-258); badge pulse (app.css:259-262).

### Design tokens — `assets/css/base.css`
- Easing curves: `--ease` `.22,.8,.36,1`, `--ease-out` `.16,1,.3,1`, `--ease-in-out`, `--spring` `.34,1.56,.64,1` (L34-37); `--lift-sh`/`--lift-sh-sm` (L52-53).
- Global reduced-motion block (L126, L204) but **scoped** — no universal kill-switch.

### Per-feature animation ecosystem (rich)
~60 `@keyframes` across feature CSS: assistant (copilot in/out, FAB ring/bob, stream shimmer, caret), trade/hl-* (flash up/down, row-in, mid pulse, tape flash), recovery (guardian/panel in, bump), governance (reveal, pulse, shimmer), ui.js (`lzSelIn/Out`, `lzSheetIn/Out`, `lzRowIn`, `lzSheen`, `lzRipple`, skeleton `shimmer`), sigil (spin/scan/breathe), wallet-pro (aura/pulse). Most feature CSS files carry their own reduced-motion guards (22 of 24 CSS files).

---

## 2. Gaps, jank risks, missing states

**Two parallel reveal systems that don't share a contract.**
- motion.js/motion.css use `[data-reveal]` → `.reveal-in`. anima.js + base.css use `[data-reveal]` → `.in`. Base.css L168 defines a *third* `[data-reveal]{opacity:0}` global rule un-hidden by `.in` (not `.reveal-in`, not gated on `.motion-ready`). On the landing, anima.js handles `.in`; in the dApp, motion.js handles `.reveal-in`. The base.css `.in` rule and the motion.css `.reveal-in` rule both target the same attribute with different un-hide classes → fragile and order-dependent. Risk: an element matched by both with only one observer attached stays hidden.

**dApp views have ZERO `[data-reveal]`** (app.html count = 0; all 28 reveals live in index.html). The entire dApp — chat, communities, wallet, markets, trade, network, identity, recovery, coin — gets no reveal-on-scroll choreography. Content appears flat.

**`tweenNumber` has zero callers.** Exported + on `window.LZ.motion` but never used. Every KPI/balance/PnL across wallet, markets, trade, recovery ledger, identity snaps in with no count-up — the single biggest missed "alive" signal in a finance app.

**`initReveal`/`initMagnet` boot once and never re-run.** No call site outside motion.js (grep confirms). The dApp re-renders lists and swaps views constantly (`ONROUTE`, `renderChatList`, `fetchMarkets`, `loadWallet`, coin page). Any `[data-reveal]` or `[data-motion="magnet"]` injected after boot is never observed/wired. Reveal/magnet are effectively landing-only.

**Double-animation on route swap.** `.view{animation:fadeUp .35s}` (app.css:41) fires on every `display:none→flex`, *and* `withViewTransition` cross-fades `::view-transition-new(root)` with `lz-vt-in` (also a fade+rise). When VT is supported both run → two overlapping fades/rises = subtle jank/jitter. Per Chrome/MDN guidance, prefer the built-in crossfade and avoid stacking a second keyframe on the same transitioning content.

**`.view` fadeUp is not reduced-motion-guarded.** The app.css reduced-motion block (L374-381) lists nav pill, crumb, hover transforms, deriving anims — but NOT `.view`. So `fadeUp` (opacity+translateY) still plays for reduce users on every route change. motion.css correctly disables the VT anim under reduce, so reduce users get *only* the unguarded fadeUp — inverted from intent.

**Two CSS files have keyframes with no reduced-motion guard:** `anima.css` (infinite `anima-breathe` glow L265 + `pulse` dot L143 on landing) and `wallet-actions.css` (`waSpin` spinner L58). Infinite ambient motion with no `prefers-reduced-motion` escape is a WCAG 2.3.3 concern.

**No gesture support.** Bottom sheet (`ui.js` `as-sheet`, `lzSheetIn/Out` L116-118) animates in/out but has **no drag-to-dismiss** (grep: no touchmove/deltaY/drag in ui.js). No swipe-between-routes, no pull/rubber-band. On touch the app feels like a website, not an app.

**No shared loading choreography.** Skeleton shimmer exists (ui.js `skeleton`, base `shimmer`) but is per-feature; route enter shows no skeleton-to-content handoff. markets/coin fetch with no enter transition tied to the route VT.

**Magnet strength asymmetry.** `initMagnet` only resets on `pointerleave`/`pointerup` — fast pointer exits that don't fire `pointerleave` (e.g. element removed mid-hover during re-render) can leave a stuck `transform`. Re-render also drops the `__magnet` guard with the node, fine, but un-reset transforms on reused nodes are possible.

---

## 3. Prioritized improvements

### P0 — correctness & "alive" baseline (low effort, high payoff)

- **P0.1 Unify the reveal contract.** Pick `.reveal-in` (motion.js) as canonical; make anima.js add `.reveal-in` too, and delete/redirect the base.css L168 `.in` rule so there's one hidden-state + one un-hide class, all gated on `.motion-ready`. Target: no element can be stranded hidden. Effort: S.
- **P0.2 Stop the double route animation.** Remove `animation:fadeUp` from `.view` (app.css:41) and let `withViewTransition` own the route motion; OR drop the VT rise and keep fadeUp, but not both. Target: single, smooth ~.32s crossfade. Effort: S.
- **P0.3 Guard `.view` + anima + wallet-actions under reduced-motion.** Add `.view{animation:none}` to app.css reduced-motion block; add a `@media (prefers-reduced-motion:reduce)` to anima.css (kill breathe/glow/pulse) and wallet-actions.css (keep spinner but consider). Effort: S.
- **P0.4 Wire `tweenNumber` into KPIs.** Call `window.LZ.motion.tweenNumber` on balance/PnL/market-cap/recovery-ledger numbers when they first render or change, with money formatters. This is the single highest-impact "feels alive" change. Target: every headline number counts up once, snaps under reduce. Effort: M (touches feature render fns, not motion.js).

### P1 — connective tissue across the dApp

- **P1.1 Re-run reveal/magnet after render & route enter.** Call `initReveal()`/`initMagnet()` at the end of `setActive` (inside or after the VT callback) and after list re-renders (chat, markets, communities, coin). Make `initReveal` idempotent (it already skips `.reveal-in`). Effort: M (shared `app.js` + per-feature hook points).
- **P1.2 Add `[data-reveal]` to dApp view sections.** Tag each `.view` header + top-level cards/rows so route entry stagger-reveals content. Pair with P1.1. Target: every route entrance has a 1-2 frame leading stagger. Effort: M.
- **P1.3 List enter/exit.** Standardize `lzRowIn` (ui.css L129) as the canonical list-item enter; apply to chat list, markets rows, tx rows, recovery feed, governance. Add stagger via `--reveal-delay`. Effort: M.
- **P1.4 Press feedback everywhere.** `.btn:active{scale(.97)}` exists (motion.css L27) but only `.btn`. Extend tactile press to nav items, cards, list rows, chips, sheet handles — a consistent ~.95-.97 active scale on the spring curve. Effort: S.

### P2 — Apple-tier polish

- **P2.1 Drag-to-dismiss bottom sheet.** Add pointer-drag with rubber-band + velocity-throw dismiss to `ui.js` sheet (Vaul model: ~500ms iOS easing, slight end-bounce). Target: native-feeling sheets on touch. Effort: L.
- **P2.2 Shared-element transitions.** Use `view-transition-name` on the sigil / identity avatar / coin row → coin page hero so navigating morphs the element instead of crossfading. Effort: M-L.
- **P2.3 Loading choreography.** Tie skeleton→content into the route VT so markets/coin fetch resolves with a single coordinated reveal rather than a pop. Effort: M.
- **P2.4 Swipe-between-routes on touch** (optional, mind hash router). Effort: L.

All P0/P1/P2 must respect `prefers-reduced-motion` and stay on transform/opacity (GPU compositor) to hold 60fps — avoid animating width/height/top/left and watch the nav-pill `width`/`height` transition (app.css:241-243) which can trigger layout; prefer `scale` where possible.

---

## 4. External best practices

- **View Transitions:** prefer the built-in crossfade; use `view-transition-name` to peel specific elements into their own transition groups rather than stacking a second keyframe on `::view-transition-*(root)`. Mutate DOM only inside the `startViewTransition` callback; use `contain: paint/layout` to avoid snapshot glitches. (MDN, Chrome for Developers, DebugBear.)
- **Drawers/sheets (Family/Vaul):** Vaul replicates the iOS Sheet — iOS easing curve + ~500ms duration, drag-to-dismiss with velocity, slight end-bounce so dragging "feels like force." Spring at the tail makes dismissal natural. (emilkowal.ski, Vaul, animations.dev.)
- **Spring vs ease:** springs for interactive/gesture-driven motion (the existing `--spring` token is well-chosen for press/pill); ease-out for entrances. (animations.dev.)
- **Reduced motion:** WCAG 2.3.3 — every infinite/ambient loop needs a `prefers-reduced-motion` escape (anima.css breathe/glow currently lacks one).

Sources:
- https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API
- https://developer.chrome.com/docs/web-platform/view-transitions
- https://www.debugbear.com/blog/view-transitions-spa-without-framework
- https://emilkowal.ski/ui/building-a-drawer-component
- https://github.com/emilkowalski/vaul
- https://animations.dev/learn/animation-theory/spring-animations

---

## 5. FILE OWNERSHIP (for CREATE phase)

**Owned (motion-domain, primary editor):**
- `assets/js/motion.js` — *SHARED, FLAG* (see below): tweenNumber wiring helpers, idempotent re-run guards, magnet reset hardening.
- `assets/css/motion.css` — *SHARED, FLAG*: reveal contract, press feedback extension, VT tuning.
- `assets/js/anima.js` — reveal-class unification, reduced-motion.
- `assets/css/anima.css` — add reduced-motion guard for breathe/glow/pulse.

**SHARED — coordinate before editing (other swarm agents likely touch these):**
- `assets/js/app.js` — route VT, `setActive`, `ONROUTE`, nav pill. Reveal/magnet re-run + tweenNumber calls land here. **High contention.**
- `assets/css/app.css` — `.view` fadeUp, reduced-motion block, nav pill. **High contention.**
- `assets/css/base.css` — easing tokens + the conflicting `[data-reveal]` L168 rule. Token owner; coordinate.
- `assets/js/ui.js` / `assets/css/ui.css` — bottom-sheet drag-to-dismiss, `lzRowIn` list-enter standardization. **Shared with UI agent.**
- `assets/css/wallet-actions.css` — reduced-motion guard (small, likely owned by wallet agent).

**Constraints honored:** no element-ID / `data-view` / `data-route` / `window.LZ` API changes; signing & Nostr untouched; all new motion gated on `.motion-ready` + `prefers-reduced-motion`; transform/opacity only.
