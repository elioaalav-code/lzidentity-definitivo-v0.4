/* =================================================================== *
 *  governance.js — v0.3 adapter-based on-chain governance engine (ESM)
 *
 *  Plain ESM, no build step, no bundler, no ethers. Calldata is hand-
 *  encoded like the rest of the app. Reads are keyless via public RPC
 *  (cfg.rpc, JSON-RPC over fetch so it works in the browser AND headless
 *  in Node); writes go through window.ethereum (EIP-1193).
 *
 *  Public API (frozen):
 *    listProposals(govCfg)            -> Promise<Proposal[]>
 *    getProposal(govCfg, id)          -> Promise<Proposal>
 *    castVote(govCfg, proposalId, support) -> Promise<{txHash}|{error}>
 *    proposalStateLabel(p)            -> string
 *    renderGovernance(el, govCfg)     -> void
 *
 *  Proposal = { id, title, body, state, choices:[{label,votes}],
 *               totalVotes, startsAt, endsAt, url, source }
 *
 *  Adapters keyed by govCfg.adapter:
 *    'governor'  — OpenZeppelin Governor / GovernorBravo
 *    'layerzero' — LayerZero fee-switch referendum (binary, ~6-mo cadence)
 *    unknown / null → [] + tidy "no governance connected" empty state
 *
 *  Never throws to the caller; always degrades to empty/error states.
 * =================================================================== */

/* ------------------------------------------------------------------ *
 *  Low-level JSON-RPC (keyless reads). Mirrors app.js rpcCall().
 *  Works in browser and headless Node (global fetch ≥ Node 18).
 * ------------------------------------------------------------------ */
async function rpcCall(url, method, params){
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error("rpc " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

/* window.ethereum provider (writes only) */
function provider(){
  return (typeof window !== "undefined" && window.ethereum) ? window.ethereum : null;
}

/* =================================================================== *
 *  PURE HELPERS (Node-testable, TDD'd)
 * =================================================================== */

/* ---- Governor state enum (OZ IGovernor / GovernorBravo share order) ---- */
export const GOVERNOR_STATES = [
  "Pending",   // 0
  "Active",    // 1
  "Canceled",  // 2
  "Defeated",  // 3
  "Succeeded", // 4
  "Queued",    // 5
  "Expired",   // 6
  "Executed",  // 7
];

/* map a numeric governor state -> canonical string. Out-of-range → "Unknown". */
export function governorStateName(n){
  const i = Number(n);
  return GOVERNOR_STATES[i] || "Unknown";
}

/* Human label for a Proposal in any adapter. Falls back to the raw state. */
export function proposalStateLabel(p){
  if (!p || p.state == null) return "Unknown";
  const s = String(p.state);
  const map = {
    Pending: "Pending", Active: "Active", Canceled: "Canceled",
    Defeated: "Defeated", Succeeded: "Succeeded", Queued: "Queued",
    Expired: "Expired", Executed: "Executed",
    // layerzero referendum states
    Open: "Voting open", Closed: "Closed", Passed: "Passed", Failed: "Failed",
    Unknown: "Unknown",
  };
  return map[s] || s;
}

/* state -> css modifier token (for colored pills) */
export function stateTone(state){
  switch (String(state)){
    case "Active": case "Open":            return "live";
    case "Succeeded": case "Queued":
    case "Executed": case "Passed":        return "good";
    case "Defeated": case "Expired":
    case "Canceled": case "Failed":        return "bad";
    case "Pending":                        return "wait";
    default:                               return "neutral";
  }
}

/* ---- hex helpers ---- */
export function hexToBigInt(hex){
  try { return BigInt(hex || "0x0"); } catch { return 0n; }
}

/* left-pad a hex value (no 0x) to 32 bytes / 64 nibbles */
export function pad32(hexNo0x){
  return String(hexNo0x).replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/* encode a uint256 to a 32-byte hex word (no 0x) */
export function encodeUint256(value){
  return pad32(BigInt(value).toString(16));
}

/* encode a uint8 to a 32-byte hex word (no 0x) — ABI right-aligns it */
export function encodeUint8(value){
  const v = BigInt(value) & 0xffn;
  return pad32(v.toString(16));
}

/* ---- tally math: derive choices/total/winner from raw vote weights ---- */
/* votes: array of { label, votes:BigInt|number|string } -> normalized + pct */
export function tallyChoices(raw){
  const choices = (raw || []).map(c => ({
    label: String(c.label),
    votes: hexToBigInt(typeof c.votes === "bigint" ? "0x" + c.votes.toString(16) : c.votes),
  }));
  let total = 0n;
  for (const c of choices) total += c.votes;
  return {
    choices: choices.map(c => ({
      label: c.label,
      votes: c.votes.toString(),
      pct: total > 0n ? Number((c.votes * 10000n) / total) / 100 : 0,
    })),
    totalVotes: total.toString(),
  };
}

/* Standard Governor votes order is (against, for, abstain). Build choices. */
export function governorChoices(against, forVotes, abstain){
  return tallyChoices([
    { label: "For",     votes: forVotes },
    { label: "Against", votes: against },
    { label: "Abstain", votes: abstain },
  ]);
}

/* title = first non-empty markdown line of a Governor proposal description.
   Strips leading "# " heading markers; trims; caps length for the rail. */
export function titleFromDescription(description){
  const text = String(description || "").replace(/\r\n/g, "\n");
  const first = text.split("\n").map(l => l.trim()).find(l => l.length > 0) || "";
  const clean = first.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
  if (!clean) return "Untitled proposal";
  return clean.length > 120 ? clean.slice(0, 117) + "…" : clean;
}

/* castVote(uint256,uint8) selector — keccak256("castVote(uint256,uint8)")[:4] */
export const CAST_VOTE_SELECTOR = "0x56781388";

/* hand-encode castVote(proposalId, support) calldata (no ethers) */
export function encodeCastVote(proposalId, support){
  return CAST_VOTE_SELECTOR + encodeUint256(proposalId) + encodeUint8(support);
}

/* ABI-decode a single string at the tail of an event `data` blob.
   For ProposalCreated the last param is the `description` string. We locate
   it via its head offset word, then read [len][bytes]. Returns "" on failure. */
export function decodeTrailingString(dataHexNo0x, offsetWordIndex){
  try {
    const data = String(dataHexNo0x).replace(/^0x/, "");
    const word = (i) => data.slice(i * 64, i * 64 + 64);
    // the head word at offsetWordIndex is a byte-offset into `data`
    const byteOffset = Number(BigInt("0x" + word(offsetWordIndex)));
    const lenHex = data.slice(byteOffset * 2, byteOffset * 2 + 64);
    const len = Number(BigInt("0x" + lenHex));
    if (!Number.isFinite(len) || len <= 0 || len > 1_000_000) return "";
    const start = byteOffset * 2 + 64;
    const strHex = data.slice(start, start + len * 2);
    return hexToUtf8(strHex);
  } catch { return ""; }
}

/* hex (no 0x) -> utf-8 string */
export function hexToUtf8(hexNo0x){
  const hex = String(hexNo0x).replace(/^0x/, "");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  try { return new TextDecoder().decode(bytes); }
  catch { return Array.from(bytes).map(b => String.fromCharCode(b)).join(""); }
}

/* topic0 for ProposalCreated. Both OZ Governor and GovernorBravo emit the
   SAME signature & topic:
     ProposalCreated(uint256 proposalId, address proposer, address[] targets,
       uint256[] values, string[] signatures, bytes[] calldatas,
       uint256 startBlock, uint256 endBlock, string description)
   keccak256 of that signature → */
export const PROPOSAL_CREATED_TOPIC =
  "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0";

/* From a ProposalCreated log, pull { id, startBlock, endBlock, description }.
   All non-indexed params live in `log.data`. Layout (word index):
     0 proposalId
     1 proposer
     2 targets offset
     3 values offset
     4 signatures offset
     5 calldatas offset
     6 startBlock
     7 endBlock
     8 description offset
   description is the trailing dynamic string at head word 8. */
export function parseProposalCreated(log){
  try {
    const data = String(log.data || "").replace(/^0x/, "");
    const word = (i) => data.slice(i * 64, i * 64 + 64);
    const id = BigInt("0x" + word(0)).toString();
    const startBlock = Number(BigInt("0x" + word(6)));
    const endBlock = Number(BigInt("0x" + word(7)));
    const description = decodeTrailingString(data, 8);
    return { id, startBlock, endBlock, description };
  } catch { return null; }
}

/* =================================================================== *
 *  ADAPTER: 'governor'  (OZ Governor / GovernorBravo)
 * =================================================================== */

/* selectors */
const SEL_STATE          = "0x3e4f49e6"; // state(uint256)
const SEL_PROPOSAL_VOTES = "0x544ffc9c"; // OZ Governor: proposalVotes(uint256) -> (against,for,abstain)
const SEL_PROPOSALS      = "0x013cf08b"; // GovernorBravo: proposals(uint256) -> struct
/* GovernorBravo proposals(id) struct word offsets:
   0 id · 1 proposer · 2 eta · 3 startBlock · 4 endBlock
   5 forVotes · 6 againstVotes · 7 abstainVotes · 8 canceled · 9 executed */

/* default look-back window (blocks). ~ 6 weeks on Ethereum mainnet @ 12s.
   Wide enough to catch sparse Governor activity (e.g. Uniswap) on the first
   load; "Load older" widens it further. */
const GOV_DEFAULT_LOOKBACK = 300_000;
/* eth_getLogs are often range-limited by public RPCs; chunk to stay safe.
   Public nodes commonly cap at 50k (publicnode), some far less — we chunk at
   45k and individual failing chunks are skipped, never fatal. */
const GOV_LOG_CHUNK = 45_000;

async function getBlockNumber(rpc){
  const hex = await rpcCall(rpc, "eth_blockNumber", []);
  return Number(BigInt(hex));
}

/* fetch ProposalCreated logs across [fromBlock, toBlock], chunked. */
async function getProposalLogs(rpc, governor, fromBlock, toBlock){
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += GOV_LOG_CHUNK){
    const end = Math.min(start + GOV_LOG_CHUNK - 1, toBlock);
    try {
      const chunk = await rpcCall(rpc, "eth_getLogs", [{
        address: governor,
        topics: [PROPOSAL_CREATED_TOPIC],
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
      }]);
      if (Array.isArray(chunk)) logs.push(...chunk);
    } catch { /* skip the failed chunk, keep what we have */ }
  }
  return logs;
}

/* read live state + tallies for one proposalId */
async function governorLiveState(rpc, governor, id){
  const idWord = encodeUint256(id);
  let state = "Unknown", choicesObj = governorChoices(0, 0, 0);
  try {
    const stateHex = await rpcCall(rpc, "eth_call",
      [{ to: governor, data: SEL_STATE + idWord }, "latest"]);
    state = governorStateName(Number(hexToBigInt(stateHex)));
  } catch { /* leave Unknown */ }
  // OZ Governor exposes proposalVotes() -> (against, for, abstain).
  // GovernorBravo (e.g. Uniswap) does NOT — it reverts — and instead exposes
  // proposals() returning a struct with forVotes/againstVotes/abstainVotes at
  // word offsets 5/6/7. Try OZ first, fall back to Bravo.
  let gotVotes = false;
  try {
    const votesHex = await rpcCall(rpc, "eth_call",
      [{ to: governor, data: SEL_PROPOSAL_VOTES + idWord }, "latest"]);
    const raw = String(votesHex || "").replace(/^0x/, "");
    if (raw.length >= 192){
      const against  = "0x" + raw.slice(0, 64);
      const forVotes = "0x" + raw.slice(64, 128);
      const abstain  = "0x" + raw.slice(128, 192);
      choicesObj = governorChoices(against, forVotes, abstain);
      gotVotes = true;
    }
  } catch { /* fall through to Bravo */ }
  if (!gotVotes){
    try {
      const sHex = await rpcCall(rpc, "eth_call",
        [{ to: governor, data: SEL_PROPOSALS + idWord }, "latest"]);
      const raw = String(sHex || "").replace(/^0x/, "");
      const word = (i) => "0x" + raw.slice(i * 64, i * 64 + 64);
      if (raw.length >= 64 * 8){
        const forVotes = word(5), against = word(6), abstain = word(7);
        choicesObj = governorChoices(against, forVotes, abstain);
      }
    } catch { /* leave zeros */ }
  }
  return { state, ...choicesObj };
}

function explorerBase(chain){
  switch (Number(chain)){
    case 1:     return "https://etherscan.io";
    case 42161: return "https://arbiscan.io";
    case 10:    return "https://optimistic.etherscan.io";
    case 8453:  return "https://basescan.org";
    case 137:   return "https://polygonscan.com";
    default:    return null;
  }
}

function governorExplorerUrl(chain, governor){
  const base = explorerBase(chain);
  return base && governor ? `${base}/address/${governor}` : null;
}

async function governorList(cfg, { lookback } = {}){
  const { rpc, governor, chain } = cfg;
  if (!rpc || !governor) return [];
  let latest;
  try { latest = await getBlockNumber(rpc); } catch { return []; }
  const span = lookback || GOV_DEFAULT_LOOKBACK;
  const fromBlock = Math.max(0, latest - span);
  const logs = await getProposalLogs(rpc, governor, fromBlock, latest);

  // newest first, dedupe by id
  const seen = new Set();
  const parsed = [];
  for (const log of logs.reverse()){
    const p = parseProposalCreated(log);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    parsed.push(p);
  }

  // hydrate live state (sequential to be kind to public RPCs)
  const url = governorExplorerUrl(chain, governor);
  const out = [];
  for (const p of parsed){
    const live = await governorLiveState(rpc, governor, p.id);
    out.push(buildGovernorProposal(p, live, url));
  }
  return out;
}

function buildGovernorProposal(p, live, url){
  return {
    id: p.id,
    title: titleFromDescription(p.description),
    body: String(p.description || ""),
    state: live.state,
    choices: live.choices,
    totalVotes: live.totalVotes,
    startsAt: null,        // block-based; coordinator may map block→time
    endsAt: null,
    startBlock: p.startBlock,
    endBlock: p.endBlock,
    url: url || null,
    source: "governor",
  };
}

async function governorGet(cfg, id){
  const { rpc, governor, chain } = cfg;
  if (!rpc || !governor) return null;
  // we need the description from the creation log → search recent window
  let latest;
  try { latest = await getBlockNumber(rpc); } catch { return null; }
  const fromBlock = Math.max(0, latest - (GOV_DEFAULT_LOOKBACK * 4));
  const logs = await getProposalLogs(rpc, governor, fromBlock, latest);
  let found = null;
  for (const log of logs){
    const p = parseProposalCreated(log);
    if (p && p.id === String(id)){ found = p; break; }
  }
  if (!found) found = { id: String(id), description: "", startBlock: null, endBlock: null };
  const live = await governorLiveState(rpc, governor, found.id);
  return buildGovernorProposal(found, live, governorExplorerUrl(chain, governor));
}

async function governorVote(cfg, proposalId, support){
  const p = provider();
  if (!p) return { error: "No wallet connected" };
  const { governor, chain } = cfg;
  if (!governor) return { error: "Governor address not configured" };
  try {
    // switch to the governor's chain first (best-effort)
    if (chain != null){
      try {
        const cur = parseInt(await p.request({ method: "eth_chainId" }), 16);
        if (cur !== Number(chain)){
          await p.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + Number(chain).toString(16) }],
          });
        }
      } catch (e) {
        if (e?.code === 4001) return { error: "Network switch rejected" };
        return { error: "Could not switch network — add it in your wallet first" };
      }
    }
    const accounts = await p.request({ method: "eth_requestAccounts" }).catch(() => []);
    const from = Array.isArray(accounts) ? accounts[0] : null;
    if (!from) return { error: "No wallet account" };
    const data = encodeCastVote(proposalId, support);
    const txHash = await p.request({
      method: "eth_sendTransaction",
      params: [{ from, to: governor, data }],
    });
    return { txHash };
  } catch (e) {
    if (e?.code === 4001) return { error: "Transaction rejected" };
    return { error: e?.message ? String(e.message).split("\n")[0] : "Transaction failed" };
  }
}

/* =================================================================== *
 *  ADAPTER: 'layerzero'  (fee-switch referendum — binary, ~6-mo cadence)
 *
 *  EXPECTED voteContract ABI / SHAPE (coordinator fills the real address):
 *  ----------------------------------------------------------------------
 *  The adapter reads ONE active referendum and its binary tally. It expects
 *  a read method returning the current window + tallies + deadline. Two
 *  shapes are supported out of the box; wire whichever the real contract
 *  exposes by setting cfg.shape ('packed' default, or 'split'):
 *
 *  shape:'packed' (default) — single view:
 *    currentReferendum() -> (
 *      uint256 id,
 *      uint64  startTime,      // unix seconds
 *      uint64  endTime,        // unix seconds (deadline)
 *      uint256 forVotes,       // weight voting ACTIVATE  (choice index 1)
 *      uint256 againstVotes,   // weight voting DEACTIVATE (choice index 0)
 *      uint8   status          // 0 None,1 Open,2 Passed,3 Failed,4 Closed
 *    )
 *    selector: keccak256("currentReferendum()")[:4]  — set cfg.selRead if it differs
 *
 *  shape:'split' — discrete getters (set the selectors in cfg.sel*):
 *    activeReferendumId() -> uint256
 *    referendumWindow(uint256) -> (uint64 start, uint64 end)
 *    referendumTally(uint256)  -> (uint256 activate, uint256 deactivate)
 *    referendumStatus(uint256) -> uint8
 *
 *  WRITE — vote on the user's current chain:
 *    castReferendumVote(uint256 id, uint8 choice)   choice 0=deactivate,1=activate
 *    selector default keccak256("castReferendumVote(uint256,uint8)")[:4]
 *    override via cfg.selVote. If the real contract uses castVote(uint256,uint8)
 *    set cfg.selVote = CAST_VOTE_SELECTOR.
 *
 *  Until cfg.voteContract is a real address the adapter NO-OPS cleanly:
 *  listProposals → [] and the UI shows "no active referendum".
 *  ----------------------------------------------------------------------
 * =================================================================== */

const LZ_STATUS = ["None", "Open", "Passed", "Failed", "Closed"];

function lzStatusName(n){
  return LZ_STATUS[Number(n)] || "Unknown";
}

/* Canonical 4-byte selectors for the signatures documented above.
   Coordinator overrides via cfg.selRead / cfg.selVote if the real contract
   uses different names. These are keccak256(sig)[:4]:
     currentReferendum()               -> 0x6c68bd6d
     castReferendumVote(uint256,uint8) -> 0xb95aa3bd
   Until cfg.voteContract is a real address the adapter no-ops regardless. */
const LZ_SEL_CURRENT = "0x6c68bd6d";      // override via cfg.selRead
const LZ_SEL_VOTE_DEFAULT = "0xb95aa3bd"; // override via cfg.selVote

function isUnsetAddress(addr){
  if (!addr) return true;
  const a = String(addr).trim().toLowerCase();
  return a === "" || a === "0x" || a === "0x0000000000000000000000000000000000000000"
    || a === "todo" || a === "0xtodo";
}

async function layerzeroList(cfg){
  const { rpc, voteContract } = cfg;
  // No real address yet → clean no-op. Same when there is simply no read path.
  if (isUnsetAddress(voteContract) || !rpc) return [];
  const selRead = cfg.selRead || LZ_SEL_CURRENT;
  if (!selRead || selRead === "0x") return []; // ABI not wired yet → no-op

  try {
    const res = await rpcCall(rpc, "eth_call",
      [{ to: voteContract, data: selRead }, "latest"]);
    const raw = String(res || "").replace(/^0x/, "");
    if (!raw) return [];
    const word = (i) => raw.slice(i * 64, i * 64 + 64);
    // packed shape decode
    const id        = BigInt("0x" + word(0));
    const startTime = Number(BigInt("0x" + word(1)));
    const endTime   = Number(BigInt("0x" + word(2)));
    const forVotes  = "0x" + word(3);
    const against   = "0x" + word(4);
    const status    = Number(BigInt("0x" + word(5)));
    if (status === 0) return []; // None → no active referendum
    const tally = tallyChoices([
      { label: "Activate fee switch",   votes: forVotes },
      { label: "Deactivate fee switch", votes: against },
    ]);
    return [{
      id: id.toString(),
      title: "LayerZero fee-switch referendum",
      body: "Binary referendum on activating the LayerZero protocol fee switch. "
          + "Vote Activate or Deactivate. Recurs roughly every 6 months across chains.",
      state: lzStatusName(status),
      choices: tally.choices,
      totalVotes: tally.totalVotes,
      startsAt: startTime ? startTime * 1000 : null,
      endsAt: endTime ? endTime * 1000 : null,
      url: null,
      source: "layerzero",
    }];
  } catch { return []; }
}

async function layerzeroVote(cfg, proposalId, support){
  const p = provider();
  if (!p) return { error: "No wallet connected" };
  const { voteContract } = cfg;
  if (isUnsetAddress(voteContract)) return { error: "No active referendum" };
  const selVote = cfg.selVote || LZ_SEL_VOTE_DEFAULT;
  if (!selVote || selVote === "0x") return { error: "Voting not yet available" };
  try {
    const accounts = await p.request({ method: "eth_requestAccounts" }).catch(() => []);
    const from = Array.isArray(accounts) ? accounts[0] : null;
    if (!from) return { error: "No wallet account" };
    // vote from the user's current chain (multichain referendum)
    const data = selVote + encodeUint256(proposalId) + encodeUint8(support);
    const txHash = await p.request({
      method: "eth_sendTransaction",
      params: [{ from, to: voteContract, data }],
    });
    return { txHash };
  } catch (e) {
    if (e?.code === 4001) return { error: "Transaction rejected" };
    return { error: e?.message ? String(e.message).split("\n")[0] : "Transaction failed" };
  }
}

/* =================================================================== *
 *  PUBLIC API — adapter dispatch
 * =================================================================== */

export async function listProposals(govCfg){
  try {
    if (!govCfg || !govCfg.adapter) return [];
    const cfg = govCfg.cfg || govCfg; // accept {adapter,cfg:{...}} or flat
    switch (govCfg.adapter){
      case "governor":  return await governorList(cfg, { lookback: govCfg.lookback });
      case "layerzero": return await layerzeroList(cfg);
      default:          return [];
    }
  } catch { return []; }
}

/* listProposals with a wider window — backing the "load older" affordance */
export async function listProposalsOlder(govCfg, multiplier = 4){
  try {
    if (!govCfg || govCfg.adapter !== "governor") return await listProposals(govCfg);
    const cfg = govCfg.cfg || govCfg;
    return await governorList(cfg, { lookback: GOV_DEFAULT_LOOKBACK * multiplier });
  } catch { return []; }
}

export async function getProposal(govCfg, id){
  try {
    if (!govCfg || !govCfg.adapter) return null;
    const cfg = govCfg.cfg || govCfg;
    switch (govCfg.adapter){
      case "governor": {
        const p = await governorGet(cfg, id);
        return p;
      }
      case "layerzero": {
        const all = await layerzeroList(cfg);
        return all.find(p => String(p.id) === String(id)) || all[0] || null;
      }
      default: return null;
    }
  } catch { return null; }
}

export async function castVote(govCfg, proposalId, support){
  try {
    if (!govCfg || !govCfg.adapter) return { error: "No governance connected" };
    const cfg = govCfg.cfg || govCfg;
    switch (govCfg.adapter){
      case "governor":  return await governorVote(cfg, proposalId, support);
      case "layerzero": return await layerzeroVote(cfg, proposalId, support);
      default:          return { error: "Unsupported governance adapter" };
    }
  } catch (e) {
    return { error: e?.message ? String(e.message).split("\n")[0] : "Vote failed" };
  }
}

/* =================================================================== *
 *  RENDER — full governance UI into a DOM element
 * =================================================================== */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function shorten(num){
  // num is a decimal string of raw on-chain weight (often 18-decimals).
  // We present a compact, decimals-agnostic magnitude.
  let n;
  try { n = BigInt(num); } catch { return "0"; }
  // assume 18-decimal token weight; collapse to whole tokens for display
  const whole = n / (10n ** 18n);
  let v = Number(whole);
  if (!Number.isFinite(v)) v = 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  if (v === 0 && n > 0n) return "<1";
  return String(v);
}

function fmtDate(ms){
  if (!ms) return null;
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return null; }
}

function walletConnected(){
  return !!(provider() && (window.LZ?.state?.account || window.ethereum?.selectedAddress));
}

function choiceBar(choices){
  const tones = ["for", "against", "abstain", "alt"];
  const segs = (choices || []).map((c, i) => {
    const pct = Math.max(0, Math.min(100, Number(c.pct) || 0));
    return `<span class="gov-bar-seg gov-tone-${tones[i] || "alt"}" style="flex-grow:${pct.toFixed(3)}"
      title="${esc(c.label)} · ${pct.toFixed(1)}%"></span>`;
  }).join("");
  return `<div class="gov-bar">${segs || '<span class="gov-bar-seg gov-tone-empty" style="flex-grow:1"></span>'}</div>`;
}

function choiceLegend(choices){
  const tones = ["for", "against", "abstain", "alt"];
  return `<div class="gov-legend">` + (choices || []).map((c, i) =>
    `<span class="gov-legend-key">
       <i class="gov-tone-${tones[i] || "alt"}"></i>${esc(c.label)}
       <b>${(Number(c.pct) || 0).toFixed(1)}%</b>
       <em>${shorten(c.votes)}</em>
     </span>`).join("") + `</div>`;
}

function voteButtons(p){
  // governor: For/Against/Abstain → support 1/0/2
  // layerzero: choice index per choices order
  if (p.source === "layerzero"){
    return p.choices.map((c, i) =>
      `<button class="gov-vote-btn" data-vote="${i}" data-id="${esc(p.id)}">${esc(c.label)}</button>`
    ).join("");
  }
  return `
    <button class="gov-vote-btn gov-vote-for"     data-vote="1" data-id="${esc(p.id)}">Vote For</button>
    <button class="gov-vote-btn gov-vote-against" data-vote="0" data-id="${esc(p.id)}">Vote Against</button>
    <button class="gov-vote-btn gov-vote-abstain" data-vote="2" data-id="${esc(p.id)}">Abstain</button>`;
}

function proposalCard(p){
  const tone = stateTone(p.state);
  const label = proposalStateLabel(p);
  const dates = [];
  const s = fmtDate(p.startsAt), e = fmtDate(p.endsAt);
  if (s) dates.push(`opened ${esc(s)}`);
  if (e) dates.push(`ends ${esc(e)}`);
  return `
    <article class="gov-card" data-id="${esc(p.id)}">
      <header class="gov-card-head">
        <span class="gov-state gov-state-${tone}">${esc(label)}</span>
        ${dates.length ? `<span class="gov-dates">${dates.join(" · ")}</span>` : ""}
      </header>
      <h3 class="gov-title">${esc(p.title)}</h3>
      ${choiceBar(p.choices)}
      ${choiceLegend(p.choices)}
      <footer class="gov-card-foot">
        <button class="gov-expand" data-id="${esc(p.id)}" aria-expanded="false">Details</button>
        ${p.url ? `<a class="gov-link" href="${esc(p.url)}" target="_blank" rel="noopener">View on explorer ↗</a>` : ""}
      </footer>
      <div class="gov-detail" hidden>
        <p class="gov-body">${esc((p.body || "").slice(0, 1400))}${(p.body || "").length > 1400 ? "…" : ""}</p>
        <div class="gov-vote-row" ${["Active", "Open"].includes(String(p.state)) ? "" : "data-closed=\"1\""}>
          ${["Active", "Open"].includes(String(p.state)) ? voteButtons(p) : `<span class="gov-vote-closed">Voting ${esc(label.toLowerCase())}</span>`}
        </div>
        <p class="gov-vote-msg" aria-live="polite" hidden></p>
      </div>
    </article>`;
}

function shell(inner, attrs = ""){
  return `<div class="gov-root" ${attrs}>${inner}</div>`;
}

function emptyState(kind){
  const map = {
    none:    { t: "No governance connected", d: "This community has no on-chain governance wired up yet." },
    empty:   { t: "No active proposals", d: "Nothing to vote on right now. New proposals will appear here." },
    referendum: { t: "No active referendum", d: "The LayerZero fee-switch referendum is not open. It recurs roughly every 6 months." },
    error:   { t: "Couldn’t load governance", d: "The RPC didn’t respond. Check your connection and retry." },
  };
  const m = map[kind] || map.empty;
  const retry = kind === "error" || kind === "empty" || kind === "referendum"
    ? `<button class="gov-retry">Retry</button>` : "";
  return `<div class="gov-empty">
    <div class="gov-empty-icon" aria-hidden="true">◷</div>
    <h3>${esc(m.t)}</h3><p>${esc(m.d)}</p>${retry}
  </div>`;
}

function loadingState(){
  return `<div class="gov-loading">
    ${[0, 1, 2].map(() => `<div class="gov-skel"><span></span><span></span><span></span></div>`).join("")}
  </div>`;
}

export function renderGovernance(el, govCfg){
  if (!el) return;
  const reduced = typeof window !== "undefined"
    && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) el.setAttribute("data-reduced", "1");

  // no adapter at all → tidy "no governance connected"
  if (!govCfg || !govCfg.adapter || (govCfg.adapter !== "governor" && govCfg.adapter !== "layerzero")){
    el.innerHTML = shell(emptyState("none"));
    return;
  }

  el.innerHTML = shell(loadingState());

  const wire = () => {
    // expand/collapse details
    el.querySelectorAll(".gov-expand").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".gov-card");
        const detail = card?.querySelector(".gov-detail");
        if (!detail) return;
        const open = !detail.hidden;
        detail.hidden = open;
        btn.setAttribute("aria-expanded", String(!open));
        btn.textContent = open ? "Details" : "Hide";
      });
    });
    // vote buttons
    el.querySelectorAll(".gov-vote-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".gov-card");
        const msg = card?.querySelector(".gov-vote-msg");
        const support = Number(btn.getAttribute("data-vote"));
        const id = btn.getAttribute("data-id");
        const row = card?.querySelector(".gov-vote-row");
        if (!walletConnected()){
          if (msg){ msg.hidden = false; msg.className = "gov-vote-msg gov-msg-warn"; msg.textContent = "Connect your wallet to vote."; }
          return;
        }
        row?.querySelectorAll("button").forEach(b => b.disabled = true);
        if (msg){ msg.hidden = false; msg.className = "gov-vote-msg"; msg.textContent = "Confirm in your wallet…"; }
        const res = await castVote(govCfg, id, support);
        if (res?.txHash){
          if (msg){ msg.className = "gov-vote-msg gov-msg-ok"; msg.textContent = "Vote submitted · " + res.txHash.slice(0, 10) + "…"; }
        } else {
          if (msg){ msg.className = "gov-vote-msg gov-msg-err"; msg.textContent = res?.error || "Vote failed"; }
          row?.querySelectorAll("button").forEach(b => b.disabled = false);
        }
      });
    });
    // retry + load-older
    el.querySelector(".gov-retry")?.addEventListener("click", () => renderGovernance(el, govCfg));
    el.querySelector(".gov-load-older")?.addEventListener("click", async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true; b.textContent = "Loading…";
      const older = await listProposalsOlder(govCfg);
      paint(older, true);
    });
  };

  const paint = (proposals, loadedOlder) => {
    if (!Array.isArray(proposals)){
      el.innerHTML = shell(emptyState("error"));
      wire();
      return;
    }
    if (proposals.length === 0){
      el.innerHTML = shell(emptyState(govCfg.adapter === "layerzero" ? "referendum" : "empty"));
      wire();
      return;
    }
    const cards = proposals.map(proposalCard).join("");
    const olderBtn = (govCfg.adapter === "governor" && !loadedOlder)
      ? `<div class="gov-more"><button class="gov-load-older">Load older proposals</button></div>` : "";
    el.innerHTML = shell(`<div class="gov-list">${cards}</div>${olderBtn}`);
    wire();
  };

  listProposals(govCfg)
    .then(paint)
    .catch(() => { el.innerHTML = shell(emptyState("error")); wire(); });
}

/* =================================================================== *
 *  SELF-MOUNT
 * =================================================================== */
if (typeof window !== "undefined"){
  window.LZ = window.LZ || {};
  window.LZ.gov = {
    listProposals, getProposal, castVote, proposalStateLabel, renderGovernance,
    listProposalsOlder,
  };
}
