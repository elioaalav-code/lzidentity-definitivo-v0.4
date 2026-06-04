/* ============================================================
 *  pillars.js · LZidentity — Recovery tab logic
 *
 *  Recovery is the one identity pillar that remains after the
 *  v2.1 refocus (Trading + AI copilot replaced Doppelgänger and
 *  Soglia). This file keeps the guardian feed feeling alive:
 *   - recovery feed live-tick (guardian events every ~12s)
 *   - "Test the flow" drill button
 *
 *  Sketch only (no backend) — wired so the surface feels alive.
 * ============================================================ */

import { toast } from "./shared.js";

const recoveryFeed = document.getElementById("recoveryFeed");
const recoveryLastTest = document.getElementById("recoveryLastTest");
const recoveryTestBtn = document.getElementById("recoveryTest");

const recoverySamples = [
  { what: "Guardian Maya signed a heartbeat · <em>Arbitrum</em>",            badge: "ok" },
  { what: "Ledger Nano · drawer · proof-of-life · <em>Ethereum</em>",        badge: "ok" },
  { what: "Backup phone synced recovery rule · <em>Base</em>",               badge: "ok" },
  { what: "Recovery rule re-confirmed across 5 chains · <em>LayerZero</em>", badge: "ok" },
  { what: "Threshold check: <em>2 of 3 guardians responsive</em>",           badge: "ok" },
];

function addRecoveryEvent(){
  if (!recoveryFeed) return;
  const s = recoverySamples[Math.floor(Math.random() * recoverySamples.length)];
  const row = document.createElement("div");
  row.className = "recovery-event";
  row.innerHTML = `
    <span class="t">now</span>
    <span class="what">${s.what}</span>
    <span class="delta pos">${s.badge}</span>`;
  row.style.opacity = "0";
  row.style.transform = "translateY(-6px)";
  recoveryFeed.prepend(row);
  requestAnimationFrame(() => {
    row.style.transition = "opacity .4s ease, transform .4s cubic-bezier(.22,.8,.36,1)";
    row.style.opacity = "1";
    row.style.transform = "none";
  });
  while (recoveryFeed.children.length > 8) recoveryFeed.lastElementChild.remove();
}

setInterval(addRecoveryEvent, 12000);

let lastTestDays = 7;
setInterval(() => {
  if (!recoveryLastTest) return;
  // gentle, slow drift just for liveness
  lastTestDays += 1 / 86400;
  recoveryLastTest.firstChild.nodeValue = `${Math.floor(lastTestDays)} d`;
}, 5000);

recoveryTestBtn?.addEventListener("click", () => {
  toast("recovery · simulating a 2-of-3 guardian signature · all chains via LayerZero …", 2600);
  lastTestDays = 0;
  if (recoveryLastTest) recoveryLastTest.firstChild.nodeValue = "now";
});
