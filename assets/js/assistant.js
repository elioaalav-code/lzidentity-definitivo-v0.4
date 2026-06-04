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

const LS = { KEY: "lz:ai:key", MODEL: "lz:ai:model" };
const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

const $ = (id) => document.getElementById(id);

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
const TOOLS = [
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
];

function runTool(name, args){
  const LZ = window.LZ || {};
  try {
    if (name === "navigate"){ LZ.navigate?.(args.tab); return { ok: true, opened: args.tab }; }
    if (name === "get_app_state"){ return LZ.snapshot ? LZ.snapshot() : { error: "state unavailable" }; }
    if (name === "set_trading_market"){ LZ.navigate?.("trade"); LZ.hl?.setCoin?.(String(args.coin).toUpperCase()); return { ok: true, market: String(args.coin).toUpperCase() }; }
    if (name === "prefill_order"){ LZ.navigate?.("trade"); LZ.hl?.prefillOrder?.(args); return { ok: true, note: "ticket pre-filled — the user must review and sign" }; }
  } catch (e){ return { error: String(e?.message || e) }; }
  return { error: "unknown tool" };
}

/* ─── system prompt (stable → cacheable) ───────────────────── */
const SYSTEM = `You are the LZ Assistant, a friendly in-app copilot for LZidentity — a web app for one identity that works across every chain, built on LayerZero.

The app has these tabs (you can open any with the navigate tool):
- chat: encrypted messaging across mesh, Nostr, and LayerZero (demo data).
- wallet: balances across chains, quick send (demo).
- markets: live top-coin prices and 7-day charts (real, from CoinGecko).
- trade: REAL on-chain perps trading on Hyperliquid. Live order book and candles. Orders are signed with the user's wallet and settle on-chain. There is a testnet/mainnet toggle — testnet by default. You can switch markets and pre-fill the order ticket, but the USER always signs every order. You never place orders yourself.
- network: a live stream of activity (demo).
- identity: sign one message with an EVM wallet to derive a matching Nostr identity. This part is real and deterministic.
- recovery: pick guardians who can restore your identity without a seed phrase (sketch).

How you help:
- Answer questions about what the app does and how to use any feature.
- When the user wants to go somewhere or do something, use your tools: navigate to a tab, read live state with get_app_state, switch the trading market, or pre-fill an order for them to review.
- For anything that moves funds or signs a transaction, set it up and explain it, but make clear the user signs it themselves.

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
function addBubble(role, text=""){
  const el = document.createElement("div");
  el.className = "cm " + role;
  el.innerHTML = `<div class="cm-b">${text ? mdLite(text) : ""}</div>`;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el.querySelector(".cm-b");
}
function addTrace(label){
  const el = document.createElement("div");
  el.className = "cm-trace";
  el.textContent = label;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}
function typing(on){
  let t = $("copilotTyping");
  if (on && !t){ t = document.createElement("div"); t.id = "copilotTyping"; t.className = "cm bot"; t.innerHTML = `<div class="cm-b typing"><span></span><span></span><span></span></div>`; body.appendChild(t); body.scrollTop = body.scrollHeight; }
  else if (!on && t){ t.remove(); }
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
      if (!bubble){ typing(false); bubble = addBubble("bot"); }
      acc += delta;
      bubble.innerHTML = mdLite(acc);
      body.scrollTop = body.scrollHeight;
    });
    typing(false);
    // assistant turn (sanitize tool blocks for the wire)
    history.push({ role: "assistant", content: blocks.map(b => b.type === "tool_use"
      ? { type: "tool_use", id: b.id, name: b.name, input: b.input || {} }
      : { type: "text", text: b.text }) });

    if (stopReason === "tool_use"){
      const results = [];
      for (const b of blocks.filter(x => x.type === "tool_use")){
        addTrace(`⚙ ${b.name}${b.input && Object.keys(b.input).length ? " · " + JSON.stringify(b.input) : ""}`);
        const out = runTool(b.name, b.input || {});
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
  wallet: "Wallet shows balances across chains and a quick-send form (demo).",
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
    const m = e.status === 401 ? "That API key was rejected. Check it in settings (gear icon)."
            : e.status === 429 ? "Rate limited by Anthropic — give it a moment and try again."
            : "Something went wrong: " + (e?.message || e);
    addBubble("bot", m);
  } finally { busy = false; input.focus(); }
}

/* ─── open / close + welcome ───────────────────────────────── */
let welcomed = false;
function openPanel(){
  panel.hidden = false;
  fab.classList.add("on");
  if (!welcomed){
    welcomed = true;
    addBubble("bot", getKey()
      ? "Hey — I'm your LZ copilot. Ask me anything, or tell me where to go: “open trading”, “show my balances”, “set up a 0.01 BTC long”."
      : "Hey — I'm your LZ copilot. I can walk you through any tab right now. Add an Anthropic API key (gear icon) and I'll unlock the full Claude assistant.");
  }
  setTimeout(() => input.focus(), 80);
}
function closePanel(){ panel.hidden = true; fab.classList.remove("on"); }

/* ─── wiring ───────────────────────────────────────────────── */
fab?.addEventListener("click", () => panel.hidden ? openPanel() : closePanel());
$("copilotClose")?.addEventListener("click", closePanel);
form?.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });

settingsBtn?.addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
  if (!settingsEl.hidden){ keyInput.value = getKey(); modelSel.value = getModel(); }
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

reflectMode();

/* expose for other modules / the app */
window.LZ = Object.assign(window.LZ || {}, {
  assistant: { open: openPanel, close: closePanel, ask: (t) => { openPanel(); send(t); } },
});
