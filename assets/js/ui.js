/* ============================================================ *
 *  ui.js — shared UI primitives (v2.2 overhaul)
 *
 *  One small, dependency-free toolkit every module builds on so
 *  the product stays one coherent object:
 *
 *    · CustomSelect  — accessible combobox over a hidden <select>
 *                      (the native element stays the source of truth,
 *                       so existing change-listeners keep working).
 *    · coinAvatar    — deterministic on-brand monogram avatar (no network).
 *    · magnetic      — opt-in magnetic hover for hero CTAs.
 *    · initButtonFX  — press ripple on every .btn (sheen is pure CSS).
 *    · skeleton / emptyState — reusable loading + empty primitives.
 *
 *  Loaded as a module in <head>; also exposed on window.LZUI for
 *  non-module callers. Everything is reduced-motion safe.
 * ============================================================ */

const reduce = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () =>
  window.matchMedia && window.matchMedia("(max-width: 600px)").matches;

let _uid = 0;
const uid = (p = "lz") => `${p}-${(++_uid).toString(36)}-${Date.now().toString(36).slice(-3)}`;

/* ─── coinAvatar ───────────────────────────────────────────────
 * Hash a symbol into an on-brand hue and draw a 1–3 letter monogram.
 * Returns an <span> element. Self-contained, no logos fetched.
 */
const AVATAR_HUES = [
  { bg: "rgba(179,154,255,.16)", fg: "#cbb8ff", ring: "rgba(179,154,255,.34)" }, // violet (accent)
  { bg: "rgba(94,234,212,.15)",  fg: "#7ff0dd", ring: "rgba(94,234,212,.32)" },  // teal (accent-2)
  { bg: "rgba(255,122,89,.15)",  fg: "#ff9f86", ring: "rgba(255,122,89,.32)" },  // warm (accent-3)
  { bg: "rgba(124,142,248,.16)", fg: "#9fb0ff", ring: "rgba(124,142,248,.34)" }, // eth
  { bg: "rgba(40,160,240,.15)",  fg: "#6cc2f7", ring: "rgba(40,160,240,.32)" },  // arb
  { bg: "rgba(134,239,172,.14)", fg: "#9df0bd", ring: "rgba(134,239,172,.3)" },  // green
  { bg: "rgba(253,230,138,.14)", fg: "#f3dd96", ring: "rgba(253,230,138,.3)" },  // amber
];
function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
export function coinAvatar(symbol, size = 30){
  const sym = String(symbol || "?").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "?";
  const hue = AVATAR_HUES[hashStr(sym) % AVATAR_HUES.length];
  const mono = sym.length <= 3 ? sym : sym.slice(0, 3);
  const el = document.createElement("span");
  el.className = "lz-avatar";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    `--av-size:${size}px;--av-bg:${hue.bg};--av-fg:${hue.fg};--av-ring:${hue.ring};` +
    `font-size:${mono.length >= 3 ? size * 0.34 : size * 0.4}px`;
  el.textContent = mono;
  return el;
}
export const coinAvatarHTML = (symbol, size = 30) => coinAvatar(symbol, size).outerHTML;

/* ─── fuzzy match ──────────────────────────────────────────────
 * Lightweight subsequence match with a small score so exact /
 * prefix hits rank first. Returns -1 for no match.
 */
export function fuzzyScore(query, target){
  if (!query) return 0;
  const q = query.toLowerCase(), t = String(target || "").toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 600 - idx - t.length;
  // subsequence
  let ti = 0, hits = 0;
  for (let qi = 0; qi < q.length; qi++){
    const c = q[qi];
    let found = -1;
    for (; ti < t.length; ti++){ if (t[ti] === c){ found = ti; ti++; break; } }
    if (found < 0) return -1;
    hits++;
  }
  return 200 + hits - t.length;
}

/* ─── CustomSelect ─────────────────────────────────────────────
 * A styled, searchable, groupable combobox that drives a hidden
 * native <select>. Pass either a real <select> (its <option>s seed
 * the data) or supply rich `items` and update them live.
 *
 *   new CustomSelect({
 *     select,            // hidden <select> (source of truth)  — required
 *     items,             // [{value,label,group,...}]          — optional override
 *     groupOrder,        // ['Favorites','Majors', ...]        — optional
 *     searchable: true,
 *     searchKeys: ['value','label'],
 *     renderRow(item, ctx)     => HTML string for a row body
 *     renderTrigger(item)      => HTML string for the trigger body
 *     placeholder: 'Select…',
 *     bottomSheet: true,       // becomes a sheet on phones
 *     title: 'Select market',  // sheet/aria title
 *     onSelect(value, item),
 *   })
 *
 * Instance API: open() close() toggle() setItems(items) refresh()
 *               setValue(v) get value() destroy()
 */
export class CustomSelect {
  constructor(opts){
    this.o = Object.assign({
      searchable: false, searchKeys: ["value", "label"], bottomSheet: true,
      placeholder: "Select…", title: "Select", groupOrder: null,
      renderRow: null, renderTrigger: null, onSelect: null,
    }, opts);
    this.select = this.o.select;
    if (!this.select) throw new Error("CustomSelect: `select` is required");
    this.items = this.o.items || this._itemsFromSelect();
    this.open_ = false;
    this.activeIdx = -1;
    this.filtered = [];
    this._id = uid("sel");
    this._build();
    this.refresh();
  }

  _itemsFromSelect(){
    return Array.from(this.select.options).map(op => ({
      value: op.value, label: op.textContent.trim(), group: op.dataset.group || null,
    }));
  }

  _build(){
    const wrap = document.createElement("div");
    wrap.className = "lz-select";
    // hide the native select but keep it in the DOM as the value holder
    this.select.classList.add("lz-select-native");
    this.select.setAttribute("tabindex", "-1");
    this.select.setAttribute("aria-hidden", "true");
    this.select.parentNode.insertBefore(wrap, this.select);
    wrap.appendChild(this.select);

    const trig = document.createElement("button");
    trig.type = "button";
    trig.className = "lz-select-trigger";
    trig.setAttribute("aria-haspopup", "listbox");
    trig.setAttribute("aria-expanded", "false");
    trig.setAttribute("aria-label", this.o.title);
    trig.innerHTML = `<span class="lz-select-trig-body"></span>
      <svg class="lz-select-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    wrap.appendChild(trig);

    const pop = document.createElement("div");
    pop.className = "lz-select-pop";
    pop.setAttribute("role", "dialog");
    pop.hidden = true;
    pop.innerHTML = `
      ${this.o.searchable ? `<div class="lz-select-search">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <input type="text" class="lz-select-input" role="combobox" aria-autocomplete="list"
          aria-expanded="true" aria-controls="${this._id}-list" placeholder="Search…" autocomplete="off" spellcheck="false" />
      </div>` : ``}
      <div class="lz-select-list" id="${this._id}-list" role="listbox" aria-label="${this.o.title}" tabindex="-1"></div>`;
    wrap.appendChild(pop);

    const backdrop = document.createElement("div");
    backdrop.className = "lz-select-backdrop";
    backdrop.hidden = true;
    wrap.appendChild(backdrop);

    this.el = { wrap, trig, pop, backdrop,
      list: pop.querySelector(".lz-select-list"),
      input: pop.querySelector(".lz-select-input"),
      trigBody: trig.querySelector(".lz-select-trig-body") };

    // events
    trig.addEventListener("click", () => this.toggle());
    trig.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " "){ e.preventDefault(); this.open(); }
    });
    backdrop.addEventListener("click", () => this.close());
    this.el.list.addEventListener("click", (e) => {
      const row = e.target.closest(".lz-select-row");
      if (row && row.dataset.value != null) this._choose(row.dataset.value);
    });
    this.el.list.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".lz-select-row");
      if (row){ const i = this.filtered.findIndex(it => it.value === row.dataset.value); if (i >= 0) this._setActive(i, false); }
    });
    if (this.el.input){
      this.el.input.addEventListener("input", () => this.refresh(true));
      this.el.input.addEventListener("keydown", (e) => this._onKey(e));
    }
    trig.addEventListener("keydown", (e) => { if (this.open_) this._onKey(e); });
    this._onDocClick = (e) => { if (this.open_ && !wrap.contains(e.target)) this.close(); };
    document.addEventListener("click", this._onDocClick, true);
  }

  _onKey(e){
    if (e.key === "Escape"){ e.preventDefault(); this.close(); this.el.trig.focus(); return; }
    if (e.key === "ArrowDown"){ e.preventDefault(); this._setActive(Math.min(this.activeIdx + 1, this.filtered.length - 1)); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); this._setActive(Math.max(this.activeIdx - 1, 0)); }
    else if (e.key === "Home"){ e.preventDefault(); this._setActive(0); }
    else if (e.key === "End"){ e.preventDefault(); this._setActive(this.filtered.length - 1); }
    else if (e.key === "Enter"){ e.preventDefault(); const it = this.filtered[this.activeIdx]; if (it) this._choose(it.value); }
  }

  _choose(value){
    if (this.select.value !== value){
      this.select.value = value;
      this.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this._renderTrigger();
    if (this.o.onSelect) this.o.onSelect(value, this.items.find(i => i.value === value));
    this.close();
    this.el.trig.focus();
  }

  setItems(items){ this.items = items || []; this.refresh(); }
  setValue(v){ this.select.value = v; this._renderTrigger(); if (this.open_) this.refresh(); }
  get value(){ return this.select.value; }

  _groups(){
    if (this.o.groupOrder) return this.o.groupOrder;
    const seen = []; for (const it of this.items){ const g = it.group || ""; if (!seen.includes(g)) seen.push(g); }
    return seen;
  }

  refresh(fromSearch){
    const q = this.el.input ? this.el.input.value.trim() : "";
    let rows = this.items.slice();
    if (q){
      rows = rows
        .map(it => ({ it, s: Math.max(...(this.o.searchKeys.map(k => fuzzyScore(q, it[k])))) }))
        .filter(x => x.s > -1).sort((a, b) => b.s - a.s).map(x => x.it);
    }
    this.filtered = rows;

    // build grouped (only when not searching) or flat (when searching)
    const ctx = { selected: this.select.value };
    let html = "";
    if (q){
      if (!rows.length){ html = `<div class="lz-select-empty">No match for “${escapeHtml(q)}”</div>`; }
      else html = rows.map((it, i) => this._rowHTML(it, i, ctx)).join("");
    } else {
      const groups = this._groups();
      let i = 0;
      for (const g of groups){
        const inG = rows.filter(it => (it.group || "") === g);
        if (!inG.length) continue;
        if (g) html += `<div class="lz-select-group" role="presentation">${escapeHtml(g)}<span class="lz-select-group-n">${inG.length}</span></div>`;
        for (const it of inG){ html += this._rowHTML(it, i, ctx); i++; }
      }
      // re-flatten filtered to match render order for keyboard nav
      this.filtered = groups.flatMap(g => rows.filter(it => (it.group || "") === g));
      if (!this.filtered.length) this.filtered = rows;
    }
    this.el.list.innerHTML = html;

    // active index: keep current selection visible
    const selIdx = this.filtered.findIndex(it => it.value === this.select.value);
    this._setActive(fromSearch ? 0 : (selIdx >= 0 ? selIdx : 0), false);
    this._renderTrigger();
  }

  _rowHTML(it, i, ctx){
    const sel = it.value === ctx.selected;
    const body = this.o.renderRow
      ? this.o.renderRow(it, ctx)
      : `<span class="lz-select-label">${escapeHtml(it.label)}</span>`;
    return `<div class="lz-select-row${sel ? " sel" : ""}" role="option" id="${this._id}-opt-${i}"
      data-value="${escapeHtml(it.value)}" aria-selected="${sel}">${body}
      <svg class="lz-select-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  }

  _renderTrigger(){
    const it = this.items.find(i => i.value === this.select.value);
    this.el.trigBody.innerHTML = it
      ? (this.o.renderTrigger ? this.o.renderTrigger(it) : `<span class="lz-select-label">${escapeHtml(it.label)}</span>`)
      : `<span class="lz-select-ph">${escapeHtml(this.o.placeholder)}</span>`;
  }

  _setActive(i, scroll = true){
    const rows = this.el.list.querySelectorAll(".lz-select-row");
    if (this.activeIdx >= 0 && rows[this.activeIdx]) rows[this.activeIdx].classList.remove("active");
    this.activeIdx = Math.max(-1, Math.min(i, this.filtered.length - 1));
    const cur = rows[this.activeIdx];
    if (cur){
      cur.classList.add("active");
      this.el.list.setAttribute("aria-activedescendant", cur.id);
      if (this.el.input) this.el.input.setAttribute("aria-activedescendant", cur.id);
      if (scroll) cur.scrollIntoView({ block: "nearest" });
    }
  }

  open(){
    if (this.open_) return;
    this.open_ = true;
    const sheet = this.o.bottomSheet && isPhone();
    this.el.wrap.classList.toggle("as-sheet", sheet);
    this.el.pop.hidden = false;
    this.el.backdrop.hidden = !sheet;
    this.el.trig.setAttribute("aria-expanded", "true");
    this.el.wrap.classList.add("open");
    if (reduce()) this.el.pop.style.transition = "none";
    this.refresh();
    requestAnimationFrame(() => {
      if (this.el.input) this.el.input.focus();
      else this.el.list.focus();
      const cur = this.el.list.querySelector(".lz-select-row.sel");
      if (cur) cur.scrollIntoView({ block: "center" });
    });
  }
  close(){
    if (!this.open_) return;
    this.open_ = false;
    this.el.wrap.classList.remove("open");
    this.el.trig.setAttribute("aria-expanded", "false");
    if (this.el.input) this.el.input.value = "";
    const finish = () => { this.el.pop.hidden = true; this.el.backdrop.hidden = true; };
    if (reduce()) finish();
    else { this.el.wrap.classList.add("closing"); setTimeout(() => { this.el.wrap.classList.remove("closing"); finish(); }, 140); }
  }
  toggle(){ this.open_ ? this.close() : this.open(); }
  destroy(){ document.removeEventListener("click", this._onDocClick, true); this.el.wrap.replaceWith(this.select); this.select.classList.remove("lz-select-native"); }
}

/* ─── magnetic (opt-in hero CTA hover) ─────────────────────────── */
export function magnetic(el, strength = 0.28){
  if (!el || reduce()) return () => {};
  const onMove = (e) => {
    const r = el.getBoundingClientRect();
    const mx = e.clientX - (r.left + r.width / 2);
    const my = e.clientY - (r.top + r.height / 2);
    el.style.transform = `translate(${mx * strength}px, ${my * strength}px)`;
  };
  const reset = () => { el.style.transform = ""; };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", reset);
  el.classList.add("lz-magnetic");
  return () => { el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", reset); reset(); };
}

/* ─── button FX: press ripple (delegated; sheen is pure CSS) ───── */
export function initButtonFX(){
  if (initButtonFX._done) return; initButtonFX._done = true;
  document.addEventListener("pointerdown", (e) => {
    if (reduce()) return;
    const btn = e.target.closest(".btn, .lz-fx");
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const rip = document.createElement("span");
    rip.className = "lz-ripple";
    const d = Math.max(r.width, r.height);
    rip.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    btn.appendChild(rip);
    setTimeout(() => rip.remove(), 600);
  }, true);
}

/* ─── skeleton + empty-state primitives ───────────────────────── */
export function skeleton({ rows = 3, height = 44, gap = 8, radius = 12 } = {}){
  let h = "";
  for (let i = 0; i < rows; i++) h += `<div class="lz-skel" style="height:${height}px;border-radius:${radius}px"></div>`;
  return `<div class="lz-skel-stack" style="gap:${gap}px" aria-busy="true" aria-label="Loading">${h}</div>`;
}
export function emptyState({ icon = "", title = "Nothing here yet", body = "", actionLabel = "", onAction = null } = {}){
  const el = document.createElement("div");
  el.className = "lz-empty";
  el.innerHTML = `${icon ? `<div class="lz-empty-icn">${icon}</div>` : ``}
    <div class="lz-empty-title">${escapeHtml(title)}</div>
    ${body ? `<div class="lz-empty-body">${escapeHtml(body)}</div>` : ``}
    ${actionLabel ? `<button type="button" class="btn ghost sm lz-empty-action">${escapeHtml(actionLabel)}</button>` : ``}`;
  if (actionLabel && onAction) el.querySelector(".lz-empty-action").addEventListener("click", onAction);
  return el;
}

/* ─── util ─────────────────────────────────────────────────────── */
export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* auto-init press ripple, and expose a global for non-module callers */
initButtonFX();
window.LZUI = { CustomSelect, coinAvatar, coinAvatarHTML, magnetic, initButtonFX, skeleton, emptyState, fuzzyScore, escapeHtml };
