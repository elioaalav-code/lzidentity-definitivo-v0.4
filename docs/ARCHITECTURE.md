# Architecture — LZidentity

A landing page (`index.html`) and an app (`app.html`), sharing a design
system, one identity primitive (EVM → Nostr), and a single path to the
on-chain layer (LayerZero).

## Two surfaces, one identity

```
┌────────────────────────────────────────────────────┐
│  index.html  · landing                             │
│   sections:                                        │
│   - [01] hero                                      │
│   - [02] sign once, use everywhere                 │
│   - [03] manifest                                  │
│   - [04] what you get (Recovery · Doppel · Soglia)    │
│   - [05] a quick tour (phone walkthrough)          │
│   - [06] how it travels (mesh · nostr · LayerZero) │
│   - [07] by the numbers                            │
│   - [08] carry yourself                            │
└────────────────────────────────────────────────────┘
                          │
                          ▼  shared identity
┌────────────────────────────────────────────────────┐
│  app.html  · the working app                       │
│   sidebar tabs:                                    │
│   - Chat                                           │
│   - Wallet                                         │
│   - Markets                                        │
│   - Network                                        │
│   - Identity        (EVM → Nostr derivation)       │
│   ───── your identity ─────                        │
│   - Recovery       (guardians · the way back)      │
│   - Doppelgänger    (the second you)               │
│   - Vault           (the testament)                │
└────────────────────────────────────────────────────┘
```

## Identity is the join key

Every tab in the app consumes the same primitive: **one EVM signature →
one deterministic Nostr name**. The Nostr name is what the rest of the
features key off:

- **Recovery** keys the guardian set off your Nostr name — guardians prove
  they're recovering *that* identity, on every chain at once.
- **Doppelgänger** is tied to that same name — agents from other people
  reach yours by referencing it.
- **Vault (Soglia)** watches your last-seen signature across all chains
  and runs the rule against that identity.

You sign once. The rest of the app inherits.

## File layout

```
lzidentity/
├── index.html              landing
├── app.html                app
├── assets/
│   ├── css/
│   │   ├── base.css        design tokens + primitives
│   │   ├── landing.css     landing-specific styles
│   │   ├── app.css         app-specific styles
│   │   └── anima.css       identity sections (manifest, pillars,
│   │                        Recovery/Doppel/Vault tabs)
│   └── js/
│       ├── base.js, landing.js, shared.js, shader.js  (landing + shared)
│       ├── app.js                                     (app router + views)
│       ├── anima.js                                   (landing reveals)
│       └── pillars.js                                 (Recovery/Doppel/Vault)
├── contracts/              Solidity (LayerZero OApps)
│   ├── KarmaLedger.sol         the cross-chain reputation ledger
│   ├── DoppelgangerHub.sol     the agent inbox
│   └── ThresholdVault.sol      the testament
├── docs/                   navigation + design notes
└── sources/                upstream references (kept for reading)
```

## Pillar colors

Each pillar gets one accent color, used throughout the landing and the app.

| Pillar          | Color             | Where it shows up           |
| --------------- | ----------------- | --------------------------- |
| Karma           | `#FF6B35` orange  | landing pillar 1, Karma tab |
| Doppelgänger    | `#4A9EFF` blue    | landing pillar 2, agent tab |
| Soglia          | `#8B5CF6` violet  | landing pillar 3, Vault tab |

## Build & run

Plain static files.

```bash
python3 -m http.server 8080
open http://localhost:8080
```

## Routes

| Route                | Surface                       |
| -------------------- | ----------------------------- |
| `/`                  | landing                       |
| `/#manifest`         | manifest section              |
| `/#pillars`          | what you get                  |
| `/app.html`          | app (default: chat)           |
| `/app.html#/identity`| sign & derive                 |
| `/app.html#/karma`   | Karma — reputation            |
| `/app.html#/doppel`  | Doppelgänger — the second you |
| `/app.html#/vault`   | Soglia — testament            |
