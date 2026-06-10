# Security Audit — LZidentity (v0.5 / branch `main`)

> Audit AI strutturato (metodo SCOPE→FAN-OUT→TRIAGE→REPORT). Personal-use,
> codice di proprietà dell'autore. Data: 2026-06-08. Commit auditato: `main`
> (= `v0.5`, "Discover: richer cards…").
> **Questo audit NON è la parola finale.** Vedi §"Da verificare a mano".

---

## 1 · Sommario esecutivo

LZidentity è una dApp **buildless** (HTML/CSS/JS, nessun bundler) con identità
EVM→Nostr, trading reale su Hyperliquid (firma EIP-712/L1-action dal browser),
un copilot Claude, e 3 contratti Solidity **non deployati**.

La notizia buona: **la Content-Security-Policy è buona** (`index.html:7-31`,
`app.html:7-31`): `script-src 'self' https://esm.sh` **senza `'unsafe-inline'`**,
`connect-src` con allowlist stretta, `object-src 'none'`, `base-uri 'self'`,
`form-action 'none'`. Questo **neutralizza la maggior parte degli XSS** trovati
dai passaggi per-componente: gli handler inline (`onerror=`), gli URI
`javascript:` e gli `<script>` inline **non eseguono**. Diversi finding
"CRITICAL" dei sotto-agenti sono quindi **declassati** una volta considerata la
CSP — la calibrazione qui sotto ne tiene conto.

Il rischio reale più materiale è la **supply-chain**: le librerie crittografiche
che derivano la chiave Nostr e firmano gli ordini Hyperliquid sono caricate da
`esm.sh` **senza SRI**, ed `esm.sh` è whitelisted nella CSP — è l'unico vettore
che *buca* la CSP e tocca direttamente le chiavi.

### Tabella finding

| ID | Severità | Componente | Titolo | Stato |
|----|----------|-----------|--------|-------|
| **H1** | **High** | App shell / crypto | Librerie di firma/derivazione da `esm.sh` senza SRI (bypassa la CSP) | Confermato (lettura codice) |
| **M1** | Medium | Identità | Chiave privata Nostr persistita in `localStorage` | Confermato |
| **M2** | Medium | Coin-page / router | Dati esterni + route param non escapati in `innerHTML` | Confermato (impatto limitato dalla CSP) |
| **M3** | Medium | Coin-page | Schema URL non validato in `href` (`javascript:`) | Confermato (mitigato dalla CSP) |
| **L1** | Low | Hyperliquid | Indice asset non validato nel range `[0, universe)` | Confermato |
| **L2** | Low | Trade | Possibile doppio invio ordine su doppio click | Confermato (mitigazioni presenti) |
| **L3** | Low/Info | Assistant | Prompt-injection può pre-compilare un ordine fuorviante | Confermato (firma utente obbligatoria) |
| **K1** | ⚠ Non deployare | Contratti | I 3 contratti Solidity sono scheletri illustrativi, non sicuri | Confermato |
| FP1 | Falso positivo | Communities | `javascript:`/`data:` in `<img src>` non esegue | Scartato |
| FP2 | Falso positivo | Assistant | `mdLite` escapa prima del markdown → niente XSS | Scartato |

---

## 1.5 · Stato dei fix (branch `worktree-security-audit-v0.5`)

Applicati in questo branch (oltre a un **bug funzionale** scoperto durante i fix):

| ID | Stato | Cosa è cambiato |
|----|-------|-----------------|
| 🐞 **BUG Identity** | ✅ Risolto | `@noble/secp256k1@2.1.0` **non esporta più `schnorr`** (rimosso in v2) → `schnorr` era `undefined` e **ogni derivazione Nostr falliva dopo la firma**. Ora `schnorr` arriva da `@noble/curves`. Causa-radice del "se firmo non funziona". |
| **H1** | ✅ Risolto | Librerie crypto **vendorizzate** in `assets/vendor/crypto.js` + `msgpack.js` (build esbuild, self-contained). Rimosso `esm.sh` da `script-src` e `connect-src` in entrambi gli HTML. Niente più CDN nel percorso di firma. |
| **M1** | ✅ Mitigato | Validazione formato (`/^[0-9a-f]{64}$/`) della priv key in rilettura da storage; storage corrotto viene scartato; corretto il commento fuorviante "session key". |
| **M2** | ✅ Risolto | `esc()` applicato a `chain`, `dl.category`, route `id` in `coin-page.js`. |
| **M3** | ✅ Risolto | Nuovo helper `safeUrl()` (solo http/https) su `href` di homepage/explorer. |
| **L1** | ✅ Indurito | Guardia su forma di `meta()` + `szDecimals` numerico prima della costruzione ordine. |
| **L2** | ✅ Risolto | Flag in-flight `placing` in `confirmOrder()` blocca il doppio invio durante la firma (preserva il retry dopo un rifiuto). |
| **L3** | ◻ Lasciato | `prefillOrder` solo-riempie (già sicuro); nessuna modifica necessaria. |
| **K1** | ◻ Non toccato | Contratti illustrativi: da riscrivere quando si va on-chain (fuori scope di questo branch). |

**Verifica:** bundle vendorizzato testato in Node (npub identico al previsto,
schnorr sign/verify OK, ECDH/keccak/msgpack OK); syntax-check esbuild su tutti i
file modificati; app servita staticamente con tutte le risorse a 200 e CSP senza
`esm.sh`. Test in browser reale con wallet ancora **da fare a mano** (vedi §5).

---

## 2 · Finding

### H1 · [High] Crypto di firma e derivazione caricata da CDN senza integrità (SRI)

**File:** `assets/js/shared.js:9-11`, `assets/js/nostr.js:24-28`,
`assets/js/hyperliquid.js:19-20`. CSP: `index.html:9`, `app.html:9`.

```js
// shared.js
({ schnorr } = await import("https://esm.sh/@noble/secp256k1@2.1.0"));
({ sha256 }  = await import("https://esm.sh/@noble/hashes@1.4.0/sha256"));
({ bech32 }  = await import("https://esm.sh/@scure/base@1.1.6"));
// hyperliquid.js
import { encode as msgpackEncode } from "https://esm.sh/@msgpack/msgpack@2.8.0";
import { keccak_256 } from "https://esm.sh/@noble/hashes@1.4.0/sha3";
```

**Impatto.** Queste librerie eseguono: la derivazione della chiave privata Nostr
(`schnorr`, `sha256`, `bech32`) e la firma degli ordini Hyperliquid
(`msgpack` + `keccak_256`). Sono caricate da `esm.sh` **senza Subresource
Integrity**, ed `esm.sh` è esplicitamente permesso in `script-src` (`index.html:9`).
Se `esm.sh` viene compromesso (o un attaccante riesce a interporsi), una versione
malevola di `@noble/secp256k1` può: esfiltrare la firma del wallet (da cui si
deriva l'intera identità Nostr), rigenerare la chiave privata, o **alterare il
payload di un ordine prima della firma**. È l'unico vettore che bypassa la CSP,
perché la CSP stessa whitelista `esm.sh` per gli script e per le connessioni.
La crittografia in sé è corretta (librerie `@noble` auditate, IV da
`crypto.getRandomValues`) — il problema è *come* viene caricata.

**Stato conferma:** Confermato per lettura del codice + CSP.

**PoC (concettuale, NON contro sistemi live).** Un modulo `esm.sh` sostituito
che fa `fetch`/beacon della firma: `img-src https:` permette un beacon immagine
verso qualunque host https, quindi l'esfiltrazione passa anche con la CSP.

**Fix proposto.**
1. **Vendora le librerie localmente** in `assets/vendor/` (come è già fatto per
   `lightweight-charts`) e importa da `/assets/vendor/...`. Poi togli `esm.sh`
   da `script-src` e `connect-src`. È la soluzione più solida per una dApp che
   firma transazioni.
2. In alternativa, se resti su CDN: usa un **import map con hash di integrità**
   e pinna versioni esatte; ma l'SRI sugli ES module import è ancora poco
   supportato → preferisci il vendoring.

---

### M1 · [Medium] Chiave privata Nostr persistita in `localStorage`

**File:** `assets/js/shared.js:86` (scrittura), `:94-98` (rilettura non validata).

```js
localStorage.setItem(LS.PRIV, state.derived.priv);   // :86
// :94
const savedPriv = localStorage.getItem(LS.PRIV);
```

**Impatto.** La chiave privata Nostr (hex) è salvata in `localStorage`, quindi
**persistente** e leggibile da qualunque script nel contesto di origine (incluso
un modulo `esm.sh` compromesso — vedi H1). Il commento a `shared.js:21` la
descrive come "session key… never sent off-device", ma `localStorage` non è una
session key (sopravvive alla chiusura del tab) e il claim "never sent off-device"
dipende interamente dall'assenza di esecuzione di codice ostile. In rilettura
(`:94-98`) non c'è validazione di formato/lunghezza prima dell'uso in
`signEvent` (`nostr.js`).

**Stato conferma:** Confermato.

**Fix proposto.** Valuta `sessionStorage` (coerente col commento) o, meglio,
mantieni la chiave **solo in memoria** ri-derivandola dalla firma del wallet
quando serve (la derivazione è già deterministica). Se resta in storage, valida
il formato (`/^[0-9a-f]{64}$/`) in rilettura prima di usarla. Questo finding è un
**amplificatore**: riduce l'impatto di qualunque XSS o di H1.

---

### M2 · [Medium] Dati esterni e route param non escapati in `innerHTML`

**File:** `assets/js/coin-page.js:509` (`${chain}`), `:519` (`${dl.category}`),
`:539` (`Loading ${id}`). Sorgente route param: `assets/js/app.js:59-61`
(`decodeURIComponent(hash.split("/")[1])`, non sanitizzato).

```js
// coin-page.js:539 — id viene dall'hash dell'URL (link condivisibile)
root.innerHTML = `<div class="cp-loading">…Loading ${id || "coin"}…</div>`;
// coin-page.js:509 / :519 — chain e category vengono da DefiLlama (API esterna)
`<span class="cp-dl-chain-name">${chain}</span>`
`<span class="cp-dl-badge">${dl.category || "Protocol"}</span>`
```

**Impatto — onesto.** Sono dati non fidati inseriti in `innerHTML` senza
`esc()` (la funzione esiste ed è usata altrove nello stesso file → è una
dimenticanza puntuale). `id` è **attacker-controllabile** via link
`app.html#/coin/<img src=x onerror=…>`. **Tuttavia la CSP limita fortemente
l'impatto**: senza `'unsafe-inline'`, gli handler inline (`onerror`) e gli
`<script>` inline **non eseguono**, e gli script iniettati via `innerHTML` non
girano comunque per spec HTML. Quindi **non** è un furto-chiavi diretto. Resta:
**content/UI spoofing e phishing** (iniettare markup ingannevole nella pagina
coin condivisa), beacon immagine (`img-src https:`), e — soprattutto — il fatto
che la sicurezza dipende **al 100% dalla CSP**: un solo errore futuro nella CSP
(es. aggiungere `'unsafe-inline'`) trasforma questi punti in XSS pieno con furto
della chiave Nostr (M1).

**Stato conferma:** Confermato (sorgente e sink tracciati). Severità calibrata
considerando la CSP.

**Nota:** in `governance.js` (`:1162`, `:1171`) e `communities.js` i campi
esterni (title, body, nomi) **sono** passati per `esc()`/`escapeHtml()` → quei
punti sono **a posto** (i sotto-agenti li avevano segnalati come "rischio se il
codice cambia", non come vuln attuali).

**Fix proposto.** Applica `esc()` a `chain`, `dl.category` e `id` prima
dell'inserimento (`escapeHtml` è già importata). Difesa-in-profondità: non
affidare la sicurezza solo alla CSP.

---

### M3 · [Medium] Schema URL non validato in `href` (`javascript:`)

**File:** `assets/js/coin-page.js:336-337`.

```js
links.push(`<a class="cp-link" href="${esc(md.homepage)}" …>Website…</a>`);
links.push(`<a class="cp-link" href="${esc(md.explorer)}" …>Explorer…</a>`);
```

**Impatto.** `esc()` neutralizza i caratteri HTML ma **non lo schema**: un
`md.homepage = "javascript:…"` (da CoinGecko, API esterna) passa intatto in
`href`. Al click eseguirebbe JS — **ma** la CSP senza `'unsafe-inline'` blocca
la navigazione `javascript:`, quindi oggi è neutralizzato. Resta una cattiva
igiene (e un rischio se la CSP cambia o su user-agent non conformi).

**Stato conferma:** Confermato; mitigato dalla CSP.

**Fix proposto.** Valida lo schema: accetta solo `https:` (e magari `http:`)
con `new URL(...)` in un `try/catch`, altrimenti scarta il link.

---

### L1 · [Low] Indice asset Hyperliquid non validato nel range

**File:** `assets/js/hyperliquid.js:111-115` (`assetInfo`), usato a `:263/:279`.

`assetInfo` lancia se `i < 0` ma **non** verifica `i < universe.length`. Se
l'endpoint `/info` fosse compromesso e restituisse un indice fuori range,
l'ordine verrebbe costruito su un asset diverso da quello mostrato. Richiede
compromissione dell'API (la CSP `connect-src` limita a `api.hyperliquid.xyz`).
**Fix:** `require 0 <= i < universe.length` prima del return.

### L2 · [Low] Possibile doppio invio su doppio click

**File:** `assets/js/trade.js:873-902`, `assets/js/hl-orders-pro.js:879-902`.

Esistono già mitigazioni: `btn.disabled = true` (`trade.js:878`) e flag `busy`
(`hl-orders-pro.js:880`); inoltre Hyperliquid rigetta il nonce duplicato. La
finestra di race è stretta. **Fix (robustezza):** cattura e azzera
`pendingOrder` **prima** dell'`await`, così un secondo invio trova lo stato già
consumato.

### L3 · [Low/Info] Prompt-injection può pre-compilare un ordine fuorviante

**File:** `assets/js/assistant.js:136` (tool `prefill_order`),
`assets/js/trade.js:1295-1301` (implementazione).

`prefillOrder` **solo riempie il form** (side/type/size/price) e ricalcola il
notional — **non firma e non invia** (verificato a `trade.js:1295-1301`).
Quindi un dato ostile letto dal modello (es. un nome coin/contenuto Snapshot con
istruzioni) può, al massimo, far pre-compilare un ordine ingannevole, ma
**l'utente deve comunque firmare** nel wallet (passo umano obbligatorio).
**Fix (igiene):** nel modal di review mostra sempre i parametri canonici
dell'ordine così come saranno firmati; considera di marcare visivamente gli
ordini pre-compilati dall'assistant.

---

## 3 · Falsi positivi scartati (annotati, non buttati)

- **FP1 — `communities.js:552`** `src="${escapeHtml(prof.picture)}"` su `<img>`:
  un URI `javascript:`/`data:` in `img src` **non esegue script** nei browser →
  niente XSS. `escapeHtml` impedisce il break-out dell'attributo. Non è una vuln.
- **FP2 — `assistant.js:711` + `mdLite` (`:262-267`)**: `mdLite` chiama
  `escapeHtml(s)` **prima** di applicare le regex markdown, quindi
  `**<img onerror=…>**` diventa `<strong>&lt;img…&gt;</strong>` → niente HTML
  attivo. Il "bypass" ipotizzato non esiste.
- **CSS injection via `--comm-accent`** (`communities.js:172`): `setProperty`
  tratta il valore come singola custom property; un valore malformato viene
  ignorato, non si iniettano nuove regole né si esegue JS. Non sfruttabile.
- **governance.js `title`/`body`**: passati per `esc()` → già sicuri.

---

## 4 · Copertura

Matrice componenti × classi. `✓✓` = ≥2 passaggi (critici), `✓` = 1 passaggio,
`–` = non rilevante, `n/d` = non deployato.

| Componente | KeyExpo | FirmaCieca | XSS/DOM | InputAPI | Transport | SupplyChain | Race | AccessCtrl | CrossChain |
|-----------|:------:|:----------:|:------:|:--------:|:---------:|:-----------:|:----:|:----------:|:----------:|
| C1 Identità (shared/nostr/sigil) | ✓✓ | ✓✓ | – | – | – | (H1) | – | – | – |
| C2 Hyperliquid firma/ordini | ✓✓ | ✓✓ | – | ✓✓ | ✓ | – | ✓✓ | – | – |
| C3 Assistant | ✓ | ✓ | ✓ | – | ✓ | – | – | – | – |
| C4 Dati esterni (comm/gov/dao/coin/chat) | – | – | ✓✓ | ✓ | ✓ | – | – | – | – |
| C5 Client API (market/net/hl) | – | – | ✓ | ✓ | ✓ | – | – | – | – |
| C6 App shell / router / vendor | – | – | ✓ | – | ✓ | ✓ | – | – | – |
| C8/C9 Contratti (3) | n/d | – | – | ✓ | – | – | – | ✓✓ | ✓✓ |

**Gate di copertura:** nessuna cella rilevante è a 0; i componenti critici
(C1, C2, C4, contratti) hanno ≥2 passaggi. Buchi noti dichiarati: vedi §5.

---

## 5 · Da verificare a mano (obbligatorio — l'audit AI non è la parola finale)

1. **H1 — superficie esm.sh.** Confermare a runtime tutte le `import` da
   `esm.sh` (anche dinamiche) e decidere il vendoring. È il rischio #1.
2. **Robustezza CSP.** L'intera valutazione XSS (M2/M3) poggia sul fatto che la
   CSP non ha `'unsafe-inline'` in `script-src`. Verificare che **nessun host**
   serva la pagina con una CSP più permissiva (es. header server che sovrascrive
   il meta), e che `img-src https:` (beacon) sia accettabile come trade-off.
3. **Firma Hyperliquid byte-per-byte.** `hyperliquid.js` espone `selfTest()` che
   ricalcola un hash noto: eseguirlo nel browser e confermare `PASS`. Verificare
   a mano che il payload mostrato nel modal di review (`trade.js`) coincida
   esattamente con `orderWire` (`hyperliquid.js:279`) campo per campo (a,b,p,s,r,t).
4. **Precisione importi.** Verificare che `formatSize`/`formatPrice`
   (`hl-format.js`) non introducano differenze tra ciò che l'utente vede e ciò
   che firma su coin con molti decimali.
5. **Contratti (K1).** Non deployare gli scaffold attuali; quando si passa
   on-chain, rifare un audit dedicato (con `forge test` su copia locale) sul
   codice reale.

---

## 6 · Note di metodo

- Audit eseguito col metodo SCOPE→FAN-OUT→TRIAGE→REPORT (run multipli sui
  critici, prompt mirati 1 componente × 1 classe, verifica scettica con lettura
  diretta del codice).
- I sotto-agenti hanno prodotto diversi "CRITICAL"; il triage li ha **ricalibrati
  alla luce della CSP** e ha scartato 2 falsi positivi netti. Severità assegnate
  secondo: impatto reale considerando le mitigazioni esistenti, separando i
  rischi di fiducia/centralizzazione (contratti) dai bug per attaccanti esterni.
- Nessun exploit è stato eseguito contro sistemi live. I PoC sono concettuali o
  da eseguire su copia locale.
