# Design Principles — CipherMesh × Anima

> Heuristics derived from **TRIBE v2** (Meta AI Research, arXiv:2507.22229) —
> a foundation model that predicts whole-brain fMRI responses to multimodal
> stimuli (video + audio + language) across 1,000+ hours of brain data from
> 720 subjects.

This is not a styleguide. It is a list of **falsifiable bets** about why
certain web interfaces feel "alive" while others feel inert. Each bet maps a
finding from TRIBE v2 to a concrete decision in the CipherMesh × Anima site
and dApp.

The model itself does not run in the browser (it requires GPU + PyTorch and
is CC BY-NC). We use it as an **oracle**: read its findings, encode them in
the UX, and optionally validate later by running candidate hero-loops through
the model offline to predict cortical engagement.

---

## P1 · Multimodal synergy beats single-channel polish

> *"The benefit of multimodality is highest in associative cortices … the
> multimodal encoder consistently outperforms the unimodal models, especially
> in associative areas such as the prefrontal or parieto-occipito-temporal
> cortices (up to 30% increase)."* — TRIBE v2 §3.3

**Translation.** A page with great motion *or* great copy *or* great audio
moves one cortical network. A page where motion, copy, and a subtle audio
texture **fire in sync** moves the high-level integration network — which
is where "wow" actually lives.

**Where this lives in the build:**
- The hero combines three streams: cortical-mesh WebGL animation,
  Instrument-Serif italic copy that *moves* on the same beat, and a
  near-silent low-frequency drone (opt-in, muted by default — see P7).
- Every section landing has at least two synchronized channels (visual
  motif + typographic motif sharing a tempo).

## P2 · The 4-second lookback window

> Video feature extraction uses **4-second lookback windows** at 2 Hz.
> TR = 1.49 s.

**Translation.** The brain's response to a visual scene at time *t* is
shaped by what was on screen for ~4 seconds prior. Animation that resets
faster than that doesn't accumulate. Animation that lingers past ~6 seconds
without change loses the response.

**Where this lives in the build:**
- Hero ambient motion runs on a **4-second base period** (the existing
  `--pulse: 4s` in `anima/site/index.html` is a happy accident — we
  standardize on it).
- Section reveals stagger at 0.4 / 0.8 / 1.6 / 3.2 s — log spacing inside
  the 4-second window.
- The mesh marquee in the transports section completes one rotation per
  ~4 s × N.

## P3 · Topographic mapping: audio→temporal, video→occipital, language→prefrontal

> *"audio predominates near the temporal gyrus … video predominates in
> occipital/parietal visual cortices … text/language activates prefrontal
> regions"* — TRIBE v2 §3.4, Fig. 5a

**Translation.** Different cortical regions specialize. The design system
mirrors this with **three accent channels** that each "own" a modality
metaphor:

| Channel  | TRIBE region        | CipherMesh transport | Anima pillar      | Color token       |
| -------- | ------------------- | -------------------- | ----------------- | ----------------- |
| audio    | superior temporal   | Nostr (broadcast)    | Karma (social)    | `--karma #FF6B35` |
| video    | occipito-parietal   | LayerZero (cross)    | Doppelgänger (AI) | `--doppel #4A9EFF`|
| language | prefrontal          | BLE Mesh (intimate)  | Soglia (legacy)   | `--soglia #8B5CF6`|

Each pillar gets its own color, motion personality, and copy register —
they don't compete, they map to different cortical regions.

## P4 · Long-range semantic context has no plateau

> *"increasing the context length used for the language model words strongly
> enhances encoding performance, without any plateau even at very long context
> lengths of 1024 words"* — TRIBE v2 §3.5, Fig. 6c

**Translation.** Short, punchy hero copy is leaving cortical activation on
the table. Pages with sustained, coherent narrative across screens activate
prefrontal language regions *more*, not less. Readers don't tune out long
copy — they tune out **incoherent** copy.

**Where this lives in the build:**
- The Anima manifesto section is **not** a 30-word summary. It is a
  three-screen scrolling editorial with carry-through metaphors.
- The Doppelgänger pillar borrows narrative passages from
  `docs/anima-v1/08-stories.md` rather than feature bullets.
- Section headings are full sentences with Instrument Serif italic
  continuation, not nouns.

## P5 · Primary visual cortex wants spatial clarity; associative wants meaning

> *"the multimodal model performs less well than the vision-only model in the
> primary visual cortex"* — TRIBE v2 §3.3

**Translation.** V1/V2 (early visual cortex) responds to **clean spatial
structure**: high contrast, well-resolved geometry, no semantic load.
Associative cortex responds to **integrated meaning**. So:

**Where this lives in the build:**
- The cortical-mesh WebGL hero is geometrically clean (vertices, edges, low
  saturation) — that feeds V1.
- The copy and color flow around it carry the meaning — that feeds
  associative areas.
- We never put busy semantic content on top of busy spatial noise.

## P6 · The cortex motif is literal, not metaphorical

> TRIBE v2 publishes predictions on the **fsaverage5 cortical mesh
> (~20,000 vertices)**.

**Translation.** The existing hero already declares `cortex · 20,484
vertices`. This is a coincidence we promote to canon: the hero WebGL is a
stylized cortical surface, not an abstract orb. The mesh vertex count, the
flat-map "Mercator" projection, the V1/V2/STS region labels — these become
the **visual language** of the unified identity. Brain ⇄ Mesh ⇄ Network
becomes a single rhyme.

## P7 · Hemodynamic anticipation: change ~1 s before the user expects it

> fMRI predictions are **offset 5 s in the past** to compensate for
> hemodynamic lag (TRIBE v2 README).

**Translation.** The brain's response trails the stimulus by ~5 s; the
*felt* moment of activation is earlier than the cortical signal. Interfaces
that confirm an action **before** the user finishes the gesture feel
"prescient." We bake anticipation into micro-interactions:

- The `Sign & derive` button animates its success state when the wallet
  popup opens, not when the signature returns.
- Scroll-triggered reveals fire at 70% threshold, not 100%.
- The cortical-mesh ambient deformation leads the cursor by ~120 ms.

## P8 · Default to silence; reward consent with sound

The audio channel from P1 / P3 is real, but auto-playing audio is a known
trust-killer. We resolve this by gating audio behind a single, visible
toggle in the topbar — and once consented, every section landing has its
own 2-second audio "phrase" tuned to the section's color.

---

## Validation loop (post-build)

After the SPA ships, validate by rendering 10–20 candidate hero loops as
4-second `.mp4` clips and running them through TRIBE v2 offline (Colab
notebook in the upstream repo) to predict mean cortical engagement on the
multimodal-integration ROI mask. Promote the winner.

This is the part where the neuroscience model actually does work — not in
production, but in the design loop.
