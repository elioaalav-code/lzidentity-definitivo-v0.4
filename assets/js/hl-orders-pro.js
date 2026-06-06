/* =====================================================================
 *  hl-orders-pro.js — ADVANCED ORDER TYPES (Hyperliquid parity)
 *  ---------------------------------------------------------------------
 *  Renders inside #hlProMount (bottom of the order ticket): a collapsible
 *  "Advanced" panel with three tools that drive the signed exec primitives
 *  added to hyperliquid.js:
 *    · TP / SL   — take-profit and/or stop-loss trigger orders (reduceOnly)
 *                  -> HL.placeTrigger (individual), or a bracket via HL.placeOrders.
 *    · Scale     — a price-ladder of N limit orders between two prices
 *                  -> HL.placeOrders (grouping "na"), with a preview table
 *                  and a TIF selector (GTC / ALO post-only) + Flat/Ascending weight.
 *    · TWAP      — native Hyperliquid TWAP over a duration -> HL.placeTwap.
 *
 *  Every funds-moving submit goes through an explicit review→confirm step
 *  (real funds on mainnet), shows a loading state, toasts success/error,
 *  then calls window.LZ.hl.refreshUser(). All DOM/window.LZ access guarded,
 *  all injected text escaped. No build, no libs.
 * ===================================================================== */

import * as HL from "./hyperliquid.js";
import * as fmt from "./fmt-num.js";
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
  const isMainnet = () => { try { return HL.isMainnet(); } catch { return false; } };
  const refreshUser = () => { try { window.LZ?.hl?.refreshUser?.(); } catch {} };
  // Number formatting delegates to the shared fmt-num.js module.
  const fmtPx = (n, decimals) => {
    const coin = (() => { try { return window.LZ?.hl?.coin?.() || undefined; } catch { return undefined; } })();
    return fmt.price(n, decimals != null ? { decimals } : { coin });
  };
  const fmtSz = (n) => fmt.size(n, { decimals: 6 });
  const fmtNotional = (sz, px) => {
    const v = num(sz), p = num(px);
    if (v == null || p == null) return "—";
    return fmt.usd(v * p);
  };
  const fmtPct = (pct) => (pct == null ? "" : fmt.pct(pct));

  // localStorage persistence
  const LS_OPEN = "lz.pro.open";
  const LS_TAB  = "lz.pro.tab";
  const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v != null ? v : def; } catch { return def; } };
  const lsSet = (k, v)    => { try { localStorage.setItem(k, v); } catch {} };

  // mark price (best-effort, for % presets / previews / validation)
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
    // update tpsl live preview whenever mark updates
    if (tab === "tpsl" && !body.hidden){ updateTpslPreview(); updateRR(); }
  }

  /* ─── state ──────────────────────────────────────────────── */
  let coin = coinNow();
  let tab  = lsGet(LS_TAB, "tpsl");   // tpsl | scale | twap
  let pending = null;                  // { label, lines: [], run: async () => {...} } awaiting confirm
  let busy = false;
  let scaleDist = "flat";              // "flat" | "asc"

  /* ─── scaffold ───────────────────────────────────────────── */
  mount.classList.add("hl-pro");
  mount.innerHTML = `
    <button type="button" class="pro-toggle" id="proToggle" aria-expanded="false">
      <span class="pro-toggle-left">
        <svg class="pro-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
        <span class="pro-toggle-label">Advanced orders</span>
        <span class="pro-active-badge" aria-hidden="true">ON</span>
      </span>
      <span class="pro-coinlbl"><em id="proCoin">${esc(coin)}</em> · mark <em id="proMark">—</em></span>
    </button>
    <div class="pro-body" id="proBody" hidden>
      <nav class="pro-tabs" id="proTabs" role="tablist" aria-label="Order type">
        <div class="pro-tabs-track" aria-hidden="true">
          <div class="pro-tabs-indicator" id="proTabsIndicator"></div>
        </div>
        <button data-tab="tpsl"  role="tab" aria-selected="false" tabindex="-1">TP / SL</button>
        <button data-tab="scale" role="tab" aria-selected="false" tabindex="-1">Scale</button>
        <button data-tab="twap"  role="tab" aria-selected="false" tabindex="-1">TWAP</button>
      </nav>
      <div class="pro-panel" id="proPanel" role="tabpanel"></div>
      <div class="pro-confirm" id="proConfirm" hidden aria-live="polite"></div>
    </div>`;

  const $ = (sel) => mount.querySelector(sel);
  const body = $("#proBody");

  // restore open state from localStorage
  const wasOpen = lsGet(LS_OPEN, "false") === "true";
  if (wasOpen){
    body.hidden = false;
    $("#proToggle").setAttribute("aria-expanded", "true");
    renderPanel();
    refreshMark();
  }

  function setTabIndicator(){
    const tabs = $("#proTabs");
    if (!tabs) return;
    const active = tabs.querySelector(`button[data-tab="${CSS.escape(tab)}"]`);
    const indicator = $("#proTabsIndicator");
    if (!active || !indicator) return;
    const idx = [...tabs.querySelectorAll("button[data-tab]")].indexOf(active);
    indicator.style.setProperty("--tab-i", String(idx));
    tabs.querySelectorAll("button[data-tab]").forEach((b) => {
      const isActive = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(isActive));
      b.tabIndex = isActive ? 0 : -1;
    });
  }

  $("#proToggle").addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    $("#proToggle").setAttribute("aria-expanded", String(open));
    lsSet(LS_OPEN, String(open));
    if (open){ renderPanel(); refreshMark(); }
  });

  $("#proTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    lsSet(LS_TAB, tab);
    setTabIndicator();
    clearConfirm();
    renderPanel();
  });

  // keyboard navigation for tabs (arrow keys)
  $("#proTabs").addEventListener("keydown", (e) => {
    const tabs = [...mount.querySelectorAll("#proTabs button[data-tab]")];
    const idx  = tabs.findIndex(b => b === document.activeElement);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else return;
    e.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });

  /* ─── side-toggle markup (shared, sliding-pill matches ticket) ─── */
  const sideToggle = (id, buyLabel, sellLabel, def = "buy") => `
    <div class="pro-side" id="${esc(id)}" data-side="${def}" role="group" aria-label="Side">
      <button type="button" data-s="buy"  class="${def === "buy"  ? "on buy"  : "buy"}"  aria-pressed="${def === "buy"}">${esc(buyLabel)}</button>
      <button type="button" data-s="sell" class="${def === "sell" ? "on sell" : "sell"}" aria-pressed="${def === "sell"}">${esc(sellLabel)}</button>
    </div>`;
  function wireSide(id){
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-s]");
      if (!b) return;
      el.dataset.side = b.dataset.s;
      el.querySelectorAll("button").forEach(x => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      if (id === "tpslSide"){ updateTpslPreview(); updateRR(); }
    });
  }
  const sideOf = (id) => ($("#" + id)?.dataset.side) || "buy";

  /* ─── TP/SL percent/price toggle helper ───────────────────── */
  let tpslMode = "price";   // "price" | "pct"

  /* ─── TP/SL preset chips ──────────────────────────────────── */
  // TP presets: % above mark for sell-trigger (close long), below for buy-trigger (close short)
  // SL presets: % below mark for sell-trigger, above for buy-trigger
  const TP_PRESETS = [10, 25, 50];   // +%
  const SL_PRESETS = [5, 10, 15];    // -%

  function tpPresetChips(){
    return TP_PRESETS.map(p =>
      `<button type="button" class="pro-chip" data-preset="tp" data-val="${p}" title="TP +${p}%">+${p}%</button>`
    ).join("");
  }
  function slPresetChips(){
    return SL_PRESETS.map(p =>
      `<button type="button" class="pro-chip sl" data-preset="sl" data-val="${p}" title="SL −${p}%">−${p}%</button>`
    ).join("");
  }

  function tpslPanel(){
    const isConnected = !!account();
    if (!isConnected) return disconnectedState();
    const markAvail = mark != null;
    return `
      <p class="pro-hint">
        Reduce-only triggers on <strong>${esc(coin)}</strong>. Set a take-profit, stop-loss, or both.
        <span class="pro-hint-sub">Market trigger by default — uncheck for limit trigger.</span>
      </p>
      ${sideToggle("tpslSide", "Sell / close long", "Buy / close short", "sell")}
      <label class="pro-field" id="fieldTpslSize">
        <span>Size <em>${esc(coin)}</em></span>
        <div class="pro-input-wrap">
          <input id="tpslSize" inputmode="decimal" placeholder="0.0" autocomplete="off" aria-label="Size in ${esc(coin)}">
        </div>
      </label>
      <div class="pro-tpsl-mode-row">
        <span class="pro-field-label">Trigger prices</span>
        <div class="pro-pill-toggle" id="tpslModeToggle" data-mode="${tpslMode}">
          <button type="button" data-m="price" class="${tpslMode === "price" ? "on" : ""}">Abs. price</button>
          <button type="button" data-m="pct"   class="${tpslMode === "pct"   ? "on" : ""}">% offset</button>
        </div>
      </div>
      <div class="pro-grid2">
        <div class="pro-field" id="fieldTpPx">
          <label for="tpPx" class="pro-label-tp">Take-profit ${tpslMode === "pct" ? "%" : "px"}</label>
          <div class="pro-input-wrap pro-input-tp${tpslMode === "pct" ? " has-suffix" : ""}">
            <input id="tpPx" inputmode="decimal" placeholder="${tpslMode === "pct" ? "e.g. 10" : "optional"}" autocomplete="off" aria-label="Take-profit ${tpslMode === "pct" ? "percent" : "price"}">
            ${tpslMode === "pct" ? `<span class="pro-input-suffix">%</span>` : ""}
          </div>
        </div>
        <div class="pro-field" id="fieldSlPx">
          <label for="slPx" class="pro-label-sl">Stop-loss ${tpslMode === "pct" ? "%" : "px"}</label>
          <div class="pro-input-wrap pro-input-sl${tpslMode === "pct" ? " has-suffix" : ""}">
            <input id="slPx" inputmode="decimal" placeholder="${tpslMode === "pct" ? "e.g. 5" : "optional"}" autocomplete="off" aria-label="Stop-loss ${tpslMode === "pct" ? "percent" : "price"}">
            ${tpslMode === "pct" ? `<span class="pro-input-suffix">%</span>` : ""}
          </div>
        </div>
      </div>
      <div class="pro-presets">
        <div class="pro-preset-row">
          <span class="pro-preset-label">TP</span>
          <div class="pro-preset-chips" id="tpPresetChips">${tpPresetChips()}</div>
        </div>
        <div class="pro-preset-row">
          <span class="pro-preset-label">SL</span>
          <div class="pro-preset-chips" id="slPresetChips">${slPresetChips()}</div>
        </div>
      </div>
      <div class="pro-tpsl-preview" id="tpslPreview" aria-live="polite"></div>
      <div class="pro-rr-block" id="rrBlock" aria-live="polite"></div>
      <div class="pro-row-check">
        <label class="pro-check"><input type="checkbox" id="tpslMarket" checked> <span>Market trigger (faster fill)</span></label>
        <label class="pro-check"><input type="checkbox" id="tpslBracket"> <span>Place both at once (bracket)</span></label>
      </div>
      <button class="btn accent pro-submit" id="tpslSubmit">Review triggers</button>`;
  }

  function scalePanel(){
    const isConnected = !!account();
    if (!isConnected) return disconnectedState();
    return `
      <p class="pro-hint">
        Ladder of limit orders spread between two prices.
        <span class="pro-hint-sub">Flat: equal size each rung. Ascending: smaller near start, larger near end.</span>
      </p>
      ${sideToggle("scaleSide", "Buy / Long", "Sell / Short", "buy")}
      <div class="pro-grid2">
        <label class="pro-field" id="fieldScFrom">
          <span>From price</span>
          <div class="pro-input-wrap">
            <input id="scFrom" inputmode="decimal" placeholder="0.0" autocomplete="off" aria-label="From price">
          </div>
        </label>
        <label class="pro-field" id="fieldScTo">
          <span>To price</span>
          <div class="pro-input-wrap">
            <input id="scTo" inputmode="decimal" placeholder="0.0" autocomplete="off" aria-label="To price">
          </div>
        </label>
      </div>
      <div class="pro-grid2">
        <label class="pro-field" id="fieldScCount">
          <span>Orders <em class="pro-label-range">(2–20)</em></span>
          <div class="pro-input-wrap">
            <input id="scCount" inputmode="numeric" placeholder="5" value="5" autocomplete="off" aria-label="Number of orders">
          </div>
        </label>
        <label class="pro-field" id="fieldScSize">
          <span>Total size <em>${esc(coin)}</em></span>
          <div class="pro-input-wrap">
            <input id="scSize" inputmode="decimal" placeholder="0.0" autocomplete="off" aria-label="Total size in ${esc(coin)}">
          </div>
        </label>
      </div>
      <div class="pro-tif-row">
        <span class="pro-field-label">TIF</span>
        <div class="pro-tif" id="scTif" data-tif="Gtc" role="group" aria-label="Time in force">
          <button type="button" data-t="Gtc" class="on" aria-pressed="true">GTC</button>
          <button type="button" data-t="Alo" aria-pressed="false">ALO <span class="pro-tif-sub">post-only</span></button>
        </div>
      </div>
      <div class="pro-dist-row">
        <span class="pro-field-label">Distribution</span>
        <div class="pro-dist-toggle" id="scDist" role="group" aria-label="Size distribution">
          <button type="button" data-d="flat" class="${scaleDist === "flat" ? "on" : ""}" aria-pressed="${scaleDist === "flat"}">Flat</button>
          <button type="button" data-d="asc"  class="${scaleDist === "asc"  ? "on" : ""}" aria-pressed="${scaleDist === "asc"}">Ascending</button>
        </div>
      </div>
      <div class="pro-scale-summary" id="scSummary" hidden></div>
      <div class="pro-preview" id="scPreview" aria-label="Order ladder preview"></div>
      <button class="btn accent pro-submit" id="scSubmit">Review ladder</button>`;
  }

  function twapPanel(){
    const isConnected = !!account();
    if (!isConnected) return disconnectedState();
    return `
      <p class="pro-hint">
        Native Hyperliquid TWAP — sliced and worked over the duration on HL's engine.
        <span class="pro-hint-sub">Sub-order interval fixed at 30 s. To cancel, go to open orders on the exchange.</span>
      </p>
      ${sideToggle("twSide", "Buy / Long", "Sell / Short", "buy")}
      <div class="pro-grid2">
        <label class="pro-field" id="fieldTwSize">
          <span>Total size <em>${esc(coin)}</em></span>
          <div class="pro-input-wrap">
            <input id="twSize" inputmode="decimal" placeholder="0.0" autocomplete="off" aria-label="Total TWAP size">
          </div>
        </label>
        <label class="pro-field" id="fieldTwMin">
          <span>Duration</span>
          <div class="pro-input-wrap has-suffix">
            <input id="twMin" inputmode="numeric" placeholder="30" autocomplete="off" aria-label="Duration in minutes">
            <span class="pro-input-suffix">min</span>
          </div>
        </label>
      </div>
      <div class="pro-twap-summary" id="twSummary" aria-live="polite"></div>
      <div class="pro-row-check">
        <label class="pro-check"><input type="checkbox" id="twRand" checked> <span>Randomize slice timing</span></label>
        <label class="pro-check"><input type="checkbox" id="twReduce"> <span>Reduce only</span></label>
      </div>
      <button class="btn accent pro-submit" id="twSubmit">Review TWAP</button>`;
  }

  function disconnectedState(){
    return `
      <div class="pro-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Connect a wallet to use advanced orders.</span>
      </div>`;
  }

  /* ─── panels ─────────────────────────────────────────────── */
  function renderPanel(){
    const p = $("#proPanel");
    if (!p) return;
    if (tab === "tpsl")       p.innerHTML = tpslPanel();
    else if (tab === "scale") p.innerHTML = scalePanel();
    else                      p.innerHTML = twapPanel();
    bindPanel();
    setTabIndicator();
  }

  /* ─── bind active panel ──────────────────────────────────── */
  function bindPanel(){
    if (tab === "tpsl"){
      wireSide("tpslSide");
      // mode toggle
      const modeEl = $("#tpslModeToggle");
      modeEl?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-m]");
        if (!b) return;
        tpslMode = b.dataset.m;
        modeEl.dataset.mode = tpslMode;
        modeEl.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
        renderPanel();   // re-render to swap placeholder/suffix
      });
      // preset chips
      mount.addEventListener("click", handlePresetClick, { once: true });
      // NB: once:true would fire only once — use delegated handler that checks tab
      $("#tpPresetChips")?.addEventListener("click", (e) => {
        const ch = e.target.closest("[data-preset='tp']");
        if (!ch) return;
        applyTpPreset(Number(ch.dataset.val));
      });
      $("#slPresetChips")?.addEventListener("click", (e) => {
        const ch = e.target.closest("[data-preset='sl']");
        if (!ch) return;
        applySlPreset(Number(ch.dataset.val));
      });
      ["tpslSize","tpPx","slPx"].forEach(id => $("#" + id)?.addEventListener("input", () => { updateTpslPreview(); updateRR(); }));
      $("#tpslSubmit")?.addEventListener("click", submitTpsl);
      updateTpslPreview();
      updateRR();

    } else if (tab === "scale"){
      wireSide("scaleSide");
      const tif = $("#scTif");
      tif?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-t]"); if (!b) return;
        tif.dataset.tif = b.dataset.t;
        tif.querySelectorAll("button").forEach(x => {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        });
        renderScalePreview();
      });
      // distribution toggle
      const dist = $("#scDist");
      dist?.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-d]"); if (!b) return;
        scaleDist = b.dataset.d;
        dist.querySelectorAll("button").forEach(x => {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        });
        renderScalePreview();
      });
      // side change refreshes preview
      $("#scaleSide")?.addEventListener("click", () => renderScalePreview());
      ["scFrom","scTo","scCount","scSize"].forEach(id =>
        $("#" + id)?.addEventListener("input", renderScalePreview));
      $("#scSubmit")?.addEventListener("click", submitScale);
      renderScalePreview();

    } else {
      wireSide("twSide");
      ["twSize","twMin"].forEach(id => $("#" + id)?.addEventListener("input", updateTwapSummary));
      $("#twSide")?.addEventListener("click", updateTwapSummary);
      $("#twSubmit")?.addEventListener("click", submitTwap);
      updateTwapSummary();
    }
  }

  /* ─── TP/SL preset application ──────────────────────────── */
  function applyTpPreset(pct){
    const isBuy   = sideOf("tpslSide") === "buy";
    const tpInput = $("#tpPx");
    if (!tpInput) return;
    if (tpslMode === "pct"){
      tpInput.value = String(pct);
    } else {
      if (mark == null){ toast("Mark price unavailable — switch to % offset mode.", "err"); return; }
      // TP for sell (close long) = above mark; for buy (close short) = below mark
      const px = isBuy ? mark * (1 - pct / 100) : mark * (1 + pct / 100);
      tpInput.value = px.toPrecision(6);
    }
    updateTpslPreview(); updateRR();
  }

  function applySlPreset(pct){
    const isBuy   = sideOf("tpslSide") === "buy";
    const slInput = $("#slPx");
    if (!slInput) return;
    if (tpslMode === "pct"){
      slInput.value = String(pct);
    } else {
      if (mark == null){ toast("Mark price unavailable — switch to % offset mode.", "err"); return; }
      // SL for sell (close long) = below mark; for buy (close short) = above mark
      const px = isBuy ? mark * (1 + pct / 100) : mark * (1 - pct / 100);
      slInput.value = px.toPrecision(6);
    }
    updateTpslPreview(); updateRR();
  }

  /* ─── TP/SL live preview & validation ────────────────────── */
  function updateTpslPreview(){
    const pv = $("#tpslPreview");
    if (!pv) return;

    const isBuy  = sideOf("tpslSide") === "buy";
    const tpRaw  = $("#tpPx")?.value.trim();
    const slRaw  = $("#slPx")?.value.trim();
    const szV    = num($("#tpslSize")?.value);

    let tpResolved = null, slResolved = null;
    let tpDelta = null, slDelta = null;

    if (tpRaw){
      const v = num(tpRaw);
      if (v != null){
        if (tpslMode === "price"){
          tpResolved = v;
          tpDelta = mark != null ? ((tpResolved - mark) / mark * 100) : null;
        } else if (mark != null){
          tpResolved = isBuy ? mark * (1 - v / 100) : mark * (1 + v / 100);
          tpDelta = isBuy ? -v : v;
        }
      }
    }
    if (slRaw){
      const v = num(slRaw);
      if (v != null){
        if (tpslMode === "price"){
          slResolved = v;
          slDelta = mark != null ? ((slResolved - mark) / mark * 100) : null;
        } else if (mark != null){
          slResolved = isBuy ? mark * (1 + v / 100) : mark * (1 - v / 100);
          slDelta = isBuy ? v : -v;
        }
      }
    }

    // Inline validation — mark field errors visually
    const fieldTp = $("#fieldTpPx"), fieldSl = $("#fieldSlPx");
    const errs = [];
    let tpErr = false, slErr = false;

    if (tpResolved != null && mark != null){
      if (!isBuy && tpResolved <= mark){ errs.push("TP must be above mark for a sell trigger (closing long)."); tpErr = true; }
      if (isBuy  && tpResolved >= mark){ errs.push("TP must be below mark for a buy trigger (closing short)."); tpErr = true; }
    }
    if (slResolved != null && mark != null){
      if (!isBuy && slResolved >= mark){ errs.push("SL must be below mark for a sell trigger (closing long)."); slErr = true; }
      if (isBuy  && slResolved <= mark){ errs.push("SL must be above mark for a buy trigger (closing short)."); slErr = true; }
    }
    if (tpResolved != null && slResolved != null){
      if (!isBuy && slResolved >= tpResolved){ errs.push("SL must be below TP for sell triggers."); slErr = true; }
      if (isBuy  && slResolved <= tpResolved){ errs.push("SL must be above TP for buy triggers.");  slErr = true; }
    }
    fieldTp?.classList.toggle("is-err", tpErr);
    fieldSl?.classList.toggle("is-err", slErr);

    // Build preview rows
    const rows = [];
    if (tpResolved != null) rows.push(`
      <div class="pro-tpsl-row tp">
        <span class="pro-tpsl-badge tp">TP</span>
        <span class="pro-tpsl-px">${esc(fmtPx(tpResolved))}</span>
        ${tpDelta != null ? `<span class="pro-tpsl-delta">${esc(fmtPct(tpDelta))}</span>` : ""}
        ${szV != null && szV > 0 ? `<span class="pro-tpsl-notional">${esc(fmtNotional(szV, tpResolved))}</span>` : ""}
      </div>`);
    if (slResolved != null) rows.push(`
      <div class="pro-tpsl-row sl">
        <span class="pro-tpsl-badge sl">SL</span>
        <span class="pro-tpsl-px">${esc(fmtPx(slResolved))}</span>
        ${slDelta != null ? `<span class="pro-tpsl-delta">${esc(fmtPct(slDelta))}</span>` : ""}
        ${szV != null && szV > 0 ? `<span class="pro-tpsl-notional">${esc(fmtNotional(szV, slResolved))}</span>` : ""}
      </div>`);

    if (tpslMode === "pct" && mark == null){
      pv.innerHTML = `<p class="pro-pv-warn">Mark price unavailable — enter prices in absolute mode or wait for data.</p>`;
    } else if (rows.length === 0 && errs.length === 0){
      pv.innerHTML = "";
    } else {
      pv.innerHTML = `
        ${rows.length ? `<div class="pro-tpsl-rows">${rows.join("")}</div>` : ""}
        ${errs.map(e => `<p class="pro-pv-warn">${esc(e)}</p>`).join("")}`;
    }
  }

  /* ─── R:R readout + bar ─────────────────────────────────── */
  function updateRR(){
    const el = $("#rrBlock");
    if (!el) return;

    const isBuy      = sideOf("tpslSide") === "buy";
    const tpRaw      = $("#tpPx")?.value.trim();
    const slRaw      = $("#slPx")?.value.trim();

    // Resolve TP/SL to absolute prices (mirrors updateTpslPreview logic)
    let tpResolved = null, slResolved = null;
    if (tpRaw){
      const v = num(tpRaw);
      if (v != null){
        if (tpslMode === "price") tpResolved = v;
        else if (mark != null)   tpResolved = isBuy ? mark * (1 - v / 100) : mark * (1 + v / 100);
      }
    }
    if (slRaw){
      const v = num(slRaw);
      if (v != null){
        if (tpslMode === "price") slResolved = v;
        else if (mark != null)   slResolved = isBuy ? mark * (1 + v / 100) : mark * (1 - v / 100);
      }
    }

    // Need mark and at least one leg for any output
    if (mark == null || (tpResolved == null && slResolved == null)){
      el.innerHTML = "";
      return;
    }

    const rewardDist = tpResolved != null ? Math.abs(tpResolved - mark) : null;
    const riskDist   = slResolved != null ? Math.abs(slResolved - mark) : null;
    const rewardPct  = rewardDist != null ? (rewardDist / mark * 100) : null;
    const riskPct    = riskDist   != null ? (riskDist   / mark * 100) : null;

    // R:R ratio
    let rrLabel = "—";
    let rewardBarPct = 50, riskBarPct = 50;
    let hasBoth = rewardDist != null && riskDist != null && riskDist > 0;
    if (hasBoth){
      const ratio = rewardDist / riskDist;
      rrLabel = ratio.toFixed(2) + " : 1";
      const total = rewardDist + riskDist;
      rewardBarPct = Math.round((rewardDist / total) * 100);
      riskBarPct   = 100 - rewardBarPct;
    } else if (rewardDist != null && riskDist == null){
      rewardBarPct = 100; riskBarPct = 0;
    } else if (riskDist != null && rewardDist == null){
      rewardBarPct = 0; riskBarPct = 100;
    }

    const tpPctStr = rewardPct != null ? rewardPct.toFixed(2) + "%" : "—";
    const slPctStr = riskPct   != null ? riskPct.toFixed(2) + "%"   : "—";

    // Break-even note (purely informational — shown when both legs present)
    let beNote = "";
    if (hasBoth){
      const bePct = (riskDist / (rewardDist + riskDist) * 100).toFixed(1);
      beNote = `<p class="pro-rr-note">Win rate needed to break even (1:1 payout assumed): <strong>${esc(bePct)}%</strong></p>`;
    }

    el.innerHTML = `
      <div class="pro-rr-header">
        <span class="pro-rr-label">Risk : Reward</span>
        <span class="pro-rr-ratio ${hasBoth ? (rewardDist >= riskDist ? "rr-good" : "rr-warn") : ""}">${esc(rrLabel)}</span>
      </div>
      <div class="pro-rr-bar" aria-hidden="true">
        <div class="pro-rr-bar-reward" style="width:${rewardBarPct}%"></div>
        <div class="pro-rr-bar-risk"   style="width:${riskBarPct}%"></div>
      </div>
      <div class="pro-rr-legs">
        <span class="pro-rr-leg tp">
          <span class="pro-rr-dot tp"></span>
          Reward <strong>${esc(tpPctStr)}</strong>${rewardDist != null ? ` (${esc(fmtPx(rewardDist))})` : ""}
        </span>
        <span class="pro-rr-leg sl">
          <span class="pro-rr-dot sl"></span>
          Risk <strong>${esc(slPctStr)}</strong>${riskDist != null ? ` (${esc(fmtPx(riskDist))})` : ""}
        </span>
      </div>
      ${beNote}`;
  }

  /* ─── scale ladder math + preview ────────────────────────── */
  // ascending distribution: weights 1,2,...,n normalised to total
  function ascWeights(n){
    const sum = n * (n + 1) / 2;
    return Array.from({ length: n }, (_, i) => (i + 1) / sum);
  }

  function scaleOrders(){
    const from  = num($("#scFrom")?.value), to = num($("#scTo")?.value);
    const count = Math.round(num($("#scCount")?.value) || 0);
    const total = num($("#scSize")?.value);
    if (from == null || to == null || from <= 0 || to <= 0) return { err: "Enter valid from and to prices." };
    if (from === to)                    return { err: "From and to prices must differ." };
    if (!(count >= 2 && count <= 20))   return { err: "Order count must be between 2 and 20." };
    if (total == null || total <= 0)    return { err: "Enter a positive total size." };
    const isBuy = sideOf("scaleSide") === "buy";
    const tif   = $("#scTif")?.dataset.tif || "Gtc";
    const step  = (to - from) / (count - 1);
    const weights = scaleDist === "asc" ? ascWeights(count) : Array(count).fill(1 / count);
    const orders = [];
    for (let i = 0; i < count; i++){
      orders.push({ coin, isBuy, sz: total * weights[i], px: from + step * i, type: "limit", tif, reduceOnly: false });
    }
    const notional = total * ((from + to) / 2);
    return { orders, isBuy, tif, notional, from, to, weights };
  }

  function renderScalePreview(){
    const pv = $("#scPreview");
    const sm = $("#scSummary");
    if (!pv) return;
    const r = scaleOrders();
    if (r.err){
      pv.innerHTML = `<span class="pro-pv-msg">${esc(r.err)}</span>`;
      if (sm) sm.hidden = true;
      return;
    }
    // summary bar
    if (sm){
      sm.hidden = false;
      const isBuy = sideOf("scaleSide") === "buy";
      const distLabel = scaleDist === "asc" ? "ascending" : "flat";
      sm.innerHTML = `
        <span class="${isBuy ? "pro-sum-long" : "pro-sum-short"}">${esc(isBuy ? "BUY" : "SELL")}</span>
        <span>${esc(r.orders.length)} orders · ${esc(distLabel)}</span>
        <span class="pro-sum-ntl">≈ ${esc(fmtNotional(r.orders.reduce((a,o) => a + o.sz, 0), (r.from + r.to) / 2))}</span>`;
    }
    // maxSz for bar width ratio (ascending distribution)
    const maxSz = Math.max(...r.orders.map(o => o.sz));
    const rows = r.orders.map((o, i) => {
      const barPct = maxSz > 0 ? Math.round((o.sz / maxSz) * 100) : 0;
      return `<div class="pro-pv-row">
        <div class="pro-pv-bar" style="width:${barPct}%"></div>
        <span class="pro-pv-idx">${i + 1}</span>
        <span>${esc(fmtPx(o.px))}</span>
        <span>${esc(fmtSz(o.sz))}</span>
        <span class="pro-pv-ntl">${esc(fmtNotional(o.sz, o.px))}</span>
      </div>`;
    }).join("");
    pv.innerHTML = `
      <div class="pro-pv-head">
        <span>#</span><span>Price</span><span>Size</span><span>Notional</span>
      </div>${rows}`;
  }

  /* ─── TWAP summary block ───────────────────────────────────── */
  function updateTwapSummary(){
    const sm = $("#twSummary");
    if (!sm) return;
    const sz      = num($("#twSize")?.value);
    const minutes = Math.round(num($("#twMin")?.value) || 0);
    if (sz == null || sz <= 0 || !(minutes > 0)){
      sm.innerHTML = "";
      return;
    }
    const subOrders   = Math.ceil(minutes * 2);   // ~30 s intervals
    const szEach      = sz / subOrders;
    const isBuy       = sideOf("twSide") === "buy";
    const notional    = mark != null ? fmtNotional(sz, mark) : "—";
    sm.innerHTML = `
      <div class="pro-twap-stat">
        <span class="${isBuy ? "pro-sum-long" : "pro-sum-short"}">${esc(isBuy ? "BUY" : "SELL")}</span>
        <span>${esc(fmtSz(sz))} ${esc(coin)} over <strong>${esc(String(minutes))} min</strong></span>
        <span class="pro-sum-ntl">≈ ${esc(notional)}</span>
      </div>
      <div class="pro-twap-divider"></div>
      <div class="pro-twap-detail">~${esc(String(subOrders))} slices · ≈${esc(fmtSz(szEach))} ${esc(coin)} each · 30 s interval</div>
      <div class="pro-twap-note">To stop early, cancel from your open orders on the exchange.</div>`;
  }

  /* ─── submits → review/confirm ───────────────────────────── */
  function guardAccount(){
    if (!account()){ toast("Connect a wallet first.", "err"); return false; }
    return true;
  }

  function submitTpsl(){
    if (!guardAccount()) return;
    const isBuy    = sideOf("tpslSide") === "buy";
    const sz       = num($("#tpslSize")?.value);
    const tpRaw    = num($("#tpPx")?.value);
    const slRaw    = num($("#slPx")?.value);
    const isMarket = !!$("#tpslMarket")?.checked;
    const bracket  = !!$("#tpslBracket")?.checked;

    if (sz == null || sz <= 0)          return toast("Enter a size greater than zero.", "err");
    if (tpRaw == null && slRaw == null) return toast("Enter a TP and/or SL price.", "err");

    // resolve final prices
    let tp = null, sl = null;
    if (tpRaw != null){
      if (tpslMode === "price") tp = tpRaw;
      else if (mark != null)   tp = isBuy ? mark * (1 - tpRaw / 100) : mark * (1 + tpRaw / 100);
      else return toast("Mark price unavailable — switch to absolute price mode.", "err");
    }
    if (slRaw != null){
      if (tpslMode === "price") sl = slRaw;
      else if (mark != null)   sl = isBuy ? mark * (1 + slRaw / 100) : mark * (1 - slRaw / 100);
      else return toast("Mark price unavailable — switch to absolute price mode.", "err");
    }

    // Validation
    if (tp != null && mark != null){
      if (!isBuy && tp <= mark) return toast("TP must be above mark price for sell triggers (closing long).", "err");
      if (isBuy  && tp >= mark) return toast("TP must be below mark price for buy triggers (closing short).", "err");
    }
    if (sl != null && mark != null){
      if (!isBuy && sl >= mark) return toast("SL must be below mark price for sell triggers (closing long).", "err");
      if (isBuy  && sl <= mark) return toast("SL must be above mark price for buy triggers (closing short).", "err");
    }

    const legs = [];
    if (tp != null) legs.push({ tpsl: "tp", triggerPx: tp, label: `TP @ ${fmtPx(tp)}` });
    if (sl != null) legs.push({ tpsl: "sl", triggerPx: sl, label: `SL @ ${fmtPx(sl)}` });

    const triggerType = isMarket ? "Market trigger (faster fill)" : "Limit trigger";
    const lines = [
      `${isBuy ? "BUY" : "SELL"} ${fmtSz(sz)} ${coin} — reduce-only`,
      legs.map(l => l.label).join("   ·   "),
      triggerType,
      bracket && legs.length === 2 ? "Placed as a single bracket order." : "",
    ].filter(Boolean);

    review(lines,
      async () => {
        if (bracket && legs.length === 2){
          const orders = legs.map(l => ({
            coin, isBuy, sz, px: l.triggerPx, reduceOnly: true,
            trigger: { isMarket, triggerPx: l.triggerPx, tpsl: l.tpsl },
          }));
          await HL.placeOrders({ account: account(), orders, grouping: "na" });
        } else {
          for (const l of legs){
            await HL.placeTrigger({ account: account(), coin, isBuy, sz, triggerPx: l.triggerPx, isMarket, tpsl: l.tpsl, reduceOnly: true });
          }
        }
      });
  }

  function submitScale(){
    if (!guardAccount()) return;
    const r = scaleOrders();
    if (r.err) return toast(r.err, "err");
    const totalSz = r.orders.reduce((a, o) => a + o.sz, 0);
    const lines = [
      `${r.isBuy ? "BUY" : "SELL"} ${r.orders.length} limit orders — ${esc(coin)}`,
      `From ${fmtPx(r.orders[0].px)} → ${fmtPx(r.orders[r.orders.length - 1].px)}`,
      `${scaleDist === "asc" ? "Ascending" : "Flat"} distribution · TIF: ${r.tif === "Alo" ? "ALO (post-only)" : "GTC"}`,
      `Total size: ${fmtSz(totalSz)} ${coin} ≈ ${fmtNotional(totalSz, (r.from + r.to) / 2)}`,
    ];
    review(lines,
      async () => { await HL.placeOrders({ account: account(), orders: r.orders, grouping: "na" }); });
  }

  function submitTwap(){
    if (!guardAccount()) return;
    const isBuy      = sideOf("twSide") === "buy";
    const sz         = num($("#twSize")?.value);
    const minutes    = Math.round(num($("#twMin")?.value) || 0);
    const randomize  = !!$("#twRand")?.checked;
    const reduceOnly = !!$("#twReduce")?.checked;
    if (sz == null || sz <= 0)  return toast("Enter a size greater than zero.", "err");
    if (!(minutes > 0))         return toast("Enter a duration in minutes.", "err");
    const notional = mark != null ? `≈ ${fmtNotional(sz, mark)}` : "";
    const lines = [
      `TWAP ${isBuy ? "BUY" : "SELL"} ${fmtSz(sz)} ${coin} ${notional}`,
      `Duration: ${minutes} min · ${Math.ceil(minutes * 2)} slices · 30 s interval`,
      randomize  ? "Randomized slice timing." : "Fixed slice timing.",
      reduceOnly ? "Reduce-only." : "",
      "Cancel from the exchange (HL open orders) to stop early.",
    ].filter(Boolean);
    review(lines,
      async () => { await HL.placeTwap({ account: account(), coin, isBuy, sz, minutes, reduceOnly, randomize }); });
  }

  /* ─── confirm sheet (structured, network badge, spinner) ──── */
  function review(lines, run){
    pending = { lines, run };
    const c = $("#proConfirm");
    const mn = isMainnet();
    c.hidden = false;
    c.classList.toggle("is-mainnet", mn);
    c.innerHTML = `
      <div class="pro-confirm-header">
        ${mn
          ? `<span class="pro-net-badge mainnet">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
              MAINNET — real funds
             </span>`
          : `<span class="pro-net-badge testnet">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              TESTNET
             </span>`}
        <span class="pro-confirm-title">Confirm order</span>
      </div>
      <ul class="pro-confirm-lines">
        ${lines.map((l, i) => `<li class="${i === 0 ? "pro-confirm-primary" : "pro-confirm-secondary"}">${esc(l)}</li>`).join("")}
      </ul>
      <div class="pro-confirm-actions">
        <button class="btn ghost sm" id="proCancel">Cancel</button>
        <button class="btn accent sm pro-go-btn" id="proGo">
          Sign &amp; place
          <svg class="pro-go-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>`;
    $("#proCancel").addEventListener("click", clearConfirm);
    $("#proGo").addEventListener("click", doConfirm);
    c.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearConfirm(){
    pending = null;
    const c = $("#proConfirm");
    if (c){ c.hidden = true; c.innerHTML = ""; c.classList.remove("is-mainnet"); }
  }

  async function doConfirm(){
    if (!pending || busy) return;
    busy = true;
    const go = $("#proGo");
    if (go){
      go.disabled = true;
      go.innerHTML = `<span class="bt-spin" aria-hidden="true"></span>Signing…`;
    }
    try {
      await pending.run();
      toast("Order(s) placed successfully.", "ok");
      clearConfirm();
      refreshUser();
    } catch (e){
      const msg = e?.message ? String(e.message).split("\n")[0] : "Order failed.";
      toast(msg, "err");
      if (go){
        go.disabled = false;
        go.innerHTML = `Sign &amp; place <svg class="pro-go-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
      }
    } finally {
      busy = false;
    }
  }

  /* ─── react to coin / network changes ─────────────────────── */
  function onCoin(){
    coin = coinNow();
    const cl = $("#proCoin"); if (cl) cl.textContent = coin;
    mark = null; paintMark();
    clearConfirm();
    if (!body.hidden){ renderPanel(); refreshMark(); }
  }
  window.addEventListener("lz:hl:coin", onCoin);
  window.addEventListener("lz:hl:net",  () => {
    clearConfirm(); mark = null; paintMark();
    if (!body.hidden){ renderPanel(); refreshMark(); }
  });
})();
