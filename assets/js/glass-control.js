/* ============================================================ *
 *  glass-control.js — Glass 27 material intensity control.
 *
 *  iOS-27-inspired: the user owns the glass. Three modes switch the
 *  --glass-* tokens via html[data-glass] (see base.css):
 *    clear   — thinner fills, more blur, legibility text-shadow
 *    frosted — the default obsidian material (no attribute needed)
 *    solid   — near-opaque fills, blur off
 *
 *  Persisted as localStorage "lz:glass"; preloader.js re-applies it
 *  pre-paint. prefers-reduced-transparency still hard-forces solid
 *  surfaces in CSS regardless of this control.
 *
 *  Public API: window.LZ.glass = { get, set }
 * ============================================================ */

const KEY = "lz:glass";
const MODES = ["clear", "frosted", "solid"];
const LABELS = { clear: "Clear", frosted: "Frost", solid: "Solid" };

function get() {
  const m = document.documentElement.dataset.glass;
  return MODES.includes(m) ? m : "frosted";
}

function set(mode) {
  if (!MODES.includes(mode)) mode = "frosted";
  if (mode === "frosted") delete document.documentElement.dataset.glass;
  else document.documentElement.dataset.glass = mode;
  try {
    if (mode === "frosted") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch (_) {}
  reflect();
}

function reflect() {
  const cur = get();
  document.querySelectorAll(".gc-seg [data-mode]").forEach((b) => {
    const on = b.dataset.mode === cur;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
}

function mount() {
  const foot = document.querySelector(".side-foot");
  if (!foot || document.querySelector(".glass-ctl")) return;

  const ctl = document.createElement("div");
  ctl.className = "glass-ctl";
  const lab = document.createElement("span");
  lab.className = "gc-lab";
  lab.textContent = "Glass";
  const seg = document.createElement("div");
  seg.className = "gc-seg";
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Glass intensity");
  for (const m of MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.mode = m;
    b.setAttribute("role", "radio");
    b.textContent = LABELS[m];
    b.addEventListener("click", () => set(m));
    seg.appendChild(b);
  }
  // radiogroup keyboard contract: arrows move + select
  seg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = MODES[(MODES.indexOf(get()) + dir + MODES.length) % MODES.length];
    set(next);
    const btn = seg.querySelector(`[data-mode="${next}"]`);
    if (btn) btn.focus();
  });
  ctl.append(lab, seg);
  foot.parentElement.insertBefore(ctl, foot);
  reflect();
}

mount();

window.LZ = window.LZ || {};
window.LZ.glass = { get, set };
