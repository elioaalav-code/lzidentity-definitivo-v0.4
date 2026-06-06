/* ============================================================ *
 *  Sigil — the generative identity artifact.
 *
 *  A deterministic piece of living art seeded by a user's npub.
 *  Same wallet -> same sigil, forever ("one you, every chain").
 *
 *  seedFromNpub() is pure (Node-testable). mountSigil()/sigilDataURL()
 *  render it (browser only) and are exercised via visual tests.
 * ============================================================ */

/* FNV-1a 32-bit string hash -> stable u32 seed. */
function xfnv1a(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* mulberry32 PRNG — deterministic, fast, good distribution for our needs. */
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seedFromNpub(npub) -> { h1, h2, density, rot, warp, ...v2 traits }
 * Pure. Deterministic. The single source of visual identity for a key.
 *
 * APPEND-ONLY / VERSIONED: the original five fields are produced by the
 * EXACT same PRNG draws in the EXACT same order as v1, so every existing
 * npub keeps its core hues / density / rotation / warp byte-for-byte. The
 * richer v2 traits are derived from an INDEPENDENT salted stream
 * ("::lz-sigil-v2") so they layer on top without perturbing v1 geometry.
 *
 *   --- v1 (frozen) ---
 *   h1, h2  : two hues in [0,360), always distinct (two-tone sigil)
 *   density : integer in [3,9] — number of flow currents
 *   rot     : base rotation in [0, 2*PI)
 *   warp    : flow distortion in [0,1]
 *
 *   --- v2 (additive richness) ---
 *   v        : seed version (2)
 *   symmetry : integer in [3,6] — n-fold mirror order of the field
 *   silhouette: 'disc' | 'faceted' | 'bloom' | 'orbit' — outer mask/motif
 *   lineStyle: 'solid' | 'filament' | 'dust' — how currents are stroked
 *   palette  : { name, sat, light, accent } — a curated family on top of h1/h2
 *   rare     : boolean — ~1-in-12 luminous accent variant
 */
export function seedFromNpub(npub){
  const key = String(npub || "");
  // v1 stream — frozen draw order. DO NOT REORDER / INSERT before warp.
  const rnd = mulberry32(xfnv1a(key + "::lz-sigil"));
  const h1 = rnd() * 360;
  const h2 = (h1 + 90 + rnd() * 180) % 360;   // 90–270° apart -> always distinct
  const density = 3 + Math.floor(rnd() * 7);  // 3..9
  const rot = rnd() * Math.PI * 2;
  const warp = rnd();

  // v2 stream — independent salt, so adding/reordering here never disturbs v1.
  const r2 = mulberry32(xfnv1a(key + "::lz-sigil-v2"));
  const symmetry  = 3 + Math.floor(r2() * 4);                 // 3..6
  const silhouette = SILHOUETTES[Math.floor(r2() * SILHOUETTES.length)];
  const lineStyle  = LINE_STYLES[Math.floor(r2() * LINE_STYLES.length)];
  const palette    = PALETTES[Math.floor(r2() * PALETTES.length)];
  const rare       = r2() < (1 / 12);                          // ~8% luminous

  return { v: 2, h1, h2, density, rot, warp,
           symmetry, silhouette, lineStyle, palette, rare };
}

/* Curated v2 trait vocabularies (tasteful by construction). */
const SILHOUETTES = ["disc", "faceted", "bloom", "orbit"];
const LINE_STYLES = ["solid", "filament", "dust"];
/* Palette families bias saturation/lightness + an accent hue offset so the
   two base hues read as part of a coherent, never-ugly scheme. */
const PALETTES = [
  { name: "aurora",  sat: 78, light: 62, accent: 18 },
  { name: "ember",   sat: 82, light: 58, accent: -22 },
  { name: "tide",    sat: 70, light: 60, accent: 30 },
  { name: "violet",  sat: 74, light: 64, accent: -14 },
  { name: "moss",    sat: 64, light: 56, accent: 24 },
  { name: "ash",     sat: 40, light: 66, accent: 8 },
];

/* Human-readable, deterministic fingerprint for a key. Two pieces:
   - code: 6 hex chars from the v1+v2 salted hash (stable, terse)
   - words: a 3-word mnemonic from curated word lists (recognisable, speakable)
   Pure; safe in Node. Used in caption, aria, nav tooltip + baked into exports. */
const FP_ADJ  = ["calm","bold","lucent","quiet","keen","wry","deep","fleet","warm","stark","vivid","sage"];
const FP_NOUN = ["ember","tide","cipher","comet","prism","grove","helix","quartz","raven","delta","echo","spire","lumen","drift","beacon","vellum"];
export function fingerprint(npub){
  const a = xfnv1a(String(npub || "") + "::lz-sigil");
  const b = xfnv1a(String(npub || "") + "::lz-sigil-v2");
  const code = ((a ^ (b << 5)) >>> 0).toString(16).padStart(8, "0").slice(-6);
  const words = [
    FP_ADJ[a % FP_ADJ.length],
    FP_NOUN[(a >>> 8) % FP_NOUN.length],
    FP_NOUN[(b >>> 4) % FP_NOUN.length],
  ];
  // Avoid an accidental duplicate noun in the mnemonic.
  if (words[2] === words[1]) words[2] = FP_NOUN[((b >>> 4) + 1) % FP_NOUN.length];
  return { code, words, label: words.join("-"), short: words.join(" ") };
}

/* ---------- helpers ---------- */
const TAU = Math.PI * 2;
const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function hslCss(h, s, l, a = 1){ return `hsla(${h.toFixed(1)},${s}%,${l}%,${a})`; }

/* ---------- canvas-2D sigil (the canonical render) ---------- */
/* Draws a deterministic two-tone flow disc into a 2D context sized w×h.
   `phase` (seconds) animates it: slow rotation, drifting currents, a
   breathing core. phase=0 yields the canonical still frame (avatars). */
function drawSigil2D(ctx, w, h, seed, phase = 0, opts = {}){
  const { h1, h2, density, rot, warp } = seed;
  // v2 enrichment is opt-in by seed version, so a v1-shaped seed renders
  // byte-for-byte as before. seedFromNpub() emits v:2 -> live sigils get it.
  const v2 = (seed.v | 0) >= 2;
  const pal = v2 ? (seed.palette || PALETTES[0]) : null;
  const sat = pal ? pal.sat : 80;
  const lit = pal ? pal.light : 60;
  const lineStyle = v2 ? (seed.lineStyle || "solid") : "solid";
  const silhouette = v2 ? (seed.silhouette || "disc") : "disc";
  const sym = v2 ? (seed.symmetry || density) : density;
  const formAmt = typeof opts.form === "number" ? Math.max(0, Math.min(1, opts.form)) : 1;
  // form<1 == "coalescing from noise": extra warp + reduced opacity early.
  const formWarp = (1 - formAmt) * 0.9;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
  const spin = rot + phase * 0.06;              // slow whole-field rotation
  const breath = 0.82 + 0.18 * Math.sin(phase * 1.1); // core pulse
  ctx.clearRect(0, 0, w, h);

  // soft radial body
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, hslCss(h1, 70, 62, 0.95));
  g.addColorStop(0.55, hslCss(h2, 65, 45, 0.55));
  g.addColorStop(1, hslCss(h2, 60, 12, 0));
  ctx.save();
  ctx.globalAlpha = 0.25 + 0.75 * formAmt;       // fade the whole field in while forming
  // silhouette mask (v2) — clip to the chosen motif, default disc == v1.
  ctx.beginPath();
  clipSilhouette(ctx, cx, cy, R, silhouette, sym, spin, v2);
  ctx.clip();
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // flow currents — `density` rotated, drifting petals
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  const eff = warp + formWarp;
  for (let i = 0; i < density; i++){
    const a = spin + (i / density) * TAU;
    const hue = i % 2 ? h2 : h1;
    const reach = R * (0.52 + 0.42 * Math.abs(Math.sin(a * (1 + eff) + phase * 0.4)));
    const bow = 0.55 + eff * 0.45;
    const ex = cx + Math.cos(a) * reach, ey = cy + Math.sin(a) * reach;
    if (v2 && lineStyle === "dust"){
      // particle-dust: stipple beads along the current instead of a stroke.
      ctx.fillStyle = hslCss(hue, sat, lit + 4, 0.55);
      const beads = 7;
      for (let b = 1; b <= beads; b++){
        const t = b / (beads + 1);
        const px = cx + (ex - cx) * t + Math.cos(a + 0.55) * reach * bow * (1 - t) * (1 - Math.abs(t - .5) * 2);
        const py = cy + (ey - cy) * t + Math.sin(a + 0.55) * reach * bow * (1 - t) * (1 - Math.abs(t - .5) * 2);
        const rad = Math.max(0.6, R * 0.03 * (1 - t * 0.5));
        ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
      }
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(
      cx + Math.cos(a + 0.55) * reach * bow,
      cy + Math.sin(a + 0.55) * reach * bow,
      ex, ey
    );
    // v1 solid == 0.16R; v2 filament == hairlines for a finer, woven feel.
    ctx.lineWidth = (v2 && lineStyle === "filament") ? Math.max(1, R * 0.05) : Math.max(1, R * 0.16);
    ctx.strokeStyle = hslCss(hue, v2 ? sat : 80, v2 ? lit : 60, 0.5);
    ctx.stroke();
  }

  // breathing core
  const coreHue = v2 && pal ? ((h1 + h2) / 2 + pal.accent + 360) % 360 : (h1 + h2) / 2;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42);
  core.addColorStop(0, hslCss(coreHue, 90, 82, 0.92 * breath));
  core.addColorStop(1, hslCss(coreHue, 90, 82, 0));
  ctx.fillStyle = core; ctx.fillRect(0, 0, w, h);

  // rare accent (v2): a bright luminous halo ring for ~1-in-12 keys.
  if (v2 && seed.rare){
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.62, 0, TAU);
    ctx.lineWidth = Math.max(1, R * 0.02);
    ctx.strokeStyle = hslCss(coreHue, 100, 88, 0.5 * breath);
    ctx.stroke();
  }
  ctx.restore();

  // thin outer rim
  ctx.globalAlpha = 0.25 + 0.75 * formAmt;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.97, 0, TAU);
  ctx.lineWidth = Math.max(1, R * 0.015);
  ctx.strokeStyle = hslCss((h1 + h2) / 2, 70, 72, 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* Clip path for the v2 silhouette. 'disc' (and all v1 renders) is a plain
   circle == identical to the original. The others carve a tasteful motif. */
function clipSilhouette(ctx, cx, cy, R, kind, sym, spin, v2){
  if (!v2 || kind === "disc"){ ctx.arc(cx, cy, R, 0, TAU); return; }
  if (kind === "faceted"){
    // regular sym-gon (3..6 facets) inscribed in R.
    const n = Math.max(3, sym);
    for (let i = 0; i <= n; i++){
      const a = spin + (i / n) * TAU;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    return;
  }
  if (kind === "bloom"){
    // sym-petalled rose curve r = R*(0.7 + 0.3*cos(sym*θ)).
    const steps = 120;
    for (let i = 0; i <= steps; i++){
      const a = spin + (i / steps) * TAU;
      const r = R * (0.72 + 0.28 * Math.cos(sym * (a - spin)));
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    return;
  }
  // 'orbit' — disc body; rings drawn over the top elsewhere is overkill,
  // so use a slightly inset disc to read distinctly from plain 'disc'.
  ctx.arc(cx, cy, R * 0.92, 0, TAU);
}

/**
 * sigilDataURL(npub, size) -> PNG data URL.
 * Static deterministic sigil for use as a small avatar anywhere.
 */
export function sigilDataURL(npub, size = 64){
  if (typeof document === "undefined") return "";
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  drawSigil2D(ctx, size, size, seedFromNpub(npub));
  return c.toDataURL("image/png");
}

/**
 * mountSigil(canvas, npub, opts?) -> { stop() }
 * Animated canvas-2D sigil: slow rotation, drifting currents, breathing core.
 * Deterministic per npub. GPU-independent (works everywhere). Honors
 * prefers-reduced-motion (renders one still frame), fps-capped (~36fps), and
 * pauses when off-screen or the tab is hidden.
 */
export function mountSigil(canvas, npub, opts = {}){
  let seed = seedFromNpub(npub);
  const ctx = canvas.getContext("2d");
  const dprCap = opts.dprCap || 2;
  const reduce = prefersReduced();

  // Forming-from-noise: start coalesced from `form0` (0 = pure turbulence,
  // 1 = resolved). `resolve()` springs it to 1 over ~700ms so the canvas is
  // never blank during signing. Reduced-motion skips straight to resolved.
  let form = reduce ? 1 : (typeof opts.form === "number" ? Math.max(0, Math.min(1, opts.form)) : 1);
  let formFrom = form, formStart = 0, formDur = 0;

  let w = 1, h = 1;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    w = Math.max(1, Math.floor(canvas.clientWidth  * dpr));
    h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    canvas.width = w; canvas.height = h;
  };
  resize();

  // No 2D context (extremely old/edge): nothing to draw, fail soft.
  if (!ctx) return { stop(){}, resolve(){}, reseed(){} };

  const t0 = performance.now();
  let running = true, raf = 0;
  const MIN_DT = 1000 / 36; let lastDraw = 0;

  const formNow = (now) => {
    if (formDur <= 0) return form;
    const t = Math.min(1, (now - formStart) / formDur);
    // ease-out-back-ish settle toward target 1.
    const e = 1 - Math.pow(1 - t, 3);
    return formFrom + (1 - formFrom) * e;
  };
  const render = (phase, now) => drawSigil2D(ctx, w, h, seed, phase, { form: formNow(now) });

  // reduced motion -> one still composition, redraw only on resize.
  if (reduce){
    render(0, performance.now());
    const onResize = () => { resize(); render(0, performance.now()); };
    window.addEventListener("resize", onResize);
    return {
      stop(){ window.removeEventListener("resize", onResize); },
      resolve(){ form = 1; render(0, performance.now()); },
      reseed(np){ seed = seedFromNpub(np); form = 1; render(0, performance.now()); },
    };
  }

  const frame = (now) => {
    if (!running) return;
    if (now - lastDraw >= MIN_DT){
      lastDraw = now;
      render((performance.now() - t0) / 1000, now);
    }
    raf = requestAnimationFrame(frame);
  };

  const onResize = () => resize();
  window.addEventListener("resize", onResize);

  const kick = () => { running = !document.hidden && canvas.isConnected; if (running){ lastDraw = 0; raf = requestAnimationFrame(frame); } };
  const io = new IntersectionObserver(([e]) => {
    running = e.isIntersecting && !document.hidden;
    if (running){ lastDraw = 0; raf = requestAnimationFrame(frame); }
  }, { threshold: 0 });
  io.observe(canvas);
  document.addEventListener("visibilitychange", kick);

  raf = requestAnimationFrame(frame);

  return {
    stop(){
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("resize", onResize);
    },
    /** Spring the field from its current form value up to fully resolved. */
    resolve(durMs = 700){
      formFrom = formNow(performance.now()); formStart = performance.now();
      formDur = Math.max(0, durMs); form = 1;
    },
    /** Swap to the true npub's seed (used when signing completes). */
    reseed(np){ if (np) seed = seedFromNpub(np); },
  };
}

/**
 * exportSigil(npub, opts?) -> Promise<{ blob, dataURL, filename }>
 * High-resolution PNG of the resting sigil with a baked-in branded footer
 * ("lzidentity · <fingerprint>"). GPU-independent (canvas-2D). Browser only.
 *   opts.size    : square art size in px (default 1024)
 *   opts.npub    : already covered by first arg
 * Caller wires navigator.share / download / clipboard (see integration doc).
 */
export async function exportSigil(npub, opts = {}){
  if (typeof document === "undefined") throw new Error("exportSigil: no document");
  const size = Math.max(256, opts.size || 1024);
  const pad = Math.round(size * 0.06);
  const footerH = Math.round(size * 0.11);
  const W = size + pad * 2;
  const H = size + pad * 2 + footerH;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("exportSigil: no 2D context");

  // obsidian backdrop
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  // the sigil itself — canonical still frame (phase 0, fully formed)
  const seed = seedFromNpub(npub);
  ctx.save();
  ctx.translate(pad, pad);
  drawSigil2D(ctx, size, size, seed, 0, { form: 1 });
  ctx.restore();

  // baked footer: brand + human-readable fingerprint
  const fp = fingerprint(npub);
  const short = String(npub || "");
  const shortNp = short.length > 22 ? `${short.slice(0, 12)}…${short.slice(-6)}` : short;
  ctx.textBaseline = "middle";
  const fy = size + pad * 2 + footerH / 2;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `600 ${Math.round(footerH * 0.34)}px ui-monospace, Menlo, monospace`;
  ctx.fillText("lzidentity", pad, fy - footerH * 0.18);
  ctx.fillStyle = "rgba(179,154,255,0.95)";
  ctx.font = `500 ${Math.round(footerH * 0.26)}px ui-monospace, Menlo, monospace`;
  ctx.fillText(`${fp.label} · ${fp.code}`, pad, fy + footerH * 0.2);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = `500 ${Math.round(footerH * 0.22)}px ui-monospace, Menlo, monospace`;
  ctx.fillText(shortNp, W - pad, fy);

  const dataURL = c.toDataURL("image/png");
  const blob = await new Promise((res) => {
    if (c.toBlob) c.toBlob((b) => res(b), "image/png");
    else res(dataURLtoBlob(dataURL));
  });
  const filename = `lz-sigil-${fp.code}.png`;
  return { blob, dataURL, filename, fingerprint: fp };
}

/**
 * shareSigil(npub, opts?) -> Promise<{ method }>
 * One-tap share of the exported PNG. Progressive enhancement:
 *   1. navigator.share({files}) when the platform can share files,
 *   2. else trigger a download AND best-effort copy-image to clipboard.
 * Never throws on user-cancel; returns the method actually used.
 * `opts.size` forwards to exportSigil (default 1024).
 */
export async function shareSigil(npub, opts = {}){
  const { blob, dataURL, filename, fingerprint: fp } = await exportSigil(npub, opts);
  const title = "My lzidentity sigil";
  const text = `My lzidentity sigil — ${fp.label} · ${fp.code}`;

  // 1) Native share with files (mobile / supporting desktop).
  try {
    if (typeof navigator !== "undefined" && navigator.share && typeof File !== "undefined"){
      const file = new File([blob], filename, { type: "image/png" });
      if (!navigator.canShare || navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title, text });
        return { method: "share" };
      }
    }
  } catch (e){
    // AbortError == user cancelled the share sheet; treat as done, no fallback.
    if (e && e.name === "AbortError") return { method: "cancelled" };
  }

  // 2) Fallback: download the PNG…
  try {
    const url = (typeof URL !== "undefined" && URL.createObjectURL) ? URL.createObjectURL(blob) : dataURL;
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    if (url !== dataURL) setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch { /* download not available — ignore */ }

  // …and best-effort copy-image to the clipboard.
  let copied = false;
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write){
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copied = true;
    }
  } catch { /* clipboard blocked / unsupported — download already fired */ }

  return { method: copied ? "download+copy" : "download" };
}

/* Tiny fallback for environments without canvas.toBlob. */
function dataURLtoBlob(url){
  const [head, b64] = url.split(",");
  const mime = (head.match(/:(.*?);/) || [])[1] || "image/png";
  const bin = atob(b64); const len = bin.length; const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
