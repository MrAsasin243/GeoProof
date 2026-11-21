/* GeoProof 1.9 — proof workspace presentation and application logic.
 * This file is loaded by index.html after the document markup.
 * Keep this file beside index.html and styles.css.
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#diagram');
  function readCanvasSize() {
    const rect=svg.getBoundingClientRect();
    return {width:Math.max(1,rect.width||1000),height:Math.max(1,rect.height||680)};
  }
  let viewportBase=readCanvasSize();
  let zoomScale=1;
  let view={x:500-viewportBase.width/2,y:340-viewportBase.height/2,width:viewportBase.width,height:viewportBase.height};
  let spacePressed = false;
  let panState = null;
  const activePointers = new Map();
  let pinchState = null;
  let gestureMode = 'idle'; // idle | drag | pan | pinch | suspended
  let pendingTouchTap = null;
  let currentPointerType = 'mouse';
  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    $('#zoomLevel').textContent = `${Math.round(100/zoomScale)}%`;
  }
  function adaptViewToViewport() {
    const next=readCanvasSize();
    if(Math.abs(next.width-viewportBase.width)<1 && Math.abs(next.height-viewportBase.height)<1) return;
    const centerX=view.x+view.width/2, centerY=view.y+view.height/2;
    viewportBase=next;
    view.width=viewportBase.width*zoomScale;
    view.height=viewportBase.height*zoomScale;
    view.x=centerX-view.width/2;
    view.y=centerY-view.height/2;
    applyView();
  }
  function resetView() {
    zoomScale=1;
    view={x:500-viewportBase.width/2,y:340-viewportBase.height/2,width:viewportBase.width,height:viewportBase.height};
    applyView();
  }
  function zoomAt(factor, clientX, clientY) {
    const before = clientX == null ? {x:view.x+view.width/2,y:view.y+view.height/2} : localPoint({clientX,clientY});
    const nextZoom=Math.max(.25,Math.min(4,zoomScale*factor));
    const ratio=nextZoom/zoomScale;
    zoomScale=nextZoom;
    const width=viewportBase.width*zoomScale;
    const height=viewportBase.height*zoomScale;
    view = {x:before.x-(before.x-view.x)*ratio,y:before.y-(before.y-view.y)*ratio,width,height};
    applyView();
  }

  // Appearance is deliberately separate from the mathematical project state.
  const themeTokens = ['bg','panel','panel2','border','text','muted','accent','accent2','canvas','grid'];
  const themeDefaults = {
    dark: {bg:'#0a1020',panel:'#121c30',panel2:'#18243b',border:'#2a3a56',text:'#e8eef9',muted:'#9aabc6',accent:'#75aaff',accent2:'#64dcc6',canvas:'#0c1525',grid:'#25334a'},
    light: {bg:'#eef2f7',panel:'#ffffff',panel2:'#f5f7fb',border:'#d6deea',text:'#182235',muted:'#64748b',accent:'#3269ad',accent2:'#168b7b',canvas:'#fbfcff',grid:'#e3e9f1'},
    graphite: {bg:'#17191d',panel:'#22252b',panel2:'#2b2f36',border:'#41464f',text:'#eceff3',muted:'#a6adb8',accent:'#9ab8e8',accent2:'#83c9bd',canvas:'#1b1e23',grid:'#343a43'}
  };
  let activeTheme = 'dark';
  function setTheme(theme) {
    const isCustom = theme && typeof theme === 'object' && !Array.isArray(theme);
    const name = isCustom ? 'custom' : (themeDefaults[theme] ? theme : 'dark');
    const tokens = isCustom ? (theme.tokens || {}) : themeDefaults[name];
    document.body.dataset.theme = name;
    const base = themeDefaults.dark;
    for (const key of themeTokens) {
      const value = tokens[key];
      if (typeof value === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(value)) {
        document.documentElement.style.setProperty('--gp-' + key, value);
      } else document.documentElement.style.removeProperty('--gp-' + key);
    }
    const resolved = {...base, ...tokens};
    document.documentElement.style.setProperty('--bg', resolved.bg);
    document.documentElement.style.setProperty('--panel', resolved.panel);
    document.documentElement.style.setProperty('--panel2', resolved.panel2);
    document.documentElement.style.setProperty('--border', resolved.border);
    document.documentElement.style.setProperty('--text', resolved.text);
    document.documentElement.style.setProperty('--muted', resolved.muted);
    document.documentElement.style.setProperty('--blue', resolved.accent);
    document.documentElement.style.setProperty('--cyan', resolved.accent2);
    document.documentElement.style.setProperty('--canvas', resolved.canvas || base.canvas);
    document.documentElement.style.setProperty('--grid', resolved.grid || base.grid);
    activeTheme = name;
    const picker = $('#themeSelect');
    if (picker) picker.value = themeDefaults[name] ? name : 'dark';
    if (!isCustom) { try { localStorage.setItem('geoproof-theme', name); } catch (_) {} }
    window.dispatchEvent(new CustomEvent('geoproof:themechange', {detail:{name, tokens:resolved}}));
    return {name, tokens:resolved};
  }
  window.GeoProof = window.GeoProof || {};
  window.GeoProof.setTheme = setTheme;
  window.GeoProof.getTheme = () => ({name:activeTheme, tokens:Object.fromEntries(themeTokens.map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue('--'+({accent:'blue',accent2:'cyan'}[key]||key)).trim()]))});
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('geoproof-theme') || 'dark'; } catch (_) {}
  setTheme(savedTheme);

  // GEOMETRY / PROOF MODEL: mathematical coordinates and dependencies live here;
  // viewBox state, SVG nodes and pointer gesture state never enter project geometry.
  const state = {
    points: [], segments: [], circles: [], marks: [], constraints: [], angles: [], angleMarks: [], angleConstraints: [], steps: [],
    proofContexts: [], activeProofContextIds: [], proofCaseGroups: [], proofExistenceGroups: [], creatingAssumption: false,
    tool: 'select', selected: null, pending: [], pendingMode: null,
    drag: null, history: [], redoHistory: [], task: null, nextId: 1, editingStepId: null
  };
  // Selection of a connected geometric component is transient UI state, not project geometry.
  let selectedGroup = null;

  const help = {
    pan: 'Перемещение доски: перетаскивай поле одним пальцем или мышью. Масштабирование двумя пальцами доступно в любом режиме.',
    select: 'Выбор: свободные точки перемещаются по полю; точка на отрезке — вдоль него; точка на окружности — по её границе. Пересечение нескольких объектов можно перетаскивать: вместе с точкой параллельно перемещается вся связанная конфигурация.',
    group: 'Группа: нажми на точку, отрезок или окружность, чтобы выделить всю связную геометрическую компоненту. Перетаскивай любой её объект — все независимые управляющие точки сместятся на один вектор, сохраняя внутреннюю геометрию и ограничения. Группа определяется связями через общие вершины, зависимости и активные ограничения.',
    point: 'Единый инструмент: щёлкни по пустому месту для свободной точки; по отрезку или окружности — для зависимой точки. Выбери любую существующую точку, затем один или несколько отрезков, чтобы привязать её к ним. Если линия проходит прямо через маркер, повторное касание точки добавит следующую ещё не выбранную линию. Можно также последовательно выбирать другие точки: все отрезки будут использовать одну вершину. Повторное касание завершает операцию, когда под точкой больше нет несвязанных линий.',
    detach: 'Открепить: выбери существующую точку, затем связанный с ней отрезок. Если несколько отрезков проходят через маркер точки, повторные касания точки последовательно снимают связи. Точка и остальные её связи сохраняются. Если это была последняя зависимость, исходное построение восстанавливается или точка освобождается.',
    segment: 'Отрезок: щёлкни по первой и второй точке. На пустом месте точки создаются автоматически; рядом с существующими точками происходит привязка.',
    triangle: 'Треугольник: последовательно укажи три вершины. Можно использовать существующие точки или создавать новые.',
    circle: 'Окружность: первый щелчок задаёт центр. Второй щелчок по существующей точке связывает радиус с ней; щелчок по свободному месту задаёт числовой радиус без дополнительной точки. Числовой радиус можно менять перетаскиванием границы окружности.',
    midpoint: 'Середина: щёлкни по отрезку. Создастся зависимая точка, исходный отрезок сохранится, а два подотрезка от концов до середины появятся в модели автоматически.',
    parallel: 'Параллельность: выбери сначала исходный отрезок, затем целевой. Конец целевого отрезка станет зависимым, чтобы направление оставалось параллельным исходному.',
    perpendicular: 'Перпендикулярность: выбери сначала исходный отрезок, затем целевой. Целевой отрезок сохранит прямой угол с исходным при перемещении.',
    equalLength: 'Равная длина: выбери исходный отрезок, затем целевой. Длина целевого будет следовать за длиной исходного; направление целевого сохраняется.',
    intersection: 'Пересечение: выбери два объекта — отрезка и/или окружности. Будут созданы все действительные точки пересечения; пересечение прямых строится по их несущим прямым.',
    angle: 'Угол: укажи три точки в порядке A, B, C. Точка B — вершина угла; величина меньшего угла будет показана в градусах.',
    equalAngle: 'Равные углы: укажи A, B, C для первого угла, затем D, E, F для второго. Создаётся активное ограничение: конечный луч второго угла становится зависимым, его длина сохраняется, а величина угла следует за первым.',
    median: 'Медиана: щёлкни по вершине треугольника, затем по противоположной стороне. Редактор создаст середину стороны и отрезок медианы.',
    altitude: 'Высота: щёлкни по вершине, затем по отрезку, задающему основание. Основание высоты может лежать на продолжении стороны.',
    bisector: 'Биссектриса: укажи три точки A, B, C в порядке сторон угла ABC. Редактор создаст биссектрису и точку её пересечения со стороной AC.',
    delete: 'Удаление: щёлкни по точке, отрезку или окружности. Зависимые ограничения будут удалены или безопасно освобождены.'
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const id = () => `g${state.nextId++}`;
  const pointById = (pid) => state.points.find((p) => p.id === pid);
  const segmentById = (sid) => state.segments.find((s) => s.id === sid);
  const constraintById = (cid) => state.constraints.find((c) => c.id === cid);
  const angleConstraintById = (cid) => state.angleConstraints.find((c) => c.id === cid);

  function allPointNames() { return state.points.map((p) => p.name); }
  function nextPointName(kind = 'free') {
    if (kind === 'midpoint') {
      let name = 'M';
      let i = 1;
      while (allPointNames().includes(name)) name = `M${i++}`;
      return name;
    }
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!allPointNames().includes(letter)) return letter;
    let i = 1;
    while (allPointNames().includes(`P${i}`)) i++;
    return `P${i}`;
  }

  function modelSnapshot() {
    return JSON.stringify({
      points: state.points, segments: state.segments, circles: state.circles,
      marks: state.marks, constraints: state.constraints, angles: state.angles,
      angleMarks: state.angleMarks, angleConstraints: state.angleConstraints,
      steps: state.steps, proofContexts: state.proofContexts, activeProofContextIds: state.activeProofContextIds, proofCaseGroups: state.proofCaseGroups, proofExistenceGroups: state.proofExistenceGroups, task: state.task, nextId: state.nextId
    });
  }

  function pushHistory() {
    state.history.push(modelSnapshot());
    if (state.history.length > 60) state.history.shift();
    state.redoHistory = [];
  }

  function clearGestureState() {
    const captured = new Set([
      state.drag?.pointerId, panState?.pointerId, ...activePointers.keys()
    ].filter(Number.isInteger));
    state.drag = null;
    panState = null;
    pinchState = null;
    pendingTouchTap = null;
    activePointers.clear();
    gestureMode = 'idle';
    svg.classList.remove('is-panning');
    captured.forEach(releaseCapture);
  }

  function applyHistorySnapshot(snapshot) {
    clearGestureState();
    Object.assign(state, JSON.parse(snapshot));
    if(!Array.isArray(state.proofContexts)) state.proofContexts=[];
    if(!Array.isArray(state.activeProofContextIds)) state.activeProofContextIds=[];
    if(!Array.isArray(state.proofCaseGroups)) state.proofCaseGroups=[];
    if(!Array.isArray(state.proofExistenceGroups)) state.proofExistenceGroups=[];
    state.creatingAssumption=false;
    state.selected = null;
    selectedGroup = null;
    state.pending = [];
    state.pendingMode = null;
    state.drag = null;
    renderAll();
  }

  function restoreHistory() {
    if (!state.history.length) return;
    state.redoHistory.push(modelSnapshot());
    applyHistorySnapshot(state.history.pop());
  }

  function redoHistory() {
    if (!state.redoHistory.length) return;
    state.history.push(modelSnapshot());
    applyHistorySnapshot(state.redoHistory.pop());
  }

  function addPoint(x, y, kind = 'free', segmentId = null, t = null) {
    const point = { id: id(), name: nextPointName(kind), kind };
    if (kind === 'free') {
      point.x = x; point.y = y;
    } else if (kind === 'midpoint' || kind === 'onSegment') {
      point.segmentId = segmentId;
      if (kind === 'onSegment') point.t = t;
    }
    state.points.push(point);
    // A point on a segment changes the combinatorial geometry, not only its drawing.
    // Keep the original segment and explicitly create the adjacent subsegments.
    if (kind === 'midpoint' || kind === 'onSegment') {
      ensureSegmentSubdivision(segmentId);
    }
    return point;
  }

  function addSegment(a, b, metadata = null) {
    if (!a || !b || a.id === b.id) return null;
    const existing = state.segments.find((s) => (s.a === a.id && s.b === b.id) || (s.a === b.id && s.b === a.id));
    if (existing) return existing;
    const segment = { id: id(), a: a.id, b: b.id, ...(metadata||{}) };
    state.segments.push(segment);
    return segment;
  }

  // Preserve the parent segment and add all consecutive pieces induced by
  // points explicitly attached to it. This makes incidences usable by proof tools.
  function ensureSegmentSubdivision(segmentId) {
    const parent = segmentById(segmentId);
    if (!parent) return;
    const a = xy(pointById(parent.a));
    const b = xy(pointById(parent.b));
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 < 1e-10) return;
    const attached = state.points
      .filter(point => point.id !== parent.a && point.id !== parent.b &&
        (point.kind === 'midpoint' || point.kind === 'onSegment') && point.segmentId === segmentId)
      .map(point => {
        const p = xy(point);
        return { point, t: ((p.x-a.x)*dx + (p.y-a.y)*dy) / length2 };
      })
      .filter(item => item.t > 1e-8 && item.t < 1-1e-8)
      .sort((u,v) => u.t-v.t);
    const chain = [pointById(parent.a), ...attached.map(item => item.point), pointById(parent.b)];
    for (let i=0; i<chain.length-1; i++) addSegment(chain[i], chain[i+1], {subdivisionParentId:parent.id,subdivisionGenerated:true});
  }

  function syncAllSegmentSubdivisions() {
    // Called after loading legacy projects as well as normalizing the live model.
    for (const segment of [...state.segments]) ensureSegmentSubdivision(segment.id);
  }

  function addCircle(center, radius, radiusPointId = null) {
    if (!center || !Number.isFinite(radius) || radius <= 1e-7) return null;
    if (radiusPointId && (radiusPointId === center.id || !pointById(radiusPointId))) return null;
    const circle = { id: id(), centerId: center.id, radius };
    if (radiusPointId) circle.radiusPointId = radiusPointId;
    state.circles.push(circle);
    return circle;
  }

  function circleRadiusPointId(circle) {
    return circle?.radiusPointId || circle?.rimId || null;
  }

  function normalizeCircle(circle) {
    if (!circle) return circle;
    if (!circle.radiusPointId && circle.rimId) circle.radiusPointId = circle.rimId;
    delete circle.rimId;
    if (!Number.isFinite(circle.radius)) circle.radius = 0;
    return circle;
  }

  // Coordinates of dependent points are derived from their geometric parents.
  // This is the key invariant: constraints are stored as relationships, not screen positions.
  function xy(point, visited = new Set()) {
    if (!point) return { x: 0, y: 0 };
    if (visited.has(point.id)) return { x: point.x || 0, y: point.y || 0 };
    const chain = new Set(visited);
    chain.add(point.id);

    if (point.kind === 'onCircle') {
      const circle = state.circles.find(item => item.id === point.circleId);
      const geometry = circleGeometry(circle);
      if (!geometry) return { x: point.x || 0, y: point.y || 0 };
      return { x: geometry.center.x + geometry.radius * Math.cos(point.angle || 0), y: geometry.center.y + geometry.radius * Math.sin(point.angle || 0) };
    }

    // A constrained point may belong to any number of segment lines.
    // One line leaves one degree of freedom (parameter t); two independent
    // lines determine a unique intersection. Further lines are incidence
    // constraints checked by isPointAvailable().
    if (point.kind === 'constrainedPoint') {
      const attachments = Array.isArray(point.lineAttachments) ? point.lineAttachments : [];
      const getEnds = attachment => {
        const segment = segmentById(attachment.segmentId);
        if (!segment) return null;
        return { segment, a:xy(pointById(segment.a), chain), b:xy(pointById(segment.b), chain) };
      };
      if (attachments.length === 1) {
        const ends = getEnds(attachments[0]);
        if (!ends) return {x:point.x||0,y:point.y||0};
        const t = Number.isFinite(attachments[0].t) ? attachments[0].t : 0.5;
        return {x:ends.a.x+(ends.b.x-ends.a.x)*t,y:ends.a.y+(ends.b.y-ends.a.y)*t};
      }
      if (attachments.length >= 2) {
        const segments=attachments.map(item=>segmentById(item.segmentId));
        if (segments.some(segment=>!segment)) return {x:point.x||0,y:point.y||0};
        // Use any independent pair, not necessarily the first two. This lets
        // redundant collinear attachments coexist with a third crossing line.
        for (let i=0;i<segments.length;i++) {
          for (let j=i+1;j<segments.length;j++) {
            const intersection=lineIntersection(segments[i],segments[j]);
            if (intersection) return intersection;
          }
        }
        // If every attached segment lies on the same supporting line, the
        // first segment's parameter retains the one remaining degree of freedom.
        if (segments.every(segment=>segmentsShareSupportingLine(segments[0],segment))) {
          const first=getEnds(attachments[0]);
          const t=Number.isFinite(attachments[0].t)?attachments[0].t:0.5;
          if (first) return {x:first.a.x+(first.b.x-first.a.x)*t,y:first.a.y+(first.b.y-first.a.y)*t};
        }
      }
      return {x:point.x||0,y:point.y||0};
    }

    if (point.kind === 'midpoint' || point.kind === 'onSegment') {
      const segment = segmentById(point.segmentId);
      if (!segment) return { x: point.x || 0, y: point.y || 0 };
      const a = xy(pointById(segment.a), chain);
      const b = xy(pointById(segment.b), chain);
      const t = point.kind === 'midpoint' ? 0.5 : Math.max(0, Math.min(1, point.t ?? 0.5));
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }

    if (point.kind === 'intersection') {
      const first = segmentById(point.segment1Id);
      const second = segmentById(point.segment2Id);
      if (first && second) {
        const a = xy(pointById(first.a), chain); const b = xy(pointById(first.b), chain);
        const c = xy(pointById(second.a), chain); const d = xy(pointById(second.b), chain);
        const cross = (b.x-a.x)*(d.y-c.y) - (b.y-a.y)*(d.x-c.x);
        if (Math.abs(cross) > 1e-8) {
          const t = ((c.x-a.x)*(d.y-c.y) - (c.y-a.y)*(d.x-c.x)) / cross;
          return { x: a.x + t*(b.x-a.x), y: a.y + t*(b.y-a.y) };
        }
      }
      return { x: point.x || 0, y: point.y || 0 };
    }

    if (point.kind === 'curveIntersection') {
      const candidates = intersectionCandidates(
        {kind:point.parent1Kind,id:point.parent1Id},
        {kind:point.parent2Kind,id:point.parent2Id}
      );
      const result = candidates[point.branch || 0];
      if (result) return result;
      return { x: point.x || 0, y: point.y || 0 };
    }

    if (point.kind === 'projection') {
      const source = pointById(point.sourcePointId); const base = segmentById(point.segmentId);
      if (source && base) {
        const p = xy(source, chain); const a = xy(pointById(base.a), chain); const b = xy(pointById(base.b), chain);
        const dx = b.x-a.x, dy = b.y-a.y, den = dx*dx+dy*dy;
        if (den > 1e-8) {
          const t = ((p.x-a.x)*dx+(p.y-a.y)*dy)/den;
          return { x: a.x+t*dx, y: a.y+t*dy };
        }
      }
      return { x: point.x || 0, y: point.y || 0 };
    }

    if (point.kind === 'angleBisector') {
      const aPoint = pointById(point.aId); const vPoint = pointById(point.vertexId); const cPoint = pointById(point.cId);
      if (aPoint && vPoint && cPoint) {
        const a = xy(aPoint, chain); const v = xy(vPoint, chain); const c = xy(cPoint, chain);
        const ab = Math.hypot(a.x-v.x, a.y-v.y); const cb = Math.hypot(c.x-v.x, c.y-v.y);
        if (ab+cb > 1e-8) {
          const t = ab/(ab+cb);
          return { x: a.x+(c.x-a.x)*t, y: a.y+(c.y-a.y)*t };
        }
      }
      return { x: point.x || 0, y: point.y || 0 };
    }

    if (point.kind === 'angleConstraintEndpoint') {
      const constraint = angleConstraintById(point.angleConstraintId);
      if (constraint) {
        const sourceInfo = angleData(constraint.sourceAngle);
        const targetA = pointById(constraint.targetAngle.aId);
        const targetVertex = pointById(constraint.targetAngle.vertexId);
        if (sourceInfo && targetA && targetVertex) {
          const a = xy(targetA, chain); const v = xy(targetVertex, chain);
          const start = Math.atan2(a.y - v.y, a.x - v.x);
          const delta = Math.abs(sourceInfo.delta) * (constraint.orientationSign || 1);
          const end = start + delta;
          return { x: v.x + constraint.targetLength * Math.cos(end), y: v.y + constraint.targetLength * Math.sin(end) };
        }
      }
      return { x: point.x || 0, y: point.y || 0 };
    }

    if (point.kind === 'constraintEndpoint') {
      const constraint = constraintById(point.constraintId);
      const target = constraint && segmentById(constraint.targetSegmentId);
      const source = constraint && segmentById(constraint.sourceSegmentId);
      if (constraint && target && source) {
        const anchor = xy(pointById(target.a), chain);
        const sa = xy(pointById(source.a), chain);
        const sb = xy(pointById(source.b), chain);
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const sourceLength = Math.hypot(dx, dy);
        if (sourceLength > 1e-8) {
          const ux = dx / sourceLength;
          const uy = dy / sourceLength;
          let vx = constraint.unitX;
          let vy = constraint.unitY;
          let length = constraint.targetLength;
          if (constraint.type === 'parallel') {
            vx = ux * constraint.sign;
            vy = uy * constraint.sign;
          } else if (constraint.type === 'perpendicular') {
            vx = -uy * constraint.sign;
            vy = ux * constraint.sign;
          } else if (constraint.type === 'equalLength') {
            length = sourceLength;
          }
          return { x: anchor.x + vx * length, y: anchor.y + vy * length };
        }
      }
    }

    return { x: point.x || 0, y: point.y || 0 };
  }

  function projectToSegment(p, segment) {
    const a = xy(pointById(segment.a));
    const b = xy(pointById(segment.b));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denominator = dx * dx + dy * dy;
    const t = denominator < 1e-8 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator));
    return { t, x: a.x + dx * t, y: a.y + dy * t };
  }

  function lineIntersection(seg1, seg2) {
    if (!seg1 || !seg2) return null;
    const a = xy(pointById(seg1.a)); const b = xy(pointById(seg1.b));
    const c = xy(pointById(seg2.a)); const d = xy(pointById(seg2.b));
    const dx1 = b.x-a.x, dy1 = b.y-a.y, dx2 = d.x-c.x, dy2 = d.y-c.y;
    const den = dx1*dy2-dy1*dx2;
    if (Math.abs(den) < 1e-8) return null;
    const t = ((c.x-a.x)*dy2-(c.y-a.y)*dx2)/den;
    const result = { x:a.x+t*dx1, y:a.y+t*dy1 };
    return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
  }

  function segmentsShareSupportingLine(first,second) {
    if (!first||!second) return false;
    const a=xy(pointById(first.a)),b=xy(pointById(first.b));
    const c=xy(pointById(second.a)),d=xy(pointById(second.b));
    const dx1=b.x-a.x,dy1=b.y-a.y,dx2=d.x-c.x,dy2=d.y-c.y;
    const len1=Math.hypot(dx1,dy1),len2=Math.hypot(dx2,dy2);
    if (len1<1e-8||len2<1e-8) return false;
    const directionCross=dx1*dy2-dy1*dx2;
    if (Math.abs(directionCross)>1e-7*len1*len2) return false;
    const offsetCross=(c.x-a.x)*dy1-(c.y-a.y)*dx1;
    return Math.abs(offsetCross)<=1e-6*Math.max(1,len1);
  }

  function circleGeometry(circle) {
    if (!circle) return null;
    const centerPoint = pointById(circle.centerId);
    if (!centerPoint) return null;
    const center = xy(centerPoint);
    const radiusPointId = circleRadiusPointId(circle);
    let radius = Math.max(0, Number(circle.radius) || 0);
    if (radiusPointId) {
      const radiusPoint = pointById(radiusPointId);
      if (!radiusPoint) return null;
      const rim = xy(radiusPoint);
      radius = Math.hypot(rim.x-center.x,rim.y-center.y);
    }
    return {center,radius};
  }

  function lineCircleIntersections(segment,circle) {
    const a=xy(pointById(segment.a)), b=xy(pointById(segment.b));
    const cg=circleGeometry(circle); if (!cg) return [];
    const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy;
    if (len2<1e-8) return [];
    const t=((cg.center.x-a.x)*dx+(cg.center.y-a.y)*dy)/len2;
    const foot={x:a.x+t*dx,y:a.y+t*dy};
    const dist2=(foot.x-cg.center.x)**2+(foot.y-cg.center.y)**2;
    const h2=cg.radius*cg.radius-dist2;
    const tolerance=1e-10*Math.max(1e-12,cg.radius*cg.radius,dist2);
    if (h2 < -tolerance) return [];
    if (Math.abs(h2)<=tolerance) return [foot];
    const offset=Math.sqrt(Math.max(0,h2)/len2);
    return [
      {x:a.x+(t-offset)*dx,y:a.y+(t-offset)*dy},
      {x:a.x+(t+offset)*dx,y:a.y+(t+offset)*dy}
    ];
  }

  function circleCircleIntersections(first,second) {
    const g1=circleGeometry(first), g2=circleGeometry(second); if (!g1||!g2) return [];
    const dx=g2.center.x-g1.center.x, dy=g2.center.y-g1.center.y;
    const d=Math.hypot(dx,dy), r1=g1.radius, r2=g2.radius;
    const lengthTolerance=1e-10*Math.max(1e-6,d,r1,r2);
    if (d<=lengthTolerance || d>r1+r2+lengthTolerance || d<Math.abs(r1-r2)-lengthTolerance) return [];
    const along=(r1*r1-r2*r2+d*d)/(2*d);
    const h2=r1*r1-along*along;
    const heightTolerance=1e-10*Math.max(1e-12,r1*r1,along*along);
    if (h2 < -heightTolerance) return [];
    const base={x:g1.center.x+along*dx/d,y:g1.center.y+along*dy/d};
    if (Math.abs(h2)<=heightTolerance) return [base];
    const h=Math.sqrt(Math.max(0,h2)), px=-dy/d, py=dx/d;
    return [
      {x:base.x+h*px,y:base.y+h*py},
      {x:base.x-h*px,y:base.y-h*py}
    ];
  }

  function intersectionCandidates(first,second) {
    if (!first||!second||first.kind===second.kind&&first.id===second.id) return [];
    if (first.kind==='segment'&&second.kind==='segment') {
      const result=lineIntersection(segmentById(first.id),segmentById(second.id));
      return result?[result]:[];
    }
    if (first.kind==='segment'&&second.kind==='circle') return lineCircleIntersections(segmentById(first.id),state.circles.find(c=>c.id===second.id));
    if (first.kind==='circle'&&second.kind==='segment') return lineCircleIntersections(segmentById(second.id),state.circles.find(c=>c.id===first.id));
    if (first.kind==='circle'&&second.kind==='circle') return circleCircleIntersections(state.circles.find(c=>c.id===first.id),state.circles.find(c=>c.id===second.id));
    return [];
  }

  function geometryById(ref) {
    if (!ref) return null;
    return ref.kind==='segment' ? segmentById(ref.id) : ref.kind==='circle' ? state.circles.find(c=>c.id===ref.id) : null;
  }

  function clickedGeometry(target,position) {
    const hit = hitTest(position, currentPointerType, true);
    return hit && (hit.kind === 'segment' || hit.kind === 'circle') ? {kind:hit.kind,id:hit.id} : null;
  }

  function angleData(angle) {
    const aPoint = pointById(angle.aId), vPoint = pointById(angle.vertexId), cPoint = pointById(angle.cId);
    if (!aPoint || !vPoint || !cPoint) return null;
    const a = xy(aPoint), v = xy(vPoint), c = xy(cPoint);
    const start = Math.atan2(a.y-v.y, a.x-v.x);
    const end = Math.atan2(c.y-v.y, c.x-v.x);
    let delta = end-start;
    while (delta > Math.PI) delta -= Math.PI*2;
    while (delta < -Math.PI) delta += Math.PI*2;
    const radiusA = Math.hypot(a.x-v.x,a.y-v.y), radiusC = Math.hypot(c.x-v.x,c.y-v.y);
    if (radiusA < 1e-7 || radiusC < 1e-7) return null;
    return { a, v, c, start, delta, degrees: Math.abs(delta)*180/Math.PI, radius: 25, mid: start+delta/2 };
  }

  // Dependency graph: every derived point explicitly exposes its parent points.
  // A child may only depend on parents whose dependency chain does not lead back to it.
  function pointParentIds(point) {
    if (!point) return [];
    if (point.kind === 'constrainedPoint') {
      const ids=[];
      for (const attachment of (point.lineAttachments || [])) {
        const segment=segmentById(attachment.segmentId);
        if (segment) ids.push(segment.a,segment.b);
      }
      return [...new Set(ids)];
    }
    if (point.kind === 'midpoint' || point.kind === 'onSegment') {
      const segment = segmentById(point.segmentId); return segment ? [segment.a, segment.b] : [];
    }
    if (point.kind === 'onCircle') {
      const circle = state.circles.find(item => item.id === point.circleId);
      return circle ? [circle.centerId, circleRadiusPointId(circle)].filter(Boolean) : [];
    }
    if (point.kind === 'intersection') {
      const a = segmentById(point.segment1Id), b = segmentById(point.segment2Id);
      return a && b ? [a.a, a.b, b.a, b.b] : [];
    }
    if (point.kind === 'curveIntersection') {
      const ids = [];
      for (const ref of [{kind:point.parent1Kind,id:point.parent1Id},{kind:point.parent2Kind,id:point.parent2Id}]) {
        if (ref.kind === 'segment') { const seg=segmentById(ref.id); if (seg) ids.push(seg.a,seg.b); }
        if (ref.kind === 'circle') { const circle=state.circles.find(c=>c.id===ref.id); if (circle) ids.push(circle.centerId,...[circleRadiusPointId(circle)].filter(Boolean)); }
      }
      return ids;
    }
    if (point.kind === 'projection') {
      const seg=segmentById(point.segmentId); return seg ? [point.sourcePointId,seg.a,seg.b] : [point.sourcePointId];
    }
    if (point.kind === 'angleBisector') return [point.aId,point.vertexId,point.cId];
    if (point.kind === 'constraintEndpoint') {
      const c=constraintById(point.constraintId); const target=c&&segmentById(c.targetSegmentId); const source=c&&segmentById(c.sourceSegmentId);
      return target&&source ? [target.a,source.a,source.b] : [];
    }
    if (point.kind === 'angleConstraintEndpoint') {
      const c=angleConstraintById(point.angleConstraintId);
      return c ? [c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId] : [];
    }
    return [];
  }

  // A derived intersection has no independent coordinates of its own. To move it,
  // translate the complete dependency closure of its parent objects. Only free
  // points are independent drivers; all other points and geometry follow from
  // their existing mathematical relationships. Shared drivers are translated once.
  function collectTranslationDrivers(pointId, visiting = new Set(), drivers = new Map()) {
    const point = pointById(pointId);
    if (!point || visiting.has(pointId)) return false;
    if (point.kind === 'free') {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      drivers.set(point.id, {id:point.id, x:point.x, y:point.y});
      return true;
    }
    const parents = pointParentIds(point);
    if (!parents.length) return false;
    const next = new Set(visiting);
    next.add(pointId);
    for (const parentId of parents) {
      if (!collectTranslationDrivers(parentId, next, drivers)) return false;
    }
    return true;
  }

  function hasIndependentLinePair(point) {
    const attachments = point?.lineAttachments || [];
    const segments = attachments.map(item => segmentById(item.segmentId));
    return segments.some((segment, index) =>
      !!segment && segments.slice(index + 1).some(other => !!other && !!lineIntersection(segment, other))
    );
  }

  function isCollinearMultiLinePoint(point) {
    const attachments = point?.lineAttachments || [];
    if (attachments.length < 2 || hasIndependentLinePair(point)) return false;
    const segments = attachments.map(item => segmentById(item.segmentId));
    return segments.every(Boolean) && segments.every(segment => segmentsShareSupportingLine(segments[0], segment));
  }

  function createRigidTranslationPlan(point) {
    const canMoveParents = point && (
      point.kind === 'intersection' ||
      point.kind === 'curveIntersection' ||
      (point.kind === 'constrainedPoint' && (point.lineAttachments || []).length >= 2 && hasIndependentLinePair(point))
    );
    if (!canMoveParents) return null;
    const parentIds = pointParentIds(point);
    if (!parentIds.length) return null;
    const drivers = new Map();
    for (const parentId of parentIds) {
      if (!collectTranslationDrivers(parentId, new Set([point.id]), drivers)) return null;
    }
    if (!drivers.size) return null;
    return [...drivers.values()];
  }

  // Build the undirected connectivity graph of the construction. A component
  // includes shared vertices, derived-point dependencies, circle centres/radii,
  // and active constraints. This is the unit manipulated by the Group tool.
  function collectConnectedGeometry(seed) {
    if (!seed || !['point','segment','circle'].includes(seed.kind)) return null;
    const adjacency = new Map();
    const node = (kind,id) => `${kind}:${id}`;
    const ensure = key => { if (!adjacency.has(key)) adjacency.set(key,new Set()); return adjacency.get(key); };
    const link = (a,b) => { if (!a || !b) return; ensure(a).add(b); ensure(b).add(a); };
    state.points.forEach(item=>ensure(node('point',item.id)));
    state.segments.forEach(item=>ensure(node('segment',item.id)));
    state.circles.forEach(item=>ensure(node('circle',item.id)));
    state.constraints.forEach(item=>ensure(node('constraint',item.id)));
    state.angleConstraints.forEach(item=>ensure(node('angleConstraint',item.id)));

    for (const segment of state.segments) {
      link(node('segment',segment.id),node('point',segment.a));
      link(node('segment',segment.id),node('point',segment.b));
    }
    for (const circle of state.circles) {
      link(node('circle',circle.id),node('point',circle.centerId));
      const radiusId=circleRadiusPointId(circle);
      if (radiusId) link(node('circle',circle.id),node('point',radiusId));
    }
    for (const point of state.points) {
      const p=node('point',point.id);
      if (point.kind==='constrainedPoint') {
        (point.lineAttachments||[]).forEach(item=>link(p,node('segment',item.segmentId)));
      } else if (point.kind==='midpoint'||point.kind==='onSegment'||point.kind==='projection') {
        if (point.segmentId) link(p,node('segment',point.segmentId));
        if (point.sourcePointId) link(p,node('point',point.sourcePointId));
      } else if (point.kind==='onCircle') {
        link(p,node('circle',point.circleId));
      } else if (point.kind==='intersection') {
        link(p,node('segment',point.segment1Id)); link(p,node('segment',point.segment2Id));
      } else if (point.kind==='curveIntersection') {
        link(p,node(point.parent1Kind,point.parent1Id)); link(p,node(point.parent2Kind,point.parent2Id));
      } else if (point.kind==='angleBisector') {
        [point.aId,point.vertexId,point.cId].forEach(id=>link(p,node('point',id)));
      } else if (point.kind==='constraintEndpoint') {
        link(p,node('constraint',point.constraintId));
      } else if (point.kind==='angleConstraintEndpoint') {
        link(p,node('angleConstraint',point.angleConstraintId));
      }
    }
    for (const constraint of state.constraints) {
      const c=node('constraint',constraint.id);
      link(c,node('segment',constraint.sourceSegmentId));
      link(c,node('segment',constraint.targetSegmentId));
    }
    for (const constraint of state.angleConstraints) {
      const c=node('angleConstraint',constraint.id);
      const ids=[constraint.sourceAngle.aId,constraint.sourceAngle.vertexId,constraint.sourceAngle.cId,
        constraint.targetAngle.aId,constraint.targetAngle.vertexId,constraint.targetAngle.cId];
      ids.forEach(id=>link(c,node('point',id)));
    }

    const start=node(seed.kind,seed.id);
    if (!adjacency.has(start)) return null;
    const visited=new Set([start]), stack=[start];
    while(stack.length) {
      const current=stack.pop();
      for(const next of adjacency.get(current)||[]) if(!visited.has(next)){visited.add(next);stack.push(next);}
    }
    const split={points:[],segments:[],circles:[],constraints:[],angleConstraints:[]};
    for(const key of visited){
      const i=key.indexOf(':'),kind=key.slice(0,i),id=key.slice(i+1);
      if(split[`${kind}s`]) split[`${kind}s`].push(id);
      else if(kind==='angleConstraint') split.angleConstraints.push(id);
      else if(kind==='constraint') split.constraints.push(id);
    }
    const drivers=new Map();
    for(const pointId of split.points){
      const point=pointById(pointId);
      if(point?.kind==='free' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        drivers.set(point.id,{id:point.id,x:point.x,y:point.y});
      }
    }
    return {...split,drivers:[...drivers.values()],seed:{kind:seed.kind,id:seed.id}};
  }

  function isInSelectedGroup(kind,id) {
    if(!selectedGroup) return false;
    const key=`${kind}s`;
    return (selectedGroup[key]||[]).includes(id);
  }

  // A dependent object may remain in the project while its geometric
  // construction is temporarily impossible (for example, two circles stop
  // intersecting). Availability is derived from the dependency graph; stale
  // coordinates are never treated as a currently existing point.
  function isPointAvailable(pointOrId, visiting = new Set()) {
    const point = typeof pointOrId === 'string' ? pointById(pointOrId) : pointOrId;
    if (!point || !point.id || visiting.has(point.id)) return false;
    if (point.kind === 'free') return Number.isFinite(point.x) && Number.isFinite(point.y);

    const next = new Set(visiting);
    next.add(point.id);
    const parents = pointParentIds(point);
    if (!parents.length || parents.some(parentId => !pointById(parentId) || !isPointAvailable(parentId, next))) return false;

    if (point.kind === 'constrainedPoint') {
      const attachments=Array.isArray(point.lineAttachments)?point.lineAttachments:[];
      if (!attachments.length) return false;
      const segments=attachments.map(item=>segmentById(item.segmentId));
      if (segments.some(segment=>!segment||!isSegmentAvailable(segment))) return false;
      if (attachments.length===1) {
        const t=Number(attachments[0].t);
        return Number.isFinite(t) && (attachments[0].extent==='line' || (t>=-1e-7 && t<=1+1e-7));
      }
      if (attachments.length>=2) {
        const hasIndependentPair=segments.some((segment,index)=>segments.slice(index+1).some(other=>!!lineIntersection(segment,other)));
        const allCollinear=segments.every(segment=>segmentsShareSupportingLine(segments[0],segment));
        if (!hasIndependentPair&&!allCollinear) return false;
      }
      const position=xy(point);
      if (!Number.isFinite(position.x)||!Number.isFinite(position.y)) return false;
      for (let i=0;i<attachments.length;i++) {
        const segment=segments[i];
        const a=xy(pointById(segment.a)), b=xy(pointById(segment.b));
        const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
        if (den<1e-12) return false;
        const t=((position.x-a.x)*dx+(position.y-a.y)*dy)/den;
        const projected={x:a.x+t*dx,y:a.y+t*dy};
        const tolerance=1e-6*Math.max(1,Math.sqrt(den));
        if (Math.hypot(position.x-projected.x,position.y-projected.y)>tolerance) return false;
        if (attachments[i].extent!=='line' && (t<-1e-7||t>1+1e-7)) return false;
      }
      return true;
    }
    if (point.kind === 'midpoint' || point.kind === 'onSegment') {
      return !!segmentById(point.segmentId);
    }
    if (point.kind === 'onCircle') {
      const circle = state.circles.find(item => item.id === point.circleId);
      const geometry = circleGeometry(circle);
      return !!geometry && Number.isFinite(geometry.radius) && geometry.radius > 1e-7;
    }
    if (point.kind === 'intersection') {
      const first = segmentById(point.segment1Id), second = segmentById(point.segment2Id);
      return !!first && !!second && !!lineIntersection(first, second);
    }
    if (point.kind === 'curveIntersection') {
      const first = {kind:point.parent1Kind,id:point.parent1Id};
      const second = {kind:point.parent2Kind,id:point.parent2Id};
      const candidates = intersectionCandidates(first, second);
      const branch = Number.isInteger(point.branch) ? point.branch : 0;
      return !!candidates[branch];
    }
    if (point.kind === 'projection') {
      const segment = segmentById(point.segmentId);
      if (!segment) return false;
      const a = xy(pointById(segment.a)), b = xy(pointById(segment.b));
      return (b.x-a.x)**2 + (b.y-a.y)**2 > 1e-10;
    }
    if (point.kind === 'angleBisector') {
      const a = xy(pointById(point.aId)), v = xy(pointById(point.vertexId)), c = xy(pointById(point.cId));
      return Math.hypot(a.x-v.x,a.y-v.y) > 1e-7 && Math.hypot(c.x-v.x,c.y-v.y) > 1e-7;
    }
    if (point.kind === 'constraintEndpoint') {
      const constraint = constraintById(point.constraintId);
      return !!constraint && !!segmentById(constraint.sourceSegmentId) && !!segmentById(constraint.targetSegmentId);
    }
    if (point.kind === 'angleConstraintEndpoint') {
      const constraint = angleConstraintById(point.angleConstraintId);
      return !!constraint && !!angleData(constraint.sourceAngle) && !!pointById(constraint.targetAngle.vertexId);
    }
    return false;
  }

  function isSegmentAvailable(segment) {
    if (!segment) return false;
    return isPointAvailable(segment.a) && isPointAvailable(segment.b);
  }

  function isCircleAvailable(circle) {
    if (!circle || !isPointAvailable(circle.centerId)) return false;
    const radiusPointId = circleRadiusPointId(circle);
    if (radiusPointId && !isPointAvailable(radiusPointId)) return false;
    const geometry = circleGeometry(circle);
    return !!geometry && Number.isFinite(geometry.radius) && geometry.radius > 1e-7;
  }

  function isAngleAvailable(angle) {
    if (!angle || ![angle.aId,angle.vertexId,angle.cId].every(pointId => isPointAvailable(pointId))) return false;
    return !!angleData(angle);
  }

  function pointDependsOn(pointId, ancestorId, visited = new Set()) {
    if (!pointId) return false;
    if (pointId === ancestorId) return true;
    if (visited.has(pointId)) return false;
    visited.add(pointId);
    const point = pointById(pointId);
    return pointParentIds(point).some(parentId => pointDependsOn(parentId, ancestorId, visited));
  }

  function wouldCreateDependencyCycle(childId, parentIds) {
    return parentIds.some(parentId => parentId === childId || pointDependsOn(parentId, childId));
  }

  function modelDependencyCycles() {
    const visiting = new Set(), visited = new Set(), cycles = [];
    function visit(pid, path) {
      if (visiting.has(pid)) { cycles.push([...path.slice(path.indexOf(pid)), pid]); return; }
      if (visited.has(pid)) return;
      visiting.add(pid);
      const point = pointById(pid);
      for (const parentId of pointParentIds(point)) if (pointById(parentId)) visit(parentId, [...path,pid]);
      visiting.delete(pid); visited.add(pid);
    }
    state.points.forEach(point => visit(point.id, []));
    return cycles;
  }

  function validateModel() {
    const issues = [];
    for (const segment of state.segments) {
      const a=pointById(segment.a), b=pointById(segment.b);
      if (!a || !b) issues.push('Отрезок ссылается на отсутствующую точку.');
      else { const p=xy(a), q=xy(b); if (Math.hypot(q.x-p.x,q.y-p.y)<1e-6) issues.push(`Отрезок ${displaySegmentName(segment)} вырожден: его концы совпадают.`); }
    }
    for (const circle of state.circles) {
      const geometry = circleGeometry(circle);
      if (!geometry) issues.push('Окружность ссылается на отсутствующий центр или радиусную опорную точку.');
      else if (!Number.isFinite(geometry.radius) || geometry.radius < 1e-6) issues.push('Окружность вырождена: радиус равен нулю или не является конечным числом.');
    }
    for (const point of state.points) {
      for (const parentId of pointParentIds(point)) if (!pointById(parentId)) issues.push(`Точка ${point.name} ссылается на отсутствующую родительскую точку.`);
      if (point.kind==='onSegment' && (!segmentById(point.segmentId) || point.t < -1e-8 || point.t > 1+1e-8)) issues.push(`Привязка точки ${point.name} к отрезку повреждена.`);
      if (point.kind==='constrainedPoint' && !isPointAvailable(point)) issues.push(`Линейные связи точки ${point.name} не имеют общего допустимого положения.`);
      if (point.kind==='onCircle' && !state.circles.some(circle => circle.id === point.circleId)) issues.push(`Привязка точки ${point.name} к окружности повреждена.`);
      if (point.kind==='curveIntersection' || point.kind==='intersection') {
        if (!isPointAvailable(point)) issues.push(`Точка пересечения ${point.name} временно скрыта: родительские объекты сейчас не имеют этой точки пересечения.`);
      }
    }
    for (const c of state.constraints) {
      const source=segmentById(c.sourceSegmentId), target=segmentById(c.targetSegmentId);
      if (!source||!target||!pointById(c.targetPointId)) { issues.push('Ограничение отрезков потеряло один из объектов.'); continue; }
      const sa=xy(pointById(source.a)), sb=xy(pointById(source.b)), ta=xy(pointById(target.a)), tb=xy(pointById(target.b));
      const sx=sb.x-sa.x, sy=sb.y-sa.y, tx=tb.x-ta.x, ty=tb.y-ta.y;
      const sl=Math.hypot(sx,sy), tl=Math.hypot(tx,ty);
      if (sl<1e-7||tl<1e-7) issues.push('Одно из ограниченных отношением отрезков выродилось.');
      else if (c.type==='parallel' && Math.abs(sx*ty-sy*tx)/(sl*tl)>1e-5) issues.push('Ограничение параллельности не выполняется.');
      else if (c.type==='perpendicular' && Math.abs(sx*tx+sy*ty)/(sl*tl)>1e-5) issues.push('Ограничение перпендикулярности не выполняется.');
      else if (c.type==='equalLength' && Math.abs(sl-tl)>1e-5) issues.push('Ограничение равенства длин не выполняется.');
    }
    for (const c of state.angleConstraints) {
      const refs=[c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId,c.targetAngle.cId,c.targetPointId];
      if (refs.some(pid=>!pointById(pid))) { issues.push('Ограничение равенства углов потеряло одну из точек.'); continue; }
      const sourceInfo=angleData(c.sourceAngle), targetInfo=angleData(c.targetAngle);
      if (!sourceInfo || !targetInfo) issues.push('Один из углов в активном ограничении вырожден.');
      else if (Math.abs(sourceInfo.degrees-targetInfo.degrees)>1e-4) issues.push('Активное ограничение равенства углов не выполняется.');
    }
    if (modelDependencyCycles().length) issues.push('Обнаружен цикл зависимостей между геометрическими точками.');
    return issues;
  }

  function renderModelValidation() {
    const issues=validateModel();
    const status=$('#modelState'), list=$('#modelIssues');
    if (!status || !list) return;
    list.replaceChildren();
    if (!issues.length) {
      status.textContent='Модель корректна'; status.className='model-state';
      const li=document.createElement('li'); li.className='ok'; li.textContent='Ссылки на объекты и цепочки зависимостей согласованы; вырожденных отрезков и окружностей не обнаружено.'; list.append(li);
    } else {
      status.textContent=`Замечаний: ${issues.length}`; status.className='model-state warn';
      issues.slice(0,8).forEach(message=>{const li=document.createElement('li');li.textContent=message;list.append(li);});
      if (issues.length>8) {const li=document.createElement('li');li.textContent=`И ещё ${issues.length-8} замечаний.`;list.append(li);}
    }
  }

  function worldToScreen(point) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return {x:point.x,y:point.y};
    const p = svg.createSVGPoint(); p.x = point.x; p.y = point.y;
    const screen = p.matrixTransform(matrix);
    return {x:screen.x,y:screen.y};
  }

  function screenDistance(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (!length2) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  let lastHitCycle = {signature:'', index:0, at:0};
  function hitTest(position, pointerType = 'mouse', cycleOverlaps = false) {
    const query = worldToScreen(position);
    const touch = pointerType === 'touch' || pointerType === 'pen';
    const tolerances = touch ? {point:25,segment:21,circle:22} : {point:13,segment:11,circle:12};
    const priority = {point:0,segment:1,circle:2};
    const candidates = [];

    for (const point of state.points) {
      if (!isPointAvailable(point)) continue;
      const screen = worldToScreen(xy(point));
      const distance = screenDistance(query,screen);
      if (distance <= tolerances.point) candidates.push({kind:'point',id:point.id,distance,priority:priority.point});
    }
    for (const segment of state.segments) {
      if (!isSegmentAvailable(segment)) continue;
      const a = worldToScreen(xy(pointById(segment.a)));
      const b = worldToScreen(xy(pointById(segment.b)));
      const distance = distToSegment(query,a,b);
      if (distance <= tolerances.segment) candidates.push({kind:'segment',id:segment.id,distance,priority:priority.segment});
    }
    for (const circle of state.circles) {
      if (!isCircleAvailable(circle)) continue;
      const data = circleGeometry(circle);
      if (!data) continue;
      const center = worldToScreen(data.center);
      const edge = worldToScreen({x:data.center.x+data.radius,y:data.center.y});
      const radiusPixels = screenDistance(center,edge);
      const distance = Math.abs(screenDistance(query,center)-radiusPixels);
      if (distance <= tolerances.circle) candidates.push({kind:'circle',id:circle.id,distance,priority:priority.circle});
    }
    if (!candidates.length) return null;
    candidates.sort((a,b) => a.distance-b.distance || a.priority-b.priority);
    const nearestDistance = candidates[0].distance;
    // Apply priority only inside a tight near-tie band around the true nearest hit.
    // This avoids a non-transitive comparator when several objects overlap.
    const overlap = candidates
      .filter(item => item.distance <= nearestDistance + 3.5)
      .sort((a,b) => a.priority-b.priority || a.distance-b.distance);

    // The nearest point wins on the first tap, but repeated taps can cycle
    // through coincident points and the geometry beneath them (e.g. a crossing).
    if (cycleOverlaps && overlap.length > 1) {
      const signature = overlap.map(item=>`${item.kind}:${item.id}`).sort().join('|');
      const now = Date.now();
      if (lastHitCycle.signature === signature && now-lastHitCycle.at < 1400) lastHitCycle.index = (lastHitCycle.index+1)%overlap.length;
      else { lastHitCycle.signature = signature; lastHitCycle.index = 0; }
      lastHitCycle.at = now;
      return overlap[lastHitCycle.index];
    }
    return overlap[0];
  }

  function nearPoint(p, tolerance = 17) {
    const hit = hitTest(p,'mouse');
    if (hit?.kind !== 'point') return null;
    const point = pointById(hit.id);
    return point || null;
  }

  function nearSegment(p, tolerance = 14) {
    const hit = hitTest(p,'mouse');
    if (hit?.kind !== 'segment') return null;
    const segment = segmentById(hit.id);
    return segment || null;
  }

  function getOrCreatePoint(p) { return nearPoint(p) || addPoint(p.x, p.y); }
  function el(tag, attrs = {}, text) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function updatePointLabelVisibility() {
    const show = state.points.some(point => isPointAvailable(point));
    $('#emptyCanvasText').style.display = show ? 'none' : '';
    $('#emptyCanvasSub').style.display = show ? 'none' : '';
  }

  function renderAll() {
    renderGeometry();
    renderObjects();
    renderProof();
    renderModelValidation();
    updateCounts();
    updatePointLabelVisibility();
    $('#taskText').textContent = state.task?.text || 'Условие задачи ещё не задано. Его можно ввести вручную — предварительное построение чертежа не требуется.';
    $('#taskGoal').textContent = state.task?.goal || 'не задана';
  }

  function drawTickForSegment(parent, segment, count = 1, color = '#ffd477') {
    const a = xy(pointById(segment.a));
    const b = xy(pointById(segment.b));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length; const uy = dy / length;
    const nx = -uy; const ny = ux;
    const spacing = 8; const tickLength = 12;
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spacing;
      const cx = (a.x + b.x) / 2 + ux * offset;
      const cy = (a.y + b.y) / 2 + uy * offset;
      parent.appendChild(el('line', {
        x1: cx - nx * tickLength / 2, y1: cy - ny * tickLength / 2,
        x2: cx + nx * tickLength / 2, y2: cy + ny * tickLength / 2,
        class: 'tick'
      }));
    }
  }

  function drawParallelMarker(parent, segment) {
    const a = xy(pointById(segment.a)); const b = xy(pointById(segment.b));
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length; const uy = dy / length; const nx = -uy; const ny = ux;
    const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2;
    const d = `M ${cx - ux * 6 - nx * 5} ${cy - uy * 6 - ny * 5} L ${cx} ${cy} L ${cx + ux * 6 - nx * 5} ${cy + uy * 6 - ny * 5}`;
    parent.appendChild(el('path', { d, fill: 'none', stroke: '#64dcc6', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  function drawPerpendicularMarker(parent, segment) {
    const a = xy(pointById(segment.a)); const b = xy(pointById(segment.b));
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length; const uy = dy / length; const nx = -uy; const ny = ux;
    const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2; const size = 9;
    const p1 = { x: cx - ux * size - nx * size, y: cy - uy * size - ny * size };
    const p2 = { x: cx + ux * size - nx * size, y: cy + uy * size - ny * size };
    const p3 = { x: cx + ux * size + nx * size, y: cy + uy * size + ny * size };
    const d = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}`;
    parent.appendChild(el('path', { d, fill: 'none', stroke: '#c0a0ff', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  function drawAngleArc(parent, angle, color = '#ffd477', tickCount = 0, label = false, right = false) {
    const info = angleData(angle); if (!info) return;
    const r = right ? 22 : 28;
    const sx = info.v.x + r*Math.cos(info.start), sy = info.v.y + r*Math.sin(info.start);
    const ex = info.v.x + r*Math.cos(info.start+info.delta), ey = info.v.y + r*Math.sin(info.start+info.delta);
    if (right) {
      const ux = Math.cos(info.start), uy = Math.sin(info.start);
      const vx = Math.cos(info.start+info.delta), vy = Math.sin(info.start+info.delta);
      const p1 = {x:info.v.x+r*ux,y:info.v.y+r*uy};
      const p2 = {x:info.v.x+r*(ux+vx),y:info.v.y+r*(uy+vy)};
      const p3 = {x:info.v.x+r*vx,y:info.v.y+r*vy};
      parent.appendChild(el('path',{d:`M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}`,class:'right-angle'}));
      return;
    }
    const sweep = info.delta >= 0 ? 1 : 0;
    parent.appendChild(el('path',{d:`M ${sx} ${sy} A ${r} ${r} 0 0 ${sweep} ${ex} ${ey}`,class:'angle-arc',stroke:color}));
    if (tickCount > 0) {
      const mid = info.mid;
      const cx = info.v.x+r*Math.cos(mid), cy = info.v.y+r*Math.sin(mid);
      const tx = -Math.sin(mid), ty = Math.cos(mid);
      for (let i=0;i<tickCount;i++) {
        const offset=(i-(tickCount-1)/2)*5;
        parent.appendChild(el('line',{x1:cx+tx*(offset-3),y1:cy+ty*(offset-3),x2:cx+tx*(offset+3),y2:cy+ty*(offset+3),class:'angle-tick',stroke:color}));
      }
    }
    if (label) {
      const lr = r+17, lx=info.v.x+lr*Math.cos(info.mid), ly=info.v.y+lr*Math.sin(info.mid);
      parent.appendChild(el('text',{x:lx,y:ly,class:'angle-label','text-anchor':'middle'},`${info.degrees.toFixed(1)}°`));
    }
  }

  // SVG RENDERER: rebuilds visual nodes from the model; it never creates or mutates geometry.
  function renderGeometry() {
    const geometry = $('#geometry'); const markings = $('#markings'); const pointsLayer = $('#pointsLayer');
    geometry.replaceChildren(); markings.replaceChildren(); pointsLayer.replaceChildren();

    for (const segment of state.segments) {
      if (!isSegmentAvailable(segment)) continue;
      const a = xy(pointById(segment.a)); const b = xy(pointById(segment.b));
      const selected = state.selected?.kind === 'segment' && state.selected.id === segment.id;
      const inGroup=isInSelectedGroup('segment',segment.id);
      const lineNode = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `geometry-line${selected ? ' selection' : ''}${inGroup ? ' group-selected' : ''}`, 'pointer-events':'none' });
      geometry.appendChild(lineNode);
      // No SVG hit overlay: all tools use the same geometric hitTest().
    }

    for (const circle of state.circles) {
      if (!isCircleAvailable(circle)) continue;
      const circleData = circleGeometry(circle);
      if (!circleData) continue;
      const {x,y} = circleData.center;
      const selected = state.selected?.kind === 'circle' && state.selected.id === circle.id;
      const inGroup=isInSelectedGroup('circle',circle.id);
      geometry.appendChild(el('circle', { cx: x, cy: y, r: circleData.radius, class: `geometry-circle${selected ? ' selection' : ''}${inGroup ? ' group-selected' : ''}`, 'pointer-events':'none' }));
    }

    for (const group of state.marks) {
      if (!group.segmentIds.every(segmentId => isSegmentAvailable(segmentById(segmentId)))) continue;
      for (const segmentId of group.segmentIds) {
        const segment = segmentById(segmentId);
        if (segment) drawTickForSegment(markings, segment, group.ticks || 1);
      }
    }

    for (const constraint of state.constraints) {
      const source = segmentById(constraint.sourceSegmentId);
      const target = segmentById(constraint.targetSegmentId);
      if (!source || !target || !isSegmentAvailable(source) || !isSegmentAvailable(target)) continue;
      if (constraint.type === 'parallel') {
        drawParallelMarker(markings, source);
        drawParallelMarker(markings, target);
      } else if (constraint.type === 'perpendicular') {
        drawPerpendicularMarker(markings, target);
      }
    }

    for (const angle of state.angles) if (isAngleAvailable(angle)) drawAngleArc(markings, angle, '#ffd477', 0, true, !!angle.rightAngle);
    for (const group of state.angleMarks) {
      if (group.angles.every(isAngleAvailable)) group.angles.forEach(angle => drawAngleArc(markings, angle, '#64dcc6', 1, false, false));
    }
    for (const constraint of state.angleConstraints) {
      if (!isAngleAvailable(constraint.sourceAngle) || !isAngleAvailable(constraint.targetAngle)) continue;
      drawAngleArc(markings, constraint.sourceAngle, '#64dcc6', 1, false, false);
      drawAngleArc(markings, constraint.targetAngle, '#64dcc6', 1, false, false);
    }

    for (const point of state.points) {
      if (!isPointAvailable(point)) continue;
      const q = xy(point);
      const selected = state.selected?.kind === 'point' && state.selected.id === point.id;
      const inGroup=isInSelectedGroup('point',point.id);
      const group = el('g', {});
      // The rendered marker is deliberately non-interactive; selection is model-driven.
      group.setAttribute('pointer-events','none');
      pointsLayer.appendChild(group);
      group.appendChild(el('circle', { cx: q.x, cy: q.y, r: 7.5, class: `point-dot${point.kind !== 'free' ? ' midpoint' : ''}${selected ? ' selection' : ''}${inGroup ? ' group-selected' : ''}` }));
      group.appendChild(el('text', { x: q.x + 12, y: q.y - 12, class: 'svglabel' }, point.name));
    }
  }

  function displaySegmentName(segment) {
    return `${pointById(segment.a)?.name || '?'}${pointById(segment.b)?.name || '?'}`;
  }

  function renderObjects() {
    const root = $('#objectList');
    root.replaceChildren();
    const items = [];
    for (const point of state.points) {
      let description = 'свободная точка';
      if (point.kind === 'midpoint') description = `середина ${displaySegmentName(segmentById(point.segmentId))}`;
      else if (point.kind === 'onSegment') description = `лежит на ${displaySegmentName(segmentById(point.segmentId))}`;
      else if (point.kind === 'constrainedPoint') {
        const names=pointLineAttachmentIds(point).map(sid=>displaySegmentName(segmentById(sid))).filter(Boolean);
        description=`привязана к ${names.length} отрезкам${names.length?`: ${names.join(', ')}`:''}`;
        if (point.previousConstruction) description+=' · исходное построение сохранено';
      }
      else if (point.kind === 'onCircle') description = `лежит на окружности ${point.circleId}`;
      else if (point.kind === 'constraintEndpoint') description = 'зависимая точка: ограничение отрезка';
      else if (point.kind === 'angleConstraintEndpoint') description = 'зависимая точка: равенство углов';
      else if (point.kind === 'intersection') description = 'пересечение двух несущих прямых';
      else if (point.kind === 'curveIntersection') description = 'пересечение прямых и/или окружностей';
      else if (point.kind === 'projection') description = 'основание перпендикуляра';
      else if (point.kind === 'angleBisector') description = 'точка биссектрисы на противоположной стороне';
      const available = isPointAvailable(point);
      if (!available) description = point.kind === 'curveIntersection' || point.kind === 'intersection'
        ? 'временно скрыта: геометрические объекты не пересекаются'
        : 'временно скрыта: родительское построение недоступно';
      items.push({ kind: 'point', id: point.id, title: `Точка ${point.name}`, sub: description, available });
    }
    for (const segment of state.segments) {
      const available = isSegmentAvailable(segment);
      items.push({ kind: 'segment', id: segment.id, title: `Отрезок ${displaySegmentName(segment)}`, sub: available ? 'отрезок' : 'временно скрыт: одна из вершин недоступна', available });
    }
    for (const circle of state.circles) {
      const available = isCircleAvailable(circle);
      items.push({ kind: 'circle', id: circle.id, title: 'Окружность', sub: !available ? 'временно скрыта: центр или радиусная точка недоступны' : circleRadiusPointId(circle) ? 'радиус определяется существующей точкой' : `радиус ${circleGeometry(circle)?.radius.toFixed(1) ?? '—'}`, available });
    }
    for (const mark of state.marks) {
      const names = mark.segmentIds.map((sid) => displaySegmentName(segmentById(sid))).join(' = ');
      const available = mark.segmentIds.every(sid => isSegmentAvailable(segmentById(sid)));
      items.push({ kind: 'mark', id: mark.id, title: 'Равные отрезки', sub: available ? names : `${names} · временно скрыто`, available });
    }
    for (const angle of state.angles) {
      const a=pointById(angle.aId), v=pointById(angle.vertexId), c=pointById(angle.cId);
      if (a && v && c) {
        const available=isAngleAvailable(angle);
        items.push({kind:'angle',id:angle.id,title:`Угол ${a.name}${v.name}${c.name}`,sub:available?`${angleData(angle)?.degrees.toFixed(1) ?? '—'}°`:'временно скрыт: одна из точек недоступна',available});
      }
    }
    for (const group of state.angleMarks) {
      const available=group.angles.every(isAngleAvailable);
      items.push({kind:'angleMark',id:group.id,title:'Равные углы',sub:group.angles.map(a=>`${pointById(a.aId)?.name||'?'}${pointById(a.vertexId)?.name||'?'}${pointById(a.cId)?.name||'?'}`).join(' = ')+(available?'':' · временно скрыто'),available});
    }
    for (const constraint of state.angleConstraints) {
      const label = angle => `${pointById(angle.aId)?.name||'?'}${pointById(angle.vertexId)?.name||'?'}${pointById(angle.cId)?.name||'?'}`;
      const value=angleData(constraint.sourceAngle)?.degrees;
      const available=isAngleAvailable(constraint.sourceAngle)&&isAngleAvailable(constraint.targetAngle);
      items.push({kind:'angleConstraint',id:constraint.id,title:'Равенство углов',sub:`∠${label(constraint.sourceAngle)} = ∠${label(constraint.targetAngle)}${value===undefined?'':` (${value.toFixed(1)}°)`}${available?'':' · временно скрыто'}`,available});
    }
    for (const constraint of state.constraints) {
      const source = segmentById(constraint.sourceSegmentId); const target = segmentById(constraint.targetSegmentId);
      if (!source || !target) continue;
      const symbol = constraint.type === 'parallel' ? ' ∥ ' : constraint.type === 'perpendicular' ? ' ⟂ ' : ' = ';
      const title = constraint.type === 'parallel' ? 'Параллельность' : constraint.type === 'perpendicular' ? 'Перпендикулярность' : 'Равенство длин';
      const available=isSegmentAvailable(source)&&isSegmentAvailable(target);
      items.push({ kind: 'constraint', id: constraint.id, title, sub: `${displaySegmentName(source)}${symbol}${displaySegmentName(target)}${available?'':' · временно скрыто'}`, available });
    }

    if (!items.length) {
      root.innerHTML = '<div class="empty">На чертеже пока нет объектов.</div>';
    } else {
      for (const item of items) {
        const row = document.createElement('div'); row.className = `object${item.available === false ? ' unavailable' : ''}`;
        const main = document.createElement('div');
        const title = document.createElement('div'); title.textContent = item.title;
        const sub = document.createElement('div'); sub.className = 'kind'; sub.textContent = item.sub;
        main.append(title, sub);
        const actions=document.createElement('div');actions.className='object-actions';
        if (item.kind==='point' && pointLineAttachmentIds(pointById(item.id)).length) {
          const detach=document.createElement('button');detach.textContent='↗';detach.title='Выбрать связи этой точки для открепления';
          detach.onclick=()=>{
            const point=pointById(item.id);if(!point)return;
            state.tool='detach';state.pending=[point.id];state.pendingMode='detachLine';state.selected={kind:'point',id:point.id};
            document.querySelectorAll('.tool').forEach(button=>button.classList.toggle('active',button.dataset.tool==='detach'));
            const names=pointLineAttachmentIds(point).map(sid=>{const seg=segmentById(sid);return seg?displaySegmentName(seg):null;}).filter(Boolean);
            $('#toolHelp').textContent=`Выбрана точка ${point.name}. Связи: ${names.join(', ')}. Выбери отрезок, который нужно открепить.`;
            closeWorkspaceMenu();renderGeometry();
          };
          actions.append(detach);
        }
        const remove = document.createElement('button'); remove.textContent = '×'; remove.title = 'Удалить';
        remove.onclick = () => { pushHistory(); deleteObject(item.kind, item.id); renderAll(); };
        actions.append(remove);row.append(main, actions); root.append(row);
      }
    }
    $('#objectListCount').textContent = items.length;
  }

  const basisLabels = {
    condition: 'Условие задачи', definition: 'Определение', axiom: 'Аксиома',
    theorem: 'Теорема', previous: 'Ранее доказанный факт', construction: 'Построение', logic: 'Правило логического вывода', assumption: 'Временное предположение'
  };

  // The base is explicitly Euclidean plane geometry. Rules describe classical
  // foundations, definitions and theorems; selecting one never proves that its
  // hypotheses are established in this particular proof.
  const rule = (id,basis,label,conditions,conclusion,reason,premisesMin,premisesMax,sourceLabel,sourceUrl,keywords=[]) => ({
    id,basis,label,conditions,conclusion,reason,premisesMin,premisesMax,sourceLabel,sourceUrl,keywords,
    description:`Условия: ${conditions} Вывод: ${conclusion}`
  });
  const EUCLID_URL='https://www.euclids-elements.org/elements/books/bookI/';
  const UCI_URL='https://www.math.uci.edu/~ndonalds/math161/euclid.pdf';
  const UW_URL='https://sites.math.washington.edu/~julia/teaching/445_Spring2014/theorems-Euclidean-Julia.pdf';
  const TTU_URL='https://www.math.ttu.edu/~rgelca/GEOMETRY.pdf';
  const AMSI_URL='https://amsi.org.au/teacher_modules/Circle_Geometry.html';
  const OPENSTAX_URL='https://openstax.org/books/contemporary-mathematics/pages/10-3-triangles';
  const proofRuleCatalog = [
    // Given / construction
    rule('given_condition','condition','Дано в условии задачи','Утверждение явно содержится в условии.','Это утверждение принимается как исходное данное.','По условию задачи.',0,0,'Евклид, Книга I: постулаты и общие понятия',EUCLID_URL,['дано','условие']),
    rule('previous_fact','previous','Ранее доказанный факт','Существуют более ранние шаги, содержащие нужные предпосылки.','Используется ранее установленное утверждение.','По ранее доказанному факту.',1,99,'Методика построения доказательства',UCI_URL,['предыдущий шаг','ссылка']),
    rule('construction_midpoint','construction','Построение середины отрезка','Выполнено построение точки на отрезке как его середины.','Построение фиксирует объект, но не заменяет обоснование свойств.','По выполненному построению середины отрезка.',0,0,'Евклид, Постулат 1 и построения Книги I',EUCLID_URL,['построение','середина']),
    rule('construction_perpendicular','construction','Построение перпендикуляра','Выполнено построение перпендикулярных прямых или отрезков.','Построение фиксирует полученную конфигурацию.','По выполненному построению перпендикуляра.',0,0,'Евклид, Определение 10 и Постулат 4',EUCLID_URL,['построение','перпендикуляр']),
    // Axioms and postulates
    rule('axiom_line_through_points','axiom','Постулат о проведении прямой','Даны две различные точки.','Через эти точки можно провести прямую.','По постулату о проведении прямой через две точки.',0,0,'Евклид, Постулат 1',EUCLID_URL,['прямая','две точки','линия']),
    rule('axiom_extend_segment','axiom','Постулат о продолжении прямой','Дан конечный отрезок.','Его можно непрерывно продолжить по той же прямой.','По постулату о продолжении прямой.',0,0,'Евклид, Постулат 2',EUCLID_URL,['продолжение','отрезок']),
    rule('axiom_circle','axiom','Постулат о построении окружности','Заданы центр и радиус.','Можно построить окружность с указанными центром и радиусом.','По постулату о построении окружности.',0,0,'Евклид, Постулат 3',EUCLID_URL,['окружность','центр','радиус']),
    rule('axiom_right_angles','axiom','Равенство всех прямых углов','Даны два прямых угла.','Все прямые углы равны между собой.','По постулату о равенстве всех прямых углов.',2,2,'Евклид, Постулат 4',EUCLID_URL,['прямой угол','перпендикуляр']),
    rule('axiom_parallel_playfair','axiom','Аксиома параллельных прямых (форма Плейфера)','Дана прямая и точка вне неё; рассматривается евклидова плоскость.','Через данную точку проходит ровно одна прямая, параллельная данной прямой.','По аксиоме параллельных прямых (постулат Плейфера).',0,0,'University of Washington, Euclidean Parallel Postulate; UCI notes',UW_URL,['параллельные','плейфер','пятый постулат','евклид']),
    rule('axiom_incidence_unique_line','axiom','Аксиома инцидентности: единственность прямой','Даны две различные точки плоскости.','Существует ровно одна прямая, содержащая обе точки.','По первой аксиоме инцидентности.',1,1,'Texas Tech University, Introduction to Geometry, incidence axiom I1',TTU_URL,['инцидентность','две точки','единственная прямая']),
    rule('axiom_incidence_line_points','axiom','Аксиома инцидентности: точки на прямой','Рассматривается любая прямая евклидовой плоскости.','На каждой прямой лежат по меньшей мере две различные точки.','По второй аксиоме инцидентности.',0,0,'Texas Tech University, Introduction to Geometry, incidence axiom I2',TTU_URL,['инцидентность','точки на прямой']),
    rule('axiom_incidence_noncollinear','axiom','Аксиома инцидентности: существование треугольника','Рассматривается евклидова плоскость.','Существуют три точки, не лежащие на одной прямой.','По третьей аксиоме инцидентности.',0,0,'Texas Tech University, Introduction to Geometry, incidence axiom I3',TTU_URL,['инцидентность','неколлинеарные']),
    rule('axiom_equal_transitive','axiom','Транзитивность равенства','A = B и B = C.','A = C.','По общему понятию о равенстве равных одному и тому же.',2,2,'Евклид, Общее понятие 1',EUCLID_URL,['равенство','транзитивность']),
    rule('axiom_add_equals','axiom','Сложение равных величин','A = B и C = D.','A + C = B + D.','По общему понятию о сложении равных.',2,2,'Евклид, Общее понятие 2',EUCLID_URL,['сложение','равные']),
    rule('axiom_subtract_equals','axiom','Вычитание равных величин','A = B и C = D; вычитание определено.','A − C = B − D.','По общему понятию о вычитании равных.',2,2,'Евклид, Общее понятие 3',EUCLID_URL,['вычитание','равные']),
    rule('axiom_coincidence','axiom','Совпадающие фигуры равны','Фигуры совмещаются при наложении.','Они равны по величине (конгруэнтны в соответствующем смысле).','По общему понятию о совпадении.',1,1,'Евклид, Общее понятие 4',EUCLID_URL,['совпадение','конгруэнтность']),
    rule('axiom_whole_part','axiom','Целое больше своей части','Одна величина является собственной частью другой.','Целое больше этой части.','По общему понятию «целое больше части».',1,1,'Евклид, Общее понятие 5',EUCLID_URL,['целое','часть','неравенство']),
    // Definitions
    rule('definition_point','definition','Первичное понятие: точка','В выбранной аксиоматике точка принимается как исходный объект.','Точка — неопределяемое первичное понятие; её свойства задаются аксиомами и отношениями инцидентности.','В строгой аксиоматике точка не определяется через более простые геометрические понятия.',0,0,'Texas Tech University, Introduction to Geometry: points as primary notions',TTU_URL,['точка','первичное понятие','неопределяемое']),
    rule('definition_line','definition','Первичное понятие: прямая','В выбранной аксиоматике прямая принимается как исходный объект.','Прямая — неопределяемый объект; принадлежность точек прямой и взаимное положение прямых задаются аксиомами инцидентности.','В строгой аксиоматике прямая не определяется через более простые геометрические понятия.',0,0,'Texas Tech University, Introduction to Geometry: lines and points as primary notions',TTU_URL,['прямая','первичное понятие','неопределяемое']),
    rule('definition_circle','definition','Определение окружности','Задана плоскость и точка O.','Окружность с центром O — множество точек плоскости, равноудалённых от O.','По определению окружности.',0,0,'Евклид, Определения 15–17',EUCLID_URL,['окружность','центр']),
    rule('definition_radius','definition','Определение радиуса','O — центр окружности, A принадлежит окружности.','OA — радиус окружности; все радиусы одной окружности равны.','По определению радиуса и окружности.',1,1,'Евклид, Определения 15–17',EUCLID_URL,['радиус']),
    rule('definition_diameter','definition','Определение диаметра','Отрезок проходит через центр окружности, а его концы лежат на окружности.','Такой отрезок является диаметром; его длина равна двум радиусам.','По определению диаметра.',1,1,'Евклид, Определение 17',EUCLID_URL,['диаметр']),
    rule('definition_midpoint','definition','Определение середины отрезка','M принадлежит отрезку AB и AM = MB.','M — середина AB; эквивалентно: M делит AB на две равные части.','По определению середины отрезка.',1,2,'Стандартное определение; см. Евклид, построение середины I.10',EUCLID_URL,['середина','отрезок']),
    rule('definition_angle','definition','Определение угла','Два луча имеют общее начало.','Угол образован этими лучами; общее начало — вершина угла.','По определению угла.',0,0,'Евклид, Определения 8–9',EUCLID_URL,['угол','луч']),
    rule('definition_angle_bisector','definition','Определение биссектрисы угла','Луч выходит из вершины угла и делит его на два угла.','Если полученные углы равны, луч является биссектрисой.','По определению биссектрисы угла.',1,2,'Стандартное определение; Евклид, построение I.9',EUCLID_URL,['биссектриса']),
    rule('definition_perpendicular','definition','Определение перпендикулярности','Две прямые пересекаются под прямым углом.','Эти прямые перпендикулярны.','По определению перпендикулярных прямых.',1,1,'Евклид, Определение 10',EUCLID_URL,['перпендикуляр','прямой угол']),
    rule('definition_parallel','definition','Определение параллельных прямых','Прямые лежат в одной плоскости и не пересекаются при продолжении.','Эти прямые параллельны.','По определению параллельных прямых.',1,1,'Евклид, Определение 23',EUCLID_URL,['параллельность']),
    rule('definition_triangle','definition','Определение треугольника','Три точки неколлинеарны и попарно соединены тремя отрезками.','Полученная фигура — треугольник; его стороны и углы определяются вершинами.','По определению треугольника.',1,3,'Евклид, Определение 19',EUCLID_URL,['треугольник']),
    rule('definition_isosceles','definition','Определение равнобедренного треугольника','В треугольнике две стороны равны.','Треугольник равнобедренный; равные стороны — боковые, третья — основание.','По определению равнобедренного треугольника.',1,2,'Евклид, Определение 20',EUCLID_URL,['равнобедренный']),
    rule('definition_equilateral','definition','Определение равностороннего треугольника','Три стороны треугольника равны.','Треугольник равносторонний.','По определению равностороннего треугольника.',1,3,'Евклид, Определение 20',EUCLID_URL,['равносторонний']),
    rule('definition_median','definition','Определение медианы треугольника','Отрезок соединяет вершину треугольника с серединой противоположной стороны.','Этот отрезок является медианой.','По определению медианы.',1,2,'Стандартное определение',UCI_URL,['медиана']),
    rule('definition_altitude','definition','Определение высоты треугольника','Отрезок проведён из вершины перпендикулярно прямой, содержащей противоположную сторону.','Этот отрезок является высотой.','По определению высоты.',1,2,'Стандартное определение',UCI_URL,['высота']),
    rule('definition_congruent_triangles','definition','Определение равенства (конгруэнтности) треугольников','Соответствующие стороны и углы двух треугольников попарно равны.','Треугольники конгруэнтны при заданном соответствии вершин.','По определению конгруэнтности треугольников.',3,6,'UCI, Euclidean Geometry: congruence',UCI_URL,['конгруэнтность','равенство треугольников']),
    rule('definition_segment','definition','Определение отрезка','Даны две точки A и B на одной прямой.','Отрезок AB состоит из A, B и всех точек прямой, лежащих между A и B.','По определению отрезка.',0,0,'Texas Tech University, Introduction to Geometry',TTU_URL,['отрезок','между']),
    rule('definition_ray','definition','Определение луча','Даны точка O и направление на прямой через O.','Луч — часть прямой с началом O, содержащая O и все точки по одну сторону от O.','По определению луча.',0,0,'Texas Tech University, Introduction to Geometry',TTU_URL,['луч','начало']),
    rule('definition_chord','definition','Определение хорды','A и B — различные точки одной окружности.','Отрезок AB называется хордой этой окружности.','По определению хорды.',0,0,'AMSI, Circle Geometry: chord and diameter',AMSI_URL,['хорда','окружность']),
    rule('definition_secant','definition','Определение секущей','Прямая имеет с окружностью две различные общие точки.','Такая прямая называется секущей окружности.','По определению секущей.',0,0,'AMSI, Circle Geometry: secant',AMSI_URL,['секущая','окружность']),
    rule('definition_tangent','definition','Определение касательной','Прямая имеет с окружностью ровно одну общую точку T.','Такая прямая называется касательной; T — точка касания.','По определению касательной.',0,0,'AMSI, Circle Geometry: tangent',AMSI_URL,['касательная','точка касания']),
    rule('definition_central_angle','definition','Определение центрального угла','Вершина угла совпадает с центром окружности, а стороны пересекают окружность.','Угол называется центральным относительно этой окружности.','По определению центрального угла.',0,0,'AMSI, Circle Geometry',AMSI_URL,['центральный угол']),
    rule('definition_inscribed_angle','definition','Определение вписанного угла','Вершина угла лежит на окружности, а стороны пересекают окружность ещё в двух точках.','Угол называется вписанным; он опирается на соответствующую дугу.','По определению вписанного угла.',0,0,'AMSI, Circle Geometry',AMSI_URL,['вписанный угол','дуга']),
    rule('definition_perpendicular_bisector','definition','Определение серединного перпендикуляра','Прямая проходит через середину отрезка и перпендикулярна ему.','Такая прямая называется серединным перпендикуляром отрезка.','По определению серединного перпендикуляра.',0,0,'Texas Tech University, Introduction to Geometry',TTU_URL,['серединный перпендикуляр']),
    rule('definition_cyclic_quadrilateral','definition','Определение вписанного четырёхугольника','Все четыре вершины четырёхугольника лежат на одной окружности.','Четырёхугольник называется вписанным (циклическим).','По определению вписанного четырёхугольника.',0,0,'AMSI, Circle Geometry',AMSI_URL,['вписанный четырёхугольник','циклический']),
    rule('definition_similar_triangles','definition','Определение подобных треугольников','Соответствующие углы двух треугольников равны, а соответствующие стороны пропорциональны.','Треугольники подобны при указанном соответствии вершин.','По определению подобия треугольников.',2,6,'University of Washington, Euclidean Geometry: similarity',UW_URL,['подобие','пропорциональность']),
    // Core theorems of plane geometry
    rule('theorem_vertical_angles','theorem','Теорема о вертикальных углах','Две прямые пересекаются; рассматриваются противоположные углы.','Вертикальные углы равны.','По теореме о вертикальных углах.',1,2,'Евклид I.15; UCI, Euclidean Geometry',UCI_URL,['вертикальные углы']),
    rule('theorem_linear_pair','theorem','Смежные углы в сумме дают 180°','Углы имеют общую сторону, а две другие стороны являются противоположными лучами.','Сумма смежных углов равна 180°.','По теореме о смежных углах.',1,2,'Евклид, Книга I; стандартная теорема о линейной паре',EUCLID_URL,['смежные','180']),
    rule('theorem_triangle_angle_sum','theorem','Сумма углов треугольника','Рассматривается треугольник в евклидовой плоскости; используется аксиома параллельных.','Сумма внутренних углов равна 180°.','По теореме о сумме углов треугольника.',1,3,'University of Washington, Theorem 10.11',UW_URL,['сумма углов','180','треугольник']),
    rule('theorem_exterior_angle','theorem','Теорема о внешнем угле треугольника','Один из углов треугольника продолжен до внешнего угла.','Внешний угол равен сумме двух внутренних углов, не смежных с ним.','По теореме о внешнем угле треугольника.',1,3,'University of Washington, Corollary 10.12; UCI notes',UW_URL,['внешний угол','треугольник']),
    rule('theorem_isosceles_base_angles','theorem','Теорема о равных углах при основании','В треугольнике две стороны равны.','Углы при основании равны.','По теореме о равных углах при основании равнобедренного треугольника.',1,2,'UCI, Euclid I.5',UCI_URL,['равнобедренный','углы при основании']),
    rule('theorem_isosceles_converse','theorem','Обратная теорема о равнобедренном треугольнике','В треугольнике два угла равны.','Противолежащие этим углам стороны равны.','По обратной теореме о равнобедренном треугольнике.',1,2,'Стандартная теорема евклидовой геометрии',UCI_URL,['обратная','равные углы']),
    rule('theorem_sss','theorem','Признак равенства треугольников SSS','Три стороны одного треугольника соответственно равны трём сторонам другого.','Треугольники равны (конгруэнтны) при соответствующем порядке вершин.','По третьему признаку равенства треугольников (SSS).',3,3,'UCI, Triangle Congruence Theorems; Euclid I.8',UCI_URL,['sss','три стороны','равенство треугольников']),
    rule('theorem_sas','theorem','Признак равенства треугольников SAS','Две стороны и угол между ними одного треугольника соответственно равны двум сторонам и углу между ними другого.','Треугольники равны (конгруэнтны).','По первому признаку равенства треугольников (SAS).',3,3,'UCI, Euclid I.4',UCI_URL,['sas','две стороны','угол']),
    rule('theorem_asa','theorem','Признак равенства треугольников ASA','Сторона и два прилежащих к ней угла одного треугольника соответственно равны стороне и двум прилежащим углам другого.','Треугольники равны (конгруэнтны).','По второму признаку равенства треугольников (ASA).',3,3,'UCI, ASA congruence theorem',UCI_URL,['asa','сторона и два угла']),
    rule('theorem_aas','theorem','Признак равенства треугольников AAS','Два угла и соответствующая сторона одного треугольника равны двум углам и соответствующей стороне другого.','Треугольники равны (конгруэнтны).','По признаку AAS; он следует из ASA и суммы углов треугольника.',3,3,'UCI, Triangle Congruence Theorems',UCI_URL,['aas','два угла']),
    rule('theorem_hl','theorem','Признак равенства прямоугольных треугольников (гипотенуза и катет)','Треугольники прямоугольные; гипотенузы и один соответствующий катет равны.','Прямоугольные треугольники равны.','По признаку равенства прямоугольных треугольников по гипотенузе и катету.',3,4,'Стандартная теорема о конгруэнтности прямоугольных треугольников',UCI_URL,['гипотенуза','катет','прямоугольный']),
    rule('theorem_midsegment','theorem','Теорема о средней линии треугольника','Отрезок соединяет середины двух сторон треугольника.','Он параллелен третьей стороне и равен половине её длины.','По теореме о средней линии треугольника.',3,3,'University of Washington, Theorem 10.30',UW_URL,['средняя линия','середины']),
    rule('theorem_pythagorean','theorem','Теорема Пифагора','Треугольник прямоугольный; c — гипотенуза, a и b — катеты.','a² + b² = c².','По теореме Пифагора.',1,3,'Классическая теорема евклидовой геометрии',UCI_URL,['пифагор','квадрат','гипотенуза']),
    rule('theorem_perpendicular_bisector_locus','theorem','Свойство серединного перпендикуляра','Точка лежит на серединном перпендикуляре к отрезку AB.','Она равноудалена от A и B; верно и обратное утверждение.','По теореме о геометрическом месте точек серединного перпендикуляра.',1,2,'Классическая теорема евклидовой геометрии',UCI_URL,['серединный перпендикуляр','равноудалена']),
    rule('theorem_alternate_angles','theorem','Накрест лежащие углы при параллельных прямых','Две параллельные прямые пересечены секущей.','Накрест лежащие углы равны.','По теореме о накрест лежащих углах.',2,3,'University of Washington, Theorem 10.1; Euclid I.29',UW_URL,['накрест лежащие','секущая']),
    rule('theorem_corresponding_angles','theorem','Соответственные углы при параллельных прямых','Две параллельные прямые пересечены секущей.','Соответственные углы равны.','По свойству соответственных углов.',2,3,'University of Washington, Corollary 10.2',UW_URL,['соответственные углы']),
    rule('theorem_same_side_interior','theorem','Односторонние внутренние углы','Две параллельные прямые пересечены секущей.','Сумма односторонних внутренних углов равна 180°.','По свойству односторонних внутренних углов.',2,3,'University of Washington, Corollary 10.3',UW_URL,['односторонние','180']),
    rule('theorem_parallel_transitive','theorem','Транзитивность параллельности','l ∥ m и m ∥ n; все прямые лежат в одной евклидовой плоскости.','l ∥ n.','По транзитивности параллельности.',2,2,'University of Washington, Theorem 10.10',UW_URL,['транзитивность','параллельность']),
    rule('theorem_triangle_aa_similarity','theorem','Признак подобия треугольников AA','Два угла одного треугольника соответственно равны двум углам другого.','Треугольники подобны; третьи углы также равны, а соответствующие стороны пропорциональны.','По первому признаку подобия треугольников (AA).',2,2,'University of Washington, Theorem 12.3',UW_URL,['подобие','aa']),
    rule('theorem_triangle_sss_similarity','theorem','Признак подобия треугольников SSS','Три пары соответствующих сторон треугольников пропорциональны.','Треугольники подобны.','По признаку подобия треугольников по трём сторонам (SSS).',3,3,'University of Washington, Theorem 12.5',UW_URL,['подобие','sss']),
    rule('theorem_triangle_sas_similarity','theorem','Признак подобия треугольников SAS','Две пары соответствующих сторон пропорциональны, а углы между ними равны.','Треугольники подобны.','По признаку подобия треугольников по двум сторонам и углу между ними (SAS).',3,3,'University of Washington, Theorem 12.6',UW_URL,['подобие','sas']),
    rule('theorem_thales_diameter','theorem','Теорема Фалеса об угле, опирающемся на диаметр','Вершина вписанного угла лежит на окружности, а его стороны проходят через концы диаметра.','Этот вписанный угол прямой.','По теореме об угле, опирающемся на диаметр.',2,3,'University of Washington, circle theorems',UW_URL,['фалес','диаметр','прямой угол']),
    rule('theorem_inscribed_central_angle','theorem','Связь центрального и вписанного углов','Центральный и вписанный углы опираются на одну и ту же дугу окружности.','Центральный угол вдвое больше вписанного.','По теореме о центральном и вписанном углах.',2,3,'University of Washington, Inscribed Angle Theorem',UW_URL,['вписанный угол','центральный угол']),
    rule('theorem_radius_tangent','theorem','Радиус перпендикулярен касательной','Прямая касается окружности в точке T, O — её центр.','OT перпендикулярен касательной в точке T.','По теореме о радиусе, проведённом в точку касания.',2,2,'University of Washington, circle theorems',UW_URL,['касательная','радиус']),
    rule('theorem_tangent_lengths','theorem','Равенство касательных из одной точки','Из точки вне окружности проведены две касательные к окружности.','Длины касательных от внешней точки до точек касания равны.','По теореме о равенстве касательных, проведённых из одной точки.',2,3,'University of Washington, circle theorems',UW_URL,['касательные','внешняя точка']),
    rule('theorem_intersecting_chords','theorem','Теорема о пересекающихся хордах','Две хорды AB и CD одной окружности пересекаются во внутренней точке P.','PA · PB = PC · PD.','По теореме о произведениях отрезков пересекающихся хорд.',2,3,'University of Washington, Intersecting Chords Theorem',UW_URL,['хорды','произведение','окружность']),
    rule('theorem_triangle_inequality','theorem','Неравенство треугольника','A, B, C — три неколлинеарные точки; AB, BC, CA — стороны треугольника.','Каждая сторона меньше суммы двух других: AB < AC + CB, BC < BA + AC, CA < CB + BA.','По неравенству треугольника.',1,3,'Texas Tech University, Introduction to Geometry',TTU_URL,['неравенство треугольника','стороны']),
    rule('theorem_side_angle_inequality','theorem','Связь большей стороны и большего угла','В треугольнике одна сторона больше другой.','Против большей стороны лежит больший угол; обратное утверждение также верно.','По теореме о соотношении сторон и противолежащих углов.',1,2,'Texas Tech University, Introduction to Geometry',TTU_URL,['большая сторона','больший угол']),
    rule('theorem_pythagorean_converse','theorem','Обратная теорема Пифагора','В треугольнике квадрат наибольшей стороны равен сумме квадратов двух других сторон.','Угол, противолежащий наибольшей стороне, прямой.','По обратной теореме Пифагора.',1,2,'Texas Tech University, Introduction to Geometry',TTU_URL,['обратная теорема пифагора','прямоугольный']),
    rule('theorem_cpctc','theorem','Соответствующие части равных треугольников равны','Два треугольника доказанно конгруэнтны при заданном соответствии вершин.','Соответствующие стороны и соответствующие углы равны.','По свойству соответствующих частей конгруэнтных треугольников (CPCTC).',1,2,'University of California, Irvine, Euclidean Geometry',UCI_URL,['cpctc','соответствующие части']),
    rule('theorem_centroid','theorem','Теорема о центроиде треугольника','В треугольнике проведены три медианы; G — их общая точка.','Три медианы пересекаются в одной точке G; G делит каждую медиану в отношении 2:1, считая от вершины.','По теореме о центроиде (точке пересечения медиан).',1,3,'Texas Tech University, Introduction to Geometry',TTU_URL,['центроид','центр тяжести','медианы','2:1']),
    rule('theorem_orthocenter','theorem','Теорема о точке пересечения высот','В треугольнике проведены прямые, содержащие три высоты.','Все три высоты (или их продолжения) проходят через одну точку — ортоцентр.','По теореме о пересечении высот треугольника.',1,3,'Texas Tech University, Introduction to Geometry',TTU_URL,['ортоцентр','высоты']),
    rule('theorem_converse_alternate_angles','theorem','Обратная теорема о накрест лежащих углах','Две прямые пересечены секущей; пара накрест лежащих углов равна.','Две прямые параллельны.','По обратной теореме о накрест лежащих углах.',1,2,'University of Washington, Selected Theorems of Euclidean Geometry',UW_URL,['обратная','накрест лежащие','параллельность']),
    rule('theorem_converse_corresponding_angles','theorem','Обратная теорема о соответственных углах','Две прямые пересечены секущей; пара соответственных углов равна.','Две прямые параллельны.','По обратной теореме о соответственных углах.',1,2,'University of Washington, Selected Theorems of Euclidean Geometry',UW_URL,['обратная','соответственные углы','параллельность']),
    rule('theorem_cyclic_quadrilateral','theorem','Противоположные углы вписанного четырёхугольника','Четырёхугольник вписан в окружность.','Сумма каждой пары противоположных углов равна 180°.','По теореме о противоположных углах вписанного четырёхугольника.',1,2,'AMSI, Circle Geometry',AMSI_URL,['вписанный четырёхугольник','180']),
    rule('theorem_same_segment_angles','theorem','Вписанные углы, опирающиеся на одну хорду','Два вписанных угла опираются на одну и ту же хорду и лежат в соответствующем сегменте окружности.','Эти вписанные углы равны.','По теореме о равных углах в одном сегменте.',1,2,'AMSI, Circle Geometry',AMSI_URL,['одна хорда','один сегмент','вписанные углы']),
    rule('theorem_secant_secant','theorem','Теорема о двух секущих','Из внешней точки P проведены две секущие, пересекающие окружность в A, B и C, D; A и C — ближние точки.','PA · PB = PC · PD.','По теореме о произведениях внешней и полной частей двух секущих.',1,3,'AMSI, Circle Geometry',AMSI_URL,['две секущие','степень точки','произведение']),
    rule('theorem_tangent_secant_power','theorem','Теорема о касательной и секущей','Из внешней точки P проведены касательная PT и секущая PAB.','PT² = PA · PB, где A — ближняя точка пересечения.','По теореме о касательной и секущей (степени точки).',1,3,'AMSI, Circle Geometry',AMSI_URL,['касательная','секущая','степень точки']),
    rule('theorem_equal_transitive','theorem','Транзитивность равенства (как свойство вывода)','A = B и B = C.','A = C.','По транзитивности равенства.',2,2,'Евклид, Общее понятие 1',EUCLID_URL,['равенство','транзитивность']),
    // Explicitly checkable propositional natural-deduction rules.
    rule('logic_and_intro','logic','Введение конъюнкции (∧I)','Доказаны P и Q.','P ∧ Q.','По правилу введения конъюнкции (∧I).',2,2,'University of Cambridge, Natural Deduction Rules', 'https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','конъюнкция','and introduction']),
    rule('logic_and_elim_left','logic','Устранение конъюнкции: левая часть (∧E₁)','Доказано P ∧ Q.','P.','По правилу устранения конъюнкции (∧E₁).',1,1,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','конъюнкция','and elimination']),
    rule('logic_and_elim_right','logic','Устранение конъюнкции: правая часть (∧E₂)','Доказано P ∧ Q.','Q.','По правилу устранения конъюнкции (∧E₂).',1,1,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','конъюнкция','and elimination']),
    rule('logic_contradiction_intro','logic','Введение противоречия (⊥I)','Доказаны P и ¬P.','⊥.','Из противоречащих высказываний выводится противоречие (⊥I).',2,2,'Natural Deduction — contradiction introduction','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','противоречие','ложь']),
    rule('logic_implies_intro','logic','Введение импликации (→I)','В поддоказательстве из временного предположения P получено Q.','P → Q; предположение P снимается.','По правилу введения импликации (→I): закрытие поддоказательства.',1,1,'Natural Deduction — implication introduction', 'https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','импликация','введение импликации','поддоказательство']),
    rule('logic_modus_ponens','logic','Modus ponens (→E)','Доказаны P → Q и P.','Q.','По правилу устранения импликации (modus ponens, →E).',2,2,'Stanford Encyclopedia of Philosophy, Natural Deduction Systems','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','modus ponens','импликация']),
    rule('logic_or_intro_left','logic','Введение дизъюнкции слева (∨I₁)','Доказано P.','P ∨ Q для некоторого Q.','По правилу введения дизъюнкции (∨I₁).',1,1,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','дизъюнкция']),
    rule('logic_or_intro_right','logic','Введение дизъюнкции справа (∨I₂)','Доказано Q.','P ∨ Q для некоторого P.','По правилу введения дизъюнкции (∨I₂).',1,1,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','дизъюнкция']),
    rule('logic_or_elim','logic','Устранение дизъюнкции · разбор случаев (∨E)','Доказано P ∨ Q; в отдельном поддоказательстве из P получено R, а в другом — из Q получено то же R.','R; оба временных предположения снимаются.','По правилу устранения дизъюнкции (∨E): два случая покрывают оба варианта исходной дизъюнкции.',3,3,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','дизъюнкция','разбор случаев','∨E','cases']),
    rule('logic_double_negation_elim','logic','Устранение двойного отрицания (¬¬E)','Доказано ¬¬P; используется классическая логика.','P.','По правилу устранения двойного отрицания (¬¬E).',1,1,'University of Cambridge, Natural Deduction Rules','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','двойное отрицание']),
    rule('logic_negation_intro','logic','Введение отрицания (¬I)','В поддоказательстве из временного предположения P получено противоречие ⊥.','¬P; предположение P снимается.','По правилу введения отрицания (¬I): предположение P приводит к противоречию.',1,1,'Natural Deduction — negation introduction','https://www.cl.cam.ac.uk/teaching/1112/R07/lecture8.pdf',['логика','отрицание','поддоказательство','противоречие']),
    rule('logic_raa','logic','Классическое доказательство от противного (RAA)','В поддоказательстве временно предполагается ¬P и из этого предположения выводится противоречие ⊥.','P; предположение ¬P снимается.','По классическому правилу reductio ad absurdum (RAA): если отрицание P приводит к противоречию, заключаем P.',2,2,'Natural Deduction — classical reductio ad absurdum','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','классическое доказательство от противного','raa','reductio ad absurdum','противоречие']),
    rule('logic_equal_symmetry','logic','Симметричность равенства','Доказано A = B.','B = A.','По симметричности равенства.',1,1,'Lean 4, Propositions and Proofs: propositional equality','https://lean-lang.org/theorem_proving_in_lean4/Propositions-and-Proofs/',['логика','симметричность','равенство']),
    rule('logic_equal_transitivity','logic','Транзитивность равенства','Доказаны A = B и B = C.','A = C.','По транзитивности равенства.',2,2,'Евклид, Общее понятие 1',EUCLID_URL,['логика','транзитивность','равенство']),
    rule('logic_forall_intro','logic','Введение всеобщности (∀I)','Из P(a) выводится ∀x P(x), где a — произвольный параметр, не встречающийся свободно ни в одном не снятом предположении.','∀x P(x).','По правилу введения всеобщего квантора (∀I); проверяется условие свежести произвольного параметра.',1,1,'Natural Deduction — universal quantifier introduction','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','квантор всеобщности','forall','universal introduction','∀I']),
    rule('logic_forall_elim','logic','Устранение всеобщности (∀E)','Доказано ∀x P(x); выбран допустимый терм t.','P(t).','По правилу устранения всеобщего квантора (∀E): из общего утверждения получаем любой его экземпляр.',1,1,'Natural Deduction — universal quantifier elimination','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','квантор всеобщности','forall','universal elimination','∀E']),
    rule('logic_exists_intro','logic','Введение существования (∃I)','Доказано P(t) для некоторого терма t.','∃x P(x).','По правилу введения квантора существования (∃I): найденный экземпляр подтверждает существование.',1,1,'Natural Deduction — existential quantifier introduction','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','квантор существования','exists','existential introduction','∃I']),
    rule('logic_exists_elim','logic','Устранение существования (∃E)','Доказано ∃x P(x); из временного предположения P(c), где c — свежий параметр, выведено Q, не содержащее c.','Q; временное предположение P(c) снимается.','По правилу устранения квантора существования (∃E): используется свежий свидетель, который не может влиять на внешнее заключение.',2,2,'Natural Deduction — existential quantifier elimination','https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',['логика','квантор существования','exists','existential elimination','∃E'])
  ];
  const proofRuleById = id => proofRuleCatalog.find(rule=>rule.id===id) || null;

  // Introductory examples intentionally use explicit, symbolic formula snapshots.
  // They do not require a drawing and are not inferred from visual geometry.
  const proofExampleCatalog = [
    {
      id:'transitivity-equality', title:'Транзитивность равенства величин', kind:'Общее понятие · Евклид, CN 1', sourceUrl:EUCLID_URL,
      intro:'Если AB равно CD, а CD равно EF, то AB равно EF. Это простейший пример применения транзитивности равенства к двум исходным посылкам.',
      source:'Евклид, Общее понятие 1 — вещи, равные одной и той же вещи, равны между собой; в современной записи используется транзитивность равенства.',
      steps:[
        {claim:'AB = CD',basisType:'condition',basisRuleId:'given_condition',reason:'Первое равенство принято как условие примера.',formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'magnitude',id:'AB'},{kind:'magnitude',id:'CD'}]}},
        {claim:'CD = EF',basisType:'condition',basisRuleId:'given_condition',reason:'Второе равенство принято как условие примера.',formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'magnitude',id:'CD'},{kind:'magnitude',id:'EF'}]}},
        {claim:'AB = EF',basisType:'axiom',basisRuleId:'axiom_equal_transitive',reason:'По транзитивности равенства: если AB = CD и CD = EF, то AB = EF.',refs:[0,1],goal:true,formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'magnitude',id:'AB'},{kind:'magnitude',id:'EF'}]}}
      ]
    },
    {
      id:'right-angles-equal', title:'Равенство всех прямых углов', kind:'Постулат Евклида · Постулат 4', sourceUrl:EUCLID_URL,
      intro:'Даны два прямых угла. По четвёртому постулату Евклида все прямые углы равны между собой.',
      source:'Евклид, Постулат 4. Пример показывает прямое применение постулата к двум явно записанным предпосылкам.',
      steps:[
        {claim:'∠α — прямой угол',basisType:'condition',basisRuleId:'given_condition',reason:'Первый угол принят как прямой по условию примера.',formula:{op:'atom',predicate:'is_right_angle',terms:[{kind:'angle_symbol',id:'α'}]}},
        {claim:'∠β — прямой угол',basisType:'condition',basisRuleId:'given_condition',reason:'Второй угол принят как прямой по условию примера.',formula:{op:'atom',predicate:'is_right_angle',terms:[{kind:'angle_symbol',id:'β'}]}},
        {claim:'∠α = ∠β',basisType:'axiom',basisRuleId:'axiom_right_angles',reason:'По четвёртому постулату Евклида все прямые углы равны между собой.',refs:[0,1],goal:true,formula:{op:'atom',predicate:'equal_angles',terms:[{kind:'angle_symbol',id:'α'},{kind:'angle_symbol',id:'β'}]}}
      ]
    },
    {
      id:'addition-equals', title:'Сложение равных величин', kind:'Общее понятие · Евклид, CN 2', sourceUrl:EUCLID_URL,
      intro:'Если AB = CD и EF = GH, то суммы равных величин равны: AB + EF = CD + GH.',
      source:'Евклид, Общее понятие 2 — если к равным прибавить равные, то целые будут равны.',
      steps:[
        {claim:'AB = CD',basisType:'condition',basisRuleId:'given_condition',reason:'Первая пара равных величин задана.',formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'magnitude',id:'AB'},{kind:'magnitude',id:'CD'}]}},
        {claim:'EF = GH',basisType:'condition',basisRuleId:'given_condition',reason:'Вторая пара равных величин задана.',formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'magnitude',id:'EF'},{kind:'magnitude',id:'GH'}]}},
        {claim:'AB + EF = CD + GH',basisType:'axiom',basisRuleId:'axiom_add_equals',reason:'По Общему понятию 2 Евклида: к равным прибавлены равные величины.',refs:[0,1],goal:true,formula:{op:'atom',predicate:'equal_magnitudes',terms:[{kind:'sum',terms:[{kind:'magnitude',id:'AB'},{kind:'magnitude',id:'EF'}]},{kind:'sum',terms:[{kind:'magnitude',id:'CD'},{kind:'magnitude',id:'GH'}]}]}}
      ]
    },
    {
      id:'unique-line', title:'Единственность прямой через две точки', kind:'Аксиома инцидентности · отдельная аксиоматика', sourceUrl:TTU_URL,
      intro:'Для любых двух различных точек существует ровно одна прямая, содержащая обе точки. Здесь заключение непосредственно является экземпляром аксиомы инцидентности.',
      source:'Аксиоматическая геометрия: аксиома единственности прямой через две различные точки.',
      steps:[
        {claim:'A и B — различные точки',basisType:'condition',basisRuleId:'given_condition',reason:'Две различные точки заданы.',formula:{op:'atom',predicate:'distinct_points',terms:[{kind:'point_symbol',id:'A'},{kind:'point_symbol',id:'B'}]}},
        {claim:'Через A и B проходит ровно одна прямая',basisType:'axiom',basisRuleId:'axiom_incidence_unique_line',reason:'По аксиоме инцидентности: через две различные точки проходит ровно одна прямая.',refs:[0],goal:true,formula:{op:'atom',predicate:'unique_line_through',terms:[{kind:'point_symbol',id:'A'},{kind:'point_symbol',id:'B'}]}}
      ]
    },
    {
      id:'forall-elimination', title:'От всеобщности к частному случаю (∀E)', kind:'Натуральный вывод · квантор всеобщности', sourceUrl:'https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',
      intro:'Из общего утверждения ∀x P(?x) получаем конкретный экземпляр P(A). Пример использует формальный AST и существующую проверку подстановки правила ∀E.',
      source:'Правило устранения всеобщности: из ∀x P(x) разрешено вывести P(t) для любого допустимого терма t. Проверяется именно подстановка терма; истинность исходного P и корректность выбранной области объектов остаются содержательными предпосылками.',
      steps:[
        {claim:'∀x P(?x)',basisType:'condition',basisRuleId:'given_condition',reason:'Всеобщее утверждение принято как исходное условие примера. Оно не выводится из одного частного экземпляра.',formula:{op:'forall',variable:'x',args:[{op:'atom',predicate:'user_predicate',text:'P',terms:[{kind:'variable',name:'x'}]}]}},
        {claim:'P(A)',basisType:'logic',basisRuleId:'logic_forall_elim',reason:'По правилу ∀E подставляем допустимую константу A вместо связанной переменной x. После подстановки тело квантора совпадает с P(A).',refs:[0],goal:true,formula:{op:'atom',predicate:'user_predicate',text:'P',terms:[{kind:'constant',name:'A'}]}}
      ]
    },
    {
      id:'modus-ponens', title:'Modus Ponens: вывод следствия из импликации', kind:'Натуральный вывод · устранение импликации (→E)', sourceUrl:'https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',
      intro:'Если P влечёт Q и P установлено, то можно вывести Q. Пример использует три формальные формулы и проверяет, что вторая посылка совпадает с условием импликации.',
      source:'Modus Ponens (→E): из P → Q и P выводится Q. Структурная проверка сопоставляет формулы, но не устанавливает истинность исходных посылок P → Q и P.',
      steps:[
        {claim:'P → Q',basisType:'condition',basisRuleId:'given_condition',reason:'Импликация P → Q принята как первая исходная посылка.',formula:{op:'implies',args:[{op:'atom',predicate:'user_predicate',text:'P',terms:[]},{op:'atom',predicate:'user_predicate',text:'Q',terms:[]}]}},
        {claim:'P',basisType:'condition',basisRuleId:'given_condition',reason:'Антецедент P принят как вторая исходная посылка.',formula:{op:'atom',predicate:'user_predicate',text:'P',terms:[]}},
        {claim:'Q',basisType:'logic',basisRuleId:'logic_modus_ponens',reason:'По правилу →E (Modus Ponens): из P → Q и P выводится консеквент Q.',refs:[0,1],goal:true,formula:{op:'atom',predicate:'user_predicate',text:'Q',terms:[]}}
      ]
    },
    {
      id:'existential-introduction', title:'Введение существования: предъявление свидетеля (∃I)', kind:'Натуральный вывод · введение квантора существования',
      sourceUrl:'https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',
      intro:'Из конкретного экземпляра P(A) выводится утверждение, что существует объект x со свойством P(x). Константа A выступает явным свидетелем.',
      source:'Правило ∃I: из P(t) выводится ∃x P(x), если t является допустимым термом. Проверяется совпадение подстановки; истинность P(A) остаётся предпосылкой.',
      steps:[
        {claim:'P(A)',basisType:'condition',basisRuleId:'given_condition',reason:'Конкретный экземпляр P(A) принят как исходное условие. Именно A будет свидетелем существования.',formula:{op:'atom',predicate:'user_predicate',text:'P',terms:[{kind:'constant',name:'A'}]}},
        {claim:'∃x P(?x)',basisType:'logic',basisRuleId:'logic_exists_intro',reason:'По правилу ∃I используем A как свидетель: подстановка A вместо связанной переменной x в теле P(?x) даёт исходную посылку P(A).',refs:[0],goal:true,formula:{op:'exists',variable:'x',args:[{op:'atom',predicate:'user_predicate',text:'P',terms:[{kind:'variable',name:'x'}]}]}}
      ]
    },
    {
      id:'nested-universal-elimination', title:'Устранение всеобщности во вложенной формуле (∀E)', kind:'Натуральный вывод · вложенные кванторы и α-эквивалентность',
      sourceUrl:'https://plato.stanford.edu/archives/spr2026/entries/natural-deduction/',
      intro:'Из ∀x ∃y R(x,y) получаем ∃z R(A,z). Внешний квантор разрешает подставить A вместо x; имя внутренней связанной переменной можно переименовать.',
      source:'При ∀E подстановка терма выполняется в теле внешнего квантора. Формулы ∃y R(A,y) и ∃z R(A,z) совпадают с точностью до α-эквивалентности: переименование связанной переменной не меняет смысл и не должно захватывать свободные переменные.',
      steps:[
        {claim:'∀x ∃y R(?x, ?y)',basisType:'condition',basisRuleId:'given_condition',reason:'Исходное условие содержит внешний квантор всеобщности и внутренний квантор существования.',formula:{op:'forall',variable:'x',args:[{op:'exists',variable:'y',args:[{op:'atom',predicate:'user_predicate',text:'R',terms:[{kind:'variable',name:'x'},{kind:'variable',name:'y'}]}]}]}},
        {claim:'∃z R(A, ?z)',basisType:'logic',basisRuleId:'logic_forall_elim',reason:'По ∀E подставляем константу A вместо внешней связанной переменной x. Внутренняя связанная переменная y переименована в z; формула сравнивается с учётом α-эквивалентности.',refs:[0],goal:true,formula:{op:'exists',variable:'z',args:[{op:'atom',predicate:'user_predicate',text:'R',terms:[{kind:'constant',name:'A'},{kind:'variable',name:'z'}]}]}}
      ]
    }
  ];

  function renderProofExamples(){
    const host=$('#proofExamplesList'); if(!host)return; host.replaceChildren();
    const order=['unique-line','right-angles-equal','transitivity-equality','addition-equals','forall-elimination','modus-ponens','existential-introduction','nested-universal-elimination'];
    [...proofExampleCatalog].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id)).forEach(example=>{
      const card=document.createElement('article');card.className='proof-example-card';
      const kind=document.createElement('div');kind.className='proof-example-kind';kind.textContent=example.kind;
      const head=document.createElement('div');head.className='proof-example-card-head';const title=document.createElement('h4');title.textContent=example.title;head.append(title);
      const intro=document.createElement('p');intro.textContent=example.intro;
      const steps=document.createElement('div');steps.className='proof-example-steps';
      example.steps.forEach((step,index)=>{const row=document.createElement('div');row.className='proof-example-step'+(step.goal?' conclusion':'');const number=document.createElement('span');number.className='n';number.textContent=String(index+1);const body=document.createElement('div');const claim=document.createElement('strong');claim.textContent=step.claim;const basis=document.createElement('small');basis.textContent=step.basisRuleId==='given_condition'?'Дано · исходная посылка':(proofRuleById(step.basisRuleId)?.label||'Аксиоматическое основание');body.append(claim,basis);row.append(number,body);steps.append(row);});
      const source=document.createElement('p');source.className='proof-example-source';source.textContent=example.source;
      const goal=example.steps.find(item=>item.goal)||example.steps[example.steps.length-1];
      const conclusion=document.createElement('div');conclusion.className='proof-example-conclusion';
      const conclusionLabel=document.createElement('span');conclusionLabel.textContent='Итог примера';
      const conclusionFormula=document.createElement('strong');conclusionFormula.textContent=goal?.claim||'';
      conclusion.append(conclusionLabel,conclusionFormula);
      const sourceLink=document.createElement('a');sourceLink.className='proof-example-source-link';sourceLink.href=example.sourceUrl||EUCLID_URL;sourceLink.target='_blank';sourceLink.rel='noopener noreferrer';sourceLink.textContent='Открыть первоисточник ↗';
      const add=document.createElement('button');add.type='button';add.className='btn primary';add.textContent='Добавить пример в доказательство';add.addEventListener('click',()=>loadProofExample(example.id));
      card.append(kind,head,intro,steps,conclusion,source,sourceLink,add);host.append(card);
    });
  }
  function loadProofExample(exampleId){
    const example=proofExampleCatalog.find(item=>item.id===exampleId);if(!example)return;
    if(state.activeProofContextIds.length||state.proofContexts.some(context=>context.status==='open')){alert('Сначала заверши или отмени открытые поддоказательства. Пример добавляется во внешнюю область доказательства.');return;}
    pushHistory();
    state.steps.forEach(step=>step.isGoal=false);
    const stamp=Date.now(),ids=[];
    example.steps.forEach((item,index)=>{
      const stepId=`example-${example.id}-${stamp}-${index+1}`;ids.push(stepId);
      state.steps.push({id:stepId,claim:item.claim,reason:item.reason,basisType:item.basisType,basisRuleId:item.basisRuleId,references:(item.refs||[]).map(refIndex=>ids[refIndex]),isGoal:!!item.goal,assertion:null,formulaExpression:null,formulaSnapshot:clone(item.formula),formulaSourceLost:false,contextPath:[],isAssumption:false,exampleId:example.id});
    });
    setProofTab('work');renderProof();
  }

  function premiseRangeLabel(rule) {
    if(rule.premisesMin===rule.premisesMax) return `${rule.premisesMin}`;
    if(rule.premisesMax>=99) return `не менее ${rule.premisesMin}`;
    return `${rule.premisesMin}–${rule.premisesMax}`;
  }

  function renderBasisRuleSelector(existingRuleId = '') {
    const basis=$('#basisType').value, select=$('#basisRule'), previous=select.value;
    const query=($('#basisRuleSearch')?.value||'').trim().toLocaleLowerCase('ru');
    select.replaceChildren();
    const empty=document.createElement('option'); empty.value=''; empty.textContent='Не выбрано — свободное обоснование'; select.append(empty);
    proofRuleCatalog.filter(item=>item.basis===basis && `${item.label} ${item.conditions} ${item.conclusion} ${(item.keywords||[]).join(' ')}`.toLocaleLowerCase('ru').includes(query)).forEach(item=>{
      const option=document.createElement('option'); option.value=item.id; option.textContent=item.label; select.append(option);
    });
    const wanted=existingRuleId || previous;
    if(wanted && [...select.options].some(option=>option.value===wanted)) select.value=wanted;
    updateBasisRuleInfo();
  }

  let lastSuggestedRuleReason='';
  function updateBasisRuleInfo() {
    const selected=proofRuleById($('#basisRule').value), info=$('#basisRuleInfo'), reasonField=$('#reasonInput');
    info.replaceChildren();
    if(!selected) {
      info.textContent='Можно выбрать правило из каталога или оставить свободное обоснование. Количество предыдущих шагов выбирается пользователем.';
    } else {
      const addLine=(label,value)=>{const line=document.createElement('div');line.className='proof-rule-detail';const strong=document.createElement('b');strong.textContent=label+' ';line.append(strong,document.createTextNode(value));info.append(line);};
      addLine('Условия:',selected.conditions);
      addLine('Заключение:',selected.conclusion);
      addLine('Рекомендуемые ссылки на предыдущие шаги:',premiseRangeLabel(selected));
      const note=document.createElement('div');note.className='proof-rule-detail';note.textContent=selected.basis==='logic'?'Для этого правила GeoProof сопоставляет формальные посылки и заключение. Это не доказывает истинность геометрических атомов.':'Это структурная подсказка: наличие геометрических предпосылок и корректность применения теоремы пока не проверяются автоматически.';info.append(note);
      if(selected.sourceUrl){const source=document.createElement('a');source.href=selected.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';source.textContent='Источник: '+selected.sourceLabel;source.className='proof-rule-detail';info.append(source);}
    }
    if(lastSuggestedRuleReason && reasonField.value===lastSuggestedRuleReason) reasonField.value='';
    lastSuggestedRuleReason='';
    if(selected && !reasonField.value.trim()){reasonField.value=selected.reason;lastSuggestedRuleReason=selected.reason;}
  }

  function renderProofLibrary() {
    const host=$('#proofLibraryList'); if(!host) return;
    host.replaceChildren();
    const query=($('#proofLibrarySearch')?.value||'').trim().toLocaleLowerCase('ru');
    const groups=[['axiom','Аксиомы и постулаты'],['definition','Первичные понятия и определения'],['theorem','Теоремы и следствия'],['logic','Правила логического вывода'],['construction','Построения'],['condition','Условие'],['previous','Работа с ранее доказанными фактами']];
    let count=0;
    for(const [basis,title] of groups){
      const entries=proofRuleCatalog.filter(item=>item.basis===basis && `${item.label} ${item.conditions} ${item.conclusion} ${(item.keywords||[]).join(' ')}`.toLocaleLowerCase('ru').includes(query));
      if(!entries.length) continue;
      const heading=document.createElement('div');heading.className='proof-library-group-title';heading.textContent=title;host.append(heading);
      for(const item of entries){
        count++;
        const card=document.createElement('article');card.className='proof-library-item';
        const name=document.createElement('strong');name.textContent=item.label;
        const conditions=document.createElement('p');conditions.textContent=`Условия: ${item.conditions}`;
        const conclusion=document.createElement('p');conclusion.textContent=`Вывод: ${item.conclusion}`;
        const refs=document.createElement('p');refs.textContent=`Ссылки на шаги: ${premiseRangeLabel(item)}`;
        card.append(name,conditions,conclusion,refs);
        if(item.sourceUrl){const source=document.createElement('a');source.href=item.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';source.textContent='Источник';source.className='proof-rule-detail';card.append(source);}
        const use=document.createElement('button');use.type='button';use.className='btn subtle';use.textContent='Использовать в новом шаге';
        use.addEventListener('click',()=>{openStepEditor(null,item.id);});
        card.append(use);host.append(card);
      }
    }
    if(!count){const empty=document.createElement('div');empty.className='empty';empty.textContent='По этому запросу ничего не найдено. Можно оставить свободное обоснование.';host.append(empty);}
  }
  function setProofTab(tabName){
    document.querySelectorAll('[data-proof-tab]').forEach(button=>{const active=button.dataset.proofTab===tabName;button.classList.toggle('active',active);button.setAttribute('aria-selected',active?'true':'false');});
    document.querySelectorAll('[data-proof-view]').forEach(view=>{view.hidden=view.dataset.proofView!==tabName;});
  }
  document.querySelectorAll('[data-proof-tab]').forEach(button=>button.addEventListener('click',()=>setProofTab(button.dataset.proofTab)));

  function proofPath(stepOrPath) {
    const path=Array.isArray(stepOrPath)?stepOrPath:stepOrPath?.contextPath;
    return Array.isArray(path)?path:[];
  }
  function pathIsPrefix(prefix,path) {
    return prefix.length<=path.length && prefix.every((id,index)=>id===path[index]);
  }
  function sameArray(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>value===b[index]);}
  function proofStepVisibleInContext(step,contextPath=state.activeProofContextIds) {
    return pathIsPrefix(proofPath(step),proofPath(contextPath));
  }
  function activeProofContext() {
    const id=state.activeProofContextIds[state.activeProofContextIds.length-1];
    return state.proofContexts.find(context=>context.id===id && context.status==='open')||null;
  }
  function proofContextLabel(context) {
    return context?.label || `Предположение ${Math.max(1,state.proofContexts.indexOf(context)+1)}`;
  }
  function visibleDisjunctionSteps(contextPath=state.activeProofContextIds){
    return state.steps.filter(step=>state.steps.indexOf(step)<state.steps.length&&proofStepVisibleInContext(step,contextPath)&&getStepFormula(step.id)?.op==='or');
  }
  function visibleExistentialSteps(contextPath=state.activeProofContextIds){
    return state.steps.filter(step=>proofStepVisibleInContext(step,contextPath)&&getStepFormula(step.id)?.op==='exists');
  }
  function openExistsElimStartModal(){
    if(activeProofContext()?.caseGroupId){alert('Сначала заверши текущий случай разбора дизъюнкции.');return;}
    const candidates=visibleExistentialSteps();if(!candidates.length){alert('В текущей области нет формального утверждения вида ∃x P(x). Сначала сформулируй его.');return;}
    const select=$('#existsElimSourceSelect');select.replaceChildren();
    candidates.forEach(step=>{const option=document.createElement('option');option.value=step.id;option.textContent=`Шаг ${state.steps.indexOf(step)+1}: ${displayFormulaForStep(step.id)}`;select.append(option);});
    $('#existsElimStartModal').style.display='flex';
  }
  function startExistsElimination(){
    const sourceId=$('#existsElimSourceSelect').value,source=state.steps.find(step=>step.id===sourceId),formula=getStepFormula(sourceId);
    if(!source||formula?.op!=='exists'||!proofStepVisibleInContext(source,state.activeProofContextIds)){alert('Выбери доступное формальное утверждение ∃x P(x).');return;}
    const used=new Set();state.steps.forEach(step=>allFormulaTerms(getStepFormula(step.id)).forEach(term=>{if(term.kind==='constant'&&term.name)used.add(term.name);}));
    let suffix=1,eigenparameter=`c_${suffix}`;while(used.has(eigenparameter))eigenparameter=`c_${++suffix}`;
    pushHistory();
    const groupId=`exists-group-${Date.now()}-${state.proofExistenceGroups.length+1}`;
    const contextId=`exists-context-${Date.now()}-${state.proofContexts.length+1}`;
    const assumptionId=`exists-assumption-${Date.now()}-${state.steps.length+1}`;
    const parentPath=[...state.activeProofContextIds],contextPath=[...parentPath,contextId];
    const witnessFormula=substituteFormula(formula.args[0],formula.variable,{kind:'constant',name:eigenparameter});
    const assumption={id:assumptionId,claim:displayFormulaAst(witnessFormula),reason:`Временное предположение для ∃E: тело существующего утверждения с подстановкой свежего параметра ${eigenparameter}.`,basisType:'assumption',basisRuleId:null,references:[],isGoal:false,assertion:null,formulaExpression:null,formulaSnapshot:witnessFormula,formulaSourceLost:false,contextPath,isAssumption:true,assumptionContextId:contextId,existsElimGroupId:groupId};
    const context={id:contextId,label:`∃E: ${displayFormulaAst(witnessFormula)} (свежий параметр ${eigenparameter})`,parentPath,assumptionStepId:assumptionId,status:'open',consequentStepId:null,closedByStepId:null,closingRuleId:null,existsElimGroupId:groupId};
    const group={id:groupId,existentialStepId:sourceId,parentPath,contextId,assumptionStepId:assumptionId,eigenparameter,consequentStepId:null,resultStepId:null,status:'open'};
    state.proofExistenceGroups.push(group);state.proofContexts.push(context);state.steps.push(assumption);state.activeProofContextIds=contextPath;
    $('#existsElimStartModal').style.display='none';setProofTab('work');renderProof();
  }
  function renderProofContextControls() {
    const current=activeProofContext();
    const begin=$('#beginSubproofBtn'),beginCases=$('#beginCasesBtn'),beginExists=$('#beginExistsElimBtn'),close=$('#closeSubproofBtn'),status=$('#proofContextStatus');
    if(!begin||!close||!status)return;
    close.disabled=!current;
    if(beginCases)beginCases.disabled=!visibleDisjunctionSteps().length||!!current?.caseGroupId;
    if(beginExists)beginExists.disabled=!visibleExistentialSteps().length||!!current?.caseGroupId;
    if(!current){status.textContent='Сейчас нет открытых поддоказательств. Можно начать временное предположение или разбор случаев по дизъюнкции.';close.textContent='Завершить поддоказательство';return;}
    const assumption=state.steps.find(step=>step.id===current.assumptionStepId);
    const depth=state.activeProofContextIds.length;
    if(current.existsElimGroupId){
      const group=state.proofExistenceGroups.find(item=>item.id===current.existsElimGroupId);
      status.textContent=`Устранение существования (∃E): временно предполагается тело ∃-утверждения со свежим параметром ${group?.eigenparameter||'c'}. Выведи заключение, в котором этот параметр не встречается.`;
      close.textContent='Завершить · ∃E';
    } else if(current.caseGroupId){
      const group=state.proofCaseGroups.find(item=>item.id===current.caseGroupId),caseIndex=current.caseIndex||0;
      status.textContent=`Разбор по случаям · случай ${caseIndex+1} из 2. Временно предполагается ${assumption?.claim||'P'}. Докажи то же заключение, что и в первом случае; после закрытия второго случая GeoProof применит ∨E.`;
      close.textContent=`Завершить случай ${caseIndex+1}`;
      if(beginCases)beginCases.disabled=true;
    } else {
      status.textContent=`Открыто поддоказательство (${depth===1?'внешний контекст':`уровень вложенности ${depth}`}): предполагается ${assumption?.claim||'P'}. Внутренние шаги доступны только здесь и во вложенных контекстах.`;
      close.textContent=getStepFormula(assumption?.id)?.op==='not'?'Завершить · доступно классическое RAA':'Завершить: вывести P → Q / ¬P';
    }
  }
  function contextById(contextId){return state.proofContexts.find(context=>context.id===contextId)||null;}

  function proofScopeProblem(step) {
    const currentPath=proofPath(step);
    const sources=[...(step.references||[]),...(step.formulaExpression?.sourceStepIds||[])];
    for(const sourceId of new Set(sources)){
      const source=state.steps.find(item=>item.id===sourceId);
      if(!source)return `Источник шага ${sourceId} отсутствует.`;
      if(['logic_implies_intro','logic_negation_intro','logic_raa','logic_exists_elim'].includes(step.basisRuleId) && step.dischargedContextId){
        const context=state.proofContexts.find(item=>item.id===step.dischargedContextId);
        const dischargedPath=context?[...(context.parentPath||[]),context.id]:[];
        if(context && (sourceId===context.assumptionStepId || sourceId===context.consequentStepId) && sameArray(proofPath(source),dischargedPath))continue;
      }
      if(step.basisRuleId==='logic_exists_elim'&&step.existenceEliminationGroupId){
        const group=state.proofExistenceGroups.find(item=>item.id===step.existenceEliminationGroupId);
        if(group){
          const context=contextById(group.contextId),innerPath=context?[...(context.parentPath||[]),context.id]:[];
          if(sourceId===group.existentialStepId&&sameArray(proofPath(source),group.parentPath||[]))continue;
          if((sourceId===group.assumptionStepId||sourceId===group.consequentStepId)&&context&&sameArray(proofPath(source),innerPath))continue;
        }
      }
      if(step.basisRuleId==='logic_or_elim'&&step.caseEliminationGroupId){
        const group=state.proofCaseGroups.find(item=>item.id===step.caseEliminationGroupId);
        if(group){
          if(sourceId===group.disjunctionStepId&&sameArray(proofPath(source),group.parentPath||[]))continue;
          const index=(group.caseConsequentStepIds||[]).indexOf(sourceId);
          if(index>=0){const ctx=contextById(group.caseContextIds[index]);if(ctx&&ctx.status==='case-closed'&&sourceId===ctx.consequentStepId&&sameArray(proofPath(source),[...(group.parentPath||[]),ctx.id]))continue;}
        }
      }
      if(!proofStepVisibleInContext(source,currentPath))return `Шаг ссылается на внутренний шаг ${state.steps.indexOf(source)+1}, который находится вне текущей области действия предположения.`;
    }
    return null;
  }
  function contextById(contextId){return state.proofContexts.find(context=>context.id===contextId)||null;}

  function renderProof() {
    const root = $('#proofSteps'); root.replaceChildren();
    if (!state.steps.length) {
      root.innerHTML = '<div class="empty">Добавляй утверждения, указывай математическое основание и связывай выводы с предыдущими шагами.</div>';
    } else {
      const shownContextHeaders=new Set();
      state.steps.forEach((step, index) => {
        const path=proofPath(step);
        for(let depth=0;depth<path.length;depth++){
          const contextId=path[depth];
          if(shownContextHeaders.has(contextId))continue;
          shownContextHeaders.add(contextId);
          const context=contextById(contextId);
          const header=document.createElement('div');
          header.className='proof-context-header'+(context?.status==='closed'||context?.status==='case-closed'?' closed':'')+(context?.caseGroupId?' case-context':'');
          header.style.marginLeft=`${(depth+1)*13}px`;
          const title=document.createElement('strong');title.textContent=`Поддоказательство: ${proofContextLabel(context)}`;
          const stateLabel=document.createElement('span');stateLabel.className='context-state';stateLabel.textContent=context?.status==='case-closed'?'случай закрыт':context?.status==='closed'?'закрыто':'открыто';
          header.append(title,stateLabel);root.append(header);
        }
        const row = document.createElement('div'); row.className = 'step'+(path.length?' in-subproof':'')+(step.dischargedContextId?' discharged-conclusion':'');
        row.style.setProperty('--proof-depth',String(path.length));
        const number = document.createElement('span'); number.className = 'num'; number.textContent = index + 1;
        const main = document.createElement('div'); main.className = 'stepmain';
        if(step.isAssumption){const badge=document.createElement('div');badge.className='step-assumption-label';badge.textContent='ВРЕМЕННОЕ ПРЕДПОЛОЖЕНИЕ';main.append(badge);}
        if(step.dischargedContextId){const badge=document.createElement('div');badge.className='step-assumption-label';badge.textContent=step.basisRuleId==='logic_negation_intro'?'ЗАКРЫТИЕ ПОДДОКАЗАТЕЛЬСТВА · ¬I':step.basisRuleId==='logic_raa'?'ЗАКРЫТИЕ ПОДДОКАЗАТЕЛЬСТВА · RAA':'ЗАКРЫТИЕ ПОДДОКАЗАТЕЛЬСТВА · →I';main.append(badge);}
        if(step.isAssumption&&step.caseGroupId){const badge=document.createElement('div');badge.className='proof-case-label';badge.textContent=`СЛУЧАЙ ${Number(step.caseIndex)+1} · ВРЕМЕННОЕ ПРЕДПОЛОЖЕНИЕ`;main.append(badge);}
        if(step.caseEliminationGroupId){const badge=document.createElement('div');badge.className='proof-case-label';badge.textContent='РАЗБОР СЛУЧАЕВ · ∨E';main.append(badge);}
        if(step.existenceEliminationGroupId){const badge=document.createElement('div');badge.className='proof-case-label';badge.textContent='УСТРАНЕНИЕ СУЩЕСТВОВАНИЯ · ∃E';main.append(badge);}
        const claim = document.createElement('div'); claim.className = 'claim'; claim.textContent = step.claim;
        const selectedRule=proofRuleById(step.basisRuleId);
        const formulaLine=document.createElement('div');formulaLine.className='proof-formula-line';formulaLine.textContent=displayFormulaForStep(step.id);
        const audit=auditProofStep(step,index);
        const auditBadge=document.createElement('span');auditBadge.className=`proof-step-status ${audit.status}`;auditBadge.textContent=audit.status==='checked'?'Схема проверена':audit.status==='invalid'?'Ошибка структуры':'Нужна проверка';
        const details=document.createElement('details');details.className='proof-step-details';
        const summary=document.createElement('summary');summary.textContent='Основание и подробности';details.append(summary);
        const reason = document.createElement('div'); reason.className = 'reason'; reason.textContent = `Обоснование: ${step.reason}`;
        const ruleDetail=document.createElement('div'); ruleDetail.className='proof-step-rule';
        if(selectedRule) ruleDetail.textContent=`Правило ${selectedRule.label}. Условия: ${selectedRule.conditions} Вывод: ${selectedRule.conclusion}`;
        const meta = document.createElement('div'); meta.className = 'step-meta';
        const refs = (step.references || []).map(id => state.steps.findIndex(s => s.id === id)).filter(i => i >= 0).map(i => `шаг ${i+1}`);
        meta.textContent = `${basisLabels[step.basisType || 'condition'] || 'Основание не указано'}${selectedRule ? ' · ' + selectedRule.label : ' · свободное обоснование'}${refs.length ? ' · использует: ' + refs.join(', ') : ''}`;
        details.append(reason); if(selectedRule) details.append(ruleDetail); details.append(meta);
        if(path.length){const scope=document.createElement('div');scope.className='step-scope-label';scope.textContent=`Область действия: ${path.map(id=>proofContextLabel(contextById(id))).join(' → ')}`;details.append(scope);}
        main.append(claim,formulaLine,auditBadge,details);
        const tools = document.createElement('div'); tools.className = 'step-tools';
        const edit = document.createElement('button'); edit.textContent = '✎'; edit.title = 'Редактировать шаг';
        edit.onclick = () => openStepEditor(step.id);
        if(step.dischargedContextId){edit.disabled=true;edit.title='Автоматический вывод поддоказательства. Изменяй исходное предположение или внутреннее заключение.';}
        const remove = document.createElement('button'); remove.textContent = '×'; remove.title = 'Удалить шаг';
        remove.onclick = () => removeProofStep(step.id);
        tools.append(edit, remove); row.append(number, main, tools); root.append(row);
      });
    }
    $('#stepCount').textContent = `${state.steps.length} шагов`;
    const outline = state.steps.map((step, index) => {
      const refs = (step.references || []).map(id => state.steps.findIndex(s => s.id === id)+1).filter(n => n > 0);
      const prefix=proofPath(step).length?'  '.repeat(proofPath(step).length):'';
      return `${prefix}-- Шаг ${index + 1}: ${step.isAssumption?'[Предположение] ':''}${step.claim}\n${prefix}-- Тип основания: ${basisLabels[step.basisType || 'condition']}\n${prefix}-- Правило: ${proofRuleById(step.basisRuleId)?.label || 'свободное обоснование'}\n${prefix}-- Обоснование: ${step.reason}\n${prefix}-- Зависимости: ${refs.length ? refs.map(n => `шаг ${n}`).join(', ') : 'не указаны'}`;
    }).join('\n\n');
    $('#proofOutline').textContent = state.steps.length
      ? `ДОКАЗАТЕЛЬСТВО\n\n${state.task?.text || 'Условие задачи не задано.'}\nЦель: ${state.task?.goal || 'не задана'}\n\n${outline}`
      : 'Добавь шаги доказательства. Здесь появится последовательность утверждений и обоснований.';
    const integrity = $('#proofIntegrity');
    if (integrity) {
      const dangling = state.steps.filter(s => (s.references || []).some(ref => !state.steps.some(x => x.id === ref))).length;
      const assertionKinds={equal_segments:['segment','segment'],segment_sum:['segment','segment','segment'],parallel_segments:['segment','segment'],perpendicular_segments:['segment','segment'],point_on_segment:['point','segment'],point_on_line:['point','segment'],point_is_midpoint:['point','segment'],point_on_circle:['point','circle'],equal_angles:['angle','angle'],collinear_points:['point','point','point'],triangle_congruence:['point','point','point','point','point','point'],triangle_similarity:['point','point','point','point','point','point'],isosceles_triangle:['point','point','point'],equilateral_triangle:['point','point','point'],right_triangle:['point','point','point'],triangle_angle_sum:['point','point','point'],triangle_centroid:['point','point','point','point'],triangle_orthocenter:['point','point','point','point'],cyclic_quadrilateral:['point','point','point','point'],equal_distance_point:['point','point','point']};
      const brokenAssertions=state.steps.filter(step=>{
        if(!step.assertion) return false;
        if(step.assertion.type==='custom') {
          const objects=step.assertion.objects||[], kinds=step.assertion.objectKinds||[];
          if(objects.length!==kinds.length) return true;
          return objects.some((objectId,index)=>kinds[index]==='point'?!state.points.some(p=>p.id===objectId):kinds[index]==='angle'?!state.angles.some(a=>a.id===objectId):kinds[index]==='circle'?!state.circles.some(c=>c.id===objectId):!state.segments.some(seg=>seg.id===objectId));
        }
        const kinds=assertionKinds[step.assertion.type];
        if(!kinds || !Array.isArray(step.assertion.objects) || step.assertion.objects.length!==kinds.length) return true;
        return step.assertion.objects.some((objectId,index)=>kinds[index]==='point'?!state.points.some(p=>p.id===objectId):kinds[index]==='angle'?!state.angles.some(a=>a.id===objectId):!state.segments.some(seg=>seg.id===objectId));
      }).length;
      const problems=[]; const notices=[];
      const invalidRules=state.steps.filter(step=>step.basisRuleId && !proofRuleById(step.basisRuleId)).length;
      const wrongBasis=state.steps.filter(step=>{const r=proofRuleById(step.basisRuleId);return r && step.basisType!==r.basis && !(step.basisType==='previous'&&r.basis==='theorem');}).length;
      const wrongPremises=state.steps.filter(step=>{const r=proofRuleById(step.basisRuleId);return r && (step.references||[]).length<r.premisesMin || r && r.premisesMax<99 && (step.references||[]).length>r.premisesMax;}).length;
      const logicalInvalid=state.steps.filter(step=>proofRuleById(step.basisRuleId)?.basis==='logic'&&auditProofStep(step, state.steps.indexOf(step)).status==='invalid').length;
      const logicalChecked=state.steps.filter(step=>proofRuleById(step.basisRuleId)?.basis==='logic'&&auditProofStep(step, state.steps.indexOf(step)).status==='checked').length;
      const lostFormulaSources=state.steps.filter(step=>step.formulaSourceLost).length;
      const malformedFormulaSources=state.steps.filter(step=>(step.formulaExpression||step.formulaSnapshot)&&!getStepFormula(step.id)).length;
      const unused=state.steps.filter(s=>!s.isGoal&&!state.steps.some(other=>other.id!==s.id&&((other.references||[]).includes(s.id)||(other.formulaExpression?.sourceStepIds||[]).includes(s.id)))).length;
      const openContexts=state.proofContexts.filter(context=>context.status==='open').length;
      const incompleteCaseGroups=state.proofCaseGroups.filter(group=>group.status!=='closed').length;
      const incompleteExistenceGroups=state.proofExistenceGroups.filter(group=>group.status!=='closed').length;
      const scopeProblems=state.steps.filter(step=>proofScopeProblem(step)).length;
      const missingContexts=state.steps.filter(step=>proofPath(step).some(id=>!contextById(id))).length;
      const invalidContexts=state.proofContexts.filter(context=>!state.steps.some(step=>step.id===context.assumptionStepId)||(context.status==='closed'&&!state.steps.some(step=>step.id===context.closedByStepId))||(context.status==='case-closed'&&!state.proofCaseGroups.some(group=>group.caseContextIds?.includes(context.id)&&['second-open','closed'].includes(group.status)))||(context.existsElimGroupId&&!state.proofExistenceGroups.some(group=>group.id===context.existsElimGroupId))).length;
      if(dangling) problems.push(`${dangling} ссылок на отсутствующие шаги`);
      if(brokenAssertions) problems.push(`${brokenAssertions} утверждений с потерянными геометрическими объектами`);
      if(invalidRules) problems.push(`${invalidRules} шагов с неизвестным правилом`);
      if(logicalInvalid) problems.push(`${logicalInvalid} применений логических правил не соответствуют формальной схеме`);
      if(lostFormulaSources) problems.push(`${lostFormulaSources} логических формул потеряли исходные шаги`);
      if(malformedFormulaSources) problems.push(`${malformedFormulaSources} логических формул имеют некорректную структуру`);
      if(scopeProblems) problems.push(`${scopeProblems} шагов используют предположения вне области их действия`);
      if(missingContexts||invalidContexts) problems.push(`${missingContexts+invalidContexts} повреждённых контекстов поддоказательств`);
      if(wrongBasis) notices.push(`${wrongBasis} выбранных правил имеют несоответствие категории основания`);
      if(wrongPremises) notices.push(`${wrongPremises} шаг(а/ов) имеют число ссылок вне ориентировочного диапазона каталога; требуется содержательная проверка`);
      if(logicalChecked) notices.push(`${logicalChecked} логических выводов прошли структурную проверку формы правила`);
      if(openContexts) notices.push(`${openContexts} поддоказательств остаются открытыми и ещё не закрыты выводом`);
      if(incompleteCaseGroups) notices.push(`${incompleteCaseGroups} разбор(а) по случаям не завершены`);
      if(incompleteExistenceGroups) notices.push(`${incompleteExistenceGroups} поддоказательств ∃E не завершены`);
      if(unused) notices.push(`${unused} шаг(а/ов) пока не используются последующими выводами и не отмечены как цель`);
      integrity.innerHTML = problems.length
        ? `<strong>Есть проблемы структуры:</strong> ${problems.join('; ')}.${notices.length?' <br><strong>Сводка:</strong> '+notices.join('; ')+'.':''} Формальная проверка логических схем не доказывает истинность геометрических посылок.`
        : `<strong>Структура:</strong> ссылки и формальные записи не содержат обнаруженных ошибок.${notices.length?' <br><strong>Сводка:</strong> '+notices.join('; ')+'.':''} Теоремы каталога и геометрические условия по-прежнему требуют содержательной проверки.`;
    }
    renderProofGraph();
    renderProofLibrary();
    renderProofExamples();
    renderProofContextControls();
    const goal=state.steps.find(step=>step.isGoal);
    $('#proofGoalStatus').textContent=goal?`Целевое утверждение отмечено: «${goal.claim}». GeoProof фиксирует отметку пользователя, но не подтверждает истинность вывода.`:'Цель доказательства не отмечена. Отметь один шаг как целевое утверждение после составления рассуждения.';
  }

  const assertionDefinitions = {
    equal_segments: { category:'Отрезки и длины', label: 'Равенство отрезков', searchTerms:['равные отрезки','длины равны','равенство длин','equal segments'], fields: [{key:'first',label:'Первый отрезок',kind:'segment'},{key:'second',label:'Второй отрезок',kind:'segment'}], format:v=>`${v[0]} = ${v[1]}` },
    segment_sum: { category:'Отрезки и длины', label: 'Длина целого отрезка равна сумме частей', searchTerms:['сумма частей','сложение отрезков','отрезок состоит из частей','аддитивность длины','segment addition','segment sum'], fields: [{key:'whole',label:'Целый отрезок',kind:'segment'},{key:'part1',label:'Первая часть',kind:'segment'},{key:'part2',label:'Вторая часть',kind:'segment'}], format:v=>`${v[0]} = ${v[1]} + ${v[2]}` },
    parallel_segments: { category:'Отношения между отрезками', label: 'Параллельность отрезков', searchTerms:['параллельные','параллельность','parallel'], fields: [{key:'first',label:'Первый отрезок',kind:'segment'},{key:'second',label:'Второй отрезок',kind:'segment'}], format:v=>`${v[0]} ∥ ${v[1]}` },
    perpendicular_segments: { category:'Отношения между отрезками', label: 'Перпендикулярность отрезков', searchTerms:['перпендикулярные','перпендикулярность','perpendicular'], fields: [{key:'first',label:'Первый отрезок',kind:'segment'},{key:'second',label:'Второй отрезок',kind:'segment'}], format:v=>`${v[0]} ⟂ ${v[1]}` },
    point_on_segment: { category:'Точки и принадлежность', label: 'Принадлежность точки отрезку', searchTerms:['лежит на отрезке','принадлежит отрезку','point on segment'], fields: [{key:'point',label:'Точка',kind:'point'},{key:'segment',label:'Отрезок',kind:'segment'}], format:v=>`${v[0]} ∈ ${v[1]}` },
    point_is_midpoint: { category:'Точки и принадлежность', label: 'Точка — середина отрезка', searchTerms:['середина','середина отрезка','midpoint','mid point'], fields: [{key:'point',label:'Точка-середина',kind:'point'},{key:'segment',label:'Целый отрезок',kind:'segment'}], format:v=>`${v[0]} — середина ${v[1]}` },
    point_on_line: { category:'Точки и принадлежность', label: 'Принадлежность точки прямой', searchTerms:['лежит на прямой','принадлежит прямой','point on line'], fields: [{key:'point',label:'Точка',kind:'point'},{key:'line',label:'Прямая через отрезок',kind:'segment'}], format:v=>`${v[0]} ∈ прямой (${v[1]})` },
    equal_angles: { category:'Углы', label: 'Равенство углов', searchTerms:['равные углы','равенство','equal angles'], fields: [{key:'first',label:'Первый угол',kind:'angle'},{key:'second',label:'Второй угол',kind:'angle'}], format:v=>`${v[0]} = ${v[1]}` },
    collinear_points: { category:'Точки и принадлежность', label: 'Коллинеарность трёх точек', searchTerms:['коллинеарные точки','лежат на одной прямой','collinear'], fields: [{key:'p1',label:'Первая точка',kind:'point'},{key:'p2',label:'Вторая точка',kind:'point'},{key:'p3',label:'Третья точка',kind:'point'}], format:v=>`Точки ${v.join(', ')} коллинеарны` },
    point_on_circle: { category:'Точки и принадлежность', label:'Принадлежность точки окружности', searchTerms:['точка на окружности','окружность','point on circle'], fields:[{key:'point',label:'Точка',kind:'point'},{key:'circle',label:'Окружность',kind:'circle'}], format:v=>`${v[0]} принадлежит окружности с выбранным центром` },
    triangle_congruence: { category:'Треугольники', label:'Равенство двух треугольников', searchTerms:['треугольники равны','конгруэнтность','sss','sas','asa','aas'], fields:[{key:'a1',label:'Треугольник 1 · вершина A',kind:'point'},{key:'b1',label:'Треугольник 1 · вершина B',kind:'point'},{key:'c1',label:'Треугольник 1 · вершина C',kind:'point'},{key:'a2',label:'Треугольник 2 · соответствующая вершина D',kind:'point'},{key:'b2',label:'Треугольник 2 · соответствующая вершина E',kind:'point'},{key:'c2',label:'Треугольник 2 · соответствующая вершина F',kind:'point'}], format:v=>`△${v[0]}${v[1]}${v[2]} ≅ △${v[3]}${v[4]}${v[5]}`, allowRepeated:true, distinctGroups:[[0,1,2],[3,4,5]] },
    triangle_similarity: { category:'Треугольники', label:'Подобие двух треугольников', searchTerms:['подобные треугольники','подобие','similarity','aa'], fields:[{key:'a1',label:'Треугольник 1 · вершина A',kind:'point'},{key:'b1',label:'Треугольник 1 · вершина B',kind:'point'},{key:'c1',label:'Треугольник 1 · вершина C',kind:'point'},{key:'a2',label:'Треугольник 2 · соответствующая вершина D',kind:'point'},{key:'b2',label:'Треугольник 2 · соответствующая вершина E',kind:'point'},{key:'c2',label:'Треугольник 2 · соответствующая вершина F',kind:'point'}], format:v=>`△${v[0]}${v[1]}${v[2]} ∼ △${v[3]}${v[4]}${v[5]}`, allowRepeated:true, distinctGroups:[[0,1,2],[3,4,5]] },
    isosceles_triangle: { category:'Треугольники', label:'Равнобедренный треугольник (AB = AC)', searchTerms:['равнобедренный','две равные стороны'], fields:[{key:'apex',label:'Вершина при равных сторонах A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'}], format:v=>`В △${v[0]}${v[1]}${v[2]}: ${v[0]}${v[1]} = ${v[0]}${v[2]}` },
    equilateral_triangle: { category:'Треугольники', label:'Равносторонний треугольник', searchTerms:['равносторонний','три равные стороны'], fields:[{key:'a',label:'Вершина A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'}], format:v=>`В △${v[0]}${v[1]}${v[2]}: ${v[0]}${v[1]} = ${v[1]}${v[2]} = ${v[2]}${v[0]}` },
    right_triangle: { category:'Треугольники', label:'Прямоугольный треугольник (угол при B)', searchTerms:['прямоугольный','90 градусов','правый угол'], fields:[{key:'a',label:'Точка на первом луче A',kind:'point'},{key:'b',label:'Вершина прямого угла B',kind:'point'},{key:'c',label:'Точка на втором луче C',kind:'point'}], format:v=>`∠${v[0]}${v[1]}${v[2]} = 90°` },
    triangle_centroid: { category:'Треугольники', label:'G — центроид треугольника', searchTerms:['центроид','точка пересечения медиан','центр тяжести'], fields:[{key:'a',label:'Вершина A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'},{key:'g',label:'Кандидат на центроид G',kind:'point'}], format:v=>`${v[3]} — точка пересечения медиан △${v[0]}${v[1]}${v[2]}` },
    triangle_orthocenter: { category:'Треугольники', label:'H — ортоцентр треугольника', searchTerms:['ортоцентр','точка пересечения высот'], fields:[{key:'a',label:'Вершина A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'},{key:'h',label:'Кандидат на ортоцентр H',kind:'point'}], format:v=>`${v[3]} — точка пересечения высот △${v[0]}${v[1]}${v[2]}` },
    cyclic_quadrilateral: { category:'Четырёхугольники и окружности', label:'Вписанный четырёхугольник', searchTerms:['циклический четырёхугольник','вершины на окружности'], fields:[{key:'a',label:'Вершина A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'},{key:'d',label:'Вершина D',kind:'point'}], format:v=>`Точки ${v.join(', ')} лежат на одной окружности` },
    equal_distance_point: { category:'Точки и принадлежность', label:'Равноудалённость точки от двух точек', searchTerms:['равноудалена','серединный перпендикуляр','равные расстояния'], fields:[{key:'p',label:'Точка P',kind:'point'},{key:'a',label:'Точка A',kind:'point'},{key:'b',label:'Точка B',kind:'point'}], format:v=>`${v[0]}${v[1]} = ${v[0]}${v[2]}` },
    triangle_angle_sum: { category:'Треугольники', label:'Сумма внутренних углов треугольника', searchTerms:['сумма углов','180 градусов'], fields:[{key:'a',label:'Вершина A',kind:'point'},{key:'b',label:'Вершина B',kind:'point'},{key:'c',label:'Вершина C',kind:'point'}], format:v=>`∠${v[1]}${v[0]}${v[2]} + ∠${v[0]}${v[1]}${v[2]} + ∠${v[0]}${v[2]}${v[1]} = 180°` },
    logic_and: { category:'Логические связки', label:'Конъюнкция P ∧ Q', searchTerms:['логика','и','конъюнкция','and'], fields:[], format:v=>`${v[0]} ∧ ${v[1]}` },
    logic_or: { category:'Логические связки', label:'Дизъюнкция P ∨ Q', searchTerms:['логика','или','дизъюнкция','or'], fields:[], format:v=>`${v[0]} ∨ ${v[1]}` },
    logic_implies: { category:'Логические связки', label:'Импликация P → Q', searchTerms:['логика','если то','импликация','implies'], fields:[], format:v=>`${v[0]} → ${v[1]}` },
    logic_not: { category:'Логические связки', label:'Отрицание ¬P', searchTerms:['логика','неверно','отрицание','not'], fields:[], format:v=>`¬(${v[0]})` },
    logic_bottom: { category:'Логические связки', label:'Противоречие ⊥ из P и ¬P', searchTerms:['логика','противоречие','ложь','bottom','⊥'], fields:[], format:v=>'⊥ (противоречие)' },
    logic_predicate: { category:'Кванторы и предикаты', label:'Предикат P(?x, A)', searchTerms:['предикат','переменная','атомарная формула','predicate','variable'], fields:[], format:v=>v[0] },
    logic_forall: { category:'Кванторы и предикаты', label:'Всеобщность ∀x P(x)', searchTerms:['forall','для всех','всякий','универсальный квантор','∀'], fields:[], format:v=>v[0] },
    logic_exists: { category:'Кванторы и предикаты', label:'Существование ∃x P(x)', searchTerms:['exists','существует','экзистенциальный квантор','∃'], fields:[], format:v=>v[0] }
  };

  const assertionCategoryOrder=['Отрезки и длины','Отношения между отрезками','Углы','Точки и принадлежность','Треугольники','Четырёхугольники и окружности','Логические связки','Кванторы и предикаты'];
  function renderAssertionTypeCatalog(selectedType='text') {
    const select=$('#assertionType'), query=($('#assertionSearch')?.value||'').trim().toLocaleLowerCase('ru');
    select.replaceChildren();
    const free=document.createElement('option'); free.value='text'; free.textContent='Свободный текст'; select.append(free);
    const custom=document.createElement('option'); custom.value='custom'; custom.textContent='Свободное утверждение с объектами'; select.append(custom);
    for(const category of assertionCategoryOrder){
      const matches=Object.entries(assertionDefinitions).filter(([key,def])=>def.category===category && `${def.label} ${category} ${key} ${(def.searchTerms||[]).join(' ')}`.toLocaleLowerCase('ru').includes(query));
      if(!matches.length) continue;
      const group=document.createElement('optgroup'); group.label=category;
      matches.forEach(([key,def])=>{const option=document.createElement('option');option.value=key;option.textContent=def.label;group.append(option);});
      select.append(group);
    }
    const selectedExists=[...select.options].some(option=>option.value===selectedType);
    select.value=selectedExists?selectedType:'text';
    if(query && select.options.length===1){const noResults=document.createElement('option');noResults.value='';noResults.textContent='Ничего не найдено — используй свободный текст';noResults.disabled=true;select.append(noResults);}
  }

  function assertionObjectOptions(kind) {
    if (kind === 'point') return state.points.map(item=>({id:item.id,label:item.name}));
    if (kind === 'angle') return state.angles.map(item=>({id:item.id,label:`∠${pointById(item.aId)?.name||'?'}${pointById(item.vertexId)?.name||'?'}${pointById(item.cId)?.name||'?'}`}));
    if (kind === 'circle') return state.circles.map(item=>({id:item.id,label:`Окружность с центром ${pointById(item.centerId)?.name||'?'}`}));
    return state.segments.map(item=>({id:item.id,label:displaySegmentName(item)}));
  }

  function renderAssertionBuilder(existingAssertion = null, existingFormulaExpression = null, existingFormulaSnapshot = null) {
    const type = $('#assertionType').value;
    const host = $('#assertionObjectFields'); host.replaceChildren();
    if(type==='logic_predicate'){
      const formula=existingFormulaSnapshot?.op==='atom'&&existingFormulaSnapshot.predicate==='user_predicate'?existingFormulaSnapshot:null;
      const intro=document.createElement('div');intro.className='logic-formula-intro';
      intro.textContent='Создай атомарное высказывание P(t₁,…,tₙ). Запись ?x обозначает свободную переменную; A, c и другие термы без знака ? считаются константами. Текст предиката сам по себе не получает геометрического смысла.';
      const grid=document.createElement('div');grid.className='logic-formula-fields single';
      const predicateWrap=document.createElement('div');const predicateLabel=document.createElement('label');predicateLabel.textContent='Имя предиката';
      const predicateInput=document.createElement('input');predicateInput.className='field-input';predicateInput.dataset.predicateName='';predicateInput.placeholder='Например: P';predicateInput.value=formula?.text||'P';predicateInput.maxLength=40;
      predicateWrap.append(predicateLabel,predicateInput);
      const termsWrap=document.createElement('div');const termsLabel=document.createElement('label');termsLabel.textContent='Аргументы через запятую (можно оставить пустыми)';
      const termsInput=document.createElement('input');termsInput.className='field-input';termsInput.dataset.predicateTerms='';termsInput.placeholder='Например: ?x, A';termsInput.value=(formula?.terms||[]).map(term=>term.kind==='variable'?`?${term.name}`:term.name||term.id||'').join(', ');termsInput.maxLength=200;
      termsWrap.append(termsLabel,termsInput);grid.append(predicateWrap,termsWrap);host.append(intro,grid);
      predicateInput.addEventListener('input',updateAssertionPreview);termsInput.addEventListener('input',updateAssertionPreview);updateAssertionPreview();return;
    }
    if(type==='logic_forall'||type==='logic_exists'){
      const op=type==='logic_forall'?'forall':'exists';
      const sourceIds=existingFormulaExpression?.sourceStepIds||[];
      const currentVariable=existingFormulaExpression?.variable||existingFormulaSnapshot?.variable||'x';
      const intro=document.createElement('div');intro.className='logic-formula-intro';
      intro.textContent=op==='forall'?'Выбери формулу со свободной переменной ?x. Квантор свяжет именно её в выбранном высказывании.':'Выбери формулу со свободной переменной ?x. Квантор свяжет переменную и утверждает существование хотя бы одного подходящего объекта.';
      const fields=document.createElement('div');fields.className='logic-formula-fields single';
      const editingIndex=state.editingStepId?state.steps.findIndex(step=>step.id===state.editingStepId):state.steps.length;
      const available=state.steps.slice(0,editingIndex<0?state.steps.length:editingIndex).filter(step=>!!getStepFormula(step.id)&&proofStepVisibleInContext(step,state.editingStepId?proofPath(state.steps[editingIndex]):state.activeProofContextIds));
      const sourceWrap=document.createElement('div');const sourceLabel=document.createElement('label');sourceLabel.textContent='Формула, в которой связывается переменная';
      const select=document.createElement('select');select.dataset.formulaSource='0';const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выбери предыдущий шаг';select.append(placeholder);
      available.forEach(step=>{const option=document.createElement('option');option.value=step.id;option.textContent=`Шаг ${state.steps.indexOf(step)+1}: ${step.claim}`;select.append(option);});
      if(sourceIds[0]&&[...select.options].some(option=>option.value===sourceIds[0]))select.value=sourceIds[0];
      select.addEventListener('change',updateAssertionPreview);sourceWrap.append(sourceLabel,select);
      const variableWrap=document.createElement('div');const variableLabel=document.createElement('label');variableLabel.textContent='Связываемая переменная (без знака ?)';
      const variableInput=document.createElement('input');variableInput.className='field-input';variableInput.dataset.quantifierVariable='';variableInput.value=currentVariable;variableInput.placeholder='x';variableInput.maxLength=24;
      variableInput.addEventListener('input',updateAssertionPreview);variableWrap.append(variableLabel,variableInput);
      fields.append(sourceWrap,variableWrap);host.append(intro,fields);updateAssertionPreview();return;
    }
    if (type.startsWith('logic_')) {
      const op=type.slice(6);
      const arity=op==='not'?1:2;
      const sourceIds=existingFormulaExpression?.sourceStepIds||[];
      const intro=document.createElement('div');intro.className='logic-formula-intro';
      intro.textContent='Выбери ранее сформулированные высказывания, из которых состоит логическая запись. Это задаёт синтаксис формулы, но не доказывает её истинность. Для получения нового вывода выбери соответствующее правило логики и укажи его посылки.';
      const fields=document.createElement('div');fields.className='logic-formula-fields'+(arity===1?' single':'');
      const editingIndex=state.editingStepId?state.steps.findIndex(step=>step.id===state.editingStepId):state.steps.length;
      const available=state.steps.slice(0,editingIndex<0?state.steps.length:editingIndex).filter(step=>!!getStepFormula(step.id)&&proofStepVisibleInContext(step, state.editingStepId?proofPath(state.steps[editingIndex]):state.activeProofContextIds));
      const names=op==='and'?['Левая часть P','Правая часть Q']:op==='or'?['Левая часть P','Правая часть Q']:op==='implies'?['Условие P','Следствие Q']:op==='bottom'?['Высказывание P','Противоположное высказывание ¬P']:['Высказывание P'];
      for(let i=0;i<arity;i++){
        const wrap=document.createElement('div');
        const label=document.createElement('label');label.textContent=names[i];
        const select=document.createElement('select');select.dataset.formulaSource=String(i);
        const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выбери предыдущий шаг';select.append(placeholder);
        available.forEach(step=>{
          const option=document.createElement('option');option.value=step.id;option.textContent=`Шаг ${state.steps.indexOf(step)+1}: ${step.claim}`;select.append(option);
        });
        if(sourceIds[i]&&[...select.options].some(option=>option.value===sourceIds[i]))select.value=sourceIds[i];
        select.addEventListener('change',updateAssertionPreview);
        wrap.append(label,select);fields.append(wrap);
      }
      host.append(intro,fields);updateAssertionPreview();return;
    }
    if (type === 'custom') {
      const intro=document.createElement('div'); intro.className='small';
      intro.textContent='Сформулируй утверждение в поле ниже и при необходимости привяжи к нему любые объекты чертежа. Эти связи описывают структуру, но не подтверждают истинность.';
      host.append(intro);
      const rows=document.createElement('div'); rows.className='custom-object-rows'; rows.id='customAssertionRows';
      const initial=(existingAssertion?.type==='custom'?(existingAssertion.objects||[]).map((id,i)=>({id,kind:existingAssertion.objectKinds?.[i]||'point'})):[]);
      const addRow=(kind='point',objectId='')=>{
        const row=document.createElement('div'); row.className='custom-object-row';
        const kindSelect=document.createElement('select'); kindSelect.className='field-select'; kindSelect.dataset.customKind='';
        [['point','Точка'],['segment','Отрезок'],['angle','Угол'],['circle','Окружность']].forEach(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;kindSelect.append(option);});
        kindSelect.value=kind;
        const objectSelect=document.createElement('select'); objectSelect.className='field-select'; objectSelect.dataset.customObject='';
        const fillObjects=()=>{
          const previous=objectSelect.value || objectId; objectSelect.replaceChildren();
          const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выбери объект';objectSelect.append(placeholder);
          assertionObjectOptions(kindSelect.value).forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.label;objectSelect.append(option);});
          if(previous && [...objectSelect.options].some(option=>option.value===previous)) objectSelect.value=previous;
        };
        fillObjects(); kindSelect.addEventListener('change',()=>{objectId='';fillObjects();});
        const remove=document.createElement('button');remove.type='button';remove.className='btn subtle';remove.textContent='×';remove.title='Убрать объект';
        remove.addEventListener('click',()=>row.remove());
        row.append(kindSelect,objectSelect,remove); rows.append(row);
      };
      initial.forEach(item=>addRow(item.kind,item.id));
      const add=document.createElement('button');add.type='button';add.className='btn subtle';add.textContent='+ Добавить объект';
      add.addEventListener('click',()=>addRow());
      host.append(rows,add);
      $('#assertionPreview').textContent='Свободная формулировка. Привязанные объекты будут сохранены вместе с утверждением.';
      return;
    }
    const def = assertionDefinitions[type];
    if (!def) { $('#assertionPreview').textContent='Можно ввести утверждение обычным текстом.'; return; }
    const grid=document.createElement('div'); grid.className='builder-grid';
    def.fields.forEach((field,index)=>{
      const wrap=document.createElement('div');
      const label=document.createElement('label'); label.textContent=field.label;
      const select=document.createElement('select'); select.dataset.assertionField=field.key;
      const placeholder=document.createElement('option'); placeholder.value=''; placeholder.textContent='Выбери объект'; select.append(placeholder);
      assertionObjectOptions(field.kind).forEach(option=>{const el=document.createElement('option');el.value=option.id;el.textContent=option.label;select.append(el);});
      const oldId=existingAssertion?.objects?.[index]; if(oldId && [...select.options].some(o=>o.value===oldId)) select.value=oldId;
      select.addEventListener('change',updateAssertionPreview);
      wrap.append(label,select); grid.append(wrap);
    });
    host.append(grid); updateAssertionPreview();
  }

  function currentStructuredAssertion() {
    const type=$('#assertionType').value;
    if(type==='logic_predicate'){
      const name=$('#assertionObjectFields').querySelector('[data-predicate-name]')?.value.trim()||'';
      const rawTerms=$('#assertionObjectFields').querySelector('[data-predicate-terms]')?.value||'';
      if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))return null;
      const tokens=rawTerms.trim()?rawTerms.split(',').map(item=>item.trim()):[];
      if(tokens.some(token=>!token||!(/^(\?[A-Za-z][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*|[0-9]+)$/.test(token))))return null;
      const terms=tokens.map(token=>token.startsWith('?')?{kind:'variable',name:token.slice(1)}:{kind:'constant',name:token});
      const formulaSnapshot={op:'atom',predicate:'user_predicate',text:name,terms};
      return {type:'logic',formulaSnapshot,claim:displayFormulaAst(formulaSnapshot)};
    }
    if(type==='logic_forall'||type==='logic_exists'){
      const op=type==='logic_forall'?'forall':'exists';
      const sourceStepIds=[...$('#assertionObjectFields').querySelectorAll('select[data-formula-source]')].map(select=>select.value);
      const variable=$('#assertionObjectFields').querySelector('[data-quantifier-variable]')?.value.trim()||'';
      if(sourceStepIds.length!==1||!sourceStepIds[0]||!/^([A-Za-z][A-Za-z0-9_]*)$/.test(variable))return null;
      const source=state.steps.find(step=>step.id===sourceStepIds[0]);const body=source?getStepFormula(source.id):null;
      if(!body||!freeVariableNames(body).has(variable))return null;
      const formulaExpression={op,sourceStepIds,variable};
      const preview={op,variable,args:[body]};
      return {type:'logic',formulaExpression,claim:displayFormulaAst(preview)};
    }
    if(type.startsWith('logic_')) {
      const op=type.slice(6), sourceStepIds=[...$('#assertionObjectFields').querySelectorAll('select[data-formula-source]')].map(select=>select.value);
      const expected=op==='not'?1:2;
      if(sourceStepIds.length!==expected||sourceStepIds.some(id=>!id)) return null;
      if(new Set(sourceStepIds).size!==sourceStepIds.length && op!=='not') return null;
      if(sourceStepIds.some(id=>!state.steps.some(step=>step.id===id&&step.id!==state.editingStepId)||!getStepFormula(id))) return null;
      const formulaExpression={op,sourceStepIds};
      const labels=sourceStepIds.map(id=>displayFormulaForStep(id));
      const symbol={and:'∧',or:'∨',implies:'→',not:'¬',bottom:'⊥'}[op];
      const claim=op==='not'?`¬(${labels[0]})`:op==='bottom'?`⊥ (попытка вывести из ${labels[0]} и ${labels[1]})`:`(${labels[0]}) ${symbol} (${labels[1]})`;
      return {type:'logic',formulaExpression,claim};
    }
    if(type==='custom') {
      const rows=[...$('#assertionObjectFields').querySelectorAll('.custom-object-row')];
      const objectKinds=[],objects=[];
      for(const row of rows){
        const kind=row.querySelector('[data-custom-kind]')?.value;
        const objectId=row.querySelector('[data-custom-object]')?.value;
        if(!objectId) continue;
        objectKinds.push(kind); objects.push(objectId);
      }
      return {type:'custom',objects,objectKinds,claim:$('#claimInput').value.trim()};
    }
    const def=assertionDefinitions[type];
    if(!def) return null;
    const selects=[...$('#assertionObjectFields').querySelectorAll('select[data-assertion-field]')];
    if(selects.length!==def.fields.length || selects.some(x=>!x.value)) return null;
    const objects=selects.map(x=>x.value);
    if(def.allowRepeated!==true && new Set(objects).size!==objects.length) return null;
    if((def.distinctGroups||[]).some(group=>new Set(group.map(index=>objects[index])).size!==group.length)) return null;
    const labels=selects.map((select,index)=>{
      const kind=def.fields[index].kind;
      if(kind==='point') return pointById(select.value)?.name||'?';
      if(kind==='angle'){const angle=state.angles.find(item=>item.id===select.value);return angle?`∠${pointById(angle.aId)?.name||'?'}${pointById(angle.vertexId)?.name||'?'}${pointById(angle.cId)?.name||'?'}`:'?';}
      if(kind==='circle'){const circle=state.circles.find(item=>item.id===select.value);return circle?`○(${pointById(circle.centerId)?.name||'?'})`:'?';}
      const obj=segmentById(select.value); return obj?displaySegmentName(obj):'?';
    });
    return {type,objects,claim:def.format(labels)};
  }

  function updateAssertionPreview() {
    if($('#assertionType').value==='custom') return;
    const assertion=currentStructuredAssertion();
    $('#assertionPreview').textContent=assertion?`Получится: ${assertion.claim}`:'Выбери все необходимые объекты или предыдущие утверждения.';
    if(assertion) $('#claimInput').value=assertion.claim;
  }

  function openAssumptionEditor(){
    if(state.creatingAssumption)return;
    state.creatingAssumption=true;
    openStepEditor();
    state.creatingAssumption=true;
    $('#stepModalTitle').textContent='Начать поддоказательство · ввести предположение';
    $('#basisType').value='assumption';$('#basisType').disabled=true;
    $('#basisRule').value='';$('#basisRule').disabled=true;
    $('#reasonInput').value='Временное предположение внутри поддоказательства. Оно будет снято при закрытии контекста.';
    $('#assertionSearch').value='';
    $('#claimInput').placeholder='Предположим P: ...';
    $('#saveStep').textContent='Начать поддоказательство';
  }
  function openCloseSubproofModal(){
    const context=activeProofContext();
    if(!context){alert('Нет открытого поддоказательства.');return;}
    const assumption=state.steps.find(step=>step.id===context.assumptionStepId);
    if(!assumption){alert('Не найдено исходное предположение контекста.');return;}
    const assumptionFormula=getStepFormula(assumption.id);
    const expectedPath=[...(context.parentPath||[]),context.id];
    const candidates=state.steps.filter(step=>step.id!==assumption.id&&sameArray(proofPath(step),expectedPath)&&state.steps.indexOf(step)>state.steps.indexOf(assumption)&&!!getStepFormula(step.id));
    if(!candidates.length){alert('Внутри поддоказательства пока нет формального заключения. Добавь шаг Q, который следует из предположения P, затем закрой контекст.');return;}
    $('#subproofAssumptionText').textContent=`Предположение: ${assumption.claim} · Формальная запись: ${displayFormulaForStep(assumption.id)}`;
    const isCase=!!context.caseGroupId,isExistsElim=!!context.existsElimGroupId,canUseRAA=assumptionFormula?.op==='not';
    $('#subproofModalTitle').textContent=isCase?'Завершить случай разбора P ∨ Q':isExistsElim?'Завершить поддоказательство · ∃E':'Завершить поддоказательство';
    $('#confirmSubproof').hidden=isCase||isExistsElim;$('#confirmNegationSubproof').hidden=isCase||isExistsElim;$('#confirmRAASubproof').hidden=isCase||isExistsElim||!canUseRAA;$('#confirmCaseConclusion').hidden=!isCase;$('#confirmExistsSubproof').hidden=!isExistsElim;
    $('#confirmSubproof').textContent='Закрыть и вывести P → Q';$('#confirmNegationSubproof').textContent='Закрыть и вывести ¬P';$('#confirmRAASubproof').textContent='Закрыть и вывести P · RAA';$('#confirmExistsSubproof').textContent='Закрыть и применить ∃E';
    $('#subproofConsequenceLabel').textContent=isCase?'Какое общее заключение R получено в этом случае?':isExistsElim?'Какое внешнее заключение Q получено с использованием существующего свидетеля?':'Какое утверждение доказано внутри предположения?';
    const existsGroup=isExistsElim?state.proofExistenceGroups.find(item=>item.id===context.existsElimGroupId):null;
    $('#subproofHint').textContent=isCase?'После завершения первого случая GeoProof откроет второй. Оба случая должны привести к одной и той же формуле R.':isExistsElim?`Внутри предполагается тело ∃-утверждения для свежего параметра ${existsGroup?.eigenparameter||'c'}. Итоговое Q не должно содержать этот параметр; он не может влиять на заключение.`:canUseRAA?'Для классического RAA предположение должно иметь вид ¬P, а внутренним заключением должно быть противоречие ⊥. После закрытия контекста GeoProof выведет P.':'GeoProof применит введение импликации (→I) или отрицания (¬I) и снимет временное предположение.';
    const select=$('#subproofConsequence');select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выбери доказанное заключение Q';select.append(placeholder);
    candidates.forEach(step=>{const option=document.createElement('option');option.value=step.id;option.textContent=`Шаг ${state.steps.indexOf(step)+1}: ${step.claim}`;select.append(option);});
    $('#subproofModal').style.display='flex';
  }
  function closeCurrentSubproof(mode='implies'){
    const context=activeProofContext(), consequentId=$('#subproofConsequence').value;
    if(!context||!consequentId)return;
    if(context.caseGroupId){closeDisjunctionCase(context,consequentId);return;}
    const assumption=state.steps.find(step=>step.id===context.assumptionStepId),consequent=state.steps.find(step=>step.id===consequentId);
    if(!assumption||!consequent||!sameArray(proofPath(consequent),[...(context.parentPath||[]),context.id])){alert('Выбранное заключение не принадлежит текущему поддоказательству.');return;}
    const assumptionFormula=getStepFormula(assumption.id),consequentFormula=getStepFormula(consequent.id);
    if(!assumptionFormula||!consequentFormula){alert('Не удалось получить формальную запись предположения или заключения.');return;}
    if(mode==='exists'){
      const group=state.proofExistenceGroups.find(item=>item.id===context.existsElimGroupId),source=group?state.steps.find(item=>item.id===group.existentialStepId):null,existential=source?getStepFormula(source.id):null;
      if(!group||group.status!=='open'||existential?.op!=='exists'||!sameArray(proofPath(consequent),[...(context.parentPath||[]),context.id])){alert('Контекст не связан с корректным исходным утверждением ∃x P(x).');return;}
      const expectedWitness=substituteFormula(existential.args[0],existential.variable,{kind:'constant',name:group.eigenparameter});
      if(!sameFormula(assumptionFormula,expectedWitness)){alert('Временное предположение не совпадает с телом существующего утверждения для свежего параметра.');return;}
      if(formulaContainsConstant(consequentFormula,group.eigenparameter)){alert(`Нельзя вывести Q, содержащее свежий параметр ${group.eigenparameter}. Измени заключение так, чтобы оно не зависело от конкретного свидетеля.`);return;}
      if(!eigenconstantIsFresh(group.eigenparameter,group)){alert(`Параметр ${group.eigenparameter} не является свежим относительно исходной ∃-формулы или внешних не снятых предположений.`);return;}
      pushHistory();context.status='closed';context.consequentStepId=consequent.id;context.closingRuleId='logic_exists_elim';context.closedByStepId=`proof-${Date.now()}-${state.steps.length+1}`;
      const resultId=context.closedByStepId,resultFormula=clone(consequentFormula);
      const result={id:resultId,claim:displayFormulaAst(resultFormula),reason:`Устранение существования (∃E): из ${displayFormulaForStep(source.id)} взят свежий параметр ${group.eigenparameter}; внутри временного предположения доказано заключение, не содержащее этот параметр.`,basisType:'logic',basisRuleId:'logic_exists_elim',references:[source.id,consequent.id],isGoal:false,assertion:null,formulaExpression:null,formulaSnapshot:resultFormula,formulaSourceLost:false,contextPath:[...(context.parentPath||[])],dischargedContextId:context.id,existenceEliminationGroupId:group.id};
      state.steps.push(result);group.consequentStepId=consequent.id;group.resultStepId=resultId;group.status='closed';state.activeProofContextIds=[...(context.parentPath||[])];$('#subproofModal').style.display='none';renderProof();return;
    }
    if(mode==='negation'&&consequentFormula.op!=='bottom'){alert('Для введения отрицания (¬I) внутренним заключением должно быть противоречие ⊥. Сначала выведи ⊥ из пары P и ¬P.');return;}
    if(mode==='raa'&&(assumptionFormula.op!=='not'||!Array.isArray(assumptionFormula.args)||assumptionFormula.args.length!==1||consequentFormula.op!=='bottom')){alert('Для классического RAA нужно временно предположить ¬P и вывести внутри этого контекста противоречие ⊥.');return;}
    if(mode==='raa'){
      const contradictionAudit=auditProofStep(consequent,state.steps.indexOf(consequent));
      if(contradictionAudit.status!=='checked'){alert(`Для RAA требуется структурно проверенное противоречие, полученное по ⊥I. ${contradictionAudit.detail||'Проверь источник противоречия.'}`);return;}
    }
    pushHistory();
    const ruleId=mode==='negation'?'logic_negation_intro':mode==='raa'?'logic_raa':'logic_implies_intro';
    context.status='closed';context.consequentStepId=consequent.id;context.closingRuleId=ruleId;
    const stepId=`proof-${Date.now()}-${state.steps.length+1}`;
    const formulaExpression=mode==='raa'?null:mode==='negation'?{op:'not',sourceStepIds:[assumption.id]}:{op:'implies',sourceStepIds:[assumption.id,consequent.id]};
    const formulaSnapshot=mode==='raa'?clone(assumptionFormula.args[0]):null;
    const claim=mode==='raa'?displayFormulaAst(formulaSnapshot):mode==='negation'?`Отрицание утверждения: ${assumption.claim}`:`Если ${assumption.claim}, то ${consequent.claim}`;
    const reason=mode==='raa'?'Классическое доказательство от противного (RAA): временное предположение ¬P приводит к противоречию ⊥, поэтому в классической логике выводится P.':mode==='negation'?'Введение отрицания (¬I): временное предположение P приводит к противоречию ⊥, поэтому предположение снимается.':'Введение импликации (→I): временное предположение P снято после вывода Q внутри поддоказательства.';
    const result={id:stepId,claim,reason,basisType:'logic',basisRuleId:ruleId,references:mode==='raa'?[assumption.id,consequent.id]:[consequent.id],isGoal:false,assertion:null,formulaExpression,formulaSnapshot,formulaSourceLost:false,contextPath:[...(context.parentPath||[])],dischargedContextId:context.id};
    state.steps.push(result);context.closedByStepId=stepId;
    state.activeProofContextIds=[...(context.parentPath||[])];
    $('#subproofModal').style.display='none';renderProof();
  }


  function openStepEditor(stepId = null, presetRuleId = null) {
    state.creatingAssumption=false;
    const existing = stepId ? state.steps.find(step => step.id === stepId) : null;
    const presetRule=proofRuleById(presetRuleId);
    state.editingStepId = stepId;
    lastSuggestedRuleReason='';
    $('#stepModalTitle').textContent = existing ? 'Редактировать шаг доказательства' : 'Добавить шаг доказательства';
    $('#claimInput').value = existing?.claim || '';
    $('#reasonInput').value = existing?.reason || '';
    $('#isGoalInput').checked = !!existing?.isGoal;
    $('#basisType').disabled=!!existing?.isAssumption;
    $('#basisType').value = existing?.basisType || presetRule?.basis || 'condition';
    $('#basisRuleSearch').value='';
    $('#assertionSearch').value='';
    renderBasisRuleSelector(existing?.basisRuleId || presetRule?.id || '');
    $('#basisRule').disabled=!!existing?.isAssumption;
    const snapshotType=existing?.formulaSnapshot?.predicate==='user_predicate'?'logic_predicate':null;
    const statementType=snapshotType || (existing?.formulaExpression?.op ? `logic_${existing.formulaExpression.op}` : (existing?.assertion?.type || 'text'));
    renderAssertionTypeCatalog(statementType);
    renderAssertionBuilder(existing?.assertion || null, existing?.formulaExpression || null, existing?.formulaSnapshot || null);
    const picker = $('#stepReferences'); picker.replaceChildren();
    $('#stepReferenceSearch').value='';
    const currentIndex = stepId ? state.steps.findIndex(step => step.id === stepId) : state.steps.length;
    const currentPath=existing?proofPath(existing):state.activeProofContextIds;
    const available = state.steps.slice(0, currentIndex).filter(step=>proofStepVisibleInContext(step,currentPath));
    if (!available.length) {
      const hint = document.createElement('span'); hint.className = 'small'; hint.textContent = 'Пока нет предыдущих шагов.'; picker.append(hint);
    } else {
      available.forEach(step => {
        const label = document.createElement('label'); label.className = 'reference-option';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = step.id;
        checkbox.checked = (existing?.references || []).includes(step.id);
        const text = document.createElement('span'); text.textContent = `Шаг ${state.steps.indexOf(step)+1}: ${step.claim}`;
        label.append(checkbox, text); picker.append(label);
      });
    }
    $('#saveStep').textContent = existing ? 'Сохранить изменения' : 'Добавить шаг';
    $('#stepModal').style.display = 'flex'; $('#claimInput').focus();
  }

  // First-order terms and formulas are explicit syntax trees. A token prefixed
  // with '?' is a variable; an unprefixed name is a constant symbol.
  function validLogicalName(value){return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(value);}
  function freeVariableNames(formula,bound=new Set(),out=new Set()){
    if(!formula)return out;
    const visitTerm=term=>{
      if(!term)return;
      if(term.kind==='variable'&&typeof term.name==='string'&&!bound.has(term.name))out.add(term.name);
      if(term.kind==='sum')(term.terms||[]).forEach(visitTerm);
    };
    if(formula.op==='atom')(formula.terms||[]).forEach(visitTerm);
    else if(formula.op==='forall'||formula.op==='exists'){
      const next=new Set(bound);next.add(formula.variable);freeVariableNames(formula.args?.[0],next,out);
    } else (formula.args||[]).forEach(child=>freeVariableNames(child,bound,out));
    return out;
  }
  function allFormulaTerms(formula,out=[]){
    if(!formula)return out;
    const visitTerm=term=>{if(!term)return;if(term.kind==='sum')(term.terms||[]).forEach(visitTerm);else out.push(term);};
    if(formula.op==='atom')(formula.terms||[]).forEach(visitTerm);
    else (formula.args||[]).forEach(child=>allFormulaTerms(child,out));
    return out;
  }
  function renameBoundOccurrences(formula,oldName,newName){
    if(!formula)return formula;
    const renameTerm=term=>{if(!term)return term;if(term.kind==='variable'&&term.name===oldName)return {...term,name:newName};if(term.kind==='sum')return {...term,terms:(term.terms||[]).map(renameTerm)};return clone(term);};
    if(formula.op==='atom')return {...formula,terms:(formula.terms||[]).map(renameTerm)};
    if((formula.op==='forall'||formula.op==='exists')&&formula.variable===oldName)return clone(formula);
    return {...formula,args:(formula.args||[]).map(child=>renameBoundOccurrences(child,oldName,newName))};
  }
  function freshVariableName(formula,avoid=[]){
    // Avoid every variable symbol in the subtree, including variables bound by
    // nested quantifiers; checking only free variables could cause capture.
    const used=new Set([...allFormulaTerms(formula).filter(term=>term.kind==='variable').map(term=>term.name),...avoid]);
    let index=1,name='z';while(used.has(name))name=`z${index++}`;return name;
  }
  function substituteFormula(formula,variable,replacement){
    if(!formula)return null;
    if(formula.op==='atom'){
      const substituteTerm=term=>{
        if(term.kind==='variable'&&term.name===variable)return clone(replacement);
        if(term.kind==='sum')return {...term,terms:(term.terms||[]).map(substituteTerm)};
        return clone(term);
      };
      return {...formula,terms:(formula.terms||[]).map(substituteTerm)};
    }
    if(formula.op==='forall'||formula.op==='exists'){
      if(formula.variable===variable)return clone(formula);
      let binder=formula.variable,body=formula.args?.[0];
      if(replacement.kind==='variable'&&binder===replacement.name&&freeVariableNames(body).has(variable)){
        const renamed=freshVariableName(body,[variable,replacement.name]);
        body=renameBoundOccurrences(body,binder,renamed);binder=renamed;
      }
      return {...formula,variable:binder,args:[substituteFormula(body,variable,replacement)]};
    }
    return {...formula,args:(formula.args||[]).map(child=>substituteFormula(child,variable,replacement))};
  }
  function quantifiedInstances(quantified,instance){
    if(!quantified||!['forall','exists'].includes(quantified.op)||!validLogicalName(quantified.variable)||!quantified.args?.[0])return [];
    const candidates=allFormulaTerms(instance);
    const unique=new Map(candidates.map(term=>[formulaTermKey(term),term]));
    return [...unique.values()].filter(term=>sameFormula(substituteFormula(quantified.args[0],quantified.variable,term),instance));
  }
  function formulaContainsConstant(formula,name){return allFormulaTerms(formula).some(term=>term.kind==='constant'&&term.name===name);}
  function undischargedAssumptionSteps(atStep){
    const path=proofPath(atStep);
    return state.steps.filter(candidate=>{
      if(candidate===atStep)return false;
      if(candidate.basisType==='condition')return pathIsPrefix(proofPath(candidate),path);
      return candidate.isAssumption&&path.includes(candidate.assumptionContextId);
    });
  }
  function freeVariableIsFresh(name,atStep){
    return undischargedAssumptionSteps(atStep).every(candidate=>!freeVariableNames(getStepFormula(candidate.id)).has(name));
  }
  function eigenconstantIsFresh(name,group){
    const existential=group?getStepFormula(group.existentialStepId):null;
    if(!group||!existential||formulaContainsConstant(existential,name))return false;
    const outerScope={contextPath:[...(group.parentPath||[])]};
    return undischargedAssumptionSteps(outerScope).every(candidate=>!formulaContainsConstant(getStepFormula(candidate.id),name));
  }
  function appendDisjunctionCase(group,index){
    const disjunctionStep=state.steps.find(step=>step.id===group.disjunctionStepId),formula=getStepFormula(group.disjunctionStepId);
    if(!disjunctionStep||formula?.op!=='or'||!formula.args?.[index])throw new Error('Исходная дизъюнкция больше недоступна.');
    const contextId=`case-context-${Date.now()}-${state.proofContexts.length+1}-${index}`;
    const assumptionId=`case-assumption-${Date.now()}-${state.steps.length+1}-${index}`;
    const assumptionFormula=clone(formula.args[index]),assumptionText=displayFormulaAst(assumptionFormula);
    const contextPath=[...(group.parentPath||[]),contextId];
    const assumption={id:assumptionId,claim:assumptionText,reason:`Временное предположение для случая ${index+1} при устранении дизъюнкции.`,basisType:'assumption',basisRuleId:null,references:[],isGoal:false,assertion:null,formulaExpression:null,formulaSnapshot:assumptionFormula,formulaSourceLost:false,contextPath,isAssumption:true,assumptionContextId:contextId,caseGroupId:group.id,caseIndex:index};
    const context={id:contextId,label:`Случай ${index+1}: ${assumptionText}`,parentPath:[...(group.parentPath||[])],assumptionStepId:assumptionId,status:'open',consequentStepId:null,closedByStepId:null,closingRuleId:null,caseGroupId:group.id,caseIndex:index};
    group.caseContextIds[index]=contextId;group.caseAssumptionStepIds[index]=assumptionId;
    state.proofContexts.push(context);state.steps.push(assumption);state.activeProofContextIds=contextPath;
  }
  function openDisjunctionCasesModal(){
    if(activeProofContext()?.caseGroupId){alert('Разбор случаев уже выполняется. Сначала заверши текущий случай.');return;}
    const candidates=visibleDisjunctionSteps();if(!candidates.length){alert('В текущей области нет доступной формальной дизъюнкции P ∨ Q. Сначала сформулируй её как шаг доказательства.');return;}
    const select=$('#caseDisjunctionSelect');select.replaceChildren();
    candidates.forEach(step=>{const option=document.createElement('option');option.value=step.id;option.textContent=`Шаг ${state.steps.indexOf(step)+1}: ${step.claim}`;select.append(option);});
    $('#orElimStartModal').style.display='flex';
  }
  function startDisjunctionCases(){
    const sourceId=$('#caseDisjunctionSelect').value,source=state.steps.find(step=>step.id===sourceId),formula=getStepFormula(sourceId);
    if(!source||formula?.op!=='or'||!proofStepVisibleInContext(source,state.activeProofContextIds)){alert('Выбери доступную дизъюнкцию P ∨ Q.');return;}
    pushHistory();
    const group={id:`case-group-${Date.now()}-${state.proofCaseGroups.length+1}`,disjunctionStepId:sourceId,parentPath:[...state.activeProofContextIds],caseContextIds:[null,null],caseAssumptionStepIds:[null,null],caseConsequentStepIds:[null,null],status:'first-open',resultStepId:null};
    state.proofCaseGroups.push(group);
    appendDisjunctionCase(group,0);
    $('#orElimStartModal').style.display='none';setProofTab('work');renderProof();
  }
  function openCaseTwo(group){
    group.status='second-open';appendDisjunctionCase(group,1);$('#subproofModal').style.display='none';renderProof();
  }
  function closeDisjunctionCase(context,consequentId){
    const group=state.proofCaseGroups.find(item=>item.id===context.caseGroupId),index=context.caseIndex||0;
    const consequent=state.steps.find(step=>step.id===consequentId);
    if(!group||!consequent||!sameArray(proofPath(consequent),[...(context.parentPath||[]),context.id])){alert('Выбранное заключение должно находиться непосредственно внутри текущего случая.');return;}
    const consequentFormula=getStepFormula(consequent.id);if(!consequentFormula){alert('Заключение не имеет доступной формальной записи.');return;}
    if(index===1){const first=state.steps.find(step=>step.id===group.caseConsequentStepIds[0]);if(!first||!sameFormula(getStepFormula(first.id),consequentFormula)){alert('Оба случая должны приводить к одной и той же формуле R. Выбери заключение, совпадающее с первым случаем.');return;}}
    pushHistory();context.status='case-closed';context.consequentStepId=consequent.id;context.closingRuleId='logic_or_elim';group.caseConsequentStepIds[index]=consequent.id;state.activeProofContextIds=[...(group.parentPath||[])];
    if(index===0){openCaseTwo(group);return;}
    const disjunction=state.steps.find(step=>step.id===group.disjunctionStepId),left=state.steps.find(step=>step.id===group.caseConsequentStepIds[0]),right=state.steps.find(step=>step.id===group.caseConsequentStepIds[1]);
    if(!disjunction||!left||!right){alert('Не удалось собрать результаты двух случаев.');return;}
    const resultFormula=clone(getStepFormula(left.id));
    const resultId=`proof-${Date.now()}-${state.steps.length+1}`;
    const result={id:resultId,claim:displayFormulaAst(resultFormula),reason:'Устранение дизъюнкции (∨E): исходная дизъюнкция разбита на случаи P и Q; в обоих случаях получено одинаковое заключение R.',basisType:'logic',basisRuleId:'logic_or_elim',references:[disjunction.id,left.id,right.id],isGoal:false,assertion:null,formulaExpression:null,formulaSnapshot:resultFormula,formulaSourceLost:false,contextPath:[...(group.parentPath||[])],caseEliminationGroupId:group.id,dischargedCaseContextIds:[...group.caseContextIds]};
    group.status='closed';group.resultStepId=resultId;state.steps.push(result);$('#subproofModal').style.display='none';renderProof();
  }

  function normalizeClaimText(value) {
    return String(value||'').normalize('NFC').trim().replace(/\s+/g,' ');
  }
  function atomFormulaForStep(step) {
    if(step.assertion && step.assertion.type && step.assertion.type!=='custom') {
      const def=assertionDefinitions[step.assertion.type];
      if(def && def.fields && def.fields.length=== (step.assertion.objects||[]).length) {
        const terms=def.fields.map((field,index)=>({kind:field.kind,id:step.assertion.objects[index]}));
        return {op:'atom',predicate:step.assertion.type,terms};
      }
    }
    if(step.assertion?.type==='custom') {
      return {op:'atom',predicate:'custom',text:normalizeClaimText(step.claim),terms:(step.assertion.objects||[]).map((id,index)=>({kind:step.assertion.objectKinds?.[index]||'unknown',id}))};
    }
    return {op:'atom',predicate:'text',text:normalizeClaimText(step.claim)};
  }
  function getStepFormula(stepId, visiting=new Set()) {
    const step=state.steps.find(item=>item.id===stepId);
    if(!step || step.formulaSourceLost || visiting.has(stepId)) return null;
    if(step.formulaSnapshot) return clone(step.formulaSnapshot);
    if(!step.formulaExpression) return atomFormulaForStep(step);
    const op=step.formulaExpression.op, ids=step.formulaExpression.sourceStepIds;
    const quantified=['forall','exists'].includes(op),arity=(op==='not'||quantified)?1:2;
    if(!['and','or','implies','not','bottom','forall','exists'].includes(op)||!Array.isArray(ids)||ids.length!==arity) return null;
    const next=new Set(visiting);next.add(stepId);
    const args=ids.map(id=>getStepFormula(id,next));
    if(args.some(item=>!item)) return null;
    if(quantified){const variable=step.formulaExpression.variable;if(!validLogicalName(variable)||!freeVariableNames(args[0]).has(variable))return null;return {op,variable,args};}
    return {op,args};
  }
  function normalizeFormulaTerm(term,boundVariables=new Map()) {
    if(!term) return {kind:'invalid'};
    if(term.kind==='segment') {
      const segment=segmentById(term.id);
      if(segment) return {kind:'segment',ends:[segment.a,segment.b].sort()};
    }
    if(term.kind==='angle') {
      const angle=state.angles.find(item=>item.id===term.id);
      if(angle) return {kind:'angle',vertex:angle.vertexId,rays:[angle.aId,angle.cId].sort()};
    }
    if(term.kind==='sum') return {kind:'sum',terms:(term.terms||[]).map(item=>normalizeFormulaTerm(item,boundVariables)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
    if(term.kind==='variable'){const name=term.name||term.id||'';return {kind:'variable',name:boundVariables.has(name)?boundVariables.get(name):`free:${name}`};}
    if(term.kind==='constant')return {kind:'constant',name:term.name||term.id||''};
    return {kind:term.kind,id:term.id};
  }
  function formulaTermKey(term) { return JSON.stringify(normalizeFormulaTerm(term)); }
  function formulaKey(formula,boundVariables=new Map(),depth=0) {
    if(!formula) return 'INVALID';
    if(formula.op==='atom') {
      let terms=(formula.terms||[]).map(term=>normalizeFormulaTerm(term,boundVariables));
      if(['equal_segments','parallel_segments','perpendicular_segments','equal_angles','equal_magnitudes'].includes(formula.predicate)) terms.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return JSON.stringify({op:'atom',predicate:formula.predicate,text:formula.text||'',terms});
    }
    if(formula.op==='forall'||formula.op==='exists'){
      const next=new Map(boundVariables);next.set(formula.variable,`bound:${depth}`);
      return JSON.stringify({op:formula.op,children:(formula.args||[]).map(child=>formulaKey(child,next,depth+1))});
    }
    let children=(formula.args||[]).map(child=>formulaKey(child,boundVariables,depth));
    if(formula.op==='and'||formula.op==='or') children.sort();
    return JSON.stringify({op:formula.op,children});
  }
  function sameFormula(a,b) { return !!a&&!!b&&formulaKey(a)===formulaKey(b); }
  function displayFormulaTerm(term){
    if(!term)return '?';
    if(term.kind==='sum')return (term.terms||[]).map(displayFormulaTerm).join(' + ');
    if(term.kind==='variable')return `?${term.name||'x'}`;
    return term.name||term.id||term.label||'?';
  }
  function displayFormulaAst(formula){
    if(!formula)return '<?>';
    if(formula.op==='atom'){
      const terms=formula.terms||[];
      if(formula.predicate==='equal_magnitudes'||formula.predicate==='equal_angles')return `${displayFormulaTerm(terms[0])} = ${displayFormulaTerm(terms[1])}`;
      if(formula.predicate==='is_right_angle')return `∠${displayFormulaTerm(terms[0])} = 90°`;
      if(formula.predicate==='unique_line_through')return `Через ${displayFormulaTerm(terms[0])} и ${displayFormulaTerm(terms[1])} проходит ровно одна прямая`;
      if(formula.predicate==='distinct_points')return `${displayFormulaTerm(terms[0])} ≠ ${displayFormulaTerm(terms[1])}`;
      if(formula.predicate==='user_predicate')return `${formula.text||'P'}${terms.length?`(${terms.map(displayFormulaTerm).join(', ')})`:''}`;
      return formula.text||`${formula.predicate||'утверждение'}(${terms.map(displayFormulaTerm).join(', ')})`;
    }
    if(formula.op==='not')return `¬(${displayFormulaAst(formula.args?.[0])})`;
    if(formula.op==='forall')return `∀${formula.variable} (${displayFormulaAst(formula.args?.[0])})`;
    if(formula.op==='exists')return `∃${formula.variable} (${displayFormulaAst(formula.args?.[0])})`;
    if(formula.op==='bottom')return '⊥';
    const symbol={and:'∧',or:'∨',implies:'→'}[formula.op]||'?';
    return `(${displayFormulaAst(formula.args?.[0])}) ${symbol} (${displayFormulaAst(formula.args?.[1])})`;
  }
  function displayFormulaForStep(stepId, visiting=new Set()) {
    const step=state.steps.find(item=>item.id===stepId);if(!step)return '<?> ';
    if(visiting.has(stepId))return '[циклическая формула]';
    if(step.formulaSnapshot)return displayFormulaAst(step.formulaSnapshot);
    if(!step.formulaExpression)return step.claim||'P';
    const next=new Set(visiting);next.add(stepId);
    const labels=(step.formulaExpression.sourceStepIds||[]).map(id=>displayFormulaForStep(id,next));
    const op=step.formulaExpression.op;
    if(op==='not')return `¬(${labels[0]||'?'})`;
    if(op==='forall'||op==='exists')return `${op==='forall'?'∀':'∃'}${step.formulaExpression.variable||'x'} (${labels[0]||'?'})`;
    if(op==='bottom')return '⊥';
    const symbol={and:'∧',or:'∨',implies:'→'}[op]||'?';
    return `(${labels[0]||'?'}) ${symbol} (${labels[1]||'?'})`;
  }
  function stepFormulaLine(step) {
    return step.formulaExpression ? displayFormulaForStep(step.id) : (step.assertion ? step.claim : `Текстовое высказывание: ${step.claim}`);
  }
  function equalityTerms(formula){return formula?.op==='atom'&&['equal_segments','equal_angles','equal_magnitudes'].includes(formula.predicate)&&Array.isArray(formula.terms)&&formula.terms.length===2?formula.terms:null;}
  function sameUnorderedTerms(left,right){return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every(term=>right.some(candidate=>formulaTermKey(term)===formulaTermKey(candidate)));}
  function evaluateAxiomRule(step){
    const selected=proofRuleById(step.basisRuleId),refs=step.references||[],premises=refs.map(id=>getStepFormula(id)),target=getStepFormula(step.id);
    const fail=message=>({status:'invalid',label:'Не соответствует аксиоме',detail:message});
    const pass=message=>({status:'checked',label:'Аксиома применена по схеме',detail:message});
    if(!target)return fail('Заключение не имеет корректной формальной записи.');
    if(premises.some(item=>!item))return fail('Одна из посылок недоступна.');
    if(step.basisRuleId==='axiom_incidence_unique_line'){
      const terms=target.op==='atom'&&target.predicate==='unique_line_through'?target.terms||[]:[];
      if(refs.length!==1||premises[0]?.predicate!=='distinct_points'||terms.length!==2||!sameUnorderedTerms(terms,premises[0].terms||[]))return fail('Нужны две различные точки как посылка и утверждение о единственной прямой через те же точки.');
      return pass('Заключение является экземпляром аксиомы единственности прямой через две различные точки.');
    }
    if(step.basisRuleId==='axiom_right_angles'){
      if(refs.length!==2||premises.some(item=>item?.op!=='atom'||item.predicate!=='is_right_angle'||(item.terms||[]).length!==1)||target.op!=='atom'||target.predicate!=='equal_angles')return fail('Нужны две посылки о прямых углах и заключение об их равенстве.');
      const expected=premises.map(item=>item.terms[0]);
      return sameUnorderedTerms(target.terms||[],expected)?pass('Оба угла указаны как прямые; равенство выведено по Постулату 4.') : fail('Равенство должно связывать именно два указанных прямых угла.');
    }
    if(step.basisRuleId==='axiom_equal_transitive'){
      if(refs.length!==2||!equalityTerms(premises[0])||!equalityTerms(premises[1])||!equalityTerms(target)||premises[0].predicate!==premises[1].predicate||target.predicate!==premises[0].predicate)return fail('Нужны два равенства величин одного типа и заключение о равенстве крайних величин.');
      const a=premises[0].terms,b=premises[1].terms;
      const shared=a.findIndex(term=>b.some(other=>formulaTermKey(term)===formulaTermKey(other)));
      if(shared<0)return fail('У двух равенств нет общей промежуточной величины.');
      const middle=a[shared],left=a[1-shared],right=b.find(term=>formulaTermKey(term)!==formulaTermKey(middle));
      return right&&sameUnorderedTerms(target.terms,[left,right])?pass('Из двух равенств с общей величиной получено равенство оставшихся величин.') : fail('Заключение не совпадает с транзитивным равенством крайних величин.');
    }
    if(step.basisRuleId==='axiom_add_equals'){
      if(refs.length!==2||!equalityTerms(premises[0])||!equalityTerms(premises[1])||!equalityTerms(target)||target.predicate!=='equal_magnitudes'||premises.some(item=>item.predicate!=='equal_magnitudes'))return fail('Нужны две посылки о равенстве величин и равенство их сумм.');
      const p=premises[0].terms,q=premises[1].terms,t=target.terms;
      const expectedA={kind:'sum',terms:[p[0],q[0]]},expectedB={kind:'sum',terms:[p[1],q[1]]};
      const expectedA2={kind:'sum',terms:[q[0],p[0]]},expectedB2={kind:'sum',terms:[q[1],p[1]]};
      const direct=formulaTermKey(t[0])===formulaTermKey(expectedA)&&formulaTermKey(t[1])===formulaTermKey(expectedB);
      const reversed=formulaTermKey(t[0])===formulaTermKey(expectedA2)&&formulaTermKey(t[1])===formulaTermKey(expectedB2);
      return direct||reversed?pass('К двум равным величинам прибавлены соответственно равные величины; полученные суммы равны.') : fail('Заключение должно быть равенством сумм левых и правых частей двух посылок.');
    }
    return {status:'review',label:'Требует содержательной проверки',detail:'Для этой аксиомы пока не реализована точная проверка структуры посылок.'};
  }

  function evaluateLogicalRule(step) {
    const selected=proofRuleById(step.basisRuleId);
    if(!selected || selected.basis!=='logic') return null;
    const refs=(step.references||[]), premises=refs.map(id=>getStepFormula(id)), target=getStepFormula(step.id);
    const fail=message=>({status:'invalid',label:'Не соответствует правилу вывода',detail:message});
    const pass=message=>({status:'checked',label:'Формальная схема совпадает',detail:message});
    if(!target) return fail('У целевого шага нет корректной формальной записи. Проверь логические связки и ссылки на исходные формулы.');
    if(premises.some(formula=>!formula)) return fail('Одна из посылок не имеет доступной формальной записи.');
    switch(selected.id) {
      case 'logic_and_intro': {
        if(refs.length!==2||target.op!=='and') return fail('Для ∧I нужны ровно две посылки и заключение вида P ∧ Q.');
        const args=target.args||[];
        const ok=(sameFormula(args[0],premises[0])&&sameFormula(args[1],premises[1]))||(sameFormula(args[0],premises[1])&&sameFormula(args[1],premises[0]));
        return ok?pass('Заключение состоит ровно из двух указанных посылок.'):fail('Части заключения P ∧ Q не совпадают с двумя выбранными посылками.');
      }
      case 'logic_and_elim_left': case 'logic_and_elim_right': {
        if(refs.length!==1||premises[0]?.op!=='and') return fail('Для ∧E нужна одна посылка вида P ∧ Q.');
        const index=selected.id.endsWith('left')?0:1;
        return sameFormula(target,premises[0].args?.[index])?pass(`Заключение совпадает с ${index===0?'левой':'правой'} частью конъюнкции.`):fail('Заключение не совпадает с требуемой частью конъюнкции.');
      }
      case 'logic_modus_ponens': {
        if(refs.length!==2) return fail('Для modus ponens нужны две посылки: P → Q и P.');
        const implicationIndex=premises.findIndex(formula=>formula?.op==='implies'&&formula.args?.length===2);
        if(implicationIndex<0) return fail('Среди посылок нет формулы P → Q.');
        const implication=premises[implicationIndex], antecedent=premises[1-implicationIndex];
        return sameFormula(antecedent,implication.args[0])&&sameFormula(target,implication.args[1])?pass('Посылка P совпадает с условием импликации, заключение совпадает с Q.') : fail('Нужно иметь P → Q и P, а заключением указать именно Q.');
      }
      case 'logic_or_intro_left': case 'logic_or_intro_right': {
        if(refs.length!==1||target.op!=='or'||target.args?.length!==2) return fail('Для ∨I нужна одна посылка и заключение вида P ∨ Q.');
        const index=selected.id.endsWith('left')?0:1;
        return sameFormula(premises[0],target.args[index])?pass(`Выбранная посылка совпадает с ${index===0?'левой':'правой'} частью дизъюнкции.`):fail('Выбранная посылка не совпадает с соответствующей частью дизъюнкции.');
      }
      case 'logic_or_elim': {
        const group=state.proofCaseGroups.find(item=>item.id===step.caseEliminationGroupId);
        if(!group||group.status!=='closed'||refs.length!==3)return fail('Для ∨E нужны исходная дизъюнкция и два завершённых поддоказательства случаев.');
        const disjunction=getStepFormula(group.disjunctionStepId);
        if(refs[0]!==group.disjunctionStepId||disjunction?.op!=='or'||disjunction.args?.length!==2)return fail('Первая посылка должна быть выбранной дизъюнкцией P ∨ Q.');
        const ctx1=contextById(group.caseContextIds?.[0]),ctx2=contextById(group.caseContextIds?.[1]);
        if(!ctx1||!ctx2||ctx1.status!=='case-closed'||ctx2.status!=='case-closed')return fail('Оба случая должны быть завершены отдельно.');
        const ass1=state.steps.find(item=>item.id===ctx1.assumptionStepId),ass2=state.steps.find(item=>item.id===ctx2.assumptionStepId);
        const con1=state.steps.find(item=>item.id===group.caseConsequentStepIds?.[0]),con2=state.steps.find(item=>item.id===group.caseConsequentStepIds?.[1]);
        if(!ass1||!ass2||!con1||!con2)return fail('Не найдены оба предположения или одно из заключений случаев.');
        if(refs[1]!==con1.id||refs[2]!==con2.id)return fail('Второй и третий источники ∨E должны точно совпадать с заключениями первого и второго случаев.');
        if(!sameArray(ctx1.parentPath,group.parentPath)||!sameArray(ctx2.parentPath,group.parentPath)||!sameArray(proofPath(ass1),[...group.parentPath,ctx1.id])||!sameArray(proofPath(ass2),[...group.parentPath,ctx2.id]))return fail('Случаи должны быть отдельными поддоказательствами одного внешнего контекста.');
        if(!sameArray(proofPath(con1),[...group.parentPath,ctx1.id])||!sameArray(proofPath(con2),[...group.parentPath,ctx2.id]))return fail('Заключения каждого случая должны быть получены внутри соответствующего поддоказательства.');
        if(!sameFormula(getStepFormula(ass1.id),disjunction.args[0])||!sameFormula(getStepFormula(ass2.id),disjunction.args[1]))return fail('Первый случай должен предполагать P, второй — Q из исходной дизъюнкции P ∨ Q.');
        if(!sameFormula(getStepFormula(con1.id),getStepFormula(con2.id))||!sameFormula(target,getStepFormula(con1.id)))return fail('Оба случая должны приводить к одному и тому же заключению R.');
        if(group.resultStepId!==step.id||!sameArray(proofPath(step),group.parentPath))return fail('Результат ∨E должен быть единственным итогом группы и находиться во внешней области действия обоих случаев.');
        const leftAudit=auditCaseDerivation(con1.id,ctx1.id),rightAudit=auditCaseDerivation(con2.id,ctx2.id);
        if(leftAudit.status==='invalid'||rightAudit.status==='invalid')return fail(`В одном из случаев обнаружена ошибка: ${leftAudit.status==='invalid'?leftAudit.detail:rightAudit.detail}`);
        if(leftAudit.status!=='checked'||rightAudit.status!=='checked')return {status:'review',label:'Схема ∨E совпадает · проверьте выводы случаев',detail:`Оба случая имеют одно заключение R и правильно закрыты. Однако их внутренние обоснования требуют проверки. Случай 1: ${leftAudit.detail||'без замечаний'}. Случай 2: ${rightAudit.detail||'без замечаний'}. Внешние условия принимаются как посылки, их истинность не проверяется.`};
        return pass('Оба случая P и Q закрыты; цепочки использованных формальных правил согласованы, временные предположения сняты. Исходные условия остаются принятыми посылками, а не доказанными системой фактами.');
      }
      case 'logic_double_negation_elim': {
        const source=premises[0];
        if(refs.length!==1||source?.op!=='not'||source.args?.[0]?.op!=='not') return fail('Для ¬¬E нужна одна посылка вида ¬¬P.');
        return sameFormula(target,source.args[0].args[0])?pass('Заключение совпадает с P из посылки ¬¬P (классическая логика).'):fail('Заключение должно совпадать с P из посылки ¬¬P.');
      }
      case 'logic_contradiction_intro': {
        if(refs.length!==2||target.op!=='bottom'||target.args?.length!==2)return fail('Для ⊥I нужны две посылки, одна из которых является отрицанием другой, и заключение ⊥.');
        const [a,b]=premises;
        const complementary=(x,y)=>x?.op==='not'&&sameFormula(x.args?.[0],y)||y?.op==='not'&&sameFormula(y.args?.[0],x);
        return complementary(a,b)?pass('Посылки имеют вид P и ¬P; противоречие ⊥ выведено по схеме ⊥I.'):fail('Выбранные посылки не являются парой P и ¬P.');
      }
      case 'logic_negation_intro': {
        const context=step.dischargedContextId?contextById(step.dischargedContextId):null;
        if(!context||context.status!=='closed'||context.closedByStepId!==step.id)return fail('Для ¬I нужно закрытое поддоказательство с временным предположением.');
        if(refs.length!==1||target.op!=='not')return fail('Для ¬I нужно одно внутреннее заключение ⊥ и итоговая формула ¬P.');
        const assumption=state.steps.find(item=>item.id===context.assumptionStepId),contradiction=state.steps.find(item=>item.id===refs[0]);
        const expectedPath=[...(context.parentPath||[]),context.id];
        if(!assumption?.isAssumption||!contradiction||!sameArray(proofPath(assumption),expectedPath)||!sameArray(proofPath(contradiction),expectedPath))return fail('Предположение и противоречие должны находиться непосредственно внутри закрываемого контекста.');
        if(!sameArray(proofPath(step),context.parentPath||[]))return fail('Результат поддоказательства должен находиться во внешней области действия.');
        const assumptionFormula=getStepFormula(assumption.id),contradictionFormula=getStepFormula(contradiction.id);
        if(contradictionFormula?.op!=='bottom'||!assumptionFormula)return fail('Внутри предположения нужно получить проверенное противоречие ⊥.');
        return target.args?.length===1&&sameFormula(target.args[0],assumptionFormula)?pass('Поддоказательство привело к ⊥; предположение P снято, получено ¬P.') : fail('Заключение должно быть отрицанием исходного предположения P.');
      }
      case 'logic_raa': {
        const context=step.dischargedContextId?contextById(step.dischargedContextId):null;
        if(!context||context.status!=='closed'||context.closedByStepId!==step.id||context.closingRuleId!=='logic_raa')return fail('Для RAA требуется закрытый контекст, снятый именно правилом RAA.');
        if(refs.length!==2||refs[0]!==context.assumptionStepId||refs[1]!==context.consequentStepId)return fail('Для RAA нужны ровно два источника: временное предположение ¬P и внутреннее противоречие ⊥.');
        const assumption=state.steps.find(item=>item.id===context.assumptionStepId),contradiction=state.steps.find(item=>item.id===context.consequentStepId);
        const expectedPath=[...(context.parentPath||[]),context.id];
        if(!assumption?.isAssumption||!contradiction||!sameArray(proofPath(assumption),expectedPath)||!sameArray(proofPath(contradiction),expectedPath))return fail('Предположение ¬P и противоречие ⊥ должны находиться непосредственно внутри закрываемого контекста.');
        if(!sameArray(proofPath(step),context.parentPath||[]))return fail('Результат RAA должен находиться во внешней области действия.');
        const assumptionFormula=getStepFormula(assumption.id),contradictionFormula=getStepFormula(contradiction.id);
        if(assumptionFormula?.op!=='not'||!Array.isArray(assumptionFormula.args)||assumptionFormula.args.length!==1)return fail('Временное предположение должно быть именно формальной формулой ¬P, а не свободным текстом.');
        if(contradictionFormula?.op!=='bottom')return fail('Внутренним заключением должно быть формальное противоречие ⊥.');
        if(contradiction.basisRuleId!=='logic_contradiction_intro')return fail('Внутреннее противоречие должно быть выведено проверяемым правилом ⊥I, а не просто записано формулой ⊥.');
        const contradictionScopeProblem=proofScopeProblem(contradiction);
        if(contradictionScopeProblem)return fail(`Внутреннее противоречие использует недоступные формулы: ${contradictionScopeProblem}`);
        const contradictionAudit=evaluateLogicalRule(contradiction);
        if(contradictionAudit?.status!=='checked')return fail(`Внутреннее правило ⊥I не прошло проверку: ${contradictionAudit?.detail||'неверная схема противоречия'}`);
        return sameFormula(target,assumptionFormula.args[0])?pass('Из предположения ¬P получено структурно проверенное противоречие ⊥ по правилу ⊥I; предположение снято, P выведено по классическому правилу RAA.') : fail('Заключение должно совпадать с P из временного предположения ¬P.');
      }
      case 'logic_implies_intro': {
        const context=step.dischargedContextId?contextById(step.dischargedContextId):null;
        if(!context || context.status!=='closed' || context.closedByStepId!==step.id) return fail('Для →I нужно закрытое поддоказательство с явно указанным контекстом предположения.');
        if(refs.length!==1 || target.op!=='implies' || target.args?.length!==2) return fail('Для →I нужно одно внутреннее заключение Q и итоговая формула P → Q.');
        const assumption=state.steps.find(item=>item.id===context.assumptionStepId);
        const consequent=state.steps.find(item=>item.id===refs[0]);
        const expectedPath=[...(context.parentPath||[]),context.id];
        if(!assumption?.isAssumption || !consequent || !sameArray(proofPath(assumption),expectedPath) || !sameArray(proofPath(consequent),expectedPath)) return fail('Предположение и заключение должны находиться непосредственно внутри закрываемого контекста. Сначала закрой вложенные поддоказательства.');
        if(!sameArray(proofPath(step),context.parentPath||[])) return fail('Результат поддоказательства должен находиться во внешней области действия.');
        const assumptionFormula=getStepFormula(assumption.id), consequentFormula=getStepFormula(consequent.id);
        if(!assumptionFormula||!consequentFormula) return fail('Предположение или внутреннее заключение не имеет доступной формальной записи.');
        if(!sameFormula(target.args[0],assumptionFormula)||!sameFormula(target.args[1],consequentFormula)) return fail('Формула должна иметь вид P → Q, где P — предположение контекста, а Q — выбранное внутреннее заключение.');
        return pass('Схема →I корректна: предположение P снято и получено P → Q. Это проверяет закрытие контекста, но не подтверждает истинность каждого внутреннего геометрического шага.');
      }
      case 'logic_equal_symmetry': {
        const source=premises[0];
        if(refs.length!==1||!['equal_segments','equal_angles'].includes(source?.predicate)||target.predicate!==source.predicate) return fail('Для симметричности выбери одну посылку о равенстве отрезков или углов.');
        const a=source.terms||[],b=target.terms||[];
        const reversed=a.length===2&&b.length===2&&formulaTermKey(a[0])===formulaTermKey(b[1])&&formulaTermKey(a[1])===formulaTermKey(b[0]);
        return reversed?pass('Левая и правая части равенства переставлены местами.') : fail('Заключение должно иметь вид B = A, если посылка имеет вид A = B.');
      }
      case 'logic_equal_transitivity': {
        if(refs.length!==2) return fail('Для транзитивности нужны две посылки A = B и B = C.');
        const [p,q]=premises;
        if(!p||!q||!['equal_segments','equal_angles'].includes(p.predicate)||q.predicate!==p.predicate||target.predicate!==p.predicate) return fail('Для транзитивности нужны два равенства объектов одного типа: отрезков или углов.');
        const terms=f=>f.terms||[];const pTerms=terms(p),qTerms=terms(q);
        if(pTerms.length!==2||qTerms.length!==2||(target.terms||[]).length!==2) return fail('Для транзитивности каждое равенство должно содержать две величины.');
        const termKey=formulaTermKey;
        const shared=pTerms.findIndex(a=>qTerms.some(b=>termKey(a)===termKey(b)));
        if(shared<0) return fail('У двух равенств нет общей средней величины.');
        const middle=pTerms[shared];
        const outerP=pTerms[1-shared];
        const outerQ=qTerms.find(term=>termKey(term)!==termKey(middle));
        if(!outerP||!outerQ) return fail('Не удалось определить две крайние величины равенства.');
        const expected={op:'atom',predicate:target.predicate,terms:[outerP,outerQ]};
        return sameFormula(target,expected)?pass('Заключение связывает два крайних отрезка через общую среднюю величину.') : fail('Заключение не соответствует транзитивному равенству A = B, B = C.');
      }
      case 'logic_forall_intro': {
        if(refs.length!==1||target.op!=='forall'||!validLogicalName(target.variable)||!target.args?.[0])return fail('Для ∀I нужна одна посылка P(a) и заключение ∀x P(x).');
        const sourceStep=state.steps.find(item=>item.id===refs[0]),source=premises[0];
        const candidates=[...freeVariableNames(source)];
        const matching=candidates.filter(name=>sameFormula(substituteFormula(target.args[0],target.variable,{kind:'variable',name}),source));
        if(!matching.length)return fail('Посылка должна быть точным экземпляром тела ∀x P(x), полученным заменой связанной переменной на свободную переменную-параметр.');
        const valid=matching.find(name=>freeVariableIsFresh(name,step));
        if(!valid)return fail(`Нарушено условие ∀I: свободная переменная ${matching.map(name=>`?${name}`).join(', ')} встречается в не снятом предположении. Используй произвольный параметр, не зависящий от предпосылок.`);
        return pass(`Посылка совпадает с экземпляром тела квантора при произвольном параметре ?${valid}; он не встречается свободно в не снятых предположениях.`);
      }
      case 'logic_forall_elim': {
        if(refs.length!==1||premises[0]?.op!=='forall')return fail('Для ∀E нужна одна посылка вида ∀x P(x).');
        const instances=quantifiedInstances(premises[0],target);
        const vacuous=!freeVariableNames(premises[0].args[0]).has(premises[0].variable)&&sameFormula(premises[0].args[0],target);
        return vacuous?pass('Квантифицированная переменная не встречается в теле; формула тождественно совпадает с её экземпляром.') : instances.length?pass(`Заключение получено корректной подстановкой терма ${displayFormulaTerm(instances[0])} вместо связанной переменной ?${premises[0].variable}.`):fail('Заключение не является экземпляром тела всеобщего утверждения при допустимой подстановке терма.');
      }
      case 'logic_exists_intro': {
        if(refs.length!==1||target.op!=='exists'||!validLogicalName(target.variable)||!target.args?.[0])return fail('Для ∃I нужна одна посылка P(t) и заключение ∃x P(x).');
        const instances=quantifiedInstances(target,premises[0]);
        const vacuous=!freeVariableNames(target.args[0]).has(target.variable)&&sameFormula(target.args[0],premises[0]);
        return vacuous?pass('Квантифицированная переменная не встречается в теле; формула остаётся той же.') : instances.length?pass(`Посылка совпадает с экземпляром тела ∃x P(x) при терме ${displayFormulaTerm(instances[0])}; существование засвидетельствовано этим термом.`):fail('Посылка не является экземпляром тела заявленного существования.');
      }
      case 'logic_exists_elim': {
        const group=state.proofExistenceGroups.find(item=>item.id===step.existenceEliminationGroupId);
        const context=step.dischargedContextId?contextById(step.dischargedContextId):null;
        if(!group||group.status!=='closed'||!context||context.status!=='closed'||context.closedByStepId!==step.id||context.closingRuleId!=='logic_exists_elim')return fail('Для ∃E требуется завершённое специальное поддоказательство со свежим свидетелем.');
        if(refs.length!==2||refs[0]!==group.existentialStepId||refs[1]!==group.consequentStepId)return fail('Для ∃E нужны ровно две ссылки: исходное ∃-утверждение и внутреннее заключение Q.');
        const existential=getStepFormula(group.existentialStepId),assumption=state.steps.find(item=>item.id===group.assumptionStepId),consequent=state.steps.find(item=>item.id===group.consequentStepId);
        const expectedPath=[...(context.parentPath||[]),context.id];
        if(existential?.op!=='exists'||!assumption?.isAssumption||!consequent||!sameArray(context.parentPath,group.parentPath)||!sameArray(proofPath(assumption),expectedPath)||!sameArray(proofPath(consequent),expectedPath))return fail('Связь между существующим утверждением, предположением-свидетелем и внутренним заключением повреждена.');
        if(!sameArray(proofPath(step),group.parentPath)||!sameArray(proofPath(step),context.parentPath||[]))return fail('Результат ∃E должен находиться во внешнем контексте поддоказательства.');
        const expectedWitness=substituteFormula(existential.args[0],existential.variable,{kind:'constant',name:group.eigenparameter});
        if(!sameFormula(getStepFormula(assumption.id),expectedWitness))return fail('Внутреннее предположение не соответствует телу ∃-формулы с подстановкой свежего параметра.');
        const conclusion=getStepFormula(consequent.id);
        if(!sameFormula(target,conclusion))return fail('Внешнее заключение должно в точности совпадать с внутренним результатом Q.');
        if(formulaContainsConstant(conclusion,group.eigenparameter))return fail(`Свежий параметр ${group.eigenparameter} не должен встречаться в итоговом заключении Q.`);
        if(!eigenconstantIsFresh(group.eigenparameter,group))return fail(`Параметр ${group.eigenparameter} не является свежим относительно исходной ∃-формулы или внешних не снятых предположений.`);
        if(group.resultStepId!==step.id||group.contextId!==context.id)return fail('Группа ∃E не согласована со своим итоговым шагом и контекстом.');
        return pass(`Из ∃-посылки введён свежий параметр ${group.eigenparameter}; по нему доказано Q, не содержащее параметр, после чего временное предположение снято.`);
      }
      default: return fail('Для выбранного правила ещё не реализована проверка схемы.');
    }
  }
  function auditProofStep(step,index) {
    const selected=proofRuleById(step.basisRuleId);
    if(step.isAssumption) return {status:'review',label:'Временное предположение',detail:'Утверждение принято внутри открытого контекста; оно не считается доказанным вне этого поддоказательства.'};
    const scopeProblem=proofScopeProblem(step);
    if(scopeProblem && !['logic_implies_intro','logic_negation_intro','logic_raa','logic_or_elim','logic_exists_elim'].includes(selected?.id)) return {status:'invalid',label:'Нарушена область действия',detail:scopeProblem};
    if(step.formulaSourceLost) return {status:'invalid',label:'Потерян источник формулы',detail:'Один из шагов, из которых была составлена логическая формула, удалён. Отредактируй формулу.'};
    if(selected?.basis==='logic') return evaluateLogicalRule(step);
    if(['axiom_incidence_unique_line','axiom_right_angles','axiom_equal_transitive','axiom_add_equals'].includes(selected?.id)) return evaluateAxiomRule(step);
    if(selected) return {status:'review',label:'Требует содержательной проверки',detail:'Каталожное правило выбрано, но его геометрические предпосылки и соответствие заключения пока не сопоставляются формальным шаблоном.'};
    return {status:'review',label:step.assertion?'Структурированное утверждение':'Свободная формулировка',detail:'Формулировка сохранена; её истинность и достаточность обоснования проверяет пользователь.'};
  }

  function auditCaseDerivation(conclusionId,caseContextId) {
    const visited=new Set();let reviewReason='';let invalidReason='';
    const visit=stepId=>{
      if(!stepId||visited.has(stepId)||invalidReason)return;visited.add(stepId);
      const source=state.steps.find(item=>item.id===stepId);
      if(!source){invalidReason=`Не найден использованный шаг ${stepId}.`;return;}
      if(source.isAssumption){
        const context=state.proofContexts.find(item=>item.assumptionStepId===source.id);
        if(!context||!['closed','case-closed'].includes(context.status))reviewReason=reviewReason||'В цепочке остался не закрытый временный контекст.';
        return;
      }
      const sourcePath=proofPath(source);
      if(source.basisType==='condition'){
        if(sourcePath.includes(caseContextId))reviewReason=reviewReason||'Внутри случая добавлено дополнительное локальное «дано». Ветвь должна опираться на исходные внешние условия и явно закрытые предположения.';
        return;
      }
      const audit=auditProofStep(source,state.steps.indexOf(source));
      if(audit?.status==='invalid'){
        invalidReason=`Шаг ${state.steps.indexOf(source)+1} («${source.claim||'без названия'}»): ${audit.detail||audit.label}.`;return;
      }
      if(audit?.status!=='checked')reviewReason=reviewReason||`Шаг ${state.steps.indexOf(source)+1} («${source.claim||'без названия'}») требует содержательной проверки: ${audit?.detail||audit?.label||'нет формальной проверки'}.`;
      (source.references||[]).forEach(visit);
      (source.formulaExpression?.sourceStepIds||[]).forEach(visit);
      if(source.dischargedContextId){
        const context=contextById(source.dischargedContextId);
        if(context)visit(context.assumptionStepId);
      }
      if(source.caseEliminationGroupId){
        const group=state.proofCaseGroups.find(item=>item.id===source.caseEliminationGroupId);
        if(group)(group.caseAssumptionStepIds||[]).forEach(visit);
      }
    };
    visit(conclusionId);
    if(invalidReason)return {status:'invalid',detail:invalidReason};
    if(reviewReason)return {status:'review',detail:reviewReason};
    return {status:'checked',detail:'Использованные правила и ссылки в этой ветви структурно согласованы; внешние условия принимаются как посылки.'};
  }

  function removeProofStep(stepId) {
    const target=state.steps.find(step=>step.id===stepId);if(!target)return;
    const assumptionContext=target.isAssumption?state.proofContexts.find(context=>context.assumptionStepId===stepId):null;
    const closingContext=state.proofContexts.find(context=>context.closedByStepId===stepId);
    pushHistory();
    let removedIds=new Set([stepId]);
    const dependentClosedContext=!assumptionContext?state.proofContexts.find(context=>context.status==='closed'&&context.consequentStepId===stepId):null;
    if(dependentClosedContext?.closedByStepId)removedIds.add(dependentClosedContext.closedByStepId);
    if(assumptionContext){
      const doomedContexts=new Set([assumptionContext.id]);
      let changed=true;
      while(changed){changed=false;for(const context of state.proofContexts){if(!doomedContexts.has(context.id)&&(context.parentPath||[]).some(id=>doomedContexts.has(id))){doomedContexts.add(context.id);changed=true;}}}
      state.steps.forEach(step=>{if(proofPath(step).some(id=>doomedContexts.has(id))||doomedContexts.has(step.dischargedContextId))removedIds.add(step.id);});
      state.proofContexts=state.proofContexts.filter(context=>!doomedContexts.has(context.id));
      state.activeProofContextIds=state.activeProofContextIds.filter(id=>!doomedContexts.has(id));
    }
    // Deleting any premise, case assumption/conclusion or final ∨E result removes its paired case tree atomically.
    const affectedCaseGroups=state.proofCaseGroups.filter(group=>group.disjunctionStepId===stepId||group.resultStepId===stepId||(group.caseAssumptionStepIds||[]).includes(stepId)||(group.caseConsequentStepIds||[]).includes(stepId));
    for(const group of affectedCaseGroups){
      const contextIds=new Set(group.caseContextIds||[]);let changed=true;
      while(changed){changed=false;for(const context of state.proofContexts){if(!contextIds.has(context.id)&&(context.parentPath||[]).some(id=>contextIds.has(id))){contextIds.add(context.id);changed=true;}}}
      state.steps.forEach(item=>{if(proofPath(item).some(id=>contextIds.has(id))||item.caseEliminationGroupId===group.id)removedIds.add(item.id);});
      state.proofContexts=state.proofContexts.filter(context=>!contextIds.has(context.id));
      state.activeProofContextIds=state.activeProofContextIds.filter(id=>!contextIds.has(id));
      state.proofCaseGroups=state.proofCaseGroups.filter(item=>item.id!==group.id);
    }
    const affectedExistenceGroups=state.proofExistenceGroups.filter(group=>[group.existentialStepId,group.assumptionStepId,group.consequentStepId,group.resultStepId].includes(stepId));
    for(const group of affectedExistenceGroups){
      const contextIds=new Set([group.contextId]);let changed=true;
      while(changed){changed=false;for(const context of state.proofContexts){if(!contextIds.has(context.id)&&(context.parentPath||[]).some(id=>contextIds.has(id))){contextIds.add(context.id);changed=true;}}}
      state.steps.forEach(item=>{if(proofPath(item).some(id=>contextIds.has(id))||item.existenceEliminationGroupId===group.id)removedIds.add(item.id);});
      state.proofContexts=state.proofContexts.filter(context=>!contextIds.has(context.id));
      state.activeProofContextIds=state.activeProofContextIds.filter(id=>!contextIds.has(id));
      state.proofExistenceGroups=state.proofExistenceGroups.filter(item=>item.id!==group.id);
    }
    state.steps=state.steps.filter(step=>!removedIds.has(step.id));
    state.steps.forEach(step=>{
      step.references=(step.references||[]).filter(ref=>!removedIds.has(ref));
      if((step.formulaExpression?.sourceStepIds||[]).some(ref=>removedIds.has(ref))){step.formulaSourceLost=true;step.formulaExpression=null;}
    });
    const affectedClosedContext=state.proofContexts.find(context=>context.status==='closed'&&(context.closedByStepId===stepId||context.consequentStepId===stepId));
    if(affectedClosedContext && !assumptionContext){affectedClosedContext.status='open';affectedClosedContext.closedByStepId=null;affectedClosedContext.consequentStepId=null;affectedClosedContext.closingRuleId=null;state.activeProofContextIds=[...(affectedClosedContext.parentPath||[]),affectedClosedContext.id];}
    state.activeProofContextIds=state.activeProofContextIds.filter(id=>state.proofContexts.some(context=>context.id===id&&context.status==='open'));
    renderProof();
  }

  function proofLevels() {
    const levels = new Map();
    state.steps.forEach(step => {
      const parents = [...new Set([...(step.references || []), ...(step.formulaExpression?.sourceStepIds || [])])].map(ref => levels.get(ref)).filter(Number.isInteger);
      levels.set(step.id, parents.length ? Math.max(...parents) + 1 : 0);
    });
    return levels;
  }

  function renderProofGraph() {
    const host = $('#proofGraphLanes'); host.replaceChildren();
    if (!state.steps.length) { host.textContent = 'Добавь шаги, чтобы увидеть зависимости.'; return; }
    const levels = proofLevels();
    const maxLevel = Math.max(0, ...levels.values());
    for (let level=0; level<=maxLevel; level++) {
      const lane=document.createElement('div'); lane.className='proof-lane';
      const heading=document.createElement('div'); heading.className='proof-lane-title'; heading.textContent=level===0?'Исходные утверждения':`Выводы · уровень ${level+1}`; lane.append(heading);
      state.steps.filter(step=>levels.get(step.id)===level).forEach(step=>{
        const node=document.createElement('div'); node.className='proof-node'+(step.isGoal?' goal-node':'');
        const title=document.createElement('strong'); title.textContent=`Шаг ${state.steps.indexOf(step)+1}${step.isGoal?' · ЦЕЛЬ':''}`;
        const claim=document.createElement('div'); claim.textContent=step.claim;
        const ruleLine=document.createElement('small'); ruleLine.className='proof-node-rule';
        ruleLine.textContent=proofRuleById(step.basisRuleId)?.label||'Свободное обоснование';
        const deps=document.createElement('small');
        const refs=(step.references||[]).map(ref=>state.steps.findIndex(item=>item.id===ref)+1).filter(n=>n>0);
        const formulaRefs=(step.formulaExpression?.sourceStepIds||[]).map(ref=>state.steps.findIndex(item=>item.id===ref)+1).filter(n=>n>0);
        deps.textContent=[refs.length?`↑ Посылки: ${refs.join(', ')}`:'',formulaRefs.length?`Формула собрана из: ${formulaRefs.join(', ')}`:'',step.isAssumption?'Временное предположение':(proofPath(step).length?`Контекст: ${proofPath(step).map(id=>proofContextLabel(contextById(id))).join(' → ')}`:'')].filter(Boolean).join(' · ')||'Без ссылок на другие шаги';
        node.append(title,claim,ruleLine,deps); lane.append(node);
      });
      host.append(lane);
    }
  }

  let presentationIndex=-1;
  function renderPresentation() {
    const steps=state.steps;
    const isIntro=presentationIndex<0;
    $('#presentationStepNo').textContent=isIntro?'Условие задачи':`Шаг ${presentationIndex+1} из ${steps.length}${steps[presentationIndex]?.isGoal?' · Целевое утверждение':''}`;
    $('#presentationClaim').textContent=isIntro?(state.task?.text||'Условие задачи не задано.'):steps[presentationIndex].claim;
    const current=steps[presentationIndex]; const audit=current?auditProofStep(current,presentationIndex):null;
    $('#presentationReason').textContent=isIntro?`Цель: ${state.task?.goal||'не задана'}`:`Формальная запись: ${current?displayFormulaForStep(current.id):''}. ${basisLabels[current.basisType]||'Основание не указано'}${proofRuleById(current.basisRuleId)?' · '+proofRuleById(current.basisRuleId).label:''}. ${current.reason}${audit?` Статус: ${audit.label}. ${audit.detail}`:''}`;
    const refs=isIntro?[]:(steps[presentationIndex].references||[]).map(ref=>state.steps.findIndex(item=>item.id===ref)+1).filter(n=>n>0);
    $('#presentationDeps').textContent=refs.length?`Опирается на шаги: ${refs.join(', ')}`:'';
    $('#presentationCounter').textContent=isIntro?'Введение':`${presentationIndex+1}/${steps.length}`;
    $('#presentationProgress').style.width=steps.length?`${Math.max(0,presentationIndex+1)/(steps.length+1)*100}%`:'0%';
    $('#presentationPrev').disabled=isIntro;
    $('#presentationNext').textContent=presentationIndex>=steps.length-1?'Завершить':'Далее →';
  }
  function startPresentation(){ presentationIndex=-1; $('#proofPresentation').classList.add('active'); renderPresentation(); }

  function updateCounts() {
    const count = state.points.length + state.segments.length + state.circles.length + state.marks.length
      + state.constraints.length + state.angles.length + state.angleMarks.length + state.angleConstraints.length;
    const temporarilyHidden = state.points.filter(point => !isPointAvailable(point)).length
      + state.segments.filter(segment => !isSegmentAvailable(segment)).length
      + state.circles.filter(circle => !isCircleAvailable(circle)).length
      + state.marks.filter(mark => !mark.segmentIds.every(sid => isSegmentAvailable(segmentById(sid)))).length
      + state.constraints.filter(constraint => !isSegmentAvailable(segmentById(constraint.sourceSegmentId)) || !isSegmentAvailable(segmentById(constraint.targetSegmentId))).length
      + state.angles.filter(angle => !isAngleAvailable(angle)).length
      + state.angleMarks.filter(group => !group.angles.every(isAngleAvailable)).length
      + state.angleConstraints.filter(constraint => !isAngleAvailable(constraint.sourceAngle) || !isAngleAvailable(constraint.targetAngle)).length;
    $('#objectCount').textContent = `${count} объектов${temporarilyHidden ? ` · ${temporarilyHidden} временно скрыто` : ''}`;
  }

  function setTool(tool) {
    if (state.drag || panState || pinchState || activePointers.size) clearGestureState();
    state.tool = tool; state.pending = []; state.pendingMode = null; state.selected = null; selectedGroup = null;
    document.querySelectorAll('.tool').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
    $('#toolHelp').textContent = help[tool];
    renderGeometry(); renderObjects();
  }

  function localPoint(event) {
    return localPointFromClient(event.clientX,event.clientY);
  }

  function localPointFromClient(clientX,clientY) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return {x:0,y:0};
    const screenPoint = svg.createSVGPoint(); screenPoint.x = clientX; screenPoint.y = clientY;
    const point = screenPoint.matrixTransform(matrix.inverse());
    return {x:point.x,y:point.y};
  }

  function releaseConstraint(constraintId) {
    const constraint = constraintById(constraintId);
    if (!constraint) return;
    const targetPoint = pointById(constraint.targetPointId);
    if (targetPoint && targetPoint.kind === 'constraintEndpoint') {
      const position = xy(targetPoint);
      targetPoint.kind = 'free'; targetPoint.x = position.x; targetPoint.y = position.y;
      delete targetPoint.constraintId;
    }
    state.constraints = state.constraints.filter((item) => item.id !== constraintId);
    state.marks = state.marks.filter((mark) => mark.constraintId !== constraintId);
  }

  function releaseAngleConstraint(constraintId) {
    const constraint=angleConstraintById(constraintId);
    if (!constraint) return;
    const targetPoint=pointById(constraint.targetPointId);
    if (targetPoint && targetPoint.kind==='angleConstraintEndpoint') {
      const position=xy(targetPoint);
      targetPoint.kind='free'; targetPoint.x=position.x; targetPoint.y=position.y;
      delete targetPoint.angleConstraintId;
    }
    state.angleConstraints=state.angleConstraints.filter(item=>item.id!==constraintId);
  }

  function deleteObject(kind, objectId) {
    if (kind === 'point') {
      const point = pointById(objectId);
      if (!point) return;
      // A circle whose radius was defined by this user point becomes scalar-radius based.
      for (const circle of state.circles.filter(item => circleRadiusPointId(item) === objectId && item.centerId !== objectId)) {
        const geometry = circleGeometry(circle);
        if (geometry) circle.radius = geometry.radius;
        delete circle.radiusPointId; delete circle.rimId;
      }
      // Removing a centre removes its circle; on-circle points are released by deleteObject('circle').
      state.circles.filter(item => item.centerId === objectId).map(item => item.id).forEach(circleId => deleteObject('circle', circleId));
      const relatedAngleConstraints=state.angleConstraints.filter(c=>
        c.targetPointId===objectId || [c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId,c.targetAngle.cId].includes(objectId)
      ).map(c=>c.id);
      relatedAngleConstraints.forEach(releaseAngleConstraint);
      const dependentIds = state.points.filter(candidate => candidate.id !== objectId && pointDependsOn(candidate.id, objectId)).map(candidate => candidate.id);
      dependentIds.forEach((dependentId) => { if (pointById(dependentId)) deleteObject('point', dependentId); });
      const attachedSegments = state.segments.filter((segment) => segment.a === objectId || segment.b === objectId).map((segment) => segment.id);
      attachedSegments.forEach((segmentId) => deleteObject('segment', segmentId));
      const attachedCircleIds = state.circles.filter((circle) => circle.centerId === objectId || circleRadiusPointId(circle) === objectId).map((circle) => circle.id);
      attachedCircleIds.forEach((circleId) => deleteObject('circle', circleId));
      state.points = state.points.filter((candidate) => candidate.id !== objectId);
      const validAngle = (angle) => angle.aId !== objectId && angle.vertexId !== objectId && angle.cId !== objectId;
      state.angles = state.angles.filter(validAngle);
      state.angleMarks = state.angleMarks.map((mark) => ({...mark, angles:mark.angles.filter(validAngle)})).filter((mark) => mark.angles.length === 2);
    } else if (kind === 'segment') {
      const relatedConstraints = state.constraints.filter((constraint) => constraint.sourceSegmentId === objectId || constraint.targetSegmentId === objectId).map((constraint) => constraint.id);
      relatedConstraints.forEach(releaseConstraint);
      const attachedPoints = state.points.filter((point) => point.segmentId === objectId || point.segment1Id === objectId || point.segment2Id === objectId || (point.kind==='curveIntersection' && ((point.parent1Kind==='segment'&&point.parent1Id===objectId)||(point.parent2Kind==='segment'&&point.parent2Id===objectId))) || (point.kind==='constrainedPoint' && ((point.lineAttachments||[]).some(item=>item.segmentId===objectId) || point.previousConstruction?.segmentId===objectId || point.previousConstruction?.segment1Id===objectId || point.previousConstruction?.segment2Id===objectId || (point.previousConstruction?.parent1Kind==='segment'&&point.previousConstruction?.parent1Id===objectId) || (point.previousConstruction?.parent2Kind==='segment'&&point.previousConstruction?.parent2Id===objectId) || point.previousConstruction?.__suspendedConstraint?.sourceSegmentId===objectId || point.previousConstruction?.__suspendedConstraint?.targetSegmentId===objectId)));
      const freedProjectionIds = [];
      for (const point of attachedPoints) {
        if (point.kind==='constrainedPoint') {
          const wasAvailable=isPointAvailable(point);
          const current=xy(point);
          if (point.previousConstruction) {
            const saved=point.previousConstruction;
            const referencesDeletedSegment=saved.segmentId===objectId||saved.segment1Id===objectId||saved.segment2Id===objectId||
              (saved.parent1Kind==='segment'&&saved.parent1Id===objectId)||(saved.parent2Kind==='segment'&&saved.parent2Id===objectId)||
              saved.__suspendedConstraint?.sourceSegmentId===objectId||saved.__suspendedConstraint?.targetSegmentId===objectId;
            if (referencesDeletedSegment) delete point.previousConstruction;
          }
          point.lineAttachments=(point.lineAttachments||[]).filter(item=>item.segmentId!==objectId);
          if (!point.lineAttachments.length) restoreSuspendedConstruction(point,current);
          else if (point.lineAttachments.length===1) {
            const remaining=segmentById(point.lineAttachments[0].segmentId);
            const savedT=point.lineAttachments[0].t;
            const t=wasAvailable&&remaining?rawSegmentParameter(current,remaining):savedT;
            if (!remaining||!Number.isFinite(t)) restoreSuspendedConstruction(point,current); else point.lineAttachments[0].t=t;
          }
        } else if (point.kind === 'midpoint') {
          // Removing the parent segment removes its dependent midpoint and every
          // segment that uses that midpoint (including a median drawn to it).
          const incidentSegments = state.segments
            .filter(candidate => candidate.id !== objectId && (candidate.a === point.id || candidate.b === point.id))
            .map(candidate => candidate.id);
          incidentSegments.forEach(segmentId => { if (segmentById(segmentId)) deleteObject('segment', segmentId); });
          state.points = state.points.filter((candidate) => candidate.id !== point.id);
        } else if (point.kind === 'onSegment') {
          const position = xy(point);
          point.kind = 'free'; point.x = position.x; point.y = position.y;
          delete point.segmentId; delete point.t;
        } else if (point.kind === 'intersection' || point.kind === 'projection' || point.kind === 'curveIntersection') {
          if ((point.kind === 'intersection' || point.kind === 'curveIntersection') && !isPointAvailable(point)) {
            deleteObject('point', point.id);
            continue;
          }
          const position = xy(point);
          if (point.kind === 'projection') freedProjectionIds.push(point.id);
          point.kind = 'free'; point.x = position.x; point.y = position.y;
          delete point.segmentId; delete point.segment1Id; delete point.segment2Id; delete point.sourcePointId;
          delete point.parent1Kind; delete point.parent1Id; delete point.parent2Kind; delete point.parent2Id; delete point.branch; delete point.circleId; delete point.angle;
        }
      }
      if (freedProjectionIds.length) state.angles = state.angles.filter((angle) => !angle.rightAngle || !freedProjectionIds.includes(angle.vertexId));
      state.segments = state.segments.filter((segment) => segment.id !== objectId && segment.subdivisionParentId !== objectId);
      state.marks = state.marks.map((mark) => ({ ...mark, segmentIds: mark.segmentIds.filter((sid) => sid !== objectId) })).filter((mark) => mark.segmentIds.length > 1);
    } else if (kind === 'circle') {
      const attached=state.points.filter(point=>(point.kind==='curveIntersection'&&((point.parent1Kind==='circle'&&point.parent1Id===objectId)||(point.parent2Kind==='circle'&&point.parent2Id===objectId))) || (point.kind==='onCircle' && point.circleId===objectId));
      const frozen = attached.filter(point => isPointAvailable(point)).map(point => ({point, position:xy(point)}));
      const unavailable = attached.filter(point => !isPointAvailable(point));
      unavailable.forEach(point => { if (pointById(point.id)) deleteObject('point', point.id); });
      for (const {point,position} of frozen) {
        if (!pointById(point.id)) continue;
        point.kind='free'; point.x=position.x; point.y=position.y;
        delete point.parent1Kind; delete point.parent1Id; delete point.parent2Kind; delete point.parent2Id; delete point.branch; delete point.circleId; delete point.angle;
      }
      state.circles = state.circles.filter((circle) => circle.id !== objectId);
    } else if (kind === 'angle') {
      state.angles = state.angles.filter((angle) => angle.id !== objectId);
    } else if (kind === 'angleMark') {
      state.angleMarks = state.angleMarks.filter((mark) => mark.id !== objectId);
    } else if (kind === 'angleConstraint') {
      releaseAngleConstraint(objectId);
    } else if (kind === 'mark') {
      state.marks = state.marks.filter((mark) => mark.id !== objectId);
    } else if (kind === 'constraint') {
      releaseConstraint(objectId);
    }
    if (state.selected?.id === objectId) state.selected = null;
  }

  function chooseObject(target, position) {
    const hit = hitTest(position, currentPointerType, true);
    return hit ? {kind:hit.kind,id:hit.id} : null;
  }

  function clickedPoint(target, position) {
    const hit = hitTest(position, currentPointerType, false);
    return hit?.kind === 'point' ? pointById(hit.id) : null;
  }

  function clickedSegment(target, position) {
    const hit = hitTest(position, currentPointerType, true);
    return hit?.kind === 'segment' ? segmentById(hit.id) : null;
  }

  // When a point marker lies directly on a line, the point normally wins
  // hit-testing. During an attach/detach operation, allow the user to tap that
  // same location repeatedly to cycle through the lines passing through it.
  function segmentThroughPointAt(point, position, includeAttached) {
    if (!point || !isPointAvailable(point)) return null;
    const query=worldToScreen(position);
    const tolerance=(currentPointerType==='touch'||currentPointerType==='pen')?22:12;
    const attached=new Set(pointLineAttachmentIds(point));
    const p=xy(point);
    const candidates=[];
    for (const segment of state.segments) {
      if (!isSegmentAvailable(segment)) continue;
      if (attached.has(segment.id)!==includeAttached) continue;
      if (!pointOnAttachedSegment(p,segment,'segment')) continue;
      const a=worldToScreen(xy(pointById(segment.a)));
      const b=worldToScreen(xy(pointById(segment.b)));
      const distance=distToSegment(query,a,b);
      if (distance<=tolerance) candidates.push({segment,distance});
    }
    candidates.sort((a,b)=>a.distance-b.distance);
    return candidates[0]?.segment||null;
  }

  function rawSegmentParameter(position, segment) {
    const a=xy(pointById(segment.a)), b=xy(pointById(segment.b));
    const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
    if (den<1e-12) return null;
    return ((position.x-a.x)*dx+(position.y-a.y)*dy)/den;
  }

  function pointOnAttachedSegment(position, segment, extent='segment') {
    if (!segment || !isSegmentAvailable(segment)) return false;
    const a=xy(pointById(segment.a)),b=xy(pointById(segment.b));
    const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
    if (den<1e-12) return false;
    const t=((position.x-a.x)*dx+(position.y-a.y)*dy)/den;
    const nearest={x:a.x+t*dx,y:a.y+t*dy};
    const tolerance=1e-6*Math.max(1,Math.sqrt(den));
    if (Math.hypot(position.x-nearest.x,position.y-nearest.y)>tolerance) return false;
    return extent==='line' || (t>=-1e-7 && t<=1+1e-7);
  }

  function constructionSnapshot(point) {
    if (!point || point.kind==='free' || point.kind==='constrainedPoint') return null;
    const saved={};
    for (const [key,value] of Object.entries(point)) if (key!=='id'&&key!=='name') saved[key]=clone(value);
    // Active constraints are temporarily suspended while their endpoint is
    // attached to user-selected lines. They are restored when the final line
    // attachment is removed, provided their original objects still exist.
    if (point.kind==='constraintEndpoint') {
      const constraint=constraintById(point.constraintId);
      if (constraint) {
        saved.__suspendedConstraint=clone(constraint);
        saved.__suspendedMarks=clone(state.marks.filter(mark=>mark.constraintId===constraint.id));
      }
    } else if (point.kind==='angleConstraintEndpoint') {
      const constraint=angleConstraintById(point.angleConstraintId);
      if (constraint) saved.__suspendedAngleConstraint=clone(constraint);
    }
    return saved;
  }

  function attachPointToSegment(point, segment) {
    if (!point || !segment || !isPointAvailable(point)) {
      $('#toolHelp').textContent = 'Нельзя привязать отсутствующую или временно недоступную точку.';
      return false;
    }
    if (point.id===segment.a || point.id===segment.b) {
      $('#toolHelp').textContent = 'Точка уже является концом этого отрезка — связь существует и не требует дополнительной привязки.';
      return false;
    }
    const attachments=point.kind==='constrainedPoint'?(point.lineAttachments||[]):[];
    if (attachments.some(item=>item.segmentId===segment.id)) {
      $('#toolHelp').textContent = `Точка ${point.name} уже привязана к отрезку ${displaySegmentName(segment)}.`;
      return false;
    }
    if (wouldCreateDependencyCycle(point.id,[segment.a,segment.b])) {
      $('#toolHelp').textContent = 'Нельзя прикрепить точку: эта связь создала бы циклическую зависимость.';
      return false;
    }

    const current=xy(point);
    let candidate=current;
    const nextAttachments=clone(attachments);
    if (!nextAttachments.length) {
      const projected=projectToSegment(current,segment);
      if (projected.t<=1e-5||projected.t>=1-1e-5) {
        $('#toolHelp').textContent = 'Точка попадает почти в конец отрезка. Для связи с вершиной используй саму существующую точку.';
        return false;
      }
      candidate={x:projected.x,y:projected.y};
      nextAttachments.push({kind:'segment',segmentId:segment.id,t:projected.t,extent:'segment'});
    } else {
      const existingSegments=nextAttachments.map(item=>segmentById(item.segmentId));
      const candidates=existingSegments.map(parent=>parent?lineIntersection(parent,segment):null).filter(Boolean);
      const common=candidates.find(intersection=>[...existingSegments,segment].every(parent=>pointOnAttachedSegment(intersection,parent,'segment')));
      if (common) candidate=common;
      else {
        const redundantCollinear=existingSegments.every(parent=>segmentsShareSupportingLine(parent,segment)) &&
          existingSegments.every(parent=>pointOnAttachedSegment(current,parent,'segment')) &&
          pointOnAttachedSegment(current,segment,'segment');
        if (!redundantCollinear) {
          $('#toolHelp').textContent = 'Новый отрезок не проходит через общую точку существующих связей. Параллельные разные линии или несовместимые пересечения не добавляются.';
          return false;
        }
        candidate=current;
      }
      for (let i=0;i<nextAttachments.length;i++) {
        const t=rawSegmentParameter(candidate,existingSegments[i]);
        if (!Number.isFinite(t)) { $('#toolHelp').textContent='Не удалось определить положение точки на одном из связанных отрезков.';return false; }
        nextAttachments[i].t=t;
      }
      const t=rawSegmentParameter(candidate,segment);
      if (!Number.isFinite(t)) { $('#toolHelp').textContent='Не удалось определить положение точки на новом отрезке.';return false; }
      nextAttachments.push({kind:'segment',segmentId:segment.id,t,extent:'segment'});
    }

    const previousConstruction=point.kind==='constrainedPoint'?point.previousConstruction:constructionSnapshot(point);
    pushHistory();
    if (previousConstruction?.__suspendedConstraint) {
      const suspendedId=previousConstruction.__suspendedConstraint.id;
      state.constraints=state.constraints.filter(item=>item.id!==suspendedId);
      state.marks=state.marks.filter(mark=>mark.constraintId!==suspendedId);
    }
    if (previousConstruction?.__suspendedAngleConstraint) {
      const suspendedId=previousConstruction.__suspendedAngleConstraint.id;
      state.angleConstraints=state.angleConstraints.filter(item=>item.id!==suspendedId);
    }
    const initialPosition=candidate;
    for (const key of Object.keys(point)) if (key!=='id'&&key!=='name') delete point[key];
    point.kind='constrainedPoint';
    point.x=initialPosition.x;point.y=initialPosition.y;
    point.lineAttachments=nextAttachments;
    if (previousConstruction) point.previousConstruction=previousConstruction;
    state.pending=[point.id]; state.pendingMode='attachAnyGeometry'; state.selected={kind:'point',id:point.id};
    const count=nextAttachments.length;
    const countLabel=count===2?'2 отрезка':count>=3&&count<=4?`${count} отрезка`:`${count} отрезков`;
    $('#toolHelp').textContent = count===1
      ? `Точка ${point.name} привязана к ${displaySegmentName(segment)}. Можно выбрать ещё один отрезок или соединить точку с другой точкой. Если линия проходит прямо через маркер, коснись точки ещё раз, чтобы добавить её.`
      : `К точке ${point.name} прикреплено ${countLabel}. Её положение определяется независимыми пересекающимися линиями; совпадающие по одной прямой отрезки могут быть дополнительными связями. Можно продолжить добавлять линии.`;
    renderAll();
    return true;
  }

  function addPointOnSegment(segment, position) {
    const projected = projectToSegment(position, segment);
    // Prefer reusing an existing free point when the user clicks close to it.
    const existing = nearPoint(position, 14);
    if (existing && existing.kind === 'free') return attachPointToSegment(existing, segment);
    if (projected.t < 0.015 || projected.t > 0.985) {
      const endpoint = pointById(projected.t < 0.5 ? segment.a : segment.b);
      $('#toolHelp').textContent = `Щелчок попал почти в вершину ${endpoint.name}; выбери место дальше от конца отрезка.`;
      return false;
    }
    pushHistory();
    const point = addPoint(0, 0, 'onSegment', segment.id, projected.t);
    state.pending = []; state.pendingMode = null;
    $('#toolHelp').textContent = `Создана точка ${point.name}, точно лежащая на отрезке ${displaySegmentName(segment)}.`;
    renderAll();
    return true;
  }

  function addSegmentConstraint(type, source, target) {
    if (!source || !target || source.id === target.id) {
      $('#toolHelp').textContent = 'Нужно выбрать два разных отрезка.';
      return false;
    }
    if (state.constraints.some((c) => c.targetSegmentId === target.id)) {
      $('#toolHelp').textContent = 'У целевого отрезка уже есть активное ограничение. Сначала удали его в списке объектов.';
      return false;
    }
    const targetEndpoint = pointById(target.b);
    if (!targetEndpoint || targetEndpoint.kind !== 'free') {
      $('#toolHelp').textContent = 'Второй конец целевого отрезка должен быть свободной точкой. Выбери другой отрезок.';
      return false;
    }
    if (targetEndpoint.id === source.a || targetEndpoint.id === source.b) {
      $('#toolHelp').textContent = 'Выбранные отрезки имеют общий целевой конец. Выбери другой целевой отрезок.';
      return false;
    }
    const sourceA = xy(pointById(source.a)); const sourceB = xy(pointById(source.b));
    const targetA = xy(pointById(target.a)); const targetB = xy(pointById(target.b));
    const sourceLength = Math.hypot(sourceB.x - sourceA.x, sourceB.y - sourceA.y);
    const targetLength = Math.hypot(targetB.x - targetA.x, targetB.y - targetA.y);
    if (sourceLength < 1 || targetLength < 1) {
      $('#toolHelp').textContent = 'Нельзя наложить ограничение на отрезок нулевой длины.';
      return false;
    }
    const su = (sourceB.x - sourceA.x) / sourceLength;
    const sv = (sourceB.y - sourceA.y) / sourceLength;
    const tu = (targetB.x - targetA.x) / targetLength;
    const tv = (targetB.y - targetA.y) / targetLength;
    const dot = su * tu + sv * tv;
    const cross = su * tv - sv * tu;
    if (wouldCreateDependencyCycle(targetEndpoint.id, [target.a, source.a, source.b])) {
      $('#toolHelp').textContent = 'Нельзя применить ограничение: оно создало бы циклическую зависимость. Выбери другие отрезки.';
      return false;
    }

    pushHistory();
    const constraint = {
      id: id(), type, sourceSegmentId: source.id, targetSegmentId: target.id,
      targetPointId: targetEndpoint.id,
      targetLength,
      unitX: tu, unitY: tv,
      sign: type === 'perpendicular' ? (cross >= 0 ? 1 : -1) : (dot >= 0 ? 1 : -1)
    };
    state.constraints.push(constraint);
    targetEndpoint.kind = 'constraintEndpoint';
    targetEndpoint.constraintId = constraint.id;
    delete targetEndpoint.x; delete targetEndpoint.y;
    if (type === 'equalLength') {
      state.marks.push({ id: id(), constraintId: constraint.id, segmentIds: [source.id, target.id], ticks: 1 });
    }
    state.pending = []; state.pendingMode = null;
    const phrase = type === 'parallel' ? 'параллельны' : type === 'perpendicular' ? 'перпендикулярны' : 'имеют равную длину';
    $('#toolHelp').textContent = `Ограничение применено: ${displaySegmentName(source)} и ${displaySegmentName(target)} ${phrase}.`;
    renderAll();
    return true;
  }

  function addEqualAngleConstraint(sourceAngle, targetAngle) {
    const sourceIds=[sourceAngle.aId,sourceAngle.vertexId,sourceAngle.cId];
    const targetIds=[targetAngle.aId,targetAngle.vertexId,targetAngle.cId];
    if (new Set(sourceIds).size!==3 || new Set(targetIds).size!==3) {
      $('#toolHelp').textContent='Каждый угол должен задаваться тремя различными точками.'; return false;
    }
    const targetPoint=pointById(targetAngle.cId);
    if (!targetPoint || targetPoint.kind!=='free') {
      $('#toolHelp').textContent='Конечная точка F второго угла должна быть свободной. Перестраиваться будет именно луч от E к F.'; return false;
    }
    const sourceInfo=angleData(sourceAngle), targetInfo=angleData(targetAngle);
    if (!sourceInfo || !targetInfo || sourceInfo.degrees<0.05 || targetInfo.degrees<0.05) {
      $('#toolHelp').textContent='Нельзя связать вырожденный угол. Проверь, что точки каждого угла различны и не совпадают геометрически.'; return false;
    }
    const parents=[sourceAngle.aId,sourceAngle.vertexId,sourceAngle.cId,targetAngle.aId,targetAngle.vertexId];
    if (wouldCreateDependencyCycle(targetPoint.id,parents)) {
      $('#toolHelp').textContent='Нельзя применить равенство углов: оно создало бы циклическую зависимость.'; return false;
    }
    if (state.angleConstraints.some(c=>c.targetPointId===targetPoint.id)) {
      $('#toolHelp').textContent='Эта точка уже управляется ограничением. Выбери другой конечный луч второго угла.'; return false;
    }
    const vertex=xy(pointById(targetAngle.vertexId)), end=xy(targetPoint);
    const targetLength=Math.hypot(end.x-vertex.x,end.y-vertex.y);
    if (targetLength<1e-6) { $('#toolHelp').textContent='Длина второго луча должна быть положительной.'; return false; }
    const constraint={
      id:id(), sourceAngle:{...sourceAngle}, targetAngle:{...targetAngle},
      targetPointId:targetPoint.id, targetLength,
      orientationSign:targetInfo.delta>=0?1:-1
    };
    state.angleConstraints.push(constraint);
    targetPoint.kind='angleConstraintEndpoint'; targetPoint.angleConstraintId=constraint.id;
    delete targetPoint.x; delete targetPoint.y;
    state.pending=[]; state.pendingMode=null;
    $('#toolHelp').textContent=`Создано активное ограничение: ∠${pointById(sourceAngle.aId).name}${pointById(sourceAngle.vertexId).name}${pointById(sourceAngle.cId).name} = ∠${pointById(targetAngle.aId).name}${pointById(targetAngle.vertexId).name}${pointById(targetAngle.cId).name}. Конечный луч второго угла теперь зависимый.`;
    renderAll();
    return true;
  }

  function createOrSelectAtPoint(position, target) {
    const point = clickedPoint(target, position);
    return point || addPoint(position.x, position.y);
  }

  function pointLineAttachmentIds(point) {
    if (!point) return [];
    const ids=[];
    if (point.kind==='constrainedPoint') ids.push(...(point.lineAttachments||[]).map(item=>item.segmentId));
    if (point.kind==='onSegment'||point.kind==='midpoint'||point.kind==='projection') ids.push(point.segmentId);
    if (point.kind==='intersection') ids.push(point.segment1Id,point.segment2Id);
    if (point.kind==='curveIntersection') ids.push(
      point.parent1Kind==='segment'?point.parent1Id:null,
      point.parent2Kind==='segment'?point.parent2Id:null
    );
    // Segments for which this point is already a shared endpoint are also
    // genuine incidence relations and can be detached independently.
    ids.push(...state.segments.filter(segment=>segment.a===point.id||segment.b===point.id).map(segment=>segment.id));
    return [...new Set(ids.filter(Boolean))];
  }

  function makePointFree(point, position) {
    for (const key of Object.keys(point)) if (key!=='id'&&key!=='name') delete point[key];
    point.kind='free'; point.x=position.x; point.y=position.y;
  }

  function restoreSuspendedConstruction(point, position) {
    const saved=point.previousConstruction?clone(point.previousConstruction):null;
    for (const key of Object.keys(point)) if (key!=='id'&&key!=='name') delete point[key];
    if (!saved) { makePointFree(point,position); return; }

    const suspendedConstraint=saved.__suspendedConstraint;
    const suspendedMarks=saved.__suspendedMarks||[];
    const suspendedAngleConstraint=saved.__suspendedAngleConstraint;
    delete saved.__suspendedConstraint;delete saved.__suspendedMarks;delete saved.__suspendedAngleConstraint;
    Object.assign(point,saved);

    let canRestore=true;
    if (suspendedConstraint) {
      const target=segmentById(suspendedConstraint.targetSegmentId);
      const source=segmentById(suspendedConstraint.sourceSegmentId);
      canRestore=!!target&&!!source&&(target.a===point.id||target.b===point.id)&&
        !wouldCreateDependencyCycle(point.id,[target.a,source.a,source.b].filter(pid=>pid!==point.id));
      if (canRestore) {
        state.constraints.push(suspendedConstraint);
        state.marks.push(...suspendedMarks);
      }
    }
    if (suspendedAngleConstraint) {
      const c=suspendedAngleConstraint;
      const refs=[c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId,c.targetPointId];
      canRestore=canRestore&&c.targetPointId===point.id&&refs.every(pointById)&&
        !wouldCreateDependencyCycle(point.id,[c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId]);
      if (canRestore) state.angleConstraints.push(c);
    }
    if (!canRestore || !isPointAvailable(point)) makePointFree(point,position);
  }

  function detachPointFromSegment(point, segment) {
    if (!point||!segment) return false;
    const position=xy(point);
    const endpointRelation=segment.a===point.id||segment.b===point.id;
    const explicitRelation=point.kind==='constrainedPoint'&&(point.lineAttachments||[]).some(item=>item.segmentId===segment.id);
    if (endpointRelation && !explicitRelation) {
      // A segment endpoint is already attached by identity. To detach only this
      // segment while preserving both geometries, split the shared vertex into
      // a new independent endpoint at the same mathematical coordinates.
      pushHistory();
      if (point.kind==='constraintEndpoint') {
        const constraint=constraintById(point.constraintId);
        if (constraint?.targetSegmentId===segment.id) releaseConstraint(constraint.id);
      }
      if (point.kind==='constrainedPoint' && point.previousConstruction?.__suspendedConstraint?.targetSegmentId===segment.id) {
        // The user explicitly detached the original constrained endpoint itself;
        // do not restore a constraint whose target segment no longer uses it.
        delete point.previousConstruction;
      }
      const independentEndpoint=addPoint(position.x,position.y);
      if (segment.a===point.id) segment.a=independentEndpoint.id;
      if (segment.b===point.id) segment.b=independentEndpoint.id;
      const stillAttached=pointLineAttachmentIds(point).length>0;
      state.pending=stillAttached?[point.id]:[];
      state.pendingMode=stillAttached?'detachLine':null;
      $('#toolHelp').textContent=`Отрезок ${displaySegmentName(segment)} отделён от точки ${point.name}. Создана самостоятельная концевая точка ${independentEndpoint.name}; остальные связи исходной точки сохранены.`;
      renderAll();
      return true;
    }
    if (point.kind==='constrainedPoint') {
      const previous=point.lineAttachments||[];
      if (!previous.some(item=>item.segmentId===segment.id)) return false;
      const wasAvailable=isPointAvailable(point);
      const remaining=previous.filter(item=>item.segmentId!==segment.id);
      pushHistory();
      if (remaining.length) {
        point.lineAttachments=remaining;
        if (remaining.length===1) {
          const parent=segmentById(remaining[0].segmentId);
          const t=wasAvailable&&parent?rawSegmentParameter(position,parent):remaining[0].t;
          if (!parent||!Number.isFinite(t)) { restoreSuspendedConstruction(point,position); }
          else remaining[0].t=t;
        }
      } else {
        restoreSuspendedConstruction(point,position);
      }
      state.pending=pointById(point.id)&&point.kind==='constrainedPoint'?[point.id]:[];
      state.pendingMode=state.pending.length?'detachLine':null;
      $('#toolHelp').textContent=`Связь точки ${point.name} с отрезком ${displaySegmentName(segment)} удалена. ${state.pending.length?'Можно выбрать ещё одну линию для открепления.':'Исходное построение восстановлено либо точка освобождена.'}`;
      renderAll();
      return true;
    }

    const attachedIds=pointLineAttachmentIds(point);
    if (!attachedIds.includes(segment.id)) return false;
    pushHistory();
    if (point.kind==='intersection') {
      const remainingId=point.segment1Id===segment.id?point.segment2Id:point.segment1Id;
      const remaining=segmentById(remainingId);
      if (remaining) {
        const t=rawSegmentParameter(position,remaining);
        point.kind='constrainedPoint';
        point.lineAttachments=[{kind:'segment',segmentId:remaining.id,t,extent:'line'}];
        delete point.segment1Id; delete point.segment2Id;
      } else makePointFree(point,position);
    } else if (point.kind==='curveIntersection') {
      const other=point.parent1Kind==='segment'&&point.parent1Id===segment.id
        ? {kind:point.parent2Kind,id:point.parent2Id}
        : {kind:point.parent1Kind,id:point.parent1Id};
      if (other.kind==='segment') {
        const remaining=segmentById(other.id),t=remaining?rawSegmentParameter(position,remaining):null;
        if (remaining&&t!==null) {
          point.kind='constrainedPoint'; point.lineAttachments=[{kind:'segment',segmentId:remaining.id,t,extent:'line'}];
          delete point.parent1Kind;delete point.parent1Id;delete point.parent2Kind;delete point.parent2Id;delete point.branch;
        } else makePointFree(point,position);
      } else if (other.kind==='circle') {
        const circle=state.circles.find(item=>item.id===other.id),cg=circleGeometry(circle);
        if (cg) { point.kind='onCircle';point.circleId=circle.id;point.angle=Math.atan2(position.y-cg.center.y,position.x-cg.center.x);delete point.parent1Kind;delete point.parent1Id;delete point.parent2Kind;delete point.parent2Id;delete point.branch; }
        else makePointFree(point,position);
      } else makePointFree(point,position);
    } else {
      // Midpoints, points created on a segment and projections become free
      // when their defining segment is explicitly detached.
      makePointFree(point,position);
    }
    state.pending=[];state.pendingMode=null;
    $('#toolHelp').textContent=`Точка ${point.name} откреплена от ${displaySegmentName(segment)}.`;
    renderAll();
    return true;
  }

  function handleDetachTool(target, position) {
    const point=clickedPoint(target,position);
    const geometry=clickedGeometry(target,position);
    if (!state.pending.length) {
      if (!point) { $('#toolHelp').textContent='Сначала выбери точку, у которой нужно удалить связь.'; return; }
      const ids=pointLineAttachmentIds(point);
      state.pending=[point.id];state.pendingMode='detachLine';state.selected={kind:'point',id:point.id};
      const names=ids.map(sid=>{const segment=segmentById(sid);return segment?displaySegmentName(segment):null;}).filter(Boolean);
      $('#toolHelp').textContent=names.length
        ? `Выбрана точка ${point.name}. Её связи с отрезками: ${names.join(', ')}. Теперь выбери линию, от которой нужно открепить точку.`
        : `У точки ${point.name} нет активных связей с отрезками, которые можно удалить.`;
      renderGeometry();return;
    }
    const selected=pointById(state.pending[0]);
    if (point&&point.id===selected?.id) {
      const lineUnderPoint=segmentThroughPointAt(selected,position,true);
      if (lineUnderPoint) { detachPointFromSegment(selected,lineUnderPoint); return; }
      state.pending=[];state.pendingMode=null;state.selected=null;
      $('#toolHelp').textContent='Выбор точки для открепления завершён.';renderGeometry();return;
    }
    if (point&&point.id!==selected?.id) {
      state.pending=[point.id];state.pendingMode='detachLine';state.selected={kind:'point',id:point.id};
      const names=pointLineAttachmentIds(point).map(sid=>{const seg=segmentById(sid);return seg?displaySegmentName(seg):null;}).filter(Boolean);
      $('#toolHelp').textContent=names.length?`Выбрана точка ${point.name}. Выбери один из её отрезков: ${names.join(', ')}.`:`У точки ${point.name} нет активных связей с отрезками.`;
      renderGeometry();return;
    }
    if (geometry?.kind==='segment'&&selected) {
      const segment=segmentById(geometry.id);
      if (!pointLineAttachmentIds(selected).includes(segment.id)) {
        $('#toolHelp').textContent=`Точка ${selected.name} не привязана к отрезку ${displaySegmentName(segment)}.`;return;
      }
      detachPointFromSegment(selected,segment);return;
    }
    $('#toolHelp').textContent='Теперь выбери отрезок, от которого нужно открепить выбранную точку.';
  }

  function handleOnSegmentTool(target, position) {
    const point = clickedPoint(target, position);
    const segment = clickedSegment(target, position);
    if (!state.pending.length) {
      if (point && point.kind === 'free') {
        state.pending = [point.id]; state.pendingMode = 'attachPoint';
        $('#toolHelp').textContent = `Выбрана точка ${point.name}. Теперь щёлкни по отрезку, к которому её нужно прикрепить.`;
      } else if (segment) {
        state.pending = [segment.id]; state.pendingMode = 'createOnSegment';
        $('#toolHelp').textContent = `Выбран отрезок ${displaySegmentName(segment)}. Теперь щёлкни в нужном месте на нём, чтобы создать зависимую точку.`;
      } else {
        $('#toolHelp').textContent = 'Сначала выбери свободную точку или существующий отрезок.';
      }
      renderGeometry();
      return;
    }
    if (state.pendingMode === 'attachPoint') {
      if (!segment) { $('#toolHelp').textContent = 'Теперь нужно выбрать отрезок.'; return; }
      attachPointToSegment(pointById(state.pending[0]), segment);
      return;
    }
    if (state.pendingMode === 'createOnSegment') {
      const parent = segmentById(state.pending[0]);
      if (!parent) { state.pending = []; state.pendingMode = null; renderAll(); return; }
      addPointOnSegment(parent, position);
    }
  }

  function attachPointToCircle(point, circle) {
    if (!point || !circle || point.kind !== 'free') {
      $('#toolHelp').textContent = 'Привязать можно только свободную точку.'; return false;
    }
    const geometry = circleGeometry(circle);
    if (!geometry || geometry.radius < 1e-7) { $('#toolHelp').textContent = 'Нельзя привязать точку к вырожденной окружности.'; return false; }
    if (wouldCreateDependencyCycle(point.id, [circle.centerId, circleRadiusPointId(circle)].filter(Boolean))) {
      $('#toolHelp').textContent = 'Нельзя прикрепить точку: это создало бы циклическую зависимость.'; return false;
    }
    const position = xy(point);
    const angle = Math.atan2(position.y - geometry.center.y, position.x - geometry.center.x);
    pushHistory(); point.kind = 'onCircle'; point.circleId = circle.id; point.angle = angle;
    delete point.x; delete point.y;
    state.pending = []; state.pendingMode = null;
    $('#toolHelp').textContent = `Точка ${point.name} привязана к окружности и будет оставаться на ней.`;
    renderAll(); return true;
  }

  function handleOnCircleTool(target, position) {
    const point = clickedPoint(target, position);
    const geometry = clickedGeometry(target, position);
    if (!state.pending.length) {
      if (point && point.kind === 'free') {
        state.pending = [point.id]; state.pendingMode = 'attachPointCircle';
        $('#toolHelp').textContent = `Выбрана точка ${point.name}. Теперь щёлкни по границе окружности.`;
      } else if (geometry?.kind === 'circle') {
        state.pending = [geometry.id]; state.pendingMode = 'createOnCircle';
        $('#toolHelp').textContent = 'Окружность выбрана. Щёлкни по её границе, чтобы создать точку.';
      } else $('#toolHelp').textContent = 'Сначала выбери свободную точку или границу окружности.';
      renderGeometry(); return;
    }
    if (state.pendingMode === 'attachPointCircle') {
      if (geometry?.kind !== 'circle') { $('#toolHelp').textContent = 'Теперь нужно выбрать границу окружности.'; return; }
      attachPointToCircle(pointById(state.pending[0]), state.circles.find(circle => circle.id === geometry.id)); return;
    }
    if (state.pendingMode === 'createOnCircle') {
      const circle = state.circles.find(item => item.id === state.pending[0]);
      if (!circle) { state.pending=[]; state.pendingMode=null; renderAll(); return; }
      const cg = circleGeometry(circle); const angle = Math.atan2(position.y-cg.center.y, position.x-cg.center.x);
      pushHistory(); const created = {id:id(),name:nextPointName(),kind:'onCircle',circleId:circle.id,angle}; state.points.push(created);
      state.pending=[]; state.pendingMode=null; $('#toolHelp').textContent=`Создана точка ${created.name} на окружности.`; renderAll();
    }
  }

  function handleConstraintTool(tool, target, position) {
    const segment = clickedSegment(target, position);
    if (!segment) { $('#toolHelp').textContent = 'Щёлкни по существующему отрезку.'; return; }
    if (!state.pending.length) {
      state.pending = [segment.id]; state.pendingMode = 'constraintSource';
      const relationship = tool === 'parallel' ? 'параллелен' : tool === 'perpendicular' ? 'перпендикулярен' : 'равен по длине';
      $('#toolHelp').textContent = `Исходный отрезок ${displaySegmentName(segment)} выбран. Теперь выбери отрезок, который должен быть ему ${relationship}.`;
      renderGeometry();
      return;
    }
    const source = segmentById(state.pending[0]);
    addSegmentConstraint(tool, source, segment);
  }

  function handleIntersectionTool(target, position) {
    const geometry=clickedGeometry(target,position);
    if (!geometry) { $('#toolHelp').textContent='Щёлкни по отрезку или границе окружности.'; return; }
    if (!state.pending.length) {
      state.pending=[geometry]; state.pendingMode='intersectionFirst';
      $('#toolHelp').textContent=`Выбран ${geometry.kind==='segment'?'отрезок':'окружность'}. Теперь выбери второй объект для пересечения.`;
      return;
    }
    const first=state.pending[0];
    if (first.kind===geometry.kind && first.id===geometry.id) { $('#toolHelp').textContent='Нужно выбрать другой геометрический объект.'; return; }
    const candidates=intersectionCandidates(first,geometry);
    if (!candidates.length) {
      $('#toolHelp').textContent='Эти объекты не имеют единственной или конечного числа точек пересечения (либо они не пересекаются).';
      state.pending=[]; state.pendingMode=null; return;
    }
    const already=state.points.filter(point=>point.kind==='curveIntersection' && (
      point.parent1Kind===first.kind && point.parent1Id===first.id && point.parent2Kind===geometry.kind && point.parent2Id===geometry.id ||
      point.parent1Kind===geometry.kind && point.parent1Id===geometry.id && point.parent2Kind===first.kind && point.parent2Id===first.id
    ));
    if (already.length>=candidates.length) {
      $('#toolHelp').textContent='Точки пересечения этих объектов уже построены.';
      state.pending=[]; state.pendingMode=null; return;
    }
    pushHistory();
    candidates.forEach((candidate,index)=>{
      if (already.some(p=>p.branch===index)) return;
      const point={id:id(),name:nextPointName(),kind:'curveIntersection',parent1Kind:first.kind,parent1Id:first.id,parent2Kind:geometry.kind,parent2Id:geometry.id,branch:index,x:candidate.x,y:candidate.y};
      state.points.push(point);
    });
    const created=candidates.length-already.length;
    state.pending=[]; state.pendingMode=null;
    renderAll();
    $('#toolHelp').textContent=`Создано точек пересечения: ${created}. Они будут перестраиваться вместе с исходными объектами.`;
  }

  function handlePointSequenceTool(tool, target, position) {
    if (!state.pending.length) pushHistory();
    const point=createOrSelectAtPoint(position,target);
    if (tool==='angle') {
      state.pending.push(point.id);
      if (state.pending.length===3) {
        const [a,v,c]=state.pending;
        if (new Set([a,v,c]).size===3) state.angles.push({id:id(),aId:a,vertexId:v,cId:c});
        else $('#toolHelp').textContent='Для угла нужны три различные точки.';
        state.pending=[]; state.pendingMode=null; renderAll();
      } else { state.pendingMode='anglePoints'; $('#toolHelp').textContent=`Выбрана точка ${point.name}. Укажи ещё ${3-state.pending.length} точку(и); вторая точка будет вершиной.`; }
      return;
    }
    if (tool==='equalAngle') {
      state.pending.push(point.id);
      if (state.pending.length===6) {
        const ids=state.pending;
        const first={aId:ids[0],vertexId:ids[1],cId:ids[2]};
        const second={aId:ids[3],vertexId:ids[4],cId:ids[5]};
        addEqualAngleConstraint(first,second);
        state.pending=[]; state.pendingMode=null; renderAll();
      } else { state.pendingMode='equalAnglePoints'; $('#toolHelp').textContent=`Выбрана точка ${point.name}. Укажи ещё ${6-state.pending.length} точек: A, B, C для первого и D, E, F для второго угла.`; }
      return;
    }
    if (tool==='bisector') {
      state.pending.push(point.id);
      if (state.pending.length===3) {
        const [aId,vId,cId]=state.pending;
        if (new Set([aId,vId,cId]).size===3) {
          const a=pointById(aId),v=pointById(vId),c=pointById(cId);
          const pa=xy(a),pv=xy(v),pc=xy(c);
          const sideA= Math.hypot(pa.x-pv.x,pa.y-pv.y), sideC=Math.hypot(pc.x-pv.x,pc.y-pv.y);
          const cross=(pa.x-pv.x)*(pc.y-pv.y)-(pa.y-pv.y)*(pc.x-pv.x);
          if (sideA>1e-7 && sideC>1e-7 && Math.abs(cross)>1e-6) {
            addSegment(a,c);
            const foot={id:id(),name:nextPointName(),kind:'angleBisector',aId,vertexId:vId,cId};
            state.points.push(foot); addSegment(v,foot);
            state.angles.push({id:id(),aId,vertexId:vId,cId});
            $('#toolHelp').textContent=`Построена биссектриса угла ${a.name}${v.name}${c.name}.`;
          } else $('#toolHelp').textContent='Биссектриса требует невырожденного угла: точки не должны лежать на одной прямой или совпадать.';
        } else $('#toolHelp').textContent='Для биссектрисы нужны три различные точки.';
        state.pending=[]; state.pendingMode=null; renderAll();
      } else { state.pendingMode='bisectorPoints'; $('#toolHelp').textContent=`Выбрана точка ${point.name}. Укажи ещё ${3-state.pending.length} точки A, B, C; B — вершина угла.`; }
      return;
    }
  }

  function handleVertexSegmentConstruction(tool,target,position) {
    const point=clickedPoint(target,position);
    const segment=clickedSegment(target,position);
    if (!state.pending.length) {
      if (!point) { $('#toolHelp').textContent='Сначала щёлкни по вершине — существующей точке.'; return; }
      state.pending=[point.id]; state.pendingMode=`${tool}Vertex`;
      $('#toolHelp').textContent=`Выбрана вершина ${point.name}. Теперь щёлкни по противоположной стороне.`;
      renderGeometry(); return;
    }
    if (!segment) { $('#toolHelp').textContent='Теперь выбери отрезок, задающий противоположную сторону.'; return; }
    const vertex=pointById(state.pending[0]);
    if (!vertex || segment.a===vertex.id || segment.b===vertex.id) { $('#toolHelp').textContent='Выбранный отрезок должен быть противоположен вершине и не содержать её.'; return; }
    const A=xy(pointById(segment.a)), B=xy(pointById(segment.b)), V=xy(vertex);
    const den=(B.x-A.x)**2+(B.y-A.y)**2;
    if (den<1e-8) { $('#toolHelp').textContent='Нельзя построить линию по отрезку нулевой длины.'; return; }
    pushHistory();
    if (tool==='median') {
      let midpoint=state.points.find(p=>p.kind==='midpoint'&&p.segmentId===segment.id);
      if (!midpoint) midpoint=addPoint(0,0,'midpoint',segment.id);
      addSegment(vertex,midpoint);
      $('#toolHelp').textContent=`Построена медиана из ${vertex.name} к стороне ${displaySegmentName(segment)}.`;
    } else {
      const foot={id:id(),name:nextPointName(),kind:'projection',sourcePointId:vertex.id,segmentId:segment.id};
      const t=((V.x-A.x)*(B.x-A.x)+(V.y-A.y)*(B.y-A.y))/den;
      foot.x=A.x+t*(B.x-A.x); foot.y=A.y+t*(B.y-A.y);
      state.points.push(foot); addSegment(vertex,foot);
      const footXY=xy(foot);
      const distA=Math.hypot(footXY.x-A.x,footXY.y-A.y);
      const rightAngleBasePointId=distA<1e-5 ? segment.b : segment.a;
      state.angles.push({id:id(),aId:vertex.id,vertexId:foot.id,cId:rightAngleBasePointId,rightAngle:true});
      $('#toolHelp').textContent=`Построена высота из ${vertex.name}. Основание H находится на несущей прямой ${displaySegmentName(segment)}.`;
    }
    state.pending=[]; state.pendingMode=null; renderAll();
  }

  function clickCanvas(event) {
    if (state.tool === 'pan') return;
    const position = localPoint(event);
    const target = event.target.closest?.('[data-kind]');

    if (state.tool === 'group') {
      const object=chooseObject(target,position);
      if(!object){selectedGroup=null;state.selected=null;$('#toolHelp').textContent='Выделение группы снято. Нажми на точку, отрезок или окружность, чтобы выбрать другую конфигурацию.';renderAll();return;}
      const component=collectConnectedGeometry(object);
      if(!component){selectedGroup=null;state.selected=null;$('#toolHelp').textContent='Не удалось определить связанную геометрическую конфигурацию.';renderAll();return;}
      selectedGroup=component;
      state.selected={kind:'group',id:object.id};
      if(!component.drivers.length){
        state.drag=null;
        $('#toolHelp').textContent='Группа выделена, но в ней нет независимых свободных точек для переноса. Измени управляющее построение или освободи одну из точек.';
      } else {
        const before=modelSnapshot();
        pushHistory();
        state.drag={kind:'object-group',id:object.id,pointerId:event.pointerId,before,
          startPosition:{x:position.x,y:position.y},drivers:component.drivers,component};
        gestureMode='drag';
        try{svg.setPointerCapture(event.pointerId);}catch(_){}
        $('#toolHelp').textContent=`Выделена связанная конфигурация: ${component.points.length} точек, ${component.segments.length} отрезков, ${component.circles.length} окружностей. Перетаскивай объект — вся группа переместится без изменения внутренних отношений.`;
      }
      renderAll();return;
    }

    if (state.tool === 'select') {
      selectedGroup=null;
      const object = chooseObject(target, position);
      state.selected = object;
      if (object?.kind === 'point') {
        const point = pointById(object.id);
        const groupDrivers = createRigidTranslationPlan(point);
        const individuallyMovable = point?.kind === 'free' || point?.kind === 'onSegment' || point?.kind === 'onCircle' ||
          (point?.kind === 'constrainedPoint' && ((point.lineAttachments || []).length === 1 || isCollinearMultiLinePoint(point)));
        if (groupDrivers) {
          const before = modelSnapshot();
          pushHistory();
          state.drag = {
            kind:'point-group', id:point.id, pointerId:event.pointerId, before,
            startPosition:{x:position.x,y:position.y}, drivers:groupDrivers
          };
          gestureMode = 'drag';
          try { svg.setPointerCapture(event.pointerId); } catch (_) {}
          $('#toolHelp').textContent = `Перемещается точка ${point.name} вместе со всей связанной конфигурацией. Геометрические отношения и относительные положения сохраняются.`;
        } else if (individuallyMovable) {
          const before = modelSnapshot();
          pushHistory();
          state.drag = { kind:'point', id: point.id, pointerId: event.pointerId, before };
          gestureMode = 'drag';
          try { svg.setPointerCapture(event.pointerId); } catch (_) {}
        } else if (point?.kind === 'constrainedPoint') {
          $('#toolHelp').textContent = 'Эта точка не имеет независимого перемещения. Для пересечения независимых линий перетаскивай саму точку: связанные объекты переместятся вместе. Если линии коллинеарны, точка движется вдоль общей линии.';
        } else if (point?.kind === 'constraintEndpoint') {
          $('#toolHelp').textContent = 'Эта точка зависит от ограничения. Перемещай исходный отрезок или начало целевого отрезка.';
        } else if (point?.kind === 'angleConstraintEndpoint') {
          $('#toolHelp').textContent = 'Эта точка задаёт конечный луч зависимого угла. Измени исходный угол или удали ограничение равенства углов, чтобы освободить точку.';
        } else {
          $('#toolHelp').textContent = `Точка ${point?.name || ''} определяется построением и не имеет независимой степени свободы.`;
        }
      } else if (object?.kind === 'circle') {
        const circle = state.circles.find(item=>item.id===object.id);
        if (circle && !circleRadiusPointId(circle)) {
          const before = modelSnapshot();
          pushHistory();
          state.drag = {kind:'circle-radius',id:circle.id,pointerId:event.pointerId,before};
          gestureMode = 'drag';
          try { svg.setPointerCapture(event.pointerId); } catch (_) {}
          $('#toolHelp').textContent = 'Перетаскивай границу окружности, чтобы изменить радиус.';
        }
      }
      renderAll();
      return;
    }

    if (state.tool === 'point') {
      const existingPoint = clickedPoint(target, position);
      const geometry = clickedGeometry(target, position);

      if (state.pendingMode === 'attachAnyGeometry' && state.pending.length) {
        const pendingPoint = pointById(state.pending[0]);
        if (existingPoint && existingPoint.id === pendingPoint?.id) {
          const lineUnderPoint=segmentThroughPointAt(pendingPoint,position,false);
          if (lineUnderPoint) { attachPointToSegment(pendingPoint,lineUnderPoint); return; }
          state.pending=[];state.pendingMode=null;state.selected=null;
          $('#toolHelp').textContent=`Работа со связями точки ${pendingPoint.name} завершена.`;
          renderAll();return;
        }
        if (existingPoint && existingPoint.id !== pendingPoint?.id) {
          if (pendingPoint && existingPoint) {
            pushHistory();
            const segment = addSegment(pendingPoint, existingPoint);
            state.pending = [pendingPoint.id]; state.pendingMode = 'attachAnyGeometry'; state.selected = {kind:'point',id:pendingPoint.id};
            $('#toolHelp').textContent = segment
              ? `Создан отрезок ${displaySegmentName(segment)} с общей вершиной ${pendingPoint.name}. Выбери ещё одну точку или линию, чтобы добавить новые связи.`
              : `Эти точки уже соединены. Можно выбрать другую точку или линию для ${pendingPoint.name}.`;
            renderAll();
          }
          return;
        }
        if (geometry?.kind==='segment') {
          attachPointToSegment(pendingPoint,segmentById(geometry.id));
          return;
        }
        if (geometry?.kind==='circle') {
          if (pendingPoint?.kind!=='free') {
            $('#toolHelp').textContent='Привязка к окружности пока требует свободную точку. Для нескольких линейных связей выбери отрезки.';return;
          }
          const attached=attachPointToCircle(pendingPoint,state.circles.find(circle=>circle.id===geometry.id));
          if (attached) renderAll();
          return;
        }
        if (!existingPoint && pendingPoint) {
          pushHistory();
          const endpoint = addPoint(position.x, position.y);
          const segment = addSegment(pendingPoint, endpoint);
          state.pending = [pendingPoint.id]; state.pendingMode = 'attachAnyGeometry'; state.selected = {kind:'point',id:pendingPoint.id};
          $('#toolHelp').textContent = segment
            ? `Создан отрезок от ${pendingPoint.name} к ${endpoint.name}. Выбери ещё одну точку или линию для продолжения.`
            : 'Не удалось создать отрезок.';
          renderAll();return;
        }
        $('#toolHelp').textContent = 'Выбрана та же точка. Коснись её ещё раз, чтобы завершить, либо выбери другую точку/линию.';
        return;
      }

      if (existingPoint) {
        state.pending=[existingPoint.id];state.pendingMode='attachAnyGeometry';state.selected={kind:'point',id:existingPoint.id};
        const count=pointLineAttachmentIds(existingPoint).length;
        $('#toolHelp').textContent=`Выбрана точка ${existingPoint.name}. Выбери отрезок, чтобы прикрепить её (уже ${count} линейных связей), или другую точку, чтобы создать общий отрезок. Можно добавлять связи по одной; повторный выбор ${existingPoint.name} завершает операцию.`;
        renderGeometry();return;
      }

      if (geometry?.kind === 'segment') {
        const parentSegment = segmentById(geometry.id);
        const projected = projectToSegment(position, parentSegment);
        if (projected.t <= 0.015 || projected.t >= 0.985) {
          $('#toolHelp').textContent = 'Щелчок попал почти в конец отрезка. Для использования вершины щёлкни по самой точке.';
          return;
        }
        pushHistory();
        const point = addPoint(0, 0, 'onSegment', parentSegment.id, projected.t);
        $('#toolHelp').textContent = `Точка ${point.name} создана и автоматически прикреплена к отрезку ${displaySegmentName(parentSegment)}.`;
      } else if (geometry?.kind === 'circle') {
        const circle = state.circles.find(item => item.id === geometry.id);
        const cg = circleGeometry(circle);
        if (!cg || cg.radius < 1e-7) return;
        pushHistory();
        const angle = Math.atan2(position.y - cg.center.y, position.x - cg.center.x);
        const point = {id:id(), name:nextPointName(), kind:'onCircle', circleId:circle.id, angle};
        state.points.push(point);
        $('#toolHelp').textContent = `Точка ${point.name} создана и автоматически прикреплена к окружности.`;
      } else {
        pushHistory();
        const point = addPoint(position.x, position.y);
        $('#toolHelp').textContent = `Создана свободная точка ${point.name}.`;
      }
      state.pending = []; state.pendingMode = null;
      renderAll();
      return;
    }
    if (state.tool === 'segment') {
      if (!state.pending.length) {
        pushHistory();
        const point = createOrSelectAtPoint(position, target);
        state.pending = [point.id]; state.pendingMode = 'segmentFirst';
        state.selected = { kind: 'point', id: point.id };
      } else {
        const point = createOrSelectAtPoint(position, target);
        const first = pointById(state.pending[0]);
        if (first && point.id !== first.id) addSegment(first, point);
        state.pending = []; state.pendingMode = null; state.selected = null;
      }
      renderAll(); return;
    }
    if (state.tool === 'triangle') {
      if (!state.pending.length) pushHistory();
      const point = createOrSelectAtPoint(position, target);
      if (!state.pending.includes(point.id)) state.pending.push(point.id);
      if (state.pending.length === 3) {
        const [a, b, c] = state.pending.map(pointById);
        addSegment(a, b); addSegment(b, c); addSegment(c, a);
        state.pending = []; state.pendingMode = null; state.selected = null;
      }
      renderAll(); return;
    }
    if (state.tool === 'circle') {
      if (!state.pending.length) {
        pushHistory();
        const point = createOrSelectAtPoint(position, target);
        state.pending = [point.id]; state.pendingMode = 'circleCenter';
        state.selected = { kind: 'point', id: point.id };
        $('#toolHelp').textContent = `Центр ${point.name} выбран. Укажи существующую точку как опору радиуса или щёлкни по свободному месту, чтобы задать радиус без создания дополнительной точки.`;
      } else {
        const center = pointById(state.pending[0]);
        const radiusPoint = clickedPoint(target, position);
        if (center && radiusPoint && radiusPoint.id !== center.id) {
          const a = xy(center), b = xy(radiusPoint);
          const radius = Math.hypot(b.x-a.x,b.y-a.y);
          if (radius > 1e-7) {
            const circle = addCircle(center, radius, radiusPoint.id);
            $('#toolHelp').textContent = circle ? `Окружность построена. Радиус задаётся существующей точкой ${radiusPoint.name}; эта точка сохранена в чертеже.` : 'Не удалось создать окружность.';
          } else $('#toolHelp').textContent = 'Радиус должен быть положительным.';
        } else if (center) {
          const a = xy(center);
          const radius = Math.hypot(position.x-a.x,position.y-a.y);
          if (radius > 1e-7) {
            addCircle(center, radius);
            $('#toolHelp').textContent = `Окружность построена с радиусом ${radius.toFixed(1)}. Вспомогательная координата радиуса не добавлена в список точек.`;
          } else $('#toolHelp').textContent = 'Радиус должен быть положительным.';
        }
        state.pending = []; state.pendingMode = null; state.selected = null;
      }
      renderAll(); return;
    }
    if (state.tool === 'midpoint') {
      const segment = clickedSegment(target, position);
      if (!segment) { $('#toolHelp').textContent = 'Не найден отрезок. Щёлкни непосредственно по линии.'; return; }
      if (state.points.some((point) => point.kind === 'midpoint' && point.segmentId === segment.id)) {
        $('#toolHelp').textContent = 'Для этого отрезка середина уже создана.'; return;
      }
      pushHistory(); addPoint(0, 0, 'midpoint', segment.id); renderAll(); return;
    }
    if (['parallel', 'perpendicular', 'equalLength'].includes(state.tool)) { handleConstraintTool(state.tool, target, position); return; }
    if (state.tool === 'intersection') { handleIntersectionTool(target, position); renderGeometry(); return; }
    if (['angle','equalAngle','bisector'].includes(state.tool)) { handlePointSequenceTool(state.tool,target,position); renderGeometry(); return; }
    if (['median','altitude'].includes(state.tool)) { handleVertexSegmentConstruction(state.tool,target,position); return; }
    if (state.tool === 'detach') { handleDetachTool(target,position); return; }
    if (state.tool === 'delete') {
      const object = chooseObject(target, position);
      if (object) { pushHistory(); deleteObject(object.kind, object.id); renderAll(); }
    }
  }

  // INPUT CONTROLLER: pointer gestures are routed through one explicit state machine.
  function pointerCenter(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function releaseCapture(pointerId) {
    try { if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId); } catch (_) {}
  }

  function startPan(event) {
    const anchor = localPoint(event);
    panState = {pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,worldX:anchor.x,worldY:anchor.y};
    state.drag = null;
    pendingTouchTap = null;
    gestureMode = 'pan';
    svg.classList.add('is-panning');
    try { svg.setPointerCapture(event.pointerId); } catch (_) {}
  }

  function rollbackDrag(drag) {
    if (!drag?.before) return;
    // Remove only this gesture's history entry; never discard an unrelated action.
    if (state.history[state.history.length-1] === drag.before) state.history.pop();
    state.redoHistory = [];
    Object.assign(state, JSON.parse(drag.before));
    state.selected = null;
    selectedGroup = null;
    state.pending = [];
    state.pendingMode = null;
    state.drag = null;
    renderAll();
  }

  function startPinch() {
    const pts = [...activePointers.values()].slice(0,2);
    if (pts.length < 2) return;
    // A second finger cancels a one-finger object drag instead of committing
    // an accidental partial movement before the camera gesture takes over.
    if (state.drag) rollbackDrag(state.drag);
    state.drag = null;
    panState = null;
    pendingTouchTap = null;
    gestureMode = 'pinch';
    const center = pointerCenter(pts[0],pts[1]);
    pinchState = {
      distance:Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y)),
      centerX:center.x,centerY:center.y
    };
    svg.classList.add('is-panning');
  }

  function updatePinch() {
    if (activePointers.size < 2 || !pinchState) return;
    const pts = [...activePointers.values()].slice(0,2);
    const center = pointerCenter(pts[0],pts[1]);
    const distance = Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));
    const oldCenter = {x:pinchState.centerX,y:pinchState.centerY};
    const factor = pinchState.distance/distance;
    zoomAt(factor,oldCenter.x,oldCenter.y);
    const before = localPointFromClient(oldCenter.x,oldCenter.y);
    const after = localPointFromClient(center.x,center.y);
    view.x -= after.x-before.x;
    view.y -= after.y-before.y;
    pinchState = {distance,centerX:center.x,centerY:center.y};
    applyView();
  }

  function updateDraggedObject(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    const position = localPoint(event);
    if (state.drag.kind === 'point-group' || state.drag.kind === 'object-group') {
      // Compute from the original pointer and driver positions on every frame.
      // This avoids cumulative drift and keeps the complete parent construction rigid.
      const dx = position.x - state.drag.startPosition.x;
      const dy = position.y - state.drag.startPosition.y;
      for (const driver of state.drag.drivers) {
        const point = pointById(driver.id);
        if (!point || point.kind !== 'free') continue;
        point.x = driver.x + dx;
        point.y = driver.y + dy;
      }
    } else if (state.drag.kind === 'circle-radius') {
      const circle = state.circles.find(item=>item.id===state.drag.id);
      const data = circleGeometry(circle);
      if (!circle || !data) return;
      const radius = Math.hypot(position.x-data.center.x,position.y-data.center.y);
      if (radius > 1e-6) circle.radius = radius;
    } else {
      const point = pointById(state.drag.id);
      if (!point) return;
      if (point.kind === 'free') {
        point.x = position.x; point.y = position.y;
      } else if (point.kind === 'onCircle') {
        const circle = state.circles.find(item => item.id === point.circleId);
        const geometry = circleGeometry(circle);
        if (!geometry) return;
        point.angle = Math.atan2(position.y-geometry.center.y,position.x-geometry.center.x);
      } else if (point.kind === 'onSegment') {
        const parent = segmentById(point.segmentId);
        if (!parent) return;
        point.t = projectToSegment(position,parent).t;
      } else if (point.kind==='constrainedPoint') {
        const attachments=point.lineAttachments||[];
        if (!attachments.length || (attachments.length>1 && !isCollinearMultiLinePoint(point))) return;
        const parent=segmentById(attachments[0].segmentId);
        if (!parent) return;
        const projected=projectToSegment(position,parent);
        for (const attachment of attachments) {
          const attachedSegment=segmentById(attachment.segmentId);
          if (!attachedSegment) return;
          const t=rawSegmentParameter(projected,attachedSegment);
          if (!Number.isFinite(t)) return;
          attachment.t=t;
        }
        const lastKnown=xy(point);point.x=lastKnown.x;point.y=lastKnown.y;
      }
    }
    renderGeometry(); renderObjects(); renderModelValidation(); updateCounts();
  }

  function finishPointer(event, cancelled = false) {
    const pointerId = event.pointerId;
    const wasTouch = event.pointerType === 'touch' || activePointers.has(pointerId);
    if (wasTouch) activePointers.delete(pointerId);

    if (gestureMode === 'pinch') {
      releaseCapture(pointerId);
      pinchState = null;
      if (activePointers.size >= 2) startPinch();
      else {
        gestureMode = activePointers.size === 1 ? 'suspended' : 'idle';
        svg.classList.remove('is-panning');
      }
      return;
    }

    if (gestureMode === 'suspended') {
      releaseCapture(pointerId);
      if (activePointers.size === 0) gestureMode = 'idle';
      return;
    }

    if (panState && pointerId === panState.pointerId) {
      releaseCapture(pointerId);
      panState = null;
      gestureMode = 'idle';
      svg.classList.remove('is-panning');
      return;
    }

    if (state.drag && pointerId === state.drag.pointerId) {
      const drag = state.drag;
      releaseCapture(pointerId);
      state.drag = null;
      gestureMode = 'idle';
      if (cancelled && drag.before) {
        rollbackDrag(drag);
        if (activePointers.size === 0) gestureMode = 'idle';
      } else renderAll();
      return;
    }

    // Single-finger drawing taps are committed on pointerup, so a second finger
    // can turn the gesture into pinch without accidentally creating geometry.
    if (!cancelled && pendingTouchTap && pendingTouchTap.pointerId === pointerId && gestureMode === 'idle') {
      const dx = event.clientX-pendingTouchTap.startX, dy = event.clientY-pendingTouchTap.startY;
      if (Math.hypot(dx,dy) <= 12) {
        currentPointerType = 'touch';
        clickCanvas(event);
      }
    }
    if (pendingTouchTap?.pointerId === pointerId) pendingTouchTap = null;
    releaseCapture(pointerId);
    if (wasTouch && activePointers.size === 0 && gestureMode !== 'pinch') gestureMode = 'idle';
  }

  svg.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') {
      activePointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      try { svg.setPointerCapture(event.pointerId); } catch (_) {}
      if (activePointers.size >= 2) {
        event.preventDefault();
        startPinch();
        return;
      }
      if (gestureMode === 'suspended') return;
    }

    const wantsPan = event.button === 1 || event.button === 2 || (event.button === 0 && (spacePressed || state.tool === 'pan'));
    if (wantsPan) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    currentPointerType = event.pointerType || 'mouse';

    if (event.pointerType === 'touch') {
      // Dragging a point is immediate; drawing-tool taps are deferred until up.
      if (state.tool === 'select' || state.tool === 'group') {
        clickCanvas(event);
        if (!state.drag && !state.selected) startPan(event);
      } else {
        pendingTouchTap = {pointerId:event.pointerId,startX:event.clientX,startY:event.clientY};
      }
    } else {
      clickCanvas(event);
    }
  });

  svg.addEventListener('contextmenu',event=>event.preventDefault());
  svg.addEventListener('wheel',event=>{
    event.preventDefault();
    zoomAt(event.deltaY<0?0.88:1.14,event.clientX,event.clientY);
  },{passive:false});

  svg.addEventListener('pointermove',event=>{
    if (activePointers.has(event.pointerId)) {
      activePointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if (gestureMode === 'pinch' && activePointers.size >= 2) { updatePinch(); return; }
      if (gestureMode === 'suspended') return;
    }

    if (panState && event.pointerId === panState.pointerId) {
      const current = localPoint(event);
      const anchor = {x:panState.worldX,y:panState.worldY};
      view.x += anchor.x-current.x;
      view.y += anchor.y-current.y;
      applyView();
      return;
    }

    if (state.drag && event.pointerId === state.drag.pointerId) {
      updateDraggedObject(event);
      return;
    }

    if (pendingTouchTap && event.pointerId === pendingTouchTap.pointerId) {
      const dx=event.clientX-pendingTouchTap.startX,dy=event.clientY-pendingTouchTap.startY;
      if (Math.hypot(dx,dy)>12) pendingTouchTap=null;
    }
  });

  svg.addEventListener('pointerup',event=>finishPointer(event,false));
  svg.addEventListener('pointercancel',event=>finishPointer(event,true));
  svg.addEventListener('lostpointercapture',event=>{
    const pointerId=event.pointerId;
    const wasTouch=activePointers.delete(pointerId);
    if (state.drag?.pointerId===pointerId) {
      const interruptedDrag=state.drag;
      rollbackDrag(interruptedDrag);
    }
    if (panState?.pointerId===pointerId) panState=null;
    if (pendingTouchTap?.pointerId===pointerId) pendingTouchTap=null;
    if (gestureMode==='pinch') {
      pinchState=null;
      gestureMode=activePointers.size===1?'suspended':'idle';
    } else if (gestureMode==='suspended' && activePointers.size===0) gestureMode='idle';
    else if (gestureMode!=='pinch' && !state.drag && !panState && (!wasTouch || activePointers.size===0)) gestureMode='idle';
    if (!panState && gestureMode!=='pinch') svg.classList.remove('is-panning');
  });

  $('#zoomInBtn').onclick=()=>zoomAt(.8);
  $('#zoomOutBtn').onclick=()=>zoomAt(1.25);
  $('#zoomResetBtn').onclick=resetView;
  const boardResizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>adaptViewToViewport()):null;
  if(boardResizeObserver) boardResizeObserver.observe(svg.parentElement);
  else window.addEventListener('resize',adaptViewToViewport);
  adaptViewToViewport();
  applyView();
  svg.classList.add('pan-ready');
  document.addEventListener('keydown',e=>{if(e.code==='Space' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)){spacePressed=true;e.preventDefault();}});
  document.addEventListener('keyup',e=>{if(e.code==='Space')spacePressed=false;});
  window.addEventListener('blur',()=>{spacePressed=false;});

  document.querySelectorAll('.tool').forEach((button) => button.addEventListener('click', () => { setTool(button.dataset.tool); closeWorkspaceMenu(); }));

  function projectSnapshot() {
    return {
      format: 'GeoProofProject',
      version: 1,
      savedAt: new Date().toISOString(),
      task: clone(state.task),
      nextId: state.nextId,
      geometry: {
        points: clone(state.points), segments: clone(state.segments), circles: clone(state.circles),
        marks: clone(state.marks), constraints: clone(state.constraints), angles: clone(state.angles),
        angleMarks: clone(state.angleMarks), angleConstraints: clone(state.angleConstraints)
      },
      proof: { steps: clone(state.steps), contexts: clone(state.proofContexts), activeContextIds: clone(state.activeProofContextIds), caseGroups: clone(state.proofCaseGroups), existenceGroups: clone(state.proofExistenceGroups) }
    };
  }

  function validateProjectStructure(project) {
    if (!project || project.format !== 'GeoProofProject' || project.version !== 1 || !project.geometry) return 'Файл не является поддерживаемым проектом GeoProof.';
    const g=project.geometry;
    const arrays=['points','segments','circles','marks','constraints','angles','angleMarks','angleConstraints'];
    for (const key of arrays) if (!Array.isArray(g[key])) return `В файле отсутствует корректный список «${key}».`;
    if (!project.proof || !Array.isArray(project.proof.steps)) return 'В файле отсутствует список шагов доказательства.';
    if(project.proof.existenceGroups!==undefined&&!Array.isArray(project.proof.existenceGroups))return 'Список групп ∃E имеет некорректный формат.';
    const stepIds=new Set();
    for (const step of project.proof.steps) { if (!step || typeof step.claim!=='string' || typeof step.reason!=='string' || (step.isGoal!==undefined && typeof step.isGoal!=='boolean')) return 'Шаг доказательства имеет некорректную структуру.'; if (step.id) { if (stepIds.has(step.id)) return 'Повторяется идентификатор шага доказательства.'; stepIds.add(step.id); } }
    for (let i=0;i<project.proof.steps.length;i++) {
      const step=project.proof.steps[i];
      for (const ref of (step.references||[])) { const refIndex=project.proof.steps.findIndex(item=>item.id===ref); if (refIndex<0) return 'Шаг доказательства ссылается на отсутствующий шаг.'; if (refIndex>=i) return 'Шаг доказательства может ссылаться только на более ранние шаги.'; }
      if(step.formulaExpression) {
        const op=step.formulaExpression.op, sources=step.formulaExpression.sourceStepIds, quantified=['forall','exists'].includes(op),arity=(op==='not'||quantified)?1:2;
        if(!['and','or','implies','not','bottom','forall','exists'].includes(op)||!Array.isArray(sources)||sources.length!==arity||(quantified&&!validLogicalName(step.formulaExpression.variable))) return 'Логическая формула шага имеет некорректную структуру.';
        for(const ref of sources) { const sourceIndex=project.proof.steps.findIndex(item=>item.id===ref); if(sourceIndex<0) return 'Логическая формула ссылается на отсутствующий шаг.'; if(sourceIndex>=i) return 'Логическая формула может использовать только предыдущие шаги.'; }
      }
      if(step.formulaSourceLost!==undefined && typeof step.formulaSourceLost!=='boolean') return 'Признак потерянного источника логической формулы имеет неверный тип.';
      if(step.formulaSnapshot){
        const validTerm=(term,depth=0)=>!!term&&typeof term==='object'&&depth<=16&&(typeof term.kind==='string')&&(['variable','constant'].includes(term.kind)?(validLogicalName(term.name)||(term.kind==='constant'&&/^[0-9]+$/.test(term.name||''))):term.kind==='sum'?Array.isArray(term.terms)&&term.terms.every(item=>validTerm(item,depth+1)):typeof (term.id??term.name)==='string');
        const validFormula=(formula,depth=0)=>{if(depth>32||!formula||typeof formula!=='object')return false;if(formula.op==='atom'){const termsOk=Array.isArray(formula.terms)?formula.terms.every(term=>validTerm(term)):formula.terms===undefined&&formula.predicate==='text'&&typeof formula.text==='string';return typeof formula.predicate==='string'&&termsOk&&(formula.predicate!=='user_predicate'||validLogicalName(formula.text));}if(formula.op==='not')return Array.isArray(formula.args)&&formula.args.length===1&&validFormula(formula.args[0],depth+1);if(['and','or','implies'].includes(formula.op))return Array.isArray(formula.args)&&formula.args.length===2&&formula.args.every(item=>validFormula(item,depth+1));if(['forall','exists'].includes(formula.op))return validLogicalName(formula.variable)&&Array.isArray(formula.args)&&formula.args.length===1&&validFormula(formula.args[0],depth+1);if(formula.op==='bottom')return true;return false;};
        if(!validFormula(step.formulaSnapshot))return 'Снимок формулы содержит некорректную логическую структуру.';
      }
    }
    const contexts=Array.isArray(project.proof.contexts)?project.proof.contexts:[];
    const contextIds=new Set();
    for(const context of contexts){
      if(!context||typeof context.id!=='string'||!context.id||contextIds.has(context.id)||!Array.isArray(context.parentPath)||!['open','closed','case-closed'].includes(context.status))return 'Контекст поддоказательства имеет некорректную структуру.';
      contextIds.add(context.id);
      if(!project.proof.steps.some(step=>step.id===context.assumptionStepId&&step.isAssumption))return 'Контекст поддоказательства не содержит исходного предположения.';
      if(context.status==='closed'&&!project.proof.steps.some(step=>step.id===context.closedByStepId&&step.dischargedContextId===context.id))return 'Закрытый контекст не имеет шага, снимающего предположение.';
      if(context.status==='case-closed'&&(!context.caseGroupId||!context.consequentStepId))return 'Закрытый случай не содержит группу разбора или общее заключение.';
    }
    for(const context of contexts){
      if((context.parentPath||[]).some(id=>!contextIds.has(id)))return 'Внешний контекст поддоказательства не существует.';
      for(let depth=0;depth<(context.parentPath||[]).length;depth++){
        const parent=contexts.find(item=>item.id===context.parentPath[depth]);
        if(!parent||!sameArray(parent.parentPath,(context.parentPath||[]).slice(0,depth)))return 'Иерархия родительских поддоказательств повреждена.';
        if((parent.status==='closed'||parent.status==='case-closed')&&context.status==='open')return 'Открытое поддоказательство не может находиться внутри уже закрытого контекста.';
      }
    }
    const existenceGroups=Array.isArray(project.proof.existenceGroups)?project.proof.existenceGroups:[];
    const existenceGroupIds=new Set();
    for(const group of existenceGroups){
      if(!group||typeof group.id!=='string'||!group.id||existenceGroupIds.has(group.id)||!Array.isArray(group.parentPath)||typeof group.contextId!=='string'||typeof group.existentialStepId!=='string'||typeof group.assumptionStepId!=='string'||!validLogicalName(group.eigenparameter)||!['open','closed'].includes(group.status))return 'Группа устранения существования (∃E) имеет некорректную структуру.';
      existenceGroupIds.add(group.id);
      const existential=project.proof.steps.find(step=>step.id===group.existentialStepId),assumption=project.proof.steps.find(step=>step.id===group.assumptionStepId),context=contexts.find(item=>item.id===group.contextId);
      if(!existential||!(existential.formulaSnapshot?.op==='exists'||existential.formulaExpression?.op==='exists')||!assumption?.isAssumption||!context||context.existsElimGroupId!==group.id||context.assumptionStepId!==assumption.id||!sameArray(context.parentPath,group.parentPath))return 'Группа ∃E не согласована с исходной формулой, предположением или контекстом.';
      if(group.status==='open'&&(context.status!=='open'||group.consequentStepId!==null||group.resultStepId!==null))return 'Открытая группа ∃E не должна содержать закрывающий шаг.';
      if(group.status==='closed'){
        const result=project.proof.steps.find(step=>step.id===group.resultStepId),consequent=project.proof.steps.find(step=>step.id===group.consequentStepId);
        if(context.status!=='closed'||context.closingRuleId!=='logic_exists_elim'||context.closedByStepId!==group.resultStepId||context.consequentStepId!==group.consequentStepId||!result||result.basisRuleId!=='logic_exists_elim'||result.existenceEliminationGroupId!==group.id||result.dischargedContextId!==context.id||!consequent)return 'Закрытая группа ∃E не имеет корректного результата или снятого предположения.';
      }
    }
    const caseGroups=Array.isArray(project.proof.caseGroups)?project.proof.caseGroups:[];
    const caseGroupIds=new Set();
    for(const group of caseGroups){
      if(!group||typeof group.id!=='string'||!group.id||caseGroupIds.has(group.id)||!Array.isArray(group.parentPath)||!Array.isArray(group.caseContextIds)||group.caseContextIds.length!==2||!Array.isArray(group.caseAssumptionStepIds)||group.caseAssumptionStepIds.length!==2||!Array.isArray(group.caseConsequentStepIds)||group.caseConsequentStepIds.length!==2||!['first-open','second-open','closed'].includes(group.status))return 'Группа разбора по случаям имеет некорректную структуру.';
      caseGroupIds.add(group.id);
      const disjunctionStep=project.proof.steps.find(step=>step.id===group.disjunctionStepId);
      if(!disjunctionStep)return 'Группа разбора ссылается на отсутствующую дизъюнкцию.';
      const hasDisjunction=disjunctionStep.formulaSnapshot?.op==='or'||disjunctionStep.formulaExpression?.op==='or';
      if(!hasDisjunction)return 'Группа разбора должна ссылаться на формулу P ∨ Q.';
      const disjunctionPath=Array.isArray(disjunctionStep.contextPath)?disjunctionStep.contextPath:[];
      if(!pathIsPrefix(disjunctionPath,group.parentPath))return 'Исходная дизъюнкция недоступна во внешнем контексте разбора.';
      for(let caseIndex=0;caseIndex<2;caseIndex++){
        const contextId=group.caseContextIds[caseIndex],assumptionId=group.caseAssumptionStepIds[caseIndex],consequentId=group.caseConsequentStepIds[caseIndex];
        const shouldExist=group.status==='closed'||group.status==='second-open'||(group.status==='first-open'&&caseIndex===0);
        if(!shouldExist){if(contextId!==null||assumptionId!==null||consequentId!==null)return 'Не начатый случай не должен содержать частичные ссылки.';continue;}
        const context=contexts.find(item=>item.id===contextId),assumption=project.proof.steps.find(step=>step.id===assumptionId);
        if(!context||!assumption||context.caseGroupId!==group.id||context.caseIndex!==caseIndex||context.assumptionStepId!==assumption.id||!sameArray(context.parentPath,group.parentPath))return 'Контекст одного из случаев не согласован с группой разбора.';
        if(group.status==='closed'&&(context.status!=='case-closed'||context.consequentStepId!==consequentId||!consequentId))return 'Завершённая группа не содержит два закрытых случая.';
        if(group.status==='first-open'&&caseIndex===0&&(context.status!=='open'||consequentId!==null))return 'Первый случай должен оставаться открытым без выбранного заключения.';
        if(group.status==='second-open'&&caseIndex===0&&(context.status!=='case-closed'||!consequentId))return 'Перед вторым случаем первый должен быть закрыт с указанным заключением.';
        if(group.status==='second-open'&&caseIndex===1&&(context.status!=='open'||consequentId!==null))return 'Второй случай должен быть открыт без выбранного заключения.';
        if(consequentId&&!project.proof.steps.some(step=>step.id===consequentId))return 'Не найдено заключение одного из случаев.';
      }
      if(group.status!=='closed'&&group.resultStepId!==null)return 'Незавершённая группа не должна иметь итогового вывода.';
      if(group.status==='closed'){
        const result=project.proof.steps.find(step=>step.id===group.resultStepId);
        if(!result||result.basisRuleId!=='logic_or_elim'||result.caseEliminationGroupId!==group.id||!sameArray(proofPath(result),group.parentPath))return 'Завершённая группа не имеет корректного итогового вывода ∨E.';
      }
    }
    for(let i=0;i<project.proof.steps.length;i++){
      const step=project.proof.steps[i],path=Array.isArray(step.contextPath)?step.contextPath:[];
      if(path.some(id=>!contextIds.has(id)))return 'Шаг ссылается на неизвестную область действия поддоказательства.';
      for(let depth=0;depth<path.length;depth++){
        const context=contexts.find(item=>item.id===path[depth]);
        if(!context||!sameArray(context.parentPath,path.slice(0,depth)))return 'Вложенность контекстов поддоказательств нарушена.';
      }
      if(step.isAssumption){const ctx=contexts.find(item=>item.assumptionStepId===step.id);if(!ctx||!sameArray(path,[...(ctx.parentPath||[]),ctx.id])||step.basisType!=='assumption')return 'Предположение не согласовано с областью действия контекста.';}
      if(step.dischargedContextId&&!contexts.some(context=>context.id===step.dischargedContextId&&context.closedByStepId===step.id))return 'Шаг снятия предположения не связан с соответствующим контекстом.';
      const sourceIds=[...(step.references||[]),...(step.formulaExpression?.sourceStepIds||[])];
      for(const sourceId of sourceIds){
        const sourceIndex=project.proof.steps.findIndex(item=>item.id===sourceId);if(sourceIndex<0||sourceIndex>=i)continue;
        const source=project.proof.steps[sourceIndex],sourcePath=Array.isArray(source.contextPath)?source.contextPath:[];
        const discharged=['logic_implies_intro','logic_negation_intro','logic_raa','logic_exists_elim'].includes(step.basisRuleId)&&step.dischargedContextId&&(()=>{const ctx=contexts.find(item=>item.id===step.dischargedContextId);const sourcePath=Array.isArray(source.contextPath)?source.contextPath:[];return !!ctx&&(sourceId===ctx.assumptionStepId||sourceId===ctx.consequentStepId)&&sameArray(sourcePath,[...(ctx.parentPath||[]),ctx.id]);})();
        const caseDischarged=step.basisRuleId==='logic_or_elim'&&step.caseEliminationGroupId&&(()=>{const group=caseGroups.find(item=>item.id===step.caseEliminationGroupId);if(!group)return false;if(sourceId===group.disjunctionStepId)return sameArray(sourcePath,group.parentPath);const index=group.caseConsequentStepIds.indexOf(sourceId);if(index<0)return false;const context=contexts.find(item=>item.id===group.caseContextIds[index]);return !!context&&context.status==='case-closed'&&sameArray(sourcePath,[...group.parentPath,context.id]);})();
        if(!discharged&&!caseDischarged&&!pathIsPrefix(sourcePath,path))return 'Шаг использует утверждение за пределами области действия предположения.';
      }
    }
    const activeIds=Array.isArray(project.proof.activeContextIds)?project.proof.activeContextIds:[];
    for(let i=0;i<activeIds.length;i++){const ctx=contexts.find(item=>item.id===activeIds[i]);if(!ctx||ctx.status!=='open'||!sameArray(ctx.parentPath,activeIds.slice(0,i)))return 'Список открытых поддоказательств повреждён.';}
    if(contexts.some(context=>context.status==='open'&&!activeIds.includes(context.id)))return 'Существует открытое поддоказательство, отсутствующее в стеке активных контекстов.';
    for(const context of contexts){if(context.status==='closed'){const closing=project.proof.steps.find(step=>step.id===context.closedByStepId);if(!closing||!['logic_implies_intro','logic_negation_intro','logic_raa','logic_exists_elim'].includes(closing.basisRuleId)||closing.basisRuleId!==context.closingRuleId||!sameArray(proofPath(closing),context.parentPath||[]))return 'Шаг закрытия поддоказательства не согласован с внешним контекстом.';}if(context.status==='case-closed'&&!caseGroups.some(group=>group.id===context.caseGroupId&&group.caseContextIds.includes(context.id)&&['second-open','closed'].includes(group.status)))return 'Закрытый случай не связан с активной или завершённой группой разбора.';}
    const ids=new Set();
    for (const item of [...g.points,...g.segments,...g.circles,...g.marks,...g.constraints,...g.angles,...g.angleMarks,...g.angleConstraints]) {
      if (!item || typeof item.id!=='string' || !item.id) return 'Обнаружен объект без корректного идентификатора.';
      if (ids.has(item.id)) return `Повторяется идентификатор объекта ${item.id}.`;
      ids.add(item.id);
    }
    const pointIds=new Set(g.points.map(p=>p.id));
    const segmentIds=new Set(g.segments.map(x=>x.id));
    const circleIds=new Set(g.circles.map(x=>x.id));
    const hasPoints=(list)=>list.every(pid=>typeof pid==='string'&&pointIds.has(pid));
    for (const seg of g.segments) if (!hasPoints([seg.a,seg.b])) return 'Отрезок ссылается на отсутствующую точку.';
    for (const circle of g.circles) {
      const radiusPointId = circle.radiusPointId || circle.rimId || null;
      if (!pointIds.has(circle.centerId)) return 'Окружность ссылается на отсутствующий центр.';
      if (radiusPointId && !pointIds.has(radiusPointId)) return 'Окружность ссылается на отсутствующую радиусную точку.';
      if (radiusPointId === circle.centerId) return 'Центр окружности не может одновременно быть её радиусной опорной точкой.';
      if (!radiusPointId && (!Number.isFinite(Number(circle.radius)) || Number(circle.radius) <= 0)) return 'Окружность содержит некорректный радиус.';
    }
    const pointKinds=new Set(['free','midpoint','onSegment','onCircle','intersection','curveIntersection','projection','angleBisector','constraintEndpoint','angleConstraintEndpoint','constrainedPoint']);
    for (const point of g.points) {
      if (!pointKinds.has(point.kind)) return `У точки ${point.name||''} неизвестный тип построения.`;
      if (['midpoint','onSegment'].includes(point.kind) && !segmentIds.has(point.segmentId)) return `Точка ${point.name||''} ссылается на отсутствующий отрезок.`;
      if (point.kind==='onCircle' && !circleIds.has(point.circleId)) return `Точка ${point.name||''} ссылается на отсутствующую окружность.`;
      if (point.kind==='constrainedPoint') {
        if (!Array.isArray(point.lineAttachments)||point.lineAttachments.length<1) return `Точка ${point.name||''} не содержит линейных связей.`;
        const seenAttachments=new Set();
        for (const attachment of point.lineAttachments) {
          if (!attachment||!segmentIds.has(attachment.segmentId)||!Number.isFinite(Number(attachment.t))) return `Точка ${point.name||''} содержит некорректную линейную связь.`;
          if (seenAttachments.has(attachment.segmentId)) return `Точка ${point.name||''} дважды привязана к одному отрезку.`;
          seenAttachments.add(attachment.segmentId);
        }
        if (point.previousConstruction && (!point.previousConstruction.kind || !pointKinds.has(point.previousConstruction.kind) || point.previousConstruction.kind==='constrainedPoint')) return `Точка ${point.name||''} содержит некорректное исходное построение.`;
      }
      if (point.kind==='constraintEndpoint' && !g.constraints.some(c=>c.id===point.constraintId)) return 'Зависимая точка ссылается на отсутствующее ограничение отрезков.';
      if (point.kind==='angleConstraintEndpoint' && !g.angleConstraints.some(c=>c.id===point.angleConstraintId)) return 'Зависимая точка ссылается на отсутствующее ограничение углов.';
      if (point.kind==='projection' && (!pointIds.has(point.sourcePointId)||!segmentIds.has(point.segmentId))) return 'Основание высоты ссылается на отсутствующую точку или отрезок.';
      if (point.kind==='angleBisector' && !hasPoints([point.aId,point.vertexId,point.cId])) return 'Точка биссектрисы ссылается на отсутствующую точку.';
      if (point.kind==='intersection' && (!segmentIds.has(point.segment1Id)||!segmentIds.has(point.segment2Id))) return 'Точка пересечения ссылается на отсутствующий отрезок.';
      if (point.kind==='curveIntersection') {
        const valid=(kind,ref)=>kind==='segment'?segmentIds.has(ref):kind==='circle'?circleIds.has(ref):false;
        if (!valid(point.parent1Kind,point.parent1Id)||!valid(point.parent2Kind,point.parent2Id)) return 'Точка пересечения ссылается на отсутствующий объект.';
      }
    }
    for (const c of g.constraints) {
      if (!segmentIds.has(c.sourceSegmentId)||!segmentIds.has(c.targetSegmentId)||!pointIds.has(c.targetPointId)) return 'Ограничение отрезков ссылается на отсутствующий объект.';
      const targetPoint=g.points.find(point=>point.id===c.targetPointId);
      if (!targetPoint || targetPoint.kind!=='constraintEndpoint' || targetPoint.constraintId!==c.id) return 'Зависимый конец отрезка не согласован с ограничением.';
    }
    for (const c of g.angleConstraints) {
      if (!c.sourceAngle||!c.targetAngle||!hasPoints([c.sourceAngle.aId,c.sourceAngle.vertexId,c.sourceAngle.cId,c.targetAngle.aId,c.targetAngle.vertexId,c.targetAngle.cId,c.targetPointId])) return 'Ограничение углов ссылается на отсутствующую точку.';
      const targetPoint=g.points.find(point=>point.id===c.targetPointId);
      if (!targetPoint || targetPoint.kind!=='angleConstraintEndpoint' || targetPoint.angleConstraintId!==c.id || c.targetAngle.cId!==c.targetPointId) return 'Зависимый луч не согласован с ограничением равенства углов.';
    }
    for (const mark of g.marks) if (!Array.isArray(mark.segmentIds) || mark.segmentIds.some(sid=>!segmentIds.has(sid))) return 'Отметка равенства ссылается на отсутствующий отрезок.';
    for (const mark of g.angleMarks) if (!Array.isArray(mark.angles) || mark.angles.some(a=>!a||!hasPoints([a.aId,a.vertexId,a.cId]))) return 'Отметка равенства углов ссылается на отсутствующую точку.';
    for (const angle of g.angles) if (!hasPoints([angle.aId,angle.vertexId,angle.cId])) return 'Угол ссылается на отсутствующую точку.';
    return null;
  }

  function saveProject() {
    const payload=JSON.stringify(projectSnapshot(),null,2);
    const blob=new Blob([payload],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url; link.download='geoproof-project.geoproof.json';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    $('#saveProjectBtn').textContent='Сохранено';
    setTimeout(()=>$('#saveProjectBtn').textContent='Сохранить проект',1200);
  }

  function applyProject(project) {
    const structuralError=validateProjectStructure(project);
    if (structuralError) throw new Error(structuralError);
    const g=project.geometry;
    const previous={points:state.points,segments:state.segments,circles:state.circles,marks:state.marks,constraints:state.constraints,angles:state.angles,angleMarks:state.angleMarks,angleConstraints:state.angleConstraints,steps:state.steps,proofContexts:state.proofContexts,activeProofContextIds:state.activeProofContextIds,proofCaseGroups:state.proofCaseGroups,proofExistenceGroups:state.proofExistenceGroups,task:state.task,nextId:state.nextId};
    pushHistory();
    state.points=clone(g.points); state.segments=clone(g.segments); state.circles=clone(g.circles).map(normalizeCircle);
    state.marks=clone(g.marks); state.constraints=clone(g.constraints); state.angles=clone(g.angles);
    state.angleMarks=clone(g.angleMarks); state.angleConstraints=clone(g.angleConstraints);
    state.steps=clone(project.proof.steps); state.steps.forEach((step,i)=>{ if(!step.id) step.id=`legacy-step-${i+1}`; if(!step.basisType) step.basisType='condition'; if(!Array.isArray(step.references)) step.references=[]; if(!Array.isArray(step.contextPath))step.contextPath=[]; }); state.proofContexts=clone(project.proof.contexts||[]);state.activeProofContextIds=clone(project.proof.activeContextIds||[]);state.proofCaseGroups=clone(project.proof.caseGroups||[]);state.proofExistenceGroups=clone(project.proof.existenceGroups||[]);state.creatingAssumption=false; state.task=clone(project.task||null);
    state.nextId=Math.max(Number(project.nextId)||1,1);
    state.pending=[]; state.pendingMode=null; state.selected=null; state.drag=null;
    syncAllSegmentSubdivisions();
    if (modelDependencyCycles().length) {
      Object.assign(state,previous);
      throw new Error('Проект содержит циклические зависимости. Загрузка отменена, текущий чертёж сохранён.');
    }
    const maxNumericId=Math.max(0,...[...state.points,...state.segments,...state.circles,...state.constraints,...state.angleConstraints].map(item=>Number(String(item.id).replace(/^g/,''))||0));
    state.nextId=Math.max(state.nextId,maxNumericId+1);
    renderAll(); setTool('select');
    $('#toolHelp').textContent='Проект загружен. Проверь список объектов и состояние геометрической модели.';
  }

  $('#saveProjectBtn').addEventListener('click',saveProject);
  $('#openProjectBtn').addEventListener('click',()=>$('#projectFileInput').click());
  $('#projectFileInput').addEventListener('change',async event=>{
    const file=event.target.files?.[0]; if (!file) return;
    try {
      const project=JSON.parse(await file.text());
      applyProject(project);
    } catch(error) {
      alert(`Не удалось открыть проект: ${error.message||'неизвестная ошибка'}`);
    } finally { event.target.value=''; }
  });

  function resetBoard() {
    clearGestureState();
    state.points = []; state.segments = []; state.circles = []; state.marks = []; state.constraints = []; state.angles = []; state.angleMarks = []; state.angleConstraints = [];
    state.selected = null; selectedGroup = null; state.pending = []; state.pendingMode = null; state.task = null; state.nextId = 1;
    renderAll();
  }

  $('#clearBoardBtn').onclick = () => {
    if (!state.points.length && !state.segments.length && !state.constraints.length) return;
    pushHistory(); resetBoard();
  };
  $('#undoBtn').onclick = restoreHistory;
  $('#redoBtn').onclick = redoHistory;

  $('#exampleBtn').onclick = () => {
    pushHistory(); resetBoard();
    const A = addPoint(500, 115); const B = addPoint(270, 500); const C = addPoint(730, 500);
    const bc = addSegment(B, C);
    addSegment(A, B); addSegment(A, C);
    addPoint(0, 0, 'midpoint', bc.id);
    const midpoint = state.points[state.points.length - 1];
    addSegment(A, midpoint);
    const BM = addSegment(B, midpoint); const MC = addSegment(midpoint, C);
    state.marks.push({ id: id(), segmentIds: [BM.id, MC.id], ticks: 1 });
    state.task = {
      text: 'В треугольнике ABC отрезок AM — медиана. Докажите, что площади треугольников ABM и ACM равны.',
      goal: 'Area(ABM) = Area(ACM)'
    };
    setTool('select'); state.selected = null; renderAll();
  };

  function openTaskEditor() {
    $('#taskTextInput').value = state.task?.text || '';
    $('#taskGoalInput').value = state.task?.goal || '';
    $('#taskModal').style.display = 'flex';
    $('#taskTextInput').focus();
  }
  $('#editTaskBtn').onclick = openTaskEditor;
  $('#cancelTask').onclick = () => { $('#taskModal').style.display = 'none'; };
  $('#saveTask').onclick = () => {
    const text = $('#taskTextInput').value.trim();
    const goal = $('#taskGoalInput').value.trim();
    if (!text && !goal) {
      alert('Заполни условие задачи или цель.');
      return;
    }
    pushHistory();
    state.task = { text, goal };
    $('#taskModal').style.display = 'none';
    renderAll();
  };

  $('#assertionType').addEventListener('change',()=>renderAssertionBuilder());
  $('#stepReferenceSearch').addEventListener('input',()=>{
    const query=$('#stepReferenceSearch').value.trim().toLocaleLowerCase('ru');
    $('#stepReferences').querySelectorAll('.reference-option').forEach(option=>{option.style.display=option.textContent.toLocaleLowerCase('ru').includes(query)?'':'none';});
  });
  $('#assertionSearch').addEventListener('input',()=>{const selected=$('#assertionType').value;renderAssertionTypeCatalog(selected);renderAssertionBuilder();});
  $('#basisType').addEventListener('change',()=>renderBasisRuleSelector(''));
  $('#basisRule').addEventListener('change',updateBasisRuleInfo);
  $('#basisRuleSearch').addEventListener('input',()=>renderBasisRuleSelector($('#basisRule').value));
  $('#proofLibrarySearch').addEventListener('input',renderProofLibrary);
  renderProofExamples();
  setProofTab('work');
  $('#addStepBtn').onclick = () => openStepEditor();
  $('#beginSubproofBtn').onclick=openAssumptionEditor;
  $('#beginCasesBtn').onclick=openDisjunctionCasesModal;
  $('#beginExistsElimBtn').onclick=openExistsElimStartModal;
  $('#cancelOrElimStart').onclick=()=>$('#orElimStartModal').style.display='none';
  $('#confirmOrElimStart').onclick=startDisjunctionCases;
  $('#cancelExistsElimStart').onclick=()=>$('#existsElimStartModal').style.display='none';
  $('#confirmExistsElimStart').onclick=startExistsElimination;
  $('#confirmCaseConclusion').onclick=()=>closeCurrentSubproof('case');
  $('#closeSubproofBtn').onclick=openCloseSubproofModal;
  $('#cancelSubproof').onclick=()=>$('#subproofModal').style.display='none';
  $('#confirmSubproof').onclick=()=>closeCurrentSubproof('implies');
  $('#confirmNegationSubproof').onclick=()=>closeCurrentSubproof('negation');
  $('#confirmRAASubproof').onclick=()=>closeCurrentSubproof('raa');
  $('#confirmExistsSubproof').onclick=()=>closeCurrentSubproof('exists');
  $('#cancelStep').onclick = () => { $('#stepModal').style.display = 'none'; state.editingStepId=null;state.creatingAssumption=false;$('#basisType').disabled=false;$('#basisRule').disabled=false;$('#claimInput').placeholder='Например: AB = AC'; };
  $('#saveStep').onclick = () => {
    const isAssumption=!!state.creatingAssumption;
    const parentContextPath=[...state.activeProofContextIds];
    const structured = currentStructuredAssertion();
    const isLogicExpression=structured?.type==='logic';
    const assertion=isLogicExpression?null:structured;
    const formulaExpression=isLogicExpression?structured.formulaExpression:null;
    const formulaSnapshot=isLogicExpression?structured.formulaSnapshot:null;
    const claim = (structured?.claim || $('#claimInput').value).trim(); const reason = $('#reasonInput').value.trim();
    if ($('#assertionType').value !== 'text' && !structured) { alert('Выбери все необходимые объекты или исходные высказывания.'); return; }
    if (!claim || !reason) { alert('Заполни утверждение и обоснование.'); return; }
    let references = [...$('#stepReferences').querySelectorAll('input:checked')].map(input=>input.value);
    let basisType=isAssumption?'assumption':$('#basisType').value, basisRuleId=isAssumption?null:($('#basisRule').value || null);
    if(!isAssumption&&basisType==='assumption'){alert('Временное предположение можно создать только кнопкой «Начать поддоказательство».');return;}
    if(basisRuleId==='logic_and_intro' && formulaExpression?.op==='and') references=[...formulaExpression.sourceStepIds];
    if(basisRuleId==='logic_contradiction_intro' && formulaExpression?.op==='bottom') references=[...formulaExpression.sourceStepIds];
    if(basisRuleId==='logic_or_intro_left' && formulaExpression?.op==='or' && formulaExpression.sourceStepIds[0]) references=[formulaExpression.sourceStepIds[0]];
    if(basisRuleId==='logic_or_intro_right' && formulaExpression?.op==='or' && formulaExpression.sourceStepIds[1]) references=[formulaExpression.sourceStepIds[1]];
    if(basisRuleId==='logic_forall_intro' && formulaExpression?.op==='forall') references=[...(formulaExpression.sourceStepIds||[])];
    const currentIndex=state.editingStepId?state.steps.findIndex(item=>item.id===state.editingStepId):state.steps.length;
    const targetPath=state.editingStepId?proofPath(state.steps[currentIndex]):(isAssumption?[...parentContextPath,'__new_context__']:parentContextPath);
    const validSource=ref=>{const source=state.steps.find(item=>item.id===ref);return !!source&&state.steps.indexOf(source)<currentIndex&&proofStepVisibleInContext(source,targetPath);};
    if(references.some(ref=>!validSource(ref)) || (formulaExpression?.sourceStepIds||[]).some(ref=>!validSource(ref))) { alert('Шаг может использовать только предыдущие утверждения, доступные в текущей области действия предположений.'); return; }
    pushHistory();
    if ($('#isGoalInput').checked) state.steps.forEach(item=>{ if(item.id!==state.editingStepId) item.isGoal=false; });
    const data={claim,reason,basisType,basisRuleId,references,isGoal:$('#isGoalInput').checked,
      assertion:assertion?{type:assertion.type,objects:assertion.objects,objectKinds:assertion.objectKinds||null}:null,
      formulaExpression:formulaExpression?clone(formulaExpression):null, formulaSnapshot:formulaSnapshot?clone(formulaSnapshot):null, formulaSourceLost:false,
      contextPath:state.editingStepId?[...proofPath(state.steps[currentIndex])]:[...parentContextPath], isAssumption:!!(state.editingStepId&&state.steps[currentIndex]?.isAssumption)};
    if (state.editingStepId) {
      const step=state.steps.find(item=>item.id===state.editingStepId);
      if (step) Object.assign(step,data);
    } else {
      const stepId=`proof-${Date.now()}-${state.steps.length+1}`;
      if(isAssumption){
        const contextId=`subproof-${Date.now()}-${state.proofContexts.length+1}`;
        data.contextPath=[...parentContextPath,contextId];data.isAssumption=true;data.assumptionContextId=contextId;data.isGoal=false;
        state.steps.push({id:stepId,...data});
        state.proofContexts.push({id:contextId,label:`Предположение ${state.proofContexts.length+1}`,parentPath:parentContextPath,assumptionStepId:stepId,status:'open',consequentStepId:null,closedByStepId:null});
        state.activeProofContextIds=[...parentContextPath,contextId];
      } else state.steps.push({id:stepId,...data});
    }
    state.creatingAssumption=false;$('#basisType').disabled=false;$('#basisRule').disabled=false;$('#claimInput').placeholder='Например: AB = AC';
    state.editingStepId=null; $('#stepModal').style.display = 'none'; renderProof();
  };
  $('#clearStepsBtn').onclick = () => { if(!state.steps.length)return; pushHistory(); state.steps = [];state.proofContexts=[];state.activeProofContextIds=[];state.proofCaseGroups=[];state.proofExistenceGroups=[];state.creatingAssumption=false; renderProof(); };
  $('#toggleGraphBtn').onclick=()=>{const graph=$('#proofGraph');graph.hidden=!graph.hidden;$('#toggleGraphBtn').textContent=graph.hidden?'Показать граф':'Скрыть граф';};
  $('#presentProofBtn').onclick=startPresentation;
  $('#closePresentation').onclick=()=>$('#proofPresentation').classList.remove('active');
  $('#presentationPrev').onclick=()=>{presentationIndex=Math.max(-1,presentationIndex-1);renderPresentation();};
  $('#presentationNext').onclick=()=>{if(presentationIndex>=state.steps.length-1){$('#proofPresentation').classList.remove('active');return;}presentationIndex++;renderPresentation();};
  document.addEventListener('keydown',event=>{if(!$('#proofPresentation').classList.contains('active'))return;if(event.key==='ArrowRight')$('#presentationNext').click();if(event.key==='ArrowLeft')$('#presentationPrev').click();});

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea'); textarea.value = text; document.body.append(textarea);
    textarea.select();
    try { document.execCommand('copy'); $('#copyProofBtn').textContent = 'Скопировано'; }
    catch (_) { $('#copyProofBtn').textContent = 'Не удалось скопировать'; }
    textarea.remove();
  }

  function proofText() {
    const lines = [state.task?.text || 'Условие задачи не задано.', `Цель: ${state.task?.goal || 'не задана'}`, ''];
    state.steps.forEach((step, index) => {
      const refs = (step.references || []).map(ref => state.steps.findIndex(item => item.id === ref) + 1).filter(n => n > 0);
      lines.push(`${'  '.repeat(proofPath(step).length)}${index + 1}. ${step.isAssumption?'[ПРЕДПОЛОЖЕНИЕ] ':''}${step.claim}${step.isGoal?' [ЦЕЛЕВОЕ УТВЕРЖДЕНИЕ]':''}`);
      lines.push(`   Формальная запись: ${displayFormulaForStep(step.id)}`);
      const audit=auditProofStep(step,index); if(audit) lines.push(`   Структурная проверка: ${audit.label} — ${audit.detail}`);
      lines.push(`   Основание: ${basisLabels[step.basisType] || 'не указано'}`);
      if(step.basisRuleId) { const item=proofRuleById(step.basisRuleId); lines.push(`   Правило: ${item?.label || step.basisRuleId}`); if(item) { lines.push(`   Предпосылки правила: ${item.conditions}`); lines.push(`   Содержание вывода: ${item.conclusion}`); if(item.sourceLabel) lines.push(`   Источник формулировки: ${item.sourceLabel}`); } }
      lines.push(`   Обоснование: ${step.reason}`);
      if (refs.length) lines.push(`   Использует шаги: ${refs.join(', ')}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  function openProofPrintView() {
    const popup = window.open('', '_blank');
    if (!popup) { alert('Браузер заблокировал новое окно. Разреши всплывающие окна для GeoProof.'); return; }
    const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const refsFor = step => (step.references || []).map(ref => state.steps.findIndex(item => item.id === ref) + 1).filter(n => n > 0);
    const steps = state.steps.map((step, index) => { const item=proofRuleById(step.basisRuleId), audit=auditProofStep(step,index); return `<article class="step" style="margin-left:${proofPath(step).length*18}px"><div class="number">${index+1}</div><div><div class="claim">${step.isAssumption?'[ВРЕМЕННОЕ ПРЕДПОЛОЖЕНИЕ] ':''}${step.dischargedContextId?'[ЗАКРЫТИЕ ПОДДОКАЗАТЕЛЬСТВА] ':''}${esc(step.claim)}${step.isGoal?' <span class="goal-label">ЦЕЛЬ</span>':''}</div><div class="meta"><b>${esc(basisLabels[step.basisType] || 'Основание не указано')}</b>${item?` · ${esc(item.label)}`:''}</div><div class="refs"><b>Формальная запись:</b> ${esc(displayFormulaForStep(step.id))}</div>${item?`<div class="refs"><b>Условия правила:</b> ${esc(item.conditions)}<br><b>Вывод правила:</b> ${esc(item.conclusion)}</div>`:''}<p>${esc(step.reason)}</p>${audit?`<div class="refs"><b>Структурная проверка:</b> ${esc(audit.label)} — ${esc(audit.detail)}</div>`:''}${refsFor(step).length ? `<div class="refs">Опирается на шаги: ${refsFor(step).join(', ')}</div>` : ''}</div></article>`; }).join('');
    popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Доказательство — GeoProof</title><link rel="stylesheet" href="${new URL('styles.css', window.location.href).href}"></head><body class="gp-print-page"><div class="actions"><button onclick="window.print()">Печать / сохранить в PDF</button></div><h1>Доказательство</h1><div class="subtitle">Подготовлено в GeoProof · ${new Date().toLocaleDateString('ru-RU')}</div><div class="task"><b>Условие задачи</b><div>${esc(state.task?.text || 'Не задано')}</div><div class="goal"><b>Цель:</b> ${esc(state.task?.goal || 'Не задана')}</div></div><h2>Ход доказательства</h2>${steps || '<div class="empty">Шаги доказательства пока не добавлены.</div>'}<p class="subtitle">Документ отражает введённые пользователем утверждения и обоснования. Он не является автоматической проверкой математической корректности.</p></body></html>`);
    popup.document.close();
  }

  $('#copyProofBtn').onclick = () => {
    const text = proofText();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => { $('#copyProofBtn').textContent = 'Скопировано'; setTimeout(() => { $('#copyProofBtn').textContent = 'Скопировать доказательство'; }, 1200); })
        .catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  };
  $('#printProofBtn').onclick = openProofPrintView;
  const workspaceMenu=$('#workspaceMenu');
  let workspaceMode='geometry';
  function setWorkspaceMode(mode){
    workspaceMode=mode==='proof'?'proof':'geometry';
    document.querySelectorAll('[data-workspace-mode]').forEach(button=>{
      const active=button.dataset.workspaceMode===workspaceMode;
      button.classList.toggle('active',active);
      button.setAttribute('aria-selected',active?'true':'false');
    });
    document.querySelectorAll('[data-workspace-pane]').forEach(pane=>{
      pane.hidden=pane.dataset.workspacePane!==workspaceMode;
    });
    workspaceMenu.scrollTop=0;
  }
  document.querySelectorAll('[data-workspace-mode]').forEach(button=>button.addEventListener('click',()=>setWorkspaceMode(button.dataset.workspaceMode)));
  setWorkspaceMode('geometry');

  const proofFocusButton=$('#proofFocusBtn');
  function setProofFocus(enabled){
    document.body.classList.toggle('proof-focus',!!enabled);
    if(enabled){setWorkspaceMode('proof');openWorkspaceMenu();proofFocusButton?.setAttribute('aria-pressed','true');if(proofFocusButton)proofFocusButton.textContent='⤢ Вернуться к доске';}
    else{document.body.classList.remove('proof-focus');proofFocusButton?.setAttribute('aria-pressed','false');if(proofFocusButton)proofFocusButton.textContent='⛶ Полный экран';closeWorkspaceMenu(false);}
  }
  proofFocusButton?.addEventListener('click',()=>setProofFocus(!document.body.classList.contains('proof-focus')));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('proof-focus'))setProofFocus(false);});
  if(new URLSearchParams(location.search).get('workspace')==='proof')setTimeout(()=>setProofFocus(true),0);

  const menuBackdrop=$('#menuBackdrop');
  const openMenuButton=$('#openMenuBtn');
  function openWorkspaceMenu(){
    document.body.classList.add('menu-open');
    workspaceMenu.setAttribute('aria-hidden','false');
    workspaceMenu.inert=false;
    menuBackdrop.hidden=false;
    openMenuButton.setAttribute('aria-expanded','true');
    $('#closeMenuBtn').focus();
  }
  function closeWorkspaceMenu(returnFocus=true){
    document.body.classList.remove('menu-open');
    workspaceMenu.setAttribute('aria-hidden','true');
    workspaceMenu.inert=true;
    menuBackdrop.hidden=true;
    openMenuButton.setAttribute('aria-expanded','false');
    if(returnFocus) openMenuButton.focus();
  }
  openMenuButton.onclick=()=>document.body.classList.contains('menu-open')?closeWorkspaceMenu(false):openWorkspaceMenu();
  $('#closeMenuBtn').onclick=()=>closeWorkspaceMenu();
  menuBackdrop.addEventListener('click',()=>closeWorkspaceMenu());

  const docsPanel=$('#documentation');
  function openDocs(){closeWorkspaceMenu(false);docsPanel.classList.add('docs-open');docsPanel.setAttribute('aria-hidden','false');$('#closeDocsBtn').focus();}
  function closeDocs(){docsPanel.classList.remove('docs-open');docsPanel.setAttribute('aria-hidden','true');$('#openDocsBtn').focus();}
  $('#openDocsBtn').onclick=openDocs; $('#closeDocsBtn').onclick=closeDocs;

  $('#stepModal').addEventListener('click', (event) => { if (event.target === $('#stepModal')) {$('#stepModal').style.display = 'none';state.creatingAssumption=false;$('#basisType').disabled=false;$('#basisRule').disabled=false;$('#claimInput').placeholder='Например: AB = AC';} });
  $('#taskModal').addEventListener('click', (event) => { if (event.target === $('#taskModal')) $('#taskModal').style.display = 'none'; });
  $('#subproofModal').addEventListener('click',(event)=>{if(event.target===$('#subproofModal'))$('#subproofModal').style.display='none';});
  $('#orElimStartModal').addEventListener('click',(event)=>{if(event.target===$('#orElimStartModal'))$('#orElimStartModal').style.display='none';});
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if(docsPanel.classList.contains('docs-open')) closeDocs();
      if(document.body.classList.contains('menu-open')) closeWorkspaceMenu();
      $('#stepModal').style.display = 'none';
      $('#taskModal').style.display = 'none';
      $('#subproofModal').style.display = 'none';
      if($('#stepModal').style.display==='flex'&&state.creatingAssumption){state.creatingAssumption=false;$('#basisType').disabled=false;$('#basisRule').disabled=false;$('#claimInput').placeholder='Например: AB = AC';}
      if (state.pending.length) {
        state.pending = []; state.pendingMode = null; state.selected = null;
        $('#toolHelp').textContent = 'Действие отменено. ' + help[state.tool];
        renderGeometry(); renderObjects();
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redoHistory(); else restoreHistory(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoHistory(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
  });

  renderAll();
  $('#toolHelp').textContent = help[state.tool];
})();
