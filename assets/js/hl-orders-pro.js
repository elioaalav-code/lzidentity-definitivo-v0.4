/* =====================================================================
 *  hl-orders-pro.js — ADVANCED ORDER TYPES (Hyperliquid parity)
 *  ---------------------------------------------------------------------
 *  Renders inside #hlProMount (bottom of the order ticket): a collapsible
 *  "Advanced" panel with three tools that drive the signed exec primitives
 *  added to hyperliquid.js:
 *    · TP / SL   — take-profit and/or stop-loss trigger orders (reduceOnly)
 *                  -> HL.placeTrigger, or a bracket via HL.placeOrders.
 *    · Scale     — a price-ladder of N limit orders between two prices
 *                  -> HL.placeOrders (grouping "na"), with a preview table
 *                  and a TIF selector (GTC / ALO post-only).
 *    · TWAP      — native Hyperliquid TWAP over a duration -> HL.placeTwap.
 *
 *  Every funds-moving submit goes through an explicit review→confirm step
 *  (real funds on mainnet), shows a loading state, toasts success/error,
 *  then calls window.LZ.hl.refreshUser(). All DOM/window.LZ access guarded,
 *  all injected text escaped. No build, no libs.
 *
 *  NOTE: native TWAP runs on Hyperliquid's engine; cancellation is done
 *  from the exchange (no twapCancel primitive is wired here yet).
 * ===================================================================== */

import * as HL from "./hyperliquid.js";
import { state, toast } from "./shared.js";

(function initHlOrdersPro(){
  const mount = document.getElementById("hlProMount");
  if (!mount) return;

  /* ─── helpers ────────────────────────────────────────────── */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
  const coinNow = () => { try { return window.LZ?.hl?.coin?.() || "BTC"; } catch { return "BTC"; } };
  const account = () => { try { return window.LZ?.hl?.account?.() || state.account || null; } catch { return state.account || null; } };
  const net = () => { try { return HL.getNetwork(); } catch { return "testnet"; } };
  const refreshUser = () => { try { window.LZ?.hl?.refreshUser?.(); } catch {} };
  const fmtPx = (n) => { const v = num(n); return v == null ? "—" :
    v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) :
    v >= 1    ? v.toLocaleString("en-US", { maximumFractionDigits: 3 }) :
                v.toLocaleString("en-US", { maximumFractionDigits: 6 }); };

  // current mark price (best-effort, for % presets / previews)
  let mark = null;
  async function refreshMark(){
    try {
      const mids = await HL.allMids();
      const m = num(mids?.[coin]);
      if (m != null && m > 0){ mark = m; paintMark(); }
    } catch {}
  }
  function paintMark(){
    const el = mount.querySelector("#proMark");
    if (el) el.textContent = mark != null ? fmtPx(mark) : "—";
  }

  /* ─── state ──────────────────────────────────────────────── */
  let coin = coinNow();
  let tab = "tpsl";          // tpsl | scale | twap
  let pending = null;        // { label, run: async () => {...} } awaiting confirm
  let busy = false;

  /* ─── scaffold ───────────────────────────────────────────── */
  mount.classList.add("hl-pro");
  mount.innerHTML = `
    <button type="button" class="pro-toggle" id="proToggle" aria-expanded="false">
      <span>Advanced orders</span>
      <span class="pro-coinlbl"><em id="proCoin">${esc(coin)}</em> · mark <em id="proMark">—</em></span>
      <svg class="pro-chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="pro-body" id="proBody" hidden>
      <div class="pro-tabs" id="proTabs" role="tablist">
        <button data-tab="tpsl" class="on" role="tab">TP / SL</button>
        <button data-tab="scale" role="tab">Scale</button>
        <button data-tab="twap" role="tab">TWAP</button>
      </div>
      <div class="pro-panel" id="proPanel"></div>
      <div class="pro-confirm" id="proConfirm" hidden></div>
    </div>`;

  const $ = (sel) => mount.querySelector(sel);
  const body = $("#proBody");

  $("#proToggle").addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    $("#proToggle").setAttribute("aria-expanded", String(open));
    if (open){ renderPanel(); refreshMark(); }
  });
  $("#proTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    $("#proTabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    clearConfirm();
    renderPanel();
  });

  /* ─── side toggle markup (shared) ────────────────────────── */
  const sideToggle = (id, buyLabel, sellLabel, def = "buy") => `
    <div class="pro-side" id="${id}" data-side="${def}">
      <button type="button" data-s="buy" class="${def === "buy" ? "on buy" : "buy"}">${esc(buyLabel)}</button>
      <button type="button" data-s="sell" class="${def === "sell" ? "on sell" : "sell"}">${esc(sellLabel)}</button>
    </div>`;
  function wireSide(id){
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-s]");
      if (!b) return;
      el.dataset.side = b.dataset.s;
      el.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    });
  }
  const sideOf = (id) => ($("#" + id)?.dataset.side) || "buy";

  /* ─── panels ─────────────────────────────────────────────── */
  function renderPanel(){
    const p = $("#proPanel");
    if (!p) return;
    if (tab === "tpsl") p.innerHTML = tpslPanel();
    else if (tab === "scale") p.innerHTML = scalePanel();
    else p.innerHTML = twapPanel();
    bindPanel();
  }

  function tpslPanel(){
    return `
      <p class="pro-hint">Reduce-only triggers to close a position. Set a take-profit, a stop-loss, or both.</p>
      ${sideToggle("tpslSide", "Sell to close long", "Buy to close short", "sell")}
      <label class="pro-field"><span>Size <em>${esc(coin)}</em></span><input id="tpslSize" inputmode="decimal" placeholder="0.0"></label>
      <div class="pro-grid2">
        <label class="pro-field"><span>Take-profit px</span><input id="tpPx" inputmode="decimal" placeholder="optional"></label>
        <label class="pro-field"><span>Stop-loss px</span><input id="slPx" inputmode="decimal" placeholder="optional"></label>
      </div>
      <label class="pro-check"><input type="checkbox" id="tpslMarket" checked> <span>Trigger as market order</span></label>
      <button class="btn accent pro-submit" id="tpslSubmit">Review triggers</button>`;
  }

  function scalePanel(){
    return `
      <p class="pro-hint">Ladder of limit orders evenly spread between two prices.</p>
      ${sideToggle("scaleSide", "Buy / Long", "Sell / Short", "buy")}
      <div class="pro-grid2">
        <label class="pro-field"><span>From px</span><input id="scFrom" inputmode="decimal" placeholder="0.0"></label>
        <label class="pro-field"><span>To px</span><input id="scTo" inputmode="decimal" placeholder="0.0"></label>
      </div>
      <div class="pro-grid2">
        <label class="pro-field"><span>Orders</span><input id="scCount" inputmode="numeric" placeholder="5" value="5"></label>
        <label class="pro-field"><span>Total size <em>${esc(coin)}</em></span><input id="scSize" inputmode="decimal" placeholder="0.0"></label>
      </div>
      <div class="pro-tif" id="scTif" data-tif="Gtc">
        <span>TIF</span>
        <button type="button" data-t="Gtc" class="on">GTC</button>
        <button type="button" data-t="Alo">ALO (post-only)</button>
      </div>
      <div class="pro-preview" id="scPreview"></div>
      <button class="btn accent pro-submit" id="scSubmit">Review ladder</button>`;
  }

  function twapPanel(){
    return `
      <p class="pro-hint">Native Hyperliquid TWAP — the order is sliced and worked over the duration on the exchange engine.</p>
      ${sideToggle("twSide", "Buy / Long", "Sell / Short", "buy")}
      <div class="pro-grid2">
        <label class="pro-field"><span>Total size <em>${esc(coin)}</em></span><input id="twSize" inputmode="decimal" placeholder="0.0"></label>
        <label class="pro-field"><span>Duration (min)</span><input id="twMin" inputmode="numeric" placeholder="30"></label>
      </div>
      <label class="pro-check"><input type="checkbox" id="twRand" checked> <span>Randomize slice timing</span></label>
      <label class="pro-check"><input type="checkbox" id="twReduce"> <span>Reduce only</span></label>
      <button class="btn accent pro-submit" id="twSubmit">Review TWAP</button>`;
  }

  /* ─── bind active panel ──────────────────────────────────── */
  function bindPanel(){
    if (tab === "tpsl"){
      wireSide("tpslSide");
      $("#tpslSubmit")?.addEventListener("click", submitTpsl);
    } else if (tab === "scale"){
      wireSide("scaleSide");
      const tif = $("#scTif");
      tif?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-t]"); if (!b) return;
        tif.dataset.tif = b.dataset.t;
        tif.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
        renderScalePreview();
      });
      ["scFrom","scTo","scCount","scSize"].forEach(id =>
        $("#" + id)?.addEventListener("input", renderScalePreview));
      $("#scSubmit")?.addEventListener("click", submitScale);
      renderScalePreview();
    } else {
      wireSide("twSide");
      $("#twSubmit")?.addEventListener("click", submitTwap);
    }
  }

  /* ─── scale ladder math + preview ────────────────────────── */
  function scaleOrders(){
    const from = num($("#scFrom")?.value), to = num($("#scTo")?.value);
    const count = Math.round(num($("#scCount")?.value) || 0);
    const total = num($("#scSize")?.value);
    if (from == null || to == null || from <= 0 || to <= 0) return { err: "Enter valid prices" };
    if (!(count >= 2 && count <= 50)) return { err: "Orders must be 2–50" };
    if (total == null || total <= 0) return { err: "Enter a total size" };
    const isBuy = sideOf("scaleSide") === "buy";
    const tif = $("#scTif")?.dataset.tif || "Gtc";
    const each = total / count;
    const step = (to - from) / (count - 1);
    const orders = [];
    for (let i = 0; i < count; i++){
      orders.push({ coin, isBuy, sz: each, px: from + step * i, type: "limit", tif, reduceOnly: false });
    }
    return { orders, each, isBuy, tif };
  }
  function renderScalePreview(){
    const pv = $("#scPreview");
    if (!pv) return;
    const r = scaleOrders();
    if (r.err){ pv.innerHTML = `<span class="pro-pv-msg">${esc(r.err)}</span>`; return; }
    const rows = r.orders.map(o =>
      `<div class="pro-pv-row"><span>${esc(fmtPx(o.px))}</span><span>${esc(o.sz.toLocaleString("en-US",{maximumFractionDigits:6}))}</span></div>`).join("");
    pv.innerHTML = `<div class="pro-pv-head"><span>Price</span><span>Size</span></div>${rows}`;
  }

  /* ─── submits → review/confirm ───────────────────────────── */
  function guardAccount(){
    if (!account()){ toast("connect a wallet first", "err"); return false; }
    return true;
  }

  function submitTpsl(){
    if (!guardAccount()) return;
    const isBuy = sideOf("tpslSide") === "buy";
    const sz = num($("#tpslSize")?.value);
    const tp = num($("#tpPx")?.value);
    const sl = num($("#slPx")?.value);
    const isMarket = !!$("#tpslMarket")?.checked;
    if (sz == null || sz <= 0) return toast("enter a size", "err");
    if (tp == null && sl == null) return toast("enter a TP and/or SL price", "err");
    const legs = [];
    if (tp != null) legs.push({ tpsl: "tp", triggerPx: tp });
    if (sl != null) legs.push({ tpsl: "sl", triggerPx: sl });
    const lines = legs.map(l => `${l.tpsl.toUpperCase()} @ ${fmtPx(l.triggerPx)}`).join(" · ");
    review(`${isBuy ? "Buy" : "Sell"} ${sz} ${coin} reduce-only — ${lines} (${isMarket ? "market" : "limit"} trigger)`,
      async () => {
        for (const l of legs){
          await HL.placeTrigger({ account: account(), coin, isBuy, sz, triggerPx: l.triggerPx, isMarket, tpsl: l.tpsl, reduceOnly: true });
        }
      });
  }

  function submitScale(){
    if (!guardAccount()) return;
    const r = scaleOrders();
    if (r.err) return toast(r.err, "err");
    review(`${r.isBuy ? "Buy" : "Sell"} ${r.orders.length} ${coin} limit orders (${r.tif}) from ${fmtPx(r.orders[0].px)} to ${fmtPx(r.orders[r.orders.length-1].px)}`,
      async () => { await HL.placeOrders({ account: account(), orders: r.orders, grouping: "na" }); });
  }

  function submitTwap(){
    if (!guardAccount()) return;
    const isBuy = sideOf("twSide") === "buy";
    const sz = num($("#twSize")?.value);
    const minutes = Math.round(num($("#twMin")?.value) || 0);
    const randomize = !!$("#twRand")?.checked;
    const reduceOnly = !!$("#twReduce")?.checked;
    if (sz == null || sz <= 0) return toast("enter a size", "err");
    if (!(minutes > 0)) return toast("enter a duration in minutes", "err");
    review(`TWAP ${isBuy ? "buy" : "sell"} ${sz} ${coin} over ${minutes} min${reduceOnly ? " · reduce-only" : ""}`,
      async () => { await HL.placeTwap({ account: account(), coin, isBuy, sz, minutes, reduceOnly, randomize }); });
  }

  /* ─── confirm sheet ──────────────────────────────────────── */
  function review(label, run){
    pending = { label, run };
    const c = $("#proConfirm");
    c.hidden = false;
    c.innerHTML = `
      <div class="pro-confirm-msg"><strong>Confirm — ${esc(net())}</strong><span>${esc(label)}</span></div>
      <div class="pro-confirm-actions">
        <button class="btn ghost xs" id="proCancel">Cancel</button>
        <button class="btn accent xs" id="proGo">Sign &amp; place ▸</button>
      </div>`;
    $("#proCancel").addEventListener("click", clearConfirm);
    $("#proGo").addEventListener("click", doConfirm);
  }
  function clearConfirm(){
    pending = null;
    const c = $("#proConfirm");
    if (c){ c.hidden = true; c.innerHTML = ""; }
  }
  async function doConfirm(){
    if (!pending || busy) return;
    busy = true;
    const go = $("#proGo");
    if (go){ go.disabled = true; go.textContent = "Signing…"; }
    try {
      await pending.run();
      toast("Order(s) placed", "ok");
      clearConfirm();
      refreshUser();
    } catch (e){
      toast(e?.message ? String(e.message).split("\n")[0] : "Order failed", "err");
      if (go){ go.disabled = false; go.textContent = "Sign & place ▸"; }
    } finally {
      busy = false;
    }
  }

  /* ─── react to coin / network changes ────────────────────── */
  function onCoin(){
    coin = coinNow();
    const cl = $("#proCoin"); if (cl) cl.textContent = coin;
    mark = null; paintMark();
    clearConfirm();
    if (!body.hidden){ renderPanel(); refreshMark(); }
  }
  window.addEventListener("lz:hl:coin", onCoin);
  window.addEventListener("lz:hl:net", () => { clearConfirm(); mark = null; paintMark(); if (!body.hidden) refreshMark(); });
})();
