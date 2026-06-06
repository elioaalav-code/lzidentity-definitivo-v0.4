/* =================================================================== *
 *  risk.js — pure, local risk engine (keyless). No DOM, no network.
 *  Inputs are passed in by callers (risk-watch.js / assistant.js).
 * =================================================================== */
export const RISK_CFG = {
  wLev:40, wLiq:40, wConc:20, levFull:10, liqWindow:0.25,
  liqAlertPct:8, pnlSwingPct:15, heatAlert:75, fundingHrPct:0.01,
  pollMs:25000, cooldownMs:600000,
};
const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
export function heatBand(heat){ if (heat>=75) return "hot"; if (heat>=41) return "elevated"; return "calm"; }

/* positions:[{coin,side,size,leverage,uPnLUsd,liquidationPx}] wallet:[{sym,chain,amount,usd}]
   markets:{[coin]:{markPx,funding}} */
export function computeRisk({ positions=[], wallet=[], markets={} } = {}){
  const pos = positions.map(p => {
    const mark = markets[p.coin]?.markPx ?? p.markPx ?? p.entryPx ?? 0;
    const notionalUsd = Math.abs(p.size||0) * mark;
    const distToLiqPct = (p.liquidationPx && mark) ? Math.abs(mark - p.liquidationPx)/mark*100 : null;
    return { coin:p.coin, side:p.side, notionalUsd, leverage:p.leverage ?? null,
      uPnLUsd:p.uPnLUsd ?? 0, liquidationPx:p.liquidationPx ?? null, distToLiqPct,
      funding: markets[p.coin]?.funding ?? null };
  });
  const totalNotionalUsd = pos.reduce((s,p)=>s+p.notionalUsd,0);
  const pick = (sym) => wallet.filter(w => w.sym===sym);
  const cashUsd = pick("USDC").reduce((s,w)=>s+(w.usd||0),0);
  const ethAmt  = pick("ETH").reduce((s,w)=>s+(w.amount||0),0);
  const ethUsd  = pick("ETH").reduce((s,w)=>s+(w.usd||0),0);
  const uPnL    = pos.reduce((s,p)=>s+p.uPnLUsd,0);
  const equity  = cashUsd + ethUsd + uPnL;
  const totalLeverage = equity>0 ? totalNotionalUsd/equity : 0;
  let nearestLiq = null;
  for (const p of pos) if (p.distToLiqPct!=null && (!nearestLiq || p.distToLiqPct<nearestLiq.distToLiqPct))
    nearestLiq = { coin:p.coin, distToLiqPct:p.distToLiqPct };
  const concentrationTopPct = totalNotionalUsd>0 ? Math.max(0,...pos.map(p=>p.notionalUsd))/totalNotionalUsd : 0;
  const netExposureByAsset = {};
  for (const p of pos){ const signed=(p.side==="long"?1:-1)*p.notionalUsd; netExposureByAsset[p.coin]=(netExposureByAsset[p.coin]||0)+signed; }
  if (ethUsd) netExposureByAsset.ETH = (netExposureByAsset.ETH||0)+ethUsd;
  const levC  = Math.min(totalLeverage/RISK_CFG.levFull,1)*RISK_CFG.wLev;
  const liqC  = nearestLiq ? clamp(1-(nearestLiq.distToLiqPct/100)/RISK_CFG.liqWindow,0,1)*RISK_CFG.wLiq : 0;
  const concC = concentrationTopPct*RISK_CFG.wConc;
  const heat  = Math.round(clamp(levC+liqC+concC,0,100));
  return { positions:pos, totals:{ totalNotionalUsd, totalLeverage, cashUsd,
    ethSpot:{amount:ethAmt,usd:ethUsd}, nearestLiq, heat, concentrationTopPct, netExposureByAsset } };
}

/* Diff two RiskReads → trigger events (rising-edge only). */
export function detectTriggers(prev, next, cfg = RISK_CFG){
  const events = [];
  const prevByCoin = {}; (prev?.positions || []).forEach(p => prevByCoin[p.coin] = p);
  const adverse = (p) => p.funding!=null && ((p.side==="long"&&p.funding>0)||(p.side==="short"&&p.funding<0)) && Math.abs(p.funding*100) >= cfg.fundingHrPct;
  for (const p of (next?.positions || [])){
    const pp = prevByCoin[p.coin];
    if (p.distToLiqPct!=null && p.distToLiqPct<=cfg.liqAlertPct && !(pp && pp.distToLiqPct!=null && pp.distToLiqPct<=cfg.liqAlertPct))
      events.push({ type:"liq", coin:p.coin, msg:`${p.coin} ${p.distToLiqPct.toFixed(1)}% from liquidation` });
    if (adverse(p) && !(pp && adverse(pp)))
      events.push({ type:"funding", coin:p.coin, msg:`${p.coin} funding turned against you` });
    if (pp){ const base = p.notionalUsd || 1; const swing = (p.uPnLUsd - pp.uPnLUsd)/base*100;
      if (Math.abs(swing) >= cfg.pnlSwingPct) events.push({ type:"pnl", coin:p.coin, msg:`${p.coin} P&L moved ${swing>=0?"+":""}${swing.toFixed(0)}%` }); }
  }
  if ((next?.totals?.heat ?? 0) >= cfg.heatAlert && !((prev?.totals?.heat ?? 0) >= cfg.heatAlert))
    events.push({ type:"heat", coin:null, msg:`Portfolio heat ${next.totals.heat} — consider de-risking` });
  return events;
}

/* per-key cooldown gate (rising-edge dedup for the watcher). */
export function makeCooldown(cooldownMs){
  const last = {};
  return { allow(key, now){ const t = last[key]; if (t != null && now - t < cooldownMs) return false; last[key] = now; return true; } };
}
