# 04 · Doppelgänger Agent (v1)

Il Doppelgänger è l'agente AI personale legato a ogni Anima. Nella v1 era
progettato per agire autonomamente entro vincoli definiti.

## File correlati

- [`/agent/system-prompt.md`](../agent/system-prompt.md) — il system prompt completo
- [`/agent/tools.json`](../agent/tools.json) — 5 tool definitions per Claude API

## Memoria a tre strati (RAG)

```python
class AnimaMemory:
    """Tre strati di memoria, retrieval-augmented."""
    def __init__(self, anima_id: str):
        self.episodic   = PineconeIndex(f"anima-{anima_id}-episodes")
        self.semantic   = PineconeIndex(f"anima-{anima_id}-facts")
        self.procedural = JSONStore(f"prefs/{anima_id}.json")
```

- **Episodica**: ogni azione del Soggetto diventa un episodio indicizzato.
- **Semantica**: pattern persistenti estratti dagli episodi (es: *"il Soggetto
  preferisce Uniswap V3 a 1inch (12/12 trade ultimi 30gg)"*).
- **Procedurale**: preferenze esplicite, vincoli configurati.

Ogni notte, una *reflection pass* condensa episodi vecchi e aggiorna le
preferenze.

## Privacy

Tutta la memoria cifrata client-side con chiave derivata dall'Anima. Il server
vede solo embedding ciechi. Lit Protocol gestisce l'access control.

## Esempio di interazione agent-to-agent

Nel design v1, due Doppelgänger possono negoziare uno swap cross-chain senza
intervento umano:

```
ALPHA:  Vedo che vuoi 0.5 ETH contro 1500 USDC. Il mio Soggetto
        ne ha in surplus su Arbitrum. Possiamo fare a 2998
        USDC/ETH — sotto Uniswap, sopra il tuo limit.

BETA:   Conosco il tuo Soggetto di reputazione. Le sue ultime
        12 negoziazioni hanno avuto slippage medio di 0.04%.
        Mi fido. Procedi.

ALPHA:  Commit hash: 0x4e2... Lock escrow 0.5 ETH sulla mia
        side. Tu confermi 1500 USDC sul tuo. Settlement chain:
        Base. Timeout: 90s.

BETA:   Confermato. Eseguo.

[14 secondi più tardi]

ALPHA:  Done. Receipt: 0x9a1... Buona giornata, BETA.
```

## Nota retrospettiva

Questo esempio — due agenti che chiudono uno swap da $1500 senza che gli umani
ne sappiano niente — è esattamente ciò che è stato criticato nella v2.
"Se fanno danni che si fa?"

Nel design v2 (Consigliere), la stessa interazione richiederebbe:
1. Il Consigliere di Alice propone il trade ad Alice
2. Alice firma esplicitamente un *mandato singolo* per quel trade
3. Solo dopo, il Consigliere apre canale con quello di Bob
4. Anche Bob firma esplicitamente
5. I due eseguono il match già firmato da entrambi gli umani

Più lento, più sicuro, più onesto.
