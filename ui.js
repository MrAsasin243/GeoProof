/* GeoProof — dock layout controller. Presentation only: resizing, drawers, dock toggles.
   Does not touch geometry, proof state or any application data. */
(() => {
  'use strict';

  const body = document.body;
  const menu = document.getElementById('workspaceMenu');
  const backdrop = document.getElementById('menuBackdrop');
  const scrim = document.getElementById('dockScrim');
  const openMenuBtn = document.getElementById('openMenuBtn');
  const toolsBtn = document.getElementById('toolsToggleBtn');
  const leftBtn = document.getElementById('leftDockBtn');
  const rightBtn = document.getElementById('rightDockBtn');

  const mq = window.matchMedia('(max-width: 900px)');
  const isMobile = () => mq.matches;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };

  /* ---------- persisted dock widths ---------- */
  const LIMITS = {left: [212, 460], right: [280, 620]};
  const DEFAULTS = {left: 264, right: 372};

  const setWidth = (side, px) => {
    const [min, max] = LIMITS[side];
    const v = Math.round(Math.max(min, Math.min(max, px)));
    document.documentElement.style.setProperty(side === 'left' ? '--dock-l' : '--dock-r', v + 'px');
    return v;
  };
  ['left', 'right'].forEach(side => setWidth(side, store.get('gp-dock-' + side, DEFAULTS[side])));

  /* ---------- splitters ---------- */
  document.querySelectorAll('.splitter').forEach(handle => {
    const side = handle.dataset.split;
    const prop = side === 'left' ? '--dock-l' : '--dock-r';
    let startX = 0, startW = 0, active = false, pid = null;

    const currentWidth = () =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue(prop)) || DEFAULTS[side];

    const down = e => {
      if (isMobile()) return;
      active = true; pid = e.pointerId;
      startX = e.clientX; startW = currentWidth();
      handle.classList.add('dragging');
      body.classList.add('resizing');
      try { handle.setPointerCapture(pid); } catch (_) {}
      e.preventDefault();
    };
    const move = e => {
      if (!active || e.pointerId !== pid) return;
      const delta = e.clientX - startX;
      setWidth(side, side === 'left' ? startW + delta : startW - delta);
    };
    const up = e => {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      handle.classList.remove('dragging');
      body.classList.remove('resizing');
      try { handle.releasePointerCapture(pid); } catch (_) {}
      store.set('gp-dock-' + side, currentWidth());
    };

    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
    handle.addEventListener('dblclick', () => { setWidth(side, DEFAULTS[side]); store.set('gp-dock-' + side, DEFAULTS[side]); });
    handle.addEventListener('keydown', e => {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = (e.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
        setWidth(side, currentWidth() + dir * step);
        store.set('gp-dock-' + side, currentWidth());
        e.preventDefault();
      }
      if (e.key === 'Home') { setWidth(side, DEFAULTS[side]); store.set('gp-dock-' + side, DEFAULTS[side]); e.preventDefault(); }
    });
  });

  /* ---------- desktop dock toggles ---------- */
  const syncDockButtons = () => {
    leftBtn?.classList.toggle('on', !body.classList.contains('left-collapsed'));
    rightBtn?.classList.toggle('on', !body.classList.contains('right-collapsed'));
    toolsBtn?.setAttribute('aria-expanded', body.classList.contains('tools-open') ? 'true' : 'false');
  };

  leftBtn?.addEventListener('click', () => {
    if (isMobile()) body.classList.toggle('tools-open');
    else body.classList.toggle('left-collapsed');
    syncDockButtons();
  });
  rightBtn?.addEventListener('click', () => {
    if (isMobile()) openMenuBtn?.click();
    else body.classList.toggle('right-collapsed');
    syncDockButtons();
  });

  /* ---------- mobile left drawer ---------- */
  const closeTools = () => { body.classList.remove('tools-open'); syncDockButtons(); };
  toolsBtn?.addEventListener('click', () => { body.classList.toggle('tools-open'); syncDockButtons(); });
  document.getElementById('closeToolsBtn')?.addEventListener('click', closeTools);
  document.querySelectorAll('.dock-left .tool').forEach(btn => {
    btn.addEventListener('click', () => { if (isMobile()) closeTools(); });
  });

  scrim?.addEventListener('click', () => {
    closeTools();
    if (body.classList.contains('menu-open')) document.getElementById('closeMenuBtn')?.click();
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (body.classList.contains('tools-open')) closeTools();
  });

  /* ---------- dock adapter ----------
     The application opens/closes #workspaceMenu as a drawer and marks it inert.
     On desktop the dock is permanent, so visibility side-effects are neutralised
     while the application's own state machine keeps running untouched. */
  let armed = false;
  openMenuBtn?.addEventListener('click', () => {
    armed = true;
    setTimeout(() => { armed = false; }, 0);
  }, true);

  let prevMenu = body.classList.contains('menu-open');
  let prevFocus = body.classList.contains('proof-focus');

  const keepInteractive = () => {
    if (isMobile()) return;
    if (menu && menu.inert) menu.inert = false;
    if (menu && menu.getAttribute('aria-hidden') !== 'false') menu.setAttribute('aria-hidden', 'false');
    if (backdrop && !backdrop.hidden) backdrop.hidden = true;
  };

  new MutationObserver(() => {
    const menuOpen = body.classList.contains('menu-open');
    const focus = body.classList.contains('proof-focus');

    if (focus !== prevFocus) {
      prevFocus = focus;
      prevMenu = menuOpen;
      if (!focus && !isMobile()) body.classList.remove('right-collapsed');
      keepInteractive();
      syncDockButtons();
      return;
    }
    if (menuOpen !== prevMenu) {
      prevMenu = menuOpen;
      if (!isMobile() && armed) body.classList.toggle('right-collapsed');
    }
    keepInteractive();
    syncDockButtons();
  }).observe(body, {attributes: true, attributeFilter: ['class']});

  if (menu) {
    new MutationObserver(keepInteractive).observe(menu, {attributes: true, attributeFilter: ['inert', 'aria-hidden']});
  }
  keepInteractive();

  mq.addEventListener?.('change', () => {
    body.classList.remove('tools-open');
    if (!isMobile()) {
      body.classList.remove('menu-open');
      if (backdrop) backdrop.hidden = true;
    }
    keepInteractive();
    syncDockButtons();
  });

  /* ---------- presentation label mirroring ----------
     Keeps the visible presentation labels in sync with whichever node the
     application writes to, so the overlay always shows the current step. */
  const aliases = document.getElementById('gpPresentationAliases');
  if (aliases) {
    const mirror = node => {
      const target = document.getElementById(node.dataset.mirror);
      if (target && node.textContent && target.textContent !== node.textContent) {
        target.textContent = node.textContent;
      }
    };
    const observer = new MutationObserver(records => {
      records.forEach(r => {
        const node = r.target.nodeType === 1 ? r.target.closest('[data-mirror]') : r.target.parentElement?.closest('[data-mirror]');
        if (node) mirror(node);
      });
    });
    observer.observe(aliases, {subtree: true, childList: true, characterData: true});
    document.getElementById('presentProofBtn')?.addEventListener('click', () => {
      setTimeout(() => aliases.querySelectorAll('[data-mirror]').forEach(mirror), 0);
    });
  }

  /* ---------- proof focus button label ---------- */
  const focusBtn = document.getElementById('proofFocusBtn');
  const syncFocus = () => {
    if (!focusBtn) return;
    const on = body.classList.contains('proof-focus');
    focusBtn.textContent = on ? '⤡' : '⛶';
    focusBtn.title = on ? 'Вернуться к доске' : 'Полный экран';
    focusBtn.classList.toggle('on', on);
  };
  new MutationObserver(syncFocus).observe(body, {attributes: true, attributeFilter: ['class']});
  syncFocus();

  /* ---------- documentation: close on scrim click ---------- */
  const docs = document.getElementById('documentation');
  document.addEventListener('pointerdown', e => {
    if (!docs || !docs.classList.contains('docs-open')) return;
    if (!docs.contains(e.target) && !e.target.closest('#openDocsBtn')) {
      document.getElementById('closeDocsBtn')?.click();
    }
  });

  syncDockButtons();
})();