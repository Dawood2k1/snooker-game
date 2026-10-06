// Rendering. Static art (arena, table, ball sprites, cue) is painted once into
// offscreen canvases at the current device resolution; each frame then composes
// those with the dynamic parts: balls, aiming guide, cue, effects.

const Renderer = (() => {
  const { W, H, R, CUSHION: C, RAIL } = CFG;
  const SC = CFG.SCENE;
  const OUTER = { x: -C - RAIL, y: -C - RAIL, w: W + 2 * (C + RAIL), h: H + 2 * (C + RAIL) };
  const SHADOW_OFF = { x: 0.2 * R, y: 0.3 * R }; // overhead lights sit slightly up-left
  const CUE = CFG.CUE;

  const view = { scale: 1, ox: 0, oy: 0, dpr: 1, cssW: 1, cssH: 1 };
  const layers = {};
  const sprites = {};
  const fx = { particles: [], popups: [] };
  let noiseTile = null;
  let rebuildTimer = null;

  // ---------------------------------------------------------------- helpers

  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];
  const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function seeded(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function poly(ctx, pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  // Same winding for every sub-path so overlapping shapes union under "nonzero"
  function clockwise(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a >= 0 ? pts : pts.slice().reverse();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Polygon with a corner radius per vertex
  function roundedPoly(ctx, pts, radii) {
    const n = pts.length;
    const a = pts[n - 1], b = pts[0];
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.arcTo(p.x, p.y, q.x, q.y, radii[i]);
    }
    ctx.closePath();
  }

  function circle(ctx, x, y, r) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  // Offscreen canvas whose context draws in scene units
  function makeLayer(x, y, w, h) {
    const k = view.scale * view.dpr;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * k));
    canvas.height = Math.max(1, Math.ceil(h * k));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, -x * k, -y * k);
    return { canvas, ctx, x, y, w: canvas.width / k, h: canvas.height / k, k };
  }

  function drawLayer(ctx, layer) {
    ctx.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
  }

  // Fine felt grain with a horizontal nap, as a tileable texture
  function makeNoiseTile() {
    const size = 160;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const rnd = seeded(1234);
    const raw = new Float32Array(size * size);
    for (let i = 0; i < raw.length; i++) raw[i] = rnd();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -4; k <= 4; k++) s += raw[y * size + ((x + k + size) % size)];
        const v = raw[y * size + x] * 0.5 + (s / 9) * 0.5;
        const i = (y * size + x) * 4;
        const light = v > 0.5;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 255 : 0;
        img.data[i + 3] = Math.abs(v - 0.5) * 2 * (light ? 34 : 52);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Covers the current clip region with grain at CSS-pixel scale
  function grain(ctx, alpha) {
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ctx.createPattern(noiseTile, 'repeat');
    ctx.fillRect(0, 0, ctx.canvas.width / view.dpr, ctx.canvas.height / view.dpr);
    ctx.restore();
  }

  // ---------------------------------------------------------------- view

  function resize(cssW, cssH, dpr) {
    view.cssW = cssW;
    view.cssH = cssH;
    view.dpr = dpr;
    view.scale = Math.min(cssW / SC.w, cssH / SC.h);
    view.ox = (cssW - SC.w * view.scale) / 2 - SC.x * view.scale;
    view.oy = (cssH - SC.h * view.scale) / 2 - SC.y * view.scale;
    if (!layers.table) {
      rebuild();
    } else {
      // Keep drawing the old art (scaled) while the window is being dragged
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuild, 160);
    }
  }

  function toScene(cssX, cssY) {
    return { x: (cssX - view.ox) / view.scale, y: (cssY - view.oy) / view.scale };
  }

  function rebuild() {
    if (!noiseTile) noiseTile = makeNoiseTile();
    buildBackground();
    buildTable();
    buildBallSprites();
    buildCue();
  }

  // ---------------------------------------------------------------- arena

  function buildBackground() {
    const w = Math.ceil(view.cssW * view.dpr), h = Math.ceil(view.cssH * view.dpr);
    const make = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const cx = (view.ox + (W / 2) * view.scale) * view.dpr;
    const cy = (view.oy + (H / 2) * view.scale) * view.dpr;
    const reach = Math.max(w, h);

    const bg = make();
    const b = bg.getContext('2d');
    let g = b.createRadialGradient(cx, cy, 0, cx, cy, reach * 0.75);
    g.addColorStop(0, '#26302c');
    g.addColorStop(0.35, '#161c1b');
    g.addColorStop(0.7, '#0b0e0f');
    g.addColorStop(1, '#040506');
    b.fillStyle = g;
    b.fillRect(0, 0, w, h);
    // Warm spill from the canopy lights onto the floor around the table
    b.save();
    b.translate(cx, cy);
    b.scale(1, 0.62);
    g = b.createRadialGradient(0, 0, OUTER.w * 0.3 * view.scale * view.dpr, 0, 0, OUTER.w * 0.95 * view.scale * view.dpr);
    g.addColorStop(0, 'rgba(255, 236, 200, 0.07)');
    g.addColorStop(1, 'rgba(255, 236, 200, 0)');
    b.fillStyle = g;
    b.fillRect(-w, -h * 2, w * 2, h * 4);
    b.restore();
    b.globalAlpha = 0.35;
    b.fillStyle = b.createPattern(noiseTile, 'repeat');
    b.fillRect(0, 0, w, h);
    layers.bg = bg;

    const vg = make();
    const v = vg.getContext('2d');
    g = v.createRadialGradient(cx, cy, reach * 0.32, cx, cy, reach * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    v.fillStyle = g;
    v.fillRect(0, 0, w, h);
    layers.vignette = vg;
  }

  // ---------------------------------------------------------------- table

  function buildTable() {
    const pad = 90;
    const layer = makeLayer(OUTER.x - pad, OUTER.y - pad, OUTER.w + pad * 2, OUTER.h + pad * 2);
    const ctx = layer.ctx;
    const k = layer.k;

    // Shadow cast on the floor
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 46 * k;
    ctx.shadowOffsetY = 16 * k;
    ctx.beginPath();
    roundRect(ctx, OUTER.x + 4, OUTER.y + 4, OUTER.w - 8, OUTER.h - 8, 20);
    ctx.fillStyle = '#1a0703';
    ctx.fill();
    ctx.restore();

    drawRails(ctx, k);
    for (const p of CFG.POCKETS) drawPocketRim(ctx, p);
    drawCloth(ctx);
    for (const p of CFG.POCKETS) drawPocketHole(ctx, p);
    drawCushions(ctx);
    drawMarkings(ctx);
    layers.table = layer;
  }

  function drawRails(ctx, k) {
    const o = OUTER;
    const x0 = -C, y0 = -C, x1 = W + C, y1 = H + C;
    const rails = [
      { pts: [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: x1, y: y0 }, { x: x0, y: y0 }], horiz: true, outer: o.y, inner: y0 },
      { pts: [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }], horiz: true, outer: o.y + o.h, inner: y1 },
      { pts: [{ x: o.x, y: o.y }, { x: x0, y: y0 }, { x: x0, y: y1 }, { x: o.x, y: o.y + o.h }], horiz: false, outer: o.x, inner: x0 },
      { pts: [{ x: x1, y: y0 }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: x1, y: y1 }], horiz: false, outer: o.x + o.w, inner: x1 },
    ];

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, o.x, o.y, o.w, o.h, 20);
    ctx.clip();
    rails.forEach((rail, i) => {
      ctx.save();
      ctx.beginPath();
      poly(ctx, rail.pts);
      ctx.clip();
      // Rounded profile: dark outer edge, lit crown, darker inner edge
      const g = rail.horiz ? ctx.createLinearGradient(0, rail.outer, 0, rail.inner) : ctx.createLinearGradient(rail.outer, 0, rail.inner, 0);
      g.addColorStop(0, '#120402');
      g.addColorStop(0.07, '#3a1207');
      g.addColorStop(0.2, '#64240f');
      g.addColorStop(0.42, '#7d3215');
      g.addColorStop(0.62, '#682710');
      g.addColorStop(0.88, '#4a180a');
      g.addColorStop(1, '#260904');
      ctx.fillStyle = g;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      drawWoodGrain(ctx, rail, i);
      // Varnish: a broad soft reflection of the canopy along the crown
      const s = rail.horiz ? ctx.createLinearGradient(0, rail.outer, 0, rail.inner) : ctx.createLinearGradient(rail.outer, 0, rail.inner, 0);
      s.addColorStop(0, 'rgba(255,225,190,0)');
      s.addColorStop(0.3, 'rgba(255,225,190,0.10)');
      s.addColorStop(0.42, 'rgba(255,225,190,0.16)');
      s.addColorStop(0.56, 'rgba(255,225,190,0.04)');
      s.addColorStop(1, 'rgba(255,225,190,0)');
      ctx.fillStyle = s;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.restore();
    });

    // Lamp reflections in the lacquer
    for (const fx of [0.2, 0.5, 0.8]) {
      for (const y of [o.y + RAIL * 0.42, o.y + o.h - RAIL * 0.42]) {
        const x = o.x + o.w * fx;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(3.2, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 22);
        g.addColorStop(0, 'rgba(255,240,220,0.16)');
        g.addColorStop(1, 'rgba(255,240,220,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-22, -22, 44, 44);
        ctx.restore();
      }
    }

    // Miter joints
    ctx.strokeStyle = 'rgba(10,2,0,0.55)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y); ctx.lineTo(x0, y0);
    ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(x1, y0);
    ctx.moveTo(o.x, o.y + o.h); ctx.lineTo(x0, y1);
    ctx.moveTo(o.x + o.w, o.y + o.h); ctx.lineTo(x1, y1);
    ctx.stroke();

    // Fine maple inlay around the rails
    const inset = RAIL * 0.52;
    ctx.beginPath();
    roundRect(ctx, x0 - inset, y0 - inset, x1 - x0 + inset * 2, y1 - y0 + inset * 2, 8);
    ctx.strokeStyle = 'rgba(40,10,2,0.7)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236,196,140,0.42)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.restore();

    // Outer bevel catching the light on the top edge
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, o.x + 0.8, o.y + 0.8, o.w - 1.6, o.h - 1.6, 19.5);
    const bevel = ctx.createLinearGradient(0, o.y, 0, o.y + o.h);
    bevel.addColorStop(0, 'rgba(255,210,170,0.35)');
    bevel.addColorStop(0.5, 'rgba(255,210,170,0.06)');
    bevel.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.strokeStyle = bevel;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // Groove where the rail meets the cushion
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 2.4;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(255,200,150,0.12)';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(x0 - 1.8, y0 - 1.8, x1 - x0 + 3.6, y1 - y0 + 3.6);
    ctx.restore();
  }

  function drawWoodGrain(ctx, rail, seed) {
    const rnd = seeded(97 + seed * 31);
    const n = typeof noise === 'function' ? noise : (a, b) => 0.5 + 0.5 * Math.sin(a * 3.1 + b * 7.7);
    const len0 = rail.horiz ? OUTER.x : OUTER.y;
    const len1 = len0 + (rail.horiz ? OUTER.w : OUTER.h);
    const lo = Math.min(rail.outer, rail.inner), hi = Math.max(rail.outer, rail.inner);
    const draw = (s, off) => (rail.horiz ? [s, off] : [off, s]);

    for (let i = 0; i < 110; i++) {
      const base = lo + rnd() * (hi - lo);
      const dark = rnd() < 0.62;
      ctx.strokeStyle = dark ? `rgba(28,7,2,${0.12 + rnd() * 0.25})` : `rgba(200,110,60,${0.05 + rnd() * 0.1})`;
      ctx.lineWidth = 0.2 + rnd() * rnd() * 1.6;
      const f = 0.003 + rnd() * 0.006, amp = 1.5 + rnd() * 4.5, ph = rnd() * 1000;
      ctx.beginPath();
      for (let s = len0; s <= len1 + 4; s += 4) {
        const off = base + (n(ph, s * f) - 0.5) * amp * 2;
        const [x, y] = draw(s, off);
        if (s === len0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Darker figure flecks and pores
    for (let i = 0; i < 260; i++) {
      const s = len0 + rnd() * (len1 - len0);
      const off = lo + rnd() * (hi - lo);
      const [x, y] = draw(s, off);
      const l = 1.5 + rnd() * 7;
      ctx.fillStyle = `rgba(20,4,0,${0.08 + rnd() * 0.18})`;
      ctx.fillRect(rail.horiz ? x : x - 0.2, rail.horiz ? y - 0.2 : y, rail.horiz ? l : 0.4, rail.horiz ? 0.4 : l);
    }
  }

  function drawPocketRim(ctx, p) {
    ctx.save();
    // Rail wood darkens as it rolls into the pocket
    let g = ctx.createRadialGradient(p.x, p.y, p.rim, p.x, p.y, p.rim + 7);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    circle(ctx, p.x, p.y, p.rim + 7);
    ctx.fill();
    // Leather pocket cover
    g = ctx.createRadialGradient(p.x - 4, p.y - 5, p.r * 0.6, p.x, p.y, p.rim);
    g.addColorStop(0, '#3b3b3b');
    g.addColorStop(0.55, '#202020');
    g.addColorStop(0.85, '#141414');
    g.addColorStop(1, '#070707');
    ctx.fillStyle = g;
    ctx.beginPath();
    circle(ctx, p.x, p.y, p.rim);
    ctx.fill();
    // Sheen on the side facing the light
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.rim - 1.4, Math.PI * 1.05, Math.PI * 1.6);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    circle(ctx, p.x, p.y, p.rim);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  function clothPath(ctx) {
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    for (const t of CFG.throats()) poly(ctx, clockwise(t));
  }

  function drawCloth(ctx) {
    ctx.save();
    clothPath(ctx);
    ctx.clip();
    ctx.fillStyle = '#17763c';
    ctx.fillRect(-C, -C, W + 2 * C, H + 2 * C);
    grain(ctx, 0.75);

    // Overhead canopy: bright centre, gentle fall-off towards the cushions
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(1, 0.6);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.64);
    g.addColorStop(0, 'rgba(255,255,220,0.14)');
    g.addColorStop(0.45, 'rgba(255,255,220,0.05)');
    g.addColorStop(0.78, 'rgba(0,0,0,0.04)');
    g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = g;
    ctx.fillRect(-W, -W, W * 2, W * 2);
    ctx.restore();
    for (const x of [W * 0.2, W * 0.5, W * 0.8]) {
      ctx.save();
      ctx.translate(x, H / 2);
      ctx.scale(1.3, 1);
      const lg = ctx.createRadialGradient(0, 0, 0, 0, 0, H * 0.55);
      lg.addColorStop(0, 'rgba(255,255,225,0.05)');
      lg.addColorStop(1, 'rgba(255,255,225,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(-H, -H, H * 2, H * 2);
      ctx.restore();
    }

    // The bed falls away into each pocket
    for (const [i, t] of CFG.throats().entries()) {
      const p = CFG.POCKETS[i];
      // The mouth is the pair of cushion noses, the throat corners on the bed's edge
      const nose = t.filter((q) => q.x >= 0 && q.x <= W && q.y >= 0 && q.y <= H);
      const mouth = { x: (nose[0].x + nose[1].x) / 2, y: (nose[0].y + nose[1].y) / 2 };
      const fg = ctx.createLinearGradient(mouth.x, mouth.y, p.x, p.y);
      fg.addColorStop(0, 'rgba(0,0,0,0)');
      fg.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      fg.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      poly(ctx, t);
      ctx.fill();
    }

    // Shadow line under each cushion nose
    for (const c of CFG.cushions(C)) {
      const [a, b] = c.pts;
      const n = c.normal;
      const sg = ctx.createLinearGradient(a.x, a.y, a.x + n.x * 9, a.y + n.y * 9);
      sg.addColorStop(0, 'rgba(0,0,0,0.42)');
      sg.addColorStop(0.35, 'rgba(0,0,0,0.12)');
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      poly(ctx, [a, b, { x: b.x + n.x * 9, y: b.y + n.y * 9 }, { x: a.x + n.x * 9, y: a.y + n.y * 9 }]);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPocketHole(ctx, p) {
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    g.addColorStop(0, '#000');
    g.addColorStop(0.7, '#020202');
    g.addColorStop(0.92, '#0a0a0a');
    g.addColorStop(1, '#151515');
    ctx.fillStyle = g;
    ctx.beginPath();
    circle(ctx, p.x, p.y, p.r);
    ctx.fill();
    // Depth: inner shadow on the far wall
    const ig = ctx.createRadialGradient(p.x + 3, p.y + 4, p.r * 0.2, p.x, p.y, p.r);
    ig.addColorStop(0, 'rgba(0,0,0,0)');
    ig.addColorStop(1, 'rgba(0,0,0,0.9)');
    ctx.fillStyle = ig;
    ctx.fill();
    // The far inner wall of the pocket, glimpsed from a camera above the table centre
    const toward = Math.atan2(H / 2 - p.y, W / 2 - p.x);
    ctx.save();
    ctx.beginPath();
    circle(ctx, p.x, p.y, p.r);
    ctx.clip();
    const wx = p.x + Math.cos(toward) * p.r * 0.4, wy = p.y + Math.sin(toward) * p.r * 0.4;
    const wall = ctx.createRadialGradient(wx, wy, p.r * 0.75, wx, wy, p.r * 1.4);
    wall.addColorStop(0, 'rgba(60,48,38,0)');
    wall.addColorStop(1, 'rgba(78,62,48,0.6)');
    ctx.fillStyle = wall;
    ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    ctx.restore();
    // Faint lip highlight where the cloth curls over the fall
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r - 0.6, toward - 0.9, toward + 0.9);
    ctx.strokeStyle = 'rgba(90,200,130,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawCushions(ctx) {
    for (const c of CFG.cushions(C)) {
      const [a, b] = c.pts;
      const n = c.normal;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.save();
      ctx.beginPath();
      roundedPoly(ctx, c.pts, [5, 5, 0, 0]);
      const g = ctx.createLinearGradient(mx - n.x * C, my - n.y * C, mx, my);
      g.addColorStop(0, '#0b4a23');
      g.addColorStop(0.5, '#146b36');
      g.addColorStop(0.82, '#1b8042');
      g.addColorStop(0.94, '#26954e');
      g.addColorStop(1, '#2fa65a');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.clip();
      grain(ctx, 0.6);
      ctx.restore();

      ctx.save();
      ctx.lineCap = 'round';
      // Bright rubber nose
      const ux = (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y), uy = (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y);
      ctx.beginPath();
      ctx.moveTo(a.x - n.x * 1.1 + ux * 5, a.y - n.y * 1.1 + uy * 5);
      ctx.lineTo(b.x - n.x * 1.1 - ux * 5, b.y - n.y * 1.1 - uy * 5);
      ctx.strokeStyle = 'rgba(190,255,200,0.2)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      // Jaw faces curving into the pocket
      ctx.beginPath();
      roundedPoly(ctx, c.pts, [5, 5, 0, 0]);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      // Seam against the rail
      ctx.beginPath();
      ctx.moveTo(c.pts[2].x, c.pts[2].y); ctx.lineTo(c.pts[3].x, c.pts[3].y);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawMarkings(ctx) {
    const { BAULK_X, D_R, MID_Y, SPOTS } = CFG;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.moveTo(BAULK_X, 0);
    ctx.lineTo(BAULK_X, H);
    ctx.moveTo(BAULK_X, MID_Y + D_R);
    ctx.arc(BAULK_X, MID_Y, D_R, Math.PI / 2, Math.PI * 1.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const k of Object.keys(SPOTS)) {
      if (k === 'yellow' || k === 'green' || k === 'brown') continue; // on the baulk line
      ctx.beginPath();
      circle(ctx, SPOTS[k].x, SPOTS[k].y, 1.1);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- balls

  function makeSprite(size, paint) {
    const k = view.scale * view.dpr;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.ceil(size * k);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, canvas.width / 2, canvas.height / 2);
    paint(ctx);
    return { canvas, size: canvas.width / k };
  }

  function buildBallSprites() {
    sprites.balls = {};
    for (const [kind, def] of Object.entries(CFG.BALLS)) {
      sprites.balls[kind] = makeSprite(R * 2 + 2, (ctx) => paintBall(ctx, hexRgb(def.color), kind));
    }
    sprites.gloss = makeSprite(R * 2 + 2, paintGloss);
    sprites.shadow = makeSprite(R * 3.4, paintShadow);
  }

  function paintBall(ctx, base, kind) {
    const lift = kind === 'black' ? 0.32 : kind === 'cue' ? 0.6 : 0.42;
    ctx.beginPath();
    circle(ctx, 0, 0, R);
    const g = ctx.createRadialGradient(-0.36 * R, -0.42 * R, 0.04 * R, -0.08 * R, -0.1 * R, 1.22 * R);
    g.addColorStop(0, rgba(mix(base, WHITE, lift)));
    g.addColorStop(0.32, rgba(mix(base, WHITE, lift * 0.18)));
    g.addColorStop(0.7, rgba(base));
    g.addColorStop(1, rgba(mix(base, BLACK, kind === 'cue' ? 0.42 : 0.62)));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    ctx.clip();
    // Limb darkening
    const ao = ctx.createRadialGradient(0, 0, R * 0.62, 0, 0, R);
    ao.addColorStop(0, 'rgba(0,0,0,0)');
    ao.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = ao;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    // Green bounce light from the cloth on the lower rim
    const bl = ctx.createRadialGradient(0.5 * R, 0.62 * R, 0, 0.5 * R, 0.62 * R, R * 0.9);
    bl.addColorStop(0, 'rgba(70,190,110,0.28)');
    bl.addColorStop(1, 'rgba(70,190,110,0)');
    ctx.fillStyle = bl;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  }

  function paintGloss(ctx) {
    ctx.save();
    ctx.beginPath();
    circle(ctx, 0, 0, R);
    ctx.clip();
    const soft = ctx.createRadialGradient(-0.36 * R, -0.42 * R, 0, -0.36 * R, -0.42 * R, R * 0.62);
    soft.addColorStop(0, 'rgba(255,255,255,0.5)');
    soft.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    soft.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = soft;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    // Crisp reflection of the lamp canopy
    ctx.translate(-0.38 * R, -0.45 * R);
    ctx.rotate(-0.55);
    ctx.beginPath();
    roundRect(ctx, -0.22 * R, -0.11 * R, 0.44 * R, 0.22 * R, 0.1 * R);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.restore();
    // A faint second light on the far side
    ctx.beginPath();
    circle(ctx, 0.46 * R, 0.4 * R, 0.07 * R);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
    // Rim
    ctx.beginPath();
    circle(ctx, 0, 0, R - 0.25);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  function paintShadow(ctx) {
    ctx.save();
    ctx.translate(SHADOW_OFF.x, SHADOW_OFF.y);
    ctx.scale(1, 0.92);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.5);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.38)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    circle(ctx, 0, 0, R * 1.5);
    ctx.fill();
    ctx.restore();
    // Tight contact shadow right under the ball
    const c = ctx.createRadialGradient(0, 0, R * 0.7, 0, 0, R * 1.08);
    c.addColorStop(0, 'rgba(0,0,0,0.55)');
    c.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = c;
    ctx.beginPath();
    circle(ctx, 0, 0, R * 1.08);
    ctx.fill();
  }

  function drawSprite(ctx, sprite, x, y, scale = 1) {
    const s = sprite.size * scale;
    ctx.drawImage(sprite.canvas, x - s / 2, y - s / 2, s, s);
  }

  // The six red dots of the TV-style cue ball, rolling with the ball
  function drawCueDots(ctx, ball, x, y) {
    const o = ball.orient;
    if (!o) return;
    ctx.save();
    ctx.beginPath();
    circle(ctx, x, y, R - 0.3);
    ctx.clip();
    for (let j = 0; j < 3; j++) {
      for (const sgn of [1, -1]) {
        const wx = o[j] * sgn, wy = o[3 + j] * sgn, wz = o[6 + j] * sgn;
        if (wz > -0.04) continue; // facing away from the camera
        const facing = -wz;
        ctx.save();
        ctx.translate(x + wx * R * 0.97, y + wy * R * 0.97);
        ctx.rotate(Math.atan2(wy, wx));
        ctx.globalAlpha = Math.min(1, facing * 2.5);
        ctx.beginPath();
        ctx.ellipse(0, 0, 0.17 * R * facing + 0.02, 0.17 * R, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#b3122b';
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- cue

  function cueWidth(x) {
    return CUE.TIP_W + (CUE.BUTT_W - CUE.TIP_W) * Math.pow(Math.max(0, x) / CUE.LENGTH, 0.85);
  }

  function cueOutline(ctx, x0 = 0, x1 = CUE.LENGTH, u0 = -1, u1 = 1) {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 2) ctx.lineTo(x, (u0 * cueWidth(x)) / 2);
    ctx.lineTo(x1, (u0 * cueWidth(x1)) / 2);
    for (let x = x1; x >= x0; x -= 2) ctx.lineTo(x, (u1 * cueWidth(x)) / 2);
    ctx.lineTo(x0, (u1 * cueWidth(x0)) / 2);
    ctx.closePath();
  }

  function buildCue() {
    const L = CUE.LENGTH, BW = CUE.BUTT_W;
    const layer = makeLayer(-1, -BW / 2 - 1, L + 2, BW + 2);
    const ctx = layer.ctx;
    const rnd = seeded(42);

    ctx.save();
    cueOutline(ctx);
    ctx.clip();

    // Ash shaft
    let g = ctx.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, '#ecd3a2');
    g.addColorStop(0.5, '#e2c48b');
    g.addColorStop(0.75, '#d4ad6f');
    ctx.fillStyle = g;
    ctx.fillRect(0, -BW, L, BW * 2);
    // Ash grain: long, slightly wavy streaks that follow the taper
    for (let i = 0; i < 26; i++) {
      const u = rnd() * 2 - 1, ph = rnd() * 10;
      ctx.beginPath();
      for (let x = 10; x < L * 0.8; x += 3) {
        const y = ((u + Math.sin(x * 0.03 + ph) * 0.06) * cueWidth(x)) / 2;
        if (x === 10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(130,80,30,${0.08 + rnd() * 0.18})`;
      ctx.lineWidth = 0.15 + rnd() * 0.35;
      ctx.stroke();
    }

    // Ebony butt and the spliced points
    const spliceEnd = L * 0.79;
    const ebony = ctx.createLinearGradient(L * 0.55, 0, L, 0);
    ebony.addColorStop(0, '#24150d');
    ebony.addColorStop(1, '#140b07');
    ctx.fillStyle = ebony;
    ctx.fillRect(spliceEnd, -BW, L, BW * 2);
    const points = [
      { tip: L * 0.56, u: 0, half: 0.48 },
      { tip: L * 0.62, u: -1, half: 0.42 },
      { tip: L * 0.62, u: 1, half: 0.42 },
    ];
    for (const p of points) {
      const w = cueWidth(spliceEnd) / 2;
      ctx.beginPath();
      ctx.moveTo(p.tip, (p.u * cueWidth(p.tip)) / 2);
      ctx.lineTo(spliceEnd + 0.5, p.u * w - p.half * w);
      ctx.lineTo(spliceEnd + 0.5, p.u * w + p.half * w);
      ctx.closePath();
      ctx.fillStyle = ebony;
      ctx.fill();
      ctx.strokeStyle = 'rgba(250,232,200,0.75)';
      ctx.lineWidth = 0.35;
      ctx.stroke();
    }
    // Ebony figure
    for (let i = 0; i < 30; i++) {
      const x = spliceEnd + rnd() * (L - spliceEnd);
      const u = rnd() * 2 - 1;
      ctx.fillStyle = `rgba(120,80,50,${0.05 + rnd() * 0.1})`;
      ctx.fillRect(x, (u * cueWidth(x)) / 2, 6 + rnd() * 20, 0.25);
    }

    // Brass joint collar
    const jx = spliceEnd + 3;
    g = ctx.createLinearGradient(jx, 0, jx + 3, 0);
    g.addColorStop(0, '#7a5a1c');
    g.addColorStop(0.5, '#f4d98a');
    g.addColorStop(1, '#8a6a24');
    ctx.fillStyle = g;
    ctx.fillRect(jx, -BW, 3, BW * 2);
    ctx.fillStyle = 'rgba(20,10,4,0.9)';
    ctx.fillRect(jx + 3, -BW, 0.6, BW * 2);

    // Rubber bumper
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(L - 4, -BW, 4, BW * 2);

    // Tip end: brass ferrule, leather and blue chalk
    g = ctx.createLinearGradient(3.6, 0, 9.8, 0);
    g.addColorStop(0, '#b8902f');
    g.addColorStop(0.5, '#f1d27c');
    g.addColorStop(1, '#a07a25');
    ctx.fillStyle = g;
    ctx.fillRect(3.6, -BW, 6.2, BW * 2);
    ctx.fillStyle = '#6a4325';
    ctx.fillRect(1.3, -BW, 2.3, BW * 2);
    ctx.fillStyle = '#3a78c2';
    ctx.fillRect(-1, -BW, 2.4, BW * 2);
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `rgba(200,225,255,${0.2 + rnd() * 0.4})`;
      ctx.fillRect(rnd() * 2, (rnd() - 0.5) * CUE.TIP_W, 0.4, 0.4);
    }

    // Cylindrical shading: darken the flanks, add a specular streak
    const bands = 16;
    for (let i = 0; i < bands; i++) {
      const u0 = -1 + (2 * i) / bands, u1 = u0 + 2 / bands;
      const u = (u0 + u1) / 2;
      const nz = Math.sqrt(1 - u * u);
      const diffuse = Math.max(0, -u * 0.25 + nz * 0.97);
      const spec = Math.pow(Math.max(0, -u * 0.38 + nz * 0.92), 40);
      cueOutline(ctx, -1, L, u0, u1);
      ctx.fillStyle = `rgba(0,0,0,${(1 - diffuse) * 0.62})`;
      ctx.fill();
      if (spec > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${spec * 0.55})`;
        ctx.fill();
      }
    }
    ctx.restore();

    cueOutline(ctx);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 0.35;
    ctx.stroke();
    sprites.cue = layer;
  }

  function cueFrame(cue) {
    const dx = Math.cos(cue.angle), dy = Math.sin(cue.angle);
    const px = -dy, py = dx;
    const back = R + 2.5 + cue.pull;
    return { dx, dy, px, py, tipX: cue.x - dx * back + px * cue.side, tipY: cue.y - dy * back + py * cue.side };
  }

  // Shadow on the cloth: it drifts further from the cue towards the raised butt
  function drawCueShadow(ctx, cue) {
    const f = cueFrame(cue);
    const pts = [];
    for (const [t, u] of [[0, -1], [1, -1], [1, 1], [0, 1]]) {
      const along = t * CUE.LENGTH;
      const off = 2 + t * 13;
      const w = (cueWidth(along) / 2) * u * (1.05 + t * 0.5);
      pts.push({
        x: f.tipX - f.dx * along + f.px * w + off * 0.55,
        y: f.tipY - f.dy * along + f.py * w + off * 0.83,
      });
    }
    const fade = ctx.createLinearGradient(pts[0].x, pts[0].y, (pts[1].x + pts[2].x) / 2, (pts[1].y + pts[2].y) / 2);
    fade.addColorStop(0, 'rgba(0,0,0,0.34)');
    fade.addColorStop(0.5, 'rgba(0,0,0,0.2)');
    fade.addColorStop(1, 'rgba(0,0,0,0.08)');
    ctx.save();
    ctx.globalAlpha = cue.alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 5 * view.scale * view.dpr;
    ctx.fillStyle = fade;
    ctx.beginPath();
    poly(ctx, pts);
    ctx.fill();
    ctx.restore();
  }

  function drawCue(ctx, cue) {
    const f = cueFrame(cue);
    ctx.save();
    ctx.globalAlpha = cue.alpha;
    ctx.translate(f.tipX, f.tipY);
    ctx.rotate(cue.angle + Math.PI);
    drawLayer(ctx, sprites.cue);
    ctx.restore();
  }

  // ---------------------------------------------------------------- guide

  function lineFade(ctx, x1, y1, x2, y2, color, alpha, width, dash) {
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(1, rgba(color, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function drawGuide(ctx, pred, legal, time) {
    ctx.save();
    ctx.lineCap = 'round';
    pred.segments.forEach((s, i) => {
      let x1 = s.x1, y1 = s.y1;
      if (i === 0) {
        const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1;
        x1 += ((s.x2 - s.x1) / len) * R;
        y1 += ((s.y2 - s.y1) / len) * R;
      }
      ctx.setLineDash([3.5, 4]);
      ctx.lineDashOffset = -time * 14;
      ctx.strokeStyle = `rgba(255,255,255,${s.bounce ? 0.32 : 0.6})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    if (pred.ghost) {
      const g = pred.ghost;
      const col = legal ? [255, 255, 255] : [255, 96, 96];
      if (pred.object) {
        const o = pred.object;
        lineFade(ctx, o.x1 + o.dx * R, o.y1 + o.dy * R, o.x1 + o.dx * (R + o.len), o.y1 + o.dy * (R + o.len), col, 0.9, 1.6);
      }
      if (pred.cueAfter) {
        const c = pred.cueAfter;
        lineFade(ctx, c.x1, c.y1, c.x1 + c.dx * c.len, c.y1 + c.dy * c.len, [150, 205, 255], 0.75, 1.2, [3, 3.5]);
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      circle(ctx, g.x, g.y, R);
      ctx.fillStyle = rgba(col, 0.07);
      ctx.fill();
      ctx.strokeStyle = rgba(col, 0.85);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.beginPath();
      circle(ctx, g.x, g.y, 1.2);
      ctx.fillStyle = rgba(col, 0.8);
      ctx.fill();
    }

    const pocketId = (pred.object && pred.object.pocket) || (!pred.ghost && pred.pocket);
    if (pocketId && (legal || !pred.ghost)) {
      const p = CFG.POCKETS.find((q) => q.id === pocketId);
      const pulse = 0.55 + 0.45 * Math.sin(time * 6);
      ctx.save();
      ctx.shadowColor = pred.ghost ? 'rgba(255,214,110,0.9)' : 'rgba(255,90,90,0.9)';
      ctx.shadowBlur = 12 * view.scale * view.dpr;
      ctx.strokeStyle = pred.ghost ? `rgba(255,214,110,${0.5 + pulse * 0.4})` : `rgba(255,110,110,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      circle(ctx, p.x, p.y, p.rim + 1.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- ball in hand

  function drawPlacement(ctx, place, time) {
    const { BAULK_X, D_R, MID_Y } = CFG;
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(BAULK_X, MID_Y - D_R);
    ctx.arc(BAULK_X, MID_Y, D_R, Math.PI * 1.5, Math.PI / 2, true);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${0.04 + pulse * 0.04})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + pulse * 0.35})`;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    if (!place.show) return;
    ctx.save();
    ctx.globalAlpha = place.valid ? 0.95 : 0.55;
    drawSprite(ctx, sprites.shadow, place.x, place.y);
    drawSprite(ctx, sprites.balls.cue, place.x, place.y);
    drawSprite(ctx, sprites.gloss, place.x, place.y);
    ctx.restore();
    if (!place.valid) {
      ctx.beginPath();
      circle(ctx, place.x, place.y, R + 2);
      ctx.strokeStyle = 'rgba(255,90,90,0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- effects

  function chalk(x, y, dx, dy) {
    for (let i = 0; i < 14; i++) {
      const a = Math.atan2(dy, dx) + Math.PI + (Math.random() - 0.5) * 2.2;
      const s = 10 + Math.random() * 40;
      fx.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.4 + Math.random() * 0.5, r: 0.35 + Math.random() * 0.6 });
    }
  }

  function popup(text, x, y, color) {
    fx.popups.push({ text, x, y, color, life: 0, max: 1.4 });
  }

  function update(dt) {
    for (const p of fx.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
    fx.particles = fx.particles.filter((p) => p.life < p.max);
    for (const p of fx.popups) p.life += dt;
    fx.popups = fx.popups.filter((p) => p.life < p.max);
  }

  function drawEffects(ctx) {
    for (const p of fx.particles) {
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = '#9cc4ff';
      ctx.beginPath();
      circle(ctx, p.x, p.y, p.r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of fx.popups) {
      const t = p.life / p.max;
      const ease = 1 - Math.pow(1 - Math.min(1, t * 3), 3);
      ctx.save();
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.translate(p.x, p.y - 26 * ease - t * 10);
      ctx.scale(0.7 + 0.3 * ease, 0.7 + 0.3 * ease);
      ctx.font = '700 17px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- frame

  function frame(ctx, scene) {
    const dpr = view.dpr, k = view.scale * dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layers.bg, 0, 0, view.cssW * dpr, view.cssH * dpr);
    ctx.setTransform(k, 0, 0, k, view.ox * dpr, view.oy * dpr);
    drawLayer(ctx, layers.table);

    // Balls dropping into pockets
    for (const f of scene.falling) {
      const t = Math.min(1, f.t / f.dur);
      const e = t * t * (3 - 2 * t);
      const x = f.x + (f.pocket.x - f.x) * e, y = f.y + (f.pocket.y - f.y) * e;
      const s = 1 - 0.42 * e;
      drawSprite(ctx, sprites.balls[f.kind], x, y, s);
      drawSprite(ctx, sprites.gloss, x, y, s);
      ctx.beginPath();
      circle(ctx, x, y, R * s + 0.3);
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.95, e * 1.15)})`;
      ctx.fill();
    }

    const balls = scene.balls;
    for (const b of balls) drawSprite(ctx, sprites.shadow, b.body.position.x, b.body.position.y);
    if (scene.cue) drawCueShadow(ctx, scene.cue);
    if (scene.guide) drawGuide(ctx, scene.guide, scene.guideLegal, scene.time);
    for (const b of balls) {
      const { x, y } = b.body.position;
      // Re-spotted balls settle onto their spot
      const appear = b.appear === undefined ? 1 : b.appear;
      const s = appear < 1 ? 0.75 + 0.25 * (1 - Math.pow(1 - appear, 3)) : 1;
      ctx.globalAlpha = appear;
      drawSprite(ctx, sprites.balls[b.kind], x, y, s);
      if (b.kind === 'cue') drawCueDots(ctx, b, x, y);
      drawSprite(ctx, sprites.gloss, x, y, s);
      ctx.globalAlpha = 1;
    }
    if (scene.place) drawPlacement(ctx, scene.place, scene.time);
    if (scene.cue) drawCue(ctx, scene.cue);
    drawEffects(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layers.vignette, 0, 0, view.cssW * dpr, view.cssH * dpr);
    ctx.restore();
  }

  return { resize, toScene, frame, chalk, popup, update, view };
})();
