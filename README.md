# LZidentity

> One identity that works on every chain. Sign once with your wallet, and it
> follows you wherever you go — with a way to recover it without the seed
> phrase, real on-chain trading on Hyperliquid, and an assistant that helps
> you use every corner of the app.

## What this is

A landing page and a working app, in one repo. The landing tells the story.
The app lets you try it: connect a wallet, derive your second name on Nostr
with one signature, and use the three things you get out of the box —
**Recovery**, **Trading**, **Assistant**.

> **Picking up this project as a new contributor or agent?** Read
> **[`HANDOFF.md`](HANDOFF.md)** first. It explains the design decisions,
> the tone rules, the Hyperliquid + Claude integration, and what to build
> next — everything you need to continue without having to reconstruct it.

## Quick start

```bash
cd lzidentity
python3 -m http.server 8080
open http://localhost:8080
```

Plain HTML, CSS, and a sprinkle of JavaScript. No build step, no toolchain
to fight with. The Hyperliquid client and the Claude assistant both run
straight from the browser via ES-module imports.

## Pages

| Route                | What you see                                  |
| -------------------- | --------------------------------------------- |
| `/`                  | The landing — story, manifest, tour           |
| `/app.html`          | The app — opens on the chat tab               |
| `/app.html#/trade`   | Real perps trading on Hyperliquid             |
| `/app.html#/recovery`| A way back, without the seed phrase           |
| `/app.html#/identity`| Sign once, derive your Nostr name             |

The **Assistant** is a global copilot (the button bottom-right) — it works
on every tab, not a route of its own.

## What it does

**One identity, two names.** Sign one short message with your wallet
(MetaMask, Rabby, anything that exposes `window.ethereum`) and a matching
Nostr name is born. Same wallet, same name, forever. Switch device, sign
again — you're back.

**Trading.** Real perpetual-futures trading on **Hyperliquid**, inside your
identity. Live order book and candles, your positions and balance in one
place. Every order is built, signed by your own wallet (EIP-712), and sent
on-chain — there's a testnet/mainnet toggle, and it starts on testnet. The
app never signs or places anything on its own; you confirm and sign each
order.

**Recovery.** A way back, without the seed phrase. Pick a few guardians
(friends, devices, anyone you'd trust in a panic). If you ever lose access,
two of them sign and you're back to being yourself — on every chain at once.
No twelve words to memorize.

**Assistant.** An in-app copilot that actually knows the app. Ask it to
explain a feature, open a tab, read your live balances, or pre-fill a trade
for you to sign. Bring your own Anthropic (Claude) API key for the full
assistant — stored only in your browser — or use the built-in offline guide.
It never signs anything for you.

## Built on

- **Hyperliquid** — the perps DEX the Trading tab reads and trades against,
  with real EIP-712 order signing from the browser
- **Claude (Anthropic API)** — the brain behind the Assistant; the user
  supplies their own key, called directly from the client with streaming
  and tool use
- **LayerZero** — the cross-chain layer that keeps one identity coherent
  across every chain at once
- **Nostr** — the second name your wallet is paired with, for encrypted
  messages and a public identity that isn't owned by any one company

## Layout

```
lzidentity/
├── index.html          landing page
├── app.html            the app (chat · wallet · markets · trade · network
│                          · identity · recovery, plus the global assistant)
├── assets/
│   ├── css/            base · landing · app · anima · trade · assistant
│   └── js/
│       ├── shared.js       wallet connect + EVM→Nostr derivation (LIVE)
│       ├── app.js          router + chat/wallet/markets/network/identity
│       ├── hyperliquid.js  Hyperliquid client + REAL order signing
│       ├── trade.js        Trading tab UI (chart · book · ticket)
│       ├── assistant.js    Claude copilot (+ scripted fallback)
│       └── pillars.js      Recovery tab logic (sketch)
├── docs/               architecture + internal design notes
└── README.md
```

## What's live vs. what's a sketch

| Surface                              | Live | Sketch |
| ------------------------------------ | ---- | ------ |
| EVM → Nostr derivation               | ✅   |        |
| Trading · Hyperliquid market data    | ✅   |        |
| Trading · real on-chain order signing| ✅   |        |
| Assistant · Claude (with your key)   | ✅   |        |
| Assistant · offline guide            | ✅   |        |
| Chat / Wallet / Markets / Network    | ✅ (demo data) |  |
| Recovery guardians + history         |      | ✅     |

The Trading tab is the real thing: it pulls live prices, the order book, and
candles from Hyperliquid over WebSocket, and signs orders with the official
L1-action scheme (verified byte-for-byte against the SDK by a self-test that
logs on load). Recovery is still wired with demo data — it's the shape of
what's coming.
