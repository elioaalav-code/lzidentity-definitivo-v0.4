/* ============================================================ *
 *  Motion — the connective tissue.
 *
 *  A small, coherent motion layer applied app-wide:
 *   - tweenNumber : count-up / number transitions for KPIs
 *   - withViewTransition : smooth route cross-fades (graceful fallback)
 *   - initMagnet : subtle pointer-follow on [data-motion="magnet"]
 *   - initReveal : staggered reveal of [data-reveal] on enter
 *
 *  Pure helpers (lerp / easeOutCubic / tweenValueAt) are Node-testable.
 *  All honor prefers-reduced-motion and degrade safely.
 * ============================================================ */

/* ---------- pure (testable) ---------- */
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Value of a from->to tween at `elapsed` ms over `duration` ms. Clamped. */
export function tweenValueAt(from, to, elapsed, duration, ease = easeOutCubic){
  if (duration <= 0) return to;
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return lerp(from, to, ease(t));
}

/* ---------- browser guards ---------- */
const hasDoc = typeof document !== "undefined";
const reduced = () => hasDoc && window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => hasDoc && window.matchMedia &&
  window.matchMedia("(pointer: fine)").matches;

/* ---------- tweenNumber ---------- */
/**
 * Animate an element's text from `from` to `to`.
 * opts: { duration=700, format=(v)=>String(Math.round(v)) }
 * Reduced motion -> jumps straight to the formatted target.
 */
export function tweenNumber(el, from, to, opts = {}){
  if (!el) return;
  const duration = opts.duration ?? 700;
  const format = opts.format ?? ((v) => String(Math.round(v)));
  if (reduced() || duration <= 0){ el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const v = tweenValueAt(from, to, now - start, duration);
    el.textContent = format(v);
    if (now - start < duration) requestAnimationFrame(step);
    else el.textContent = format(to);
  };
  requestAnimationFrame(step);
}

/* ---------- view transitions ---------- */
/**
 * Run `apply` (the DOM mutation) inside a View Transition when supported,
 * otherwise just call it. Never throws; always applies the change.
 */
export function withViewTransition(apply){
  if (typeof apply !== "function") return;
  if (reduced() || !hasDoc || !document.startViewTransition){ apply(); return; }
  try { document.startViewTransition(() => apply()); }
  catch { apply(); }
}

/* ---------- magnet ---------- */
/** Subtle pointer-follow on [data-motion="magnet"] (fine pointer only). */
export function initMagnet(root = hasDoc ? document : null){
  if (!root || reduced() || !finePointer()) return;
  const STR = 0.28, MAX = 6; // px
  root.querySelectorAll('[data-motion="magnet"]').forEach((el) => {
    if (el.__magnet) return; el.__magnet = true;
    const reset = () => { el.style.transform = ""; };
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * STR;
      const dy = (e.clientY - (r.top + r.height / 2)) * STR;
      const cl = (n) => Math.max(-MAX, Math.min(MAX, n));
      el.style.transform = `translate(${cl(dx)}px, ${cl(dy)}px)`;
    });
    el.addEventListener("pointerleave", reset);
    el.addEventListener("pointerup", reset);
  });
}

/* ---------- reveal on enter ---------- */
/** Stagger-reveal [data-reveal] elements as they scroll into view. */
export function initReveal(root = hasDoc ? document : null){
  if (!root) return;
  const items = root.querySelectorAll("[data-reveal]:not(.reveal-in)");
  if (reduced() || !("IntersectionObserver" in window)){
    items.forEach((el) => el.classList.add("reveal-in"));
    return;
  }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting){
        const el = entry.target;
        el.style.setProperty("--reveal-delay", `${(i % 6) * 55}ms`);
        el.classList.add("reveal-in");
        obs.unobserve(el);
      }
    });
  }, { threshold: 0.08, rootMargin: "0px 0px -8% 0px" });
  items.forEach((el) => io.observe(el));
}

/* ---------- self-mount ---------- */
if (hasDoc){
  // signals CSS that JS-driven motion is active (so reveal hide-states only
  // apply when we can actually un-hide them — no-JS keeps content visible).
  document.documentElement.classList.add("motion-ready");
  // when View Transitions drive route swaps, CSS suppresses the per-view
  // fadeUp so the two don't double up (motion agent finding).
  if (document.startViewTransition) document.documentElement.classList.add("lz-vt");
  const boot = () => { initMagnet(); initReveal(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  // expose for other modules + dynamically added content
  window.LZ = window.LZ || {};
  window.LZ.motion = { tweenNumber, withViewTransition, initMagnet, initReveal };
}
