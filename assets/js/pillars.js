/* ============================================================
 *  pillars.js · LZidentity — Recovery tab logic (v2.2 overhaul)
 *
 *  Recovery is the one identity pillar that remains after the
 *  v2.1 refocus. This file drives a fully-realized, mock-only
 *  social-recovery UX (no smart contracts):
 *
 *   - Guardian management with a state machine
 *       (pending → ready → expired → revoked)
 *   - Add-guardian flow (invite link + QR placeholder + copy);
 *       new guardians enter "pending" then auto-flip to "ready"
 *   - Threshold M-of-N stepper, reflected into the header KPI
 *   - Per-chain deployment chips (deployed / syncing)
 *   - Recovery drill: animated, deterministic 2-of-3 signature
 *       collection with a success / timeout result
 *   - Live activity feed (reduced-motion safe)
 *
 *  Mock-only — wired so the surface feels alive. All timings are
 *  deterministic and short for demo purposes.
 * ============================================================ */

import { toast } from "./shared.js";
import { coinAvatar, emptyState } from "./ui.js";

/* ---- reduced-motion guard ---------------------------------- */
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/* ---- DOM ---------------------------------------------------- */
const elGuardiansList = document.getElementById("recoveryGuardiansList");
const elGuardiansKPI  = document.getElementById("recoveryGuardians");
const elThresholdKPI  = document.getElementById("recoveryThreshold");
const elLastTest      = document.getElementById("recoveryLastTest");
const elChainsKPI     = document.getElementById("recoveryChains");
const elChainStatus   = document.getElementById("recoveryChainStatus");
const elFeed          = document.getElementById("recoveryFeed");
const elTestBtn       = document.getElementById("recoveryTest");

const elThreshVal     = document.getElementById("recoveryThreshVal");
const elThreshUp      = document.getElementById("recoveryThreshUp");
const elThreshDown    = document.getElementById("recoveryThreshDown");

const elAddBtn        = document.getElementById("recoveryAddBtn");
const elAddPanel      = document.getElementById("recoveryAddPanel");
const elAddClose      = document.getElementById("recoveryAddClose");
const elAddCancel     = document.getElementById("recoveryAddCancel");
const elAddConfirm    = document.getElementById("recoveryAddConfirm");
const elInviteName    = document.getElementById("recoveryInviteName");
const elInviteType    = document.getElementById("recoveryInviteType");
const elInviteLink    = document.getElementById("recoveryInviteLink");
const elInviteCopy    = document.getElementById("recoveryInviteCopy");
const elQR            = document.getElementById("recoveryQR");

const elDrill         = document.getElementById("recoveryDrill");

/* ============================================================
 *  Mock state
 * ============================================================ */
let threshold = 2; // M of N

/** Guardian state machine: pending | ready | expired | revoked */
const guardians = [
  { id: "g-maya",   name: "Maya",        type: "friend",        state: "ready",   lastSeen: 2 * 3600 },          // 2h
  { id: "g-ledger", name: "Ledger Nano", type: "device",        state: "ready",   lastSeen: 26 * 3600 },         // ~1d
  { id: "g-phone",  name: "Backup phone",type: "device",        state: "expired", lastSeen: 19 * 86400 },        // 19d
];

const chains = [
  { id: "eth",  name: "Ethereum", state: "deployed" },
  { id: "arb",  name: "Arbitrum", state: "deployed" },
  { id: "op",   name: "Optimism", state: "deployed" },
  { id: "base", name: "Base",     state: "deployed" },
  { id: "sol",  name: "Solana",   state: "syncing"  },
];

/* ---- helpers ----------------------------------------------- */
function relTime(seconds){
  if (seconds < 90) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const BADGE = {
  pending: { label: "Pending", icon: clock() },
  ready:   { label: "Ready",   icon: check() },
  expired: { label: "Expired", icon: warn() },
  revoked: { label: "Revoked", icon: cross() },
};
const TYPE_LABEL = { friend: "Friend", device: "Device", "backup wallet": "Backup wallet" };

function clock(){ return `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5" stroke-linecap="round"/></svg>`; }
function check(){ return `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 8.5l3 3 6-6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function warn(){ return `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2.5 14 13H2L8 2.5Z" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.3v.01" stroke-linecap="round"/></svg>`; }
function cross(){ return `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>`; }

/* ============================================================
 *  Render: guardians
 * ============================================================ */
function avatarFor(name){
  // monogram avatar from first letters of the name
  const sym = String(name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2) || "?";
  return coinAvatar(sym, 44).outerHTML;
}

function renderGuardians(enterId = null){
  if (!elGuardiansList) return;
  elGuardiansList.innerHTML = "";

  const visible = guardians.filter(g => g.state !== "revoked" || true); // keep revoked (dimmed)
  if (visible.length === 0){
    elGuardiansList.appendChild(emptyState({
      icon: "🛟",
      title: "No guardians yet",
      body: "Add at least two people or devices you trust to enable recovery.",
      actionLabel: "Add guardian",
      onAction: openAddPanel,
    }));
    updateKPIs();
    return;
  }

  for (const g of guardians){
    const badge = BADGE[g.state];
    const row = document.createElement("div");
    row.className = `rec-guardian is-${g.state}`;
    row.setAttribute("role", "listitem");
    row.dataset.id = g.id;
    const seenTxt = g.state === "revoked" ? "removed"
      : g.state === "pending" ? "awaiting accept"
      : `seen ${relTime(g.lastSeen)}`;
    row.innerHTML = `
      <div class="rec-g-av">
        ${avatarFor(g.name)}
        <span class="rec-g-heart" aria-hidden="true"></span>
      </div>
      <div class="rec-g-body">
        <div class="rec-g-name">${esc(g.name)}</div>
        <div class="rec-g-meta">
          <span class="rec-g-type">${esc(TYPE_LABEL[g.type] || g.type)}</span>
          <span class="rec-g-seen"><span class="dot" aria-hidden="true"></span>${esc(seenTxt)}</span>
        </div>
      </div>
      <span class="rec-g-badge" role="status" aria-label="Status: ${badge.label}">${badge.icon}${badge.label}</span>`;
    if (enterId && g.id === enterId && !REDUCED) row.classList.add("rec-enter");
    elGuardiansList.appendChild(row);
  }
  updateKPIs();
}

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

/* ============================================================
 *  Render: chains
 * ============================================================ */
function renderChains(){
  if (!elChainStatus) return;
  elChainStatus.innerHTML = "";
  for (const c of chains){
    const chip = document.createElement("div");
    chip.className = `rec-chip ${c.id} ${c.state}`;
    chip.setAttribute("role", "listitem");
    chip.innerHTML = `
      <span class="rc-dot" aria-hidden="true"></span>
      <span class="rc-name">${esc(c.name)}</span>
      <span class="rc-state">${c.state === "deployed" ? "deployed" : "syncing"}</span>`;
    elChainStatus.appendChild(chip);
  }
}

/* ============================================================
 *  KPIs + threshold
 * ============================================================ */
function activeCount(){ return guardians.filter(g => g.state === "ready" || g.state === "pending").length; }
function totalCount(){ return guardians.filter(g => g.state !== "revoked").length; }

function updateKPIs(){
  if (elGuardiansKPI) elGuardiansKPI.innerHTML = `${activeCount()}<small>· active</small>`;
  const n = Math.max(totalCount(), 1);
  if (threshold > n) threshold = n;
  if (threshold < 1) threshold = 1;
  if (elThresholdKPI) elThresholdKPI.textContent = `${threshold} / ${n}`;
  if (elThreshVal) elThreshVal.innerHTML = `${threshold}<span class="rt-of">of</span>${n}`;
  if (elThreshDown) elThreshDown.disabled = threshold <= 1;
  if (elThreshUp) elThreshUp.disabled = threshold >= n;
  if (elChainsKPI) elChainsKPI.textContent = String(chains.length);
}

function bumpThreshold(delta){
  const n = Math.max(totalCount(), 1);
  const next = Math.min(Math.max(threshold + delta, 1), n);
  if (next === threshold) return;
  threshold = next;
  updateKPIs();
  if (elThreshVal && !REDUCED){
    elThreshVal.classList.remove("rt-bump");
    void elThreshVal.offsetWidth;
    elThreshVal.classList.add("rt-bump");
  }
  addFeedEvent(`Threshold set to <em>${threshold}-of-${n}</em> · by you`, "changed");
  toast(`recovery · threshold now ${threshold}-of-${n}`, "info", 2000);
}

elThreshUp?.addEventListener("click", () => bumpThreshold(+1));
elThreshDown?.addEventListener("click", () => bumpThreshold(-1));

/* ============================================================
 *  Add-guardian flow
 * ============================================================ */
let lastFocused = null;

function buildQR(){
  if (!elQR || elQR.childElementCount) return;
  // deterministic pseudo-random pattern for a QR placeholder
  let seed = 1337;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 81; i++){
    const cell = document.createElement("i");
    // always-on finder corners
    const r = Math.floor(i / 9), c = i % 9;
    const finder = (r < 3 && c < 3) || (r < 3 && c > 5) || (r > 5 && c < 3);
    if (!finder && rand() > 0.52) cell.className = "off";
    frag.appendChild(cell);
  }
  elQR.appendChild(frag);
}

function openAddPanel(){
  if (!elAddPanel) return;
  buildQR();
  lastFocused = document.activeElement;
  elAddPanel.hidden = false;
  if (!REDUCED) elAddPanel.classList.add("rec-open");
  elAddBtn?.setAttribute("aria-expanded", "true");
  // focus first field
  requestAnimationFrame(() => elInviteName?.focus());
  document.addEventListener("keydown", onAddKeydown);
}

function closeAddPanel(){
  if (!elAddPanel || elAddPanel.hidden) return;
  elAddPanel.hidden = true;
  elAddPanel.classList.remove("rec-open");
  elAddBtn?.setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onAddKeydown);
  (lastFocused instanceof HTMLElement ? lastFocused : elAddBtn)?.focus();
}

function onAddKeydown(e){
  if (e.key === "Escape"){ e.preventDefault(); closeAddPanel(); return; }
  if (e.key === "Tab"){
    // simple focus trap within the panel
    const focusable = elAddPanel.querySelectorAll(
      'button, input, select, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }
}

elAddBtn?.addEventListener("click", openAddPanel);
elAddClose?.addEventListener("click", closeAddPanel);
elAddCancel?.addEventListener("click", closeAddPanel);

elInviteCopy?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(elInviteLink.value); }
  catch { elInviteLink.select(); }
  elInviteCopy.textContent = "Copied ✓";
  toast("recovery · invite link copied", "ok", 1800);
  setTimeout(() => { if (elInviteCopy) elInviteCopy.textContent = "Copy"; }, 1600);
});

let addSeq = 0;
elAddConfirm?.addEventListener("click", () => {
  const name = (elInviteName?.value || "").trim() || "New guardian";
  const type = elInviteType?.value || "friend";
  const id = `g-new-${++addSeq}`;
  guardians.push({ id, name, type, state: "pending", lastSeen: 0 });
  closeAddPanel();
  renderGuardians(id);
  addFeedEvent(`Invitation sent to <em>${esc(name)}</em> · ${esc(TYPE_LABEL[type] || type)}`, "added");
  toast(`recovery · invite sent to ${name}`, "info", 2200);
  if (elInviteName) elInviteName.value = "";

  // mock: auto-flip pending → ready after a short delay
  setTimeout(() => {
    const g = guardians.find(x => x.id === id);
    if (!g || g.state !== "pending") return;
    g.state = "ready";
    g.lastSeen = 30; // just signed
    renderGuardians();
    addFeedEvent(`<em>${esc(g.name)}</em> accepted and signed in`, "added");
    toast(`recovery · ${g.name} is now a ready guardian`, "ok", 2400);
  }, 3200);
});

/* ============================================================
 *  Recovery drill — deterministic animated sequence
 * ============================================================ */
let drillRunning = false;

function eligibleSigners(){
  return guardians.filter(g => g.state === "ready").slice(0, Math.max(threshold, 2));
}

function avatarSmall(name){
  const sym = String(name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2) || "?";
  return coinAvatar(sym, 32).outerHTML;
}

function runDrill(){
  if (!elDrill || drillRunning) return;
  const signers = eligibleSigners();
  const need = Math.min(threshold, signers.length || threshold);

  // not enough ready guardians → deterministic timeout demo
  const willSucceed = signers.length >= need && need >= 1;

  drillRunning = true;
  elDrill.className = "rec-drill";
  elDrill.hidden = false;
  if (!REDUCED) elDrill.classList.add("rec-open");

  const total = need;
  elDrill.innerHTML = `
    <div class="rd-head">
      <div class="rd-title">Recovery drill<small>collecting ${need}-of-${Math.max(totalCount(),1)} signatures</small></div>
      <button type="button" class="rd-close" id="rdClose" aria-label="Close drill">✕</button>
    </div>
    <div class="rd-progress"><i id="rdBar"></i></div>
    <div class="rd-signers" id="rdSigners"></div>`;

  const bar = elDrill.querySelector("#rdBar");
  const list = elDrill.querySelector("#rdSigners");
  elDrill.querySelector("#rdClose").addEventListener("click", dismissDrill);

  // build signer rows (use available ready signers; pad with the need)
  const rows = [];
  for (let i = 0; i < need; i++){
    const g = signers[i] || { name: signers.length ? signers[0].name : "Guardian", };
    const row = document.createElement("div");
    row.className = "rd-signer";
    row.innerHTML = `
      <div class="rd-s-av">${avatarSmall(g.name)}</div>
      <div class="rd-s-name">${esc(g.name)}</div>
      <div class="rd-s-state">waiting</div>
      <div class="rd-s-check" aria-hidden="true">${check()}</div>`;
    list.appendChild(row);
    rows.push(row);
  }

  let signed = 0;
  const stepMs = REDUCED ? 350 : 1100;

  function signNext(i){
    if (i >= need){ finish(true); return; }
    const row = rows[i];
    const state = row.querySelector(".rd-s-state");
    row.classList.add("is-signing");
    state.textContent = "signing…";
    setTimeout(() => {
      // deterministic: if drill is meant to fail, stall on the last signer
      if (!willSucceed && i === need - 1){
        state.textContent = "no response";
        row.classList.remove("is-signing");
        finish(false);
        return;
      }
      row.classList.remove("is-signing");
      row.classList.add("is-signed");
      state.textContent = "signed ✓";
      signed++;
      bar.style.width = `${Math.round((signed / total) * 100)}%`;
      signNext(i + 1);
    }, stepMs);
  }

  function finish(ok){
    drillRunning = false;
    const dur = need * (REDUCED ? 0 : 1.1) + 3;
    if (ok){
      elDrill.classList.add("is-done");
      bar.style.width = "100%";
      appendResult(
        "✓",
        "Recovery would succeed",
        `${need} of ${Math.max(totalCount(),1)} guardians signed in ${dur.toFixed(0)}s · all chains via LayerZero.`,
        true
      );
      if (elLastTest){ elLastTest.firstChild.nodeValue = "now"; lastTestDays = 0; }
      addFeedEvent(`Recovery drill · <em>${need} of ${Math.max(totalCount(),1)} signed in ${dur.toFixed(0)} s</em>`, "ok");
      toast("recovery · drill passed, you're covered", "ok", 2600);
    } else {
      elDrill.classList.add("is-timeout");
      appendResult(
        "!",
        "Drill timed out",
        "Not enough guardians responded. Check who's expired, then try again.",
        false
      );
      addFeedEvent(`Recovery drill <em>timed out</em> · not enough responsive guardians`, "removed");
      toast("recovery · drill timed out — check guardian health", "err", 2800);
    }
  }

  function appendResult(ic, title, body, ok){
    const res = document.createElement("div");
    res.className = "rd-result";
    if (!REDUCED) res.classList.add("rec-pop");
    res.innerHTML = `
      <div class="rd-result-ic">${ic}</div>
      <div class="rd-result-tx"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>
      <div class="rd-result-btns">
        <button type="button" class="btn ghost xs" id="rdDismiss">Dismiss</button>
        <button type="button" class="btn ${ok ? "ghost" : "accent"} xs" id="rdRetry">Run again</button>
      </div>`;
    elDrill.appendChild(res);
    res.querySelector("#rdDismiss").addEventListener("click", dismissDrill);
    res.querySelector("#rdRetry").addEventListener("click", () => { dismissDrill(); runDrill(); });
    requestAnimationFrame(() => res.querySelector("#rdDismiss")?.focus());
  }

  // kick off
  bar.style.width = "0%";
  setTimeout(() => signNext(0), REDUCED ? 0 : 300);
}

function dismissDrill(){
  if (!elDrill) return;
  drillRunning = false;
  elDrill.hidden = true;
  elDrill.className = "rec-drill";
  elDrill.innerHTML = "";
  elTestBtn?.focus();
}

elTestBtn?.addEventListener("click", runDrill);

/* ============================================================
 *  Activity feed
 * ============================================================ */
const feedSamples = [
  { what: "Guardian Maya signed a heartbeat · <em>Arbitrum</em>",            badge: "ok" },
  { what: "Ledger Nano · proof-of-life confirmed · <em>Ethereum</em>",       badge: "ok" },
  { what: "Recovery rule re-confirmed across 5 chains · <em>LayerZero</em>", badge: "ok" },
  { what: "Threshold check · <em>2 of 3 guardians responsive</em>",          badge: "ok" },
];

function addFeedEvent(whatHtml, badge = "ok", timeTxt = "now"){
  if (!elFeed) return;
  const row = document.createElement("div");
  row.className = "recovery-event";
  row.innerHTML = `
    <span class="t">${esc(timeTxt)}</span>
    <span class="what">${whatHtml}</span>
    <span class="delta ${esc(badge)}">${esc(badge)}</span>`;
  if (!REDUCED){
    row.style.opacity = "0";
    row.style.transform = "translateY(-6px)";
  }
  elFeed.prepend(row);
  if (!REDUCED){
    requestAnimationFrame(() => {
      row.style.transition = "opacity .4s var(--ease), transform .4s var(--ease)";
      row.style.opacity = "1";
      row.style.transform = "none";
    });
  }
  while (elFeed.children.length > 10) elFeed.lastElementChild.remove();
}

/* only churn the recovery feed when the tab is visible and the recovery
 * route is actually on-screen (was running forever in the background). */
function recoveryActive(){
  return !document.hidden && !!document.querySelector('.view[data-view="recovery"].active');
}
function tickFeed(){
  if (!recoveryActive()) return;
  const s = feedSamples[Math.floor(Math.random() * feedSamples.length)];
  addFeedEvent(s.what, s.badge);
}

/* ---- liveness timers (paused-safe-ish; cheap) -------------- */
let feedTimer = null;
function startFeed(){ if (!feedTimer) feedTimer = setInterval(tickFeed, 14000); }
startFeed();

let lastTestDays = 7;
setInterval(() => {
  if (!elLastTest || !elLastTest.firstChild || !recoveryActive()) return;
  lastTestDays += 1 / 86400;
  elLastTest.firstChild.nodeValue = lastTestDays < 0.5 ? "now" : `${Math.floor(lastTestDays)} d`;
}, 5000);

/* ============================================================
 *  Init (and re-sync on route activation)
 * ============================================================ */
function initRecovery(){
  renderChains();
  renderGuardians();
  updateKPIs();
}
initRecovery();

window.addEventListener("lz:route", (e) => {
  if (e.detail?.route === "recovery") updateKPIs();
});
