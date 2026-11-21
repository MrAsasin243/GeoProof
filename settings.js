/* GeoProof — colour palette editor. Presentation only; applies tokens via GeoProof.setTheme. */
(() => {
  'use strict';

  const TOKENS = {
    bg:      'Фон приложения',
    panel:   'Панели',
    panel2:  'Вторичные поверхности',
    border:  'Границы',
    text:    'Основной текст',
    muted:   'Вторичный текст',
    accent:  'Акцент',
    accent2: 'Дополнительный акцент',
    canvas:  'Фон доски',
    grid:    'Сетка доски'
  };

  const PRESETS = {
    graphite: {bg:'#2a2f35',panel:'#31373e',panel2:'#3a4149',border:'#4a525b',text:'#e2e6ea',muted:'#9ba5b0',accent:'#8aa1ba',accent2:'#8ab4a8',canvas:'#252a30',grid:'#333a42'},
    slate:    {bg:'#232830',panel:'#2a3038',panel2:'#333a44',border:'#434b57',text:'#dfe4ea',muted:'#959fad',accent:'#7f9ac2',accent2:'#79ada2',canvas:'#1f242b',grid:'#2f3742'},
    dark:     {bg:'#1c2027',panel:'#232830',panel2:'#2c323b',border:'#3c444f',text:'#dde2e8',muted:'#8f99a6',accent:'#7d95b5',accent2:'#74a89c',canvas:'#191d23',grid:'#2a313a'},
    light:    {bg:'#e9edf2',panel:'#f4f6f9',panel2:'#e4e9ef',border:'#c8d1db',text:'#242a31',muted:'#5d6875',accent:'#3f6491',accent2:'#2f7a6c',canvas:'#f7f9fb',grid:'#dbe2ea'}
  };

  const STORE = 'geoproof-editor-palette';
  const PRESET_STORE = 'geoproof-editor-preset';
  const HEX = /^#[0-9a-f]{6}$/i;

  const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} };
  const drop = key => { try { localStorage.removeItem(key); } catch (_) {} };

  let active = {...PRESETS.graphite};
  let presetName = read(PRESET_STORE, 'graphite');
  if (!PRESETS[presetName]) presetName = 'graphite';

  /* ---- modal ---- */
  const modal = document.createElement('div');
  modal.className = 'overlay';
  modal.id = 'gpPaletteModal';
  modal.innerHTML = `
    <div class="modal gp-palette-modal" role="dialog" aria-modal="true" aria-label="Цветовая схема">
      <div class="gp-palette-head">
        <h3>Цветовая схема</h3>
        <button class="iconbtn" type="button" data-close title="Закрыть">✕</button>
      </div>
      <div class="gp-palette-body">
        <p class="gp-palette-hint">Настройка применяется сразу и сохраняется на этом устройстве. Геометрия, зависимости и шаги доказательства не изменяются.</p>
        <div class="gp-palette-presets">
          <select class="field-select" id="themeSelect" aria-label="Готовая тема">
            <option value="graphite">Графитовая</option>
            <option value="slate">Сланцевая</option>
            <option value="dark">Тёмная</option>
            <option value="light">Светлая</option>
          </select>
          <button class="gp-palette-preset" type="button" data-preset="graphite">Графит</button>
          <button class="gp-palette-preset" type="button" data-preset="slate">Сланец</button>
          <button class="gp-palette-preset" type="button" data-preset="dark">Тёмная</button>
          <button class="gp-palette-preset" type="button" data-preset="light">Светлая</button>
        </div>
        <div class="gp-palette-preview" id="gpPalettePreview">
          <span data-preview="bg"></span><span data-preview="panel"></span><span data-preview="panel2"></span>
          <span data-preview="border"></span><span data-preview="muted"></span><span data-preview="text"></span>
          <span data-preview="accent"></span><span data-preview="accent2"></span><span data-preview="canvas"></span>
          <span data-preview="grid"></span>
        </div>
        <div class="gp-palette-grid" id="gpPaletteGrid"></div>
      </div>
      <div class="gp-palette-footer">
        <button class="btn subtle" type="button" data-reset>Сбросить палитру</button>
        <div class="gp-palette-footer-actions">
          <button class="btn" type="button" data-close>Закрыть</button>
          <button class="btn primary" type="button" data-save>Сохранить</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const grid = modal.querySelector('#gpPaletteGrid');
  const themeSelect = modal.querySelector('#themeSelect');

  const paintPreview = () => {
    modal.querySelectorAll('[data-preview]').forEach(el => { el.style.background = active[el.dataset.preview] || 'transparent'; });
  };

  const markPreset = () => {
    modal.querySelectorAll('[data-preset]').forEach(b => {
      const p = PRESETS[b.dataset.preset];
      const same = Object.keys(TOKENS).every(k => (p[k] || '').toLowerCase() === (active[k] || '').toLowerCase());
      b.classList.toggle('active', same);
    });
  };

  const apply = () => {
    const tokens = {};
    Object.keys(TOKENS).forEach(k => { tokens[k] = active[k]; });
    if (window.GeoProof && typeof window.GeoProof.setTheme === 'function') {
      window.GeoProof.setTheme({name: 'custom', tokens});
    }
    const root = document.documentElement.style;
    root.setProperty('--accent', active.accent);
    root.setProperty('--accent2', active.accent2);
    root.setProperty('--blue', active.accent);
    root.setProperty('--cyan', active.accent2);
    root.setProperty('--canvas', active.canvas);
    root.setProperty('--grid', active.grid);
    root.setProperty('--panel3', mix(active.panel2, active.text, 0.10));
    root.setProperty('--border-soft', mix(active.border, active.panel, 0.35));
    root.setProperty('--border-strong', mix(active.border, active.text, 0.22));
    root.setProperty('--faint', mix(active.muted, active.panel, 0.32));
    root.setProperty('--line', mix(active.text, active.muted, 0.45));
    paintPreview();
    markPreset();
  };

  function mix(a, b, t) {
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return a;
    const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function parse(hex) {
    if (!HEX.test(hex || '')) return null;
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  }

  const buildRows = () => {
    grid.replaceChildren();
    Object.entries(TOKENS).forEach(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'gp-palette-row';
      row.innerHTML = `<label for="gp-${key}">${label}</label>
        <div class="gp-palette-controls">
          <input type="color" id="gp-${key}-picker" aria-label="Цвет: ${label}">
          <input type="text" id="gp-${key}" maxlength="7" spellcheck="false" aria-label="HEX: ${label}">
        </div>`;
      const picker = row.querySelector('input[type=color]');
      const hex = row.querySelector('input[type=text]');
      picker.value = active[key];
      hex.value = active[key].toUpperCase();

      picker.addEventListener('input', () => {
        active[key] = picker.value;
        hex.value = picker.value.toUpperCase();
        apply();
      });
      hex.addEventListener('input', () => {
        const v = hex.value.trim();
        if (HEX.test(v)) { active[key] = v; picker.value = v; apply(); }
      });
      hex.addEventListener('blur', () => { hex.value = active[key].toUpperCase(); });
      grid.appendChild(row);
    });
    paintPreview();
    markPreset();
  };

  const usePreset = name => {
    if (!PRESETS[name]) return;
    presetName = name;
    active = {...PRESETS[name]};
    if (themeSelect.value !== name) themeSelect.value = name;
    drop(STORE);
    write(PRESET_STORE, name);
    buildRows();
    apply();
  };

  const open = () => {
    buildRows();
    modal.style.display = 'flex';
    modal.querySelector('input[type=color]')?.focus();
  };
  const close = () => { modal.style.display = 'none'; };

  document.getElementById('openPaletteBtn')?.addEventListener('click', open);
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => usePreset(b.dataset.preset)));
  themeSelect.addEventListener('change', () => usePreset(themeSelect.value));
  modal.querySelector('[data-reset]').addEventListener('click', () => usePreset('graphite'));
  modal.querySelector('[data-save]').addEventListener('click', () => {
    write(STORE, active);
    write(PRESET_STORE, presetName);
    apply();
    close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display === 'flex') { e.stopPropagation(); close(); }
  }, true);

  /* ---- initial paint: always override the app's boot theme ---- */
  const stored = read(STORE, null);
  if (stored && Object.keys(TOKENS).every(k => HEX.test(stored[k] || ''))) {
    active = {...PRESETS.graphite, ...stored};
  } else {
    active = {...PRESETS[presetName]};
  }
  themeSelect.value = presetName;
  buildRows();
  apply();

  window.GeoProof = window.GeoProof || {};
  window.GeoProof.openPalette = open;
})();