/* preloader-hide — extracted from an inline <script> so the page can run under
 * a strict Content-Security-Policy (script-src 'self', no 'unsafe-inline'). */
/* Glass 27: apply the saved material mode BEFORE first paint (this file loads
 * first), so a "clear"/"solid" choice never flashes frosted. UI lives in
 * glass-control.js; tokens in base.css html[data-glass]. */
(function(){
  try{
    var g = localStorage.getItem("lz:glass");
    if (g === "clear" || g === "solid") document.documentElement.dataset.glass = g;
  }catch(e){}
})();
(function(){
  var hide = function(){ var p = document.getElementById("preloader"); if (p) p.classList.add("gone"); };
  if (document.readyState === "complete") setTimeout(hide, 400);
  else window.addEventListener("load", function(){ setTimeout(hide, 400); });
  setTimeout(hide, 2500);
})();
