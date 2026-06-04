# 03 · Contracts overview (v1)

I tre contratti core, in versione semplificata, sono in [`/contracts`](../contracts/):

- [`KarmaLedger.sol`](../contracts/KarmaLedger.sol) — OApp che gestisce il saldo
  Karma con pattern *Optimistic Local, Eventually Global*. Spese locali < budget
  sono istantanee; spese maggiori innescano un "pull" cross-chain via LayerZero.

- [`DoppelgangerHub.sol`](../contracts/DoppelgangerHub.sol) — OApp per il matching
  di intent tra agenti. Gli intent sono pubblicati come commitment hash per evitare
  front-running; si rivelano solo al momento del match atomico.

- [`ThresholdVault.sol`](../contracts/ThresholdVault.sol) — OApp + composer per il
  testamento omnichain. Inattività multichain → grace period → distribuzione
  atomica.

Tutti i contratti sono illustrativi (NON audited, NON deploy-ready). Mancano:

- `AnimaRegistry` (mint dell'Anima, signature verification)
- `ChainConductor` (composer per orchestrazione atomica)
- Setup completo dei peer LZ (`setPeer` per ogni chain remota)
- Gestione admin / ownership / pause
- Test invariant Foundry completi
