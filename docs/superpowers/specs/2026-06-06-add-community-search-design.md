# Add Community — DAO search engine + your own DAOs/Nostr groups

**Date:** 2026-06-06
**Approved (Elio):** a search-engine to add your own DAOs to Communities. **Hybrid**
governance (Snapshot search/breadth + on-chain Governor where known). Also add
**Nostr groups by hashtag**. Build the Snapshot adapter with a parallel Opus agent;
coordinator does discovery UI + persistence + registry + integration.

This spec is the frozen interface contract for the parallel build.

## Concept

Top of the Communities left rail gets a **Search / + Add** affordance. It opens a
discovery panel:
- **DAOs** — type a name → live results from **Snapshot's keyless GraphQL index**
  (thousands of real DAOs) → **Add**.
- **Nostr group** — add any community by **hashtag** (e.g. `#ethereum`), npub, or
  NIP-28 channel — instant, keyless.
- **Advanced** — add by **Governor address + chain**.

Added communities persist in `localStorage` and merge with the seed registry; each
is removable. Governance resolves per community (hybrid, see below).

## Non-negotiable constraints

No build step; plain ESM. No new bundled deps. Reuse existing primitives
(`window.ethereum`, fetch, the Nostr engine). Preserve element IDs / `window.LZ` /
HL signing / Nostr derivation. Honor reduced-motion. Strict file ownership; the agent
does NOT commit (coordinator integrates + commits).

## Hybrid governance resolution

Each added DAO gets a `gov` chosen by `daos.js`:
- If it matches the curated **`KNOWN_GOVERNORS`** map (snapshot-space id / lowercased
  name → `{chain, governor}`) → `{adapter:'governor', cfg:{chain, rpc, governor}}`
  (real on-chain vote — reuses the existing governor adapter).
- else → `{adapter:'snapshot', cfg:{space:'<space-id>'}}` (Snapshot proposals + gasless
  signed vote).
- Nostr groups → `gov:null`.

## Module ownership

| Module | Files | Owner |
|---|---|---|
| Snapshot adapter + space search | `assets/js/governance.js` (extend) | Agent |
| Discovery/add UI + persistence | `assets/js/community-add.js`, `assets/css/community-add.css` | Coordinator |
| Registry: merge + builders + known map | `assets/js/daos.js` (extend) | Coordinator |
| Rail integration | `assets/js/communities.js` (extend) | Coordinator |
| Backbone | `app.html` (css/script links) | Coordinator |

## Interface contracts (FROZEN)

### A. Snapshot adapter + search — `governance.js` (Agent)
Extend the existing `window.LZ.gov` (keep governor/layerzero adapters intact):
- Add adapter `'snapshot'`, `cfg:{ space:'<snapshot-space-id>' }` (e.g. `uniswapgovernance.eth`):
  - `listProposals` / `getProposal`: Snapshot GraphQL `https://hub.snapshot.org/graphql`
    `proposals(where:{space}, orderBy:"created", orderDirection:desc, first:20)`; map to the
    existing `Proposal` shape `{id,title,body,state,choices:[{label,votes}],totalVotes,
    startsAt,endsAt,url,source:'snapshot'}` (choices from `choices[]`+`scores[]`, totalVotes
    from `scores_total`, state from Snapshot `state` pending/active/closed, url=`https://snapshot.org/#/<space>/proposal/<id>`).
  - `castVote(cfg, proposalId, choice)`: Snapshot gasless vote — build the EIP-712 vote
    message, `eth_signTypedData_v4` via `window.ethereum`, POST to the Snapshot sequencer
    (`https://seq.snapshot.org`). `choice` is the 1-based choice index. Return `{txHash|id}`
    or `{error}`. (Needs wallet — not headless-verifiable; verify message construction by unit test.)
  - `renderGovernance(el, govCfg)` already exists for governor/layerzero/empty — extend it to
    render `'snapshot'` proposals with the proposal's own multiple choices as vote buttons.
- Add `searchSpaces(query) -> Promise<Array<{id,name,network,followers,avatar?}>>`:
  Snapshot GraphQL space search. Try `ranking(first:18, where:{search:$q}){items{id name
  network followersCount}}`; if `ranking` is unavailable, fall back to
  `spaces(first:18, where:{...})` / a top-spaces client-side filter. Never throw → `[]`.
- Self-mount additions onto `window.LZ.gov` (add `searchSpaces`; keep existing keys).
- Reads keyless via fetch; verify live against the real Snapshot API headless.

### B. Registry — `daos.js` (Coordinator)
- `export const KNOWN_GOVERNORS = { 'uniswapgovernance.eth': {chain:1, governor:'0x408ED6…'}, ... }`
- `communityFromSnapshot(space) -> community` (gov resolved via KNOWN_GOVERNORS else snapshot adapter)
- `communityFromHashtag(tag) -> community` (kind:'nostr-group', nostr.feedHashtag, gov:null)
- `communityFromGovernor({name,chain,governor}) -> community`
- `loadUserCommunities()`, `addUserCommunity(c)`, `removeUserCommunity(id)` — `localStorage` key `lz:communities`
- `allCommunities() -> [...seed, ...user]` (dedupe by id)

### C. Discovery UI — `community-add.js` + `.css` (Coordinator)
- `window.LZ.communityAdd = { open(opts) }` — opens a modal/panel with the three add modes;
  uses `window.LZ.gov.searchSpaces` (debounced) for DAO search and `daos.js` builders + persistence.
  Calls `opts.onAdded(community)` after a successful add. Obsidian-glass styling.

### D. Rail integration — `communities.js` (Coordinator)
- Community list source switches from `COMMUNITIES` to `allCommunities()`.
- A **"＋ Add / Search"** button in the rail header → `window.LZ.communityAdd.open({onAdded})`.
- A remove affordance on user-added communities → `removeUserCommunity` + re-render.

## Data flow

search box → `window.LZ.gov.searchSpaces(q)` → results → Add → `daos.js`
builder + `addUserCommunity` (localStorage) → `communities.js` re-renders rail from
`allCommunities()` and opens the new community → its Governance tab uses the resolved
`gov` (governor or snapshot adapter) via `window.LZ.gov.renderGovernance`.

## Error handling

Snapshot API down → empty results + retry; never throw. Invalid hashtag/address →
inline validation. Duplicate add → no-op (dedupe by id). Not connected/derived →
read works; vote/post show the existing CTAs.

## Testing

- **Unit (TDD):** `daos.js` builders + dedupe + KNOWN_GOVERNORS resolution; Snapshot
  proposal→Proposal mapping + vote-message construction (agent).
- **Live reads (headless):** `searchSpaces('uniswap')` returns real spaces;
  `listProposals({adapter:'snapshot',cfg:{space:'uniswapgovernance.eth'}})` returns real
  proposals. Discovery UI renders results (mock or live).
- **Integrity:** node --check all; signing 336/336; no dup IDs; all routes render; no console errors.
- **Not headless-verifiable:** Snapshot gasless vote (wallet) — verified by construction + in-browser.

## Out of scope (YAGNI)

Editing/curating added communities beyond add/remove; following individual npub feeds
(hashtag covers groups); proposal creation; cross-device sync (localStorage only).
