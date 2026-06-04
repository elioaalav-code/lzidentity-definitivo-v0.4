# 01 · Overview (v1)

## L'idea in una frase

> Ogni indirizzo on-chain ha **una sola "Anima"** — un'entità soulbound, indivisibile,
> che esiste **simultaneamente su ogni chain** grazie ai messaggi LayerZero, e che
> fonde reputazione, intenti e un agente AI personale in un unico oggetto on-chain.

## I tre pilastri originali

### 1. Karma — reputazione a somma zero, globale
Hai 1.000 punti di Karma. Sono *gli stessi* su Ethereum, Base, Arbitrum, Solana, Aptos.
Li spendi su Optimism per saltare la coda di un mint → un attimo dopo ne hai 950
anche su Sui. La prima risorsa scarsa veramente cross-chain.

### 2. Doppelgänger — l'agente AI personale
La tua Anima ospita un piccolo agente AI che osserva ogni tua azione su ogni chain.
Mentre dormi, negozia, vota nelle DAO, fa rebalance, accetta airdrop. I Doppelgänger
di utenti diversi possono *parlarsi* via LayerZero e chiudere trade atomicamente
cross-chain.

### 3. Soglia — il testamento omnichain
Imposti una volta sola un "testamento omnichain". Se la tua Anima resta inattiva
per N giorni — non su una chain, ma **su tutto il multichain** — si attiva una
cascata coreografata: asset migrati, NFT trasferiti, frasi segrete time-locked
rilasciate.

## Perché solo LayerZero
- Reputazione globalmente coerente richiede consenso di stato cross-chain → ULNs di LZ
- Gli agenti che si parlano tra chain richiedono messaging arbitrario, non solo bridging
- Il testamento atomico cross-chain richiede una primitiva di *commit-or-abort*
  multichain — esattamente ciò che LZ V2 abilita con i composer

## Stato del design

Questo è il design come è stato originariamente concepito. È stato poi criticato
e abbandonato — vedi [`09-design-evolution.md`](09-design-evolution.md).
