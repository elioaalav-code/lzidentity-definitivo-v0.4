import {
  awaitCrypto, bootstrapWallet, connectWallet, disconnectWallet, deriveNostr,
  onChange, state, shortAddr, shortNpub, toast, fmt, copyToClipboard,
} from "./shared.js";

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
const ROUTES = ["chat","wallet","markets","trade","network","identity","recovery"];
const views = Object.fromEntries(ROUTES.map(r => [r, document.querySelector(`.view[data-view="${r}"]`)]));
const navLinks = [...document.querySelectorAll(".side-nav a")];
const crumbHere = document.getElementById("crumbHere");

function getRoute(){
  const h = (location.hash || "#/chat").replace(/^#\/?/, "");
  const r = h.split("/")[0];
  return ROUTES.includes(r) ? r : "chat";
}
function setActive(route){
  for (const k of ROUTES){ views[k]?.classList.toggle("active", k === route); }
  navLinks.forEach(a => {
    const on = a.dataset.route === route;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  crumbHere.textContent = route;
  document.title = `LZidentity · ${route}`;
  // each view's onEnter hook (app.js-owned views)
  ONROUTE[route]?.();
  // broadcast to feature modules (trade.js, assistant.js) that live outside this file
  window.dispatchEvent(new CustomEvent("lz:route", { detail: { route } }));
}
window.addEventListener("hashchange", () => setActive(getRoute()));
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
}

function renderBanner(){
  if (state.account){ walletBanner.innerHTML = ""; return; }
  walletBanner.innerHTML = `
    <div class="connect-banner">
      <div class="icn">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.2"/></svg>
      </div>
      <div class="col">
        <h4>Connect to use the wallet</h4>
        <p>You're viewing demo balances. Connect MetaMask to see your real address everywhere — sends still sign locally in demo mode.</p>
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
    const a = await connectWallet();
    toast(`connected · ${shortAddr(a)}`, "ok");
  } catch { toast("connect rejected", "err"); }
}
connectBtn.addEventListener("click", connectFlow);

onChange(reflectWalletButton);

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
  items.innerHTML = CONVS.filter(c => !q || c.name.toLowerCase().includes(q) || c.last.toLowerCase().includes(q)).map(c => `
    <div class="chat-item ${c.id===activeConv?"active":""}" data-id="${c.id}">
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
let walletPrices = { eth: 3698, arb: 0.83, op: 1.23 };
const TOKENS = [
  { sym:"ETH", nm:"Ethereum", chain:"mainnet",  amount:2.418, key:"eth", cls:"eth", icon:"Ξ" },
  { sym:"ARB", nm:"Arbitrum", chain:"arbitrum", amount:1842,  key:"arb", cls:"arb", icon:"AR" },
  { sym:"OP",  nm:"Optimism", chain:"optimism", amount:930,   key:"op",  cls:"op",  icon:"OP" },
];
const TXS = [
  { kind:"in",   t:"Received ETH",     s:"from 0x4ec2…b021 · LayerZero",   amt:"+ 0.42 ETH",   dir:"up" },
  { kind:"out",  t:"Sent ARB",         s:"to 0xF1A4…0237 · Arbitrum",       amt:"− 120 ARB",    dir:"dn" },
  { kind:"swap", t:"Swap OP → ETH",    s:"0.3 OP via 1inch · OP",          amt:"+ 0.014 ETH",  dir:"up" },
  { kind:"in",   t:"Bridge in",        s:"from Optimism · OFTv2",          amt:"+ 12.5 OP",    dir:"up" },
  { kind:"out",  t:"Fee · gas",        s:"Arbitrum gas refill",            amt:"− $0.18",      dir:"dn" },
];

function totalUSD(){
  return TOKENS.reduce((s,t) => s + (walletPrices[t.key] || 0) * t.amount, 0);
}
function renderWallet(){
  document.getElementById("walletTotal").innerHTML = `${fmt.usd(totalUSD())} <small id="walletDelta">+ 3.1%</small>`;
  const list = document.getElementById("tokenList");
  list.innerHTML = TOKENS.map(t => {
    const usd = walletPrices[t.key] * t.amount;
    return `<div class="token-row">
      <div class="ic ${t.cls}">${t.icon}</div>
      <div class="col"><span class="sym">${t.sym}</span><span class="nm">${t.nm} · ${t.amount.toLocaleString("en-US")} ${t.sym}</span></div>
      <div class="amount"><span class="v">${fmt.usd(usd)}</span><span class="usd">@ ${fmt.usd(walletPrices[t.key])}</span></div>
    </div>`;
  }).join("");

  const txl = document.getElementById("txList");
  txl.innerHTML = TXS.map(tx => `
    <div class="tx-row">
      <div class="ic ${tx.kind}">${tx.kind === "in" ? "↓" : tx.kind === "out" ? "↑" : "⇄"}</div>
      <div class="col"><div class="t">${tx.t}</div><div class="s">${tx.s}</div></div>
      <div class="amt ${tx.dir}">${tx.amt}</div>
    </div>`).join("");
}

async function fetchWalletPrices(){
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,arbitrum,optimism&vs_currencies=usd");
    if (!r.ok) throw new Error("rate-limited");
    const j = await r.json();
    walletPrices = {
      eth: j.ethereum?.usd ?? walletPrices.eth,
      arb: j.arbitrum?.usd ?? walletPrices.arb,
      op:  j.optimism?.usd ?? walletPrices.op,
    };
    renderWallet();
  } catch { /* keep demo prices */ }
}

document.getElementById("walletRefresh")?.addEventListener("click", () => { fetchWalletPrices(); toast("prices refreshed", "ok"); });
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
function useDemoMarkets(){
  marketsRows = DEMO_MARKETS;
  renderMarkets();
  document.getElementById("kpiMcap").textContent = fmt.usd(2.41e12);
  document.getElementById("kpiVol").textContent  = fmt.usd(9.8e10);
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
    document.getElementById("marketsRows").classList.add("market-skel");
    document.getElementById("marketsRows").textContent = "loading coins from coingecko…";
    const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true&price_change_percentage=24h");
    if (!r.ok) throw new Error("rate-limited");
    marketsRows = await r.json();
    marketsLoaded = true;
    renderMarkets();
    // KPIs from global endpoint
    try {
      const g = await fetch("https://api.coingecko.com/api/v3/global");
      const gj = (await g.json()).data;
      document.getElementById("kpiMcap").textContent = fmt.usd(gj.total_market_cap.usd);
      document.getElementById("kpiVol").textContent  = fmt.usd(gj.total_volume.usd);
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
  root.innerHTML = marketsRows.map(c => {
    const up = (c.price_change_percentage_24h || 0) >= 0;
    const sparkUp = (c.sparkline_in_7d?.price?.[0] || 0) <= (c.sparkline_in_7d?.price?.at(-1) || 0);
    return `<div class="row" data-id="${c.id}">
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

function renderStream(items){
  const root = document.getElementById("streamList");
  root.innerHTML = items.map((s,i) => `
    <div class="stream-item ${s.st==='inf'?'live':''}">
      <span class="st ${s.st}">${s.lab}</span>
      <div class="col"><span class="h">${s.hash}</span><span class="r">${s.route}</span></div>
      <span class="lyr">${s.layer}</span>
      <span class="ag">${s.age||"now"}</span>
    </div>
  `).join("");
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

deriveBtn?.addEventListener("click", async () => {
  if (!(await awaitCrypto())){ setMB("Crypto libraries failed to load.", "err"); toast("crypto libs not loaded", "err"); return; }
  if (!state.account){
    try { await connectWallet(); } catch { toast("connect rejected", "err"); return; }
  }
  try {
    setMB("Open your wallet and sign the message …", "busy");
    await deriveNostr();
    toast(`derived · ${state.derived.npub.slice(0,16)}…`, "ok");
  } catch (e){
    console.error(e);
    setMB(/reject/i.test(e?.message || "") ? "Signature rejected." : "Derivation failed: " + (e?.message || e), "err");
    toast("derivation failed", "err");
  }
});

resetBtn?.addEventListener("click", () => { disconnectWallet(); toast("identity cleared"); });

document.querySelectorAll("[data-copy]").forEach(btn => {
  btn.addEventListener("click", async () => {
    let txt = "";
    const k = btn.dataset.copy;
    if (k === "addr") txt = state.account || "";
    if (k === "npub") txt = state.derived?.npub || "";
    if (k === "priv") txt = state.derived ? "0x" + state.derived.priv : "";
    if (!txt){ toast("nothing to copy", "err"); return; }
    const ok = await copyToClipboard(txt);
    toast(ok ? "copied to clipboard" : "copy failed", ok ? "ok" : "err");
  });
});

/* =================================================================== *
 *  ROUTE HOOKS — onEnter
 * =================================================================== */
const ONROUTE = {
  chat: () => { renderChatList(""); renderThread(); },
  wallet: () => { renderWallet(); fetchWalletPrices(); },
  markets: () => { if (!marketsLoaded) fetchMarkets(); else renderMarkets(); },
  network: () => {},
  identity: () => { reflectIdentity(); reflectIdentityDetails(); },
};

/* =================================================================== *
 *  BOOT
 * =================================================================== */
renderChatList("");
renderThread();
renderWallet();
bootstrapWallet().then(() => { reflectWalletButton(); });

setActive(getRoute());

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
      tokens: TOKENS.map(t => ({ sym: t.sym, amount: t.amount, chain: t.chain })),
      topMarkets: marketsRows.slice(0, 6).map(c => ({ sym: (c.symbol||"").toUpperCase(), price: c.current_price, ch24h: c.price_change_percentage_24h })),
    };
  },
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
