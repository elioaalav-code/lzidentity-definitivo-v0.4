/* preloader-hide — extracted from an inline <script> so the page can run under
 * a strict Content-Security-Policy (script-src 'self', no 'unsafe-inline'). */
(function(){
  var hide = function(){ var p = document.getElementById("preloader"); if (p) p.classList.add("gone"); };
  if (document.readyState === "complete") setTimeout(hide, 400);
  else window.addEventListener("load", function(){ setTimeout(hide, 400); });
  setTimeout(hide, 2500);
})();
