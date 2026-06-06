/* =================================================================== *
 *  risk-watch.js — live input gather for risk.js (+ watcher in Task 6)
 * =================================================================== */
import { computeRisk, detectTriggers, makeCooldown, heatBand, RISK_CFG } from "./risk.js";
import * as HL from "./hyperliquid.js";

export async function gatherRiskInputs(){
  const LZ = window.LZ || {};
  const w = LZ.account?.() || null;
  const snap = LZ.snapshot?.() || {};
  const wallet = (snap.tokens || []).map(t => ({ sym:t.sym, chain:t.chain, amount:t.amount, usd:t.usd }));
  let positions = [], markets = {};
  if (w){
    try {
      const ch = await HL.clearinghouse(w);
      positions = (ch?.assetPositions || []).filter(p => +p.position.szi !== 0).map(p => { const s = +p.position.szi;
        return { coin:p.position.coin, side:s>0?"long":"short", size:Math.abs(s),
          leverage:p.position.leverage?.value ?? null, uPnLUsd:+p.position.unrealizedPnl || 0,
          liquidationPx:p.position.liquidationPx ? +p.position.liquidationPx : null }; });
    } catch {}
  }
  try {
    const [m, ctxs] = await HL.metaAndCtxs();
    (m?.universe || []).forEach((u,i) => { const c = ctxs[i] || {};
      markets[u.name] = { markPx:+c.markPx || null, funding:c.funding!=null ? +c.funding : null }; });
  } catch {}
  return { positions, wallet, markets };
}

let _lastRead = null;
export function lastRead(){ return _lastRead; }
export async function readNow(){ _lastRead = computeRisk(await gatherRiskInputs()); return _lastRead; }
export function _setLastRead(r){ _lastRead = r; }

window.LZ = window.LZ || {};
window.LZ.risk = { read: lastRead, readNow };

/* ── proactive watcher ────────────────────────────────────── */
const fab = () => document.getElementById("copilotFab");
const dot = () => document.querySelector("#copilotFab .copilot-fab-dot");
const cooldown = makeCooldown(RISK_CFG.cooldownMs);
const PRIORITY = { liq:3, heat:2, funding:1, pnl:0 };   // most-severe first
let _timer = null, _running = false, _pendingRisk = false;

function paintHeatRing(read){
  const el = fab(); if (!el) return;
  el.classList.remove("heat-calm","heat-elevated","heat-hot");
  if (!read || !read.positions.length) return;          // idle: no ring
  el.classList.add("heat-" + heatBand(read.totals.heat));
}
/* toast() is a singleton (one shared element) → show only the single most-severe
   event that passes cooldown this tick; set the FAB dot + arm the risk read. */
function fireAlerts(events){
  const passing = events.filter(ev => cooldown.allow(`${ev.type}:${ev.coin||"_"}`, Date.now()));
  if (!passing.length) return;
  passing.sort((a,b) => (PRIORITY[b.type]??0) - (PRIORITY[a.type]??0));
  const top = passing[0];
  const tone = (top.type === "liq" || top.type === "heat") ? "err" : "info";
  window.LZ?.toast?.(top.msg + " — tap the assistant", tone, 6000);
  dot()?.classList.add("on");
  _pendingRisk = true;
}
async function tick(){
  if (document.hidden) return;
  if (!window.LZ?.account?.()) { paintHeatRing(null); return; }
  let read; try { read = computeRisk(await gatherRiskInputs()); } catch { return; }
  const prev = lastRead(); _setLastRead(read);
  paintHeatRing(read);
  if (prev) fireAlerts(detectTriggers(prev, read));
}
export function start(){ if (_running) return; _running = true; tick(); _timer = setInterval(tick, RISK_CFG.pollMs); }
export function stop(){ _running = false; if (_timer) clearInterval(_timer); _timer = null; }

// auto-start on load; tapping the FAB clears the dot and, if an alert is pending,
// opens the risk read in the copilot panel (spec: tap → risk read).
window.addEventListener("load", () => { start();
  fab()?.addEventListener("click", () => {
    dot()?.classList.remove("on");
    if (_pendingRisk){ _pendingRisk = false; setTimeout(() => window.LZ?.copilot?.showRisk?.(), 250); }
  });
});
window.LZ.risk.start = start; window.LZ.risk.stop = stop;
window.LZ.risk._tickOnce = tick;        // test hook
