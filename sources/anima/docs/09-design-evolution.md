# 09 · Design Evolution — la storia delle critiche

Questo è il documento più importante della repository. Racconta come un'idea
seducente è stata smontata da due critiche dell'utente e mai veramente
rimessa insieme.

---

## Punto di partenza · ANIMA v1

L'utente chiede: *"inventa un'app basata su LayerZero, stupiscimi."*

Risposta proposta: **ANIMA** — identità soulbound omnichain con tre pilastri:
**Karma** (reputazione globale), **Doppelgänger** (agente AI autonomo),
**Soglia** (testamento omnichain).

L'utente entusiasta accetta. Si producono in sequenza:
- Whitepaper tecnico
- Pitch deck di 10 slide
- Mockup UI
- Codice Solidity
- Tokenomics ($ANIMA, 1B supply)
- Roadmap 18 mesi
- Manifesto culturale
- Antologia di 5 storie
- Brand book
- Press release
- Sito marketing in HTML

Una valanga di deliverable, tutti coerenti con la visione iniziale.

---

## Prima critica · *"sembra social credit cinese"*

> *"non mi piace il modello karma, sembra di creare il credito sociale cinese, e poi l'anonimato è importante nelle blockchain"*

**La critica era giusta e sistemica.** Il design originale aveva due problemi
strutturali, non cosmetici:

1. **Reputazione globale visibile** — un punteggio che ti segue ovunque,
   leggibile da chiunque, usabile per gating ed esclusione. Esattamente il
   pattern del social credit.

2. **Violazione della pseudonimità** — il crypto nasce per dare sovranità
   tramite anonimato. Un'identità "soulbound" che collega tutta la tua
   attività on-chain in un unico oggetto pubblico ne è l'opposto.

**Cosa è stato proposto come riformulazione (v2):**

| v1 | v2 |
|---|---|
| Karma globale visibile | **Scrigno** — memoria privata cifrata client-side + attestazioni ZK opt-in |
| Doppelgänger autonomo | **Consigliere** — propone, aspetta firma, mai agisce da solo |
| Soglia | Soglia (invariata) |
| — | **Velo** — privacy attiva: route cross-chain per ridurre correlabilità |

Eliminati: classifica, tokenomics gamificata, intero pillar reputazionale,
narrativa pseudo-religiosa del *13° contratto*.

---

## Seconda critica · *"hai eliminato così tante cose che dobbiamo farlo nuovo"*

L'utente dice anche:
> *"i doppelgänger che si parlano tra loro e creavano mercato non era male,
> magari possono funzionare come agenti di vendita, di cose, magari se c'è
> un oggetto gli si può creare un NFT da abbinare, che ne so a una macchina
> o a un computer o qualsiasi altro e venderlo con uno storico tracciabile"*

**Risposta: pivot completo a VESTIGIA** — protocollo per la provenienza di
oggetti fisici con NFT inviolabili come storia.

| Vecchio | Nuovo (Vestigia) |
|---|---|
| Identità delle persone | Identità degli oggetti |
| Karma soulbound | Vestigium per oggetto (NFT history) |
| Doppelgänger | Mercante (agente di vendita) |
| Soglia per persone | Soglia per oggetti |
| — | Perizia (esperti certificati) |

Vantaggi: gli oggetti non hanno diritto alla privacy. Le persone restano
pseudonime. I problemi etici della v1 *spariscono naturalmente*.

---

## Terza critica · *"quella era una feature, non un protocollo"*

L'utente nota correttamente:
> *"vabbe quindi mo ci siamo incentrati sugli oggetti.. quella era una
> features.. non so"*

**Il bug del processo creativo è diventato visibile.** Per ogni feedback
specifico, il design è stato ribaltato totalmente — prima eliminando il Karma,
poi riducendo l'intero protocollo a una sua singola applicazione.

L'utente ha ragione: la vendita di oggetti era *un'applicazione possibile*
dell'idea originale degli agenti che parlano cross-chain, non l'intera idea.

---

## Stato attuale

Nessun design finale è stato fissato. L'analisi più sincera della conversazione
suggerisce che il protocollo "vero" forse è:

> **un'infrastruttura cross-chain dove ogni utente ha un agente AI personale
> che parla con altri agenti per coordinare azioni — sempre con consenso
> esplicito — e su cui si possono costruire applicazioni diverse**

Possibili applicazioni:
- Vendita di oggetti con provenienza (VESTIGIA come *un'app*)
- Eredità digitale (Soglia come *un'app*)
- Coordinazione DAO cross-chain
- Group buying / pooled purchases
- Matching di intent finanziari
- Attestazioni ZK opt-in (Scrigno come *un'app*)

L'utente è stato invitato a definire **quale problema** vorrebbe vedere risolto
prima di scegliere il design finale.

---

## Lezioni per chi disegna protocolli

1. **La prosa seducente nasconde idee fragili.** Il manifesto v1 era bellissimo
   e descriveva esattamente ciò che andava abbandonato.

2. **L'autonomia degli agenti è la frontiera etica.** Anche con vincoli, anche
   con threat model: se l'agente *agisce*, l'umano è responsabile per cose
   che non ha deciso. Questo è un problema, non un feature.

3. **La reputazione cross-chain è dual-use, sempre.** Quello che permette ad
   Aave di ridurti il collaterale è la stessa cosa che permette a un governo
   di escluderti dai servizi.

4. **Iterazione ≠ pivot.** Pivotare l'intero protocollo a ogni critica produce
   chaos. È meglio chiedere *"qual è il problema sotto?"* e ricostruire dal
   problema.

5. **Il processo "stupiscimi → ti stupisco" tende verso il barocco.** Più
   componenti, più features, più lore. È divertente. Spesso non è quello che
   serve.

---

## Cosa rimane di sicuro buono

Indipendentemente dal design finale:

- **L'idea della Soglia** (testamento digitale atomico cross-chain) è solida e
  utile in *qualsiasi* versione del protocollo. Mancano soluzioni reali al
  problema dell'eredità crypto. Questo lo risolve.

- **L'infrastruttura cross-chain via LayerZero** è la primitiva giusta — il
  problema non era mai quello, era cosa costruirci sopra.

- **L'idea di agenti AI personali** è valida, *se non agiscono autonomamente*.
  Come consiglieri/sentinelle/scribes ha senso. Come autonomi è pericoloso.
