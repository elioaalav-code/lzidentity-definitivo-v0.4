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
 * Deterministic on-brand avatar: curated brand colours for ~45 top
 * perps; hash-hue fallback for everything else.
 * Returns a single <span class="lz-avatar"> element (no network).
 *
 * Public contract (do NOT change):
 *   coinAvatar(symbol, size = 30)      → DOM element
 *   coinAvatarHTML(symbol, size = 30)  → outerHTML string
 *   Element class: "lz-avatar"
 *   CSS custom props: --av-size, --av-bg, --av-fg, --av-ring
 */

/* fallback palette — 7 perceptually-spread hues */
const AVATAR_HUES = [
  { bg: "rgba(179,154,255,.16)", fg: "#cbb8ff", ring: "rgba(179,154,255,.34)" }, // violet (accent)
  { bg: "rgba(94,234,212,.15)",  fg: "#7ff0dd", ring: "rgba(94,234,212,.32)" },  // teal (accent-2)
  { bg: "rgba(255,122,89,.15)",  fg: "#ff9f86", ring: "rgba(255,122,89,.32)" },  // warm (accent-3)
  { bg: "rgba(124,142,248,.16)", fg: "#9fb0ff", ring: "rgba(124,142,248,.34)" }, // indigo
  { bg: "rgba(40,160,240,.15)",  fg: "#6cc2f7", ring: "rgba(40,160,240,.32)" },  // sky
  { bg: "rgba(134,239,172,.14)", fg: "#9df0bd", ring: "rgba(134,239,172,.3)" },  // green
  { bg: "rgba(253,230,138,.14)", fg: "#f3dd96", ring: "rgba(253,230,138,.3)" },  // amber
];

/* curated brand map: real signature colours per project.
 * bg / fg / ring are raw CSS colour strings.
 * glyph overrides the monogram for a select few with universal glyphs. */
const BRAND_MAP = {
  // Bitcoin family
  BTC:  { bg:"rgba(247,147,26,.18)",   fg:"#f7931a", ring:"rgba(247,147,26,.38)",  glyph:"₿" },
  LTC:  { bg:"rgba(190,190,190,.14)",  fg:"#c8c8c8", ring:"rgba(190,190,190,.30)", glyph:"Ł" },
  BCH:  { bg:"rgba(36,202,38,.16)",    fg:"#24ca26", ring:"rgba(36,202,38,.34)" },

  // Ethereum family
  ETH:  { bg:"rgba(98,114,252,.18)",   fg:"#8b9dff", ring:"rgba(98,114,252,.36)",  glyph:"Ξ" },
  ARB:  { bg:"rgba(40,160,240,.16)",   fg:"#6cc2f7", ring:"rgba(40,160,240,.34)" },
  OP:   { bg:"rgba(255,4,32,.18)",     fg:"#ff5f70", ring:"rgba(255,4,32,.36)" },
  UNI:  { bg:"rgba(255,0,122,.17)",    fg:"#ff5fa3", ring:"rgba(255,0,122,.35)" },
  AAVE: { bg:"rgba(184,73,255,.16)",   fg:"#d08eff", ring:"rgba(184,73,255,.34)" },
  MKR:  { bg:"rgba(27,166,114,.15)",   fg:"#36d68a", ring:"rgba(27,166,114,.32)" },
  SNX:  { bg:"rgba(0,209,255,.14)",    fg:"#5de4ff", ring:"rgba(0,209,255,.30)" },
  CRV:  { bg:"rgba(255,100,0,.15)",    fg:"#ff8040", ring:"rgba(255,100,0,.32)" },

  // Solana ecosystem
  SOL:  { bg:"rgba(153,69,255,.18)",   fg:"#c084fc", ring:"rgba(153,69,255,.36)" },
  JUP:  { bg:"rgba(196,156,0,.16)",    fg:"#f5c842", ring:"rgba(196,156,0,.34)" },
  WIF:  { bg:"rgba(101,210,255,.14)",  fg:"#6dd6ff", ring:"rgba(101,210,255,.30)" },
  BONK: { bg:"rgba(234,127,27,.17)",   fg:"#f4933a", ring:"rgba(234,127,27,.34)" },
  KBONK:{ bg:"rgba(234,127,27,.17)",   fg:"#f4933a", ring:"rgba(234,127,27,.34)" },
  BOME: { bg:"rgba(80,190,70,.14)",    fg:"#72e663", ring:"rgba(80,190,70,.30)" },

  // BNB chain
  BNB:  { bg:"rgba(243,186,47,.18)",   fg:"#f3ba2f", ring:"rgba(243,186,47,.36)" },

  // Meme coins
  DOGE: { bg:"rgba(194,166,51,.18)",   fg:"#d4b93c", ring:"rgba(194,166,51,.36)", glyph:"Ð" },
  SHIB: { bg:"rgba(230,57,11,.17)",    fg:"#ff7048", ring:"rgba(230,57,11,.34)" },
  PEPE: { bg:"rgba(106,183,77,.16)",   fg:"#8ee86a", ring:"rgba(106,183,77,.32)" },
  KPEPE:{ bg:"rgba(106,183,77,.16)",   fg:"#8ee86a", ring:"rgba(106,183,77,.32)" },
  FLOKI:{ bg:"rgba(246,165,41,.16)",   fg:"#f8c05a", ring:"rgba(246,165,41,.32)" },

  // XRP / Ripple
  XRP:  { bg:"rgba(60,170,232,.16)",   fg:"#7dcfef", ring:"rgba(60,170,232,.32)" },

  // Cardano
  ADA:  { bg:"rgba(0,51,173,.20)",     fg:"#6ea0ff", ring:"rgba(0,51,173,.38)" },

  // Avalanche
  AVAX: { bg:"rgba(232,65,66,.18)",    fg:"#f07272", ring:"rgba(232,65,66,.36)" },

  // Polkadot
  DOT:  { bg:"rgba(230,0,122,.17)",    fg:"#f56bba", ring:"rgba(230,0,122,.34)" },

  // Chainlink
  LINK: { bg:"rgba(55,91,210,.17)",    fg:"#7fa4f7", ring:"rgba(55,91,210,.34)" },

  // Polygon / POL
  MATIC:{ bg:"rgba(130,71,229,.18)",   fg:"#b18af5", ring:"rgba(130,71,229,.36)" },
  POL:  { bg:"rgba(130,71,229,.18)",   fg:"#b18af5", ring:"rgba(130,71,229,.36)" },

  // Sui
  SUI:  { bg:"rgba(78,132,240,.17)",   fg:"#8ab8f8", ring:"rgba(78,132,240,.34)" },

  // Aptos
  APT:  { bg:"rgba(0,193,175,.15)",    fg:"#3ee8d4", ring:"rgba(0,193,175,.30)" },

  // Cosmos ecosystem
  ATOM: { bg:"rgba(110,88,184,.17)",   fg:"#b39aff", ring:"rgba(110,88,184,.34)" },
  TIA:  { bg:"rgba(113,47,255,.17)",   fg:"#b084ff", ring:"rgba(113,47,255,.34)" },
  OSMO: { bg:"rgba(98,0,234,.16)",     fg:"#c084fc", ring:"rgba(98,0,234,.32)" },

  // Near
  NEAR: { bg:"rgba(0,236,151,.14)",    fg:"#2eebb0", ring:"rgba(0,236,151,.30)" },

  // Injective
  INJ:  { bg:"rgba(0,148,212,.16)",    fg:"#4fc8f8", ring:"rgba(0,148,212,.32)" },

  // Sei
  SEI:  { bg:"rgba(255,68,68,.16)",    fg:"#ff8888", ring:"rgba(255,68,68,.32)" },

  // TON
  TON:  { bg:"rgba(8,168,238,.16)",    fg:"#5bcfff", ring:"rgba(8,168,238,.32)" },

  // TRX / Tron
  TRX:  { bg:"rgba(255,6,10,.17)",     fg:"#ff5f60", ring:"rgba(255,6,10,.34)" },

  // WLD / Worldcoin
  WLD:  { bg:"rgba(0,0,0,.30)",        fg:"#e0e0e0", ring:"rgba(255,255,255,.18)" },

  // FET / Fetch.ai → ASI now but still trades as FET
  FET:  { bg:"rgba(0,200,220,.14)",    fg:"#4de8f7", ring:"rgba(0,200,220,.30)" },

  // Render
  RENDER:{ bg:"rgba(255,60,0,.16)",    fg:"#ff855e", ring:"rgba(255,60,0,.32)" },

  // TAO / Bittensor
  TAO:  { bg:"rgba(140,198,63,.15)",   fg:"#aae656", ring:"rgba(140,198,63,.30)" },

  // ENA / Ethena
  ENA:  { bg:"rgba(51,51,255,.16)",    fg:"#8080ff", ring:"rgba(51,51,255,.32)" },

  // ORDI
  ORDI: { bg:"rgba(247,147,26,.15)",   fg:"#f0a84e", ring:"rgba(247,147,26,.30)" },

  // STX / Stacks
  STX:  { bg:"rgba(90,60,240,.17)",    fg:"#a48df5", ring:"rgba(90,60,240,.34)" },
};

/* ─── real coin logos (inline SVG, zero-network) ──────────────────
 * Curated vector marks for the most-traded perps. Each entry:
 *   svg   — inner markup, drawn in `currentColor` (set per mode below)
 *   solid — optional hex: fills the disc with the brand colour and
 *           draws the mark in white (real "token icon" look).
 *           When absent, the mark is drawn in the brand --av-fg on the
 *           usual dark tinted disc (best for light-coloured brands).
 * viewBox is always 0 0 24 24. Everything else falls back to the
 * monogram/glyph avatar — the contract is unchanged. */
const LOGO = {
  BTC: { solid:"#f7931a", svg:'<text x="12" y="12.6" text-anchor="middle" dominant-baseline="central" font-family="var(--mono),ui-monospace,monospace" font-weight="700" font-size="15" fill="currentColor">₿</text>' },
  ETH: { solid:"#5b6ef0", svg:'<path fill="currentColor" d="M12 2.4 12 9.7 18.2 12.3Z"/><path fill="currentColor" fill-opacity=".7" d="M12 2.4 5.8 12.3 12 9.7Z"/><path fill="currentColor" fill-opacity=".9" d="M12 15.9 12 21.6 18.2 13.6Z"/><path fill="currentColor" fill-opacity=".55" d="M12 15.9 5.8 13.6 12 21.6Z"/>' },
  SOL: { solid:"#9945ff", svg:'<path fill="currentColor" d="M7 7.1H17.5l-1.9 2H5.1z"/><path fill="currentColor" d="M5.1 10.9H15.6l1.9 2H7z"/><path fill="currentColor" d="M7 14.7H17.5l-1.9 2H5.1z"/>' },
  AVAX:{ solid:"#e84142", svg:'<path fill="currentColor" d="M12 5.4 19.2 17.6H4.8z"/>' },
  LINK:{ solid:"#2a5ada", svg:'<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" d="M12 4.6 18 8.1v6.9L12 18.5 6 15V8.1z"/>' },
  DOT: { solid:"#e6007a", svg:'<g fill="currentColor"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/><circle cx="17.6" cy="8.75" r="1.7"/><circle cx="6.4" cy="8.75" r="1.7"/><circle cx="17.6" cy="15.25" r="1.7"/><circle cx="6.4" cy="15.25" r="1.7"/></g>' },
  SUI: { solid:"#4da2ff", svg:'<path fill="currentColor" d="M12 4.2S6.6 10.6 6.6 14.6a5.4 5.4 0 0 0 10.8 0C17.4 10.6 12 4.2 12 4.2z"/>' },
  TON: { solid:"#0098ea", svg:'<path fill="currentColor" fill-opacity=".9" d="M12 4.6 19 9 12 19.6 5 9z"/><path fill="#0098ea" d="M9 8.9h6v1.5h-2.2v6.1h-1.6v-6.1H9z"/>' },
  BNB: { svg:'<g fill="currentColor"><path d="M12 4l2.4 2.4L12 8.8 9.6 6.4z"/><path d="M12 15.2l2.4 2.4L12 20l-2.4-2.4z"/><path d="M6.6 9.6 9 12l-2.4 2.4L4.2 12z"/><path d="M17.4 9.6 19.8 12l-2.4 2.4L15 12z"/><path d="M12 9.6 14.4 12 12 14.4 9.6 12z"/></g>' },
};

function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/* rgba helper for ring tint from a hex brand colour */
function hexA(hex, a){
  const m = hex.replace("#",""); const n = parseInt(m, 16);
  const r = (n>>16)&255, g = (n>>8)&255, b = n&255;
  return `rgba(${r},${g},${b},${a})`;
}

export function coinAvatar(symbol, size = 30){
  /* normalise: strip leading "k" for kPEPE/kBONK variants, uppercase */
  const raw = String(symbol || "?").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "?";
  /* check kXXX variants: map kPEPE → KPEPE key so brand map can handle them */
  const brand = BRAND_MAP[raw] || null;
  const hue   = brand || AVATAR_HUES[hashStr(raw) % AVATAR_HUES.length];
  const logo  = LOGO[raw] || null;

  /* ── real vector logo path ─────────────────────────────────── */
  if (logo){
    const el = document.createElement("span");
    el.className = "lz-avatar lz-avatar--branded lz-avatar--logo" + (logo.solid ? " lz-avatar--solid" : "");
    el.setAttribute("aria-hidden", "true");
    const bg   = logo.solid ? logo.solid : hue.bg;
    const fg   = logo.solid ? "#fff"     : hue.fg;
    const ring = logo.solid ? hexA(logo.solid, .55) : hue.ring;
    el.style.cssText = `--av-size:${size}px;--av-bg:${bg};--av-fg:${fg};--av-ring:${ring};`;
    el.innerHTML = `<svg class="lz-avatar-glyph" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${logo.svg}</svg>`;
    return el;
  }

  /* glyph: use brand override (₿ Ξ Ł Ð) or fall back to 1–3 letter monogram */
  const mono = brand && brand.glyph ? brand.glyph
    : (raw.length <= 3 ? raw : raw.slice(0, 3));

  /* font-size: glyphs and 1-char are larger; 2-char normal; 3-char compact */
  const charCount = [...mono].length; // handle multi-byte glyphs correctly
  const fs = charCount === 1 ? size * 0.46
           : charCount === 2 ? size * 0.40
           :                   size * 0.32;

  /* letter-spacing: tight for 3-char, normal for 1–2 */
  const ls = charCount >= 3 ? "-.03em" : "-.01em";

  const el = document.createElement("span");
  el.className = "lz-avatar" + (brand ? " lz-avatar--branded" : "");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    `--av-size:${size}px;--av-bg:${hue.bg};--av-fg:${hue.fg};--av-ring:${hue.ring};` +
    `font-size:${fs.toFixed(1)}px;letter-spacing:${ls};`;
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
