# Integration — Identity / Sigil (apply by coordinator)

All sigil engine work lives in OWNED files (`assets/js/sigil.js`,
`assets/css/sigil.css`, `tests/sigil.test.mjs`) and is already done + tested
(`node tests/sigil.test.mjs` → 4873/0; `signing-format` still 336/0).

Below are the **exact, copy-pasteable** edits to the coordinator-owned spine
(`app.js`, `app.html`) to wire it up. Each item: file → anchor → before/after.
Nothing here touches the Nostr derivation, element IDs, or `data-view`.

New `sigil.js` exports now available (all pure/canvas-2D, GPU-independent):
`seedFromNpub` (unchanged signature, now also returns versioned v2 traits),
`mountSigil(canvas, npub, opts)` (unchanged signature; opts now accepts
`{form:0..1}` and the returned handle gains `.resolve(durMs)` and
`.reseed(npub)`), `sigilDataURL` (unchanged), plus **new**: `exportSigil(npub,
{size})`, `shareSigil(npub, {size})`, `fingerprint(npub)`.

---

## 1. app.js — extend the sigil import

**Anchor (line ~6):**
```js
import { mountSigil, sigilDataURL } from "./sigil.js";
```
**Replace with:**
```js
import { mountSigil, sigilDataURL, exportSigil, shareSigil, fingerprint } from "./sigil.js";
```

---

## 2. app.html — add the bloom layer, fingerprint readout, and share buttons

**Anchor — the hero block (lines ~321-331):**
```html
        <div class="sigil-hero" id="sigilHero">
          <div class="sigil-orb">
            <canvas id="sigilCanvas" aria-hidden="true"></canvas>
            <div class="sigil-idle" id="sigilIdle">
              <span class="sigil-ring"></span>
              <span class="sigil-idle-cap">your sigil<br><b>awaits</b></span>
            </div>
            <div class="sigil-scan"></div>
          </div>
          <div class="sigil-cap" id="sigilCap">One you — every chain.</div>
        </div>
```
**Replace with** (adds `.sigil-bloom`, an aria-described group on the orb, a
fingerprint readout, and the share row — IDs are new, none collide):
```html
        <div class="sigil-hero" id="sigilHero">
          <div class="sigil-orb" id="sigilOrb" role="img"
               aria-label="Your generative sigil — derive an identity to create it">
            <canvas id="sigilCanvas" aria-hidden="true"></canvas>
            <div class="sigil-bloom" aria-hidden="true"></div>
            <div class="sigil-idle" id="sigilIdle">
              <span class="sigil-ring"></span>
              <span class="sigil-idle-cap">your sigil<br><b>awaits</b></span>
            </div>
            <div class="sigil-scan"></div>
          </div>
          <div class="sigil-cap" id="sigilCap">One you — every chain.</div>
          <div class="sigil-fp" id="sigilFp" aria-hidden="true">
            <span class="fp-words" id="sigilFpWords"></span>
            <span class="fp-code" id="sigilFpCode"></span>
          </div>
          <div class="sigil-share" id="sigilShare">
            <button class="btn ghost sm" id="shareSigilBtn" data-motion="magnet">Share sigil</button>
            <button class="btn ghost sm" id="saveSigilBtn">Save PNG</button>
          </div>
        </div>
```

---

## 3. app.js — forming-from-noise during signing + ignite "born" moment

**Anchor — the whole `reflectSigil()` body (lines ~872-901).** Replace the
function body so it (a) drives the new fingerprint + aria, (b) keeps the
existing nav-emblem wiring. Keep the `const sigilCanvas …` declarations above
it as-is, and ADD the new element refs.

Add these refs next to the existing sigil element refs (after line ~870
`const navSigilSub …`):
```js
const sigilOrb     = document.getElementById("sigilOrb");
const sigilCap     = document.getElementById("sigilCap");
const sigilFp      = document.getElementById("sigilFp");
const sigilFpWords = document.getElementById("sigilFpWords");
const sigilFpCode  = document.getElementById("sigilFpCode");
let igniteTimer = 0;
```

**Replace `reflectSigil()` (lines ~872-901) with:**
```js
function reflectSigil(){
  if (state.derived){
    if (sigilCanvas && sigilHero){
      const npub = state.derived.npub;
      // If a forming handle is already live (mounted at derive-start from the
      // EVM address), resolve it in place instead of remounting — smooth.
      if (sigilHandle && sigilForming){
        sigilHandle.reseed(npub);
        sigilHandle.resolve(700);
        sigilForming = false;
      } else {
        sigilHandle?.stop();
        sigilHandle = mountSigil(sigilCanvas, npub);
      }
      // Ignite the "born" crescendo (one-shot; reduced-motion is CSS-guarded).
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!sigilHero.classList.contains("born")){
        sigilHero.classList.add("igniting");
        if (!reduce){ try { navigator.vibrate?.(12); } catch {} }
        clearTimeout(igniteTimer);
        igniteTimer = setTimeout(() => sigilHero.classList.remove("igniting"), 950);
      }
      sigilHero.classList.add("born");
      // Fingerprint + aria (determinism made visible).
      const fp = fingerprint(npub);
      if (sigilFpWords) sigilFpWords.textContent = fp.label;
      if (sigilFpCode)  sigilFpCode.textContent  = fp.code;
      if (sigilFp)      sigilFp.setAttribute("aria-hidden", "false");
      if (sigilOrb)     sigilOrb.setAttribute("aria-label", `Your generative sigil — ${fp.short}`);
      if (sigilCap)     sigilCap.textContent = `Your sigil — ${fp.short}.`;
    }
    if (navSigil){
      navSigil.dataset.derived = "true";
      if (navSigilImg){ navSigilImg.src = sigilDataURL(state.derived.npub, 72); navSigilImg.alt = `Your sigil — ${fingerprint(state.derived.npub).short}`; }
      if (navSigilName) navSigilName.textContent = "Your sigil";
      if (navSigilSub)  navSigilSub.textContent  = shortNpub(state.derived.npub);
    }
  } else {
    sigilHandle?.stop(); sigilHandle = null; sigilForming = false;
    sigilHero?.classList.remove("born", "igniting");
    clearTimeout(igniteTimer);
    if (sigilCanvas){
      const c = sigilCanvas.getContext("2d");
      if (c) c.clearRect(0, 0, sigilCanvas.width || 1, sigilCanvas.height || 1);
    }
    if (sigilFp)  sigilFp.setAttribute("aria-hidden", "true");
    if (sigilOrb) sigilOrb.setAttribute("aria-label", "Your generative sigil — derive an identity to create it");
    if (sigilCap) sigilCap.textContent = "One you — every chain.";
    if (navSigil){
      navSigil.dataset.derived = "false";
      if (navSigilImg){ navSigilImg.removeAttribute("src"); navSigilImg.alt = ""; }
      if (navSigilName) navSigilName.textContent = "No identity yet";
      if (navSigilSub)  navSigilSub.textContent  = "tap to derive";
    }
  }
}
let sigilForming = false;
```

---

## 4. app.js — seed the forming sigil when signing starts

The canvas must not be blank while the wallet popup is open. Seed a "forming"
render from the already-known EVM address (`state.account`) the instant we go
into the deriving state, then `reflectSigil()` resolves it to the true npub.

**Anchor — `setDeriving(on)` (lines ~904-907):**
```js
function setDeriving(on){
  mbFlow?.classList.toggle("deriving", on);
  if (deriveBtn) deriveBtn.classList.toggle("is-deriving", on);
}
```
**Replace with:**
```js
function setDeriving(on){
  mbFlow?.classList.toggle("deriving", on);
  if (deriveBtn) deriveBtn.classList.toggle("is-deriving", on);
  // Coalesce-from-noise: while signing, render a turbulent sigil seeded by the
  // known EVM address so the scan sweep reveals forming art, not a blank disc.
  if (on && !state.derived && sigilCanvas && state.account && !sigilForming){
    sigilHandle?.stop();
    sigilHandle = mountSigil(sigilCanvas, "evm:" + state.account, { form: 0.12 });
    sigilForming = true;
  } else if (!on && sigilForming && !state.derived){
    // Signing aborted/failed before a derive — tear the interim render down.
    sigilHandle?.stop(); sigilHandle = null; sigilForming = false;
    if (sigilCanvas){ const c = sigilCanvas.getContext("2d"); c && c.clearRect(0,0,sigilCanvas.width||1,sigilCanvas.height||1); }
  }
}
```
> Note: the forming seed uses an `"evm:"`-prefixed address string, so it is a
> *different* sigil from the final npub one (it then `reseed()`s to the real
> npub on success). This is intentional — it's pre-signature scaffolding, not
> the identity. No determinism contract is affected.

---

## 5. app.js — wire the Share / Save buttons

**Anchor — end of the derive handler block (after the `deriveBtn?.addEventListener(...)`
block that ends ~line 928).** Add:
```js
/* Share / save the sigil (P0.1) — fires only once an identity exists. */
document.getElementById("shareSigilBtn")?.addEventListener("click", async () => {
  if (!state.derived){ toast("derive an identity first", "err"); return; }
  try {
    const { method } = await shareSigil(state.derived.npub, { size: 1024 });
    if (method === "download+copy") toast("sigil saved + copied to clipboard", "ok");
    else if (method === "download") toast("sigil saved", "ok");
    else if (method === "share")    toast("shared", "ok");
  } catch (e){ console.error(e); toast("could not share sigil", "err"); }
});
document.getElementById("saveSigilBtn")?.addEventListener("click", async () => {
  if (!state.derived){ toast("derive an identity first", "err"); return; }
  try {
    const { dataURL, filename } = await exportSigil(state.derived.npub, { size: 2048 });
    const a = document.createElement("a"); a.href = dataURL; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    toast("high-res sigil saved", "ok");
  } catch (e){ console.error(e); toast("could not save sigil", "err"); }
});
```

---

## Verification after applying
- `node --check assets/js/app.js`
- Open identity view: idle shows placeholder; click "Sign & derive" → canvas
  shows forming turbulence during the wallet prompt (not blank); on signature
  the sigil resolves with a bloom + spring overshoot, fingerprint appears, and
  Share/Save buttons fade in.
- Toggle OS reduced-motion: no bloom/pop/vibrate; sigil still resolves, FP +
  buttons still appear.
- `node tests/sigil.test.mjs` and `node tests/signing-format.test.mjs` stay green.
