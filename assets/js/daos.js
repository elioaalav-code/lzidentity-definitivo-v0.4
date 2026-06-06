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
  return COMMUNITIES.find((c) => c.id === id) || null;
}
