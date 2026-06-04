# ANIMA

> Un esperimento di design di protocollo cross-chain, evoluto in conversazione.

Questa repository raccoglie il materiale prodotto durante un brainstorming iterativo
attorno a un'idea di app basata su [LayerZero](https://layerzero.network/).

Il progetto è passato attraverso **tre versioni** di design, ognuna come risposta
a una critica reale dell'utente. La storia di queste evoluzioni è documentata in
[`docs/09-design-evolution.md`](docs/09-design-evolution.md) e vale forse più
del design "finale" stesso.

---

## Struttura della repository

```
anima/
├── README.md
├── site/
│   ├── index.html              ─ sito marketing (editoriale, Instrument Serif)
│   └── ui.html                 ─ prototipo dell'app (4 viste navigabili)
├── docs/
│   ├── 01-overview.md          ─ il concept originale (v1)
│   ├── 02-whitepaper.md        ─ architettura tecnica (v1)
│   ├── 03-contracts.md         ─ codice Solidity dei contratti core (v1)
│   ├── 04-agent.md             ─ spec del Doppelgänger / AI agent (v1)
│   ├── 05-tokenomics.md        ─ $ANIMA supply, sink, burn (v1)
│   ├── 06-roadmap.md           ─ 18 mesi, hard gates (v1)
│   ├── 07-manifesto.md         ─ il "perché" filosofico
│   ├── 08-stories.md           ─ antologia di 5 storie di Anime nel mondo
│   ├── 09-design-evolution.md  ─ ★ il pivot: critica, riformulazione, abbandono
│   └── 10-pitch-deck.md        ─ 10 slide per investitori
├── contracts/
│   ├── KarmaLedger.sol         ─ Karma globale via LayerZero
│   ├── DoppelgangerHub.sol     ─ intent matching cross-chain
│   └── ThresholdVault.sol      ─ testamento atomico omnichain
└── agent/
    ├── system-prompt.md        ─ system prompt del Doppelgänger
    └── tools.json              ─ tool definitions per Claude API
```

---

## Le tre versioni — in breve

### v1 · ANIMA *(identità soulbound omnichain)*
Una singola entità soulbound che vive su ogni chain. Tre pilastri:
- **Karma** — reputazione globale e scarsa
- **Doppelgänger** — agente AI personale autonomo
- **Soglia** — testamento digitale omnichain

→ critica: *"sembra social credit cinese. L'anonimato nelle blockchain è importante."*

### v2 · ANIMA riformulata *(privacy-first)*
- Sostituito Karma con **Scrigno** (memoria privata + attestazioni ZK opt-in)
- Sostituito Doppelgänger con **Consigliere** (mai agisce senza permesso)
- Mantenuto Soglia
- Aggiunto **Velo** (privacy attiva cross-chain)

→ critica: *"hai eliminato così tante cose che dobbiamo praticamente farlo nuovo."*

### v3 · VESTIGIA *(provenienza degli oggetti)*
Pivot da identità a oggetti. NFT inviolabili come storia di oggetti fisici,
Mercanti che negoziano vendite peer-to-peer cross-chain.

→ critica: *"quella era una feature, non un protocollo intero."*

### Stato attuale
Ridiscusso. Il protocollo "vero" è probabilmente *un'infrastruttura di agenti
cross-chain con consenso esplicito*, su cui si possono costruire applicazioni
diverse (oggetti, eredità, group buying, coordinazione DAO). Nessun design finale
è stato fissato.

---

## File da aprire per primi

- [`site/index.html`](site/index.html) — apri in browser per vedere il sito marketing
- [`site/ui.html`](site/ui.html) — il prototipo dell'app
- [`docs/09-design-evolution.md`](docs/09-design-evolution.md) — la storia del perché

---

## Licenza

CC0 — fai quello che vuoi con queste idee. Non sono mai diventate un prodotto reale.

Costruito in conversazione tra un umano e Claude Opus 4.7, maggio 2026.
