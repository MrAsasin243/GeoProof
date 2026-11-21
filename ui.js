/* GeoProof — dock layout controller. Presentation only: resizing, drawers, dock toggles.
   Does not touch geometry, proof state or any application data.

   Contract with app.js:
   - #openMenuBtn must exist (app.js uses it without optional chaining). It now lives
     in the stage bar and IS the right-dock toggle, so there is no duplicate control.
   - app.js owns body.menu-open / body.proof-focus and workspaceMenu.inert.
     This file only translates those states into the docked layout. */
(() => {
  'use strict';

  const body = document.body;
  const menu = document.getElementById('workspaceMenu');
  const backdrop = document.getElementById('menuBackdrop');
  const scrim = document.getElementById('dockScrim');
  const openMenuBtn = document.getElementById('openMenuBtn');   // right dock toggle
  const closeMenuBtn = document.getElementById('closeMenuBtn');
  const leftBtn = document.getElementById('leftDockBtn');       // left dock toggle
  const closeToolsBtn = document.getElementById('closeToolsBtn');

  const mq = window.matchMedia('(max-width: 900px)');
  const mqCompact = window.matchMedia('(max-width: 640px)');
  const isMobile = () => mq.matches;

  const setFlag = (el, name, on) => {
    if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
  };

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

  /* ---------- button state ---------- */
  const syncDockButtons = () => {
    const mobile = isMobile();
    const leftOpen = mobile ? body.classList.contains('tools-open') : !body.classList.contains('left-collapsed');
    const rightOpen = mobile ? body.classList.contains('menu-open') : !body.classList.contains('right-collapsed');

    if (leftBtn) {
      setFlag(leftBtn, 'on', leftOpen);
      leftBtn.setAttribute('aria-expanded', String(leftOpen));
      leftBtn.title = mobile
        ? (leftOpen ? 'Закрыть инструменты' : 'Открыть инструменты')
        : (leftOpen ? 'Скрыть панель инструментов' : 'Показать панель инструментов');
    }
    if (openMenuBtn) {
      setFlag(openMenuBtn, 'on', rightOpen);
      openMenuBtn.setAttribute('aria-expanded', String(rightOpen));
      openMenuBtn.title = mobile
        ? (rightOpen ? 'Закрыть доказательство' : 'Открыть доказательство')
        : (rightOpen ? 'Скрыть панель доказательства' : 'Показать панель доказательства');
    }
  };

  /* ---------- left dock ---------- */
  const closeTools = () => { setFlag(body, 'tools-open', false); syncDockButtons(); };

  leftBtn?.addEventListener('click', () => {
    if (isMobile()) {
      // drawers are mutually exclusive so they never overlap
      if (body.classList.contains('menu-open')) closeMenuBtn?.click();
      body.classList.toggle('tools-open');
    } else {
      body.classList.toggle('left-collapsed');
    }
    syncDockButtons();
  });
  closeToolsBtn?.addEventListener('click', closeTools);
  document.querySelectorAll('.dock-left .tool').forEach(btn => {
    btn.addEventListener('click', () => { if (isMobile()) closeTools(); });
  });

  /* ---------- right dock: ✕ also collapses the docked panel on desktop ---------- */
  closeMenuBtn?.addEventListener('click', () => {
    if (!isMobile()) body.classList.add('right-collapsed');
    syncDockButtons();
  });

  scrim?.addEventListener('click', () => {
    closeTools();
    if (body.classList.contains('menu-open')) closeMenuBtn?.click();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && body.classList.contains('tools-open')) closeTools();
  });

  /* ---------- dock adapter ----------
     app.js toggles body.menu-open from #openMenuBtn. On desktop the dock is
     permanent, so only a real press on that button flips the collapsed state;
     programmatic closes (tool pick, Esc, docs) must not hide the dock. */
  let armed = false;
  openMenuBtn?.addEventListener('click', () => {
    armed = true;
    setTimeout(() => { armed = false; }, 0);
  }, true);

  let prevMenu = body.classList.contains('menu-open');
  let prevFocus = body.classList.contains('proof-focus');

  const keepInteractive = () => {
    if (isMobile()) {
      const open = body.classList.contains('menu-open') || body.classList.contains('proof-focus');
      if (menu) {
        if (menu.inert === open) menu.inert = !open;
        const aria = open ? 'false' : 'true';
        if (menu.getAttribute('aria-hidden') !== aria) menu.setAttribute('aria-hidden', aria);
      }
      if (backdrop && !backdrop.hidden) backdrop.hidden = true;
      return;
    }
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
      if (!isMobile()) body.classList.remove('right-collapsed');
      keepInteractive();
      syncDockButtons();
      return;
    }
    if (menuOpen !== prevMenu) {
      prevMenu = menuOpen;
      if (isMobile()) {
        if (menuOpen) setFlag(body, 'tools-open', false);
      } else if (armed) {
        body.classList.toggle('right-collapsed');
      }
    }
    keepInteractive();
    syncDockButtons();
  }).observe(body, {attributes: true, attributeFilter: ['class']});

  if (menu) {
    new MutationObserver(keepInteractive).observe(menu, {attributes: true, attributeFilter: ['inert', 'aria-hidden']});
  }
  keepInteractive();

  mq.addEventListener?.('change', () => {
    setFlag(body, 'tools-open', false);
    if (!isMobile()) setFlag(body, 'menu-open', false);
    prevMenu = body.classList.contains('menu-open');
    keepInteractive();
    syncDockButtons();
    scheduleHelp();
  });

  /* ---------- board hint: clamp on phones, expand on demand ---------- */
  const helpRow = document.querySelector('.boardhelp');
  const helpText = document.getElementById('toolHelp');
  const helpBtn = document.getElementById('helpMoreBtn');
  let helpRaf = 0;

  function measureHelp() {
    if (!helpRow || !helpText || !helpBtn) return;
    if (!mqCompact.matches) {
      setFlag(helpRow, 'can-expand', false);
      setFlag(helpRow, 'expanded', false);
      helpBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (helpRow.classList.contains('expanded')) { setFlag(helpRow, 'can-expand', true); return; }
    setFlag(helpRow, 'can-expand', helpText.scrollHeight - helpText.clientHeight > 1);
  }
  function scheduleHelp() {
    if (helpRaf) return;
    helpRaf = requestAnimationFrame(() => { helpRaf = 0; measureHelp(); });
  }

  if (helpRow && helpText && helpBtn) {
    helpBtn.addEventListener('click', () => {
      const open = !helpRow.classList.contains('expanded');
      setFlag(helpRow, 'expanded', open);
      helpBtn.setAttribute('aria-expanded', String(open));
      const label = open ? 'Свернуть подсказку' : 'Показать подсказку полностью';
      helpBtn.title = label;
      helpBtn.setAttribute('aria-label', label);
      scheduleHelp();
    });
    new MutationObserver(() => {
      setFlag(helpRow, 'expanded', false);
      helpBtn.setAttribute('aria-expanded', 'false');
      helpBtn.title = 'Показать подсказку полностью';
      helpBtn.setAttribute('aria-label', 'Показать подсказку полностью');
      scheduleHelp();
    }).observe(helpText, {childList: true, characterData: true, subtree: true});
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleHelp).observe(helpText);
    mqCompact.addEventListener?.('change', scheduleHelp);
    scheduleHelp();
  }

  /* ---------- presentation label mirroring ---------- */
  const aliases = document.getElementById('gpPresentationAliases');
  if (aliases) {
    const mirror = node => {
      const target = document.getElementById(node.dataset.mirror);
      if (target && node.textContent && target.textContent !== node.textContent) {
        target.textContent = node.textContent;
      }
    };
    new MutationObserver(records => {
      records.forEach(r => {
        const node = r.target.nodeType === 1
          ? r.target.closest('[data-mirror]')
          : r.target.parentElement?.closest('[data-mirror]');
        if (node) mirror(node);
      });
    }).observe(aliases, {subtree: true, childList: true, characterData: true});
    document.getElementById('presentProofBtn')?.addEventListener('click', () => {
      setTimeout(() => aliases.querySelectorAll('[data-mirror]').forEach(mirror), 0);
    });
  }

  /* ---------- proof focus button ---------- */
  const focusBtn = document.getElementById('proofFocusBtn');
  const syncFocus = () => {
    if (!focusBtn) return;
    const on = body.classList.contains('proof-focus');
    focusBtn.textContent = on ? '⤡' : '⛶';
    const label = on ? 'Вернуться к доске' : 'Полный экран';
    focusBtn.title = label;
    focusBtn.setAttribute('aria-label', label);
    focusBtn.setAttribute('aria-pressed', String(on));
    setFlag(focusBtn, 'on', on);
  };
  new MutationObserver(syncFocus).observe(body, {attributes: true, attributeFilter: ['class']});
  syncFocus();

  /* ---------- documentation: close on outside click ---------- */
  const docs = document.getElementById('documentation');
  document.addEventListener('pointerdown', e => {
    if (!docs || !docs.classList.contains('docs-open')) return;
    if (!docs.contains(e.target) && !e.target.closest('#openDocsBtn')) {
      document.getElementById('closeDocsBtn')?.click();
    }
  });

  syncDockButtons();
})();