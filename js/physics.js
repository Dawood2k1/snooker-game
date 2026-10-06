// Ball physics. Matter.js integrates motion and resolves the cushions and pocket
// jaws; ball-to-ball impacts are solved analytically (backtracked to the exact
// moment of contact) so cut angles match the aiming guide precisely.

const Physics = (() => {
  const { Engine, Bodies, Body, Composite, Events, Resolver, Vertices } = Matter;
  const P = CFG.PHYS;
  const R = CFG.R;
  const STEP = 1 / P.HZ;

  let engine;
  let balls = [];
  let handlers = {};
  let accumulator = 0;
  let pendingCushion = [];
  let shot = null; // spin state of the cue ball for the current shot
  let nextId = 1;
  let stepCount = 0;

  function init(h) {
    handlers = h || {};
    // Matter treats slow impacts as "resting" and kills the bounce; billiards needs
    // every impact to bounce, so lower the threshold.
    Resolver._restingThresh = 0.0001;
    engine = Engine.create({ positionIterations: 8, velocityIterations: 8 });
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    engine.gravity.scale = 0;
    buildCushions();
    Events.on(engine, 'collisionStart', onCollisionStart);
  }

  function buildCushions() {
    const opts = { isStatic: true, restitution: 0, friction: 0, frictionStatic: 0, slop: 0.02, label: 'cushion' };
    for (const c of CFG.cushions(60)) {
      const centre = Vertices.centre(c.pts);
      Composite.add(engine.world, Bodies.fromVertices(centre.x, centre.y, [c.pts], opts));
    }
    // Backstop walls beyond the rails, in case anything ever escapes the pockets
    const { W, H } = CFG;
    const wall = { isStatic: true, restitution: 0, label: 'wall' };
    Composite.add(engine.world, [
      Bodies.rectangle(W / 2, -125, W + 600, 160, wall),
      Bodies.rectangle(W / 2, H + 125, W + 600, 160, wall),
      Bodies.rectangle(-125, H / 2, 160, H + 600, wall),
      Bodies.rectangle(W + 125, H / 2, 160, H + 600, wall),
    ]);
  }

  // ---------------------------------------------------------------- balls

  function addBall(kind, x, y) {
    const body = Bodies.circle(x, y, R, {
      restitution: P.CUSHION_E, // pair restitution is max(a, b) and cushions use 0
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0,
      inertia: Infinity,
      slop: 0.02,
      label: 'ball',
      // Negative group: balls never collide with each other inside Matter, since
      // ball-to-ball impacts are handled analytically below
      collisionFilter: { group: -1, category: 0x0001, mask: 0xffffffff },
    }, 40);
    const ball = { id: nextId++, kind, body, slip: null, potted: false };
    if (kind === 'cue') {
      ball.orient = randomOrientation();
      ball.spinZ = 0;
    }
    body.plugin.ball = ball;
    Composite.add(engine.world, body);
    balls.push(ball);
    return ball;
  }

  function removeBall(ball) {
    const i = balls.indexOf(ball);
    if (i >= 0) balls.splice(i, 1);
    Composite.remove(engine.world, ball.body);
    if (shot && shot.ball === ball) shot = null;
  }

  function clearBalls() {
    for (const b of balls.slice()) removeBall(b);
    shot = null;
  }

  function vel(body) {
    return { x: body.position.x - body.positionPrev.x, y: body.position.y - body.positionPrev.y };
  }

  function isMoving() {
    for (const b of balls) {
      const v = vel(b.body);
      if (v.x !== 0 || v.y !== 0 || b.slip) return true;
    }
    return false;
  }

  function isFree(x, y, ignore) {
    const min = 2 * R + 0.3;
    for (const b of balls) {
      if (b === ignore) continue;
      const dx = b.body.position.x - x, dy = b.body.position.y - y;
      if (dx * dx + dy * dy < min * min) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- spin model

  // Spin of the cue ball relative to natural roll (1 = rolling, 0 = stun,
  // negative = backspin). A struck ball slides first, then friction converts its
  // spin towards natural roll; harder shots slide further.
  function spinAt(s0, v0, dist) {
    const slide = P.SLIDE_K * v0 * v0 * Math.abs(1 - s0) + 1;
    return s0 + (1 - s0) * Math.min(1, dist / slide);
  }

  // Final rolling velocity of the cue ball after contact: 5/7 of its sliding
  // velocity plus 2/7 of its spin velocity (solid sphere).
  function cueAfterContact(dirX, dirY, speedPre, postX, postY, spin) {
    const s = spin < 0 ? spin * P.SCREW_GAIN : spin;
    return {
      x: (5 * postX + 2 * s * speedPre * dirX) / 7,
      y: (5 * postY + 2 * s * speedPre * dirY) / 7,
    };
  }

  function strike(cue, dirX, dirY, speed, spinTop, spinSide) {
    const v = speed * STEP;
    shot = { ball: cue, v0: speed, s0: spinTop * P.SPIN_MAX, side: spinSide, dist: 0, contacted: false };
    cue.slip = null;
    cue.spinZ = -spinSide * v / R * 0.5;
    Body.setVelocity(cue.body, { x: dirX * v, y: dirY * v });
  }

  // ---------------------------------------------------------------- stepping

  function update(dt) {
    accumulator = Math.min(accumulator + dt, 0.1);
    while (accumulator >= STEP) {
      substep();
      accumulator -= STEP;
    }
  }

  function substep() {
    for (const b of balls) applyCloth(b);

    pendingCushion.length = 0;
    Engine.update(engine, 1000 / P.HZ);
    for (const hit of pendingCushion) resolveCushionSpin(hit);

    resolveBallCollisions();
    checkPockets();
    trackCueBall();
    stepCount++;
  }

  function applyCloth(b) {
    const v = vel(b.body);
    if (b.slip) {
      // Spin taking hold after contact. While sliding, sliding friction is the only
      // force, and its constant direction gives the classic curved path.
      const dv = P.SLIDE_ACCEL * STEP * STEP;
      const sm = Math.hypot(b.slip.x, b.slip.y);
      if (sm <= dv) {
        Body.setVelocity(b.body, { x: v.x + b.slip.x, y: v.y + b.slip.y });
        b.slip = null;
      } else {
        const kx = (b.slip.x / sm) * dv, ky = (b.slip.y / sm) * dv;
        Body.setVelocity(b.body, { x: v.x + kx, y: v.y + ky });
        b.slip.x -= kx;
        b.slip.y -= ky;
      }
      return;
    }
    const speed = Math.hypot(v.x, v.y);
    if (speed === 0) return;
    const next = speed - P.ROLL_DECEL * STEP * STEP - speed * P.DRAG * STEP;
    if (next <= P.STOP_SPEED * STEP) {
      Body.setVelocity(b.body, { x: 0, y: 0 });
    } else {
      const k = Math.max(next, 0) / speed;
      Body.setVelocity(b.body, { x: v.x * k, y: v.y * k });
    }
  }

  function onCollisionStart(e) {
    for (const pair of e.pairs) {
      const a = pair.bodyA.parent, c = pair.bodyB.parent;
      let ballBody = null;
      if (a.label === 'ball' && c.label !== 'ball') ballBody = a;
      else if (c.label === 'ball' && a.label !== 'ball') ballBody = c;
      if (!ballBody) continue;
      const v = vel(ballBody);
      let nx = pair.collision.normal.x, ny = pair.collision.normal.y;
      if (v.x * nx + v.y * ny > 0) { nx = -nx; ny = -ny; } // point back into the table
      const vn = -(v.x * nx + v.y * ny);
      pendingCushion.push({ ball: ballBody.plugin.ball, nx, ny, vx: v.x, vy: v.y, vn });
    }
  }

  function resolveCushionSpin(hit) {
    const b = hit.ball;
    if (b.potted) return;
    const v = vel(b.body);
    const tx = -hit.ny, ty = hit.nx;
    let vt = (v.x * tx + v.y * ty) * P.CUSHION_GRIP;
    const vn = v.x * hit.nx + v.y * hit.ny;
    if (shot && shot.ball === b) {
      const sp = Math.hypot(hit.vx, hit.vy);
      if (sp > 1e-9 && Math.abs(shot.side) > 0.01) {
        // Sidespin grips the cushion and pushes the rebound towards that side
        const rx = -hit.vy / sp, ry = hit.vx / sp;
        vt += shot.side * P.SIDE_K * hit.vn * (rx * tx + ry * ty);
        shot.side *= 0.55;
      }
      if (!shot.contacted) shot.s0 = 1; // the cushion leaves it rolling naturally
    }
    b.slip = null;
    Body.setVelocity(b.body, { x: tx * vt + hit.nx * vn, y: ty * vt + hit.ny * vn });
    if (handlers.onCushion) handlers.onCushion(b, hit.vn * P.HZ);
  }

  function resolveBallCollisions() {
    const D = 2 * R, D2 = D * D;
    for (let iter = 0; iter < 4; iter++) {
      let any = false;
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          if (collidePair(balls[i], balls[j], D, D2)) any = true;
        }
      }
      if (!any) break;
    }
  }

  function collidePair(a, b, D, D2) {
    const pa = a.body.position, pb = b.body.position;
    const px = pb.x - pa.x, py = pb.y - pa.y;
    const d2 = px * px + py * py;
    if (d2 >= D2) return false;

    const va = vel(a.body), vb = vel(b.body);
    const rvx = vb.x - va.x, rvy = vb.y - va.y;
    const approach = px * rvx + py * rvy;
    if (approach >= 0) {
      // Overlapping but separating: nudge apart without touching velocities
      const d = Math.sqrt(d2);
      const overlap = D - d;
      if (overlap > 0.05 && d > 1e-6) {
        const ox = (px / d) * overlap * 0.5, oy = (py / d) * overlap * 0.5;
        Body.setPosition(a.body, { x: pa.x - ox, y: pa.y - oy });
        Body.setPosition(b.body, { x: pb.x + ox, y: pb.y + oy });
      }
      return false;
    }

    // Rewind to the instant the balls touched (t in [-1, 0] steps)
    const A = rvx * rvx + rvy * rvy, B = 2 * approach, C = d2 - D2;
    let t = 0;
    if (A > 1e-12) t = (-B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
    t = Math.max(-1, Math.min(0, t));
    const cax = pa.x + va.x * t, cay = pa.y + va.y * t;
    const cbx = pb.x + vb.x * t, cby = pb.y + vb.y * t;
    let nx = cbx - cax, ny = cby - cay;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return false;

    const jImp = (-(1 + P.BALL_E) * vn) / 2;
    const na = { x: va.x - jImp * nx, y: va.y - jImp * ny };
    const nb = { x: vb.x + jImp * nx, y: vb.y + jImp * ny };
    const rem = -t;
    Body.setPosition(a.body, { x: cax + na.x * rem, y: cay + na.y * rem });
    Body.setPosition(b.body, { x: cbx + nb.x * rem, y: cby + nb.y * rem });
    Body.setVelocity(a.body, na);
    Body.setVelocity(b.body, nb);
    a.slip = null;
    b.slip = null;

    // Cue ball's first contact: its spin now takes over
    if (shot && !shot.contacted && (a === shot.ball || b === shot.ball)) {
      shot.contacted = true;
      const pre = a === shot.ball ? va : vb;
      const post = a === shot.ball ? na : nb;
      const sp = Math.hypot(pre.x, pre.y);
      if (sp > 1e-9) {
        const spin = spinAt(shot.s0, shot.v0, shot.dist);
        const fin = cueAfterContact(pre.x / sp, pre.y / sp, sp, post.x, post.y, spin);
        shot.ball.slip = { x: fin.x - post.x, y: fin.y - post.y };
      }
    }

    if (handlers.onBallHit) handlers.onBallHit(a, b, -vn * P.HZ);
    return true;
  }

  function checkPockets() {
    const { W, H } = CFG;
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      const p = b.body.position;
      let pocket = null;
      for (const pk of CFG.POCKETS) {
        const dx = p.x - pk.x, dy = p.y - pk.y;
        if (dx * dx + dy * dy < pk.capture * pk.capture) { pocket = pk; break; }
      }
      // Safety net: anything that leaves the bed counts as potted in the nearest pocket
      if (!pocket && (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40)) {
        pocket = CFG.POCKETS.reduce((best, pk) =>
          Math.hypot(p.x - pk.x, p.y - pk.y) < Math.hypot(p.x - best.x, p.y - best.y) ? pk : best);
      }
      if (pocket) {
        const v = vel(b.body);
        b.potted = true;
        removeBall(b);
        if (handlers.onPot) handlers.onPot(b, pocket, { x: v.x * P.HZ, y: v.y * P.HZ });
      }
    }
  }

  function trackCueBall() {
    const cue = balls.find((b) => b.kind === 'cue');
    if (!cue) return;
    const v = vel(cue.body);
    const d = Math.hypot(v.x, v.y);
    if (shot && shot.ball === cue && !shot.contacted) shot.dist += d;
    if (d > 1e-7) rotate(cue.orient, v.y / d, -v.x / d, 0, d / R);
    if (Math.abs(cue.spinZ) > 1e-6) {
      rotate(cue.orient, 0, 0, 1, cue.spinZ);
      cue.spinZ *= d > 1e-7 ? 0.9985 : 0.99;
    }
    if (stepCount % 240 === 0) orthonormalize(cue.orient);
  }

  // ---------------------------------------------------------------- orientation (cue ball markings)

  function rotate(m, kx, ky, kz, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    const r = [
      c + kx * kx * t, kx * ky * t - kz * s, kx * kz * t + ky * s,
      ky * kx * t + kz * s, c + ky * ky * t, ky * kz * t - kx * s,
      kz * kx * t - ky * s, kz * ky * t + kx * s, c + kz * kz * t,
    ];
    const o = m.slice();
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        m[i * 3 + j] = r[i * 3] * o[j] + r[i * 3 + 1] * o[3 + j] + r[i * 3 + 2] * o[6 + j];
      }
    }
  }

  function orthonormalize(m) {
    const col = (j) => [m[j], m[3 + j], m[6 + j]];
    const set = (j, v) => { m[j] = v[0]; m[3 + j] = v[1]; m[6 + j] = v[2]; };
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
    const a = norm(col(0));
    let b = col(1);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    b = norm([b[0] - dot * a[0], b[1] - dot * a[1], b[2] - dot * a[2]]);
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    set(0, a); set(1, b); set(2, c);
  }

  function randomOrientation() {
    const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    rotate(m, 1, 0, 0, Math.random() * Math.PI * 2);
    rotate(m, 0, 1, 0, Math.random() * Math.PI * 2);
    rotate(m, 0, 0, 1, Math.random() * Math.PI * 2);
    return m;
  }

  // ---------------------------------------------------------------- aiming guide

  function castBalls(ox, oy, dx, dy, ignore) {
    let best = null;
    const D2 = 4 * R * R;
    for (const b of balls) {
      if (ignore.includes(b)) continue;
      const rx = b.body.position.x - ox, ry = b.body.position.y - oy;
      const proj = rx * dx + ry * dy;
      if (proj <= 0) continue;
      const perp2 = rx * rx + ry * ry - proj * proj;
      if (perp2 >= D2) continue;
      const s = proj - Math.sqrt(D2 - perp2);
      if (s < -0.5) continue;
      if (!best || s < best.s) best = { s: Math.max(0, s), ball: b };
    }
    return best;
  }

  // Ray against the rectangle the ball centre can reach, with pocket mouths
  function castWalls(ox, oy, dx, dy) {
    const { W, H, CORNER_JAW: j, MID_HALF: m } = CFG;
    const sx = dx > 0 ? (W - R - ox) / dx : dx < 0 ? (R - ox) / dx : Infinity;
    const sy = dy > 0 ? (H - R - oy) / dy : dy < 0 ? (R - oy) / dy : Infinity;
    const s = Math.max(0, Math.min(sx, sy));
    const x = ox + dx * s, y = oy + dy * s;
    let nx = 0, ny = 0, pocket = null;
    const cornerReach = j - R * 0.15;
    if (sx < sy) {
      nx = dx > 0 ? -1 : 1;
      if (y < cornerReach) pocket = dx > 0 ? 'tr' : 'tl';
      else if (y > H - cornerReach) pocket = dx > 0 ? 'br' : 'bl';
    } else {
      ny = dy > 0 ? -1 : 1;
      const top = dy < 0;
      if (x < cornerReach) pocket = top ? 'tl' : 'bl';
      else if (x > W - cornerReach) pocket = top ? 'tr' : 'br';
      else if (Math.abs(x - W / 2) < m - R * 0.75) pocket = top ? 'tm' : 'bm';
    }
    return { s, x, y, nx, ny, pocket };
  }

  function trace(ox, oy, dx, dy, ignore) {
    const ball = castBalls(ox, oy, dx, dy, ignore);
    const wall = castWalls(ox, oy, dx, dy);
    if (ball && ball.s <= wall.s) {
      return { type: 'ball', s: ball.s, x: ox + dx * ball.s, y: oy + dy * ball.s, ball: ball.ball };
    }
    return { type: 'wall', ...wall };
  }

  function reflect(dx, dy, nx, ny, side, isCue) {
    const vn = dx * nx + dy * ny;
    const tx = -ny, ty = nx;
    let vt = (dx * tx + dy * ty) * P.CUSHION_GRIP;
    if (isCue && Math.abs(side) > 0.01) {
      const rx = -dy, ry = dx;
      vt += side * P.SIDE_K * Math.abs(vn) * (rx * tx + ry * ty);
    }
    const ox = tx * vt - nx * vn * P.CUSHION_E, oy = ty * vt - ny * vn * P.CUSHION_E;
    const l = Math.hypot(ox, oy) || 1;
    return { x: ox / l, y: oy / l };
  }

  // Predict the first contact of a shot for the aiming guide.
  function predict(cue, angle, speed, spinTop, spinSide) {
    const ox = cue.body.position.x, oy = cue.body.position.y;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const out = { segments: [], ghost: null, target: null };
    const first = trace(ox, oy, dx, dy, [cue]);
    out.segments.push({ x1: ox, y1: oy, x2: first.x, y2: first.y });

    if (first.type === 'ball') {
      setContact(out, first, ox, oy, dx, dy, first.s, speed, spinTop, cue);
      return out;
    }
    if (first.pocket) {
      out.pocket = first.pocket;
      return out;
    }
    // One cushion bounce, then the next contact
    const r = reflect(dx, dy, first.nx, first.ny, spinSide, true);
    const second = trace(first.x, first.y, r.x, r.y, [cue]);
    out.segments.push({ x1: first.x, y1: first.y, x2: second.x, y2: second.y, bounce: true });
    if (second.type === 'ball') {
      setContact(out, second, first.x, first.y, r.x, r.y, first.s + second.s, speed, spinTop, cue, true);
    } else if (second.pocket) {
      out.pocket = second.pocket;
    }
    return out;
  }

  function setContact(out, hit, ox, oy, dx, dy, dist, speed, spinTop, cue, afterBounce) {
    const tb = hit.ball.body.position;
    let nx = tb.x - hit.x, ny = tb.y - hit.y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const cut = Math.max(0, dx * nx + dy * ny);
    out.ghost = { x: hit.x, y: hit.y };
    out.target = hit.ball;
    out.afterBounce = !!afterBounce;

    const objSpeed = ((1 + P.BALL_E) / 2) * cut;
    const objTrace = trace(tb.x, tb.y, nx, ny, [cue, hit.ball]);
    out.object = { x1: tb.x, y1: tb.y, dx: nx, dy: ny, len: Math.min(objTrace.s, 50 + 380 * objSpeed), full: objTrace.s, speed: objSpeed };
    if (objTrace.type === 'wall' && objTrace.pocket && objTrace.s <= out.object.len + 1) out.object.pocket = objTrace.pocket;

    const postX = dx - objSpeed * nx, postY = dy - objSpeed * ny;
    const spin = afterBounce ? 1 : spinAt(spinTop * P.SPIN_MAX, speed, dist);
    const fin = cueAfterContact(dx, dy, 1, postX, postY, spin);
    const fl = Math.hypot(fin.x, fin.y);
    if (fl > 0.02) {
      const cdx = fin.x / fl, cdy = fin.y / fl;
      const cueTrace = trace(hit.x, hit.y, cdx, cdy, [cue, hit.ball]);
      out.cueAfter = { x1: hit.x, y1: hit.y, dx: cdx, dy: cdy, len: Math.min(cueTrace.s, 30 + 230 * fl) };
    }
  }

  return {
    init, update, addBall, removeBall, clearBalls, strike, isMoving, isFree, predict, vel,
    get balls() { return balls; },
    find(kind) { return balls.find((b) => b.kind === kind); },
  };
})();
