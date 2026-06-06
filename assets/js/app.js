import {
  awaitCrypto, bootstrapWallet, connectWallet, disconnectWallet, deriveNostr,
  onChange, state, shortAddr, shortNpub, toast, fmt, copyToClipboard,
} from "./shared.js";
import { CustomSelect, coinAvatarHTML, skeleton, emptyState } from "./ui.js";
import { mountSigil } from "./sigil.js";

const prefersReduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* =================================================================== *
 *  CLOCK
 * =================================================================== */
const clockEl = document.getElementById("clock");
function tickClock(){
  const d = new Date();
  clockEl.textContent = `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")} UTC`;
}
tickClock(); setInterval(tickClock, 1000);

/* =================================================================== *
 *  ROUTER (hash-based)
 * =================================================================== */
const ROUTES = ["chat","wallet","markets","trade","network","identity","recovery","coin"];
const views = Object.fromEntries(ROUTES.map(r => [r, document.querySelector(`.view[data-view="${r}"]`)]));
const sideNav  = document.getElementById("sideNav");
const navLinks = [...document.querySelectorAll(".side-nav a")];
const crumbHere = document.getElementById("crumbHere");

/* Sliding active-route indicator: a single pill that animates between
   nav items. Positioned absolutely inside .side-nav (which is position
   relative). On phones the nav is horizontal, so we track both axes. */
let navPill = null;
function ensureNavPill(){
  if (navPill || !sideNav) return;
  navPill = document.createElement("span");
  navPill.className = "side-nav-pill";
  navPill.setAttribute("aria-hidden", "true");
  sideNav.prepend(navPill);
}
function moveNavPill(link){
  ensureNavPill();
  if (!navPill || !link) return;
  // measure relative to the scrollable nav, accounting for its scroll offset
  navPill.style.transform =
    `translate(${link.offsetLeft}px, ${link.offsetTop}px)`;
  navPill.style.width  = `${link.offsetWidth}px`;
  navPill.style.height = `${link.offsetHeight}px`;
  navPill.classList.add("on");
}

function getRoute(){
  const h = (location.hash || "#/chat").replace(/^#\/?/, "");
  const r = h.split("/")[0];
  return ROUTES.includes(r) ? r : "chat";
}
/** Second hash segment, e.g. "#/coin/bitcoin" → "bitcoin". */
function getRouteParam(){
  const h = (location.hash || "").replace(/^#\/?/, "");
  return decodeURIComponent(h.split("/")[1] || "");
}
function setActive(route){
  for (const k of ROUTES){ views[k]?.classList.toggle("active", k === route); }
  let activeLink = null;
  navLinks.forEach(a => {
    const on = a.dataset.route === route;
    a.classList.toggle("active", on);
    if (on){ a.setAttribute("aria-current", "page"); activeLink = a; }
    else a.removeAttribute("aria-current");
  });
  moveNavPill(activeLink);
  // crumb transition: brief swap animation on change
  if (crumbHere.textContent !== route){
    crumbHere.classList.remove("swap");
    void crumbHere.offsetWidth; // reflow to restart the animation
    crumbHere.textContent = route;
    crumbHere.classList.add("swap");
  }
  document.title = `LZidentity · ${route}`;
  // each view's onEnter hook (app.js-owned views)
  ONROUTE[route]?.();
  // broadcast to feature modules (trade.js, assistant.js) that live outside this file
  window.dispatchEvent(new CustomEvent("lz:route", { detail: { route } }));
}
window.addEventListener("hashchange", () => setActive(getRoute()));
// keep the pill aligned through layout shifts (resize, font load)
window.addEventListener("resize", () => {
  const cur = navLinks.find(a => a.classList.contains("active"));
  if (cur) moveNavPill(cur);
});
if (!location.hash) location.hash = "#/chat";

/* =================================================================== *
 *  WALLET BUTTON (topbar)
 * =================================================================== */
const connectBtn = document.getElementById("connectBtn");
const connLabel  = document.getElementById("connLabel");
const connDot    = document.getElementById("connDot");
const walletAddrEl = document.getElementById("walletAddr");
const walletBanner = document.getElementById("walletBanner");

function reflectWalletButton(){
  if (state.account){
    connLabel.textContent = shortAddr(state.account);
    connDot.style.display = "inline-block";
    connectBtn.classList.remove("ghost"); connectBtn.classList.add("accent");
  } else {
    connLabel.textContent = "Connect Wallet";
    connDot.style.display = "none";
    connectBtn.classList.add("ghost"); connectBtn.classList.remove("accent");
  }
  walletAddrEl.textContent = state.account || "— not connected —";
  renderBanner();
  reflectIdentity();
  reflectIdentityDetails();
  reflectSigil();
}

function renderBanner(){
  if (state.account){ walletBanner.innerHTML = ""; return; }
  walletBanner.innerHTML = `
    <div class="connect-banner">
      <div class="icn">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.2"/></svg>
      </div>
      <div class="col">
        <h4>Connect to see your balances</h4>
        <p>Connect MetaMask or Rabby to read your real on-chain balances across Ethereum, Arbitrum, Optimism and Base.</p>
      </div>
      <button class="btn accent sm" id="bannerConnect">Connect Wallet</button>
    </div>
  `;
  document.getElementById("bannerConnect")?.addEventListener("click", connectFlow);
}

async function connectFlow(){
  if (state.account){ disconnectWallet(); toast("disconnected"); return; }
  if (!window.ethereum){ toast("install MetaMask or Rabby", "err"); return; }
  try {
    connectBtn.classList.add("is-connecting");
    connectBtn.setAttribute("aria-busy", "true");
    connLabel.textContent = "Connecting…";
    const a = await connectWallet();
    toast(`connected · ${shortAddr(a)}`, "ok");
  } catch { toast("connect rejected", "err"); }
  finally {
    connectBtn.classList.remove("is-connecting");
    connectBtn.removeAttribute("aria-busy");
    reflectWalletButton();
  }
}
connectBtn.addEventListener("click", connectFlow);

onChange(reflectWalletButton);
let lastWalletAddr = null;
onChange(() => { if (state.account !== lastWalletAddr){ lastWalletAddr = state.account; loadWallet(); } });

/* =================================================================== *
 *  CHAT VIEW
 * =================================================================== */
const CONVS = [
  { id:"maya",   name:"Maya Chen",       addr:"0x7A2d…91F0",  pres:"Mesh nearby · -54 dBm", layer:"mesh",  last:"Routing via Optimism. Cost under budget.", time:"2m",  unread:2, av:"MC",  cls:"" },
  { id:"atlas",  name:"Atlas DAO",       addr:"npub1…k9v",    pres:"Online via Nostr",       layer:"nostr", last:"New NIP-28 channel checkpoint published.",   time:"18m", unread:0, av:"AD",  cls:"b" },
  { id:"river",  name:"River Ops",       addr:"0x38Cd…A117",  pres:"Last seen 1h ago",       layer:"lz",    last:"LayerZero receipt finalized on Arbitrum.",   time:"1h",  unread:1, av:"RO",  cls:"c" },
  { id:"deck",   name:"Deck Crew",       addr:"0xF1A4…0237",  pres:"Mesh nearby",            layer:"mesh",  last:"Mesh test passed at -54 dBm.",               time:"3h",  unread:0, av:"DK",  cls:"d" },
  { id:"star",   name:"Stargate Relay",  addr:"npub1…q4m",    pres:"Relay · damus.io",       layer:"nostr", last:"Encrypted payload archived to relay.",       time:"5h",  unread:0, av:"SG",  cls:"e" },
  { id:"helix",  name:"Helix Bridge",    addr:"0x9Cf2…3a01",  pres:"Bridge online · arb⇄op", layer:"lz",    last:"OFTv2 quote: 0.018 ETH for 0.5 ETH bridge.",  time:"yest",unread:0, av:"HX",  cls:"" },
];

const THREADS = {
  maya: [
    { from:"them", text:"Hey — are you on the venue floor? My signal is rough.", meta:"10:36 · via Mesh · 2 hops", layer:"mesh" },
    { from:"you",  text:"Yes. Three peers within 80m. Falling back to Nostr if RSSI drops.", meta:"10:38 · via Auto", layer:"auto" },
    { from:"them", text:"Send the treasury settlement note cross-chain so finance can audit it.", meta:"10:39 · via Mesh", layer:"mesh" },
    { from:"you",  text:"Encrypted payload is inflight from Arbitrum to Optimism. 14s ETA.", meta:"10:42 · ARB → OP", layer:"lz", inflight:true },
  ],
  atlas: [
    { from:"them", text:"New NIP-28 channel checkpoint just published. Subscribe to atlas-ops.", meta:"09:24 · relay.damus.io", layer:"nostr" },
    { from:"you",  text:"Subscribed. Will mirror to my home relay.", meta:"09:30 · via Nostr", layer:"nostr" },
  ],
  river: [
    { from:"them", text:"LayerZero receipt finalized on Arbitrum. tx 0x9f12…a88c", meta:"08:14 · LZ v2", layer:"lz" },
    { from:"you",  text:"Got it. Confirming on Optimism side now.", meta:"08:14 · via Auto", layer:"auto" },
  ],
  deck:  [{ from:"them", text:"Mesh test passed at -54 dBm.", meta:"07:50 · mesh", layer:"mesh" }],
  star:  [{ from:"them", text:"Encrypted payload archived to relay.damus.io.", meta:"06:22 · nostr", layer:"nostr" }],
  helix: [{ from:"them", text:"OFTv2 quote: 0.018 ETH for a 0.5 ETH bridge.", meta:"yesterday · lz", layer:"lz" }],
};

let activeConv = "maya";
let composeLayer = "auto";

function renderChatList(filter=""){
  const items = document.getElementById("chatItems");
  const q = filter.toLowerCase();
  const matched = CONVS.filter(c => !q || c.name.toLowerCase().includes(q) || c.last.toLowerCase().includes(q));
  if (!matched.length){
    items.replaceChildren(emptyState({
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
      title: "No conversations",
      body: q ? `Nothing matches “${filter}”.` : "Your inbox is empty.",
    }));
    return;
  }
  items.innerHTML = matched.map((c, i) => `
    <div class="chat-item stagger-in ${c.id===activeConv?"active":""}" data-id="${c.id}" style="--i:${i}">
      <div class="av ${c.cls}">${c.av}</div>
      <div class="col">
        <div class="top"><span class="name">${c.name}</span><span class="time">${c.time}</span></div>
        <span class="msg">${c.last}</span>
        <div class="meta-row"><span class="tag ${c.layer}">${c.layer.toUpperCase()}</span></div>
      </div>
      ${c.unread ? `<span class="unread">${c.unread}</span>` : ""}
    </div>
  `).join("");
  items.querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", () => { activeConv = el.dataset.id; renderChatList(filter); renderThread(); });
  });
}

function renderThread(){
  const c = CONVS.find(x => x.id === activeConv);
  const root = document.getElementById("chatThread");
  if (!c){ root.innerHTML = ""; return; }
  const msgs = THREADS[c.id] || [];
  root.innerHTML = `
    <div class="thread-head">
      <div class="who">
        <div class="av">${c.av}</div>
        <div class="info"><span class="nm">${c.name}</span><span class="sub">${c.addr} · ${c.pres}</span></div>
      </div>
      <div class="meta">
        <span class="tag ${c.layer}">${c.layer.toUpperCase()}</span>
      </div>
    </div>
    <div class="thread-body" id="threadBody">
      ${msgs.map(m => `
        <div class="msg-bubble ${m.from} ${m.inflight?"inflight":""}">
          <div>${m.text}</div>
          <div class="meta"><span>${m.meta}</span></div>
        </div>
      `).join("")}
    </div>
    <div class="thread-compose">
      <div class="layer-picker" id="layerPicker">
        ${["auto","mesh","nostr","layerzero"].map(l => `<button data-l="${l}" class="${l===composeLayer?"on":""}">${l}</button>`).join("")}
      </div>
      <input type="text" id="composeInput" placeholder="Encrypted message via ${composeLayer}…" />
      <button class="btn accent sm" id="sendChatBtn">Send →</button>
    </div>
  `;
  document.getElementById("layerPicker").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => { composeLayer = b.dataset.l; renderThread(); });
  });
  document.getElementById("sendChatBtn").addEventListener("click", sendChatMsg);
  document.getElementById("composeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatMsg(); });
  const body = document.getElementById("threadBody"); body.scrollTop = body.scrollHeight;
}

function sendChatMsg(){
  const inp = document.getElementById("composeInput");
  const txt = inp.value.trim(); if (!txt) return;
  inp.value = "";
  const c = CONVS.find(x => x.id === activeConv);
  const layerKey = composeLayer === "layerzero" ? "lz" : composeLayer;
  const layerLabel = { mesh:"Mesh", nostr:"Nostr", lz:"LayerZero", auto:"Auto" }[layerKey] || "Auto";
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  THREADS[c.id] = (THREADS[c.id] || []).concat({
    from:"you", text:txt, meta:`${time} · via ${layerLabel}`, layer:layerKey, inflight: composeLayer === "layerzero"
  });
  renderThread();
  toast(`sent via ${layerLabel.toLowerCase()}`, "ok");
  // simulate a reply
  if (Math.random() < 0.5){
    setTimeout(() => {
      const replies = [
        "Got it. Routing back through the mesh.",
        "Confirmed. Receipt landed on Arbitrum.",
        "Stored on relay.damus.io · NIP-44 wrapped.",
        "Acknowledged. -54 dBm, clean signal.",
        "Ack. Will sync when next relay comes online.",
      ];
      THREADS[c.id].push({ from:"them", text:replies[Math.floor(Math.random()*replies.length)], meta:`${time} · via ${layerLabel}`, layer:layerKey });
      renderThread();
    }, 1400 + Math.random()*1200);
  }
}

document.getElementById("chatSearch")?.addEventListener("input", (e) => renderChatList(e.target.value));

/* =================================================================== *
 *  WALLET VIEW
 * =================================================================== */
/* Real on-chain balances: native ETH + native USDC across L1 + major L2s,
   read straight from public RPCs in the browser. No backend, no demo data. */
const WALLET_CHAINS = [
  { key:"eth",  name:"Ethereum", scout:"https://eth.blockscout.com",      rpc:"https://ethereum-rpc.publicnode.com",     usdc:"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { key:"arb",  name:"Arbitrum", scout:"https://arbitrum.blockscout.com", rpc:"https://arbitrum-one-rpc.publicnode.com", usdc:"0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { key:"op",   name:"Optimism", scout:"https://optimism.blockscout.com", rpc:"https://optimism-rpc.publicnode.com",     usdc:"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { key:"base", name:"Base",     scout:"https://base.blockscout.com",     rpc:"https://base-rpc.publicnode.com",          usdc:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
];
const SPAM_RX = /https?:|www\.|\.(com|io|xyz|app|org|net|fi|to|vip)\b|claim|reward|airdrop|voucher|visit|access|\$\s|\s/i;
const WALLET_ICN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.2"/></svg>`;
let walletTokens = [];        // [{sym,nm,chain,amount,price,usd}]
// chain key → { label, accent } for badges + allocation colours (network-free)
const CHAIN_META = {
  eth:  { label:"Ethereum", accent:"#7b8cff" },
  arb:  { label:"Arbitrum", accent:"#33a4f4" },
  op:   { label:"Optimism", accent:"#ff5d6c" },
  base: { label:"Base",     accent:"#4f7cff" },
};
const chainMeta = (k) => CHAIN_META[k] || { label:(k||"chain"), accent:"#b39aff" };
let walletLoading = false;
let ethPrice = 3700;
let walletRendered = false;

async function rpcCall(url, method, params){
  const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) });
  if (!r.ok) throw new Error("rpc " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
const hexToNum = (hex, dec) => { try { return Number(BigInt(hex || "0x0")) / 10 ** dec; } catch { return 0; } };

function totalUSD(){ return walletTokens.reduce((s,t) => s + t.usd, 0); }

/* Blockscout v2 (keyless): every ERC-20 the address holds, with symbol,
   decimals and a USD exchange rate — plus the native coin balance. */
const okJson = (r) => { if (!r.ok) throw new Error("scout " + r.status); return r.json(); };
async function scoutBalances(c, addr){
  const [acc, toks] = await Promise.all([
    fetch(`${c.scout}/api/v2/addresses/${addr}`).then(okJson),
    fetch(`${c.scout}/api/v2/addresses/${addr}/token-balances`).then(okJson),
  ]);
  const out = [];
  const nativeAmt = Number(acc?.coin_balance || 0) / 1e18;
  const nativeRate = Number(acc?.exchange_rate) || ethPrice;
  if (nativeAmt > 1e-6) out.push({ sym: "ETH", nm: c.name, chain: c.key, amount: nativeAmt, price: nativeRate, usd: nativeAmt * nativeRate });
  for (const t of (Array.isArray(toks) ? toks : [])){
    const tk = t.token || {};
    if ((tk.type || "") !== "ERC-20") continue;             // skip NFTs / ERC-1155
    const rate = Number(tk.exchange_rate);
    const dec = Number(tk.decimals);
    if (!rate || !Number.isFinite(dec)) continue;           // unpriced → almost always spam
    const sym = String(tk.symbol || "").trim();
    if (!sym || SPAM_RX.test(sym) || sym.length > 12) continue;
    const amt = Number(t.value) / 10 ** dec;
    const usd = amt * rate;
    if (!(usd >= 1) || usd > 1e7 || amt > 1e12) continue;   // dust + absurd-valuation/junk-supply guards
    out.push({ sym, nm: c.name, chain: c.key, amount: amt, price: rate, usd });
  }
  return out;
}
/* fallback when a chain's Blockscout is unavailable: native ETH + USDC via RPC */
async function rpcBalances(c, addr){
  const balData = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");
  const [nativeHex, usdcHex] = await Promise.all([
    rpcCall(c.rpc, "eth_getBalance", [addr, "latest"]).catch(() => "0x0"),
    rpcCall(c.rpc, "eth_call", [{ to: c.usdc, data: balData }, "latest"]).catch(() => "0x0"),
  ]);
  const eth = hexToNum(nativeHex, 18), usdc = hexToNum(usdcHex, 6);
  const out = [];
  if (eth  > 1e-6) out.push({ sym: "ETH",  nm: c.name, chain: c.key, amount: eth,  price: ethPrice, usd: eth * ethPrice });
  if (usdc > 0.01) out.push({ sym: "USDC", nm: c.name, chain: c.key, amount: usdc, price: 1,        usd: usdc });
  return out;
}

async function loadWallet(){
  if (!state.account){ walletTokens = []; walletLoading = false; renderWallet(); return; }
  walletLoading = true; renderWallet();
  try {
    const pr = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (pr.ok){ const pj = await pr.json(); ethPrice = pj.ethereum?.usd ?? ethPrice; }
  } catch { /* keep last */ }
  const addr = state.account;
  const all = [];
  await Promise.all(WALLET_CHAINS.map(async (c) => {
    try { all.push(...await scoutBalances(c, addr)); }
    catch { try { all.push(...await rpcBalances(c, addr)); } catch {} }
  }));
  all.sort((a, b) => b.usd - a.usd);
  walletTokens = all.slice(0, 30);
  walletLoading = false;
  renderWallet();
}

/* Portfolio allocation strip in the hero card, grouped by chain — shows
   where value sits across Ethereum / Arbitrum / Optimism / Base. */
function renderWalletAlloc(total){
  const el = document.getElementById("walletAlloc");
  const chip = document.getElementById("walTokCount");
  if (chip){
    if (walletTokens.length){
      const chains = new Set(walletTokens.map(t => t.chain)).size;
      chip.innerHTML = `<b>${walletTokens.length}</b> ${walletTokens.length === 1 ? "asset" : "assets"} · <b>${chains}</b> ${chains === 1 ? "chain" : "chains"}`;
      chip.hidden = false;
    } else { chip.hidden = true; }
  }
  if (!el) return;
  if (!total || !walletTokens.length){ el.innerHTML = ""; return; }

  const by = new Map();
  for (const t of walletTokens){
    const m = chainMeta(t.chain);
    const e = by.get(t.chain) || { label:m.label, accent:m.accent, usd:0 };
    e.usd += t.usd; by.set(t.chain, e);
  }
  const groups = [...by.values()].sort((a,b) => b.usd - a.usd);
  const segs = groups.map(g =>
    `<span class="wal-alloc-seg" style="flex-grow:${(g.usd/total).toFixed(4)};background:${g.accent}" title="${g.label} · ${((g.usd/total)*100).toFixed(1)}%"></span>`).join("");
  const legend = groups.slice(0, 4).map(g =>
    `<span class="wal-alloc-key"><i style="background:${g.accent}"></i>${g.label} <b>${((g.usd/total)*100).toFixed(0)}%</b></span>`).join("");
  el.innerHTML = `<div class="wal-alloc-bar">${segs}</div><div class="wal-alloc-legend">${legend}</div>`;
}

function renderWallet(){
  const totalEl = document.getElementById("walletTotal");
  const list = document.getElementById("tokenList");
  const txl = document.getElementById("txList");
  if (!totalEl || !list || !txl) return;

  if (!state.account){
    totalEl.innerHTML = `${fmt.usd(0)} <small id="walletDelta">— not connected</small>`;
    list.replaceChildren(emptyState({ icon: WALLET_ICN, title: "Connect a wallet",
      body: "Connect to see your real on-chain balances across Ethereum, Arbitrum, Optimism and Base.",
      actionLabel: "Connect Wallet", onAction: connectFlow }));
    txl.replaceChildren(emptyState({ title: "No activity yet", body: "Connect a wallet to see your balances here." }));
    renderWalletAlloc(0);
    return;
  }

  if (walletLoading && !walletTokens.length){
    totalEl.innerHTML = `${fmt.usd(0)} <small id="walletDelta">reading chain…</small>`;
    list.innerHTML = skeleton({ rows: 3, height: 62 });
    renderWalletAlloc(0);
  } else {
    const total = totalUSD();
    totalEl.innerHTML = `${fmt.usd(total)} <small id="walletDelta" class="wallet-live">live · on-chain</small>`;
    if (!walletTokens.length){
      list.replaceChildren(emptyState({ icon: WALLET_ICN, title: "No balances found",
        body: `No ETH or USDC on Ethereum, Arbitrum, Optimism or Base for ${shortAddr(state.account)}. Switch the wallet or top it up to see it here.` }));
    } else {
      list.innerHTML = walletTokens.map((t, i) => {
        const m = chainMeta(t.chain);
        const pct = total > 0 ? (t.usd / total) * 100 : 0;
        const amt = t.amount.toLocaleString("en-US", { maximumFractionDigits: t.sym === "ETH" ? 5 : 2 });
        return `
        <div class="token-row ${walletRendered ? "" : "stagger-in"}" style="--i:${i};--tk-accent:${m.accent}">
          ${coinAvatarHTML(t.sym, 44)}
          <div class="col">
            <span class="sym">${t.sym} <i class="tk-chain">${m.label}</i></span>
            <span class="nm">${amt} ${t.sym}</span>
            <span class="tk-share"><i style="width:${pct.toFixed(1)}%"></i></span>
          </div>
          <div class="amount"><span class="v">${fmt.usd(t.usd)}</span><span class="usd"><span class="tk-pct">${pct.toFixed(1)}%</span> · @ ${fmt.usd(t.price)}</span></div>
        </div>`;
      }).join("");
    }
    renderWalletAlloc(total);
  }
  // Real per-tx history needs an indexer (Etherscan/Alchemy key + CORS), which a
  // keyless static app can't do — so we show an honest note instead of fake txs.
  txl.replaceChildren(emptyState({ title: "Transaction history",
    body: "Live on-chain history needs an indexer API and isn't wired in this build. The balances above are real." }));
  walletRendered = true;
}

/* Replace the native <select>s with the shared CustomSelect. The hidden
   native element stays the source of truth, so the existing reads of
   `sendAsset.value` / `sendVia.value` keep working unchanged. */
const sendAssetSel = document.getElementById("sendAsset");
const sendViaSel   = document.getElementById("sendVia");
if (sendAssetSel){
  new CustomSelect({
    select: sendAssetSel,
    title: "Select asset",
    renderRow: (it) => `${coinAvatarHTML(it.value, 22)}<span class="lz-select-label">${it.label}</span>`,
    renderTrigger: (it) => `${coinAvatarHTML(it.value, 20)}<span class="lz-select-label">${it.label}</span>`,
  });
}
if (sendViaSel){
  new CustomSelect({ select: sendViaSel, title: "Select route" });
}

document.getElementById("walletRefresh")?.addEventListener("click", () => { loadWallet(); toast(state.account ? "reading balances…" : "connect a wallet first", state.account ? "ok" : "err"); });
document.getElementById("sendBtn")?.addEventListener("click", () => {
  const to = document.getElementById("sendTo").value.trim();
  const amt = document.getElementById("sendAmt").value.trim();
  const asset = document.getElementById("sendAsset").value;
  const via = document.getElementById("sendVia").value;
  if (!to || !amt){ toast("destination and amount required", "err"); return; }
  toast(`signed · ${amt} ${asset} → ${to.slice(0,10)}… via ${via}`, "ok");
  document.getElementById("sendTo").value = "";
  document.getElementById("sendAmt").value = "";
});

/* =================================================================== *
 *  MARKETS VIEW — real CoinGecko data
 * =================================================================== */
let marketsRows = [];
let marketsLoaded = false;
let demoNoticeShown = false;
const marketsView = { q: "", filter: "all" };   // search + gainers/losers filter

/* Apply the active search query + filter chip to the fetched coin list. */
function visibleMarkets(){
  const q = marketsView.q.trim().toLowerCase();
  let rows = marketsRows;
  if (q) rows = rows.filter(c =>
    (c.symbol || "").toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q));
  if (marketsView.filter === "gainers") rows = rows.filter(c => (c.price_change_percentage_24h || 0) > 0);
  else if (marketsView.filter === "losers") rows = rows.filter(c => (c.price_change_percentage_24h || 0) < 0);
  return rows;
}

/* Offline/rate-limited fallback so Markets is never an empty error screen. */
const wave = (base, amp) => Array.from({length:8}, (_,i) => base + Math.sin(i/1.4)*amp - i*amp*0.05);
const DEMO_MARKETS = [
  { market_cap_rank:1, image:"", symbol:"btc",  name:"Bitcoin",  current_price:92140, price_change_percentage_24h:1.4,  market_cap:1.82e12, sparkline_in_7d:{price:wave(90000,1400)} },
  { market_cap_rank:2, image:"", symbol:"eth",  name:"Ethereum", current_price:3698,  price_change_percentage_24h:2.4,  market_cap:4.45e11, sparkline_in_7d:{price:wave(3600,90)} },
  { market_cap_rank:3, image:"", symbol:"usdt", name:"Tether",   current_price:1.00,  price_change_percentage_24h:0.0,  market_cap:1.12e11, sparkline_in_7d:{price:wave(1,0.002)} },
  { market_cap_rank:4, image:"", symbol:"bnb",  name:"BNB",      current_price:612,   price_change_percentage_24h:-0.8, market_cap:8.9e10,  sparkline_in_7d:{price:wave(620,8).reverse()} },
  { market_cap_rank:5, image:"", symbol:"sol",  name:"Solana",   current_price:184.2, price_change_percentage_24h:-1.8, market_cap:8.4e10,  sparkline_in_7d:{price:wave(190,6).reverse()} },
  { market_cap_rank:6, image:"", symbol:"xrp",  name:"XRP",      current_price:0.62,  price_change_percentage_24h:3.1,  market_cap:3.5e10,  sparkline_in_7d:{price:wave(0.59,0.02)} },
  { market_cap_rank:7, image:"", symbol:"usdc", name:"USD Coin", current_price:1.00,  price_change_percentage_24h:0.0,  market_cap:3.3e10,  sparkline_in_7d:{price:wave(1,0.001)} },
  { market_cap_rank:8, image:"", symbol:"ada",  name:"Cardano",  current_price:0.45,  price_change_percentage_24h:1.1,  market_cap:1.6e10,  sparkline_in_7d:{price:wave(0.44,0.01)} },
];
let marketsDemo = false;
function useDemoMarkets(){
  marketsRows = DEMO_MARKETS;
  marketsDemo = true;
  renderMarkets();
  document.getElementById("kpiMcap").textContent = "$" + fmt.compact(2.41e12);
  document.getElementById("kpiVol").textContent  = "$" + fmt.compact(9.8e10);
  document.getElementById("kpiDom").textContent  = "53.6%";
  document.getElementById("kpiTracked").textContent = "12,840";
  document.getElementById("kpiMcapTr").textContent = fmt.pct(1.2);
  document.getElementById("kpiMcapTr").className = "tr";
  if (!demoNoticeShown){ toast("live feed busy · showing demo markets", 2200); demoNoticeShown = true; }
}

function sparkSVG(values, up){
  if (!values || values.length < 2) return "";
  const w = 100, h = 28, min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v,i) => `${(i/(values.length-1)*w).toFixed(2)},${(h - (v-min)/range*h).toFixed(2)}`).join(" ");
  const color = up ? "#86efac" : "#fda4af";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="1.4" points="${pts}"/>
  </svg>`;
}

async function fetchMarkets(){
  try {
    const rowsEl = document.getElementById("marketsRows");
    rowsEl.classList.remove("market-skel");
    rowsEl.innerHTML = skeleton({ rows: 8, height: 44, gap: 0, radius: 0 });
    const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h");
    if (!r.ok) throw new Error("rate-limited");
    marketsRows = await r.json();
    marketsLoaded = true;
    marketsDemo = false;
    renderMarkets();
    // KPIs from global endpoint
    try {
      const g = await fetch("https://api.coingecko.com/api/v3/global");
      const gj = (await g.json()).data;
      document.getElementById("kpiMcap").textContent = "$" + fmt.compact(gj.total_market_cap.usd);
      document.getElementById("kpiVol").textContent  = "$" + fmt.compact(gj.total_volume.usd);
      document.getElementById("kpiDom").textContent  = (gj.market_cap_percentage.btc).toFixed(1) + "%";
      const ch = gj.market_cap_change_percentage_24h_usd;
      document.getElementById("kpiMcapTr").textContent = fmt.pct(ch);
      document.getElementById("kpiMcapTr").className = "tr" + (ch >= 0 ? "" : " dn");
      document.getElementById("kpiVolTr").textContent = "global";
      document.getElementById("kpiTracked").textContent = gj.active_cryptocurrencies.toLocaleString("en-US");
    } catch {}
  } catch (e){
    // graceful degradation — show representative demo data instead of an error
    useDemoMarkets();
  }
}

function renderMarkets(){
  const root = document.getElementById("marketsRows");
  root.classList.remove("market-skel");
  // honest indicator on the table head when we're on fallback data
  document.querySelector('[data-view="markets"] .markets-table')
    ?.classList.toggle("is-demo", marketsDemo);
  if (!marketsRows.length){
    root.replaceChildren(emptyState({
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 9 11l4 4 8-8"/><path d="M14 7h7v7"/></svg>`,
      title: "No market data",
      body: "Couldn't load coins right now.",
      actionLabel: "Retry",
      onAction: fetchMarkets,
    }));
    const cnt = document.getElementById("mktCount"); if (cnt) cnt.textContent = "";
    return;
  }
  const rows = visibleMarkets();
  const cnt = document.getElementById("mktCount");
  if (cnt) cnt.innerHTML = `<b>${rows.length}</b> of ${marketsRows.length} coins`;
  if (!rows.length){
    root.replaceChildren(emptyState({
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
      title: "No coins match",
      body: marketsView.q ? `Nothing matches “${marketsView.q}”. Try another name or symbol.` : "No coins in this filter right now.",
    }));
    return;
  }
  root.innerHTML = rows.map((c, i) => {
    const up = (c.price_change_percentage_24h || 0) >= 0;
    const sparkUp = (c.sparkline_in_7d?.price?.[0] || 0) <= (c.sparkline_in_7d?.price?.at(-1) || 0);
    return `<div class="row stagger-in" data-id="${c.id ?? ""}" data-sym="${c.symbol}" data-name="${c.name}" role="button" tabindex="0" aria-haspopup="menu" style="--i:${i}">
      <span class="rk">#${c.market_cap_rank}</span>
      <div class="coin">${c.image ? `<img src="${c.image}" alt="" loading="lazy"/>` : `<span class="coin-badge">${c.symbol.slice(0,1).toUpperCase()}</span>`}<div class="nm"><span class="s">${c.symbol.toUpperCase()}</span><span class="n">${c.name}</span></div></div>
      <span class="pr">${fmt.usd(c.current_price)}</span>
      <span class="ch ${up?"up":"dn"}">${fmt.pct(c.price_change_percentage_24h)}</span>
      <span class="sk">${sparkSVG(c.sparkline_in_7d?.price, sparkUp)}</span>
      <span class="mc">${fmt.usd(c.market_cap)}</span>
    </div>`;
  }).join("");
}

document.getElementById("marketsRefresh")?.addEventListener("click", () => { fetchMarkets(); toast("refreshing markets…"); });

/* live search + gainers/losers filter (operate on already-fetched rows) */
document.getElementById("mktSearch")?.addEventListener("input", (e) => {
  marketsView.q = e.target.value || "";
  if (marketsRows.length) renderMarkets();
});
document.getElementById("mktFilters")?.addEventListener("click", (e) => {
  const chip = e.target.closest(".mkt-chip"); if (!chip) return;
  marketsView.filter = chip.dataset.filter || "all";
  document.querySelectorAll("#mktFilters .mkt-chip").forEach(b => {
    const on = b === chip; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (marketsRows.length) renderMarkets();
});

/* ----- market row → quick-actions menu (trade · external info) ----- */
let coinMenuEl = null, coinMenuKey = null;
function closeCoinMenu(){
  if (!coinMenuEl) return;
  document.removeEventListener("keydown", coinMenuKey);
  window.removeEventListener("scroll", closeCoinMenu, true);
  window.removeEventListener("resize", closeCoinMenu);
  coinMenuEl.remove(); coinMenuEl = null;
}
function openCoinMenu(row){
  closeCoinMenu();
  const sym  = (row.dataset.sym || "").toUpperCase();
  const name = row.dataset.name || sym;
  const id   = row.dataset.id && row.dataset.id !== "undefined" ? row.dataset.id : "";
  const coinRef = id || sym.toLowerCase();
  const m = document.createElement("div");
  m.className = "cmenu";
  m.setAttribute("role", "menu");
  m.setAttribute("aria-label", `${sym} actions`);
  m.innerHTML = `
    <div class="cmenu-head">${coinAvatarHTML(sym, 28)}<div class="cmenu-id"><span class="s">${sym}</span><span class="n">${name}</span></div></div>
    <button class="cmenu-item primary" data-act="trade" role="menuitem"><span>Trade ${sym} on Hyperliquid</span><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 13 13 3M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div class="cmenu-sep">Open full data</div>
    <button class="cmenu-item" data-act="open" role="menuitem"><span>${sym} overview · price, charts &amp; stats</span><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  document.body.appendChild(m);
  // anchor under the row, clamped to the viewport
  const r = row.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 12);
  let top  = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = Math.max(8, left) + "px";
  m.style.top  = top + "px";
  coinMenuEl = m;
  m.querySelector('[data-act="trade"]').addEventListener("click", () => {
    closeCoinMenu();
    window.LZ.navigate("trade");
    setTimeout(() => window.LZ.hl?.setCoin(sym), 80);
  });
  m.querySelector('[data-act="open"]').addEventListener("click", () => {
    closeCoinMenu();
    location.hash = `#/coin/${encodeURIComponent(coinRef)}`;
  });
  m.addEventListener("click", (e) => { if (e.target.closest("a")) closeCoinMenu(); });
  coinMenuKey = (e) => { if (e.key === "Escape"){ closeCoinMenu(); row.focus(); } };
  document.addEventListener("keydown", coinMenuKey);
  window.addEventListener("scroll", closeCoinMenu, true);
  window.addEventListener("resize", closeCoinMenu);
  requestAnimationFrame(() => { m.classList.add("in"); m.querySelector(".cmenu-item")?.focus(); });
}
document.getElementById("marketsRows")?.addEventListener("click", (e) => {
  const row = e.target.closest(".row[data-sym]");
  if (row){ e.stopPropagation(); openCoinMenu(row); }
});
document.getElementById("marketsRows")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " "){ const row = e.target.closest(".row[data-sym]"); if (row){ e.preventDefault(); openCoinMenu(row); } }
});
document.addEventListener("click", (e) => {
  if (coinMenuEl && !coinMenuEl.contains(e.target) && !e.target.closest(".row[data-sym]")) closeCoinMenu();
});

/* =================================================================== *
 *  NETWORK VIEW — simulated live stream
 * =================================================================== */
const STREAM_TEMPLATES = [
  () => ({ st:"inf", lab:"Inflight",  layer:"LayerZero", route:`${pick(["Arbitrum","Optimism","Ethereum"])} → ${pick(["Optimism","Arbitrum","Ethereum"])}`, hash:rhash("0x") }),
  () => ({ st:"dly", lab:"Delivered", layer:"BLE Mesh",  route:`${1+Math.floor(Math.random()*4)} hops · #mesh`,                                                hash:`mesh:${rhash("",6)}…${rhash("",3)}` }),
  () => ({ st:"wrp", lab:"Wrapped",   layer:"Nostr",     route:`${pick(["relay.damus.io","nostr.band","primal.net","relay.snort.social"])}`,                  hash:`nevent1${rhash("",5)}…${rhash("",3)}` }),
  () => ({ st:"dly", lab:"Delivered", layer:"LayerZero", route:`${pick(["Arbitrum","Optimism"])} ⇄ ${pick(["Optimism","Arbitrum"])}`,                         hash:rhash("0x") }),
];
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function rhash(prefix="0x", len=4){
  const a = "abcdef0123456789";
  let s = ""; for (let i=0;i<8;i++) s += a[Math.floor(Math.random()*16)];
  let e = ""; for (let i=0;i<len;i++) e += a[Math.floor(Math.random()*16)];
  return `${prefix}${s}…${e}`;
}
const initialStream = [
  { st:"inf", lab:"Inflight",  layer:"LayerZero", route:"Arbitrum → Optimism",  hash:"0x9f12…a88c", age:"now" },
  { st:"dly", lab:"Delivered", layer:"BLE Mesh",  route:"3 hops · #mesh",       hash:"mesh:7h3…91b", age:"12s" },
  { st:"wrp", lab:"Wrapped",   layer:"Nostr",     route:"relay.damus.io",       hash:"nevent1…q4m",  age:"41s" },
  { st:"dly", lab:"Delivered", layer:"LayerZero", route:"Optimism → Ethereum",  hash:"0x4ec2…b021",  age:"1m"  },
];
let streamPaused = false;

let streamRendered = false;
function renderStream(items){
  const root = document.getElementById("streamList");
  root.innerHTML = items.map((s,i) => `
    <div class="stream-item ${s.st==='inf'?'live':''} ${streamRendered ? "" : "stagger-in"}" style="--i:${i}">
      <span class="st ${s.st}">${s.lab}</span>
      <div class="col"><span class="h">${s.hash}</span><span class="r">${s.route}</span></div>
      <span class="lyr">${s.layer}</span>
      <span class="ag">${s.age||"now"}</span>
    </div>
  `).join("");
  streamRendered = true;
}
let stream = [...initialStream];
renderStream(stream);

setInterval(() => {
  if (streamPaused) return;
  // age existing
  stream = stream.map((s,i) => i === 0 ? { ...s, age: s.age === "now" ? "2s" : ageNext(s.age) } : { ...s, age: ageNext(s.age) });
  // add new
  if (Math.random() < 0.7){
    const t = STREAM_TEMPLATES[Math.floor(Math.random()*STREAM_TEMPLATES.length)]();
    stream.unshift({ ...t, age:"now" });
    if (stream.length > 18) stream.pop();
  }
  renderStream(stream);
  // update KPIs
  const inf = stream.filter(s => s.st === "inf").length;
  document.getElementById("netInf").textContent = inf;
  const msgs = parseInt(document.getElementById("netMsgs").textContent.replace(/,/g,"")) || 18432;
  document.getElementById("netMsgs").textContent = (msgs + Math.floor(Math.random()*3)).toLocaleString("en-US");
}, 2200);

function ageNext(a){
  if (a === "now") return "3s";
  const m = a.match(/^(\d+)([sm])$/);
  if (!m) return a;
  let n = parseInt(m[1]), u = m[2];
  if (u === "s"){ n += 3; if (n >= 60){ return "1m"; } return `${n}s`; }
  if (u === "m"){ n += 1; return `${n}m`; }
  return a;
}

document.getElementById("netPause")?.addEventListener("click", (e) => {
  streamPaused = !streamPaused;
  e.target.textContent = streamPaused ? "Resume stream" : "Pause stream";
  toast(streamPaused ? "stream paused" : "stream live", streamPaused ? "" : "ok");
});

/* =================================================================== *
 *  IDENTITY VIEW (magic box)
 * =================================================================== */
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

const idAddr = document.getElementById("idAddr");
const idNpub = document.getElementById("idNpub");
const idPriv = document.getElementById("idPriv");

function setMB(msg, cls=""){
  if (!mbStatus) return;
  mbStatus.textContent = msg;
  mbStatus.className = "mb-status" + (cls ? " " + cls : "");
}

function reflectIdentity(){
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
    setMB("Connect a wallet (top right), then click \"Sign & derive\".");
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
    if (resetBtn) resetBtn.style.display = "inline-flex";
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

function reflectIdentityDetails(){
  idAddr.textContent = state.account || "—";
  idAddr.classList.toggle("dim", !state.account);
  if (state.derived){
    idNpub.textContent = state.derived.npub; idNpub.classList.remove("dim");
    idPriv.textContent = "0x" + state.derived.priv; idPriv.classList.remove("dim");
  } else {
    idNpub.textContent = "npub1··· (derive first)"; idNpub.classList.add("dim");
    idPriv.textContent = "— (derive first)"; idPriv.classList.add("dim");
  }
}

/* The generative Sigil — materializes once an identity is derived. */
const sigilCanvas = document.getElementById("sigilCanvas");
const sigilHero   = document.getElementById("sigilHero");
let sigilHandle = null;
function reflectSigil(){
  if (!sigilCanvas || !sigilHero) return;
  if (state.derived){
    // (re)mount at the canvas' current visible size so the npub's sigil is live
    sigilHandle?.stop();
    sigilHandle = mountSigil(sigilCanvas, state.derived.npub);
    sigilHero.classList.add("born");
  } else {
    sigilHandle?.stop(); sigilHandle = null;
    sigilHero.classList.remove("born");
    const c = sigilCanvas.getContext("2d");
    if (c) c.clearRect(0, 0, sigilCanvas.width || 1, sigilCanvas.height || 1);
  }
}

const mbFlow = document.querySelector('[data-view="identity"] .mb-flow');
function setDeriving(on){
  mbFlow?.classList.toggle("deriving", on);
  if (deriveBtn) deriveBtn.classList.toggle("is-deriving", on);
}

deriveBtn?.addEventListener("click", async () => {
  if (!(await awaitCrypto())){ setMB("Crypto libraries failed to load.", "err"); toast("crypto libs not loaded", "err"); return; }
  if (!state.account){
    try { await connectWallet(); } catch { toast("connect rejected", "err"); return; }
  }
  try {
    // Anticipatory success: light up the pipeline the moment the wallet
    // popup opens, not only once the signature returns.
    setDeriving(true);
    setMB("Open your wallet and sign the message …", "busy");
    await deriveNostr();
    toast(`derived · ${state.derived.npub.slice(0,16)}…`, "ok");
  } catch (e){
    console.error(e);
    setMB(/reject/i.test(e?.message || "") ? "Signature rejected." : "Derivation failed: " + (e?.message || e), "err");
    toast("derivation failed", "err");
  } finally {
    setDeriving(false);
  }
});

resetBtn?.addEventListener("click", () => { disconnectWallet(); toast("identity cleared"); });

async function copyKind(k, host){
  let txt = "";
  if (k === "addr") txt = state.account || "";
  if (k === "npub") txt = state.derived?.npub || "";
  if (k === "priv") txt = state.derived ? "0x" + state.derived.priv : "";
  if (!txt){ toast("nothing to copy", "err"); return; }
  const ok = await copyToClipboard(txt);
  if (ok && host){
    host.classList.remove("copied"); void host.offsetWidth; host.classList.add("copied");
    setTimeout(() => host.classList.remove("copied"), 900);
  }
  toast(ok ? "copied to clipboard" : "copy failed", ok ? "ok" : "err");
}

document.querySelectorAll("[data-copy]").forEach(btn => {
  btn.addEventListener("click", () => copyKind(btn.dataset.copy, btn.closest(".id-row")));
});

/* Direct copy-to-clipboard affordance on the value chips themselves. */
function makeValueCopyable(el, kind){
  if (!el) return;
  el.classList.add("copyable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", `Copy ${kind === "addr" ? "EVM address" : "npub"}`);
  el.addEventListener("click", () => copyKind(kind, el.closest(".id-row")));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); copyKind(kind, el.closest(".id-row")); }
  });
}
makeValueCopyable(idAddr, "addr");
makeValueCopyable(idNpub, "npub");

/* =================================================================== *
 *  ROUTE HOOKS — onEnter
 * =================================================================== */
const ONROUTE = {
  chat: () => { renderChatList(""); renderThread(); },
  wallet: () => { loadWallet(); },
  markets: () => { if (!marketsLoaded) fetchMarkets(); else renderMarkets(); },
  network: () => {},
  identity: () => { reflectIdentity(); reflectIdentityDetails(); reflectSigil(); },
  coin: () => { window.LZ?.coinPage?.render(getRouteParam()); },
};

/* =================================================================== *
 *  BOOT
 * =================================================================== */
renderChatList("");
renderThread();
renderWallet();
bootstrapWallet().then(() => { reflectWalletButton(); });

setActive(getRoute());
// re-align the nav pill once fonts/layout settle (web-font swap shifts widths)
requestAnimationFrame(() => {
  const cur = navLinks.find(a => a.classList.contains("active"));
  if (cur) moveNavPill(cur);
});
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(() => {
    const cur = navLinks.find(a => a.classList.contains("active"));
    if (cur) moveNavPill(cur);
  });
}

/* =================================================================== *
 *  GLOBAL APP API — window.LZ
 *  A tiny surface the feature modules (trade.js, assistant.js) and the
 *  AI copilot use to drive the app: navigate tabs, read live state.
 * =================================================================== */
window.LZ = Object.assign(window.LZ || {}, {
  routes: ROUTES,
  navigate(route){
    if (!ROUTES.includes(route)) return false;
    location.hash = "#/" + route;
    return true;
  },
  currentRoute: getRoute,
  /** A compact snapshot the assistant can reason over. */
  snapshot(){
    return {
      route: getRoute(),
      wallet: state.account || null,
      npub: state.derived?.npub || null,
      identityDerived: !!state.derived,
      walletTotalUsd: Math.round(totalUSD()),
      tokens: walletTokens.map(t => ({ sym: t.sym, amount: t.amount, chain: t.nm, usd: Math.round(t.usd) })),
      topMarkets: marketsRows.slice(0, 6).map(c => ({ sym: (c.symbol||"").toUpperCase(), price: c.current_price, ch24h: c.price_change_percentage_24h })),
    };
  },
  /** Connected EOA, or null. For wallet-actions.js (swap/bridge/receive). */
  account: () => state.account || null,
  /** The L2/L1s the wallet scans, with rpc + usdc address. */
  walletChains: () => WALLET_CHAINS.map(c => ({ ...c })),
  /** Re-read on-chain balances (call after a swap/bridge settles). */
  reloadWallet: () => loadWallet(),
  toast,
});

/* ----- console brand ----- */
const css = "color:#b39aff;font-family:Geist Mono,monospace;font-size:11px";
console.log("%c  ┌─────────────────────────────┐", css);
console.log("%c  │  LZIDENTITY app · v2.1      │", css);
console.log("%c  │  chat · wallet · markets    │", css);
console.log("%c  │  trading · network          │", css);
console.log("%c  │  identity · recovery        │", css);
console.log("%c  └─────────────────────────────┘", css);
