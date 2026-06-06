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
 * seedFromNpub(npub) -> { h1, h2, density, rot, warp }
 * Pure. Deterministic. The single source of visual identity for a key.
 *   h1, h2  : two hues in [0,360), always distinct (two-tone sigil)
 *   density : integer in [3,9] — number of flow currents
 *   rot     : base rotation in [0, 2*PI)
 *   warp    : flow distortion in [0,1]
 */
export function seedFromNpub(npub){
  const rnd = mulberry32(xfnv1a(String(npub || "") + "::lz-sigil"));
  const h1 = rnd() * 360;
  const h2 = (h1 + 90 + rnd() * 180) % 360;   // 90–270° apart -> always distinct
  const density = 3 + Math.floor(rnd() * 7);  // 3..9
  const rot = rnd() * Math.PI * 2;
  const warp = rnd();
  return { h1, h2, density, rot, warp };
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
function drawSigil2D(ctx, w, h, seed, phase = 0){
  const { h1, h2, density, rot, warp } = seed;
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
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // flow currents — `density` rotated, drifting petals
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (let i = 0; i < density; i++){
    const a = spin + (i / density) * TAU;
    const hue = i % 2 ? h2 : h1;
    const reach = R * (0.52 + 0.42 * Math.abs(Math.sin(a * (1 + warp) + phase * 0.4)));
    const bow = 0.55 + warp * 0.45;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(
      cx + Math.cos(a + 0.55) * reach * bow,
      cy + Math.sin(a + 0.55) * reach * bow,
      cx + Math.cos(a) * reach,
      cy + Math.sin(a) * reach
    );
    ctx.lineWidth = Math.max(1, R * 0.16);
    ctx.strokeStyle = hslCss(hue, 80, 60, 0.5);
    ctx.stroke();
  }

  // breathing core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42);
  core.addColorStop(0, hslCss((h1 + h2) / 2, 90, 82, 0.92 * breath));
  core.addColorStop(1, hslCss((h1 + h2) / 2, 90, 82, 0));
  ctx.fillStyle = core; ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // thin outer rim
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.97, 0, TAU);
  ctx.lineWidth = Math.max(1, R * 0.015);
  ctx.strokeStyle = hslCss((h1 + h2) / 2, 70, 72, 0.5);
  ctx.stroke();
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
  const seed = seedFromNpub(npub);
  const ctx = canvas.getContext("2d");
  const dprCap = opts.dprCap || 2;
  const reduce = prefersReduced();

  let w = 1, h = 1;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    w = Math.max(1, Math.floor(canvas.clientWidth  * dpr));
    h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    canvas.width = w; canvas.height = h;
  };
  resize();

  // No 2D context (extremely old/edge): nothing to draw, fail soft.
  if (!ctx) return { stop(){} };

  const t0 = performance.now();
  let running = true, raf = 0;
  const MIN_DT = 1000 / 36; let lastDraw = 0;

  const render = (phase) => drawSigil2D(ctx, w, h, seed, phase);

  // reduced motion -> one still composition, redraw only on resize.
  if (reduce){
    render(0);
    const onResize = () => { resize(); render(0); };
    window.addEventListener("resize", onResize);
    return { stop(){ window.removeEventListener("resize", onResize); } };
  }

  const frame = (now) => {
    if (!running) return;
    if (now - lastDraw >= MIN_DT){
      lastDraw = now;
      render((performance.now() - t0) / 1000);
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
    }
  };
}
