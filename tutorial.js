/* GeoProof — GeLogLean tutorial overlay. Presentation only; no application state. */
(() => {
  'use strict';

  const SRC = 'GeLogLean_tutorial.html';
  const panel    = document.getElementById('tutorialPanel');
  const scrim    = document.getElementById('tutorialScrim');
  const openBtn  = document.getElementById('openTutorialBtn');
  const closeBtn = document.getElementById('closeTutorialBtn');
  const retryBtn = document.getElementById('tutorialRetryBtn');
  const frame    = document.getElementById('tutorialFrame');
  const fallback = document.getElementById('tutorialFallback');
  if (!panel || !openBtn || !frame) return;

  let loaded = false, timer = 0, lastFocus = null;
  const isOpen = () => panel.classList.contains('tutorial-open');

  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (loaded) return;
      frame.hidden = true;
      if (fallback) fallback.hidden = false;
    }, 5000);
  };

  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return;
    loaded = true;
    clearTimeout(timer);
    frame.hidden = false;
    if (fallback) fallback.hidden = true;
  });

  const load = () => {
    loaded = false;
    frame.hidden = false;
    if (fallback) fallback.hidden = true;
    armTimer();
    frame.setAttribute('src', SRC);
  };

  const open = () => {
    lastFocus = document.activeElement;
    panel.classList.add('tutorial-open');
    panel.setAttribute('aria-hidden', 'false');
    if (scrim) scrim.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    openBtn.classList.add('on');
    if (!frame.getAttribute('src')) load();
    closeBtn?.focus();
  };

  const close = () => {
    panel.classList.remove('tutorial-open');
    panel.setAttribute('aria-hidden', 'true');
    if (scrim) scrim.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.classList.remove('on');
    clearTimeout(timer);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    else openBtn.focus();
  };

  openBtn.addEventListener('click', () => (isOpen() ? close() : open()));
  closeBtn?.addEventListener('click', close);
  scrim?.addEventListener('click', close);

  retryBtn?.addEventListener('click', () => {
    frame.removeAttribute('src');
    requestAnimationFrame(() => requestAnimationFrame(load));
  });

  /* Capture phase: Escape закрывает только руководство и не доходит
     до глобального обработчика app.js, который сбрасывает незавершённое построение. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); }
  }, true);
})();