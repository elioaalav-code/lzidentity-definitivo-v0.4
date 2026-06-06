# 07 — Trading, Markets, Coin Pages & Wallet Data (RESEARCH)

Scope: markets list/table, the trade view (order entry, leverage, order types, position/PNL,
depth chart, charts), coin detail page, portfolio/wallet balances, real-time refresh, error/empty/
loading states, number formatting, pro-trader UX & data density. Read-only research phase.

Baseline check: `node tests/signing-format.test.mjs` → **336 passed, 0 failed**. Any CREATE-phase
work must keep this green.

---

## 1. Current state (file:line)

The trading surface is already **unusually mature** — closer to a real perps DEX than a demo.

### 1a. Signing + HL client — `assets/js/hyperliquid.js` (432 ln)
- L1-action signing: msgpack → keccak → EIP-712 "Agent" typed-data → `eth_signTypedData_v4`
  (`hyperliquid.js:181-232`). Wire key order `a,b,p,s,r,t` is load-bearing and replicated everywhere.
- Built-in `selfTest()` against a fixed reference hash (`:193-205`), run at trade boot
  (`trade.js:109-114`) and logged to console — good guardrail.
- Mainnet default, persisted, with per-network asset-index reset + WS reconnect on toggle (`:22-44`).
- Order primitives: `placeOrder`, `cancelOrder`, `updateLeverage` (`:261-302`); advanced additive
  primitives `placeTrigger`, `placeOrders` (batch/bracket), `placeTwap` (`:359-432`).
- WebSocket bus with resubscribe/backoff/ping (`:130-177`). INFO endpoints cover meta, allMids,
  metaAndAssetCtxs, l2Book, clearinghouseState, openOrders, userFills, candleSnapshot.
- Wire formatting isolated + unit-tested in `hl-format.js` (37 ln).

### 1b. Trade view — `assets/js/trade.js` (1236 ln)
- TradingView lightweight-charts (vendored), candles + volume + EMA(9/21) overlays, crosshair OHLC
  readout, candle-close countdown, entry/liq price lines drawn on chart (`trade.js:556-726`).
- Live order book with depth bars, cumulative fill, spread (bps), bid/ask imbalance bar
  (`:433-510`); click a level to prefill limit price (`:499-510`).
- Order ticket: buy/sell, market/limit, leverage slider with bubble, size quick-chips
  (25/50/75/Max of withdrawable×lev), notional/margin/fee/est-liq readout (`:728-811`).
- Review→confirm modal with mainnet warning, signing micro-states, toasts (`:826-883`).
- Positions/orders/account tabs: uPnL, ROE, liq, aggregate uPnL, margin-usage bar, margin ratio,
  account leverage; close 50%/100% via reduce-only routed through the same review modal
  (`:968-1099`). Cancel-all (`:1073-1084`).
- Rich market switcher (CustomSelect): sectors, favorites (★), Top-volume group, live price/chg,
  search, bottom-sheet (`:162-275`).
- Polling: ctxs 10s, user 4.5s, funding/countdown 1s; skeleton on first user poll
  (`:285-298, :900-920`). Last coin/interval persisted (`:21-24`).
- `window.LZ.hl` API: `setCoin`, `prefillOrder`, getters (`coin/account/szDecimals/universe`),
  `refreshUser` (`:1211-1236`) — consumed by add-on modules and the AI copilot.

### 1c. Markets browser (in trade view) — `assets/js/hl-markets.js` (976 ln)
- Compact trigger bar (top movers + perps count + gainers/losers) → full-screen drawer
  with sortable columns (sym/last/24h%/vol/fund8h/OI), filter chips, sector chips, density toggle,
  keyboard nav, focus trap, in-place price-flash patching, 5s poll (`hl-markets.js`).

### 1d. Depth + tape — `assets/js/hl-depth.js` (908 ln)
- Canvas cumulative depth chart (zoom pills ±0.5/1/2/5%, persisted), live trades tape with
  side-color flash, Buys/Sells/All filter, capped rows. Visibility-gated, redraw on tab-show +
  ResizeObserver (`hl-depth.js:1-33`).

### 1e. Advanced orders — `assets/js/hl-orders-pro.js` (929 ln)
- Collapsible Advanced panel mounted under the ticket: TP/SL (with R:R + preview), Scale ladder
  (N orders, flat/ascending, GTC/ALO TIF, preview table), TWAP. All route through the signed
  primitives + a review→confirm step (`hl-orders-pro.js:1-90`).

### 1f. Portfolio analytics — `assets/js/hl-portfolio.js` (964 ln)
- KPI grid (incl. Today's PnL), per-coin realized-PnL bars, equity-curve SVG with tooltip + period
  pills, fills history table. Polls clearinghouse + fills every 6s while connected + visible.

### 1g. Coin detail page — `assets/js/coin-page.js` (647 ln) + `marketdata.js` (144 ln)
- Route `#/coin/<id>`, canvas chart with range pills (24h/7d/30d/90d/1y), CoinGecko+DefiLlama
  data, "Trade <SYM> on Hyperliquid" CTA → `navigate("trade")` + `setCoin` (`coin-page.js:407,459-463`).

### 1h. Markets *page* (separate from HL markets) — `app.js:504-707`
- `data-view="markets"` is a **CoinGecko top-100** table (price/24h/7d-spark/mcap), search +
  gainers/losers, KPIs from `/global`. Row → quick-actions menu (Trade on HL · open coin page).
- **Falls back to `DEMO_MARKETS` hardcoded data** when CoinGecko rate-limits (`app.js:525-547`),
  flagged with a "sample data" chip (`app.html:282`) + `is-demo` class — honest, but see gaps.

### 1i. Wallet — `app.js:300-502` + `app.html:185-246`
- Real on-chain balances via Blockscout v2 across ETH/ARB/OP/Base, RPC fallback (native+USDC),
  spam/dust filters, allocation strip by chain, token list with share bars (`app.js:337-473`).
- Quick-send card is a **toast-only mock** (`app.js:493-502`); tx history is an honest "needs an
  indexer" empty state (`app.js:468-471`). `walletRefresh` re-reads chain.

---

## 2. Gaps

**Real-time / data freshness**
- G1. Trade view positions/PnL poll every 4.5s via REST; no `webData2`/`userEvents`/`activeAssetCtx`
  WS subscriptions, so mark price and uPnL lag and the account panel jumps rather than streams.
- G2. Order book is capped at 11 levels (`trade.js:466`) and book/depth/tape are three separate
  l2Book/trades subscriptions per pane — fine, but no aggregation/grouping control (price tick size).
- G3. No funding/oracle in the book mid; spread shown but no microprice or last-trade direction dot.

**Markets page (app.js) vs HL markets duplication**
- G4. Two distinct "markets" experiences (CoinGecko spot table in `data-view=markets`, HL perps
  drawer in trade view) with different formatters, sector maps, fav logic and visual language.
  `sectorOf` is duplicated (trade.js `SECTORS`, hl-markets.js `sectorOf`) and inconsistent.
- G5. `DEMO_MARKETS` ships hardcoded prices ($92k BTC etc.); honest chip mitigates but it can show
  stale fake numbers for the whole table on a single rate-limit. No retry/backoff before falling back.
- G6. Markets page sparkline has no axis/tooltip; coin-page chart is richer — inconsistent depth.

**Order entry / pro UX**
- G7. Est. liquidation in the ticket is a first-order approximation ignoring maintenance margin
  (`trade.js:759-768`) — labelled, but can mislead at high leverage.
- G8. No order-confirmation skip toggle / no "post-only" or TIF selector on the *basic* ticket (only
  in Advanced). No slippage control for market orders (hardcoded 5%, `hyperliquid.js:253`).
- G9. No keyboard shortcuts in the trade view (buy/sell/focus-size), unlike the markets drawer.
- G10. No max-leverage guardrail messaging or margin-mode (cross/isolated) toggle in UI; leverage
  always cross (`trade.js:892`).

**Number formatting**
- G11. Price formatters are reimplemented in ~5 files (`trade.js pxStr`, `hl-markets.js fmtPx`,
  `hl-depth.js pxStr`, `hl-portfolio.js pxStr`, `coin-page.js fmtPx`) with subtly different rules
  (sig-figs vs fixed decimals, $ prefix or not). Risk of inconsistent display of the same coin.

**Error / empty / loading / wrong-network**
- G12. Trade boot failure shows a single toast (`trade.js:130`) then a silent dead chart/book — no
  inline retry or "data unavailable" panel in the chart/book regions.
- G13. No explicit wrong-network detection for the *connected wallet's* chain vs HL signing (HL
  signs chainId 1337 regardless, so a user on the wrong EVM network can still sign; mainnet/testnet
  toggle is the only guard). Worth a clearer banner when account is connected but clearinghouse is
  all-zero (the historical testnet-default bug class).
- G14. Quick-send (wallet) is a fake success toast — risk of user confusion that it "sent".

**Coin page**
- G15. Symbol→CoinGecko-id resolution relies on the id passed in; deep-linking `#/coin/BTC` (symbol)
  may mis-resolve vs `#/coin/bitcoin`. No "is this listed on HL?" check before showing the Trade CTA.

---

## 3. Prioritized improvements

### P0 — high value, contained, signing-safe

- **P0-1. Unify number formatting into one shared module** (`hl-format.js` extension or new
  `assets/js/fmt-num.js`). What: single `formatPx(n, {coin})`, `formatUsd`, `formatSize`, `formatPct`
  consumed by trade/markets/depth/portfolio/coin-page. How: extract the best rules (sig-fig for px,
  szDecimals-aware), import everywhere, delete the 5 local copies. **Must not touch wire-format
  `formatPrice/formatSize`** (those stay in hl-format.js, tested). Target: G11. Effort: M.

- **P0-2. Connected-but-empty / wrong-network banner in trade + portfolio.** What: when
  `state.account` is set but `clearinghouse` returns all-zero marginSummary, show an inline banner
  "No Hyperliquid account on {network} — deposit on app.hyperliquid.xyz or switch network", instead
  of a silent empty positions table. How: detect in `pollUser`/portfolio load; reuse `emptyState`.
  Target: G13, the historical testnet-zero bug class. Effort: S.

- **P0-3. Honest quick-send.** What: either wire a real EIP-1559 `eth_sendTransaction` for native
  ETH (no key needed — MetaMask signs) or relabel the button "Demo only" and disable success toast.
  How: gate behind a feature flag; minimum is the relabel. Target: G14. Effort: S (relabel) / M (real send).

- **P0-4. Trade-region error/retry states.** What: replace silent dead chart/book on boot failure
  with inline "couldn't load — retry" panels in `#hlChart`/`#hlAsks` regions. How: catch in
  `loadCandles`/`loadBook`, render a small retry button calling the loader. Target: G12. Effort: S.

### P1 — meaningful UX/data-density wins

- **P1-1. Stream account + mark via WebSocket.** What: subscribe `webData2`/`activeAssetCtx`
  (and/or `userEvents`) so uPnL, mark, funding update live instead of 4.5s REST polls. How: add WS
  sub in trade.js + portfolio, keep REST as cold-start/fallback. **SHARED: adds subscriptions in
  hyperliquid.js bus** (additive only). Target: G1. Effort: M.

- **P1-2. Order-book grouping / tick-size control + deeper book.** What: add a price-grouping
  selector (1×/10×/100× tick) and raise level count; aggregate levels client-side. How: extend
  `renderBook` + a small control row. Target: G2. Effort: M.

- **P1-3. Market-order slippage control + basic-ticket TIF/post-only.** What: expose slippage % for
  market orders and a GTC/ALO toggle on the basic ticket (Advanced already has it). How: pass through
  to `placeOrder`/`buildOrderWire` (params already exist; UI only). **No wire change** — `tif`/IOC
  paths already tested. Target: G8. Effort: S/M.

- **P1-4. Keyboard shortcuts in trade view** (b/s side, m/l type, focus size, Enter=review). How:
  scoped keydown while `data-view=trade` active, guard inputs. Target: G9. Effort: S.

- **P1-5. Markets-page resilience + parity.** What: add retry-with-backoff before `DEMO_MARKETS`,
  and consider deriving the spot markets table from the same shared formatter/sector logic as HL
  markets. How: wrap fetch in 2-try backoff; share sector map. Target: G5, G4, G6. Effort: M.

### P2 — polish / longer horizon

- **P2-1. Margin mode (cross/isolated) toggle** in leverage UI (HL supports per-asset isolated;
  `updateLeverage` already takes `isCross`). Effort: M. Target: G10.
- **P2-2. Accurate liq-price estimate** using maintenance-margin tiers from meta. Effort: M. Target: G7.
- **P2-3. Coin-page: HL-listed check** before showing Trade CTA, and robust symbol↔id resolution
  (map via meta.universe + CoinGecko search). Effort: S/M. Target: G15.
- **P2-4. Consolidate the two markets surfaces** into one design language (long-term). Effort: L. Target: G4.

---

## 4. External best practices (Hyperliquid / dYdX / GMX)

- **WebSocket-first account data.** Hyperliquid exposes `webData2`, `activeAssetCtx`,
  `activeAssetData`, `userEvents`, `userFills`, `orderUpdates` WS channels — the official frontend
  streams positions/PnL/mark rather than REST-polling. Our 4.5s poll is the biggest data-freshness
  gap (P1-1). (Hyperliquid API docs — verify channel names against
  `hyperliquid.gitbook.io/.../websocket`.)
- **Order-book grouping** (price tick aggregation) and **microprice/last-trade direction** are
  standard on dYdX/Hyperliquid books; ours lacks grouping (P1-2).
- **Slippage control + reduce-only/post-only on the main ticket** — Hyperliquid and GMX surface
  slippage tolerance for market orders inline rather than a hardcoded 5% (P1-3).
- **Cross vs isolated margin** is a first-class toggle on all three; we hardcode cross (P2-1).
- **Data density**: pro desks keep one canonical number format per asset class and tabular-nums
  alignment everywhere — our 5 divergent px formatters violate this (P0-1). hl-markets/portfolio
  already use tabular alignment well; extend that discipline.
- **Never show fabricated prices**: GMX/dYdX show stale-data badges and skeletons, never invented
  values. Our `DEMO_MARKETS` is the one place we ship invented prices (mitigated by chip; tighten P1-5).
- **Liq-price accuracy**: high-leverage UIs compute liq from maintenance-margin tiers, not a
  1/leverage approximation (P2-2).

---

## 5. FILE OWNERSHIP (for CREATE phase)

**Owned (safe to edit in CREATE — primarily this agent's scope):**
- `assets/js/trade.js` + `assets/css/trade.css` — ticket, chart, book, positions, polling
- `assets/js/hl-markets.js` + `assets/css/markets-pro.css`, `assets/css/hl-markets.css` — markets drawer
- `assets/js/hl-depth.js` + `assets/css/hl-depth.css` — depth + tape
- `assets/js/hl-orders-pro.js` + `assets/css/hl-orders-pro.css` — advanced orders
- `assets/js/hl-portfolio.js` + `assets/css/hl-portfolio.css` — portfolio analytics
- `assets/js/coin-page.js` + `assets/css/coin-page.css`, `coin-page-pro.css` — coin detail
- `assets/js/marketdata.js` — CoinGecko/DefiLlama read layer
- `assets/css/wallet-pro.css` (wallet visuals) — coordinate w/ identity/wallet agent
- NEW (P0-1): `assets/js/fmt-num.js` (shared display formatters) — net-new, low conflict risk

**SHARED — coordinate before editing:**
- `assets/js/hyperliquid.js` — **HL signing format is locked; run
  `tests/signing-format.test.mjs` (336 assertions) after ANY change.** Only additive WS subscriptions
  (P1-1) and untouched param pass-through (P1-3) are in scope; do NOT alter `actionHash`,
  `signL1Action`, wire key order, `formatPrice`/`formatSize`, or the selfTest reference.
- `assets/js/hl-format.js` — wire-format rules, unit-tested; **do not change** (P0-1 adds a *separate*
  display module, not these functions).
- `assets/js/app.js` — SHARED: owns the wallet view (P0-2/P0-3/G14), the CoinGecko markets page
  (P1-5), routing, and `window.LZ` assembly. Heavily shared with wallet/identity/app-shell agents.
- `app.html` — SHARED: element IDs, `data-view`/`data-route`, mount points (`#hlProMount`,
  `#hlDepthMount`, `#hlPortfolioMount`, `#hlMarketsMount`, `#coinPage`) are a hard contract — preserve.
- Tokens `assets/css/base.css`, `assets/css/glass.css` — read-only; consume vars, don't redefine.

**Cross-agent contracts to preserve:** `window.LZ.hl` API (`setCoin`/`prefillOrder`/getters/
`refreshUser`), `window.LZ.coinPage.render`, custom events `lz:hl:coin` / `lz:hl:net` /
`lz:hl:addontab` / `lz:route`. Add-on modules depend on these — extend, don't break.
