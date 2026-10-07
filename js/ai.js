// Computer opponent. It finds every pot geometrically, rehearses the most
// promising ones (different weights and spins) on a private copy of the table
// using the game's own physics, and plays the shot that scores best: a pot that
// leaves the cue ball well for the next one, or a safety when nothing is on.
// Difficulty sets how many options it weighs and how accurately it cues.

const AI = (() => {
  const { R, BAULK_X, D_R, MID_Y } = CFG;
  const P = CFG.PHYS;
  const DEG = Math.PI / 180;
  const OPPONENT_AIM = 0.2 * DEG; // assume a capable opponent when judging safeties

  const LEVELS = {
    1: {
      name: 'Amateur', aimError: 0.5 * DEG, powerError: 0.1, position: 0,
      pots: 3, weights: [1.3], spins: [[0, 0]],
      safetyBalls: 3, safetyCuts: [-0.6, 0, 0.6], safetyPowers: [0.3],
    },
    2: {
      name: 'Pro', aimError: 0.2 * DEG, powerError: 0.05, position: 350,
      pots: 5, weights: [1.15, 1.7], spins: [[0, 0], [0, -0.6], [0, 0.55]],
      safetyBalls: 5, safetyCuts: [-0.8, -0.4, 0, 0.4, 0.8], safetyPowers: [0.22, 0.42],
    },
    3: {
      name: 'Champion', aimError: 0.08 * DEG, powerError: 0.025, position: 600,
      pots: 6, weights: [1.1, 1.5, 2.1], spins: [[0, 0], [0, -0.7], [0, 0.6], [0.45, -0.35]],
      safetyBalls: 6, safetyCuts: [-0.85, -0.45, 0, 0.45, 0.85], safetyPowers: [0.2, 0.36, 0.55],
    },
  };

  let sim = null;
  let record = null;
  let job = null;

  function ensureSim() {
    if (sim) return;
    sim = createPhysics();
    sim.init({
      onBallHit(a, b) {
        if (record.firstHit) return;
        if (a.kind === 'cue') record.firstHit = b.kind;
        else if (b.kind === 'cue') record.firstHit = a.kind;
      },
      onPot(ball) { record.potted.push(ball.kind); },
    });
  }

  // ---------------------------------------------------------------- maths

  function erf(x) {
    const t = 1 / (1 + 0.3275911 * x);
    return 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  }

  function gauss() {
    const u = 1 - Math.random(), v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Distance a ball rolls from speed v under the cloth model (rolling resistance + drag)
  function rollDistance(v) {
    const a = P.ROLL_DECEL, k = P.DRAG;
    return v / k - (a / (k * k)) * Math.log(1 + (v * k) / a);
  }

  function speedForDistance(d) {
    let lo = 0, hi = P.MAX_SPEED * 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rollDistance(mid) < d) lo = mid; else hi = mid;
    }
    return hi;
  }

  // ---------------------------------------------------------------- geometry

  function kindsOn() {
    const on = Rules.state.on;
    if (on === 'red') return ['red'];
    if (on === 'colour') return CFG.COLOURS;
    return [on];
  }

  // Line-up for potting `ball` into `pocket` from (cx, cy), or null if it isn't on
  function potLine(world, cx, cy, ball, pocket, cueBall) {
    const tx = ball.body.position.x, ty = ball.body.position.y;
    let ux = pocket.x - tx, uy = pocket.y - ty;
    const dObj = Math.hypot(ux, uy);
    ux /= dObj;
    uy /= dObj;

    // The jaws only accept balls arriving within a certain angle
    let approach;
    if (pocket.corner) {
      const sx = Math.sign(pocket.x - CFG.W / 2), sy = Math.sign(pocket.y - CFG.H / 2);
      approach = (ux * sx + uy * sy) / Math.SQRT2;
      if (approach < Math.cos(58 * DEG)) return null;
    } else {
      approach = uy * Math.sign(pocket.y);
      if (approach < Math.cos(42 * DEG)) return null;
    }

    const gx = tx - ux * 2 * R, gy = ty - uy * 2 * R;
    let vx = gx - cx, vy = gy - cy;
    const dCue = Math.hypot(vx, vy);
    if (dCue < 1) return null;
    vx /= dCue;
    vy /= dCue;
    const cosCut = vx * ux + vy * uy;
    if (cosCut < Math.cos(80 * DEG)) return null;

    const ignore = cueBall ? [cueBall] : [];
    const first = world.castBalls(cx, cy, vx, vy, ignore);
    if (!first || first.ball !== ball || Math.abs(first.s - dCue) > 1.5) return null;
    const block = world.castBalls(tx, ty, ux, uy, [ball, ...ignore]);
    if (block && block.s < dObj - R) return null;

    return { ball, pocket, angle: Math.atan2(vy, vx), cosCut, dCue, dObj, approach };
  }

  // Chance of potting given the cueing error: a small aim error at the cue ball
  // is magnified by the distance to the object ball, thin cuts and the distance
  // the object ball then has to travel.
  function potChance(line, aimError) {
    const sensitivity = line.dCue / (2 * R * Math.max(line.cosCut, 0.2));
    const spread = line.dObj * aimError * sensitivity + 0.5;
    const tolerance = line.pocket.corner ? 9 * line.approach : 6.5 * line.approach;
    return erf(tolerance / (spread * Math.SQRT2));
  }

  function valueWeight(kind, kinds) {
    return kinds.length > 1 ? 0.55 + 0.45 * (CFG.BALLS[kind].value / 7) : 1;
  }

  function potLines(world, cx, cy, kinds, cueBall) {
    const lines = [];
    for (const b of world.balls) {
      if (!kinds.includes(b.kind)) continue;
      for (const pk of CFG.POCKETS) {
        const line = potLine(world, cx, cy, b, pk, cueBall);
        if (line) lines.push(line);
      }
    }
    return lines;
  }

  // How good the best available pot is from a cue ball position (0..1)
  function bestPot(world, pos, kinds, aimError) {
    if (!pos) return 0;
    if (!kinds.length) return 1;
    const cueBall = world.find('cue');
    let best = 0;
    for (const line of potLines(world, pos.x, pos.y, kinds, cueBall)) {
      best = Math.max(best, potChance(line, aimError) * valueWeight(line.ball.kind, kinds));
    }
    return best;
  }

  // What the striker will be on after a successful pot
  function kindsAfterPot(pots) {
    const on = Rules.state.on;
    if (on === 'red') return CFG.COLOURS;
    if (on === 'colour') return Rules.state.redsLeft > 0 ? ['red'] : ['yellow'];
    const next = CFG.COLOURS[CFG.COLOURS.indexOf(pots[0]) + 1];
    return next ? [next] : [];
  }

  // What the opponent will be on after a legal shot that pots nothing
  function kindsForOpponent() {
    const on = Rules.state.on;
    if (on === 'red' || on === 'colour') return Rules.state.redsLeft > 0 ? ['red'] : ['yellow'];
    return [on];
  }

  // ---------------------------------------------------------------- rehearsal

  function rehearse(cue, angle, power, spinX, spinY) {
    sim.clearBalls();
    for (const b of Physics.balls) {
      if (b.kind !== 'cue') sim.addBall(b.kind, b.body.position.x, b.body.position.y);
    }
    const ball = sim.addBall('cue', cue.x, cue.y);
    record = { firstHit: null, potted: [] };
    sim.strike(ball, Math.cos(angle), Math.sin(angle), power * P.MAX_SPEED, spinY, spinX);
    sim.simulate(12);
    const after = sim.find('cue');
    return { firstHit: record.firstHit, potted: record.potted.slice(), cue: after ? { x: after.body.position.x, y: after.body.position.y } : null };
  }

  // A cue ball that stops near a pocket in rehearsal could easily drop in for real
  function inOffRisk(pos) {
    if (!pos) return 0;
    let risk = 0;
    for (const pk of CFG.POCKETS) {
      const d = Math.hypot(pos.x - pk.x, pos.y - pk.y) - pk.capture;
      risk = Math.max(risk, 1 - Math.min(1, d / (3 * R)));
    }
    return risk;
  }

  function score(out, L, chance) {
    const verdict = Rules.assess(out);
    if (verdict.foul) return -800 - 30 * verdict.penalty;
    const risk = 300 * inOffRisk(out.cue);
    if (verdict.points > 0) {
      const next = L.position ? bestPot(sim, out.cue, kindsAfterPot(verdict.pots), L.aimError) : 0;
      return chance * (1000 + verdict.points * 25 + L.position * next) - (1 - chance) * 150 - risk;
    }
    // A legal shot that pots nothing: as good as what it leaves the opponent,
    // ideally with the cue ball far from the balls they are on
    const opp = kindsForOpponent();
    return 250 - 450 * bestPot(sim, out.cue, opp, OPPONENT_AIM) + 60 * Math.min(1, nearest(sim, out.cue, opp) / 450) - risk;
  }

  function nearest(world, pos, kinds) {
    if (!pos) return 0;
    let d = Infinity;
    for (const b of world.balls) {
      if (kinds.includes(b.kind)) d = Math.min(d, Math.hypot(b.body.position.x - pos.x, b.body.position.y - pos.y));
    }
    return d === Infinity ? 0 : d;
  }

  function powerFor(line, weight) {
    const objSpeed = speedForDistance(line.dObj + 30) * weight;
    const contact = objSpeed / (((1 + P.BALL_E) / 2) * Math.max(line.cosCut, 0.15));
    const start = speedForDistance(rollDistance(contact) + line.dCue);
    return Math.min(1, Math.max(0.06, start / P.MAX_SPEED));
  }

  // Ball in hand: the spot in the D with the best pot, else beside the yellow
  function choosePlacement(L, kinds) {
    let best = null;
    for (let i = 0; i <= 8; i++) {
      for (const f of [0.2, 0.45, 0.7, 0.92]) {
        const a = Math.PI / 2 + (Math.PI * i) / 8;
        const p = { x: BAULK_X + Math.cos(a) * D_R * f, y: MID_Y + Math.sin(a) * D_R * f };
        if (!Physics.isFree(p.x, p.y)) continue;
        const v = bestPot(Physics, p, kinds, L.aimError);
        if (!best || v > best.v) best = { ...p, v };
      }
    }
    if (!best || best.v < 0.2) {
      const spots = [{ x: BAULK_X, y: MID_Y + D_R * 0.55 }, { x: BAULK_X, y: MID_Y - D_R * 0.55 }, { x: BAULK_X - D_R * 0.5, y: MID_Y }];
      const free = spots.find((p) => Physics.isFree(p.x, p.y));
      if (free) return free;
    }
    return best ? { x: best.x, y: best.y } : { x: BAULK_X - D_R * 0.5, y: MID_Y };
  }

  // ---------------------------------------------------------------- planning

  function* think(L) {
    ensureSim();
    const kinds = kindsOn();
    const cueBall = Physics.find('cue');
    const place = cueBall ? null : choosePlacement(L, kinds);
    const C = cueBall ? { x: cueBall.body.position.x, y: cueBall.body.position.y } : place;
    let best = null;
    const consider = (shot, value) => {
      if (!best || value > best.value) best = { ...shot, value };
    };
    yield;

    // 1. Pots, most makeable first
    const lines = potLines(Physics, C.x, C.y, kinds, cueBall)
      .map((line) => ({ line, chance: potChance(line, L.aimError) }))
      .sort((a, b) => b.chance * valueWeight(b.line.ball.kind, kinds) - a.chance * valueWeight(a.line.ball.kind, kinds))
      .slice(0, L.pots);
    for (const { line, chance } of lines) {
      let first = true;
      variants:
      for (const w of L.weights) {
        for (const [sx, sy] of L.spins) {
          const shot = { angle: line.angle, power: powerFor(line, w), spinX: sx, spinY: sy, intent: 'pot', target: line.ball.kind };
          const out = rehearse(C, shot.angle, shot.power, sx, sy);
          consider(shot, score(out, L, chance));
          yield;
          // If the plain version doesn't even go in, the line is no good
          if (first && !out.potted.includes(line.ball.kind)) break variants;
          first = false;
        }
      }
    }

    // 2. Safeties, unless there is a pot well worth taking. Every ball on is a
    // target if some contact on it, full to thin, can be reached directly.
    if (!best || best.value < 400) {
      const ignore = cueBall ? [cueBall] : [];
      const targets = [];
      for (const b of Physics.balls) {
        if (!kinds.includes(b.kind)) continue;
        const tx = b.body.position.x, ty = b.body.position.y;
        const d = Math.hypot(tx - C.x, ty - C.y);
        const nx = (tx - C.x) / d, ny = (ty - C.y) / d;
        const angles = [];
        for (const f of L.safetyCuts) {
          const angle = Math.atan2(ty + nx * f * 2 * R - C.y, tx - ny * f * 2 * R - C.x);
          const hit = Physics.castBalls(C.x, C.y, Math.cos(angle), Math.sin(angle), ignore);
          if (hit && hit.ball === b) angles.push(angle);
        }
        if (angles.length) targets.push({ d, angles });
      }
      targets.sort((a, b) => a.d - b.d);
      const step = Math.max(1, targets.length / L.safetyBalls);
      const picked = [];
      for (let i = 0; i < targets.length && picked.length < L.safetyBalls; i += step) picked.push(targets[Math.floor(i)]);

      for (const t of picked) {
        for (const angle of t.angles) {
          for (const power of L.safetyPowers) {
            const out = rehearse(C, angle, power, 0, 0);
            consider({ angle, power, spinX: 0, spinY: 0, intent: 'safety' }, score(out, L, 0.5));
            yield;
          }
        }
      }

      // 3. Snookered: look for a way out off a cushion
      if (!picked.length && cueBall) {
        const escapes = [];
        for (let k = 0; k < 180; k++) {
          const angle = k * 2 * DEG;
          const pred = Physics.predict(cueBall, angle, 700, 0, 0);
          if (pred.target && Rules.isOn(pred.target.kind)) escapes.push(angle);
        }
        const every = Math.max(1, Math.floor(escapes.length / 6));
        for (let i = 0; i < escapes.length; i += every) {
          for (const power of [0.35, 0.55]) {
            const out = rehearse(C, escapes[i], power, 0, 0);
            consider({ angle: escapes[i], power, spinX: 0, spinY: 0, intent: 'escape' }, score(out, L, 0.5));
            yield;
          }
        }
      }
    }

    // 4. Still nothing legal: rehearse a sweep of multi-cushion escapes
    if (!best || best.value < -500) {
      for (let k = 0; k < 48; k++) {
        const angle = (k / 48) * Math.PI * 2;
        const out = rehearse(C, angle, 0.55, 0, 0);
        consider({ angle, power: 0.55, spinX: 0, spinY: 0, intent: 'escape' }, score(out, L, 0.5));
        yield;
      }
    }

    // 5. Nothing found at all: play at the nearest ball on and hope
    if (!best) {
      const near = Physics.balls
        .filter((b) => kinds.includes(b.kind))
        .sort((a, b) => Math.hypot(a.body.position.x - C.x, a.body.position.y - C.y) - Math.hypot(b.body.position.x - C.x, b.body.position.y - C.y))[0];
      const angle = near ? Math.atan2(near.body.position.y - C.y, near.body.position.x - C.x) : 0;
      best = { angle, power: 0.4, spinX: 0, spinY: 0, intent: 'hope', value: -1000 };
    }

    // Human-like cueing error
    return {
      place,
      angle: best.angle + gauss() * L.aimError,
      power: Math.min(1, Math.max(0.04, best.power * (1 + gauss() * L.powerError))),
      spinX: best.spinX,
      spinY: best.spinY,
      intent: best.intent,
      value: best.value,
    };
  }

  // Thinking is spread over frames so the game keeps animating
  function begin(level) {
    job = think(LEVELS[level] || LEVELS[2]);
  }

  function step(budgetMs) {
    if (!job) return null;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      const r = job.next();
      if (r.done) {
        job = null;
        return r.value;
      }
    }
    return null;
  }

  function cancel() {
    job = null;
  }

  return { begin, step, cancel, LEVELS };
})();
