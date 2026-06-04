# HANDOFF — LZidentity

> A briefing for the next agent (human or AI) picking up this project.
> Read this **before** touching the repo. It tells you where we are, why
> things are the way they are, and what to do next.

---

## 0 · v2.1 refactor — read this first

The project pivoted. **Doppelgänger and Soglia were removed** (from the app
*and* the landing). In their place:

- **Trading** — a real Hyperliquid perps tab. Live market data over
  WebSocket and **real on-chain order signing from the browser** (EIP-712
  L1-action scheme). Code: `assets/js/hyperliquid.js` (client + signing) and
  `assets/js/trade.js` (UI). Default network is **testnet**; there's a
  mainnet toggle. `hyperliquid.js` exports `selfTest()` — it recomputes a
  known action hash and logs PASS/FAIL on load, proving the msgpack+keccak
  signing matches the official SDK byte-for-byte. Don't touch the wire
  field order (`a,b,p,s,r,t`) — it's load-bearing for the signature.
- **Assistant** — a global Claude copilot (`assets/js/assistant.js`,
  `assets/css/assistant.css`), launched from the floating button. Calls the
  Anthropic Messages API straight from the browser with the user's own key
  (localStorage), streaming + tool use so it can navigate the app and read
  live state via `window.LZ`. Falls back to a scripted guide with no key.
- **`window.LZ`** — a small global API (set up in `app.js`, extended by
  `trade.js` and `assistant.js`): `navigate(route)`, `snapshot()`,
  `hl.setCoin()`, `hl.prefillOrder()`, `assistant.ask()`. This is how the
  copilot drives the app — keep it stable.

The LayerZero / Solidity material below (§5–§6) is **legacy**: Trading now
uses Hyperliquid, not our own contracts, so `contracts/*.sol` are vestigial
reference only. Recovery is still the one sketched pillar.

---

## 1 · The 60-second pitch

**LZidentity is one identity that works on every chain.** A user signs one
short message with their wallet (MetaMask, etc.), and a matching Nostr
identity is derived deterministically. From that single identity, the app
exposes three features built on top of **LayerZero V2**:

| Feature        | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| **Recovery**   | Pick guardians (friends, devices). Two of them can restore your identity on every chain at once. Replaces seed-phrase recovery. |
| **Trading**    | Real perps trading on Hyperliquid, signed by the user's wallet and settled on-chain. Live book + candles. Testnet by default. |
| **Assistant**  | A Claude-powered copilot that explains features, navigates the app, reads live state, and pre-fills trades for the user to sign. |

The marketing site and the working app live in the **same repo**, share
the same design system, and use the same identity primitive as the join key.

---

## 2 · What's live vs. what's a sketch

| Surface                            | Live | Sketch |
| ---------------------------------- | ---- | ------ |
| EVM → Nostr derivation             | ✅   |        |
| Landing page (hero, manifest, pillars, walkthrough, transports) | ✅ | |
| Chat / Wallet / Markets / Network tabs | ✅ (with demo data) | |
| Identity tab (Sign & derive)       | ✅   |        |
| Trading · Hyperliquid market data + order signing | ✅ — **real, on-chain** | |
| Assistant · Claude (user key) + offline guide | ✅ | |
| Recovery guardians + history       |      | ✅     |
| `contracts/*.sol` (legacy)         | source-only — **vestigial; Trading uses Hyperliquid** | |

The sketches use `setInterval` with synthetic data so the UI feels alive.
None of them touch a real backend or an on-chain endpoint.

---

## 3 · Project history — the decisions you need to know

This project was built in one session (2026-05-19) by merging three
upstream repos. The decisions below are *not visible from the code* but are
load-bearing — don't undo them by accident.

### 3.1 · The rebrand history

**Started as:** a merge of `elioaalav-code/ciphermesh-web` (encrypted messaging
across mesh/Nostr/LayerZero) and `elioaalav-code/anima` v1 (soulbound identity
with Karma/Doppelgänger/Soglia). Anima v2 and v3 were explicitly excluded — the
user chose v1.

**Folder & repo originally named:** `ciphermesh-anima` → renamed to
**`lzidentity`** (folder `/Users/zero/lzidentity/`, repo
`elioaalav-code/lzidentity`). GitHub keeps redirects from the old name.

**Co-branding dropped:** the public surface no longer mentions "CipherMesh"
or "Anima" anywhere. They are not features, they are history. **Do not
reintroduce these names in user-facing copy.**

### 3.2 · The Karma → Recovery pivot

The original Anima v1 design had **Karma** (cross-chain reputation) as
pillar 1. We removed it from the public surface for an honest reason:

> Karma as a public reputation only works if the rest of the crypto world
> (DAOs, mints, apps) reads it. Without that adoption, it's a number that
> only matters inside our own app — and we couldn't promise the adoption.

Now: **Recovery replaces Karma as pillar 1.** The internal "trust score"
flavor of Karma still lives — but only **inside the Doppelgänger tab**, as
an agent-to-agent reputation visible during trades. It is not a feature
sold separately. **Do not put Karma back on the landing.**

### 3.3 · TRIBE v2 as a private design oracle

The visual design was informed by **TRIBE v2** (Meta AI Research's brain
encoding model, arXiv:2507.22229). We used its findings about multimodal
cortical activation as design heuristics — color, motion timing, pillar
mapping — but we **never name-check it publicly**. Internal notes are in
`docs/DESIGN_PRINCIPLES.md` if you want the rationale.

**Rule:** TRIBE never appears in user-facing copy. The internal docs are
fine.

### 3.4 · Tone rules — apply on every public-facing change

- **Never name-check** TRIBE / CipherMesh / Anima publicly
- **No jargon:** avoid `soulbound`, `omnichain`, `OApp`, `NIP-44`,
  `cortical`, `fsaverage`, `optimistic-local-eventually-global`, etc.
- **Feature names are canonical:** Recovery, Doppelgänger, Soglia (yes,
  Italian — it's a proper noun now)
- **Human tone first.** "A second you, that never sleeps" beats "agent
  runtime tied to soulbound identity"
- **`DERIVATION_MSG` in `shared.js` is user-facing** (the wallet pops it
  up when signing) — keep it warm and reassuring

### 3.5 · Pillar colors are canonical

| Pillar          | Color             | CSS token              |
| --------------- | ----------------- | ---------------------- |
| Recovery        | `#FF6B35` orange  | `--recovery`           |
| Doppelgänger    | `#4A9EFF` blue    | `--doppel`             |
| Soglia          | `#8B5CF6` violet  | `--soglia`             |

The CSS tokens are in `assets/css/anima.css` (filename historic, leave it).

---

## 4 · Stack & layout

**Plain HTML + CSS + JS.** No bundler, no toolchain. Run with any static
server.

```bash
cd lzidentity
python3 -m http.server 8080
open http://localhost:8080
```

```
lzidentity/
├── index.html              landing
├── app.html                app (8 tabs: chat · wallet · markets · network
│                              · identity · recovery · doppel · vault)
├── assets/
│   ├── css/
│   │   ├── base.css        design tokens + primitives
│   │   ├── landing.css     landing-specific
│   │   ├── app.css         app-specific
│   │   └── anima.css       identity-feature styles (Recovery/Doppel/Vault)
│   └── js/
│       ├── shared.js       wallet connect + EVM→Nostr derivation (LIVE)
│       ├── landing.js      landing animations
│       ├── shader.js       hero WebGL
│       ├── app.js          app router + first 5 tabs
│       ├── anima.js        landing reveals
│       └── pillars.js      Recovery/Doppel/Vault tab logic (SKETCHES)
├── contracts/              Solidity (LayerZero V2 OApps)
│   ├── KarmaLedger.sol         ← still named "Karma" internally · legacy from Anima v1.
│   │                              When deploying, either rename or repurpose for the
│   │                              Doppelgänger-internal trust score.
│   ├── DoppelgangerHub.sol     agent inbox · OApp pattern
│   └── ThresholdVault.sol      testament · uses LZ Composer for atomic-multichain
├── docs/
│   ├── ARCHITECTURE.md         file map + symbol mapping
│   ├── DESIGN_PRINCIPLES.md    internal — TRIBE-derived UX heuristics
│   └── anima-v1/               historic — original Anima v1 design archive
├── sources/                upstream clones (read-only reference)
├── HANDOFF.md              ← this file
└── README.md
```

### Important file-level notes

- **`assets/js/shared.js`** holds `DERIVATION_MSG`. Changing that string
  changes the derived Nostr key, breaking continuity for any user who
  already signed. Treat it like a chain ID.
- **`assets/js/app.js`** has a hardcoded `ROUTES` array. Adding a tab
  requires extending both the array and the sidebar in `app.html`.
- **`assets/css/anima.css`** uses class names with the prefix
  `.recovery-*`, `.doppel-*`, `.soglia-*` (and pillar selectors like
  `.pillar.recovery`). Keep that convention.
- **`contracts/KarmaLedger.sol`** still carries the legacy name internally
  even though Karma was demoted from the public pillars. Rename when
  deploying (see §6).

---

## 5 · LayerZero V2 — everything you need to integrate it for real

This is the **next big task**: take the existing Solidity contracts from
"source-only" to "actually deployed and wired up", and replace the
client-side sketches with real on-chain calls.

### 5.1 · Concept primer

**Endpoint.** An immutable, permissionless contract deployed on every
supported chain. It's the entry/exit point: `endpoint.send()` on the source
chain, `endpoint.lzReceive()` on the destination.

**OApp (Omnichain Application).** A contract that inherits from
`OApp.sol`. To send, call `_lzSend()`. To receive, override `_lzReceive()`.
Each chain has one instance; they're paired via `setPeer()`.

**DVN (Decentralized Verifier Network).** Validators that attest a message
is real. Apps configure an **X-of-Y-of-N** security stack:
- **X**: required DVNs (must always sign)
- **Y**: total threshold (required + optional)
- **N**: pool size

If a DVN is compromised, only the channels that use it are at risk — not
the whole network.

**Executor.** A contract that calls the destination's `lzReceive()` to
trigger execution after verification. Pays gas on destination.

**Composer.** A pattern that breaks a single cross-chain operation into
multiple, independently-failing steps (token transfer → swap → stake). Use
it when you want **horizontal composability** instead of stacking atomic
ops. `ThresholdVault.sol` is the place where we want this for the Soglia
cascade.

**Endpoint IDs.** `30xxx` = mainnet, `40xxx` = testnet. **Not the same as
chain IDs.** Find them in
https://docs.layerzero.network/v2/deployments/deployed-contracts (the page
is dynamic — pull from the "View Metadata" JSON or hit the contract
addresses directly).

### 5.2 · The OApp contract pattern

Every OApp has the same skeleton:

```solidity
import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

contract MyOApp is OApp {
    constructor(address _endpoint, address _owner)
        OApp(_endpoint, _owner) {}

    function send(uint32 _dstEid, bytes memory _message, bytes memory _options)
        external payable
    {
        _lzSend(
            _dstEid,
            _message,
            _options,
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );
    }

    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        // your business logic here
    }
}
```

**Always include all five `_lzReceive` parameters** even if unused —
otherwise the Endpoint can't call you.

### 5.3 · The Composer pattern (for ThresholdVault)

When you want a cross-chain step to fire *after* the initial `lzReceive`:

```solidity
import { IOAppComposer } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppComposer.sol";

contract MyComposer is IOAppComposer {
    function lzCompose(
        address _oApp,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable override {
        require(msg.sender == endpoint, "unauthorized");
        // step 2 logic here
    }
}
```

The sending OApp calls `endpoint.sendCompose(composerAddress, _guid, 0, payload)`
inside its `_lzReceive`. Use this for the Soglia atomic-multichain cascade.

### 5.4 · Toolchain & setup

**Quickest path:** Hardhat with the LayerZero CLI.

```bash
npx create-lz-oapp@latest --example oapp
cd <project-name>
pnpm install   # or npm
```

**npm packages you'll end up using:**
- `@layerzerolabs/oapp-evm` — the `OApp` base contract
- `@layerzerolabs/lz-evm-protocol-v2` — interfaces
- `@layerzerolabs/devtools-evm-hardhat` — CLI tasks
- `@layerzerolabs/oft-evm` — if you also need OFT (omnichain fungible token)

**For Foundry:**
```bash
forge install layerzero-labs/devtools
forge install layerzero-labs/LayerZero-v2
forge install OpenZeppelin/openzeppelin-contracts
```

### 5.5 · Deploy + wire + send (the three commands)

The LayerZero CLI hides most of the complexity:

```bash
# 1 · deploy to each chain
npx hardhat lz:deploy

# 2 · wire peers + libraries + DVN config across all chains in one shot
npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts

# 3 · send a test message
npx hardhat lz:oapp:send \
  --dst-eid 30110 \
  --string "hello" \
  --network arbitrum-sepolia-testnet
```

The wire command reads from `layerzero.config.ts`, which declares: every
chain pair, the send/receive libraries to use, the DVN set per pathway,
and the executor.

### 5.6 · DVN config for production

Testnet: a single DVN is fine. Mainnet: **never single-DVN** — a
compromise of that one verifier means unrestricted forged messages. The
docs recommend "multiple required DVNs from independent operators."

Sensible mainnet config for our use case:
- **Required (X = 2):** LayerZero Labs + one other top-tier (Google Cloud,
  Polyhedra, Stargate)
- **Optional (Y - X = 1):** a community DVN
- **N:** the chain's full available pool

For `ThresholdVault`'s testament cascade (irreversible, high-stakes),
consider X = 3.

### 5.7 · From sketches to live calls — concrete steps for each tab

**Recovery tab (`/app.html#/recovery`)**

Current state: sketches in `pillars.js` (`addRecoveryEvent`, `recoveryTestBtn`).

To make live:
1. Write a new `RecoveryHub.sol` (or repurpose `KarmaLedger.sol`):
   - Stores `mapping(bytes32 => Guardian[]) guardians` keyed by user's
     Nostr name hash
   - Function `setGuardians(bytes32[] _guardianHashes, uint8 _threshold)`
   - Function `initiateRecovery(bytes32 _newOwner)` — broadcasts via
     `_lzSend` to all paired chains
   - Function `signRecovery(bytes32 _recoveryId)` — guardian signs
   - When threshold reached: composer triggers atomic owner-swap on every
     chain
2. Deploy on Sepolia / Arb Sepolia / OP Sepolia / Base Sepolia
3. Wire peers via `lz:oapp:wire`
4. In `pillars.js`, replace the sketches with real calls via `viem` or
   `ethers`:
   - `addGuardian` → contract call
   - `recoveryTestBtn` → contract call that emits a test event (no actual
     owner swap)
   - Listen to events to update the UI live

**Doppelgänger tab (`/app.html#/doppel`)**

Current state: a fake chat thread between `α` and `β`.

To make live:
1. `DoppelgangerHub.sol` exists — review it, fix any compile errors
2. The agent runtime is **off-chain**. Recommended stack: a small Node.js
   service that uses the **Anthropic SDK** (Claude API) for decision-making
   and `ethers`/`viem` for execution. See `docs/anima-v1/04-agent.md` for
   the v1 design — adapt it to the LZidentity tone.
3. Agent talks to other agents over **Nostr DMs (NIP-44)** for chat, and
   `DoppelgangerHub` for on-chain intent matching
4. The trust score (the demoted Karma) lives inside the agent's local
   state, surfaced in the UI as `rep: A+`

**Vault tab — Soglia (`/app.html#/vault`)**

Current state: a fake countdown.

To make live:
1. `ThresholdVault.sol` exists and is designed as an `OApp + Composer`
2. Functions to add:
   - `setRule(uint256 quietDays, uint256 graceDays, address[] beneficiaries, uint256[] shares)`
   - `heartbeat()` — user calls this on any chain to reset the timer on
     every chain via `_lzSend`
   - After `quietDays + graceDays` with no heartbeat: anyone can call
     `triggerCascade()`; composer fans out atomic transfers to beneficiaries
3. Use Composer for atomicity: either every chain transfers or none does

### 5.8 · Endpoint addresses to bake into config

Don't hardcode. Pull from `@layerzerolabs/lz-evm-sdk-v2` constants, or
from the docs page. The CLI auto-detects them when you wire your
`hardhat.config.ts` correctly:

```ts
import { EndpointId } from "@layerzerolabs/lz-definitions";

networks: {
  "arbitrum-sepolia-testnet": {
    eid: EndpointId.ARBSEP_V2_TESTNET,
    url: process.env.RPC_URL_ARB_SEPOLIA,
    accounts: [PRIVATE_KEY],
  },
  "optimism-sepolia-testnet": {
    eid: EndpointId.OPTSEP_V2_TESTNET,
    // ...
  },
  // etc.
}
```

---

## 6 · What to do next — prioritized

**P0 · Pick a testnet and deploy something.** Even a hello-world OApp on
2 chains, just to validate the toolchain works end-to-end. Use
`@layerzerolabs/oapp-evm` and `npx hardhat lz:deploy`. Pick Arbitrum
Sepolia + Optimism Sepolia — cheap, fast, well-supported.

**P1 · Make the Vault feature live.** It's the simplest of the three to
turn real because the on-chain logic is mostly *state* (timer + rule) +
one atomic cascade. Composer pattern is documented in §5.3. Wire it to
the UI in `pillars.js` (the heartbeat button is already there).

**P2 · Rename `KarmaLedger.sol`.** Either rename to `RecoveryHub.sol` and
repurpose for guardian-based recovery, or rename to `TrustLedger.sol` and
keep it as the Doppelgänger-internal trust score. Don't leave it as
`KarmaLedger` once you ship publicly — it contradicts the rebrand.

**P3 · Build the Recovery contract.** This is the biggest engineering
piece. Look at OpenZeppelin's `IERC7484` and "social recovery wallet"
prior art (Argent, Soul Wallet) — don't reinvent. Adapt to multi-chain
via LayerZero so guardian sigs propagate atomically.

**P4 · Doppelgänger agent runtime.** A separate repo or service. Reuse
`docs/anima-v1/agent-system-prompt.md` and `docs/anima-v1/agent-tools.json`
as the starting prompt — they're still good, just strip the v1 jargon.

**P5 · Mainnet hardening.** Multi-DVN config (§5.6), audit, monitoring,
gas estimation review.

---

## 7 · Open decisions you might revisit

- **Should Soglia be opt-in by default, or always-on with a high threshold?**
  Currently the UI assumes the user actively sets it up. An always-on
  default with a sensible 365-day window might be better — fewer people
  bother to configure death, more people end up protected.
- **Recovery threshold UX.** Right now 2-of-3 is hardcoded as default.
  Should the UI walk first-time users through choosing M-of-N, or just
  pick a sane default and let advanced users change it?
- **What happens to the Chat/Wallet/Markets/Network tabs long-term?** They
  exist because the project started from CipherMesh. They're useful demos
  but they aren't strictly part of "LZidentity = an identity system."
  Decide if they stay or get spun out.
- **Internationalization.** "Soglia" is Italian, deliberate. But the rest
  of the UI is English. If we expand to non-English markets, do feature
  names get translated or stay in English/Italian?

---

## 8 · Where the bodies are buried

Things that would surprise a fresh agent if discovered the hard way:

- **`sources/` is not part of the product.** It's the upstream clones from
  before the merge. Read-only reference. Don't import from it. Don't link
  to its files from the landing.
- **`docs/DESIGN_PRINCIPLES.md` references TRIBE v2.** That's intentional
  — it's internal. **Never link it from the landing or README's
  user-facing sections.**
- **The Identity tab DOES work** (`shared.js` derives a real Nostr key
  from the wallet signature). It's not a sketch. If you change the
  derivation message in `shared.js`, anyone who signed before gets a
  different key. Don't.
- **There's a sidebar divider in `app.html`** labeled "YOUR IDENTITY"
  separating the original 5 tabs from the Recovery/Doppel/Vault group.
  Don't remove it without intent — it's the visual cue that those three
  belong together.
- **The brand mark `LZ`** is rendered as text inside a gradient box.
  Don't replace with an SVG logo unless you have a reason.

---

## 9 · Repo & infrastructure

- **GitHub:** https://github.com/elioaalav-code/lzidentity (public, owned
  by `elioaalav-code`)
- **Default branch:** `main`
- **Old name:** `ciphermesh-anima` (GitHub keeps redirects)
- **Local path:** `/Users/zero/lzidentity/`
- **No CI/CD set up yet.** No deploy pipeline. No Vercel/Netlify hook.
  Static-host whenever ready (Vercel/Netlify/GitHub Pages all work — it's
  plain HTML).
- **No `package.json` in the root.** The frontend is buildless. If you
  add the contracts toolchain, put it in a sub-dir like `contracts/` with
  its own `package.json` so the static site stays buildless.

---

## 10 · Hand-off summary

If you read only one paragraph: **LZidentity is a landing + working app
for a cross-chain identity built on LayerZero V2. The frontend is done.
Three Solidity contracts (`KarmaLedger`, `DoppelgangerHub`, `ThresholdVault`)
exist as source but are not deployed. The next milestone is deploying any
one of them to testnet and wiring at least one tab to a real on-chain
call. Read §5 of this doc for the LayerZero specifics; respect the tone
rules in §3 so you don't undo the rebrand work.**

Good luck. Be honest with the user about what's a sketch and what's real.
That's the only rule you really need.
