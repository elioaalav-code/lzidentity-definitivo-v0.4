# 03 — Reusable Widgets & Components (RESEARCH, read-only)

Scope: `ui.js`, `ui.css` (the shared primitive layer) + components scattered across
`governance.js/css`, `communities.js/css`, `community-add.js/css`, `coin-page.js`,
`wallet-actions.js`. Supporting tokens/primitives live in `base.css` and `glass.css`.

CSS load order (from `app.html`): `base.css` → `ui.css` → `app.css` → … → `glass.css`
(last, wins cascade) → `communities.css` → `governance.css` → `community-add.css`.

---

## 1. Component inventory (with file:line refs)

### 1a. The shared primitive layer — `ui.js` / `ui.css` (exposed on `window.LZUI`)

| Primitive | API / class | Source |
|---|---|---|
| `CustomSelect` | accessible combobox over hidden native `<select>`; searchable, groupable, bottom-sheet on phone; full keyboard (Arrow/Home/End/Enter/Esc), ARIA `listbox`/`option`/`combobox`, `aria-activedescendant`, focus restore | `assets/js/ui.js:278-495`; CSS `assets/css/ui.css:51-129`; glass skin `assets/css/glass.css:42-99` |
| `coinAvatar` / `coinAvatarHTML` | deterministic on-brand token avatar (brand map + inline SVG logos + hash-hue fallback); `aria-hidden` | `assets/js/ui.js:188-231`; CSS `assets/css/ui.css:7-49` |
| `fuzzyScore` | subsequence fuzzy match used by CustomSelect search | `assets/js/ui.js:237-254` |
| `magnetic` | opt-in magnetic hover for hero CTAs; reduced-motion safe | `assets/js/ui.js:498-511` |
| `initButtonFX` | delegated press-ripple on `.btn`/`.lz-fx` (sheen is pure CSS) | `assets/js/ui.js:514-528`; CSS `assets/css/ui.css:131-145` |
| `skeleton({rows,height,gap,radius})` | loading skeleton, returns HTML string, `aria-busy` | `assets/js/ui.js:531-535`; CSS `assets/css/ui.css:147-152` |
| `emptyState({icon,title,body,actionLabel,onAction})` | empty-state element with optional CTA | `assets/js/ui.js:536-545`; CSS `assets/css/ui.css:154-160` |
| `escapeHtml` | shared HTML escaper | `assets/js/ui.js:548-550` |

### 1b. Base/global primitives — `base.css`

- `.btn` (+ `.ghost`, `.accent`, `.sm`, `.lg`, `.dot`) — the one true button — `base.css:147-157`
- `.card` — generic card — `base.css:160`
- `.toast` (+ `.show`, `.lab`) — single global toast, driven by `shared.js` `toast()` — `base.css:162-165`; impl `assets/js/shared.js:141-162`
- `.tag` chips (`.inflight/.delivered/.wrapped/.peer/.block/.mesh/.nostr/.lz`) — `base.css:171-180`
- `.section-label`, `.brand`, `.preloader .ring`, `.skip-link` — `base.css:130-200`
- `:focus-visible` global ring — `base.css:193`
- Tokens: colors, radii, motion, elevation, glass recipe — `base.css:1-72`
- Glass surface classes `.lz-glass*`, `.lz-glass-sheen` — `base.css:94-118`; applied per-selector list in `glass.css:11-40,80-111`

### 1c. Per-view / duplicated components

**governance.js/css** — fully self-contained, does NOT consume `ui.js`:
- Proposal card — `governance.js:971-999`; CSS `governance.css:22-76`
- State pill (`.gov-state-{live,good,bad,wait,neutral}` via `stateTone()`) — `governance.js:99-110`; CSS `governance.css:43-65`
- Tally bar + legend — `governance.js:931-949`; CSS `governance.css:79-107`
- Vote buttons (for/against/abstain/snap) — `governance.js:951-969`; CSS `governance.css:144-186`
- Vote-status message (`aria-live`) — `governance.js:996,1064-1073`; CSS `governance.css:193-199`
- Own empty/error states — `governance.js:1005-1019`; CSS `governance.css:215-235`
- Own loading skeleton (`.gov-skel`, `govShimmer`) — `governance.js:1021-1025`; CSS `governance.css:238-253`
- "Load older" / retry buttons — `governance.js:1013-1014,1100-1101`; CSS `governance.css:202-235`

**communities.js/css** — partially consumes `ui.js` (`skeleton`, `emptyState`, `escapeHtml`):
- Inline icon set `ICN` — `communities.js:48-56` (re-defined locally)
- Accent monogram avatar `.comm-av` — `communities.js:89-92`; CSS `communities.css:76-87` (parallel to `coinAvatar`)
- Tab bar `.comm-tab` (role=tablist) — `communities.js:260-270`; CSS `communities.css:124-144`
- Status chips `.comm-status-chip` — `communities.js:252-257`; CSS `communities.css:112-122` (a pill/badge)
- Kind pills `.comm-item-kind`, `.comm-kind-pill` — CSS `communities.css:69-74,105-110` (another badge dialect)
- Post card / channel message rows — `communities.js:394-416,541-551`; CSS `communities.css:156-218`
- Composer (textarea autosize + send + derive CTA) — `communities.js:584-632`; CSS `communities.css:220-254`
- Uses `emptyState` ~12 sites, `skeleton` 2 sites (good reuse)

**community-add.js/css** — bespoke modal:
- Overlay + panel modal (`role=dialog`, `aria-modal`) — `community-add.js:27-53`; CSS `community-add.css:5-36`
- Tab bar `.cadd-tab` (3rd tab dialect) — `community-add.js:38-42`; CSS `community-add.css:38-45`
- Field/input wrapper `.cadd-field` (focus-within ring) — `community-add.js:65-71`; CSS `community-add.css:52-65`
- Native `<select>` un-upgraded — `community-add.js:141-144` (does NOT use `CustomSelect`)
- Result rows + hints — `community-add.js:101-108`; CSS `community-add.css:69-78`
- Rail "add" button + per-item remove `.comm-item-x` — CSS `community-add.css:82-101`

**coin-page.js / coin-page.css** — bespoke, consumes nothing from `ui.js`:
- Loading ring + label — `coin-page.js:559-562`; CSS `coin-page.css:22-47` (own spinner, not `skeleton`)
- Error state (icon + actions + retry) — `coin-page.js:564-603`; CSS `coin-page.css:49-82`
- Stat card `statCard()` `.cp-stat` — `coin-page.js:317-323`; CSS `coin-page.css:360-407`
- Range picker tabs `.cp-range-btn` (4th tab dialect) — `coin-page.js:421-424`; CSS `coin-page.css:~290-313`
- Mini progress bars (range/supply) — `coin-page.js:328-350`
- Badge `.cp-dl-badge`, category chips `.cp-cat`, links `.cp-link`, `.cp-btn-secondary` — `coin-page.js:353-367,523-547`; CSS `coin-page.css:414,423-426`
- Coin icon (uses `<img>` + monogram fallback, NOT `coinAvatar`) — `coin-page.js:375-377`

**wallet-actions.js / wallet-actions.css** — bespoke modal framework:
- `openModal/closeModal` (`role=dialog`, `aria-modal`, Esc, backdrop click) — `wallet-actions.js:528-562`; CSS `wallet-actions.css:7-44`
- Loading + error states `.wa-loading/.wa-error` + spinner `.wa-spin` — `wallet-actions.js:641,647`; CSS `wallet-actions.css:46-60`
- Native `<select>` `.wa-sel` (NOT `CustomSelect`) — `wallet-actions.js:619-627`; CSS `wallet-actions.css:111-120`
- Amount input, quote/review rows, status line — `wallet-actions.js:665-817`; CSS `wallet-actions.css:97-166`
- Self-contained QR encoder + SVG — `wallet-actions.js:105-388` (genuinely unique, keep as-is)
- Chips `.wa-recv-chip`, badge `.wa-sg-badge` — CSS `wallet-actions.css:203-226`
- Re-implements `esc`, `shortAddr`, `toast` accessors locally — `wallet-actions.js:60-63`

---

## 2. Gaps, duplication & missing/inconsistent states

**Massive primitive duplication.** `ui.js` already ships `skeleton`, `emptyState`,
`CustomSelect`, `coinAvatar` — yet:
- `escapeHtml` is re-implemented as a local `esc` in `governance.js:897`, `community-add.js:19`,
  `coin-page.js:325`, `wallet-actions.js:61`. Four copies of the same function.
- Loading: `ui.js skeleton` (shimmer rows), `governance.js gov-skel` (own shimmer), `coin-page cp-loading-ring`
  (spinner), `wallet-actions wa-spin` (spinner). Four loading idioms, two visual languages
  (skeleton vs spinner), no rule for which to use.
- Empty/error: `ui.js emptyState` vs `governance.js emptyState(kind)` vs `coin-page cp-error`. Governance
  and coin-page roll their own despite `emptyState` supporting `icon/title/body/action`.
- Avatars: `coinAvatar` (markets/trade) vs `comm-av` accent monogram (communities) vs `cp-icon`
  `<img>`+letter (coin page). Three avatar systems.

**Modals — three independent implementations, no shared focus management.**
`wallet-actions openModal` (`wa-modal`), `community-add ensureRoot` (`cadd-overlay`), plus `CustomSelect`'s
own popover/bottom-sheet. All three set `role=dialog`/`aria-modal` and handle Esc + backdrop, but:
- **No focus trap** in `wa-modal` or `cadd-overlay` — Tab escapes to the page behind. (WAI-APG requires it.)
- **No focus restore to trigger** on close in `wa-modal`/`cadd-overlay`.
- Background not marked `inert`/`aria-hidden` — screen readers can wander behind the dialog.
- `CustomSelect` (ui.js) is the most accessible interactive widget in the app; the two real modals are less so.

**Tabs — four parallel implementations:** `comm-tab`, `cadd-tab`, `cp-range-btn`, plus governor/snapshot
choice rows. None use `role=tab`/`aria-selected`/arrow-key roving tabindex (only `communities` sets
`role=tablist` on the container but not `role=tab` on buttons). No shared tab primitive exists.

**Badges/pills — at least six dialects:** `.tag` (base), `.gov-state`, `.comm-item-kind`/`.comm-kind-pill`,
`.comm-status-chip`, `.cp-dl-badge`/`.cp-cat`, `.wa-recv-chip`/`.wa-sg-badge`. All are "small uppercase
mono pill with tinted bg+border," reinvented each time.

**Fields/inputs — no shared input primitive.** `.cadd-field`, `.wa-sel`/`.wa-amount`,
`.comm-composer-input` each define their own focus-ring/border treatment. The nice
`focus-within` + `--ring-accent` pattern in `cadd-field` is not reused.

**Selects inconsistent.** `CustomSelect` exists and is used in markets/trade, but `community-add` (chain
picker) and `wallet-actions` (token/chain pickers) use raw `<select>` — visually and behaviorally
divergent from the rest of the app despite being a primary surface.

**Buttons partially shared.** `community-add`/`communities` reuse `.btn accent/ghost sm` (good), but
`governance` (`gov-vote-btn`, `gov-retry`, `gov-load-older`), `coin-page` (`cp-back-btn`,
`cp-trade-btn`, `cp-btn-secondary`, `cp-range-btn`) define fully bespoke buttons.

**Toasts.** Single global `.toast` (base.css + shared.js) is the one well-shared notification primitive —
keep it; just route `wallet-actions` through `window.LZ.toast` (it already proxies, good).

**Missing states to standardize:** no shared *error* primitive (only ad-hoc); `emptyState` lacks an
error/`tone` variant and a retry affordance (governance/coin-page needed one and forked); no skeleton
variants for card/grid/avatar-row shapes (callers pass raw row counts).

**Accessibility gaps summary:** modal focus traps absent; tab widgets lack `role=tab`/keyboard; native
selects unstyled+inconsistent; many close buttons are bare `✕` glyphs (`wa-x`, `cadd-close`) — fine
since they carry `aria-label`, but the `✕`/`＋` glyph buttons elsewhere should be verified; loading
skeletons set `aria-busy` (ui.js) but spinner states (cp/wa) announce nothing.

---

## 3. Prioritized improvements (P0/P1/P2)

### P0 — high value, low risk, mostly additive

**P0-1. Shared modal primitive `LZUI.modal()` with focus trap + restore.**
What: add `openModal({title, body, onMount, size, labelledBy})` to `ui.js` providing focus trap
(Tab/Shift+Tab loop over focusable descendants), focus restore to the invoking element, Esc + backdrop
close, `inert`/`aria-hidden` on `#app` while open, and a single `.lz-modal` skin in `ui.css`.
How/targets: refactor `wallet-actions.js:528-562` and `community-add.js:27-53` to call it (keep their
`.wa-`/`.cadd-` body markup; only the shell + behavior is shared). Effort: M (~0.5–1 day incl. a11y test).

**P0-2. Collapse `escapeHtml` duplication.** Import `escapeHtml` from `ui.js` in the four files that
define local `esc` (`governance.js:897`, `community-add.js:19`, `coin-page.js:325`, `wallet-actions.js:61`).
Effort: S (note: governance is also Node-tested headless — keep a tiny local fallback or export-guard).

**P0-3. Add an error variant to `emptyState`.** Extend `emptyState({tone:'error', icon, title, body,
actionLabel, onAction})` and add `.lz-empty.is-error`/retry styling in `ui.css`. Then migrate
`governance.js emptyState()` (`:1005-1019`) and `coin-page cp-error` (`:564-603`) to it.
Effort: S–M.

### P1 — coherence wins, moderate refactor

**P1-1. Shared badge/pill primitive.** Add `.lz-pill` with tone modifiers
(`--accent/--accent-2/--success/--warn/--error/--neutral`) + optional leading dot to `ui.css`,
generalizing `.tag` + `.gov-state`. Migrate `gov-state`, `comm-item-kind`, `comm-status-chip`,
`cp-dl-badge`, `wa-recv-chip`. Effort: M.

**P1-2. Shared field primitive `.lz-field`.** One input/textarea/select wrapper with the
`cadd-field` focus-within ring. Migrate `cadd-field`, `wa-sel`/`wa-amount`, `comm-composer-input`.
Effort: M.

**P1-3. Upgrade native selects to `CustomSelect`.** Wire `community-add` chain select (`:141-144`)
and `wallet-actions` token/chain selects (`:619-627`) through `CustomSelect` (and `coinAvatar` in the
token rows). Effort: M — verify the hidden-native-select `change` contract still fires the existing
handlers (it preserves it by design).

**P1-4. Shared tab primitive `LZUI.tabs()`** with `role=tablist`/`role=tab`/`aria-selected` and
roving-tabindex arrow-key nav. Migrate `comm-tab`, `cadd-tab`, `cp-range-btn`. Effort: M–L.

**P1-5. Standardize loading.** Pick skeleton-first; give `skeleton()` shape presets
(`'cards'|'rows'|'list'|'feed'`). Replace `gov-skel`, `cp-loading-ring`, `wa-spin` with `skeleton`
where a layout is known; keep a small shared `.lz-spinner` only for indeterminate inline waits
(quote/bridge). Effort: M.

### P2 — polish / consolidation

**P2-1. Unify avatars.** Generalize `coinAvatar` into `lzAvatar({seed, mode:'coin'|'monogram', accent})`
so `comm-av` and `cp-icon` fallback share one renderer. Effort: M.
**P2-2. Shared button variants** for the bespoke ones (`gov-vote-*`, `cp-*`) as `.btn` modifiers
where they're really just tinted buttons. Effort: M.
**P2-3. Shared `ICN` icon set** (move `communities.js:48-56` into `ui.js` and reuse). Effort: S.
**P2-4. Progress-bar primitive** for `gov-bar`, `cp-range`/`cp-supply`. Effort: S–M.

---

## 4. External best practices (applied to recommendations)

- **Modals:** pair `role="dialog"` + `aria-modal="true"`; implement a focus trap (loop Tab/Shift+Tab),
  restore focus to the trigger on close, mark background `inert`/`aria-hidden`, Esc closes. The native
  `<dialog>` element now does most of this for free (`::backdrop`, auto focus trap, Esc) and is the
  recommended base for new vanilla projects — worth considering for P0-1.
- **State components:** treat loading/empty/error as first-class, *separately reusable* components;
  empty states should guide ("No results, try X") and errors should be actionable with retry/fallback —
  directly supports P0-3 and P1-5.
- **Design tokens / component layer:** components should encapsulate structure while exposing style hooks
  (CSS custom props) so views customize without forking — the codebase already does this well via
  `--av-*`, `--comm-accent`, `--gov-*`; the fix is to *route through* the shared primitives instead of
  re-declaring them. Each primitive should document its variants (default/hover/disabled/loading/error).

Sources:
- [Dialog (Modal) Pattern — W3C WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [aria-modal — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-modal)
- [How to Build Accessible Modals with Focus Traps — UXPin](https://www.uxpin.com/studio/blog/how-to-build-accessible-modals-with-focus-traps/)
- [UI best practices for loading, error, and empty states — LogRocket](https://blog.logrocket.com/ui-design-best-practices-loading-error-empty-state-react/)
- [Building a React Design System: Reusable Component Library — Medium](https://medium.com/@dlrnjstjs/building-a-react-design-system-creating-a-reusable-component-library-99fd70a4d6be)

---

## 5. FILE OWNERSHIP (for CREATE phase)

**SHARED — coordinate before editing (other lanes depend on these):**
- `assets/js/ui.js` ⚠️ SHARED — `window.LZUI` API; add `modal()`, `tabs()`, extend `emptyState`/`skeleton`,
  generalize avatar. Additive only; do not change existing signatures (`coinAvatar`, `CustomSelect`,
  `escapeHtml`, `skeleton`, `emptyState` are public contracts).
- `assets/css/ui.css` ⚠️ SHARED — add `.lz-modal`, `.lz-pill`, `.lz-field`, `.lz-tabs`, `.lz-spinner`,
  `.lz-empty.is-error`. Additive.
- `assets/css/base.css` ⚠️ SHARED (tokens, `.btn`, `.toast`, `.tag`) — read-only ideally; only touch if a
  new token is unavoidable, and append.
- `assets/css/glass.css` ⚠️ SHARED (last in cascade, selector lists) — add new shared component selectors
  to the glass lists if the new primitives need frosting.
- `assets/js/shared.js` ⚠️ SHARED — `toast()` lives here; don't change its signature.

**OWNED by this lane (safe to edit in CREATE):**
- `assets/js/governance.js` + `assets/css/governance.css`
- `assets/js/communities.js` + `assets/css/communities.css`
- `assets/js/community-add.js` + `assets/css/community-add.css`
- `assets/js/coin-page.js` + `assets/css/coin-page.css`
- `assets/js/wallet-actions.js` + `assets/css/wallet-actions.css`

**HARD CONSTRAINTS to preserve:** element IDs (`#commLayout`, `#coinPage`, `#walletReceive/Swap/Bridge`,
`#cpCanvas`, etc.), `data-view`/`data-route`, `window.LZ.*` and `window.LZUI.*` APIs, HL signing,
Nostr derivation, the `CustomSelect` hidden-native-`<select>` `change`-event contract.
