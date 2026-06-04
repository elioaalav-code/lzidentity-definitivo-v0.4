import { mountShader } from "./shader.js";
import { magnetic } from "./ui.js";
import {
  awaitCrypto, bootstrapWallet, connectWallet, disconnectWallet, deriveNostr,
  onChange, state, shortAddr, toast, clockTickerUTC,
} from "./shared.js";

/* preloader fade — non-module fallback already runs, this is the happy-path */
window.addEventListener("load", () => setTimeout(() => document.getElementById("preloader")?.classList.add("gone"), 500));

/* clocks */
const gmtEl = document.getElementById("gmt");
if (gmtEl) clockTickerUTC(gmtEl);

/* nav: scroll-aware — solid past 24px, condensed once past the hero fold */
const nav = document.getElementById("nav");
let lastNavY = -1;
const onScrollNav = () => {
  const y = window.scrollY;
  if (y === lastNavY) return;
  lastNavY = y;
  nav?.classList.toggle("solid", y > 24);
  nav?.classList.toggle("condensed", y > 120);
};
window.addEventListener("scroll", onScrollNav, { passive:true });
onScrollNav();

/* reveal on scroll — fire ~70% threshold (P7) and stagger siblings at
   log-ish spacing so groups breathe in rather than snap (P2/P3). */
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const el = e.target;
    // stagger by position among data-reveal siblings in the same parent
    const sibs = [...(el.parentElement?.querySelectorAll(":scope > [data-reveal]") || [])];
    const idx = Math.max(0, sibs.indexOf(el));
    el.style.setProperty("--reveal-delay", `${Math.min(idx, 6) * 90}ms`);
    el.classList.add("in");
    io.unobserve(el);
  });
}, { threshold:0.18, rootMargin:"0px 0px -12% 0px" });
document.querySelectorAll("[data-reveal]").forEach(el => io.observe(el));

/* marquee */
const TICKS = [
  { t:"inflight",  l:"INFLIGHT",  m:"0x9f12…a88c · ARB → OP · LayerZero v2" },
  { t:"delivered", l:"DELIVERED", m:"mesh:7h3…91b · 3 hops · -54 dBm" },
  { t:"wrapped",   l:"WRAPPED",   m:"nevent1…q4m · relay.damus.io · NIP-44" },
  { t:"peer",      l:"PEER JOIN", m:"npub1k9v…3xr · @riverops · mesh nearby" },
  { t:"block",     l:"BLOCK",     m:"#229,841,007 · 8.2 gwei · 36 ms" },
  { t:"inflight",  l:"INFLIGHT",  m:"0x4ec2…b021 · OP → ETH · OFTv2 enc" },
  { t:"delivered", l:"DELIVERED", m:"npub17ae…mu5 · gift-wrap · 41s" },
  { t:"peer",      l:"PEER LEFT", m:"npub1xrf…8aa · RSSI -84 → idle" },
  { t:"wrapped",   l:"WRAPPED",   m:"nevent1…lph · relay.snort.social · NIP-59" },
  { t:"block",     l:"BLOCK",     m:"#229,841,008 · 8.1 gwei · 12 tx batched" },
];
const mq = document.getElementById("mqTrack");
if (mq){
  const html = TICKS.map(x => `<span class="row"><span class="tag ${x.t}">${x.l}</span>${x.m}</span>`).join("");
  mq.innerHTML = html + html;
}

/* hero shader */
const canvas = document.getElementById("glCanvas");
if (canvas) mountShader(canvas);

/* magnetic hover on the marquee headline CTAs (hero + finale).
   magnetic() self-disables under reduced motion. */
document.querySelectorAll(".hero .btn.accent, .finale .btn.accent, .wt-intro .btn.accent")
  .forEach(btn => magnetic(btn));

/* respect reduced-motion across landing micro-interactions */
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* counters */
const counters = document.querySelectorAll("[data-counter]");
const animateCounter = (el) => {
  const target = parseFloat(el.dataset.counter);
  const decimals = parseInt(el.dataset.decimals || "0");
  const fmt = (v) => decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString("en-US");
  if (reduceMotion){ el.textContent = fmt(target); return; }
  const dur = 1800; const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(target * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
const cio = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting){ animateCounter(e.target); cio.unobserve(e.target); }});
}, { threshold:0.4 });
counters.forEach(c => cio.observe(c));

/* hero meta pseudo-live — keep each value true to its own label */
let block = 229841007, latency = 240;
setInterval(() => {
  block += 1;
  latency = Math.max(180, Math.min(320, latency + Math.round((Math.random() - 0.5) * 40)));
  const m3 = document.getElementById("m3"); if (m3) m3.textContent = `ARB ⇄ OP · ${latency} ms`;
  const m4 = document.getElementById("m4"); if (m4) m4.textContent = "#" + block.toLocaleString("en-US");
}, 4000);

/* phone clock sync */
function tickPhoneClocks(){
  const d = new Date();
  const s = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  for (let i=0;i<4;i++){ const el = document.getElementById("sbT"+i); if (el) el.textContent = s; }
}
tickPhoneClocks(); setInterval(tickPhoneClocks, 30000);

/* easter egg */
let clicks = 0, ttimer = null;
const brand = document.querySelector(".brand");
if (brand){
  brand.addEventListener("click", (e) => {
    e.preventDefault();
    clicks++; clearTimeout(ttimer);
    ttimer = setTimeout(() => clicks = 0, 700);
    if (clicks >= 3){
      document.body.style.filter = document.body.style.filter ? "" : "invert(1) hue-rotate(180deg)";
      toast(document.body.style.filter ? "panic mode · inverted" : "panic mode off", "ok");
      clicks = 0;
    }
  });
}

/* ----- WALKTHROUGH scroll-driven scenes ----- */
const wtWrap = document.querySelector(".wt-pin-wrap");
const screens = [...document.querySelectorAll(".wt-screen")];
const panels  = [...document.querySelectorAll(".wt-scene-panel")];
const segs    = [...document.querySelectorAll(".wt-progress .seg")];
const SCENES  = screens.length;

let currentScene = -1;
function setScene(idx, frac){
  if (idx !== currentScene){
    screens.forEach((s,i) => s.classList.toggle("on", i === idx));
    panels.forEach((p,i)  => p.classList.toggle("on", i === idx));
    currentScene = idx;
  }
  segs.forEach((s,i) => {
    s.classList.remove("done","cur");
    s.style.removeProperty("--p");
    if (i < idx) s.classList.add("done");
    else if (i === idx){ s.classList.add("cur"); s.style.setProperty("--p", Math.max(0, Math.min(1, frac)).toFixed(3)); }
  });
}
let rafScene = null;
function onWtScroll(){
  if (!wtWrap) return;
  if (rafScene) return;
  rafScene = requestAnimationFrame(() => {
    rafScene = null;
    const rect = wtWrap.getBoundingClientRect();
    const total = wtWrap.offsetHeight - window.innerHeight;
    const scrolled = Math.max(0, Math.min(total, -rect.top));
    const p = total > 0 ? scrolled / total : 0;
    const idx = Math.min(SCENES - 1, Math.floor(p * SCENES));
    const frac = (p * SCENES) - idx;
    setScene(idx, frac);
  });
}
window.addEventListener("scroll", onWtScroll, { passive:true });
window.addEventListener("resize", onWtScroll);
setScene(0, 0);

/* ----- WALLET CONNECT in nav ----- */
const connectBtn = document.getElementById("connectBtn");
const connLabel  = document.getElementById("connLabel");
const connDot    = document.getElementById("connDot");

function reflectNav(){
  if (!connectBtn) return;
  if (state.account){
    connLabel.textContent = shortAddr(state.account);
    connDot.style.display = "inline-block";
    connectBtn.classList.remove("ghost"); connectBtn.classList.add("accent");
  } else {
    connLabel.textContent = "Connect Wallet";
    connDot.style.display = "none";
    connectBtn.classList.add("ghost"); connectBtn.classList.remove("accent");
  }
  reflectMagicBox();
}

connectBtn?.addEventListener("click", async () => {
  if (state.account){ disconnectWallet(); toast("disconnected"); return; }
  if (!window.ethereum){ toast("install MetaMask or Rabby", "err"); return; }
  try {
    const a = await connectWallet();
    toast(`connected · ${shortAddr(a)}`, "ok");
  } catch (e){
    toast(e?.message === "no_provider" ? "no wallet detected" : "connect rejected", "err");
  }
});

/* ----- MAGIC BOX ----- */
const evmAddrEl = document.getElementById("evmAddr");
const evmChipEl = document.getElementById("evmChip");
const nodeEvm   = document.getElementById("nodeEvm");
const hashOut   = document.getElementById("hashOut");
const hashChip  = document.getElementById("hashChip");
const npubOut   = document.getElementById("npubOut");
const npubChip  = document.getElementById("npubChip");
const nodeHash  = document.getElementById("nodeHash");
const nodeNpub  = document.getElementById("nodeNpub");
const arr1      = document.getElementById("arr1");
const arr2      = document.getElementById("arr2");
const deriveBtn = document.getElementById("deriveBtn");
const resetBtn  = document.getElementById("resetBtn");
const mbStatus  = document.getElementById("mbStatus");

function setMB(msg, cls=""){
  if (!mbStatus) return;
  mbStatus.textContent = msg;
  mbStatus.className = "mb-status" + (cls ? " " + cls : "");
}

function reflectMagicBox(){
  if (!evmAddrEl) return;
  if (state.account){
    evmAddrEl.textContent = state.account;
    evmAddrEl.classList.remove("dim");
    evmChipEl.textContent = state.derived ? "linked · derived" : "ready · awaiting signature";
    nodeEvm.classList.add("live");
    if (!state.derived) setMB("Wallet connected. Click \"Sign & derive\" to generate your Nostr key.");
  } else {
    evmAddrEl.textContent = "— not connected —";
    evmAddrEl.classList.add("dim");
    evmChipEl.textContent = "awaiting connect";
    nodeEvm.classList.remove("live");
    setMB("Connect a wallet, then click \"Sign & derive\" to generate your Nostr key.");
  }
  if (state.derived){
    hashOut.textContent = "0x" + state.derived.priv;
    hashOut.classList.remove("dim");
    hashChip.textContent = "32 bytes · seed";
    nodeHash.classList.add("live"); arr1.classList.add("lit");
    npubOut.textContent = state.derived.npub;
    npubOut.classList.remove("dim");
    npubChip.textContent = "derived · live";
    nodeNpub.classList.add("live"); arr2.classList.add("lit");
    resetBtn.style.display = "inline-flex";
    setMB("Derived. This npub belongs to your EVM wallet — deterministic & repeatable.", "ok");
  } else {
    hashOut.textContent = "···"; hashOut.classList.add("dim");
    hashChip.textContent = "idle";
    nodeHash.classList.remove("live"); arr1.classList.remove("lit");
    npubOut.textContent = "npub1···"; npubOut.classList.add("dim");
    npubChip.textContent = "idle";
    nodeNpub.classList.remove("live"); arr2.classList.remove("lit");
    if (resetBtn) resetBtn.style.display = "none";
  }
}

deriveBtn?.addEventListener("click", async () => {
  if (!(await awaitCrypto())){
    setMB("Crypto libraries failed to load. Refresh to retry.", "err");
    toast("crypto libs not loaded", "err");
    return;
  }
  if (!state.account){
    try { await connectWallet(); }
    catch { toast("connect rejected", "err"); return; }
  }
  try {
    setMB("Open your wallet and sign the message …", "busy");
    nodeEvm.classList.add("live");
    await deriveNostr();
    toast(`derived · ${state.derived.npub.slice(0,16)}…`, "ok");
  } catch (e){
    console.error(e);
    setMB(/reject/i.test(e?.message || "") ? "Signature rejected." : "Derivation failed: " + (e?.message || e), "err");
    toast("derivation failed", "err");
  }
});

resetBtn?.addEventListener("click", () => {
  disconnectWallet();
  toast("identity cleared");
});

/* footer placeholder links — acknowledge instead of jumping to top */
document.querySelectorAll("a[data-soon]").forEach((a) => {
  a.addEventListener("click", (e) => { e.preventDefault(); toast("that page is coming soon"); });
});

onChange(reflectNav);

bootstrapWallet().then(reflectNav);

/* ----- console brand ----- */
const css = "color:#b39aff;font-family:Geist Mono,monospace;font-size:11px";
console.log("%c  ┌─────────────────────────────┐", css);
console.log("%c  │  LZIDENTITY · one you,      │", css);
console.log("%c  │  every chain · v1.0         │", css);
console.log("%c  └─────────────────────────────┘", css);
console.log("%c  ↳ landing online · open /app.html for the app", "color:#5eead4;font-family:Geist Mono,monospace;font-size:10px");
