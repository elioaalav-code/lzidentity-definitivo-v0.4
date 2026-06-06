# 06 — DAO Social: Communities + Governance + Nostr + Classic Chat

Research phase, READ-ONLY. Scope: the "decentralized social network for DAOs" layer —
Communities feed/channels, three governance adapters, the add-DAO search, the Nostr
engine, and the classic DM chat. File:line refs are against the v0.3-living-identity
worktree.

---

## 1. Current state

### Nostr engine — `assets/js/nostr.js`
- NIP-01 done well: `serializeEvent` (79), sync `eventId` (91), async `getPubkey`/`signEvent`
  (99/110) via @noble esm.sh, with a Node `node:crypto` sha256 fallback (29-51) so the pure
  functions stay testable headless.
- Relay pool `openPool` (137): one WS per relay, backoff reconnect (183-195), cross-relay
  dedupe by id (220), `onEose` fires once every relay has EOSE'd or died (242-250), publish
  fans out with 8s per-relay timeout and resolves OK frames (283-310). Failures degrade to
  empty, never throw. This is solid infra.
- **Only kinds handled by callers: 1 (feed), 7 (reactions), 42 (channels).** No kind-0
  (profiles), no kind-3/10002 (contacts/relay lists), no kind-4/44 (DMs), no kind-40/41
  (channel create/metadata). The pool itself is kind-agnostic — the gaps are all in callers.
- `window.LZ.nostr` exposes `{ openPool, signEvent, getPubkey, eventId, serializeEvent }` (324).

### Communities controller — `assets/js/communities.js`
- Skeleton `#commLayout → #commList | #commMain(#commHeader,#commTabs,#commPanel)` (671-686),
  already present in `app.html:174`.
- Left rail with add/remove affordances, accent theming (147-218).
- Three tabs: Feed (kind-1), Channels (kind-42), Governance (delegated) (222-294).
- **Feed** (298-363): subscribes `[{kinds:[1], #t:[hashtag], limit:50}, {kinds:[7], limit:200}]`,
  80ms batched redraw (373), newest-first. Reaction = kind-7 "+" with `["e", postId]` (433-447),
  optimistic local reflect. Composer gated on `canPost()` = derived key present (120).
- **Channels** (451-524): per-channel kind-42 sub filtered by `#e:[ch.root]`. **But every
  `root` in the registry is `""`** → guard at 490 short-circuits to "Channel not ready". Feature
  is dead on arrival for all seed + generated communities.
- **Author rendering** (69-72): raw hex sliced `8…4`. No npub bech32, no display name, no avatar
  beyond a monogram of the hex. `shortNpub` is imported (26) but only the hex is available per post.
- Sign+publish (636-666) correctly awaits async `signEvent` (the documented footgun) and treats
  "any relay OK" as success.
- `window.LZ.communities = { init, openCommunity, setTab }` (736).

### Registry — `assets/js/daos.js`
- 4 seed communities (LayerZero, Uniswap, Nostr, Ethereum) (30-109); per-community relays,
  `feedHashtag`, and channels with **empty `root` strings** (42-44, 67-68, 87, 103).
- `RPC` map: publicnode ETH + Arbitrum (25-28). `RELAYS`: damus/nos.lol/primal/snort (15-20).
- Builders: `communityFromSnapshot` / `communityFromHashtag` / `communityFromGovernor` (148-182)
  — all also emit channels with `root:""`.
- `KNOWN_GOVERNORS` maps Snapshot space → on-chain Governor (Uniswap, ENS) so a discovered space
  upgrades to real on-chain voting (124-145). localStorage persistence `lz:communities` (185-208),
  `allCommunities()` merge (211).

### Governance — `assets/js/governance.js`
- Clean adapter dispatch `listProposals/getProposal/castVote` keyed on `govCfg.adapter` (837-891).
- **governor** (240-438): pulls `ProposalCreated` logs (chunked 45k, 300k look-back, 868), parses
  description/blocks (227), hydrates live `state()` + tallies with the OZ→Bravo fallback
  (`proposalVotes` else `proposals()` struct words 5/6/7) (284-322). `castVote` switches chain then
  `eth_sendTransaction` with selector 0x56781388 (404-438). "Load older" widens to 4× (851).
- **layerzero** (440-563): fully spec'd but `voteContract:""` → `isUnsetAddress` no-ops to []
  (493-503), UI shows "no active referendum". Selectors guessed (0x6c68bd6d / 0xb95aa3bd), not
  verified against a real contract. **Inert until the address is filled.**
- **snapshot** (565-776): keyless GraphQL list/get (635-668), gasless EIP-712 vote → seq.snapshot.org
  (729-776), `searchSpaces` via `ranking` with `spaces()` fallback (785). Multi-choice aware.
- Render (1027-1109): cards with proportional choice bar/legend, expand for body, per-adapter vote
  buttons, inline vote status `aria-live` message, retry, reduced-motion. **No post-vote refresh**
  of tallies; **no "you voted" state**; **no quorum / voting-power display.**

### Classic chat — `assets/js/app.js`
- **100% mock.** `CONVS` (165) and `THREADS` (174) are hardcoded; `sendChatMsg` (264) pushes to a
  local array and fakes a random reply on a timer (279-291). The "auto/mesh/nostr/layerzero" layer
  picker is decorative. No relay, no signing, no NIP-04/44 — none of the Nostr engine is wired in.
  Containers: `#chatItems`/`#chatThread`/`#chatSearch` in `app.html:158-161`.

---

## 2. Gaps (specific)

1. **Channels are dead** — every `channel.root` is `""` (daos.js + all 4 builders). NIP-28 requires
   a kind-40 channel-create event whose id is the root that kind-42 messages tag. Nobody ever creates
   kind-40, so channels can never work. (communities.js:490, daos.js:42-44/154/167/179)
2. **No reply threading.** Feed is a flat list; kind-1 posts ignore NIP-10 `e`/`p` tags entirely.
   No way to reply, no conversation view. (communities.js:381-416)
3. **No profiles / identity.** Authors shown as raw hex `8…4`; no kind-0 fetch (name/picture/about),
   no NIP-05 verification, no npub bech32 even though `shared.js` already has bech32 (shared.js:81).
   Self looks anonymous to others too. (communities.js:69-72, 394-416)
4. **LayerZero adapter inert** — `voteContract:""`; selectors unverified. Whole DAO has no live
   governance despite being the flagship. (daos.js:54, governance.js:490-503)
5. **No post-vote feedback loop** — after a successful vote the card is not re-fetched, tallies don't
   move, and there's no persistent "✓ you voted For" badge. Only a transient text line. (governance.js:1069-1075)
6. **No vote context** — no quorum line, no "your voting power", no time-remaining countdown, no
   block→time mapping for Governor proposals (`startsAt/endsAt` left null at governance.js:377-378).
7. **Reactions are read-shallow** — only ❤ (kind-7 "+") counts; no other emoji, no per-reaction
   breakdown, no reply/zap (NIP-57) affordance. (communities.js:365-371)
8. **Classic chat is fake** — a polished mock with no Nostr DM (NIP-04/44 + NIP-17 gift-wrap). It
   advertises "nostr/layerzero/mesh" routing that does nothing. (app.js:165-292)
9. **Relay set is static & global** — same 4 relays for every community; no NIP-65 relay-list, no
   per-community relays from discovery, no relay health surfaced to the user beyond a count chip.
10. **Feed authorship is hashtag-only** — `feedAuthors` is supported in the filter (communities.js:335)
    but never populated, so feeds are open hashtag firehoses with no curation/spam control.
11. **Snapshot ↔ feed mismatch** — a discovered Snapshot DAO gets a hashtag feed derived from its name
    (`toHashtag`), which rarely matches real Nostr activity; feeds for niche DAOs will be empty.
12. **No new-event live tail** — subs fetch a `limit` window; nothing streams new posts in after EOSE
    in a visibly "live" way (the sub stays open but UX doesn't signal liveness / unread).

---

## 3. Prioritized improvements

### P0 — make the core loop actually work

- **P0-A · Bootstrap NIP-28 channel roots.** On first open of a community's Channels tab, if a
  channel has no `root`, publish a kind-40 (content = `{name,about,relays}`) with the user's key,
  persist the returned event id back into the community (localStorage), and use it as `root`.
  Seed communities can ship with **real, pre-created** kind-40 ids committed into daos.js.
  *How:* new `ensureChannelRoot(c, ch)` in communities.js; `signEvent({kind:40,...})` then `publish`;
  store id via a daos.js setter. *Target:* channels tab → live. *Effort:* M (~120 LOC + 1 setter).
- **P0-B · Real Nostr DMs in classic chat (NIP-17 gift-wrap, NIP-44 v2).** Replace the mock CONVS/
  THREADS with kind-1059 gift-wrapped DMs (modern, metadata-private) or at minimum NIP-04 for a
  first cut. Conversation list = distinct `p`-tag counterparties; thread = decrypted messages.
  *How:* new `chat-nostr.js` consuming `window.LZ.nostr`; add NIP-44 encrypt/decrypt + conversation-key
  to nostr.js. *Target:* chat sends/receives over relays. *Effort:* L (NIP-44 crypto + UI rewire).
  (If scope-limited, do NIP-04 first, gift-wrap as P1.)
- **P0-C · Post-vote refresh + "you voted" state.** After `castVote` returns `txHash`, re-fetch the
  proposal (`getProposal`) and repaint the card; record the voter's choice in localStorage keyed by
  `adapter:space/governor:proposalId` and render a persistent "✓ Voted For" badge.
  *How:* extend the vote handler in governance.js:1056-1077. *Target:* visible voting feedback.
  *Effort:* S (~60 LOC).

### P1 — depth that makes it feel social

- **P1-A · Profiles: kind-0 + npub + NIP-05.** On feed/channel render, batch-subscribe `{kinds:[0],
  authors:[…]}` for visible authors, cache pubkey→{name,picture,nip05}, swap hex for display name +
  avatar; verify NIP-05 (`/.well-known/nostr.json?name=`) with a ✓. Encode authors as npub via the
  existing bech32. *Files:* nostr.js (helper), communities.js (render). *Effort:* M.
- **P1-B · Reply threading (NIP-10).** Add a reply composer per post; build kind-1 with marked tags —
  top-level reply uses a single `["e", rootId, relay, "root"]` + `["p", author]`; deeper replies add a
  `"reply"` marker, e-tags sorted root→parent. Render nested thread on expand. *Files:* communities.js.
  *Effort:* M.
- **P1-C · LayerZero address + selector verification.** Resolve the real fee-switch voteContract and
  confirm `currentReferendum()`/`castReferendumVote` selectors against the deployed bytecode; fill
  daos.js:54. *Files:* daos.js (+ maybe cfg.selRead/selVote). *Effort:* S once the address is known
  (research/verify is the cost).
- **P1-D · Vote context.** Add quorum + time-remaining countdown; for Governor, map block→timestamp
  (`eth_getBlockByNumber` on start/endBlock) to fill `startsAt/endsAt`; show "your voting power"
  (`getVotes`/balanceOf) before voting. *Files:* governance.js. *Effort:* M.
- **P1-E · Richer reactions + live tail.** Support multiple emoji (NIP-25), show reaction breakdown,
  and visibly stream new kind-1/42 events after EOSE with an unread divider. *Files:* communities.js.
  *Effort:* M.

### P2 — polish / reach

- **P2-A · NIP-57 Zaps** on posts/proposals (lightning tipping) — high signal in Nostr social.
- **P2-B · Per-community / NIP-65 relays.** Pull a space's relays from discovery; let users add relays;
  surface per-relay connect status (the pool already tracks `alive`). *Files:* nostr.js (expose status),
  communities.js, daos.js.
- **P2-C · Author curation for feeds.** Populate `feedAuthors` (e.g. from a DAO's known team npubs or
  followed set) so feeds aren't raw hashtag firehoses; spam/mute (NIP-28 kind-44). *Files:* daos.js, communities.js.
- **P2-D · Snapshot feed mapping.** Where a Snapshot space has no matching hashtag, fall back to showing
  proposals-as-feed or let the user set the feed hashtag at add-time. *Files:* community-add.js, daos.js.
- **P2-E · Tally adapter for Tally/Agora-style governance** (REST) as a fourth adapter for DAOs that
  aren't on Snapshot or a vanilla Governor. *Files:* governance.js, daos.js.

---

## 4. External best practices / NIPs to adopt

- **NIP-28** (kind 40 create / 41 metadata / 42 message / 44 mute) — the engine already speaks 42 but
  never creates the 40 root; that single missing step is why channels are dead.
- **NIP-10** marked `e`/`p` tags — top-level reply = one `root` marker; replies add `reply`, e-tags
  sorted root→parent. Required for any real threading.
- **NIP-01 kind-0** metadata + **NIP-19** npub/nevent bech32 (bech32 already vendored in shared.js) +
  **NIP-05** DNS verification — turns anonymous hex into recognizable, verifiable identities.
- **NIP-17 / NIP-44 v2** (gift-wrapped private DMs) — the modern, metadata-private replacement for the
  leaky NIP-04 for the classic chat. NIP-04 acceptable as a first cut.
- **NIP-25** reactions (multi-emoji) and **NIP-57** zaps — standard Nostr social signals.
- **NIP-65** relay lists — per-author/per-community relay routing instead of one global static set.
- **NIP-29** (relay-based simple groups) — worth evaluating as an alternative to NIP-28 for DAO channels
  (moderation lives on the relay); larger change, note for future.
- **Governance UX (Tally/Agora/Snapshot)** — show quorum, voting power, countdown, and persistent
  "you voted" state; these are table stakes users expect and we currently lack.

Sources: [NIP-28](https://github.com/nostr-protocol/nips/blob/master/28.md),
[NIP-10](https://github.com/nostr-protocol/nips/blob/master/10.md),
[Nostr group implementations comparison](https://nostrbook.dev/groups).

---

## 5. File ownership (CREATE phase)

**Would edit (owned by this DAO-social scope):**
- `assets/js/communities.js` — channels root bootstrap, threading, profiles, reactions, live tail.
- `assets/js/communities.css` — styles for replies, profile avatars, reaction breakdown.
- `assets/js/governance.js` — post-vote refresh, "you voted" badge, quorum/power/countdown.
- `assets/js/governance.css` — voted badge, quorum/countdown UI.
- `assets/js/daos.js` — real channel-root ids, per-community relays, feedAuthors, LayerZero address.
- `assets/js/community-add.js` / `community-add.css` — feed-hashtag override, relay entry.
- `assets/js/nostr.js` — add NIP-44 encrypt/decrypt, kind-0 fetch helper, npub helper, expose relay status.
- **NEW** `assets/js/chat-nostr.js` (proposed) — real Nostr DM engine for the classic chat.

**SHARED — coordinate before editing (touched by other scopes):**
- `assets/js/app.js` — owns the classic-chat mock (CONVS/THREADS/sendChatMsg, app.js:165-292) and
  `bootCommunities` (980); replacing the chat mock means editing app.js. HIGH-contention file.
- `app.html` — chat + communities view markup (147-182); any new chat DOM lands here. SHARED.
- `assets/js/shared.js` — provides `state.derived`, bech32, `shortNpub`; read-only dependency, avoid editing.
- `assets/js/ui.js` — `skeleton`/`emptyState`/`escapeHtml` consumed widely; avoid editing.

**HARD CONSTRAINTS to preserve:** element IDs (`#commLayout`/`#commPanel`/`#chatItems`/`#chatThread`),
`data-view`/`data-route`, the frozen `window.LZ.{nostr,gov,communities,communityAdd}` surfaces, Nostr
key derivation, HL signing, base.css/glass.css tokens.
