/* ============================================================ *
 *  community-add.js — the "search engine" to add your own DAOs.
 *
 *  A modal with three modes:
 *   · Discover DAOs  → live Snapshot search (window.LZ.gov.searchSpaces)
 *   · Nostr group    → add any community by hashtag (instant, keyless)
 *   · Advanced       → add by on-chain Governor address + chain
 *
 *  Added communities are built + persisted by daos.js; on success we call
 *  opts.onAdded(community) so the rail can re-render + open it.
 *
 *  Public API: window.LZ.communityAdd = { open(opts?) }
 * ============================================================ */
import {
  communityFromSnapshot, communityFromHashtag, communityFromGovernor,
  addUserCommunity,
} from "./daos.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let root = null;       // overlay element
let onAdded = null;    // callback
let searchTimer = null;
let searchSeq = 0;

function ensureRoot(){
  if (root) return root;
  root = document.createElement("div");
  root.className = "cadd-overlay";
  root.hidden = true;
  root.innerHTML = `
    <div class="cadd-panel" role="dialog" aria-modal="true" aria-label="Add a community">
      <div class="cadd-head">
        <h3>Add a community</h3>
        <button type="button" class="cadd-close" aria-label="Close">✕</button>
      </div>
      <div class="cadd-tabs" role="tablist">
        <button type="button" class="cadd-tab on" data-mode="dao">Discover DAOs</button>
        <button type="button" class="cadd-tab" data-mode="nostr">Nostr group</button>
        <button type="button" class="cadd-tab" data-mode="gov">Advanced</button>
      </div>
      <div class="cadd-body" id="caddBody"></div>
    </div>`;
  document.body.appendChild(root);

  root.querySelector(".cadd-close").addEventListener("click", close);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.addEventListener("keydown", (e) => { if (!root.hidden && e.key === "Escape") close(); });
  root.querySelectorAll(".cadd-tab").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  return root;
}

function setMode(mode){
  root.querySelectorAll(".cadd-tab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const body = root.querySelector("#caddBody");
  if (mode === "dao")   return renderDaoMode(body);
  if (mode === "nostr") return renderNostrMode(body);
  return renderGovMode(body);
}

/* ── Discover DAOs (Snapshot live search) ─────────────────────── */
function renderDaoMode(body){
  body.innerHTML = `
    <label class="cadd-field">
      <input type="search" id="caddSearch" placeholder="Search DAOs by name… (e.g. Uniswap, Aave, ENS)" autocomplete="off" />
    </label>
    <div class="cadd-results" id="caddResults">
      <p class="cadd-hint">Type to search the Snapshot index of thousands of DAOs.</p>
    </div>`;
  const input = body.querySelector("#caddSearch");
  const out = body.querySelector("#caddResults");
  input.focus();
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2){ out.innerHTML = `<p class="cadd-hint">Type to search the Snapshot index of thousands of DAOs.</p>`; return; }
    out.innerHTML = `<p class="cadd-hint">Searching…</p>`;
    searchTimer = setTimeout(() => runSearch(q, out), 300);
  });
}

async function runSearch(q, out){
  const seq = ++searchSeq;
  let results = [];
  try {
    if (window.LZ && window.LZ.gov && window.LZ.gov.searchSpaces){
      results = await window.LZ.gov.searchSpaces(q);
    }
  } catch (_) { results = []; }
  if (seq !== searchSeq) return; // a newer search superseded this one
  if (!window.LZ || !window.LZ.gov || !window.LZ.gov.searchSpaces){
    out.innerHTML = `<p class="cadd-hint">DAO search is loading — meanwhile add a Nostr group by hashtag, or a Governor address under Advanced.</p>`;
    return;
  }
  if (!results || !results.length){
    out.innerHTML = `<p class="cadd-hint">No DAOs found for “${esc(q)}”. Try another name, or add by hashtag / Governor address.</p>`;
    return;
  }
  out.innerHTML = results.map((s) => `
    <div class="cadd-result">
      <div class="cadd-result-meta">
        <b>${esc(s.name || s.id)}</b>
        <small>${esc(s.id)}${s.network ? " · chain " + esc(s.network) : ""}${s.followers != null ? " · " + Number(s.followers).toLocaleString() + " followers" : ""}</small>
      </div>
      <button type="button" class="btn accent sm cadd-add" data-space="${esc(s.id)}" data-name="${esc(s.name || s.id)}" data-network="${esc(s.network || "")}">Add</button>
    </div>`).join("");
  out.querySelectorAll(".cadd-add").forEach((b) =>
    b.addEventListener("click", () => {
      const c = communityFromSnapshot({ id: b.dataset.space, name: b.dataset.name, network: b.dataset.network });
      commit(c, b);
    }));
}

/* ── Nostr group (by hashtag) ─────────────────────────────────── */
function renderNostrMode(body){
  body.innerHTML = `
    <label class="cadd-field">
      <span class="cadd-prefix">#</span>
      <input type="text" id="caddTag" placeholder="hashtag — e.g. ethereum, defi, nouns" autocomplete="off" />
    </label>
    <p class="cadd-hint">Follows every Nostr post tagged with this hashtag, across the relays. Instant, no key needed to read.</p>
    <button type="button" class="btn accent cadd-submit" id="caddTagAdd">Add Nostr group</button>`;
  const input = body.querySelector("#caddTag");
  input.focus();
  const add = () => {
    const t = input.value.trim();
    if (!t){ input.focus(); return; }
    commit(communityFromHashtag(t), body.querySelector("#caddTagAdd"));
  };
  body.querySelector("#caddTagAdd").addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); add(); } });
}

/* ── Advanced (Governor address) ──────────────────────────────── */
function renderGovMode(body){
  body.innerHTML = `
    <label class="cadd-field"><input type="text" id="caddGovName" placeholder="DAO name" autocomplete="off" /></label>
    <label class="cadd-field">
      <select id="caddGovChain">
        <option value="1">Ethereum (mainnet)</option>
        <option value="42161">Arbitrum One</option>
      </select>
    </label>
    <label class="cadd-field"><input type="text" id="caddGovAddr" placeholder="Governor contract address (0x…)" autocomplete="off" /></label>
    <p class="cadd-hint">For an OpenZeppelin / GovernorBravo contract. Reads proposals on-chain; voting is a real on-chain transaction.</p>
    <button type="button" class="btn accent cadd-submit" id="caddGovAdd">Add Governor</button>`;
  body.querySelector("#caddGovAdd").addEventListener("click", () => {
    const name = body.querySelector("#caddGovName").value.trim();
    const chain = body.querySelector("#caddGovChain").value;
    const governor = body.querySelector("#caddGovAddr").value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(governor)){ body.querySelector("#caddGovAddr").focus(); return; }
    commit(communityFromGovernor({ name, chain, governor }), body.querySelector("#caddGovAdd"));
  });
}

/* ── add + persist + notify ───────────────────────────────────── */
function commit(community, btnEl){
  const added = addUserCommunity(community);
  if (btnEl){ btnEl.textContent = added ? "Added ✓" : "Already added"; btnEl.disabled = true; }
  if (typeof onAdded === "function") onAdded(community);
  setTimeout(close, 450);
}

export function open(opts){
  ensureRoot();
  onAdded = (opts && opts.onAdded) || null;
  root.hidden = false;
  setMode("dao");
}
export function close(){
  if (!root) return;
  root.hidden = true;
  clearTimeout(searchTimer);
  searchSeq++;
}

window.LZ = window.LZ || {};
window.LZ.communityAdd = { open, close };
