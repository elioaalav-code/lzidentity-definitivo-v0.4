/* ============================================================
 *  anima.js · landing page reveals + TRIBE-tuned cadence
 *  See docs/DESIGN_PRINCIPLES.md (P2: 4-second lookback window,
 *  P7: anticipate the user by ~120ms).
 * ============================================================ */

/* IntersectionObserver fires at 70% threshold per P7 — the
   reveal triggers slightly before the section is fully on-screen,
   so the brain's hemodynamic response leads the eye. */
(() => {
  const els = document.querySelectorAll('.anima-manifest [data-reveal], .pillars [data-reveal]');
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.3, rootMargin: '0px 0px -80px 0px' });
  els.forEach((el) => io.observe(el));
})();

/* P3: staggered breath across the three pillars so they don't
   pulse in unison — phase-shift by TRIBE's 4s window / 3. */
(() => {
  const pillars = document.querySelectorAll('.pillar');
  const phaseStep = 4 / 3; // seconds
  pillars.forEach((p, i) => {
    p.style.setProperty('--phase-offset', `${-i * phaseStep}s`);
  });
})();

/* P4: long-form manifest paragraphs get a subtle parallax —
   text drifts 8px over its visible range. This gives the
   prefrontal language regions a gentle motion signal that
   keeps them tuned without competing with content. */
(() => {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pars = document.querySelectorAll('.am-prose .par');
  // The pull-quote drifts a touch further (12px) than the prose (8px) so it
  // floats slightly against the paragraphs — a quiet depth cue (P4).
  const quote = document.querySelector('.am-quote');
  if (!pars.length && !quote) return;
  let ticking = false;
  const update = () => {
    const vh = window.innerHeight;
    pars.forEach((p) => {
      const rect = p.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const dist = (center - vh / 2) / vh; // -1 ... +1
      const dy = Math.max(-8, Math.min(8, -dist * 8));
      p.style.transform = `translate3d(0, ${dy}px, 0)`;
    });
    if (quote) {
      const rect = quote.getBoundingClientRect();
      const dist = ((rect.top + rect.height / 2) - vh / 2) / vh;
      const dy = Math.max(-12, Math.min(12, -dist * 12));
      quote.style.transform = `translate3d(0, ${dy}px, 0)`;
    }
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
})();
