# LZidentity — DESIGN BRIEF (v2.2 overhaul)

Shared visual language for the section-overhaul swarm. **Every agent follows
this so the app stays one coherent product, not a patchwork.** Read it before
touching anything.

## North star

Calm, premium, "quiet luxury" fintech — not flashy AI-slop. Dark, dense with
*meaningful* detail, alive with restrained motion. Every screen should feel
hand-built and intentional. Think Linear × a pro trading terminal × an art
object. Spectacular through **craft and detail**, not gradients-on-white or
neon noise.

## Palette (use the CSS tokens, never hardcode)

- bg `--bg #050505` → `--bg-2` → `--surface` → `--surface-2` → `--elevated`
- text `--text` / `--text-dim` / `--text-mute`
- **accent** `--accent #b39aff` (violet) — primary identity color
- **accent-2** `--accent-2 #5eead4` (teal) — live/data/trading-positive
- **accent-3** `--accent-3 #ff7a59` (warm) — alerts / mainnet / emphasis
- trading: `--long #3fb98a` / `--short #e0556b` (in trade.css)
- chains: `--eth --arb --op`
- Borders: `--border` / `--border-strong` / `--hairline`. One-pixel hairlines
  everywhere; no heavy borders.

## Type

- Sans: `--sans` (Geist). UI, body.
- Serif: `--serif` (Instrument Serif, italic) — display accents & emphasis only.
- Mono: `--mono` (Geist Mono) — numbers, addresses, labels, tags.
- Display headings: weight 300, tight tracking (`letter-spacing:-.02em`).
- Mono labels: 10px, uppercase, `letter-spacing:.12–.18em`, `--text-mute`.

## Surfaces & elevation

- Cards: 1px `--border`, radius `--r-lg`/`--r-xl`, subtle top-lit gradient
  `linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0))`.
- Glass for overlays: `--glass` + `backdrop-filter:blur(20px) saturate(180%)`.
- Shadows: `--sh-1/2/3`. Accent glows: `--glow-accent` / `--glow-teal`.
- Spacing: use the scale `--s1…--s8`.

## Motion (the soul of "spectacular")

- Default easing `--ease`; entrances `--ease-out`; playful pops `--spring`.
- Durations `--t-fast .15s` (hover), `--t .28s` (state), `--t-slow .6s` (reveal).
- Ambient "breathing" loops at 4s for living elements (pulses, glows).
- Micro-interactions on EVERYTHING interactive: hover lift (`translateY(-2px)`),
  border-glow, icon nudge, number flashes (green/red on tick).
- Stagger reveals (40–60ms apart) for lists/grids.
- **Respect `prefers-reduced-motion`** — base.css already cuts looping motion;
  don't reintroduce un-guarded infinite animations that ignore it.

## Interaction principles

- Empty/loading/error states are first-class — never a blank box. Skeletons,
  helpful copy, a way forward.
- Buttons: `.btn` primitives (`.accent`, `.ghost`, `.sm/.lg`). Keep them.
- Everything keyboard-reachable; `:focus-visible` rings; `aria-*` on controls;
  `aria-hidden` on decorative SVG/canvas.
- Real data stays real (don't fake the live HL feed or break the Nostr
  derivation / order-signing).

## Tone (copy)

Warm, plain, confident. Feature names are canonical: **Recovery, Trading,
Assistant**. Never reintroduce Doppelgänger / Soglia / Karma / CipherMesh /
Anima / TRIBE in user-facing copy (see HANDOFF.md §3).

## File ownership (do not edit outside your lane — avoids merge conflicts)

- **base.css** — owned by the orchestrator (shared tokens). Don't edit.
- **Agent A · Trading** → `assets/css/trade.css`, `assets/js/trade.js`, and
  only `<section data-view="trade">` in `app.html`.
- **Agent B · Assistant** → `assets/css/assistant.css`, `assets/js/assistant.js`,
  and only the copilot DOM (`#copilot`, `.copilot-fab`, `#hlModal` is NOT yours)
  in `app.html`.
- **Agent C · Landing** → `index.html`, `assets/css/landing.css`,
  `assets/js/landing.js`, `assets/js/anima.js`, `assets/js/shader.js`. Do NOT
  touch `base.css` or `anima.css` (shared with the app) — landing-only styles
  go in `landing.css`.
- **Agent D · App shell + core tabs** → `assets/css/app.css`, `assets/js/app.js`,
  and the core regions of `app.html` (sidebar, topbar, and the chat/wallet/
  markets/network/identity/recovery sections). Do not touch the trade or
  copilot regions.

## Definition of done (per agent)

1. No console errors (check your JS).
2. Keeps existing IDs/hooks that other modules depend on (e.g. `window.LZ`,
   `data-view` names, element IDs read by JS) unless you also update the reader.
3. Reduced-motion safe, keyboard accessible.
4. Commit your work in your worktree with a clear message so it can be merged.
