/* ============================================================ *
 *  daos.js — community registry for the Communities (DAO social) view.
 *
 *  A community is a DAO or a Nostr group. Each has:
 *   - nostr: relays + a feed source (hashtag and/or specific author pubkeys)
 *            + optional NIP-28 channels (kind-42, #e root).
 *   - gov:   null, or a governance adapter config (see governance.js):
 *              { adapter:'layerzero', cfg:{chain,rpc,voteContract} }
 *              { adapter:'governor',  cfg:{chain,rpc,governor} }
 *
 *  Consumed by communities.js (UI) and governance.js (via the gov cfg).
 * ============================================================ */

/* Reliable public Nostr relays (read + write, no auth). */
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

/* Public, keyless JSON-RPC endpoints per chain (read path).
   publicnode allows >=45k-block getLogs ranges and stayed reliable in testing
   (llamarpc/cloudflare/ankr returned HTML/auth/range errors). */
export const RPC = {
  1:     "https://ethereum-rpc.publicnode.com",    // Ethereum mainnet
  42161: "https://arbitrum-one-rpc.publicnode.com", // Arbitrum One
};

export const COMMUNITIES = [
  {
    id: "layerzero",
    name: "LayerZero",
    handle: "layerzero",
    kind: "dao",
    accent: "#b39aff",
    blurb: "Omnichain interoperability. ZRO holders vote the protocol fee switch on-chain, multichain, every six months.",
    nostr: {
      relays: RELAYS,
      feedHashtag: "layerzero",
      channels: [
        { id: "lz-general", name: "general", root: "" },
        { id: "lz-dev",     name: "builders", root: "" },
        { id: "lz-gov",     name: "governance", root: "" },
      ],
    },
    // LayerZero fee-switch referendum (binary activate/deactivate, ~6-month cadence;
    // multichain via the ZRO OFT). The immutable voting contract address is published
    // behind "View Contract" at https://layerzero.foundation/fee-switch (JS-rendered,
    // not scrapable here). ZRO OFT token (same address all chains):
    // 0x6985884C4392D348587B19cb9eAAf157F13271cd. Referendum #3 closed Dec 2025 (no
    // quorum → fee off); next vote ~June 2026. Fill voteContract with the real address;
    // the 'layerzero' adapter no-ops cleanly (shows "no active referendum") until set.
    gov: { adapter: "layerzero", cfg: { chain: 1, rpc: RPC[1], voteContract: "" } },
  },

  {
    id: "uniswap",
    name: "Uniswap",
    handle: "uniswap",
    kind: "dao",
    accent: "#ff7a59",
    blurb: "The Uniswap Protocol governance — a real on-chain GovernorBravo with live proposals you can read and vote on.",
    nostr: {
      relays: RELAYS,
      feedHashtag: "uniswap",
      channels: [
        { id: "uni-general", name: "general", root: "" },
        { id: "uni-gov",     name: "governance", root: "" },
      ],
    },
    // Uniswap GovernorBravo on Ethereum mainnet — real, queryable.
    gov: { adapter: "governor", cfg: { chain: 1, rpc: RPC[1], governor: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3" } },
  },

  {
    id: "nostr",
    name: "Nostr",
    handle: "nostr",
    kind: "nostr-group",
    accent: "#5eead4",
    blurb: "The open protocol itself — a public square. Posts tagged #nostr from across the relays.",
    nostr: {
      relays: RELAYS,
      feedHashtag: "nostr",
      channels: [
        { id: "nostr-general", name: "general", root: "" },
      ],
    },
    gov: null,
  },

  {
    id: "ethereum",
    name: "Ethereum",
    handle: "ethereum",
    kind: "nostr-group",
    accent: "#7c8ef8",
    blurb: "Builders, research, and culture. Posts tagged #ethereum across the Nostr relays.",
    nostr: {
      relays: RELAYS,
      feedHashtag: "ethereum",
      channels: [
        { id: "eth-general", name: "general", root: "" },
      ],
    },
    gov: null,
  },
];

export function getCommunity(id){
  return allCommunities().find((c) => c.id === id) || null;
}

/* ============================================================ *
 *  Adding your own communities (search engine + manual add).
 *  User-added communities persist in localStorage and merge with
 *  the seed registry. Governance resolves hybrid: a known on-chain
 *  Governor when we have one, else the Snapshot adapter.
 * ============================================================ */

/* Curated Snapshot-space → on-chain Governor map (real on-chain voting).
   Keyed by lowercased Snapshot space id. Add more over time. */
export const KNOWN_GOVERNORS = {
  "uniswapgovernance.eth": { chain: 1, governor: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3" },
  "ens.eth":               { chain: 1, governor: "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3" },
};

const ACCENTS = ["#b39aff", "#5eead4", "#ff7a59", "#7c8ef8", "#86efac", "#fde68a"];
function pickAccent(seed){
  let h = 0; const s = String(seed || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
/** A clean #hashtag for a community feed, derived from a name/handle. */
function toHashtag(s){
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "dao";
}

/** Resolve governance for a Snapshot space: known on-chain Governor else Snapshot. */
function govForSpace(spaceId){
  const k = KNOWN_GOVERNORS[String(spaceId || "").toLowerCase()];
  if (k) return { adapter: "governor", cfg: { chain: k.chain, rpc: RPC[k.chain] || RPC[1], governor: k.governor } };
  return { adapter: "snapshot", cfg: { space: spaceId } };
}

/** Build a community from a Snapshot search result {id,name,network,followers}. */
export function communityFromSnapshot(space){
  const id = "snap:" + space.id;
  return {
    id, name: space.name || space.id, handle: space.id, kind: "dao",
    accent: pickAccent(space.id),
    blurb: `${space.name || space.id} — governance via ${KNOWN_GOVERNORS[String(space.id).toLowerCase()] ? "on-chain Governor" : "Snapshot"}.`,
    nostr: { relays: RELAYS, feedHashtag: toHashtag(space.name || space.id), channels: [{ id: id + ":general", name: "general", root: "" }] },
    gov: govForSpace(space.id),
  };
}

/** Build a Nostr-group community from a raw hashtag (with or without leading #). */
export function communityFromHashtag(tag){
  const t = toHashtag(tag);
  const id = "tag:" + t;
  return {
    id, name: "#" + t, handle: t, kind: "nostr-group",
    accent: pickAccent(t),
    blurb: `Posts tagged #${t} across the Nostr relays.`,
    nostr: { relays: RELAYS, feedHashtag: t, channels: [{ id: id + ":general", name: "general", root: "" }] },
    gov: null,
  };
}

/** Build a community from a raw on-chain Governor {name,chain,governor}. */
export function communityFromGovernor({ name, chain, governor }){
  const id = "gov:" + chain + ":" + String(governor || "").toLowerCase();
  return {
    id, name: name || ("Governor " + String(governor).slice(0, 8)), handle: String(governor).slice(0, 10), kind: "dao",
    accent: pickAccent(governor),
    blurb: "Custom on-chain Governor.",
    nostr: { relays: RELAYS, feedHashtag: toHashtag(name || "dao"), channels: [{ id: id + ":general", name: "general", root: "" }] },
    gov: { adapter: "governor", cfg: { chain: Number(chain), rpc: RPC[Number(chain)] || RPC[1], governor } },
  };
}

/* ── persistence (localStorage) ─────────────────────────────── */
const USER_KEY = "lz:communities";
export function loadUserCommunities(){
  try { const v = JSON.parse(localStorage.getItem(USER_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function saveUserCommunities(list){
  try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch (_) {}
}
/** Add (idempotent by id). Returns true if newly added. */
export function addUserCommunity(c){
  if (!c || !c.id) return false;
  if (COMMUNITIES.some((s) => s.id === c.id)) return false;   // seed already covers it
  const list = loadUserCommunities();
  if (list.some((u) => u.id === c.id)) return false;
  list.push(c); saveUserCommunities(list); return true;
}
export function removeUserCommunity(id){
  const list = loadUserCommunities().filter((u) => u.id !== id);
  saveUserCommunities(list);
}
/** True if this community was user-added (removable). */
export function isUserCommunity(id){
  return loadUserCommunities().some((u) => u.id === id);
}

/** Seed + user communities, deduped by id (seed wins). */
export function allCommunities(){
  const out = COMMUNITIES.slice();
  const seen = new Set(out.map((c) => c.id));
  for (const u of loadUserCommunities()){
    if (u && u.id && !seen.has(u.id)){ out.push(u); seen.add(u.id); }
  }
  return out;
}
