# DAO Social — v0.3 Chat → decentralized social space for DAOs

**Date:** 2026-06-06
**Approved direction (Elio):** evolve the Chat tab into a *decentralized social
network for DAOs* on Nostr, with connected DAOs. Start with **LayerZero** + Nostr
groups. Governance is **real, adapter-based**. Build with **parallel Opus subagents**.

This spec doubles as the **interface contract** the parallel agents build against.
Freeze the interfaces here; integration is done by the coordinator (me).

## Concept

The Chat view becomes **Communities**: a left rail of communities (DAOs + Nostr
groups); the selected community opens with three tabs — **Feed** (Nostr social
posts), **Channels** (group chat / DAO comms), **Governance** (proposals + vote).
Everything real: read/post on Nostr signed with the derived key; read proposals
on-chain and vote with the wallet.

## Non-negotiable constraints

- No build step; plain HTML/CSS/ESM. No new bundled deps. Reuse `@noble/secp256k1`
  + `@noble/hashes` (already imported by `shared.js`) for Nostr signing.
- Preserve all existing element IDs, `data-view`/`data-route`, `window.LZ`, HL
  signing, Nostr derivation, copilot. The Chat view is being redesigned, but it must
  keep `data-view="chat"` and the route hook.
- Honor `prefers-reduced-motion`; isolated scoped CSS (`*-pro.css` pattern).
- **Strict file ownership** (parallel safety): each agent touches ONLY its files.
  The coordinator owns `app.html`, `app.js`, `daos.js`, integration. Agents do NOT
  commit — the coordinator commits after integration.

## Modules & ownership

| Module | Files | Owner |
|---|---|---|
| Nostr engine | `assets/js/nostr.js` | Agent A |
| Communities UI | `assets/js/communities.js`, `assets/css/communities.css` | Agent B |
| Governance | `assets/js/governance.js`, `assets/css/governance.css` | Agent C |
| Registry + backbone | `assets/js/daos.js`, `app.html` chat view, `app.js` wiring, CSS/script links | Coordinator |

## Interface contracts (FROZEN — build against these)

### A. Nostr engine — `assets/js/nostr.js`
Pure (Node-testable, TDD):
- `serializeEvent(evt) -> string` — NIP-01 canonical array `[0,pubkey,created_at,kind,tags,content]` JSON, no whitespace.
- `eventId(evt) -> hexString` — lowercase hex sha256 of `serializeEvent`.

Browser:
- `getPubkey(privHex) -> hexString` — x-only schnorr pubkey.
- `signEvent(unsigned, privHex) -> signedEvent` — fills `pubkey,id,sig` (schnorr over id). `unsigned = {kind,created_at?,tags?,content}`.
- `openPool(relays: string[]) -> pool`
  - `pool.sub(filters, {onEvent, onEose}) -> subId`
  - `pool.unsub(subId)`
  - `pool.publish(signedEvent) -> Promise<Array<{relay,ok,reason?}>>`
  - `pool.close()`
- Self-mount: `window.LZ.nostr = { openPool, signEvent, getPubkey, eventId, serializeEvent }`.
- Reduced/offline: connection failures degrade to empty results, never throw to caller.

NIP usage: kind 1 (social posts/feed), kind 42 + `#e` root (NIP-28 channel msgs),
kind 7 (reactions), kind 0 (profiles, best-effort). created_at in seconds.

### B. Governance — `assets/js/governance.js`
Adapter pattern. Public API:
- `listProposals(govCfg) -> Promise<Proposal[]>`
- `getProposal(govCfg, id) -> Promise<Proposal>`
- `castVote(govCfg, proposalId, support) -> Promise<{txHash}|{error}>` (wallet; `support`: 0=against,1=for,2=abstain — or referendum choice index)
- `proposalStateLabel(p) -> string`

`Proposal = { id, title, body, state, choices:[{label,votes}], totalVotes, startsAt, endsAt, url, source }`

Adapters keyed by `govCfg.adapter`:
- `'governor'` — OZ/GovernorBravo. `cfg:{chain,rpc,governor}`. List via `eth_getLogs` ProposalCreated over a recent block window (graceful "load more"); live state via `eth_call` `state(uint256)` + `proposalVotes(uint256)`; title = first line of the event `description`. Vote via `eth_sendTransaction` `castVote(uint256,uint8)`.
- `'layerzero'` — LayerZero fee-switch referendum (binary activate/deactivate, 6-month cadence, multichain). `cfg:{chain,rpc,voteContract}`. Read current referendum window + tallies + deadline; vote = tx to the vote contract from the user's chain. If no active referendum: return `[]` (UI shows "no active referendum"). **The exact contract address is a config TODO the coordinator fills via research; adapter must work the moment a valid address is set, and no-op cleanly until then.**
- Self-mount: `window.LZ.gov = { listProposals, getProposal, castVote, proposalStateLabel }`.
- Reads keyless via `rpcCall(rpc,method,params)` style (public RPC); writes via `window.ethereum` (`wallet_switchEthereumChain` then `eth_sendTransaction`).

### C. Registry — `assets/js/daos.js` (coordinator)
```
export const COMMUNITIES = [
  { id, name, handle, kind:'dao'|'nostr-group', accent,
    nostr:{ relays:[...], feedAuthors?:[hex...], feedHashtag?:'#tag',
            channels:[{ id, name, root?:eventId }] },
    gov: null | { adapter:'layerzero'|'governor', cfg:{...} } }
]
export function getCommunity(id)
```
Seed: LayerZero (gov: layerzero adapter), ≥2 Nostr groups (gov:null), ≥1 DAO with a real `governor` adapter (e.g. an Arbitrum/Uniswap Governor) so governance demonstrably works.

### D. Backbone — `app.html` chat view + `app.js` (coordinator)
New chat-view markup: `.comm-layout` = left `#commList` + main `#commMain` with a
`#commTabs` (Feed/Channels/Governance) and a `#commPanel`. Keep `data-view="chat"`.
`ONROUTE.chat` calls `window.LZ.communities.init()`. Script tags + CSS links added.
`communities.js` exposes `window.LZ.communities = { init, openCommunity }` and owns
rendering INTO the coordinator-provided containers (by ID).

## Data flow

`daos.js` (registry) → `communities.js` renders list/tabs → Feed/Channels use
`window.LZ.nostr` (sub kind-1 / kind-42, publish signed with `state.derived.priv`)
→ Governance tab uses `window.LZ.gov` with the community's `gov` cfg → vote via
wallet. Derived key gates posting/reactions; not-derived shows a "derive to post" CTA.

## Error handling

Relay/RPC failures → empty state + retry affordance, never throw. Not connected /
not derived → clear CTAs (connect wallet / derive identity), read-only still works.
No active referendum / no governor → tidy empty state. Reduced-motion/transparency
fallbacks throughout.

## Testing

- **Unit (Node, TDD):** `nostr.eventId`/`serializeEvent` against NIP-01 known vectors;
  `governance` pure helpers (proposal state mapping, vote tally math, calldata
  encoders) where present. Tests in the job tmp dir.
- **Live reads (headless):** Nostr sub against a public relay returns events;
  `governor` adapter lists real proposals from a real Governor via public RPC.
- **Integrity:** `node --check` all JS; signing test 336/336 still passes; no dup IDs;
  all routes render; assets 200.
- **Not headless-verifiable (flagged):** posting to Nostr and casting votes need
  wallet+key — verified at build level, left for Elio to exercise in-browser.

## Parallel build plan

- **Agent A** → `nostr.js` (+ TDD). Independent, foundational.
- **Agent B** → `communities.js` + `communities.css`. Builds against the frozen
  `window.LZ.nostr` / `window.LZ.gov` interfaces using a local mock; renders into
  coordinator container IDs.
- **Agent C** → `governance.js` + `governance.css`. Builds against `window.ethereum`
  + public RPC; `governor` adapter verifiable against a real Governor.
- **Coordinator** → `daos.js`, `app.html` chat markup + container IDs, `app.js`
  wiring, CSS/script links, LayerZero contract research, integration + full verify.

Agents own only their files, do NOT touch `app.html`/`app.js`, do NOT commit.

## Out of scope (YAGNI for v1)

Direct messages (keep current DM mock removed or parked), NIP-29 relay-managed
groups (use NIP-28 public channels), encrypted DMs, profile editing, Snapshot
adapter (interface allows it later), proposal creation (read + vote only).
