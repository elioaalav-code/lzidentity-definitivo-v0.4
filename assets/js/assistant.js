/* ============================================================ *
 *  assistant.js — LZ AI copilot
 *
 *  A global assistant that helps the user use every part of the
 *  app. Two engines:
 *   1. Claude (real) — Anthropic Messages API straight from the
 *      browser with the user's own key. Streaming via fetch SSE,
 *      tool use so it can navigate the app + read live state,
 *      prompt caching on the (stable) system prompt.
 *   2. Scripted fallback — a rule-based guide when no key is set,
 *      so the copilot is useful out of the box.
 *
 *  Browser direct access needs three headers: x-api-key,
 *  anthropic-version, and anthropic-dangerous-direct-browser-access.
 *  The key lives only in localStorage and is sent only to Anthropic.
 * ============================================================ */

import { CustomSelect } from "./ui.js";
import * as HL from "./hyperliquid.js";
import * as MD from "./marketdata.js";

const LS = { KEY: "lz:ai:key", MODEL: "lz:ai:model" };
const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

const $ = (id) => document.getElementById(id);
const reduce = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ─── DOM ──────────────────────────────────────────────────── */
const fab        = $("copilotFab");
const panel      = $("copilot");
const body       = $("copilotBody");
const form       = $("copilotForm");
const input      = $("copilotInput");
const modeChip   = $("copilotMode");
const settingsBtn= $("copilotSettings");
const settingsEl = $("copilotSettingsPanel");
const keyInput   = $("copilotKey");
const modelSel   = $("copilotModel");
const slashBtn   = $("copilotSlash");
const cmdEl      = $("copilotCmd");

/* ─── config ───────────────────────────────────────────────── */
const getKey   = () => localStorage.getItem(LS.KEY) || "";
const getModel = () => localStorage.getItem(LS.MODEL) || DEFAULT_MODEL;
function reflectMode(){
  const live = !!getKey();
  modeChip.textContent = live ? getModel().replace("claude-","").replace(/-\d+$/,"") : "offline";
  modeChip.className = "ct-mode" + (live ? " live" : "");
}

/* ─── conversation state ───────────────────────────────────── */
let history = [];        // Anthropic messages[]
let busy = false;

/* ─── app tools the copilot can call ───────────────────────── */
const HL_INTERVALS = ["1m","5m","15m","1h","4h","1d"];
const TOOLS = [
  /* ── app control ── */
  { name: "navigate", description: "Open one of the app's tabs for the user.",
    input_schema: { type: "object", properties: { tab: { type: "string", enum: ["chat","wallet","markets","trade","network","identity","recovery"] } }, required: ["tab"] } },
  { name: "get_app_state", description: "Read a live snapshot of the app: current tab, connected wallet, derived Nostr identity, wallet balances, top market prices.",
    input_schema: { type: "object", properties: {} } },
  { name: "set_trading_market", description: "Switch the Trading tab to a given Hyperliquid perp market (e.g. BTC, ETH, SOL).",
    input_schema: { type: "object", properties: { coin: { type: "string" } }, required: ["coin"] } },
  { name: "prefill_order", description: "Pre-fill the Trading order ticket so the user can review and sign it. NEVER places an order — the user always signs. Use after navigating to the trade tab.",
    input_schema: { type: "object", properties: {
      side: { type: "string", enum: ["buy","sell"] },
      type: { type: "string", enum: ["market","limit"] },
      size: { type: "number", description: "Order size in the coin's units" },
      price: { type: "number", description: "Limit price (omit for market orders)" },
    }, required: ["side"] } },

  /* ── Hyperliquid live market data (real, current network: testnet/mainnet toggle) ── */
  { name: "get_ticker", description: "Hyperliquid: mark price, oracle price, 24h change, 24h volume, open interest and funding rate for one perp market.",
    input_schema: { type: "object", properties: { coin: { type: "string" } }, required: ["coin"] } },
  { name: "get_orderbook", description: "Hyperliquid live L2 order book (bids/asks with price & size) for a perp market.",
    input_schema: { type: "object", properties: { coin: { type: "string" }, depth: { type: "number", description: "levels per side, default 10" } }, required: ["coin"] } },
  { name: "get_trades", description: "Hyperliquid most recent public trades for a perp market.",
    input_schema: { type: "object", properties: { coin: { type: "string" }, limit: { type: "number" } }, required: ["coin"] } },
  { name: "get_candles", description: "Hyperliquid OHLCV candles for a perp market.",
    input_schema: { type: "object", properties: { coin: { type: "string" }, interval: { type: "string", enum: HL_INTERVALS }, limit: { type: "number" } }, required: ["coin","interval"] } },
  { name: "get_all_markets", description: "Hyperliquid: every perp market with price, 24h change, 24h volume, open interest and funding (sorted by volume).",
    input_schema: { type: "object", properties: {} } },
  { name: "get_funding_history", description: "Hyperliquid historical funding rates (last 7 days) for a perp market.",
    input_schema: { type: "object", properties: { coin: { type: "string" }, limit: { type: "number" } }, required: ["coin"] } },
  { name: "get_positions", description: "Hyperliquid open perp positions for a wallet (size, entry, uPnL, liquidation px, leverage). Omit wallet to use the connected one.",
    input_schema: { type: "object", properties: { wallet: { type: "string" } } } },
  { name: "get_open_orders", description: "Hyperliquid open/resting limit orders for a wallet. Omit wallet to use the connected one.",
    input_schema: { type: "object", properties: { wallet: { type: "string" } } } },
  { name: "get_trade_history", description: "Hyperliquid past executed fills for a wallet. Omit wallet to use the connected one.",
    input_schema: { type: "object", properties: { wallet: { type: "string" }, limit: { type: "number" } } } },

  /* ── CoinGecko (spot market data, no key) ── */
  { name: "cg_market_data", description: "CoinGecko full market data for a coin by id (e.g. 'bitcoin','ethereum','solana'): price, market cap, volume, supply, ATH, 24h/7d/30d change.",
    input_schema: { type: "object", properties: { coin_id: { type: "string" } }, required: ["coin_id"] } },
  { name: "cg_chart", description: "CoinGecko OHLC price history for a coin id over N days (1,7,14,30,90,365).",
    input_schema: { type: "object", properties: { coin_id: { type: "string" }, days: { type: "number" } }, required: ["coin_id"] } },
  { name: "cg_top_coins", description: "CoinGecko top coins by market cap with price, 24h change, market cap and volume.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "cg_trending", description: "CoinGecko trending coins over the last 24h.",
    input_schema: { type: "object", properties: {} } },
  { name: "cg_global", description: "Global crypto market: total market cap, 24h volume, BTC/ETH dominance, market-cap change.",
    input_schema: { type: "object", properties: {} } },
  { name: "fear_greed", description: "Crypto Fear & Greed index (0-100) with its classification.",
    input_schema: { type: "object", properties: {} } },

  /* ── DefiLlama (DeFi/TVL, no key) ── */
  { name: "defi_protocols", description: "DefiLlama top DeFi protocols by TVL (name, category, chains, TVL, 1d/7d change).",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "defi_protocol", description: "DefiLlama details for one protocol by slug (e.g. 'aave','uniswap','lido'): current TVL, category, per-chain breakdown.",
    input_schema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "defi_chains", description: "DefiLlama TVL by chain (top chains by total value locked).",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "defi_stablecoins", description: "DefiLlama top stablecoins by circulating supply, with price and peg.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "defi_yields", description: "DefiLlama highest-APY yield pools (TVL > $1M) with project, chain and TVL.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } } },
];

const HL_MS = { "1m":60e3, "5m":300e3, "15m":900e3, "1h":3600e3, "4h":14400e3, "1d":86400e3 };
const r2 = (n, d = 2) => (n == null || !isFinite(n) ? null : Number(Number(n).toFixed(d)));
const upper = (c) => String(c || "").toUpperCase();
const walletOf = (a) => a.wallet || window.LZ?.snapshot?.()?.wallet || null;

async function runTool(name, args){
  const LZ = window.LZ || {};
  try {
    /* app control */
    if (name === "navigate"){ LZ.navigate?.(args.tab); return { ok: true, opened: args.tab }; }
    if (name === "get_app_state"){ return LZ.snapshot ? LZ.snapshot() : { error: "state unavailable" }; }
    if (name === "set_trading_market"){ LZ.navigate?.("trade"); LZ.hl?.setCoin?.(upper(args.coin)); return { ok: true, market: upper(args.coin) }; }
    if (name === "prefill_order"){ LZ.navigate?.("trade"); LZ.hl?.prefillOrder?.(args); return { ok: true, note: "ticket pre-filled — the user must review and sign" }; }

    /* Hyperliquid market data */
    if (name === "get_ticker"){
      const C = upper(args.coin); const [m, ctxs] = await HL.metaAndCtxs();
      const i = m.universe.findIndex(u => u.name === C);
      if (i < 0) return { error: `${C} is not a Hyperliquid perp` };
      const c = ctxs[i] || {}; const mark = +c.markPx, prev = +c.prevDayPx;
      return { coin: C, network: HL.getNetwork(), mark_px: mark, oracle_px: +c.oraclePx,
        change_24h_pct: prev ? r2((mark - prev) / prev * 100) : null, day_volume_usd: r2(+c.dayNtlVlm, 0),
        open_interest_usd: r2(+c.openInterest * mark, 0), funding_rate_pct: r2(+c.funding * 100, 5), max_leverage: m.universe[i].maxLeverage };
    }
    if (name === "get_all_markets"){
      const [m, ctxs] = await HL.metaAndCtxs();
      const rows = m.universe.map((u, i) => { const c = ctxs[i] || {}; const mark = +c.markPx, prev = +c.prevDayPx;
        return { coin: u.name, mark_px: mark, change_24h_pct: prev ? r2((mark - prev) / prev * 100) : null,
          day_volume_usd: r2(+c.dayNtlVlm, 0), open_interest_usd: r2(+c.openInterest * mark, 0),
          funding_rate_pct: r2(+c.funding * 100, 5), max_leverage: u.maxLeverage }; })
        .filter(r => isFinite(r.mark_px)).sort((a, b) => (b.day_volume_usd || 0) - (a.day_volume_usd || 0));
      return { network: HL.getNetwork(), count: rows.length, markets: rows.slice(0, 60) };
    }
    if (name === "get_orderbook"){
      const C = upper(args.coin); const d = Math.min(Math.max(1, args.depth || 10), 25);
      const b = await HL.l2Book(C); const lv = b?.levels || [];
      const side = (s) => (lv[s] || []).slice(0, d).map(l => ({ px: +l.px, sz: +l.sz }));
      return { coin: C, bids: side(0), asks: side(1) };
    }
    if (name === "get_trades"){
      const C = upper(args.coin); const n = Math.min(Math.max(1, args.limit || 20), 50);
      const t = await HL.info({ type: "recentTrades", coin: C });
      return { coin: C, trades: (t || []).slice(0, n).map(x => ({ px: +x.px, sz: +x.sz, side: x.side === "B" ? "buy" : "sell", time: x.time })) };
    }
    if (name === "get_candles"){
      const C = upper(args.coin); const iv = args.interval; const n = Math.min(Math.max(1, args.limit || 50), 200);
      const ms = HL_MS[iv] || 9e5; const end = Date.now(); const start = end - n * ms;
      const data = await HL.candleSnapshot(C, iv, start, end);
      return { coin: C, interval: iv, candles: (data || []).slice(-n).map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v })) };
    }
    if (name === "get_funding_history"){
      const C = upper(args.coin); const n = Math.min(Math.max(1, args.limit || 24), 100);
      const h = await HL.info({ type: "fundingHistory", coin: C, startTime: Date.now() - 7 * 864e5 });
      return { coin: C, funding: (h || []).slice(-n).map(x => ({ time: x.time, funding_rate_pct: r2(+x.fundingRate * 100, 5), premium: r2(+x.premium, 5) })) };
    }
    if (name === "get_positions"){
      const w = walletOf(args); if (!w) return { error: "no wallet connected — connect one or pass a wallet address" };
      const ch = await HL.clearinghouse(w);
      const pos = (ch?.assetPositions || []).filter(p => +p.position.szi !== 0).map(p => { const s = +p.position.szi;
        return { coin: p.position.coin, side: s > 0 ? "long" : "short", size: Math.abs(s), entry_px: +p.position.entryPx,
          position_value_usd: r2(+p.position.positionValue, 0), unrealized_pnl_usd: r2(+p.position.unrealizedPnl, 2),
          liquidation_px: p.position.liquidationPx ? +p.position.liquidationPx : null, leverage: p.position.leverage?.value ?? null }; });
      const ms = ch?.marginSummary || {};
      return { wallet: w, network: HL.getNetwork(), account_value_usd: r2(+ms.accountValue, 2) || 0, withdrawable_usd: r2(+ch?.withdrawable, 2), positions: pos };
    }
    if (name === "get_open_orders"){
      const w = walletOf(args); if (!w) return { error: "no wallet connected — connect one or pass a wallet address" };
      const oo = await HL.openOrders(w);
      return { wallet: w, network: HL.getNetwork(), orders: (oo || []).map(o => ({ coin: o.coin, side: o.side === "B" ? "buy" : "sell", size: +o.sz, limit_px: +o.limitPx, oid: o.oid, timestamp: o.timestamp })) };
    }
    if (name === "get_trade_history"){
      const w = walletOf(args); if (!w) return { error: "no wallet connected — connect one or pass a wallet address" };
      const n = Math.min(Math.max(1, args.limit || 20), 50);
      const f = await HL.userFills(w);
      return { wallet: w, network: HL.getNetwork(), fills: (f || []).slice(0, n).map(x => ({ coin: x.coin, side: x.side === "B" ? "buy" : "sell", px: +x.px, sz: +x.sz, closed_pnl_usd: r2(+x.closedPnl, 2), fee: r2(+x.fee, 4), time: x.time, liquidation: !!x.liquidation })) };
    }

    /* CoinGecko */
    if (name === "cg_market_data") return await MD.cgMarketData(args.coin_id);
    if (name === "cg_chart")       return await MD.cgChart(args.coin_id, args.days || 7);
    if (name === "cg_top_coins")   return await MD.cgTopCoins(args.limit || 10);
    if (name === "cg_trending")    return await MD.cgTrending();
    if (name === "cg_global")      return await MD.cgGlobal();
    if (name === "fear_greed")     return await MD.fearGreed();

    /* DefiLlama */
    if (name === "defi_protocols")   return await MD.dlProtocols(args.limit || 15);
    if (name === "defi_protocol")    return await MD.dlProtocol(args.slug);
    if (name === "defi_chains")      return await MD.dlChains(args.limit || 15);
    if (name === "defi_stablecoins") return await MD.dlStablecoins(args.limit || 12);
    if (name === "defi_yields")      return await MD.dlYields(args.limit || 12);
  } catch (e){ return { error: String(e?.message || e) }; }
  return { error: "unknown tool" };
}

/* ─── system prompt (stable → cacheable) ───────────────────── */
const SYSTEM = `You are the LZ Assistant, a friendly in-app copilot for LZidentity — a web app for one identity that works across every chain, built on LayerZero.

The app has these tabs (you can open any with the navigate tool):
- chat: encrypted messaging across mesh, Nostr, and LayerZero (demo data).
- wallet: REAL on-chain balances — native ETH + USDC across Ethereum, Arbitrum, Optimism and Base for the connected wallet, read live from public RPCs. The quick-send form itself is still a demo.
- markets: live top-coin prices and 7-day charts (real, from CoinGecko).
- trade: REAL on-chain perps trading on Hyperliquid. Live order book and candles. Orders are signed with the user's wallet and settle on-chain. There is a testnet/mainnet toggle — testnet by default. You can switch markets and pre-fill the order ticket, but the USER always signs every order. You never place orders yourself.
- network: a live stream of activity (demo).
- identity: sign one message with an EVM wallet to derive a matching Nostr identity. This part is real and deterministic.
- recovery: pick guardians who can restore your identity without a seed phrase (sketch).

How you help:
- Answer questions about what the app does and how to use any feature.
- When the user wants to go somewhere or do something, use your tools: navigate to a tab, read live state with get_app_state, switch the trading market, or pre-fill an order for them to review.
- For anything that moves funds or signs a transaction, set it up and explain it, but make clear the user signs it themselves.

Live data — you can fetch real numbers, so never guess or make them up:
- Hyperliquid perps (reflects the app's current testnet/mainnet toggle): get_ticker, get_orderbook, get_trades, get_candles, get_all_markets, get_funding_history, and the connected wallet's get_positions / get_open_orders / get_trade_history.
- CoinGecko spot data: cg_market_data (by coin id like 'bitcoin'/'ethereum'/'solana'), cg_chart, cg_top_coins, cg_trending, cg_global, and fear_greed for sentiment.
- DefiLlama: defi_protocols, defi_protocol (by slug), defi_chains, defi_stablecoins, defi_yields.
When asked about a price, market, position, TVL, or "the market", call the right tool and answer from the result. Pick CoinGecko for spot/marketcap questions and Hyperliquid for perp/funding/order-book questions. If a tool returns an error (e.g. no wallet, rate limit), say so plainly. Format numbers readably (e.g. $1.2B, 3.4%). You have no CoinMarketCap tool — CoinGecko covers the same data.

Style: warm, concise, plain language. No jargon dumps. A sentence or two is usually enough. Use the user's language.`;

/* ─── rendering ────────────────────────────────────────────── */
function escapeHtml(s){ return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function mdLite(s){
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/^- (.+)$/gm, "• $1");
  return h.replace(/\n/g, "<br>");
}
function nearBottom(){ return body.scrollHeight - body.scrollTop - body.clientHeight < 80; }
function autoscroll(force){ if (force || nearBottom()) body.scrollTop = body.scrollHeight; }
function nowTime(){ return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function addBubble(role, text=""){
  const el = document.createElement("div");
  el.className = "cm " + role;
  el.innerHTML = `<div class="cm-b">${text ? mdLite(text) : ""}</div><div class="cm-time">${nowTime()}</div>`;
  body.appendChild(el);
  autoscroll(true);
  return el.querySelector(".cm-b");
}

const TRACE_LABELS = {
  navigate: "Opening", get_app_state: "Reading app state",
  set_trading_market: "Switching market", prefill_order: "Pre-filling order",
  get_ticker: "Hyperliquid ticker", get_orderbook: "Reading order book", get_trades: "Recent trades",
  get_candles: "Loading candles", get_all_markets: "Scanning HL markets", get_funding_history: "Funding history",
  get_positions: "Reading positions", get_open_orders: "Reading open orders", get_trade_history: "Trade history",
  cg_market_data: "CoinGecko", cg_chart: "CoinGecko chart", cg_top_coins: "Top coins",
  cg_trending: "Trending", cg_global: "Global market", fear_greed: "Fear & Greed",
  defi_protocols: "DefiLlama protocols", defi_protocol: "DefiLlama", defi_chains: "Chain TVL",
  defi_stablecoins: "Stablecoins", defi_yields: "Yield pools",
};
function addTrace(name, args){
  const detail = args && Object.keys(args).length ? Object.values(args).join(" · ") : "";
  const label = (TRACE_LABELS[name] || name) + (detail ? " · " + detail : "");
  const el = document.createElement("div");
  el.className = "cm-trace";
  el.innerHTML = `<span class="cm-trace-ic"><span class="cm-trace-spin"></span></span><span class="cm-trace-label">${escapeHtml(label)}</span>`;
  body.appendChild(el);
  autoscroll();
  return {
    done(){
      el.classList.add("done");
      el.querySelector(".cm-trace-ic").innerHTML =
        `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>`;
    },
    fail(){
      el.classList.add("err");
      el.querySelector(".cm-trace-ic").innerHTML =
        `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 4 12M4 4l8 8"/></svg>`;
    },
  };
}

function addError(msg, retryFn){
  const el = document.createElement("div");
  el.className = "cm-error";
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
    <div><div>${escapeHtml(msg)}</div>${retryFn ? `<div class="cm-error-act"><button type="button">Try again</button></div>` : ""}</div>`;
  if (retryFn) el.querySelector("button").addEventListener("click", () => { el.remove(); retryFn(); });
  body.appendChild(el);
  autoscroll(true);
}

/* refined streaming indicator (shimmer) with dot-typing fallback */
function typing(on){
  let t = $("copilotTyping");
  if (on && !t){
    t = document.createElement("div");
    t.id = "copilotTyping";
    if (reduce()){
      t.className = "cm bot";
      t.innerHTML = `<div class="cm-b typing"><span></span><span></span><span></span></div>`;
    } else {
      t.className = "cm-stream";
      t.innerHTML = `<div class="cm-b"><span class="cm-shimmer"></span><span class="cm-stream-lbl">thinking</span></div>`;
    }
    body.appendChild(t);
    autoscroll(true);
  } else if (!on && t){ t.remove(); }
}

/* ─── Claude engine (streaming + tool loop) ────────────────── */
async function streamOnce(messages, onText){
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": getKey(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 1500,
      stream: true,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok){
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }

  const blocks = [];           // accumulated content blocks
  let stopReason = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  for (;;){
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts){
      const line = part.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "content_block_start"){
        blocks[ev.index] = ev.content_block.type === "tool_use"
          ? { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, _json: "" }
          : { type: "text", text: "" };
      } else if (ev.type === "content_block_delta"){
        const b = blocks[ev.index]; if (!b) continue;
        if (ev.delta.type === "text_delta"){ b.text += ev.delta.text; onText?.(ev.delta.text); }
        else if (ev.delta.type === "input_json_delta"){ b._json += ev.delta.partial_json; }
      } else if (ev.type === "content_block_stop"){
        const b = blocks[ev.index];
        if (b && b.type === "tool_use"){ try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
      } else if (ev.type === "message_delta"){
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }
  }
  return { blocks: blocks.filter(Boolean), stopReason };
}

async function askClaude(userText){
  history.push({ role: "user", content: userText });
  let guard = 0;
  while (guard++ < 6){
    let bubble = null, acc = "";
    typing(true);
    const { blocks, stopReason } = await streamOnce(history, (delta) => {
      if (!bubble){ typing(false); bubble = addBubble("bot"); bubble.classList.add("streaming"); }
      acc += delta;
      bubble.innerHTML = mdLite(acc);
      autoscroll();
    });
    typing(false);
    if (bubble) bubble.classList.remove("streaming");
    // assistant turn (sanitize tool blocks for the wire)
    history.push({ role: "assistant", content: blocks.map(b => b.type === "tool_use"
      ? { type: "tool_use", id: b.id, name: b.name, input: b.input || {} }
      : { type: "text", text: b.text }) });

    if (stopReason === "tool_use"){
      const results = [];
      for (const b of blocks.filter(x => x.type === "tool_use")){
        const trace = addTrace(b.name, b.input || {});
        const out = await runTool(b.name, b.input || {});
        if (out && out.error) trace.fail(); else trace.done();
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
      }
      history.push({ role: "user", content: results });
      continue; // let Claude react to the tool results
    }
    break;
  }
}

/* ─── scripted fallback ────────────────────────────────────── */
const TAB_HELP = {
  chat: "Chat is encrypted messaging that routes over mesh, Nostr, or LayerZero. It's demo data for now.",
  wallet: "Wallet shows your real on-chain balances (ETH + USDC across Ethereum, Arbitrum, Optimism and Base) for the connected wallet. The quick-send form is still a demo.",
  markets: "Markets has live top-coin prices and 7-day charts from CoinGecko.",
  trade: "Trading is real on-chain perps on Hyperliquid — live book and candles, orders signed with your wallet. It starts on testnet; flip to mainnet when ready. You always sign each order yourself.",
  network: "Network is a live stream of activity moving through the app (demo).",
  identity: "Identity derives a Nostr key from one wallet signature — deterministic and real. Same wallet, same name, every time.",
  recovery: "Recovery lets you pick guardians who can restore your identity without a seed phrase (sketch).",
};
function scriptedReply(text){
  const t = text.toLowerCase();
  for (const tab of Object.keys(TAB_HELP)){
    if (t.includes(tab) || (tab === "trade" && /trad|hyperliquid|perp|long|short/.test(t))){
      if (/open|go to|show|take me|vai|apri|porta/.test(t)){
        window.LZ?.navigate?.(tab);
        return `Opening **${tab}**. ${TAB_HELP[tab]}`;
      }
      return TAB_HELP[tab];
    }
  }
  if (/help|what can you|cosa puoi|aiut/.test(t))
    return "I can explain any tab and take you there. Try “open trading”, “go to identity”, or ask what a feature does. Add an Anthropic API key in settings (gear icon) to unlock the full Claude assistant that can read your live state and set up trades for you.";
  if (/key|api|claude|chiave/.test(t))
    return "Tap the gear icon up top and paste an Anthropic API key to switch on the real Claude assistant. It's stored only in this browser.";
  return "I'm in offline mode right now. I can still navigate the app — try “open trading” or “explain recovery”. For full answers, add an Anthropic API key via the gear icon.";
}

/* ─── send ─────────────────────────────────────────────────── */
async function send(text){
  if (busy || !text.trim()) return;
  busy = true; input.value = "";
  addBubble("me", text);
  try {
    if (getKey()){ await askClaude(text); }
    else { typing(true); await new Promise(r => setTimeout(r, 300)); typing(false); addBubble("bot", scriptedReply(text)); }
  } catch (e){
    typing(false);
    const streaming = body.querySelector(".cm-b.streaming");
    if (streaming) streaming.classList.remove("streaming");
    const m = e.status === 401 ? "That API key was rejected. Check it in settings (gear icon)."
            : e.status === 429 ? "Rate limited by Anthropic — give it a moment and try again."
            : "Something went wrong: " + (e?.message || e);
    // a failed turn left a dangling user message in history — drop it so retry is clean
    if (getKey() && history.length && history[history.length - 1].role === "user") history.pop();
    addError(m, () => send(text));
  } finally { busy = false; input.focus(); }
}

/* ─── quick-action chips (greeting) ────────────────────────── */
const ICONS = {
  trade: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 7-8"/><path d="M21 7v5h-5"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h3M3 9h12"/></svg>`,
  recovery: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z"/><path d="M9.5 12l2 2 3.5-4"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>`,
  nav: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  net: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  clear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 3h4v4"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.4 7.2L4 20l.8-5.6A8 8 0 1 1 21 12z"/></svg>`,
  markets: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7"/></svg>`,
  identity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`,
};

const GREET_CHIPS = [
  { icon: "trade", label: "Open Trading", run: () => { window.LZ?.navigate?.("trade"); flagSuggestionSeen(); } },
  { icon: "markets", label: "Market snapshot", run: () => send("give me a quick crypto market snapshot: BTC and ETH price with 24h change, total market cap, and the fear & greed index") },
  { icon: "recovery", label: "Explain Recovery", run: () => send("explain recovery") },
  { icon: "spark", label: "Prefill a BTC trade", run: () => {
      window.LZ?.navigate?.("trade");
      window.LZ?.hl?.prefillOrder?.({ side: "buy", type: "market", size: 0.01 });
      addBubble("bot", "Pre-filled a **0.01 BTC** market buy on the Trading ticket — review and sign it yourself when ready.");
      flagSuggestionSeen();
  } },
];

function renderChips(items){
  const wrap = document.createElement("div");
  wrap.className = "cm-chips";
  items.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-chip";
    b.style.animationDelay = reduce() ? "0s" : (0.05 + i * 0.06) + "s";
    b.innerHTML = `<span class="cm-chip-ic">${ICONS[c.icon] || ICONS.nav}</span><span>${escapeHtml(c.label)}</span>`;
    b.addEventListener("click", () => c.run());
    wrap.appendChild(b);
  });
  body.appendChild(wrap);
  autoscroll(true);
}

/* ─── command palette ('/') ────────────────────────────────── */
function navCmd(route, name, icon){
  return { name, desc: "Go to " + route, icon, run: () => window.LZ?.navigate?.(route) };
}
function buildCommands(){
  return [
    { group: "Navigate", items: [
      navCmd("trade", "Trading", "trade"),
      navCmd("wallet", "Wallet", "wallet"),
      navCmd("markets", "Markets", "markets"),
      navCmd("chat", "Chat", "chat"),
      navCmd("network", "Network", "net"),
      navCmd("identity", "Identity", "identity"),
      navCmd("recovery", "Recovery", "recovery"),
    ]},
    { group: "Actions", items: [
      { name: "Toggle network", desc: "Switch Hyperliquid testnet ⇆ mainnet", icon: "net", run: toggleNetwork },
      { name: "Clear chat", desc: "Start a fresh conversation", icon: "clear", run: clearChat },
      { name: getKey() ? "Manage Claude key" : "Connect Claude", desc: "Open assistant settings", icon: "key", run: openSettings },
    ]},
  ];
}

function toggleNetwork(){
  const cur = window.LZ?.hl?.network?.() || "testnet";
  const next = cur === "mainnet" ? "testnet" : "mainnet";
  window.LZ?.navigate?.("trade");
  // drive the real network toggle in the Trading view
  const btn = document.querySelector(`#hlNetToggle button[data-net="${next}"]`);
  if (btn){ btn.click(); addBubble("bot", `Switching Hyperliquid to **${next}**.`); }
  else addBubble("bot", "Open the Trading tab first, then I can flip the network.");
}
function clearChat(){
  history = [];
  body.innerHTML = "";
  greet();
}
function openSettings(){
  if (settingsEl.hidden) settingsBtn.click();
}

let cmdOpen = false, cmdActive = -1, cmdFlat = [];
function flatCommands(filter){
  const groups = buildCommands();
  const q = (filter || "").toLowerCase();
  const out = [];
  for (const g of groups){
    const items = q ? g.items.filter(it => (it.name + " " + it.desc).toLowerCase().includes(q)) : g.items;
    if (items.length) out.push({ group: g.group, items });
  }
  return out;
}
function openCmd(filter){
  cmdOpen = true; cmdActive = 0;
  slashBtn.classList.add("on");
  input.setAttribute("aria-expanded", "true");
  renderCmd(filter);
  cmdEl.hidden = false;
}
function closeCmd(){
  if (!cmdOpen) return;
  cmdOpen = false; cmdActive = -1;
  cmdEl.hidden = true;
  slashBtn.classList.remove("on");
  input.setAttribute("aria-expanded", "false");
}
function renderCmd(filter){
  const groups = flatCommands(filter);
  cmdFlat = groups.flatMap(g => g.items);
  if (!cmdFlat.length){ cmdEl.innerHTML = `<div class="cmd-empty">No commands match “${escapeHtml(filter || "")}”.</div>`; return; }
  let i = 0, html = "";
  for (const g of groups){
    html += `<div class="cmd-group">${escapeHtml(g.group)}</div>`;
    for (const it of g.items){
      const idx = i++;
      const key = it.run === toggleNetwork ? "net" : "";
      html += `<div class="cmd-row${idx === cmdActive ? " active" : ""}" role="option" data-i="${idx}" aria-selected="${idx === cmdActive}">
        <span class="cmd-ic">${ICONS[it.icon] || ICONS.nav}</span>
        <span class="cmd-txt"><span class="cmd-name">${escapeHtml(it.name)}</span><span class="cmd-desc">${escapeHtml(it.desc)}</span></span>
        ${key ? `<span class="cmd-key">${key}</span>` : ""}</div>`;
    }
  }
  cmdEl.innerHTML = html;
}
function cmdSetActive(i){
  cmdActive = Math.max(0, Math.min(i, cmdFlat.length - 1));
  cmdEl.querySelectorAll(".cmd-row").forEach((r, idx) => {
    const on = idx === cmdActive;
    r.classList.toggle("active", on); r.setAttribute("aria-selected", String(on));
    if (on) r.scrollIntoView({ block: "nearest" });
  });
}
function cmdRun(i){
  const it = cmdFlat[i];
  if (!it) return;
  closeCmd();
  input.value = "";
  it.run();
}

slashBtn?.addEventListener("click", () => {
  if (cmdOpen){ closeCmd(); input.focus(); }
  else { input.value = ""; openCmd(""); input.focus(); }
});
cmdEl?.addEventListener("click", (e) => {
  const row = e.target.closest(".cmd-row");
  if (row) cmdRun(Number(row.dataset.i));
});
cmdEl?.addEventListener("mousemove", (e) => {
  const row = e.target.closest(".cmd-row");
  if (row) cmdSetActive(Number(row.dataset.i));
});

input?.addEventListener("input", () => {
  const v = input.value;
  if (v.startsWith("/")){ if (!cmdOpen) openCmd(v.slice(1)); else renderCmd(v.slice(1)); }
  else if (cmdOpen) closeCmd();
});
input?.addEventListener("keydown", (e) => {
  if (cmdOpen){
    if (e.key === "ArrowDown"){ e.preventDefault(); cmdSetActive(cmdActive + 1); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); cmdSetActive(cmdActive - 1); }
    else if (e.key === "Enter"){ e.preventDefault(); cmdRun(cmdActive); }
    else if (e.key === "Escape"){ e.preventDefault(); closeCmd(); }
  }
});

/* ─── open / close + welcome ───────────────────────────────── */
let welcomed = false;
function greet(){
  addBubble("bot", getKey()
    ? "Hey — I'm your LZ copilot. Ask me anything, tell me where to go, or hit `/` for commands."
    : "Hey — I'm your LZ copilot. I can walk you through any tab right now. Add an Anthropic API key (gear icon) and I'll unlock the full Claude assistant.");
  renderChips(GREET_CHIPS);
}
function openPanel(){
  if (!panel.hidden) return;
  panel.classList.remove("closing");
  panel.hidden = false;
  fab.classList.add("on");
  fab.classList.remove("attn");
  fab.setAttribute("aria-expanded", "true");
  flagSuggestionSeen();
  if (!welcomed){ welcomed = true; greet(); }
  setTimeout(() => input.focus(), 80);
}
function closePanel(){
  if (panel.hidden) return;
  closeCmd();
  fab.classList.remove("on");
  fab.setAttribute("aria-expanded", "false");
  if (reduce()){ panel.hidden = true; return; }
  panel.classList.add("closing");
  setTimeout(() => { panel.classList.remove("closing"); panel.hidden = true; }, 240);
  fab.focus();
}

/* attention pulse — call when there's a suggestion worth surfacing */
function flagSuggestion(){ if (panel.hidden) fab.classList.add("attn"); }
function flagSuggestionSeen(){ fab.classList.remove("attn"); }

/* ─── FAB magnetic hover ───────────────────────────────────── */
if (fab && !reduce()){
  const strength = 0.22;
  fab.addEventListener("pointermove", (e) => {
    if (!panel.hidden) return;
    const r = fab.getBoundingClientRect();
    const mx = e.clientX - (r.left + r.width / 2);
    const my = e.clientY - (r.top + r.height / 2);
    fab.style.transform = `translate(${mx * strength}px, ${my * strength}px) scale(1.05)`;
  });
  fab.addEventListener("pointerleave", () => { fab.style.transform = ""; });
}

/* ─── wiring ───────────────────────────────────────────────── */
fab?.addEventListener("click", () => panel.hidden ? openPanel() : closePanel());
$("copilotClose")?.addEventListener("click", closePanel);
form?.addEventListener("submit", (e) => { e.preventDefault(); if (cmdOpen){ cmdRun(cmdActive); return; } send(input.value); });

// global Esc closes the panel when open
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panel.hidden && !cmdOpen){ closePanel(); }
});

settingsBtn?.addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
  if (!settingsEl.hidden){ keyInput.value = getKey(); modelSelect?.setValue(getModel()); }
});
$("copilotKeySave")?.addEventListener("click", () => {
  const k = keyInput.value.trim();
  if (k) localStorage.setItem(LS.KEY, k); else localStorage.removeItem(LS.KEY);
  localStorage.setItem(LS.MODEL, modelSel.value);
  settingsEl.hidden = true; reflectMode();
  addBubble("bot", k ? "Claude is connected. Ask away — I can read your live app state and set things up for you." : "Key removed — back to offline mode.");
});
$("copilotKeyClear")?.addEventListener("click", () => {
  localStorage.removeItem(LS.KEY); keyInput.value = ""; reflectMode();
});

/* upgrade the native model <select> to a CustomSelect (simple rows) */
let modelSelect = null;
if (modelSel){
  modelSel.value = getModel();
  try {
    modelSelect = new CustomSelect({ select: modelSel, searchable: false, bottomSheet: false, title: "Model" });
  } catch { modelSelect = null; }
}

reflectMode();

/* expose for other modules / the app */
window.LZ = Object.assign(window.LZ || {}, {
  assistant: {
    open: openPanel, close: closePanel,
    ask: (t) => { openPanel(); send(t); },
    suggest: flagSuggestion,   // pulse the FAB when there's something to offer
  },
});
