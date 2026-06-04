/* ============================================================ *
 *  hyperliquid.js — real Hyperliquid client (read + trade)
 *
 *  Two halves:
 *   1. INFO + WEBSOCKET — public market data (no auth):
 *      meta, allMids, l2Book, candles, clearinghouseState, openOrders.
 *   2. EXCHANGE (real, on-chain) — order placement / cancel /
 *      leverage. Uses Hyperliquid's L1-action signing scheme:
 *        msgpack(action) ++ nonce(8B BE) ++ vaultFlag  →  keccak256
 *        → EIP-712 "Agent" typed-data → eth_signTypedData_v4.
 *
 *  Signing matches the official Python/TS SDKs byte-for-byte, so
 *  orders signed here settle on the real exchange. REAL FUNDS when
 *  the network toggle is on mainnet — default is testnet.
 *
 *  Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 * ============================================================ */

import { encode as msgpackEncode } from "https://esm.sh/@msgpack/msgpack@2.8.0";
import { keccak_256 } from "https://esm.sh/@noble/hashes@1.4.0/sha3";

/* ─── network (testnet default, persisted) ─────────────────── */

const NET_KEY = "hl:net";
let network = localStorage.getItem(NET_KEY) || "testnet";

const ENDPOINTS = {
  mainnet: { api: "https://api.hyperliquid.xyz",          ws: "wss://api.hyperliquid.xyz/ws" },
  testnet: { api: "https://api.hyperliquid-testnet.xyz",  ws: "wss://api.hyperliquid-testnet.xyz/ws" },
};

export function getNetwork(){ return network; }
export function isMainnet(){ return network === "mainnet"; }
export function setNetwork(n){
  if (n !== "mainnet" && n !== "testnet") return;
  if (n === network) return;
  network = n;
  localStorage.setItem(NET_KEY, n);
  _meta = null; _metaAt = 0;            // asset indices differ per network
  ws.reconnect();                        // re-open the socket on the new host
  emit("network", n);
}
const apiUrl = () => ENDPOINTS[network].api;
const wsUrl  = () => ENDPOINTS[network].ws;

/* ─── tiny event bus ───────────────────────────────────────── */

const bus = new Map();   // channel -> Set<cb>
export function on(channel, cb){
  if (!bus.has(channel)) bus.set(channel, new Set());
  bus.get(channel).add(cb);
  return () => bus.get(channel)?.delete(cb);
}
function emit(channel, data){ bus.get(channel)?.forEach(cb => { try { cb(data); } catch(e){ console.error(e); } }); }

/* ─── byte helpers ─────────────────────────────────────────── */

const hexToBytes = (h) => {
  if (h.startsWith("0x")) h = h.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return out;
};
const bytesToHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
function concatBytes(...arrs){
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs){ out.set(a, o); o += a.length; }
  return out;
}
function nonceToBytes(nonce){
  const b = new Uint8Array(8);
  let x = BigInt(nonce);
  for (let i = 7; i >= 0; i--){ b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

/* ─── number formatting (Hyperliquid wire rules) ───────────── *
 *  Sizes round to szDecimals. Prices: integers always allowed;
 *  otherwise 5 significant figures AND ≤ (MAX_DECIMALS - szDecimals)
 *  decimals (MAX_DECIMALS = 6 perps, 8 spot). Output is the minimal
 *  decimal string — the exact same string is hashed and sent.       */

function trimNum(s){
  if (s.indexOf(".") === -1) return s;
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-" ? "0" : s;
}
export function formatSize(sz, szDecimals){
  return trimNum(Number(sz).toFixed(Math.max(0, szDecimals)));
}
export function formatPrice(px, szDecimals, isPerp = true){
  px = Number(px);
  if (!isFinite(px) || px <= 0) return "0";
  if (Number.isInteger(px)) return String(px);
  const maxDecimals = isPerp ? 6 : 8;
  const decimals = Math.max(0, maxDecimals - szDecimals);
  let v = Number(px.toPrecision(5));      // 5 significant figures
  v = Number(v.toFixed(decimals));        // decimal-place cap
  if (Number.isInteger(v)) return String(v);
  return trimNum(v.toFixed(decimals));
}

/* ─── INFO endpoint ────────────────────────────────────────── */

export async function info(body){
  const r = await fetch(apiUrl() + "/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("hl info " + r.status);
  return r.json();
}

let _meta = null, _metaAt = 0;
export async function meta(){
  if (_meta && Date.now() - _metaAt < 60_000) return _meta;
  _meta = await info({ type: "meta" });
  _metaAt = Date.now();
  return _meta;
}
/** asset index + szDecimals for a perp coin name (e.g. "ETH"). */
export async function assetInfo(coin){
  const m = await meta();
  const i = m.universe.findIndex(u => u.name === coin);
  if (i < 0) throw new Error("unknown coin " + coin);
  return { index: i, szDecimals: m.universe[i].szDecimals, maxLeverage: m.universe[i].maxLeverage };
}

export const allMids        = () => info({ type: "allMids" });
export const metaAndCtxs     = () => info({ type: "metaAndAssetCtxs" });
export const l2Book         = (coin) => info({ type: "l2Book", coin });
export const clearinghouse  = (user) => info({ type: "clearinghouseState", user });
export const openOrders     = (user) => info({ type: "openOrders", user });
export const userFills      = (user) => info({ type: "userFills", user });
export function candleSnapshot(coin, interval, startTime, endTime){
  return info({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
}

/* ─── WebSocket (live market data) ─────────────────────────── */

const ws = (() => {
  let sock = null, alive = false, backoff = 800;
  const subs = new Map();        // key -> subscription object (for resubscribe)
  let pingTimer = null;

  const keyOf = (s) => JSON.stringify(s);

  function open(){
    try { sock = new WebSocket(wsUrl()); } catch { schedule(); return; }
    sock.onopen = () => {
      alive = true; backoff = 800;
      for (const s of subs.values()) send({ method: "subscribe", subscription: s });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ method: "ping" }), 25_000);
      emit("ws", "open");
    };
    sock.onclose = () => { alive = false; clearInterval(pingTimer); schedule(); emit("ws", "closed"); };
    sock.onerror = () => { try { sock.close(); } catch {} };
    sock.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || msg.channel === "pong") return;
      // channel names: allMids, l2Book, trades, candle, subscriptionResponse
      emit("ws:" + msg.channel, msg.data);
    };
  }
  function schedule(){ setTimeout(open, backoff); backoff = Math.min(backoff * 1.7, 12_000); }
  function send(obj){ if (alive && sock?.readyState === 1) sock.send(JSON.stringify(obj)); }

  return {
    ensure(){ if (!sock || sock.readyState > 1) open(); },
    subscribe(sub){
      this.ensure();
      const k = keyOf(sub);
      if (subs.has(k)) return () => this.unsubscribe(sub);
      subs.set(k, sub);
      send({ method: "subscribe", subscription: sub });
      return () => this.unsubscribe(sub);
    },
    unsubscribe(sub){
      const k = keyOf(sub);
      if (!subs.has(k)) return;
      subs.delete(k);
      send({ method: "unsubscribe", subscription: sub });
    },
    reconnect(){ try { sock?.close(); } catch {} subs.clear(); open(); },
  };
})();
export { ws };

/* ─── L1-action signing ────────────────────────────────────── */

function actionHash(action, vaultAddress, nonce){
  const packed = msgpackEncode(action);                 // canonical msgpack, insertion key order
  const tail = vaultAddress
    ? concatBytes(Uint8Array.of(0x01), hexToBytes(vaultAddress))
    : Uint8Array.of(0x00);
  return keccak_256(concatBytes(packed, nonceToBytes(nonce), tail));
}

function phantomAgent(hash){
  return { source: isMainnet() ? "a" : "b", connectionId: "0x" + bytesToHex(hash) };
}

/* Self-test: recompute the action hash for a fixed reference action and
   compare against the value produced by the official SDK (msgpack + keccak).
   If esm.sh ever ships a non-canonical msgpack, this fails loudly — before
   any real funds move. Reference computed offline from hyperliquid-python-sdk. */
const _REF_ACTION = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
const _REF_MSGPACK = "83a474797065a56f72646572a66f72646572739186a16101a162c3a170a3313030a173a3313030a172c2a17481a56c696d697481a3746966a3477463a867726f7570696e67a26e61";
const _REF_HASH = "884f2c32bb6dbdd65f6033e32fb28c0cb6f5b345db0f6471fd3366d85c9252c1";
export function selfTest(){
  const packed = bytesToHex(msgpackEncode(_REF_ACTION));
  const hash = bytesToHex(actionHash(_REF_ACTION, null, 0));
  const ok = packed === _REF_MSGPACK && hash === _REF_HASH;
  return { ok, packedOk: packed === _REF_MSGPACK, hashOk: hash === _REF_HASH, packed, hash };
}

async function signL1Action(account, action, nonce, vaultAddress = null){
  const agent = phantomAgent(actionHash(action, vaultAddress, nonce));
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    message: agent,
  };
  const sig = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(typedData)],
  });
  const s = sig.startsWith("0x") ? sig.slice(2) : sig;
  return { r: "0x" + s.slice(0, 64), s: "0x" + s.slice(64, 128), v: parseInt(s.slice(128, 130), 16) };
}

async function postExchange(action, signature, nonce, vaultAddress = null){
  const r = await fetch(apiUrl() + "/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress }),
  });
  const j = await r.json().catch(() => ({ status: "err", response: "bad response" }));
  if (j.status === "err") throw new Error(typeof j.response === "string" ? j.response : JSON.stringify(j.response));
  // order responses can also carry per-order errors inside statuses
  const statuses = j?.response?.data?.statuses;
  if (Array.isArray(statuses)){
    const err = statuses.find(s => s && s.error);
    if (err) throw new Error(err.error);
  }
  return j;
}

/* ─── public trade actions ─────────────────────────────────── */

const DEFAULT_SLIPPAGE = 0.05;   // aggressive cross for "market" (IOC) orders

/**
 * Place an order. `type` is "limit" or "market".
 * For market orders px is derived from the current mid ± slippage (IOC).
 * Returns the parsed /exchange response on success; throws with the
 * server's error string otherwise.
 */
export async function placeOrder({ account, coin, isBuy, sz, px, type = "limit", tif = "Gtc", reduceOnly = false }){
  if (!account) throw new Error("connect a wallet first");
  const { index, szDecimals } = await assetInfo(coin);

  let limitTif = tif;
  let priceNum = Number(px);
  if (type === "market"){
    const mids = await allMids();
    const mid = Number(mids[coin]);
    if (!isFinite(mid) || mid <= 0) throw new Error("no mid price for " + coin);
    priceNum = isBuy ? mid * (1 + DEFAULT_SLIPPAGE) : mid * (1 - DEFAULT_SLIPPAGE);
    limitTif = "Ioc";
  }
  const pStr = formatPrice(priceNum, szDecimals, true);
  const sStr = formatSize(sz, szDecimals);
  if (Number(sStr) <= 0) throw new Error("size must be greater than zero");

  // wire key order is load-bearing for the signature hash: a,b,p,s,r,t
  const orderWire = { a: index, b: !!isBuy, p: pStr, s: sStr, r: !!reduceOnly, t: { limit: { tif: limitTif } } };
  const action = { type: "order", orders: [orderWire], grouping: "na" };
  const nonce = Date.now();
  const signature = await signL1Action(account, action, nonce);
  return postExchange(action, signature, nonce);
}

export async function cancelOrder({ account, coin, oid }){
  if (!account) throw new Error("connect a wallet first");
  const { index } = await assetInfo(coin);
  const action = { type: "cancel", cancels: [{ a: index, o: oid }] };
  const nonce = Date.now();
  const signature = await signL1Action(account, action, nonce);
  return postExchange(action, signature, nonce);
}

export async function updateLeverage({ account, coin, leverage, isCross = true }){
  if (!account) throw new Error("connect a wallet first");
  const { index } = await assetInfo(coin);
  const action = { type: "updateLeverage", asset: index, isCross: !!isCross, leverage: Math.round(leverage) };
  const nonce = Date.now();
  const signature = await signL1Action(account, action, nonce);
  return postExchange(action, signature, nonce);
}
