# Integration — Widgets / Wallet lane (BUILD output)

Spine changes the coordinator must apply. The BUILD lane only edited its own
files (`wallet-actions.js/css`, `wallet-pro.css`, `assistant.js/css`,
`risk.css`). Everything below is OPTIONAL polish — the lane's work already
functions against the current `app.html` / `ui.js` as shipped.

## 1. (Optional, app.html) Remove now-duplicated key copy
`assistant.js` now injects a visible BYO-key notice (`#copilotKeyNote`,
`.cs-keynote`) directly under `#copilotKey` whenever the settings panel opens.
It restates, more prominently, what the static `<p>` at **app.html:676** already
says ("stored only in this browser … never to us").

If you want to avoid saying it twice, trim the second sentence of that `<p>` to
just the lead-in, e.g.:

```html
<!-- app.html ~676 -->
<p>Paste an Anthropic API key to turn on the real assistant.</p>
```

Leave it as-is if you prefer the redundancy. No code depends on the `<p>` text.

## 2. (Coordinator's own task, FYI) sessionStorage move for the key
Per `08-security-perf.md` S2, the key-storage hardening (localStorage →
sessionStorage / in-memory) is the coordinator's. The BUILD lane only added the
**UX warning**. When you move storage, the warning copy ("stored locally in this
browser … Clearing site data or using Remove key deletes it") may want a tweak to
say "clears when you close this tab" if you switch to sessionStorage. Single
string in `assistant.js` → `ensureKeyWarning()`.

## 3. No `ui.js` / `base.css` changes required
`LZUI.modal`, `CustomSelect`, `skeleton`, `emptyState`, `escapeHtml`,
`coinAvatar` were all consumed exactly as the foundation shipped them. No
additive API was needed. The only minor mismatch vs. the brief: `modal()` takes
`{width}` (not `size`) and already exposes `onClose` — used accordingly.

Nothing else for the spine.
