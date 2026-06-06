# 02 — Design System & Visual Language (RESEARCH)

Scope: the shared visual language — tokens (color, type, spacing, radii, shadow,
blur, easing), cross-view consistency, the obsidian-glass aesthetic, typography
hierarchy, contrast/WCAG, responsive behavior, and overall "Apple-tier" cohesion.

Primary files: `assets/css/base.css`, `glass.css`, `app.css`, `ui.css`,
`anima.css`. Cross-referenced every view CSS for divergence.

CSS load order (`app.html`): base → ui → app → anima → trade → assistant → risk →
recovery → wallet-actions → wallet-pro → coin-page(+pro) → chat-charts →
hl-markets → markets-pro → hl-depth → hl-portfolio → hl-orders-pro → **glass** →
sigil → motion → communities → governance → community-add. `glass.css` loads near
last by design (wins the cascade for surface treatment); `motion.css` is the new
v0.3 connective layer.

---

## 1. Current token / visual state

The system is genuinely strong and unusually coherent for a no-build SPA. There
is a real, documented design language ("obsidian-glass", DESIGN_BRIEF.md) and a
mostly-centralized token layer.

**Color tokens** — `base.css:1-30`
- Canvas ramp: `--bg #050505 → --bg-2 → --surface → --surface-2 → --elevated`
  (`base.css:2-6`) — clean 5-step near-black ladder.
- Text ramp: `--text #f6f6f7 / --text-dim #a0a0a8 / --text-mute #6b6b75`
  (`base.css:9-11`).
- Accents: `--accent #b39aff` violet, `--accent-2 #5eead4` teal, `--accent-3
  #ff7a59` warm (`base.css:12-14`). Chain colors `--eth/--arb/--op`
  (`base.css:15-17`). Semantic `--success #86efac / --warn #fde68a / --error
  #fda4af` (`base.css:18-20`).
- Borders: `--border .08 / --border-strong .16 / --hairline .06`
  (`base.css:7-8,48`).

**Glass system** — `base.css:56-71`, applied in `glass.css`
- A well-engineered, single-source-of-truth liquid-glass recipe: `--glass-soft/
  /glass/strong-bg` translucency tiers (`base.css:57-59`), a reusable
  `--glass-sheen` (top-left light + top band, `base.css:61-63`), and a layered
  bevel stack `--glass-hl / rim / bevel / depth / drop` composed into
  `--glass-stack` (`base.css:64-71`).
- Performance-aware strategy: **blur** big containers, **flat** translucent for
  live/repeated rows (`glass.css:80-114`), `contain:paint` isolation
  (`base.css:107`, `glass.css:87`). This is the standout craft of the codebase.
- `.lz-glass*` primitives in `base.css:94-118` mirror the same recipe for
  direct use.

**Motion tokens** — `base.css:33-40`
- Easings `--ease / --ease-out / --ease-in-out / --spring`; durations `--t-fast
  .15s / --t .28s / --t-slow .6s`. Used consistently in ui.css, app.css,
  motion.css. `--tribe-pulse 4s` ambient breath in anima.css:24.

**Elevation tokens** — `base.css:42-46,52-55`: `--sh-1/2/3`, `--glow-accent/teal`,
`--lift-sh / lift-sh-sm`, `--ring-accent / ring-teal`.

**Spacing scale** — `base.css:50`: `--s1…--s8` (4/8/12/16/24/32/48/72).

**Radii** — `base.css:26-30`: `--r-sm 8 / --r 14 / --r-lg 20 / --r-xl 28 /
--r-full 999`.

**Type families** — `base.css:23-25`: Geist (sans), Instrument Serif (serif
display), Geist Mono. Display headings weight 300, tight tracking — applied at
`app.css:46` (`.view-header h1` clamp 28→42), `anima.css:81-85`.

**Accessibility scaffolding (good)**: `prefers-reduced-motion` honored broadly
(`base.css:126-128,204-214`, `app.css:374-382`, `ui.css:163-168`,
`glass.css:135-138`, `motion.css`); `prefers-reduced-transparency` fallbacks
(`base.css:121-125`, `glass.css:140-149`); `:focus-visible` ring (`base.css:193`);
skip-link (`base.css:198-200`); `color-scheme:dark` + `select option`
dark fix (`base.css:75,196`).

---

## 2. Gaps & inconsistencies (honest)

**G1 — No type-scale tokens; raw px sprawl (highest-impact gap).**
Font-sizes are hardcoded px everywhere with no `--fs-*` scale. Distribution
across all CSS: 11px ×76, 13px ×59, 10px ×55, 12px ×46, 9px ×32, 14px ×29 —
plus **fractional one-offs**: 10.5px ×19, 9.5px ×12, 12.5px ×8, 13.5px ×7,
11.5px ×6, 8.5px ×4, 7.5px ×2, 7px ×2, 8px ×2. ~30 distinct sizes total. There
is no rhythm; values were eyeballed per view. The DESIGN_BRIEF prescribes a type
system but no tokens enforce it. (`app.css`, `trade.css`, `hl-*` all diverge.)

**G2 — Two parallel green/red semantic systems.**
`base.css:18,20` defines pastel `--success #86efac / --error #fda4af` (used by
wallet/markets/network up-down in `app.css:156-157,183-184,166-167`). Trading
defines saturated `--long #3fb98a / --short #e0556b` in **trade.css:6-9** — but
these are consumed by hl-markets, hl-orders-pro, hl-depth, hl-portfolio,
coin-page(-pro) (7 files). Two problems:
  (a) The same concept "value went up/down" renders in two different greens/reds
  depending on which view you're in — a visible inconsistency.
  (b) `--long/--short` live in trade.css (load #5), **not base.css**. Files that
  consume them rely on the cascade; several also hardcode the literal as a
  fallback or outright (`chat-charts.css:39-40` uses `#3fb98a/#e0556b` directly;
  `coin-page-pro.css:30`, `hl-orders-pro.css:206,483` use `var(--short,#e0556b)`).
  Fragile: any view rendered without trade.css loaded would lose the trading
  palette.

**G3 — Three `:root` blocks; tokens scattered.**
`base.css`, `anima.css:7-26` (`--recovery/--doppel/--soglia` + `--tribe-pulse`),
`trade.css:5-16` (`--long/--short/--card-bg/--card-border/--card-sh`). Trading's
card primitive (`--card-bg/border/sh`, trade.css:13-15) is a *fourth* card
treatment that diverges from both `.card` (`base.css:160`) and the glass cards in
`glass.css:11-32`. So a "card" can look 3+ ways across the app.

**G4 — Radius literals bypass the radii tokens.**
35× `999px`, plus raw `14/12/10/8/6/4/3/2px` literals dominate over `--r-sm/--r/
--r-lg/--r-xl`. `999px` should be `--r-full`; `14px` matches `--r` but is written
literally 16×; small chips/bars use ad-hoc 2/3/4/6px with no `--r-xs` token. The
tokens exist but aren't consistently consumed.

**G5 — Responsive breakpoints are not a system.**
22 distinct `max-width` values: 880(×13), 760(×9), 980(×8), 560(×6), 680(×5),
plus one-offs 640/600/620/580/780/900/1080/1100/480/460/440/420/340/280/160/118.
There's a loose cluster around 880/760/560/980 but no named tier tokens, so each
view picked its own. Maintenance and cross-view layout consistency suffer.

**G6 — Contrast / WCAG risk on muted text.**
`--text-mute #6b6b75` on `--bg #050505` ≈ 4.0:1 — **below WCAG AA 4.5:1 for
normal text**. It's used heavily for mono labels at 9–11px (`.section-label`,
`.kpi .lab`, `.lz-select-group`, many `.lab`/`.sub`), exactly the small sizes
where contrast matters most. `--text-dim #a0a0a8` ≈ 8.6:1 is fine. This is the
one real accessibility defect in an otherwise a11y-conscious system. (Note: tiny
uppercase labels also strain legibility at 8.5–9.5px regardless of contrast.)

**G7 — Glass `brightness()`/`saturate()` is not in `prefers-contrast` /
forced-colors paths.** Reduced-transparency is handled, but there's no
`@media (forced-colors: active)` or `prefers-contrast: more` treatment; on the
glass-on-glass row treatments (`glass.css:101-114`) the effective row contrast is
low and not boosted for users who ask for more contrast.

**G8 — Focus ring color is single-accent only.**
`:focus-visible` is always violet `--accent` (`base.css:193`). On teal/warm and
on the saturated trade red/green surfaces the violet ring can be low-contrast or
off-palette; no contextual ring token despite `--ring-accent/--ring-teal`
existing unused for focus.

**G9 — Selection / on-accent text hardcodes `#0a0a0c`.**
`::selection` and every "text on accent" (buttons, bubbles, chat avatars, unread
badge: `base.css:77,147,153`, `app.css:72,83,97,107`) hardcode `#0a0a0c` rather
than a `--on-accent` token. Fine today, brittle if accent hues change.

---

## 3. Prioritized improvements (P0/P1/P2)

Effort: S < 1h, M a few h, L a day+.

### P0 — correctness / accessibility / token integrity

- **P0.1 Fix muted-text contrast (G6).** Lighten `--text-mute` to ~`#7e7e88`
  (≈4.6:1) or `#86868f` (≈5.2:1, matches Apple's secondary-label feel). One token
  edit in `base.css:11`; cascades everywhere. Verify with a contrast check on
  `--bg`, `--surface`, `--surface-2`. **Target:** `base.css:11`. **Effort: S.**
- **P0.2 Promote `--long/--short` (+soft/line) to base.css and unify the
  up/down semantic (G2).** Move trading red/green tokens into `base.css` `:root`,
  and decide one of: (a) make `--success/--error` *aliases* of the trading hues
  app-wide, or (b) keep pastel for "status" and saturated for "price delta" but
  document the rule and add `--up/--down` aliases so views stop picking ad-hoc.
  Then replace hardcoded `#3fb98a/#e0556b` in `chat-charts.css:39-40` and the
  `var(--x,#hex)` fallbacks with the token. **Target:** `base.css:18-20`,
  `trade.css:6-9` (delete after move), `chat-charts.css:39-40`. **Effort: M.**
- **P0.3 Add `--on-accent` token (G9).** Define `--on-accent:#0a0a0c` in
  `base.css`; swap the literal in the shared primitives (`.btn`, `::selection`).
  **Target:** `base.css`. **Effort: S.**

### P1 — cohesion / "Apple-tier" polish

- **P1.1 Introduce a fluid type scale (G1).** Add `--fs-xs … --fs-3xl` (and a
  couple of mono-label sizes `--fs-label / --fs-label-sm`) to `base.css`, modeled
  on a 1.2 ratio with `clamp()` for the display end. Then migrate `app.css`,
  `ui.css`, `anima.css` to tokens; collapse the ~30 ad-hoc sizes (especially the
  fractional 7.5/8.5/9.5/10.5/12.5/13.5px) onto the scale. Do NOT touch view
  files owned by other lanes in CREATE — only the shared files I own. **Target:**
  `base.css` (new tokens), `app.css`, `ui.css`, `anima.css`. **Effort: L.**
- **P1.2 Consolidate the card primitive (G3).** Make trade's `--card-*`
  (trade.css:13-15) reference the shared glass/`.card` recipe, or document it as
  the canonical "terminal card" and adopt it everywhere a dense data card is
  needed. Goal: a card looks like *one* family. **Target:** `base.css`/`glass.css`
  (define), `trade.css` (align — Trading lane). **Effort: M.**
- **P1.3 Named breakpoint tiers (G5).** Establish 4 canonical tiers (e.g.
  `--bp-sm 560 / --bp-md 760 / --bp-lg 980 / --bp-xl 1100`) documented in
  DESIGN_BRIEF, and standardize the dominant clusters (880→ either 760 or 980).
  CSS custom props can't drive media queries directly, so this is a documented
  convention + a sweep, not a token. **Target:** doc + each view in CREATE.
  **Effort: M.**
- **P1.4 Radius token discipline (G4).** Add `--r-xs:4px` and `--r-2xs:2px`,
  replace `999px`→`--r-full`, `14px`→`--r`, etc. across shared files. **Target:**
  `base.css` (+2 tokens), `app.css`, `ui.css`, `glass.css`. **Effort: M.**
- **P1.5 Contextual focus ring (G8).** Use `--ring-accent` by default but allow
  per-region override (teal in trade/markets, warm on mainnet). Set
  `outline-color` from a `--focus-ring` var that views can rebind. **Target:**
  `base.css:193`. **Effort: S.**

### P2 — refinement

- **P2.1 `@media (prefers-contrast: more)` / `forced-colors` path (G7)** that
  bumps `--border`→`.16`, `--text-mute`→`--text-dim`, and disables the lowest
  glass tiers. **Target:** `base.css`/`glass.css`. **Effort: M.**
- **P2.2 Tabular-figure default for all mono numerics.** trade.css:35-36 already
  scopes `font-variant-numeric:tabular-nums` to trading; promote it to the
  `--mono` usage globally (e.g. a `.num`/`[data-num]` utility or on `.mono`
  contexts) so wallet/markets figures don't jitter. **Effort: S.**
- **P2.3 Elevation usage audit.** `--sh-1/2/3` exist but many panels hand-roll
  shadows; standardize big surfaces on the glass stack and small chips on
  `--sh-1`. **Effort: M.**
- **P2.4 Document the glass decision tree** (when blur vs flat vs `.card`) in
  DESIGN_BRIEF so future views don't reinvent surfaces. **Effort: S.**

---

## 4. External best practices to adopt (keep obsidian-glass identity)

- **Apple HIG / visionOS materials** — the model the glass system already echoes.
  Adopt their *vibrancy + secondary/tertiary label* hierarchy: pair each glass
  tier with a matching text-vibrancy tier so text contrast is guaranteed on
  glass, not eyeballed (addresses G6/G7). Their secondary-label ~`#8e8e93`-on-dark
  is a good `--text-mute` target.
- **Apple's type scale** — fluid, ratio-based (≈1.125–1.2), with semantic names
  (Largutitle/Title/Body/Caption) rather than px. Model for P1.1.
- **Linear** — the brief's stated north star. Best-in-class at: a *small*
  token set rigorously applied; one accent; hairline borders; restrained motion
  with consistent easing/duration tokens (already mirrored here). Their
  discipline of "few sizes, used everywhere" is exactly the fix for G1/G4.
- **Stripe** — semantic color tokens with explicit `on-*` foreground pairs and
  documented contrast ratios; adopt for P0.3/G2. Their dashboard's
  positive/negative financial colors are a *single* system across the product —
  the fix pattern for G2.
- **Rainbow / Phantom (web3)** — saturated, joyful but consistent
  positive/negative and chain-color systems; per-chain accent tokens (this repo
  already has `--eth/--arb/--op` — extend to base/sol consistently, currently
  ad-hoc `#2151f5`/gradient at anima.css:546-547).
- **WCAG 2.2 SC 1.4.3 / 1.4.11** — target ≥4.5:1 body text, ≥3:1 UI components/
  focus indicators; add a `prefers-contrast` path (P2.1). Several tiny uppercase
  mono labels should also bump to ≥10px or increase tracking for legibility.

---

## 5. FILE OWNERSHIP (for CREATE phase)

**Files I would EDIT (design-system lane):**
- `assets/css/base.css` — **SHARED, highest-traffic.** My edits would be the
  token layer only: `:root` additions (type scale `--fs-*`, `--r-xs/--r-2xs`,
  `--on-accent`, promoted `--long/--short/--up/--down`, `--focus-ring`) and token
  *value* tweaks (`--text-mute` lighten @ line 11). I would touch the `:focus-
  visible` rule (line 193), `.btn` on-accent literal (147,153), `::selection`
  (77). **I would NOT restructure components other lanes depend on.**
- `assets/css/glass.css` — **SHARED.** Only: add `prefers-contrast`/forced-colors
  path; radius-token swaps; no change to the blur/flat strategy or selectors
  (other lanes rely on `.kpi/.cp-*/.trade-view *` being styled here).
- `assets/css/ui.css` — **SHARED (primitives).** Migrate font-size/radius literals
  in CustomSelect/avatar/skeleton/empty to the new tokens. No structural change.
- `assets/css/app.css` — **SHARED (app shell + core tabs, owned by "Agent D" in
  the brief).** I'd only sweep font-size/radius/color literals → tokens here in
  coordination; structural layout stays with the shell owner.
- `assets/css/anima.css` — **SHARED.** Token migration of font-sizes/radii;
  `--recovery/--doppel/--soglia` pillar tokens stay (used by recovery lane).
- `docs/DESIGN_BRIEF.md` — add the type scale, breakpoint tiers, glass decision
  tree, and the unified up/down color rule.

**SHARED-FILE conflict flags for the swarm (coordinate before CREATE):**
- `base.css` `:root` — **everyone reads these tokens.** My token *additions* are
  safe/additive; my token *value* changes (`--text-mute`) affect every lane
  visually — needs a heads-up. `--long/--short` promotion touches trade.css
  (Trading lane) which currently *defines* them.
- `trade.css:5-16 :root` — owned by the **Trading lane**; my P0.2/P1.2 would have
  them delete `--long/--short` (moved to base) and align `--card-*`. Must be a
  joint change, not unilateral.
- `glass.css` selectors — span trade/markets/wallet/coin lanes; any selector edit
  risks cross-lane regressions. I'd keep to additive media queries + token swaps.
- `app.css` — the app-shell lane owns structure; I touch only token literals.
- `chat-charts.css:39-40`, `coin-page-pro.css:30`, `hl-orders-pro.css` literals —
  owned by Markets/Coin/Trading lanes; the hardcoded-hex→token swap should be
  done by those lanes once `--long/--short` live in base.css.

**Files I would NOT touch:** all `hl-*`, `markets-pro`, `coin-page*`, `recovery`,
`assistant`, `wallet-*`, `communities`, `governance`, `sigil`, `landing`,
`motion.css` (other lanes), except to hand them the new tokens to consume.
