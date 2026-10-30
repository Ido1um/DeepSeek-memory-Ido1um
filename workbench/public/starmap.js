// 记忆星图 · 3D 关系图（零依赖，纯 canvas 2D 手写投影）
// 只读投影：节点/边全部来自 /api/state 的 graph 字段，不写任何库。
(function () {
  const PAL = {
    hard: '#7fe3c3', long: '#7fb4ff', general: '#e2c886', temp: '#9aa2ad',
    person: '#ffa06a', topic: '#a7c0d4', date: '#c9a7ff',
  };
  const V = {
    nodes: [], links: [], byId: new Map(),
    yaw: 0.25, pitch: -0.18, zoom: 1, auto: true, idleAt: 0,
    hover: null, sel: null, filter: 'all', raf: 0, w: 0, h: 0, dpr: 1,
    stars: null, drag: null,
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function seed(g, keepPos) {
    const prev = keepPos ? V.byId : new Map();
    const nodes = ((g && g.nodes) || []).map((n, i) => {
      const p = prev.get(n.id);
      // 斐波那契球面撒点，避免所有点从同一处出发
      const k = i + 0.5;
      const phi = Math.acos(1 - 2 * k / Math.max(1, ((g && g.nodes) || []).length));
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const r = 120 + 40 * Math.cbrt(k);
      return {
        ...n,
        x: p ? p.x : r * Math.sin(phi) * Math.cos(theta),
        y: p ? p.y : r * Math.cos(phi) * 0.82,
        z: p ? p.z : r * Math.sin(phi) * Math.sin(theta),
        vx: 0, vy: 0, vz: 0,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = ((g && g.links) || []).filter((l) => byId.has(l.a) && byId.has(l.b));
    for (const n of nodes) n.deg = 0;
    for (const l of links) { byId.get(l.a).deg++; byId.get(l.b).deg++; }
    V.nodes = nodes; V.links = links; V.byId = byId;
    return nodes.length;
  }

  function step() {
    const N = V.nodes;
    const L = 128, K = 5200, G = 0.0012;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = K / d2;
        a.vx -= dx / d * f; a.vy -= dy / d * f; a.vz -= dz / d * f;
        b.vx += dx / d * f; b.vy += dy / d * f; b.vz += dz / d * f;
      }
    }
    for (const l of V.links) {
      const a = V.byId.get(l.a), b = V.byId.get(l.b);
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - L) * 0.01;
      a.vx += dx / d * f; a.vy += dy / d * f; a.vz += dz / d * f;
      b.vx -= dx / d * f; b.vy -= dy / d * f; b.vz -= dz / d * f;
    }
    for (const n of N) {
      n.vx -= n.x * G; n.vy -= n.y * G; n.vz -= n.z * G;
      n.vx *= 0.87; n.vy *= 0.87; n.vz *= 0.87;
      n.x += clamp(n.vx, -14, 14); n.y += clamp(n.vy, -14, 14); n.z += clamp(n.vz, -14, 14);
      const R = sphereR();
      // 截止日只有一条引力线，容易被吸进最深处 → 钉在外圈薄壳上，保证看得见
      if (n.type === 'date') {
        const rr = Math.hypot(n.x, n.y) || 1;
        n.x = (n.x / rr) * (R * 0.86); n.y = (n.y / rr) * (R * 0.86); n.z *= 0.1;
      }
      const d = Math.hypot(n.x, n.y, n.z);
      if (d > R) { const s = R / d; n.x *= s; n.y *= s; n.z *= s; }
    }
  }

  function viewK() { const m = Math.min(V.w || 900, V.h || 560); return Math.max(0.6, Math.min(2.4, m / 620)); }
  // 球半径要除以缩放系数，否则大屏上投影后会跑出画布
  function sphereR() { const m = Math.min(V.w || 900, V.h || 560); return Math.max(160, Math.min(900, (m * 0.46) / viewK())); }

  function relayout() { seed(window.__WB_STAR_GRAPH__, false); for (let i = 0; i < 260; i++) step(); }

  function project(n) {
    const cy = Math.cos(V.yaw), sy = Math.sin(V.yaw);
    const cp = Math.cos(V.pitch), sp = Math.sin(V.pitch);
    let x = n.x * cy - n.z * sy;
    let z = n.x * sy + n.z * cy;
    let y = n.y * cp - z * sp;
    z = n.y * sp + z * cp;
    const f = 900;
    // 整体缩放跟着窗口走：760 高时为 1.0，1440p 约 1.8 —— 星图真的随窗口放大
    const k = viewK();
    const s = (f / Math.max(120, f + z)) * V.zoom * k * 0.94;
    return { sx: x * s, sy: y * s, s, z };
  }

  function depthAlpha(s) { return clamp((s - 0.55) / 0.9, 0.16, 1); }

  // 背景星点：按当前画布尺寸生成（1:1 绘制，不拉伸），窗口变了就重做
  let STAR_CACHE = { key: '', cv: null };
  function starLayer(w, h, dpr) {
    const key = w + 'x' + h + 'x' + dpr;
    if (STAR_CACHE.key === key) return STAR_CACHE.cv;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    let s = 20261030;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const count = Math.min(3200, Math.round((w * h) / 1100));
    for (let i = 0; i < count; i++) {
      const bright = rnd();
      const r = bright > 0.94 ? 1.5 + rnd() * 0.6 : bright > 0.72 ? 0.9 + rnd() * 0.4 : 0.35 + rnd() * 0.4;
      g.globalAlpha = bright > 0.94 ? 0.75 + rnd() * 0.25 : 0.12 + bright * 0.6;
      g.fillStyle = bright > 0.985 ? '#ffe6c9' : bright > 0.9 ? '#cfe3ff' : '#ffffff';
      g.beginPath(); g.arc(rnd() * w, rnd() * h, r, 0, 7); g.fill();
      if (bright > 0.97) { // 极少数亮星带一点点光晕
        g.globalAlpha = 0.16;
        g.beginPath(); g.arc(g.__x || 0, 0, 0, 0, 7); g.fill();
      }
    }
    g.globalAlpha = 1;
    STAR_CACHE = { key, cv: c };
    return c;
  }

  const LAYER = new Map();
  // 按 w/h/dpr 缓存整屏图层；最多留 3 份（拖窗口时不会无限增长）
  function layer(kind, w, h, dpr, paint) {
    const key = kind + '|' + w + 'x' + h + 'x' + dpr;
    let c = LAYER.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    paint(g, w, h);
    if (LAYER.size > 3) LAYER.delete(LAYER.keys().next().value);
    LAYER.set(key, c);
    return c;
  }

  function draw() {
    const cv = $('starCanvas');
    if (!cv || !cv.clientWidth) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    V.w = w; V.h = h;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 背景：深空 + 两团星云（整屏渐变很贵，按尺寸缓存成离屏图，每帧只 blit）
    const bgc = layer('bg', w, h, dpr, (g, W, H) => {
      const bg = g.createRadialGradient(W * 0.5, H * 0.46, 40, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
      bg.addColorStop(0, '#0b1119');
      bg.addColorStop(0.55, '#070b11');
      bg.addColorStop(1, '#04060a');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      const neb = g.createRadialGradient(W * 0.62, H * 0.34, 10, W * 0.62, H * 0.34, H * 0.75);
      neb.addColorStop(0, 'rgba(60,120,150,0.10)');
      neb.addColorStop(1, 'rgba(60,120,150,0)');
      g.fillStyle = neb; g.fillRect(0, 0, W, H);
      const neb2 = g.createRadialGradient(W * 0.32, H * 0.7, 10, W * 0.32, H * 0.7, H * 0.62);
      neb2.addColorStop(0, 'rgba(96,80,150,0.09)');
      neb2.addColorStop(1, 'rgba(96,80,150,0)');
      g.fillStyle = neb2; g.fillRect(0, 0, W, H);
    });
    ctx.drawImage(bgc, 0, 0, w, h);
    const st = starLayer(w, h, dpr);
    const ox = (((-V.yaw * 26) % w) + w) % w; // 取正：否则往左转时右侧会缺一条
    ctx.drawImage(st, ox - w, 0, w, h);
    ctx.drawImage(st, ox, 0, w, h);
    // 暗角同样缓存
    const vgc = layer('vg', w, h, dpr, (g, W, H) => {
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.72);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    });
    ctx.drawImage(vgc, 0, 0, w, h);

    const cx = w / 2, cy = h / 2 - Math.min(28, h * 0.03);
    const pts = new Map();
    for (const n of V.nodes) {
      const vis = V.filter === 'all' || n.type !== 'fact' ||
        (V.filter === 'hard' ? n.tier === 'hard' : Boolean(n.due) || /待办|备注/.test(String(n.label || '')));
      if (!vis) continue;
      const p = project(n);
      pts.set(n.id, { n, ...p });
    }
    // 边：只画两端都可见的；按深度淡出
    const hot = V.hover || V.sel;
    ctx.lineWidth = 1;
    for (const l of V.links) {
      const a = pts.get(l.a), b = pts.get(l.b);
      if (!a || !b) continue;
      const on = hot && (l.a === hot || l.b === hot);
      const alpha = clamp((depthAlpha(a.s) + depthAlpha(b.s)) / 2 * 0.3, 0.035, 0.45);
      ctx.strokeStyle = on ? 'rgba(140,235,205,0.85)' : `rgba(150,190,215,${alpha})`;
      ctx.lineWidth = on ? 1.4 : 0.8;
      // 引力线带一点弧度：同一个随机种子保证每帧曲率一致，不抖动
      const ax = cx + a.sx, ay = cy + a.sy, bx = cx + b.sx, by = cy + b.sy;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const seed = (l.a.length + l.b.length + l.a.charCodeAt(0) + l.b.charCodeAt(0)) % 7;
      const bow = (seed - 3) * 0.012 * Math.min(1, len / 420);
      const mx = (ax + bx) / 2 - dy / len * len * bow;
      const my = (ay + by) / 2 + dx / len * len * bow;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(mx, my, bx, by); ctx.stroke();
    }
    // 节点：远的先画，近的后画（painter's algorithm）
    const order = [...pts.values()].sort((a, b) => b.z - a.z);
    for (const p of order) {
      const n = p.n;
      const on = hot && (n.id === hot || V.links.some((l) => (l.a === hot && l.b === n.id) || (l.b === hot && l.a === n.id)));
      const base = (n.size || 12) * p.s * (n.type === 'date' ? 0.4 : 0.2);
      const r = clamp(base * (on ? 1.9 : 1), 0.7, 5.5);
      const color = n.invalid ? '#6d747e'
        : n.type === 'person' ? PAL.person
          : n.type === 'date' ? PAL.date
            : n.type === 'topic' ? PAL.topic
              : (PAL[n.tier] || PAL.long);
      const a = depthAlpha(p.s);
      // 光晕
      if (n.type === 'person' || n.type === 'date' || on) {
        const g = ctx.createRadialGradient(cx + p.sx, cy + p.sy, 0, cx + p.sx, cy + p.sy, r * 3.4);
        g.addColorStop(0, color); g.addColorStop(0.22, 'rgba(130,180,210,0.16)'); g.addColorStop(1, 'rgba(130,180,210,0)');
        ctx.globalAlpha = 0.36 * a; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx + p.sx, cy + p.sy, r * 3.4, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx + p.sx, cy + p.sy, r, 0, 7); ctx.fill();
      if (n.type === 'person' || on) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.1; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const label = n.type === 'person' || n.type === 'topic' || n.type === 'date' || on;
      if (label) {
        const t = String(n.label || '');
        const short = t.length > 16 ? t.slice(0, 16) + '…' : t;
        ctx.font = `${n.type === 'person' ? 11.5 : 9.5}px system-ui, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.globalAlpha = clamp(a + 0.25, 0.3, 1);
        ctx.fillStyle = n.type === 'person' ? 'rgba(255,228,210,0.95)' : 'rgba(178,196,212,0.72)';
        ctx.fillText(short, cx + p.sx, cy + p.sy + r + 4);
        ctx.globalAlpha = 1;
      }
    }
    const shown = pts.size;
    const meta = $('starMeta');
    if (meta) meta.textContent = `${shown} 颗星 · ${V.links.length} 条引力线`;
  }

  function loop() {
    try {
      const spinning = V.auto && !V.drag && Date.now() - V.idleAt > 1200;
      if (spinning) V.yaw += 0.0022;
      if (spinning || V.dirty || V.drag) { draw(); V.dirty = false; }
      V.err = null;
    } catch (e) {
      V.err = String(e && e.message || e);
      V.frames = (V.frames || 0) + 1;
      if (V.frames < 3) console.error('[starmap] draw failed:', e);
    }
    V.raf = requestAnimationFrame(loop); // 无论成败都续命
  }

  function hit(ev) {
    const cv = $('starCanvas');
    const rect = cv.getBoundingClientRect();
    const mx = ev.clientX - rect.left - rect.width / 2;
    const my = ev.clientY - rect.top - rect.height / 2;
    let best = null, bd = 26 * 26;
    for (const n of V.nodes) {
      const p = project(n);
      if (V.filter !== 'all' && n.type === 'fact') {
        const vis = V.filter === 'hard' ? n.tier === 'hard' : Boolean(n.due) || /待办|备注/.test(String(n.label || ''));
        if (!vis) continue;
      }
      const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2;
      const r = clamp((n.size || 12) * p.s * 0.2, 0.7, 5.5) + 9;
      if (d < Math.min(bd, r * r)) { bd = d; best = n; }
    }
    return best;
  }

  function detail(n) {
    const d = $('starDetail');
    if (!d) return;
    if (!n) { d.innerHTML = '<span class="muted">点一颗星看它记着什么；拖动可以转视角，滚轮缩放。</span>'; return; }
    if (n.type === 'fact') {
      const bits = [`<b>${esc(n.label || '')}</b>`, `档 <b>${esc(n.tier || '')}</b>`, `分 <b>${n.score ?? '—'}</b>`];
      if (n.due) bits.push(`截止 <b>${esc(n.due)}</b>`);
      if (n.invalid) bits.push('<b>已作废</b>');
      d.innerHTML = bits.join(' · ') + `<div class="muted" style="margin-top:4px">${esc(n.value || '')}</div>`
        + `<div class="muted" style="margin-top:2px">${esc(n.factId || '')}</div>`;
    } else if (n.type === 'person') {
      const cnt = V.links.filter((l) => l.a === n.id || l.b === n.id).length;
      d.innerHTML = `<b>${esc(n.label)}</b> · 这一侧挂着 ${cnt} 条线`;
    } else if (n.type === 'date') {
      const cnt = V.links.filter((l) => l.a === n.id || l.b === n.id).length;
      d.innerHTML = `<b>${esc(n.label)}</b> · 截止日 · ${cnt} 件事`;
    } else {
      d.innerHTML = `<b>${esc(n.label)}</b> · 主题 · ${V.links.filter((l) => l.a === n.id || l.b === n.id).length} 条事实`;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function paintLegend() {
    const el = $('starLegend');
    if (!el) return;
    el.innerHTML = [['person', '人物'], ['hard', '硬事实'], ['long', '长期'], ['general', '一般'], ['temp', '临时'], ['topic', '主题'], ['date', '截止']]
      .map(([k, t]) => `<span><i style="background:${PAL[k]};box-shadow:0 0 6px ${PAL[k]}"></i>${t}</span>`).join('');
  }

  function mount() {
    const cv = $('starCanvas');
    if (!cv || cv.dataset.bound) return;
    cv.dataset.bound = '1';
    cv.addEventListener('mousedown', (ev) => {
      V.drag = { x: ev.clientX, y: ev.clientY, yaw: V.yaw, pitch: V.pitch, moved: false };
      cv.classList.add('drag');
    });
    window.addEventListener('mousemove', (ev) => {
      if (V.drag) {
        const dx = ev.clientX - V.drag.x, dy = ev.clientY - V.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) V.drag.moved = true;
        V.yaw = V.drag.yaw - dx * 0.006;
        V.pitch = clamp(V.drag.pitch + dy * 0.005, -1.15, 1.15);
        V.idleAt = Date.now();
        return;
      }
      if (cv.classList.contains('drag')) return;
      const n = hit(ev);
      const id = n ? n.id : null;
      if (id !== V.hover) { V.hover = id; V.dirty = true; cv.style.cursor = n ? 'pointer' : 'grab'; }
    });
    window.addEventListener('mouseup', () => {
      if (!V.drag) return;
      const wasDrag = V.drag.moved;
      V.drag = null; cv.classList.remove('drag');
      if (!wasDrag) V.idleAt = Date.now();
    });
    cv.addEventListener('click', (ev) => {
      if (V.drag && V.drag.moved) return;
      const n = hit(ev);
      V.sel = n ? n.id : null;
      V.dirty = true;
      detail(n);
    });
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      V.zoom = clamp(V.zoom * (ev.deltaY > 0 ? 0.92 : 1.08), 0.45, 2.4);
      V.dirty = true;
    }, { passive: false });
    const btn = $('starRelayout');
    if (btn) btn.onclick = () => { relayout(); V.dirty = true; detail(null); };
    const spin = $('starSpin');
    if (spin) {
      const syncSpin = () => { spin.classList.toggle('on', V.auto); spin.title = V.auto ? '自转中（点击暂停）' : '已暂停（点击自转）'; };
      syncSpin();
      spin.onclick = () => { V.auto = !V.auto; syncSpin(); };
    }
    for (const b of document.querySelectorAll('#starFilter button')) {
      b.onclick = () => {
        for (const x of document.querySelectorAll('#starFilter button')) x.classList.toggle('on', x === b);
        V.filter = b.dataset.tf;
        V.dirty = true;
      };
    }
    let rzT = 0;
    new ResizeObserver(() => {
      draw();
      clearTimeout(rzT);
      rzT = setTimeout(() => {
        if (!document.body.classList.contains('starmode')) return;
        for (let i = 0; i < 120; i++) step(); // 窗口变了，球半径跟着变，让点重新铺开
        draw();
      }, 180);
    }).observe(cv.parentElement);
    paintLegend();
    if (!V.raf) loop();
  }

  if (new URLSearchParams(location.search).has('debug')) window.__SM_V = V; // 调试钩子：?debug
  window.Starmap = {
    mount,
    show() {
      mount();
      V.zoom = 1;
      if (!V.nodes.length && window.__WB_STAR_GRAPH__) { seed(window.__WB_STAR_GRAPH__, false); for (let i = 0; i < 240; i++) step(); }
      else { for (let i = 0; i < 80; i++) step(); }
      V.dirty = true;
      // 首次进来容器可能还没量到尺寸：延后两拍再画一次，避免空白“卡住”
      requestAnimationFrame(() => { V.dirty = true; });
      setTimeout(() => { V.dirty = true; }, 220);
    },
    update(g) {
      if (!g || !g.nodes) return;
      window.__WB_STAR_GRAPH__ = g;
      if (!V.nodes.length) { seed(g, false); for (let i = 0; i < 240; i++) step(); }
      else { seed(g, true); }
      V.dirty = true;
      paintLegend();
      draw();
    },
    draw: () => { V.dirty = true; },
    _v: V,
  };
})();
