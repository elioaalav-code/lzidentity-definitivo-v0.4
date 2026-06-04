# 02 · Whitepaper tecnico (v1)

## 2.1 Architettura dei contratti

```
                   ┌─────────────────────────────────┐
                   │      AnimaRegistry (Hub)        │
                   │   deployed: every supported     │
                   │   chain — stesso address (CREATE2)│
                   └────────────────┬────────────────┘
                                    │ inherits
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
         ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
         │ KarmaLedger │    │ Doppel-     │    │ Threshold    │
         │ (OApp)      │    │ gangerHub   │    │ Vault (OApp) │
         │             │    │ (OApp)      │    │              │
         └─────────────┘    └─────────────┘    └──────────────┘
                │                   │                   │
                └───────────────────┼───────────────────┘
                                    ▼
                          ┌──────────────────┐
                          │  LayerZero V2    │
                          │  Endpoint + DVNs │
                          └──────────────────┘
```

### Contratti chiave

| Contratto | Tipo LZ | Responsabilità |
|---|---|---|
| `AnimaRegistry` | OApp | Mint dell'Anima (1-per-EOA via signature). Mantiene il *root* dell'identità. |
| `KarmaLedger` | OApp + Merkle | Saldo Karma autoritativo. Pubblica `KarmaDelta` events. |
| `DoppelgangerHub` | OApp | Inbox/outbox messaggi tra agenti. Encoding ABI-tipato per *intents*. |
| `ThresholdVault` | OApp + composer | Custodia asset + esecuzione testamento. |
| `ChainConductor` | LZ Composer | Orchestrazione atomica multi-chain (commit-or-revert). |

## 2.2 Modello di stato del Karma

Karma deve essere **globalmente coerente** ma evitare round-trip LZ per ogni spesa.
Soluzione: pattern **"Optimistic Local, Eventually Global"**

```
Saldo locale (chain X) = SaldoLastSync − Spese pending locali
                       + Crediti arrivati via LZ
```

1. Ogni chain ha un *budget locale* del Karma totale dell'utente (default: 20%)
2. Spese < budget locale → istantanee (no LZ)
3. Spese > budget locale → richiedono "Karma Pull" via LZ (latenza ~30s)
4. Sync periodico (ogni ora o on-demand) tramite `lzReceive` ribilancia i budget

**Anti double-spend**: ogni `spendKarma()` consuma un nonce monotonicamente crescente
firmato dall'utente. Il `KarmaLedger` su ogni chain mantiene `lastSeenNonce[chainId]`.
I messaggi LZ trasportano `(nonce, delta, sourceChain)`.

## 2.3 Message flow: Doppelgänger trade cross-chain

```
Alice (Base)                       Bob (Arbitrum)
    │                                   │
    │  1. publishIntent("SELL 100 USDC  │
    │     for 0.025 ETH on any chain")  │
    ├──────► DoppelgangerHub (Base)     │
    │              │                    │
    │              │ 2. lzSend(broadcast intent)
    │              ├───────────────────►│  DoppelgangerHub (Arbitrum)
    │              │                    │        │
    │              │  3. Bob's agent matches intent
    │              │                    │        │
    │              │   4. lzSend(commit) │       │
    │              │◄───────────────────┤        │
    │              │                    │        │
    │     5. ChainConductor.lockEscrow(Alice's USDC)
    │              │                    │        │
    │              │   6. lzSend(escrow_locked) ►│
    │              │                    │ 7. Bob's ETH locked
    │              │                    │        │
    │              │   8. lzSend(both_locked, settle) ◄──┤
    │              │                    │        │
    │              │  9. Atomic swap commit + emit Receipt
    │◄─────────────┤                    ├───────►│
```

Garanzia: o entrambi gli escrow eseguono, o entrambi si sbloccano dopo
`timeout = 3 × LZ_finality`.

## 2.4 Threat model

| Minaccia | Mitigazione |
|---|---|
| **DVN compromesso** | Multi-DVN config: 2-of-3 (LayerZero Labs + Google Cloud + utente-scelto) |
| **Karma double-spend via chain riorg** | Spese richiedono finalità della source chain prima di propagare |
| **Doppelgänger malicious / poisoned intent** | Tutti gli intent limitati da `MaxSlippage` e `MaxKarmaSpend` utente |
| **Sybil su Karma earning** | Karma proviene solo da azioni *costose*: `karma = log(gas_burned) × diversity_bonus(chains)` |
| **Threshold attivato per errore** | Grace period 7 giorni con notifiche cross-chain. Override richiede signature originale |
| **Stato divergente tra chain** | Sync forzata ogni 24h; sospensione spese se drift > 5% |
| **Censura via DVN** | Fallback path manuale: utente può sottomettere proof Merkle direttamente |

## 2.5 Stack consigliato

- **Smart contracts**: Solidity 0.8.26, Foundry, LayerZero V2 OApp template
- **Indexer**: Envio / Ponder (multi-chain nativi)
- **Doppelgänger runtime**: Python + Claude API (decisioni) + ethers.js (esecuzione)
- **Frontend**: Next.js, wagmi, viem, Rainbow Kit
- **Storage off-chain**: IPFS per memoria del Doppelgänger; cifratura threshold con Lit Protocol
- **Account Abstraction**: ERC-4337 per gas sponsorship cross-chain
