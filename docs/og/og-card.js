/* draws the brand sigil on the og-card template (external file: CSP 'self') */
import { mountSigil } from "/assets/js/sigil.js";
mountSigil(document.getElementById("sg"), "npub1lz-one-you-every-chain");
window.__ogReady = true;
