# Integration — Trading lane (apply to SHARED files)

The Trading lane (07) is done in its **owned** files. These are the only changes needed
in SHARED files. Apply them verbatim; nothing here touches `hyperliquid.js` signing.

Owned-file work already landed (no action needed): new `assets/js/fmt-num.js`; all 6
owned modules refactored onto it (kills the 5 divergent formatters); connected-but-empty /
wrong-network banner in trade + portfolio; trade-region chart/book retry panels via net.js
timeouts; `marketdata.js` routed through `net.js` (timeout + retry + cache).

---

## 1. `app.js` — Honest quick-send (P0-3, G14)  **[REQUIRED]**

The wallet "Quick send" button currently fires a **fake success toast** — it never sends
anything but tells the user it "signed". Replace it. Two options; ship at least Option A.

Find this block (around `app.js:493-502`):

```js
document.getElementById("sendBtn")?.addEventListener("click", () => {
  const to = document.getElementById("sendTo").value.trim();
  const amt = document.getElementById("sendAmt").value.trim();
  const asset = document.getElementById("sendAsset").value;
  const via = document.getElementById("sendVia").value;
  if (!to || !amt){ toast("destination and amount required", "err"); return; }
  toast(`signed · ${amt} ${asset} → ${to.slice(0,10)}… via ${via}`, "ok");
  document.getElementById("sendTo").value = "";
  document.getElementById("sendAmt").value = "";
});
```

### Option A — minimum honest (relabel + no fake confirmation)

Replace the whole block with:

```js
document.getElementById("sendBtn")?.addEventListener("click", () => {
  toast("Quick send isn’t wired in this build — use your wallet app to transfer.", "info", 4200);
});
```

…and in `app.html` change the button label + add a demo note (see §3).

### Option B — real native-ETH send (preferred; MetaMask signs, no key in-app)

Replace the whole block with the following. It does a genuine EIP-1559
`eth_sendTransaction` for **native ETH only**; every other asset/route is honestly
reported as unavailable (no fabricated confirmation):

```js
document.getElementById("sendBtn")?.addEventListener("click", async () => {
  const to    = document.getElementById("sendTo").value.trim();
  const amt   = document.getElementById("sendAmt").value.trim();
  const asset = document.getElementById("sendAsset").value;
  const via   = document.getElementById("sendVia").value;
  if (!state.account){ toast("connect a wallet first", "err"); return; }
  if (!to || !amt){ toast("destination and amount required", "err"); return; }
  // Only native ETH on the default EVM route is actually sendable keylessly.
  if (asset !== "ETH" || (via !== "auto" && via !== "mesh")){
    toast(`${asset} via ${via} isn’t wired in this build — only native ETH transfers are live.`, "info", 4600);
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)){ toast("enter a valid 0x address for ETH", "err"); return; }
  const n = Number(amt);
  if (!(n > 0)){ toast("enter a valid amount", "err"); return; }
  const eth = window.ethereum;
  if (!eth){ toast("no injected wallet found", "err"); return; }
  const btn = document.getElementById("sendBtn");
  btn.disabled = true; const old = btn.textContent; btn.textContent = "Confirm in wallet…";
  try {
    const wei = "0x" + Math.floor(n * 1e18).toString(16);
    const hash = await eth.request({ method: "eth_sendTransaction",
      params: [{ from: state.account, to, value: wei }] });
    toast(`sent · tx ${String(hash).slice(0,10)}…`, "ok", 4200);
    document.getElementById("sendTo").value = "";
    document.getElementById("sendAmt").value = "";
    setTimeout(() => { try { loadWallet(); } catch {} }, 4000);
  } catch (e){
    toast(e?.code === 4001 ? "transfer rejected" : "send failed · " + (e?.message || e), "err", 4200);
  } finally { btn.disabled = false; btn.textContent = old; }
});
```

`state`, `toast`, `loadWallet` are already in scope in `app.js`.

---

## 2. `app.html` — element IDs / mounts  **[NO CHANGES — confirm only]**

No app.html edits are required by this lane. The banners and retry panels are injected by
the owned JS into existing containers:
- trade banner → `[data-view="trade"] .trade-positions` (first child)
- trade chart retry → `#hlChart`; book retry → `[data-view="trade"] .mid-pane[data-pane="book"]`
- portfolio banner → inside `#hlPortfolioMount` body (string-concatenated in render)

All preserved contracts intact: element IDs, `data-view`/`data-route`, `window.LZ.hl`
(`setCoin`/`prefillOrder`/getters/`refreshUser`), `window.LZ.coinPage.render`, and events
`lz:hl:coin` / `lz:hl:net` / `lz:hl:addontab` / `lz:route` are untouched.

---

## 3. `app.html` — quick-send label (only if you take Option A above)

Around `app.html:233`, change:

```html
<button class="btn accent" id="sendBtn">Sign &amp; send →</button>
```

to (Option A — honest "demo" framing):

```html
<button class="btn accent" id="sendBtn">Sign &amp; send →</button>
<p class="send-note" style="margin:8px 0 0;font-size:11px;color:var(--text-mute)">Demo control — transfers aren’t wired in this build.</p>
```

If you take **Option B**, leave the button label as-is (it really sends ETH) and skip this §3.

---

## 4. `hyperliquid.js` — additive pass-through  **[OPTIONAL / P1, NOT required]**

The P1 items (WebSocket `webData2`/`activeAssetCtx` account streaming, basic-ticket
slippage/TIF) were **not** implemented in this pass to keep the signing surface frozen.
If/when picked up, the only `hyperliquid.js` ask is **purely additive**:
- expose the existing WS bus `subscribe({ type: "webData2", user })` / `activeAssetCtx`
  channels (no change to `actionHash`/`signL1Action`/wire key order/`formatPrice`/
  `formatSize`/selfTest reference).
- `placeOrder` already accepts slippage/`tif` params — UI-only, no wire change.

Until then there is **nothing to change** in `hyperliquid.js`. Signing test stays
**336/336**.
