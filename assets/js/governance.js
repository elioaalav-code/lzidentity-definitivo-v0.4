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

/* ---- Snapshot state mapping ----
   Snapshot proposals expose state 'pending' | 'active' | 'closed'.
   We normalize to the canonical Title-case strings the rest of the engine
   uses (so stateTone() / proposalStateLabel() colour + label them). Any
   unrecognized value collapses to "Closed" (the safe, non-actionable state). */
export function snapshotStateLabel(state){
  switch (String(state || "").toLowerCase()){
    case "pending": return "Pending";
    case "active":  return "Active";
    case "closed":  return "Closed";
    default:        return "Closed";
  }
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
const SEL_QUORUM         = "0xf8ce560a"; // quorum(uint256 blockNumber) -> uint256 (OZ + Bravo)
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

/* read live state + tallies for one proposalId.
   startBlock is used to look up the quorum at that snapshot (best-effort). */
async function governorLiveState(rpc, governor, id, startBlock){
  const idWord = encodeUint256(id);
  let state = "Unknown", choicesObj = governorChoices(0, 0, 0), quorum = "0";
  try {
    const stateHex = await rpcCall(rpc, "eth_call",
      [{ to: governor, data: SEL_STATE + idWord }, "latest"]);
    state = governorStateName(Number(hexToBigInt(stateHex)));
  } catch { /* leave Unknown */ }
  // quorum(blockNumber) — OZ Governor + GovernorBravo. Best-effort; some
  // governors revert (no snapshot yet / unsupported) → leave 0 / omit.
  if (startBlock != null){
    try {
      const qHex = await rpcCall(rpc, "eth_call",
        [{ to: governor, data: SEL_QUORUM + encodeUint256(startBlock) }, "latest"]);
      const q = hexToBigInt(qHex);
      if (q > 0n) quorum = q.toString();
    } catch { /* leave 0 */ }
  }
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
  return { state, quorum, ...choicesObj };
}

/* Map a block number → unix-ms timestamp (best-effort; null on failure).
   Used to fill startsAt/endsAt for Governor proposals so the UI can show a
   countdown. Only resolves blocks at/near head (past blocks have a timestamp;
   future endBlock is estimated from a 12s slot time). */
async function blockToTimeMs(rpc, blockNumber, latest){
  if (blockNumber == null) return null;
  try {
    if (latest != null && blockNumber > latest){
      // future block → estimate from head time + 12s * delta (mainnet slot)
      const headHex = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
      const headTs = Number(BigInt(headHex?.timestamp || "0x0"));
      if (!headTs) return null;
      return (headTs + (blockNumber - latest) * 12) * 1000;
    }
    const blk = await rpcCall(rpc, "eth_getBlockByNumber", ["0x" + Number(blockNumber).toString(16), false]);
    const ts = Number(BigInt(blk?.timestamp || "0x0"));
    return ts ? ts * 1000 : null;
  } catch { return null; }
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
    const live = await governorLiveState(rpc, governor, p.id, p.startBlock);
    // map start/end blocks → timestamps for a countdown (best-effort)
    const startsAt = await blockToTimeMs(rpc, p.startBlock, latest);
    const endsAt = await blockToTimeMs(rpc, p.endBlock, latest);
    out.push(buildGovernorProposal(p, live, url, { startsAt, endsAt }));
  }
  return out;
}

function buildGovernorProposal(p, live, url, times){
  return {
    id: p.id,
    title: titleFromDescription(p.description),
    body: String(p.description || ""),
    state: live.state,
    choices: live.choices,
    totalVotes: live.totalVotes,
    quorum: live.quorum || "0",
    startsAt: (times && times.startsAt) || null,
    endsAt: (times && times.endsAt) || null,
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
  const live = await governorLiveState(rpc, governor, found.id, found.startBlock);
  const startsAt = await blockToTimeMs(rpc, found.startBlock, latest);
  const endsAt = await blockToTimeMs(rpc, found.endBlock, latest);
  return buildGovernorProposal(found, live, governorExplorerUrl(chain, governor), { startsAt, endsAt });
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
 *  ADAPTER: 'snapshot'  (off-chain Snapshot spaces — gasless signed vote)
 *
 *  Reads: Snapshot's keyless GraphQL index at https://hub.snapshot.org/graphql
 *  (POST {query}). Proposals carry their OWN choice list (not just for/against)
 *  plus a parallel `scores[]` weight array and `scores_total`. Scores arrive as
 *  already-humanized floating-point voting power (NOT raw 18-decimal wei), so we
 *  keep them as plain integer-ish vote strings (no 1e18 division on render).
 *
 *  Writes: a Snapshot "vote" is an EIP-712 typed message the user signs with
 *  eth_signTypedData_v4, then we POST {address,sig,data} to the gasless
 *  sequencer https://seq.snapshot.org . No gas, no chain switch.
 * =================================================================== */

const SNAPSHOT_GQL = "https://hub.snapshot.org/graphql";
const SNAPSHOT_SEQ = "https://seq.snapshot.org";

/* keyless GraphQL POST. Returns parsed JSON or throws (callers catch → []). */
async function snapshotGql(query, variables){
  const r = await fetch(SNAPSHOT_GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (!r.ok) throw new Error("snapshot " + r.status);
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "snapshot gql error");
  return j.data;
}

/* PURE: map a raw Snapshot proposal node → the engine's Proposal shape.
   choices[]+scores[] zip into [{label,votes,pct}]; scores_total → totalVotes;
   start/end (unix sec) → ms (0 → null); url is the canonical snapshot.org link. */
export function mapSnapshotProposal(node, space){
  const labels = Array.isArray(node?.choices) ? node.choices : [];
  const scores = Array.isArray(node?.scores) ? node.scores : [];
  // total: prefer scores_total, else sum of scores. Round to keep vote strings tidy.
  let total = Number(node?.scores_total);
  if (!Number.isFinite(total)){
    total = scores.reduce((a, s) => a + (Number(s) || 0), 0);
  }
  const choices = labels.map((label, i) => {
    const v = Number(scores[i]) || 0;
    return {
      label: String(label),
      votes: String(Math.round(v)),
      pct: total > 0 ? Math.round((v / total) * 10000) / 100 : 0,
    };
  });
  const sp = node?.space?.id || space || "";
  const id = String(node?.id ?? "");
  const start = Number(node?.start);
  const end = Number(node?.end);
  return {
    id,
    title: String(node?.title || "Untitled proposal"),
    body: String(node?.body || ""),
    state: snapshotStateLabel(node?.state),
    choices,
    totalVotes: String(Math.round(Number.isFinite(total) ? total : 0)),
    quorum: Number.isFinite(Number(node?.quorum)) && Number(node?.quorum) > 0 ? String(Math.round(Number(node.quorum))) : "0",
    startsAt: Number.isFinite(start) && start > 0 ? start * 1000 : null,
    endsAt: Number.isFinite(end) && end > 0 ? end * 1000 : null,
    url: id ? `https://snapshot.org/#/${sp}/proposal/${id}` : (node?.link || null),
    source: "snapshot",
  };
}

const SNAPSHOT_PROPOSAL_FIELDS =
  "id title body choices scores scores_total quorum state start end link space{id name}";

async function snapshotList(cfg){
  const space = cfg?.space;
  if (!space) return [];
  try {
    const data = await snapshotGql(
      `query($space:String!){
        proposals(first:20, where:{space:$space}, orderBy:"created", orderDirection:desc){
          ${SNAPSHOT_PROPOSAL_FIELDS}
        }
      }`,
      { space }
    );
    const arr = Array.isArray(data?.proposals) ? data.proposals : [];
    return arr.map(n => mapSnapshotProposal(n, space));
  } catch { return []; }
}

async function snapshotGet(cfg, id){
  const space = cfg?.space;
  if (!id) return null;
  try {
    const data = await snapshotGql(
      `query($id:String!){
        proposal(id:$id){ ${SNAPSHOT_PROPOSAL_FIELDS} }
      }`,
      { id: String(id) }
    );
    if (data?.proposal) return mapSnapshotProposal(data.proposal, space);
  } catch { /* fall back to scanning the list */ }
  try {
    const all = await snapshotList(cfg);
    return all.find(p => String(p.id) === String(id)) || null;
  } catch { return null; }
}

/* PURE: build the exact EIP-712 typed-data JSON string for a Snapshot vote,
   ready to hand to eth_signTypedData_v4.

   Snapshot's "vote" envelope (hub.snapshot.org / @snapshot-labs/snapshot.js):
     domain     = { name: "snapshot", version: "0.1.4" }
     primaryType= "Vote"
     Vote type fields (single-choice; choice is the 1-based index):
       from      address
       space     string
       timestamp uint64    (unix seconds)
       proposal  string    (the proposal id — hex string for offchain props)
       choice    uint32    (1-based choice index)
       reason    string
       app       string
       metadata  string    (JSON string, "{}" when none)
   The signed `message` (minus domain/types) is what we POST as `data.message`
   to the sequencer; `data.domain` and `data.types` ride along too. */
export function buildSnapshotVoteMessage(opts){
  const {
    from, space, proposal, choice,
    reason = "", app = "lzidentity", metadata = "{}",
    timestamp = Math.floor(Date.now() / 1000),
  } = opts || {};
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ],
    Vote: [
      { name: "from", type: "address" },
      { name: "space", type: "string" },
      { name: "timestamp", type: "uint64" },
      { name: "proposal", type: "string" },
      { name: "choice", type: "uint32" },
      { name: "reason", type: "string" },
      { name: "app", type: "string" },
      { name: "metadata", type: "string" },
    ],
  };
  const message = {
    from: String(from),
    space: String(space),
    timestamp: Number(timestamp),
    proposal: String(proposal),
    choice: Number(choice),
    reason: String(reason),
    app: String(app),
    metadata: String(metadata),
  };
  return JSON.stringify({
    domain: { name: "snapshot", version: "0.1.4" },
    types,
    primaryType: "Vote",
    message,
  });
}

/* Snapshot gasless vote: sign the EIP-712 envelope with the wallet, then POST
   { address, sig, data } to the sequencer. `choice` is the 1-based index. */
async function snapshotVote(cfg, proposalId, choice){
  const p = provider();
  if (!p) return { error: "No wallet connected" };
  const space = cfg?.space;
  if (!space) return { error: "Snapshot space not configured" };
  try {
    const accounts = await p.request({ method: "eth_requestAccounts" }).catch(() => []);
    const from = Array.isArray(accounts) ? accounts[0] : null;
    if (!from) return { error: "No wallet account" };

    const typedData = buildSnapshotVoteMessage({
      from, space, proposal: String(proposalId), choice: Number(choice),
    });

    let sig;
    try {
      sig = await p.request({ method: "eth_signTypedData_v4", params: [from, typedData] });
    } catch (e) {
      if (e?.code === 4001) return { error: "Signature rejected" };
      return { error: e?.message ? String(e.message).split("\n")[0] : "Could not sign vote" };
    }
    if (!sig) return { error: "No signature" };

    const parsed = JSON.parse(typedData);
    const r = await fetch(SNAPSHOT_SEQ, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: from,
        sig,
        data: {
          domain: parsed.domain,
          types: parsed.types,
          message: parsed.message,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error){
      const detail = j?.error_description || j?.error || ("sequencer " + r.status);
      return { error: String(detail).split("\n")[0] };
    }
    // sequencer returns { id, ipfs, relayer } on success
    return { txHash: j.id || j.ipfs || "submitted" };
  } catch (e) {
    return { error: e?.message ? String(e.message).split("\n")[0] : "Vote failed" };
  }
}

/* =================================================================== *
 *  SPACE SEARCH  (Snapshot DAO discovery, keyless)
 *
 *  Primary path: GraphQL `ranking(where:{search}){items{...}}` — Snapshot's
 *  relevance-ranked space index (verified live, returns id/name/network/
 *  followersCount). If `ranking` ever stops being supported we fall back to
 *  `spaces(first, where:{id_in:[...]})` filtered client-side. Never throws → []. */
export async function searchSpaces(query){
  const q = String(query || "").trim();
  if (!q) return [];
  // --- primary: ranking ---
  try {
    const data = await snapshotGql(
      `query($q:String){
        ranking(first:18, where:{search:$q}){
          items{ id name network followersCount }
        }
      }`,
      { q }
    );
    const items = data?.ranking?.items;
    if (Array.isArray(items) && items.length){
      return items.map(s => ({
        id: String(s.id),
        name: String(s.name || s.id),
        network: String(s.network || ""),
        followers: Number(s.followersCount) || 0,
      }));
    }
  } catch { /* fall through to spaces() */ }
  // --- fallback: spaces() then client-side name/id filter ---
  try {
    const data = await snapshotGql(
      `query{
        spaces(first:1000, orderBy:"followers_count", orderDirection:desc){
          id name network followersCount
        }
      }`
    );
    const all = Array.isArray(data?.spaces) ? data.spaces : [];
    const needle = q.toLowerCase();
    return all
      .filter(s =>
        String(s.id || "").toLowerCase().includes(needle) ||
        String(s.name || "").toLowerCase().includes(needle))
      .slice(0, 18)
      .map(s => ({
        id: String(s.id),
        name: String(s.name || s.id),
        network: String(s.network || ""),
        followers: Number(s.followersCount) || 0,
      }));
  } catch { return []; }
}

/* ── Discover: famous DAOs + hottest live votes (keyless Snapshot) ──── */

/* Curated set of well-known DAOs (Snapshot space ids). Scoping the Discover
   queries to these keeps results recognizable and spam/demo-free (a global
   `orderBy:"votes"` otherwise surfaces test/meme spaces with inflated tallies). */
export const FAMOUS_DAOS = [
  "stgdao.eth", "arbitrumfoundation.eth", "opcollective.eth", "gitcoindao.eth",
  "ens.eth", "uniswapgovernance.eth", "aavedao.eth", "aave.eth", "lido-snapshot.eth",
  "safe.eth", "balancer.eth", "apecoin.eth", "snapshot.dcl.eth", "starknet.eth",
  "sushigov.eth", "aavegotchi.eth", "cvx.eth", "1inch.eth",
];

/* Famous DAOs, sorted by follower count (most-followed first). */
export async function featuredSpaces(limit = 12){
  try {
    const data = await snapshotGql(
      `query($spaces:[String]){
        spaces(first:40, where:{id_in:$spaces}){ id name network followersCount proposalsCount activeProposals }
      }`,
      { spaces: FAMOUS_DAOS }
    );
    const all = Array.isArray(data?.spaces) ? data.spaces : [];
    all.sort((a, b) => (Number(b.followersCount) || 0) - (Number(a.followersCount) || 0));
    return all.slice(0, limit).map(s => ({
      id: String(s.id),
      name: String(s.name || s.id),
      network: String(s.network || ""),
      followers: Number(s.followersCount) || 0,
      proposals: Number(s.proposalsCount) || 0,
      active: Number(s.activeProposals) || 0,
    }));
  } catch { return []; }
}

/* Hottest ACTIVE proposals among the famous DAOs, by voter count (desc).
   → [{id,title,voters,endsAt,spaceId,spaceName,url}] */
export async function hotProposals(limit = 10){
  const n = Math.max(1, Math.min(20, limit));
  try {
    const data = await snapshotGql(
      `query($n:Int!, $spaces:[String]){
        proposals(first:$n, where:{state:"active", space_in:$spaces}, orderBy:"votes", orderDirection:desc){
          id title votes choices scores scores_total end space{ id name }
        }
      }`,
      { n, spaces: FAMOUS_DAOS }
    );
    const arr = Array.isArray(data?.proposals) ? data.proposals : [];
    return arr.map(node => {
      // leading choice (highest score) → {label, pct of total}
      const choices = Array.isArray(node?.choices) ? node.choices : [];
      const scores = Array.isArray(node?.scores) ? node.scores : [];
      const total = Number(node?.scores_total) || scores.reduce((a, s) => a + (Number(s) || 0), 0);
      let lead = null;
      if (choices.length && scores.length){
        let bi = 0;
        for (let i = 1; i < scores.length; i++) if ((Number(scores[i]) || 0) > (Number(scores[bi]) || 0)) bi = i;
        lead = { label: String(choices[bi] ?? ""), pct: total > 0 ? Math.round((Number(scores[bi]) || 0) / total * 100) : 0 };
      }
      return {
        id: String(node?.id || ""),
        title: String(node?.title || "Untitled proposal"),
        voters: Number(node?.votes) || 0,
        endsAt: Number(node?.end) > 0 ? Number(node.end) * 1000 : null,
        lead,
        spaceId: node?.space?.id || "",
        spaceName: node?.space?.name || node?.space?.id || "",
        url: (node?.id && node?.space?.id) ? `https://snapshot.org/#/${node.space.id}/proposal/${node.id}` : null,
      };
    });
  } catch { return []; }
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
      case "snapshot":  return await snapshotList(cfg);
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
      case "snapshot":  return await snapshotGet(cfg, id);
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
      case "snapshot":  return await snapshotVote(cfg, proposalId, support);
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
/* only allow http(s) links — blocks javascript:/data: from relay/Snapshot data */
const safeUrl = (u) => /^https?:\/\//i.test(String(u ?? "")) ? String(u) : "";

/* ── "you voted" persistence ─────────────────────────────────────────
 * Keyed by adapter:scope:proposalId → { choice, label, at }. scope is the
 * space (snapshot), governor address, or voteContract (layerzero). Survives
 * reloads so a voted badge persists across the three adapters. */
const VOTED_KEY = "lz:gov:voted";
function votedStore(){
  try { const v = JSON.parse(localStorage.getItem(VOTED_KEY) || "{}"); return (v && typeof v === "object") ? v : {}; }
  catch { return {}; }
}
function govScope(govCfg){
  const cfg = (govCfg && (govCfg.cfg || govCfg)) || {};
  return String(cfg.space || cfg.governor || cfg.voteContract || "").toLowerCase();
}
function votedKey(govCfg, proposalId){
  return `${govCfg?.adapter || "?"}:${govScope(govCfg)}:${proposalId}`;
}
function getVoted(govCfg, proposalId){
  return votedStore()[votedKey(govCfg, proposalId)] || null;
}
function recordVoted(govCfg, proposalId, choice, label){
  try {
    const store = votedStore();
    store[votedKey(govCfg, proposalId)] = { choice, label: String(label || ""), at: Date.now() };
    localStorage.setItem(VOTED_KEY, JSON.stringify(store));
  } catch (_) {}
}

/* choice index → human label for the persistent badge, per adapter. */
function voteLabelFor(p, support){
  if (p.source === "snapshot"){
    const c = (p.choices || [])[Number(support) - 1];
    return c ? c.label : "your choice";
  }
  if (p.source === "layerzero"){
    const c = (p.choices || [])[Number(support)];
    return c ? c.label : "your choice";
  }
  return { 0: "Against", 1: "For", 2: "Abstain" }[Number(support)] || "your choice";
}

/* countdown text from an end timestamp (ms). "" if past / unknown. */
function countdownText(endMs){
  if (!endMs) return "";
  const d = endMs - Date.now();
  if (d <= 0) return "";
  const days = Math.floor(d / 86400000);
  const hrs = Math.floor((d % 86400000) / 3600000);
  const mins = Math.floor((d % 3600000) / 60000);
  if (days > 0) return `${days}d ${hrs}h left`;
  if (hrs > 0) return `${hrs}h ${mins}m left`;
  return `${mins}m left`;
}

function shorten(num, raw18 = true){
  // Governor/LayerZero votes are raw on-chain weight (≈18 decimals) → collapse.
  // Snapshot scores arrive already humanized (whole voting power) → raw18=false.
  let n;
  try { n = BigInt(num); } catch { return "0"; }
  let v;
  if (raw18){
    const whole = n / (10n ** 18n);
    v = Number(whole);
  } else {
    v = Number(n);
  }
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

function choiceLegend(choices, raw18 = true){
  const tones = ["for", "against", "abstain", "alt"];
  return `<div class="gov-legend">` + (choices || []).map((c, i) =>
    `<span class="gov-legend-key">
       <i class="gov-tone-${tones[i] || "alt"}"></i>${esc(c.label)}
       <b>${(Number(c.pct) || 0).toFixed(1)}%</b>
       <em>${shorten(c.votes, raw18)}</em>
     </span>`).join("") + `</div>`;
}

function voteButtons(p){
  // governor: For/Against/Abstain → support 1/0/2
  // layerzero: choice index per choices order (0-based)
  // snapshot: the proposal's OWN choices → 1-based choice index
  if (p.source === "snapshot"){
    return (p.choices || []).map((c, i) =>
      `<button class="gov-vote-btn gov-vote-snap" data-vote="${i + 1}" data-id="${esc(p.id)}">${esc(c.label)}</button>`
    ).join("");
  }
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

function proposalCard(p, govCfg){
  const tone = stateTone(p.state);
  const label = proposalStateLabel(p);
  const dates = [];
  const s = fmtDate(p.startsAt), e = fmtDate(p.endsAt);
  if (s) dates.push(`opened ${esc(s)}`);
  if (e) dates.push(`ends ${esc(e)}`);
  const isLive = ["Active", "Open"].includes(String(p.state));
  const countdown = isLive ? countdownText(p.endsAt) : "";
  const voted = govCfg ? getVoted(govCfg, p.id) : null;
  const votedBadge = voted
    ? `<span class="gov-voted" title="You voted on this proposal">${VOTED_CHECK}Voted ${esc(voted.label)}</span>` : "";
  // voting context line: quorum + total + countdown where available
  const ctx = [];
  if (countdown) ctx.push(`<span class="gov-ctx-time">${esc(countdown)}</span>`);
  if (p.quorum) ctx.push(`<span class="gov-ctx-quorum">Quorum ${esc(shorten(p.quorum, p.source !== "snapshot"))}</span>`);
  if (p.totalVotes && p.totalVotes !== "0") ctx.push(`<span class="gov-ctx-total">${esc(shorten(p.totalVotes, p.source !== "snapshot"))} votes cast</span>`);
  return `
    <article class="gov-card" data-id="${esc(p.id)}">
      <header class="gov-card-head">
        <span class="gov-state gov-state-${tone}">${esc(label)}</span>
        ${votedBadge}
        ${dates.length ? `<span class="gov-dates">${dates.join(" · ")}</span>` : ""}
      </header>
      <h3 class="gov-title">${esc(p.title)}</h3>
      ${choiceBar(p.choices)}
      ${choiceLegend(p.choices, p.source !== "snapshot")}
      ${ctx.length ? `<div class="gov-ctx">${ctx.join("")}</div>` : ""}
      <footer class="gov-card-foot">
        <button class="gov-expand" data-id="${esc(p.id)}" aria-expanded="false">Details</button>
        ${safeUrl(p.url) ? `<a class="gov-link" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">View on explorer ↗</a>` : ""}
      </footer>
      <div class="gov-detail" hidden>
        <p class="gov-body">${esc((p.body || "").slice(0, 1400))}${(p.body || "").length > 1400 ? "…" : ""}</p>
        <div class="gov-vote-row" ${isLive ? "" : "data-closed=\"1\""}>
          ${isLive ? voteButtons(p) : `<span class="gov-vote-closed">Voting ${esc(label.toLowerCase())}</span>`}
        </div>
        <p class="gov-vote-msg" aria-live="polite" ${voted ? "" : "hidden"}>${voted ? VOTED_CHECK + "You voted " + esc(voted.label) : ""}</p>
      </div>
    </article>`;
}

const VOTED_CHECK = `<svg class="gov-voted-icn" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

function shell(inner, attrs = ""){
  return `<div class="gov-root" ${attrs}>${inner}</div>`;
}

function emptyState(kind){
  const map = {
    none:    { t: "No governance connected", d: "This community has no on-chain governance wired up yet." },
    empty:   { t: "No active proposals", d: "Nothing to vote on right now. New proposals will appear here." },
    referendum: { t: "No active referendum", d: "The LayerZero fee-switch referendum is not open. It recurs roughly every 6 months." },
    "lz-readonly": { t: "Read-only · referendum address not wired", d: "The LayerZero fee-switch voting contract isn't published in a machine-readable form yet, so live tallies and voting are unavailable here. Referendum #3 closed Dec 2025 (no quorum → fee off); the next vote is expected ~June 2026. Follow it at layerzero.foundation/fee-switch." },
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
  const KNOWN_ADAPTERS = ["governor", "layerzero", "snapshot"];
  if (!govCfg || !govCfg.adapter || !KNOWN_ADAPTERS.includes(govCfg.adapter)){
    el.innerHTML = shell(emptyState("none"));
    return;
  }

  el.innerHTML = shell(loadingState());

  // keep the most recent proposal list so the vote handler can derive the
  // chosen-option label and refresh a single card in place.
  let lastProposals = [];

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
          // persist the "you voted" state (label derived per-adapter) so the
          // badge survives reloads, then re-fetch the proposal to refresh tallies.
          const cur = lastProposals.find(p => String(p.id) === String(id));
          const label = cur ? voteLabelFor(cur, support) : "your choice";
          recordVoted(govCfg, id, support, label);
          if (msg){ msg.className = "gov-vote-msg gov-msg-ok"; msg.innerHTML = VOTED_CHECK + "Vote submitted · refreshing…"; }
          // refresh just this proposal's card (tallies may take a block to move)
          try {
            const fresh = await getProposal(govCfg, id);
            if (fresh){
              lastProposals = lastProposals.map(p => String(p.id) === String(id) ? fresh : p);
              const tmp = document.createElement("div");
              tmp.innerHTML = proposalCard(fresh, govCfg);
              const newCard = tmp.firstElementChild;
              if (newCard && card){ card.replaceWith(newCard); wire(); }
            }
          } catch (_) {}
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
      // LayerZero with no real address → honest read-only note rather than a
      // bare "no referendum" so the inert vote UI never misleads.
      if (govCfg.adapter === "layerzero" && isUnsetAddress((govCfg.cfg || govCfg).voteContract)){
        el.innerHTML = shell(emptyState("lz-readonly"));
      } else {
        el.innerHTML = shell(emptyState(govCfg.adapter === "layerzero" ? "referendum" : "empty"));
      }
      wire();
      return;
    }
    lastProposals = proposals.slice();
    const cards = proposals.map(p => proposalCard(p, govCfg)).join("");
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
    listProposalsOlder, searchSpaces, featuredSpaces, hotProposals,
  };
}
