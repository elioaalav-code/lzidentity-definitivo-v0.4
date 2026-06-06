# 09 — Independent Audit of v0.5 "Refined"

Read-only review by an independent Opus auditor. Scope: the integrated v0.5 in the
worktree, against the MASTER-PLAN (00), the per-lane research (01–08), and the four
integration deltas (`integration/*.md`). No code was modified.

---

## Executive summary

The FOUNDATION pass largely held up: design tokens are correct and WCAG-compliant, the
shared `ui.js` primitives (modal focus-trap, `emptyState`, `html`/`raw`, `escapeHtml`) are
sound, and the four build lanes integrated cleanly at the contract level — every
`window.LZ.*` / `window.LZUI.*` surface is present, no duplicate element IDs, no dangling
references to the deleted mock-chat symbols, and **all tests are green** (`node --check`
on all 30 JS files, signing-format 336/0, sigil 4873/0).

However, **two required integration deltas did not land**, and **two XSS sinks the master
plan set out to close were closed in some files but missed in others**:

- The **"honest quick-send"** (trading integration §1, marked **[REQUIRED]**) was *not*
  applied. `app.js` still ships the original fake-success `toast("signed · …")` with no
  real `eth_sendTransaction`, no address/amount validation, and no demo relabel. The
  dishonest-UX finding S7 from research/08 is therefore still live.
- **coin-page.js renders remote CoinGecko fields unescaped** (`md.name`/`md.symbol`/
  `md.id`) — the exact XSS class the FOUNDATION pass fixed in app.js markets but missed in
  the coin detail header.
- Both **deferred items are confirmed deferred**: `cm:priv` is still persisted to
  localStorage, and there is **no CSP** in either HTML file.

The SECURITY-critical new code (chat-nostr.js NIP-04 decrypted content, governance/
communities relay data) **is** correctly escaped — the crown-jewel injection vector is
clean. The main blockers are the unescaped coin-page header and the un-shipped honest send;
the main HIGH items are the relay-subscription leak and the deferred CSP/key items.

**Verdict: GO-WITH-FIXES.** No unrecoverable design faults; the must-fix list is small and
surgical.

---

## Test / check results (run by the auditor)

| Check | Result |
|---|---|
| `node --check assets/js/*.js` (all 30 files) | **PASS** — every file OK |
| `node tests/signing-format.test.mjs` | **336 passed, 0 failed** ✓ HL wire-format intact |
| `node tests/sigil.test.mjs` | **4873 passed, 0 failed** ✓ seedFromNpub v1 freeze + v2 traits + fingerprint |
| Duplicate element IDs in `app.html` | **none** (`grep … | uniq -d` empty) |
| Dangling mock-chat symbols in `app.js` (`CONVS`/`THREADS`/`renderChatList`/`renderThread`/`sendChatMsg`/`activeConv`/`composeLayer`) | **none** |
| `window.LZ.*` surfaces (nostr, gov, communities, communityAdd, chatNostr, hl, coinPage, fmt, net, motion) | **all present** |
| `window.LZUI.*` surface (modal, emptyState, escapeHtml, html, raw, CustomSelect, …) | **present** (ui.js:640) |
| Sigil markup (`#sigilOrb role=img`, `#sigilFp`, `#sigilShare`, `.sigil-bloom`) + wiring (`reflectSigil`, `exportSigil`/`shareSigil`/`fingerprint`, forming/ignite) | **integrated** |
| chat-nostr.js / chat-nostr.css loaded in app.html | **yes** (lines 39, 737) |
| Assistant model id `claude-sonnet-4-6` | **valid & current** per Anthropic catalog — no finding |

---

## Severity-ranked findings

| # | Sev | File:line | Finding | Concrete fix |
|---|-----|-----------|---------|--------------|
| A1 | **BLOCKER** | `assets/js/coin-page.js:374-376,386` | Remote CoinGecko `md.name`/`md.symbol`/`md.id` (from `/api/v3/coins/:id`) are interpolated into `innerHTML` **unescaped**. An `esc()` helper exists at line 303 but is not applied. Same XSS class the plan closed in app.js markets; missed here. | Wrap each remote field: `${esc(md.name || md.id)}`, `${esc(md.symbol || "")}`, `#${esc(md.market_cap_rank)}` (numeric, low-risk but consistent). |
| A2 | **BLOCKER (honesty/integration)** | `assets/js/app.js:368-377` + `app.html:235` | The **REQUIRED** honest quick-send (trading integration §1) was never applied. The button still fires `toast("signed · {amt} {asset} → {to}", "ok")` with **no real tx and only non-empty validation** — it tells the user funds "signed" when nothing happened (research/08 finding S7). | Apply trading integration §1 — Option A (relabel to "isn't wired … use your wallet app" + demo note in app.html, the minimum) or Option B (real native-ETH `eth_sendTransaction` with `/^0x[0-9a-fA-F]{40}$/` address check + `Number(amt) > 0` amount check, as specified). |
| H1 | **HIGH** | `assets/js/chat-nostr.js:401` + `assets/js/app.js:909` | **Relay-subscription leak.** `init()` does `S.sub = S.pool.sub([...{limit:200}…])` on every chat-route entry **without `unsub`-ing the prior `S.sub`**. `ONROUTE.chat` calls `init()` but `teardown()` is never called — app.js has **no onLeave/onLeave-registry** (`setActive` only invokes `ONROUTE[route]()`), contrary to the integration note's optional onLeave hook. Each chat visit stacks an orphaned REQ + 200-event refetch on the pool; `seen` Sets and `S.convs` grow unbounded. | At the top of `init()` (before re-subscribing), unsub the prior: `if (S.sub != null && S.pool?.unsub) { try { S.pool.unsub(S.sub); } catch{} S.sub = null; }`. Better: add an onLeave registry in `app.js setActive` and call `window.LZ?.chatNostr?.teardown()` on chat exit (the integration delta §3c anticipated this). |
| H2 | **HIGH (deferred — see recommendation)** | `assets/js/shared.js:86,98` | `cm:priv` (32-byte Nostr secret) still written to and rehydrated from `localStorage`. XSS-exfiltratable. The P0 S1 fix was deliberately deferred. | See "Deferred item (a)" below — recommendation is to move to in-memory + re-derive. |
| H3 | **HIGH (deferred — see recommendation)** | `app.html`, `index.html` (head) | **No Content-Security-Policy** and no SRI/importmap anywhere. With `cm:priv` (H2) and the Anthropic key (M3) in localStorage, one injected script reads everything. crypto still hot-loaded from `esm.sh` unpinned (`shared.js:9-11`). | See "Deferred item (b)" below for a concrete, paste-ready CSP. |
| M1 | **MED** | `assets/js/governance.js:1093` (and 1078/1079 context) | `href="${esc(p.url)}"` for Snapshot/governor proposal links. `esc()` escapes quotes but does **not** block a `javascript:` scheme. `p.url` is template-constructed for the common paths, but the Snapshot adapter falls back to `node?.link` (raw relay/GraphQL field, governance.js:666). Low likelihood (requires malicious Snapshot space metadata), real on-click XSS. | Scheme-validate before rendering: only emit the `<a>` if `/^https?:\/\//i.test(p.url)`; otherwise drop the link. |
| M2 | **MED** | `assets/js/app.js` (network-stream) / `assets/js/pillars.js:483-498` | Background intervals are now **work-gated** (network stream gates on `streamPaused||document.hidden||!active` at app.js:630; pillars feed + last-test gate on `recoveryActive()` = `!hidden && recovery active`). Good — this resolves the *work* half of research P2. Residual: the timers still *tick* (14s/5s/2.2s) on hidden tabs; cheap but not zero. | Acceptable as-is; optional: `clearInterval` on `lz:route` leave + `visibilitychange` to also stop the wakeups. |
| M3 | **MED (accepted)** | `assets/js/assistant.js:45,648-650` | Anthropic API key in `localStorage`, sent browser-direct with `anthropic-dangerous-direct-browser-access`. This is intentional BYOK; `ensureKeyWarning()` (line 1074) appears to add the in-UI warning research/08 asked for. | Acceptable for a personal BYOK tool given the visible warning. Optional: `sessionStorage` so it clears on tab close. |
| L1 | **LOW** | `assets/js/wallet-actions.js:832,874-879` | LI.FI `transactionRequest.to/data` forwarded to the wallet; review modal shows route/amounts, not the resolved `to`/spender. Mitigated by the wallet confirmation. | Optional: surface the resolved `to`/spender in `renderReview`. |
| L2 | **LOW** | `assets/css/sigil.css` etc. | `--short` (#e0556b) is 5.51:1 on `--bg`; comfortably AA on the near-black background, but only ~3–4:1 if ever placed on the lighter `--surface`. | Keep long/short text on dark surfaces only; fine as used. |

### Accessibility (WCAG 2.2 AA) — verified

- **Contrast (computed):** `--text-mute #8a8a94` = **5.96:1** (old #6b6b75 was 3.87 — fail; the
  lightening fix is real), `--text-dim` = 7.85:1, `--long #3fb98a` = 8.27:1, `--short #e0556b`
  = 5.51:1, all on `--bg #050505`. **All pass AA** for normal text.
- **focus-visible:** global rule `:focus-visible{outline:2px solid var(--focus-ring)…}` in
  base.css:214 — universal coverage; `--focus-ring` is contextual (overridable per region). ✓
- **Modal focus-trap (ui.js modal):** correct — sets sibling `inert`, traps Tab/Shift-Tab on
  the panel, restores focus to opener, closes on Esc/backdrop/✕, reduced-motion aware. ✓
- **Sigil ARIA:** `#sigilOrb role="img"` with a live-updated `aria-label` (forms fingerprint
  `fp.short`); `#sigilCanvas aria-hidden`; `#sigilFp` toggles `aria-hidden`. ✓
- **CustomSelect / tabs:** combobox/listbox roles, `aria-expanded`, `aria-activedescendant`,
  `aria-selected`, full keyboard nav (Arrow/Home/End/Enter/Esc) in ui.js. ✓
- **Reduced-motion:** sigil bloom/ignite are CSS-guarded (`@media (prefers-reduced-motion)`
  → `animation:none`, `.sigil-bloom{display:none}`, FP/share still appear via opacity);
  motion.js gates tween/reveal/magnet/view-transition on `reduced()`. chat-nostr/governance
  have only trivial transitions. ✓

---

## Deferred item (a) — `cm:priv` in localStorage: evaluate

**Current state.** `shared.js` writes the derived Nostr secret to `localStorage` (`deriveNostr`
line 86) and rehydrates it on boot (`bootstrapWallet` line 98). It is invalidated correctly on
`accountsChanged`/disconnect.

**Reduced XSS surface in v0.5.** The mock chat that interpolated relay-shaped data into
`innerHTML` is gone; chat-nostr.js, communities.js, governance.js all escape uniformly. So the
*in-app* injection sinks that could read `localStorage` are materially fewer than in v0.4 —
the remaining sinks are A1 (coin-page) and M1 (gov link), both fixable. **But** the secret is
still readable by any script on the origin, there is **no CSP** (H3), and crypto is loaded
from `esm.sh` unpinned (a supply-chain path straight to the secret). 

**Recommendation: MOVE IT — do not accept.** The reduced sink count lowers probability, not
impact: a single XSS or a tampered `esm.sh` response still yields full Nostr-signing authority
forever (no expiry). The fix is cheap and the derivation is already deterministic:
- Keep only `cm:npub` (public) in `localStorage`; hold `priv` in `state.derived.priv`
  (in-memory) only.
- On boot, if `npub` is stored, show "re-unlock" affordance; re-derive `priv` via one
  `personal_sign` (the message is fixed, `shared.js:46`) — output is byte-identical, so no
  contract breaks.
- If the one-sign-per-reload UX is judged too heavy, fall back to `sessionStorage` (clears on
  tab close) as a strictly-better interim. Pairing this with H3's CSP gets most of the value.

This is a HIGH, not a BLOCKER: it requires a *separate* injected-script foothold to exploit,
and v0.5 reduced those footholds. Ship v0.5 with H3 (CSP) as the higher-leverage first move,
and land the in-memory/`sessionStorage` change in the immediate follow-up.

## Deferred item (b) — no CSP: concrete recommendation

Ship a `<meta http-equiv="Content-Security-Policy">` in `app.html` **and** `index.html` head.
The following enumerates every origin actually referenced in the codebase (verified by grep),
allows the data:/blob: the sigil + canvas exports need, and the inline styles the modules set:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' https://esm.sh;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: https://assets.coingecko.com https://coin-images.coingecko.com;
  connect-src 'self'
    https://esm.sh
    https://api.coingecko.com https://api.alternative.me
    https://api.anthropic.com https://li.quest
    https://api.hyperliquid.xyz https://api.hyperliquid-testnet.xyz
    https://app.hyperliquid.xyz https://hyperliquid.gitbook.io
    https://api.llama.fi https://stablecoins.llama.fi https://yields.llama.fi
    https://hub.snapshot.org https://seq.snapshot.org https://snapshot.org
    https://layerzero.foundation
    https://eth.blockscout.com https://arbitrum.blockscout.com https://base.blockscout.com https://optimism.blockscout.com
    https://etherscan.io https://arbiscan.io https://basescan.org https://optimistic.etherscan.io https://polygonscan.com
    https://ethereum-rpc.publicnode.com https://arbitrum-one-rpc.publicnode.com https://base-rpc.publicnode.com https://optimism-rpc.publicnode.com
    wss://api.hyperliquid.xyz wss://api.hyperliquid-testnet.xyz
    wss://relay.damus.io wss://nos.lol wss://relay.primal.net wss://relay.snort.social;
  worker-src 'self' blob:;
  object-src 'none';
  base-uri 'self';
  form-action 'none';
  frame-ancestors 'none';
">
```

Notes that keep this from breaking the app:
- **`script-src 'self' https://esm.sh`** — no `'unsafe-eval'`, no `'unsafe-inline'`; all JS is
  external ES modules. The `@noble`/`@scure` dynamic imports resolve from `esm.sh`. (Pair with
  S5/SRI later by vendoring `@noble`/`@scure` into `assets/vendor/` and dropping `esm.sh` from
  `script-src`.)
- **`style-src 'unsafe-inline'`** — required: ui.js/sigil set inline `style.cssText`/CSS vars
  extensively. Removing it needs a refactor; keep it for now.
- **`img-src … data:`** — the generative-grain SVG and coin badge data: URIs. CoinGecko coin
  images come from `assets.coingecko.com` / `coin-images.coingecko.com`.
- **`worker-src blob:` / canvas exports** — sigil PNG export uses `canvas.toDataURL` (data:,
  not blob:) so `img-src data:` covers `<a download>`; `blob:` in `worker-src` is belt-and-
  suspenders for any future blob export. No `connect-src blob:` needed.
- **No Google Fonts in `script-src`** — fonts are CSS/font only (`googleapis`/`gstatic`).

This is the single highest-leverage mitigation and gates the value of the H2 key fix.

---

## Regression check vs v0.4 — PASS

Element IDs, `data-view`/`data-route`, HL signing wire-format (336/336), `deriveNostr()`
determinism (sigil tests pass, derivation untouched), and all `window.LZ.*`/`window.LZUI.*`
surfaces preserved. The mock-chat deletion is clean. The eager-load of 26+ JS / 25+ CSS is
unchanged — noted as the known **P2** from research/08 (not addressed this pass, acceptable
for a no-build app; route-level dynamic `import()` is the documented backlog item).

---

## Verdict: **GO-WITH-FIXES**

Merge **after** the two BLOCKERs are fixed. The HIGHs should be scheduled immediately after
(H3 CSP first as the highest-leverage single change, then H1 leak, then H2 key relocation).

### Must-fix before merge (BLOCKER)
1. **A1** — escape remote CoinGecko fields in `coin-page.js:374-376,386` (apply existing `esc()`).
2. **A2** — apply the honest quick-send (trading integration §1, at minimum Option A relabel)
   in `app.js:368-377` + `app.html:235`; the current build claims a transfer "signed" that
   never happened.

### Fix immediately after merge (HIGH)
3. **H3** — add the CSP above to `app.html` and `index.html`.
4. **H1** — unsub the prior relay subscription in `chat-nostr.js init()` (and wire
   `teardown()` on chat-route leave) to stop the per-visit subscription/event leak.
5. **H2** — move `cm:priv` out of `localStorage` (in-memory + re-derive, or `sessionStorage`
   interim).
