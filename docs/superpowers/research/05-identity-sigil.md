# 05 — Identity Experience & the Sigil (RESEARCH)

Scope: the generative Sigil + the cinematic Identity view. Files surveyed:
`assets/js/sigil.js`, `assets/css/sigil.css`, the `[data-view="identity"]`
section of `app.html`, and the `reflectSigil()` / derive wiring in
`assets/js/app.js` + `assets/js/shared.js`.

Phase: READ-ONLY research. No code was edited.

---

## 1. Current state (file:line)

### 1.1 The generative engine — `assets/js/sigil.js`
- `seedFromNpub(npub)` (sigil.js:39-47) — pure, deterministic. FNV-1a hash
  (`xfnv1a`, sigil.js:12-19) → mulberry32 PRNG (sigil.js:22-29) → seed
  `{h1,h2,density,rot,warp}`. Salted with `"::lz-sigil"` (sigil.js:40). Hue
  pair forced 90–270° apart so the two tones are always distinct
  (sigil.js:42). Density 3–9 (sigil.js:43). Solid, idiomatic, testable.
- `drawSigil2D(ctx,w,h,seed,phase)` (sigil.js:61-110) — the canonical render:
  radial body gradient, `density` quadratic-curve "flow currents" drawn with
  `globalCompositeOperation="lighter"` (sigil.js:78), a breathing core
  (sigil.js:99-102), thin outer rim (sigil.js:106-109). `phase=0` is the
  canonical still frame; animation = slow whole-field spin (`0.06`,
  sigil.js:64) + drifting currents + core pulse (`breath`, sigil.js:65).
- `sigilDataURL(npub,size=64)` (sigil.js:116-123) — static PNG data URL for
  avatars. Currently used ONLY by the nav emblem.
- `mountSigil(canvas,npub,opts)` (sigil.js:132-195) — animated canvas-2D.
  Good engineering hygiene: DPR-capped (sigil.js:135,140), fps-capped to ~36
  (sigil.js:152,166), `IntersectionObserver` + `visibilitychange` pause
  (sigil.js:177-182), `prefers-reduced-motion` → single still frame
  (sigil.js:157-162), fails soft with no 2D ctx (sigil.js:148). Returns
  `{stop()}`.

### 1.2 The cinematic stage — `app.html` + `sigil.css`
- Identity view (app.html:311-389). `.id-stage` is a 2-col grid: sigil hero
  (left) + 3-act timeline (right), details below (sigil.css:8-17).
- HERO (app.html:321-331): `#sigilCanvas` + `.sigil-idle` placeholder (dashed
  spinning ring + "your sigil awaits", app.html:324-327) + `.sigil-scan`
  overlay + caption "One you — every chain." (app.html:330).
- 3 ACTS (app.html:334-360): 01 EVM wallet → 02 signature seed·sha256 → 03
  Nostr identity, joined by `.id-conn` connectors (app.html:343,352). Each act
  has a step pill, label, value, status chip.
- Actions (app.html:361-365): `#deriveBtn` "Sign & derive →", hidden
  `#resetBtn`, `#mbStatus` line.
- The "born" reveal (sigil.css:40,50,58,96): `.sigil-hero.born` fades the
  canvas in (`opacity 0→1`, `scale .9→1`, `transform 1.1s var(--spring)`,
  sigil.css:46-50), lights the ambient halo (sigil.css:40), cross-fades out
  the idle placeholder (sigil.css:58), and promotes the caption to full color
  (sigil.css:96).
- The "deriving" (signing) state (sigil.css:78-89): `.id-stage.deriving`
  triggers the vertical scan sweep (`sigil-scan` keyframe, sigil.css:99) and
  the orb breathe (sigil.css:89,100).
- Nav emblem (sigil.css:183-213, app.html:105-114): `.nav-sigil` link with a
  34px `.nav-sigil-orb` holding the static avatar `<img>` + dashed placeholder;
  flips to derived state via `data-derived="true"` (sigil.css:204-206).
- Reduced-motion block (sigil.css:216-222) disables ring/scan/breathe and
  shortens transitions.

### 1.3 The wiring — `app.js` + `shared.js`
- `reflectSigil()` (app.js:867-896): on `state.derived`, stops any prior
  handle, `mountSigil(sigilCanvas, npub)`, adds `.born`; sets nav emblem via
  `sigilDataURL(npub,72)`. On clear, stops, removes `.born`, clears canvas,
  resets nav. Called on identity route enter (app.js:969) and on state change
  via `reflectIdentity`/boot (app.js:118-120).
- `setDeriving(on)` (app.js:898-902) toggles `.deriving` on the flow + button.
- Derive handler (app.js:904-923): anticipatory — lights the pipeline the
  instant the wallet popup opens (`setDeriving(true)` before
  `await deriveNostr()`, app.js:912-914), toasts on success.
- Key derivation (shared.js:67-89): `personal_sign(DERIVATION_MSG)` →
  `sha256(sig)` (re-hash if first byte 0) → schnorr x-only pubkey → bech32
  `npub`. **This is the hard-constraint derivation; must keep working.**
  `state.derived = {addr,sig,priv,npub}`, persisted to localStorage.

### 1.4 What's genuinely good already
Deterministic + pure seed, GPU-independent canvas-2D, honors reduced-motion,
off-screen pause, anticipatory derive feedback, a real 3-act narrative scaffold,
and a nav emblem that reflects identity state. The bones are strong.

---

## 2. Gaps

1. **No shareability.** `sigilDataURL` exists but there is NO download / "save
   my sigil" / `navigator.share` / copy-image / open-graph affordance anywhere.
   The single most viral asset in the app is locked inside a canvas. (Grep
   confirms `sigilDataURL` is used only at app.js:878.)
2. **The "born" moment is quiet.** Reveal is a tasteful fade+scale, but there's
   no peak: no flash/bloom, no haptic (`navigator.vibrate`), no caption that
   names the moment ("Your sigil is born"), no confetti-of-light, no sound-off
   option. It reads as "an image appeared," not "something was *born*."
   (sigil.css:40-50,96 — all gentle, simultaneous, ~1s.)
3. **Generative variety is shallow.** One archetype (radial flow disc) for
   every key. Only 4 visual DOF (2 hues, density 3–9, rot, warp). Two different
   npubs can look very similar (same topology, close hues). No silhouette,
   symmetry order, line style, or palette-family variation → uniqueness/
   "this is unmistakably *mine*" is weak. (sigil.js:43-46,80-96.)
4. **No verifiability surface.** The pitch is "same wallet → same sigil
   forever," but nothing in the UI lets a user *prove* it — no seed readout, no
   "your sigil fingerprint" hash, no side-by-side "re-derive to confirm." The
   deterministic property is invisible.
5. **Idle → born has no signing-art bridge.** During `.deriving` the canvas is
   still blank (sigil only mounts after `state.derived`, app.js:868-872); the
   scan sweeps over emptiness. The art should *coalesce* from noise as the
   signature resolves, not pop in fully-formed afterward.
6. **Reduced-motion still frame is the same frame for everyone's phase.** Fine,
   but the still frame uses `phase=0` which hides the breathing-core peak; the
   static avatar (`sigilDataURL`) can look flatter than the animated one.
7. **Caption is generic & static.** "One you — every chain." never personalizes
   (no npub fingerprint word, no "born <date>").
8. **No progressive enhancement hook.** Brief allows optional WebGL; the
   codebase already has a WebGL mesh (`shader.js:1-90`) proving the pattern, but
   the sigil has no capability-gated upgrade path (bloom/grain/displacement).
9. **No tests despite the TDD claim.** sigil.js header says "TDD" but
   `tests/` has only `signing-format.test.mjs`; `seedFromNpub` (a pure,
   trivially-testable function) is untested → determinism can silently break.
10. **Accessibility of the artifact.** `#sigilCanvas` is `aria-hidden` with no
    text alternative describing the identity; nav `<img alt="">` is empty.

---

## 3. Prioritized improvements

Targets: 60fps idle on a 2019 laptop, <16ms/frame, no WebGL dependency, derive
path byte-identical, reduced-motion respected.

### P0 — make it shareable + make "born" a moment (highest emotional ROI)

**P0.1 Share / export the sigil.** *What:* add a "Save sigil" + "Share"
affordance to the hero (and a hover action on the nav emblem). *How:*
`canvas.toBlob()` from a fresh offscreen high-res render (1024–2048px) →
download as `lz-sigil-<short-npub>.png`; on supporting browsers use
`navigator.share({files:[…]})`; also "copy image" via `ClipboardItem`. Bake a
tiny footer "lzidentity · <npub-fingerprint>" into the exported PNG so shares
are self-branding. *Effort:* S (1 new exported `exportSigil(npub,size)` in
sigil.js + a button + handler in app.js). *Target:* one tap to a 1024px PNG.

**P0.2 Elevate the "born" reveal into a peak.** *What:* a 3-beat climax —
(a) signature lands → (b) bright bloom/flare + quick scale overshoot →
(c) settle into the calm living state + personalized caption. *How:* add a
`.sigil-hero.igniting` transient class (added on derive success, removed
~900ms later) driving a one-shot radial bloom keyframe + `var(--spring)`
overshoot beyond the current `scale(1)`; fire `navigator.vibrate?.(12)` (guard
+ reduced-motion); swap caption to "Your sigil is born." then settle to a
personalized line. Keep current `.born` as the resting state. *Effort:* S–M
(sigil.css keyframe + ~10 lines in `reflectSigil`/derive handler). *Target:*
a sub-second crescendo that reads as a birth, fully no-op under reduced-motion.

**P0.3 Coalesce-from-noise during signing.** *What:* during `.deriving`, render
the sigil forming out of turbulence so the scan sweep has something to reveal.
*How:* mount the canvas in a "forming" mode seeded by a *placeholder* (e.g.
hash of the EVM address, already known pre-signature) with high `warp` + low
opacity that resolves toward the true seed once `state.derived` lands
(interpolate warp/opacity over ~700ms). *Effort:* M (add a `forming` opt to
`mountSigil` + a seed crossfade). *Target:* zero blank canvas during signing.

### P1 — deepen uniqueness & make determinism visible

**P1.1 Expand generative DOF (more archetypes & traits).** *What:* widen the
visual space so two keys are obviously different and a sigil feels "rare."
*How:* extend `seedFromNpub` to also derive: symmetry order (3/4/5/6-fold),
silhouette/mask (disc / faceted / bloom / orbit-rings), line style (solid /
filament / particle-dust), palette *family* (not just two hues — pick a curated
family so colors stay tasteful), and a 1-in-N "rare" accent. Render branches in
`drawSigil2D`. Keep the seed function append-only (new fields after existing
ones) so existing npubs' core hues/rot don't shift — OR explicitly version the
seed (`lz-sigil-v2`) and accept that v0.3 is the first public release so no live
users are broken. *Effort:* M–L. *Target:* visibly distinct sigils across 50
random npubs; document trait rarity.

**P1.2 Show the determinism / "fingerprint."** *What:* a small, beautiful proof
that this art is bound to the key. *How:* derive a short human-readable
fingerprint from the seed (e.g. 4-word or 6-hex "sigil code") and show it under
the caption + in the nav emblem tooltip + baked into exports; optionally a
"re-derive to verify" micro-action. *Effort:* S. *Target:* user can read &
recognize "their" code.

**P1.3 Personalize the caption + nav.** *What:* replace static
"One you — every chain." with a line that includes the fingerprint and/or birth
context once born; keep the tagline as the idle state. *Effort:* XS.

**P1.4 Accessibility of the artifact.** *What:* give the sigil a text identity.
*How:* `aria-label` / visually-hidden description on the orb ("Your generative
sigil — <fingerprint>"); set nav `<img alt>` to the same once derived.
*Effort:* XS.

### P2 — polish & optional GPU upgrade

**P2.1 Add the missing `seedFromNpub` tests.** Pure determinism + hue-distance
+ range invariants + "same npub twice == identical" + "different npubs differ".
Node-only, mirrors `signing-format.test.mjs`. *Effort:* S. (Honors the file's
own TDD claim and protects the core promise.)

**P2.2 Optional progressive WebGL enhancement.** *What:* capability-gated bloom/
grain/displacement on top of the canvas-2D base, never required. *How:* feature-
detect WebGL (pattern already in `shader.js:3-5`); if present and motion
allowed, post-process; else the canvas-2D render IS the product. Must stay
verifiable: the *seed→geometry* stays in pure JS, GL only adds finish.
*Effort:* L. *Target:* identical silhouette with/without GL; headless still
renders the 2D canonical.

**P2.3 Richer reduced-motion still.** Render the static/reduced frame at a
phase that captures the core bloom (e.g. `phase` chosen for peak `breath`) so
avatars and reduced-motion users get the most flattering frame. *Effort:* XS.

**P2.4 "Born on" + lineage.** Stamp a derivation timestamp (local) and surface
"born <date>" in details; ties identity to a moment. *Effort:* XS.

---

## 4. External best practices (grounded)

- **Wow-moment timing.** The emotional "aha" should coincide with the user
  realizing personal value — here, the instant *their* unique sigil appears.
  Prompt sharing right at that peak (export CTA on born), since users at a wow
  moment are most likely to share. (userguiding, appcues, command.ai.)
- **Microinteractions = warmth + reward.** Small, responsive, well-timed
  feedback (the scan, the ignite bloom, a haptic tick) turn a mundane "sign"
  into a memorable, shareable moment. (UXPin, Medium/Agrawal.)
- **Uniqueness vs. taste tension.** Deterministic avatar systems must balance
  *diversity/uniqueness* (so "mine" is unmistakable) against *curation* (so it's
  never ugly) — argues for curated palette *families* + archetypes (P1.1) rather
  than raw random hues. Decentralized identity increasingly treats identity as a
  *consciously curated generative artifact*, which supports a visible
  fingerprint + shareable export. (Visual Alchemist; Creativity & Cognition
  2025.)
- **Determinism as trust.** Surfacing the seed/fingerprint makes the
  "same wallet → same sigil forever" claim *verifiable*, which is the brand
  promise; invisible determinism is wasted.

Sources:
- [WOW Moments — UserGuiding](https://userguiding.com/blog/wow-moment)
- [Finding your product's first wow moment — Appcues](https://www.appcues.com/blog/finding-your-products-first-wow-moment)
- [Wow moment for SaaS — Command.ai](https://www.command.ai/blog/wow-moment-saas/)
- [Designing Onboarding Microinteractions — UXPin](https://www.uxpin.com/studio/blog/designing-onboarding-microinteractions-guide/)
- [Micro Interactions That Wow Users — Medium/Agrawal](https://medium.com/@rounakbajoriastar/designing-for-delight-5-micro-interactions-that-wow-users-2f4d4126788e)
- [Generative Art and the "Flux" of Identity — Visual Alchemist](https://visualalchemist.in/2025/01/08/generative-art-and-the-flux-of-identity/)
- [Art, Identity, and AI — Creativity & Cognition 2025 (ACM)](https://dl.acm.org/doi/10.1145/3698061.3726959)

---

## 5. File ownership (CREATE phase)

Files I would OWN / primarily edit:
- `assets/js/sigil.js` — add `exportSigil()`, expand `seedFromNpub` traits
  (append-only/versioned), `drawSigil2D` archetype branches, `forming` mode,
  fingerprint derivation. (OWNED — core of this scope.)
- `assets/css/sigil.css` — `.igniting` bloom keyframe, ignite/overshoot, share
  buttons, fingerprint styles, reduced-motion guards. (OWNED.)
- `tests/sigil.test.mjs` — NEW, `seedFromNpub` determinism/invariant tests.
  (OWNED.)

SHARED files (coordinate — also touched by other swarm agents):
- `assets/js/app.js` — `reflectSigil()`, derive handler, new share/export
  button wiring, caption/fingerprint/aria updates, ignite/haptic trigger.
  **SHARED** (identity wiring lives in a large multi-view file).
- `app.html` — identity view markup: share/save buttons, fingerprint element,
  aria on the orb, nav emblem tooltip. **SHARED** (single-page shell; many
  agents edit it — must preserve element IDs, `data-view`/`data-route`).
- `assets/js/shared.js` — only if "born on" timestamp is added to
  `state.derived` / `deriveNostr`. **SHARED + SENSITIVE**: contains the hard-
  constraint Nostr key derivation (shared.js:67-89) — do NOT alter the
  sig→sha256→schnorr→bech32 path; only additive metadata.

Hard constraints honored by all proposals: element IDs, `data-view`/
`data-route`, `window.LZ` API, Nostr derivation, HL signing untouched;
canvas-2D remains the verifiable canonical render; `prefers-reduced-motion`
respected everywhere.
