// Snooker: p5.js entry point and game controller.
// Wires physics, rules, rendering, sound and the HUD together and handles input.

const Game = {
  state: 'menu', // menu | place | aim | strike | roll | over
  paused: false,
  matchActive: false,
  mode: 1,
  aim: { angle: 0, power: 0, dragging: false, dragFrom: null, lastTarget: null, touchAiming: false, barCharging: false },
  spin: { x: 0, y: 0 },
  showGuide: true,
  pointer: { x: 0, y: 0, over: false, type: 'mouse' },
  falling: [],
  shot: null,
  strike: null,
  anchor: null, // where the cue sat when the ball was struck
  cueAlpha: 1,
  ballInHand: true,
  time: 0,
  resultTimer: 0,
  lastResult: null,
  // Computer opponent (plays as player 2). level 0 = two human players.
  ai: { level: 0, phase: null, t: 0, plan: null, fromAngle: 0, fromSpin: null, ghost: null, savedSpin: null },
};

const STORAGE_KEY = 'snooker.settings.v1';
let canvasEl = null;

// ---------------------------------------------------------------- p5 lifecycle

function setup() {
  const stage = document.getElementById('stage');
  const cnv = createCanvas(stage.clientWidth, stage.clientHeight);
  cnv.parent('stage');
  canvasEl = cnv.elt;
  noiseSeed(7);
  Renderer.resize(width, height, pixelDensity());

  Physics.init({ onBallHit, onCushion, onPot });
  HUD.init({
    onStart: startMatch,
    onResume: resume,
    onNext: nextFrame,
    onToggleGuide: toggleGuide,
    onToggleSound: toggleSound,
    onMenu: openMenu,
    onSpin: (x, y) => { if (!isAITurn()) setSpin(x, y); },
    onPowerStart: powerBarStart,
    onPowerMove: powerBarMove,
    onPowerEnd: powerBarEnd,
  });

  const settings = loadSettings();
  Game.showGuide = settings.guide !== false;
  SFX.setMuted(!!settings.muted);
  HUD.setMenuDefaults(settings);
  HUD.setToggles(Game.showGuide, SFX.muted);
  HUD.setSpin(0, 0);
  HUD.setPower(0);

  // A racked table sits behind the start menu
  Rules.newMatch(['Player 1', 'Player 2'], settings.bestOf || 3);
  rack(1);
  Rules.newFrame(15);
  Physics.addBall('cue', CFG.BAULK_X - 22, CFG.MID_Y + 28);
  HUD.update();
  HUD.showMenu(false);

  bindInput();
}

function draw() {
  const dt = Math.min(deltaTime / 1000, 0.05);
  if (!Game.paused) update(dt);
  Renderer.frame(drawingContext, sceneData());
}

function windowResized() {
  const stage = document.getElementById('stage');
  resizeCanvas(stage.clientWidth, stage.clientHeight);
  Renderer.resize(width, height, pixelDensity());
}

// ---------------------------------------------------------------- match flow

function startMatch(names, mode, bestOf, aiLevel) {
  SFX.init();
  saveSettings({ names, mode, bestOf, ai: aiLevel });
  Game.mode = mode;
  Game.ai.level = aiLevel;
  Game.ai.savedSpin = null;
  Game.matchActive = true;
  Game.paused = false;
  Rules.newMatch(names, bestOf);
  HUD.hideMenu();
  HUD.hideResult();
  startFrame();
}

function startFrame() {
  rack(Game.mode);
  Rules.newFrame(Physics.balls.filter((b) => b.kind === 'red').length);
  Game.ballInHand = true;
  Game.state = 'place';
  Game.shot = null;
  Game.strike = null;
  resetAI();
  Game.aim.angle = 0;
  Game.aim.dragging = false;
  setPower(0);
  setSpin(0, 0);
  HUD.update();
  const s = Rules.state;
  HUD.banner(`${s.players[s.current]} to break`, `Frame ${s.frameNo + 1} · place the cue ball in the D`, 'info', 2600);
}

function nextFrame() {
  HUD.hideResult();
  if (Rules.state.matchOver) {
    Game.matchActive = false;
    openMenu();
    return;
  }
  startFrame();
}

function openMenu() {
  if (HUD.menuOpen()) return;
  Game.paused = Game.matchActive;
  Game.aim.dragging = false;
  HUD.showMenu(Game.matchActive && Game.state !== 'over');
}

function resume() {
  SFX.init();
  Game.paused = false;
  HUD.hideMenu();
}

// Lay out the balls. 1: standard rack, 2: reds scattered, 3: everything scattered
function rack(mode) {
  Physics.clearBalls();
  Game.falling = [];
  const { R, SPOTS, MID_Y } = CFG;

  if (mode === 3) {
    for (const c of CFG.COLOURS) placeRandom(c);
  } else {
    for (const c of CFG.COLOURS) Physics.addBall(c, SPOTS[c].x, SPOTS[c].y);
  }

  if (mode === 1) {
    const gap = 0.35;
    const apex = SPOTS.pink.x + 2 * R + 1.4;
    for (let row = 0; row < 5; row++) {
      for (let k = 0; k <= row; k++) {
        Physics.addBall('red', apex + row * (Math.sqrt(3) * R + gap), MID_Y + (k - row / 2) * (2 * R + gap));
      }
    }
  } else {
    for (let i = 0; i < 15; i++) placeRandom('red');
  }
}

function placeRandom(kind) {
  const { W, H, R, BAULK_X, D_R, MID_Y } = CFG;
  for (let tries = 0; tries < 800; tries++) {
    const x = R * 2 + Math.random() * (W - R * 4);
    const y = R * 2 + Math.random() * (H - R * 4);
    if (Math.hypot(x - BAULK_X, y - MID_Y) < D_R + R * 2 && x < BAULK_X + R * 2) continue;
    if (CFG.POCKETS.some((p) => Math.hypot(x - p.x, y - p.y) < p.capture + R * 3)) continue;
    if (Object.values(CFG.SPOTS).some((s) => Math.hypot(x - s.x, y - s.y) < R * 2.2)) continue;
    if (!Physics.isFree(x, y)) continue;
    return Physics.addBall(kind, x, y);
  }
  return null;
}

// Re-spot a colour: own spot, else the highest free spot, else as near as
// possible to its own spot towards the top cushion (then towards baulk).
function respot(kind) {
  const spot = CFG.SPOTS[kind];
  const free = (p) => Physics.isFree(p.x, p.y);
  let pos = free(spot) ? spot : null;
  if (!pos) pos = ['black', 'pink', 'blue', 'brown', 'green', 'yellow'].map((k) => CFG.SPOTS[k]).find(free) || null;
  for (let x = spot.x; !pos && x < CFG.W - CFG.R; x += 0.5) if (free({ x, y: spot.y })) pos = { x, y: spot.y };
  for (let x = spot.x; !pos && x > CFG.R; x -= 0.5) if (free({ x, y: spot.y })) pos = { x, y: spot.y };
  if (pos) Physics.addBall(kind, pos.x, pos.y).appear = 0;
}

// ---------------------------------------------------------------- physics callbacks

function onBallHit(a, b, speed) {
  SFX.ballHit(speed / 900);
  if (Game.shot && !Game.shot.firstHit) {
    if (a.kind === 'cue') Game.shot.firstHit = b.kind;
    else if (b.kind === 'cue') Game.shot.firstHit = a.kind;
  }
}

function onCushion(ball, speed) {
  SFX.cushion(speed / 1100);
}

function onPot(ball, pocket, v) {
  SFX.pocket(Math.hypot(v.x, v.y) / 800);
  const p = ball.body.position;
  Game.falling.push({ kind: ball.kind, x: p.x, y: p.y, pocket, t: 0, dur: 0.34 });
  if (!Game.shot) return;
  Game.shot.potted.push(ball.kind);
  if (ball.kind !== 'cue' && wouldScore(ball.kind)) {
    const toCentre = Math.atan2(CFG.MID_Y - pocket.y, CFG.W / 2 - pocket.x);
    const def = CFG.BALLS[ball.kind];
    const color = ball.kind === 'black' ? '#f2f2f2' : ball.kind === 'red' ? '#ff6b6b' : def.color;
    Renderer.popup(`+${def.value}`, pocket.x + Math.cos(toCentre) * 34, pocket.y + Math.sin(toCentre) * 34, color);
  }
}

// Optimistic check for the "+points" popup; the referee decides after the shot
function wouldScore(kind) {
  const on = Rules.on;
  if (on === 'red') return kind === 'red';
  if (on === 'colour') return kind === Game.shot.firstHit && Rules.isColour(kind);
  return kind === on;
}

// ---------------------------------------------------------------- update

function update(dt) {
  Game.time += dt;
  Physics.update(dt);
  Renderer.update(dt);

  for (const f of Game.falling) f.t += dt;
  Game.falling = Game.falling.filter((f) => f.t < f.dur);
  for (const b of Physics.balls) if (b.appear !== undefined && b.appear < 1) b.appear = Math.min(1, b.appear + dt * 3.5);

  if (Game.state === 'strike') updateStrike(dt);
  if (Game.state === 'roll') {
    Game.cueAlpha = Math.max(0, Game.cueAlpha - dt * 2.4);
    if (Game.strike) Game.strike.t += dt;
    if (!Physics.isMoving() && Game.falling.length === 0) endShot();
  }
  if (Game.state === 'over' && Game.resultTimer > 0) {
    Game.resultTimer -= dt;
    if (Game.resultTimer <= 0) HUD.showResult(Game.lastResult);
  }
  if (isAITurn() && (Game.state === 'aim' || Game.state === 'place')) updateAI(dt);
  updateHint();
}

// ---------------------------------------------------------------- computer opponent

function isAITurn() {
  return Game.ai.level > 0 && Game.matchActive && Rules.state.current === 1 && !Rules.state.frameOver;
}

function resetAI() {
  AI.cancel();
  Object.assign(Game.ai, { phase: null, t: 0, plan: null, ghost: null });
}

const smooth = (t) => t * t * (3 - 2 * t);

// The computer thinks (spread over frames), then plays its shot the way a
// player would: place the cue ball, line up, set the spin, draw back, strike.
function updateAI(dt) {
  const ai = Game.ai;
  if (!ai.phase) {
    if (!ai.savedSpin) ai.savedSpin = { ...Game.spin };
    AI.begin(ai.level);
    Object.assign(ai, { phase: 'think', t: 0, plan: null });
    setPower(0);
  }
  ai.t += dt;

  if (ai.phase === 'think') {
    if (!ai.plan) ai.plan = AI.step(10);
    if (ai.plan && ai.t >= 0.8) {
      ai.t = 0;
      if (ai.plan.place) {
        ai.phase = 'place';
        ai.ghost = { x: CFG.BAULK_X - CFG.D_R * 0.35, y: CFG.MID_Y };
        ai.ghostFrom = { ...ai.ghost };
      } else {
        startAIAim();
      }
    }
  } else if (ai.phase === 'place') {
    const k = smooth(Math.min(1, ai.t / 0.6));
    ai.ghost = {
      x: ai.ghostFrom.x + (ai.plan.place.x - ai.ghostFrom.x) * k,
      y: ai.ghostFrom.y + (ai.plan.place.y - ai.ghostFrom.y) * k,
    };
    if (ai.t >= 0.8) {
      Physics.addBall('cue', ai.plan.place.x, ai.plan.place.y);
      Game.state = 'aim';
      ai.ghost = null;
      SFX.cushion(0.15);
      startAIAim();
    }
  } else if (ai.phase === 'aim') {
    const k = smooth(Math.min(1, ai.t / 0.9));
    const turn = Math.atan2(Math.sin(ai.plan.angle - ai.fromAngle), Math.cos(ai.plan.angle - ai.fromAngle));
    Game.aim.angle = ai.fromAngle + turn * k;
    setSpin(ai.fromSpin.x + (ai.plan.spinX - ai.fromSpin.x) * k, ai.fromSpin.y + (ai.plan.spinY - ai.fromSpin.y) * k);
    if (ai.t >= 1.2) {
      ai.phase = 'power';
      ai.t = 0;
    }
  } else if (ai.phase === 'power') {
    setPower(ai.plan.power * smooth(Math.min(1, ai.t / 0.5)));
    if (ai.t >= 0.75) {
      Game.aim.angle = ai.plan.angle;
      ai.phase = null;
      shoot(ai.plan.power);
    }
  }
}

function startAIAim() {
  const ai = Game.ai;
  ai.phase = 'aim';
  ai.t = 0;
  ai.fromAngle = Game.aim.angle;
  ai.fromSpin = { ...Game.spin };
}

function updateStrike(dt) {
  const s = Game.strike;
  s.t += dt;
  if (s.t >= s.dur) fire();
}

function shoot(power) {
  const cue = Physics.find('cue');
  if (Game.state !== 'aim' || !cue || power < 0.015) {
    setPower(0);
    return;
  }
  SFX.init();
  Game.aim.dragging = false;
  Game.state = 'strike';
  Game.anchor = { x: cue.body.position.x, y: cue.body.position.y };
  Game.strike = { t: 0, dur: 0.05 + (1 - power) * 0.07, power, pull: pullFor(power) };
  Game.cueAlpha = 1;
}

function fire() {
  const cue = Physics.find('cue');
  const s = Game.strike;
  const dx = Math.cos(Game.aim.angle), dy = Math.sin(Game.aim.angle);
  Game.shot = { firstHit: null, potted: [] };
  Physics.strike(cue, dx, dy, s.power * CFG.PHYS.MAX_SPEED, Game.spin.y, Game.spin.x);
  SFX.cueStrike(s.power);
  const p = cue.body.position;
  Renderer.chalk(p.x - dx * CFG.R, p.y - dy * CFG.R, dx, dy);
  s.t = 0;
  Game.state = 'roll';
  setPower(0);
}

function endShot() {
  const shot = Game.shot || { firstHit: null, potted: [] };
  Game.shot = null;
  const prevBreak = Rules.state.breakPoints;
  const r = Rules.judge(shot);
  const s = Rules.state;

  for (const k of r.respot) respot(k);

  const cue = Physics.find('cue');
  if (r.ballInHand && cue) Physics.removeBall(cue);
  Game.ballInHand = r.ballInHand;
  if (Game.ai.savedSpin && !isAITurn()) {
    setSpin(Game.ai.savedSpin.x, Game.ai.savedSpin.y);
    Game.ai.savedSpin = null;
  }

  HUD.update();

  if (r.frameOver) {
    Game.state = 'over';
    Game.lastResult = { ...r, frameScores: s.scores.slice() };
    Game.resultTimer = 1.1;
    SFX.applause(r.matchOver ? 5 : 3.5, r.matchOver ? 1.2 : 0.9);
    const w = s.players[r.winner];
    HUD.banner(r.matchOver ? 'Match won' : 'Frame won', w, 'gold', 2200);
    return;
  }

  Game.state = r.ballInHand ? 'place' : 'aim';

  if (r.foul) {
    SFX.chime(false);
    HUD.banner(`Foul · ${r.penalty} away`, `${r.reasons.join(' · ')}`, 'foul', 2800);
  } else if (r.respottedBlack) {
    HUD.banner('Re-spotted black', 'Scores level, the black decides it', 'gold', 3000);
  } else if (s.breakPoints >= 100 && prevBreak < 100) {
    SFX.applause(4, 1);
    HUD.banner(s.breakPoints === 147 ? 'Maximum break!' : 'Century break!', `${s.players[s.current]} · ${s.breakPoints}`, 'gold', 3200);
  } else if (r.switched) {
    if (r.breakEnded >= 50) SFX.applause(2.5, 0.7);
    const sub = r.breakEnded >= 20 ? `Break of ${r.breakEnded} ends` : 'No score';
    HUD.banner(`${s.players[s.current]} to play`, sub, 'info', 1800);
  }
}

// ---------------------------------------------------------------- aiming & input

function pullFor(power) {
  return power * CFG.CUE.MAX_PULL;
}

function setPower(p) {
  Game.aim.power = Math.max(0, Math.min(1, p));
  HUD.setPower(Game.aim.power);
}

function setSpin(x, y) {
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  Game.spin.x = x;
  Game.spin.y = y;
  HUD.setSpin(x, y);
}

function aimAt(p, fine) {
  const cue = Physics.find('cue');
  if (!cue) return;
  const dx = p.x - cue.body.position.x, dy = p.y - cue.body.position.y;
  if (Math.hypot(dx, dy) < CFG.R * 0.6) return;
  const target = Math.atan2(dy, dx);
  if (fine && Game.aim.lastTarget !== null) {
    Game.aim.angle += Math.atan2(Math.sin(target - Game.aim.lastTarget), Math.cos(target - Game.aim.lastTarget)) * 0.1;
  } else {
    Game.aim.angle = target;
  }
  Game.aim.lastTarget = target;
}

function placementFor(p) {
  const { BAULK_X, D_R, MID_Y } = CFG;
  let x = Math.min(p.x, BAULK_X), y = p.y;
  const dx = x - BAULK_X, dy = y - MID_Y, d = Math.hypot(dx, dy);
  if (d > D_R) { x = BAULK_X + (dx / d) * D_R; y = MID_Y + (dy / d) * D_R; }
  return { x, y, valid: Physics.isFree(x, y) };
}

function placeCueBall() {
  const pl = placementFor(Game.pointer);
  if (!pl.valid) return;
  Physics.addBall('cue', pl.x, pl.y);
  Game.state = 'aim';
  Game.aim.lastTarget = null;
  SFX.cushion(0.15);
}

function pickUpCueBall() {
  const cue = Physics.find('cue');
  if (!Game.ballInHand || !cue || Game.state !== 'aim') return;
  Physics.removeBall(cue);
  Game.state = 'place';
  setPower(0);
}

function canInteract() {
  return !Game.paused && !HUD.menuOpen() && !HUD.helpOpen() && Game.state !== 'menu' && !isAITurn();
}

function pointerScene(e) {
  const r = canvasEl.getBoundingClientRect();
  return Renderer.toScene(e.clientX - r.left, e.clientY - r.top);
}

function bindInput() {
  canvasEl.style.touchAction = 'none';
  canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

  canvasEl.addEventListener('pointerdown', (e) => {
    if (!canInteract()) return;
    SFX.init();
    Object.assign(Game.pointer, pointerScene(e), { type: e.pointerType, over: true });
    if (e.button === 2) {
      cancelDrag();
      return;
    }
    if (Game.state === 'place') {
      if (e.pointerType === 'mouse') placeCueBall();
      return;
    }
    if (Game.state !== 'aim') return;
    const cue = Physics.find('cue');
    const p = Game.pointer;
    if (Game.ballInHand && cue && Math.hypot(p.x - cue.body.position.x, p.y - cue.body.position.y) < CFG.R * 1.3) {
      pickUpCueBall();
      return;
    }
    if (e.pointerType === 'mouse') {
      Game.aim.dragging = true;
      Game.aim.dragFrom = { x: p.x, y: p.y };
      setPower(0);
    } else {
      Game.aim.touchAiming = true;
      Game.aim.lastTarget = null;
      aimAt(p, false);
    }
  });

  window.addEventListener('pointermove', (e) => {
    const p = pointerScene(e);
    Game.pointer.x = p.x;
    Game.pointer.y = p.y;
    Game.pointer.type = e.pointerType;
    Game.pointer.over = e.target === canvasEl || Game.aim.dragging;
    if (!canInteract() || Game.aim.barCharging) return;
    if (Game.state === 'aim') {
      if (Game.aim.dragging) {
        const dx = Math.cos(Game.aim.angle), dy = Math.sin(Game.aim.angle);
        const pull = -((p.x - Game.aim.dragFrom.x) * dx + (p.y - Game.aim.dragFrom.y) * dy);
        setPower(pull / CFG.CUE.DRAG_FULL);
      } else if ((e.pointerType === 'mouse' && e.target === canvasEl) || Game.aim.touchAiming) {
        aimAt(p, e.shiftKey);
      }
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (Game.aim.touchAiming) Game.aim.touchAiming = false;
    if (Game.state === 'place' && e.pointerType !== 'mouse' && e.target === canvasEl && canInteract()) {
      placeCueBall();
      return;
    }
    if (Game.aim.dragging) {
      Game.aim.dragging = false;
      shoot(Game.aim.power);
    }
  });

  canvasEl.addEventListener('wheel', (e) => {
    if (!canInteract() || Game.state !== 'aim' || Game.aim.dragging) return;
    e.preventDefault();
    Game.aim.angle += Math.sign(e.deltaY) * (e.shiftKey ? 0.0004 : 0.0025);
  }, { passive: false });

  window.addEventListener('keydown', onKey);
}

function cancelDrag() {
  Game.aim.dragging = false;
  setPower(0);
}

function onKey(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    if (e.key === 'Enter' && HUD.menuOpen()) document.getElementById('btnStart').click();
    return;
  }
  const k = e.key;
  if (k === 'Escape') {
    if (HUD.helpOpen()) HUD.toggleHelp(false);
    else if (Game.aim.dragging) cancelDrag();
    else if (HUD.menuOpen()) { if (Game.matchActive && Game.state !== 'over') resume(); }
    else openMenu();
    return;
  }
  if (k === 'h' || k === 'H' || k === '?') { HUD.toggleHelp(); return; }
  if (k === 'g' || k === 'G') { toggleGuide(); return; }
  if (k === 'm' || k === 'M') { toggleSound(); return; }
  if (!canInteract()) return;

  const aiming = Game.state === 'aim' && !Game.aim.dragging;
  const step = e.shiftKey ? 0.0175 : 0.0015;
  switch (k) {
    case 'ArrowLeft':
      if (aiming) Game.aim.angle -= step;
      break;
    case 'ArrowRight':
      if (aiming) Game.aim.angle += step;
      break;
    case 'ArrowUp':
      if (aiming) setPower(Game.aim.power + (e.shiftKey ? 0.1 : 0.02));
      break;
    case 'ArrowDown':
      if (aiming) setPower(Game.aim.power - (e.shiftKey ? 0.1 : 0.02));
      break;
    case ' ':
    case 'Enter':
      if (aiming) shoot(Game.aim.power);
      break;
    case 'w': case 'W': setSpin(Game.spin.x, Game.spin.y + 0.1); break;
    case 's': case 'S': setSpin(Game.spin.x, Game.spin.y - 0.1); break;
    case 'a': case 'A': setSpin(Game.spin.x - 0.1, Game.spin.y); break;
    case 'd': case 'D': setSpin(Game.spin.x + 0.1, Game.spin.y); break;
    case 'c': case 'C': setSpin(0, 0); break;
    case 'r': case 'R': pickUpCueBall(); break;
    case '1': case '2': case '3':
      if (Game.matchActive && (Game.state === 'aim' || Game.state === 'place')) {
        Game.mode = +k;
        startFrame();
      }
      break;
    default:
      return;
  }
  e.preventDefault();
}

function powerBarStart(f) {
  if (!canInteract() || Game.state !== 'aim') return false;
  SFX.init();
  Game.aim.barCharging = true;
  setPower(f);
  return true;
}

function powerBarMove(f) {
  if (Game.aim.barCharging) setPower(f);
}

function powerBarEnd(release) {
  if (!Game.aim.barCharging) return;
  Game.aim.barCharging = false;
  if (release) shoot(Game.aim.power);
}

function toggleGuide() {
  Game.showGuide = !Game.showGuide;
  HUD.setToggles(Game.showGuide, SFX.muted);
  saveSettings({ guide: Game.showGuide });
  HUD.banner(Game.showGuide ? 'Aiming guide on' : 'Aiming guide off', '', 'info', 1200);
}

function toggleSound() {
  SFX.setMuted(!SFX.muted);
  HUD.setToggles(Game.showGuide, SFX.muted);
  saveSettings({ muted: SFX.muted });
}

function updateHint() {
  let text = '';
  const touch = Game.pointer.type !== 'mouse';
  if (isAITurn() && (Game.state === 'aim' || Game.state === 'place')) {
    const who = Rules.state.players[1];
    text = Game.ai.phase === 'think' ? `${who} is thinking…` : `${who} is playing`;
  } else if (Game.state === 'place') {
    text = touch ? 'Ball in hand: drag inside the D and release to place' : 'Ball in hand: click inside the D to place the cue ball';
  } else if (Game.state === 'aim') {
    if (Game.aim.dragging) text = 'Release to strike · right-click or Esc to cancel';
    else if (touch) text = 'Drag on the table to aim · pull the power bar and release to strike';
    else text = 'Aim with the mouse (Shift = fine) · drag back and release to strike';
  }
  HUD.setHint(text);
}

// ---------------------------------------------------------------- rendering data

function sceneData() {
  const cueBall = Physics.find('cue');
  const scene = { balls: Physics.balls, falling: Game.falling, time: Game.time, cue: null, guide: null, place: null };
  const side = Game.spin.x * CFG.R * 0.5;

  if (Game.state === 'aim' && cueBall && !Game.paused) {
    const feather = Game.aim.dragging || Game.aim.barCharging || Game.aim.power > 0 ? 0 : (Math.sin(Game.time * 2.2) * 0.5 + 0.5) * 3.5;
    scene.cue = { x: cueBall.body.position.x, y: cueBall.body.position.y, angle: Game.aim.angle, pull: pullFor(Game.aim.power) + 2 + feather, side, alpha: 1 };
    if (Game.showGuide && !(isAITurn() && Game.ai.phase === 'think')) {
      const speed = Math.max(Game.aim.power, 0.45) * CFG.PHYS.MAX_SPEED;
      scene.guide = Physics.predict(cueBall, Game.aim.angle, speed, Game.spin.y, Game.spin.x);
      scene.guideLegal = scene.guide.target ? Rules.isOn(scene.guide.target.kind) : true;
    }
  } else if ((Game.state === 'strike' || (Game.state === 'roll' && Game.cueAlpha > 0)) && Game.anchor && Game.strike) {
    const s = Game.strike;
    let pull;
    if (Game.state === 'strike') {
      const t = Math.min(1, s.t / s.dur);
      pull = s.pull + 2 - (s.pull + 4.5) * t * t;
    } else {
      pull = -2.5 - Math.min(1, s.t / 0.16) * (6 + s.power * 14);
    }
    scene.cue = { x: Game.anchor.x, y: Game.anchor.y, angle: Game.aim.angle, pull, side, alpha: Game.state === 'strike' ? 1 : Game.cueAlpha };
  }

  if (Game.state === 'place' && !Game.paused) {
    if (isAITurn()) {
      const g = Game.ai.ghost;
      scene.place = g ? { x: g.x, y: g.y, valid: true, show: true } : { show: false };
    } else {
      const pl = placementFor(Game.pointer);
      scene.place = { ...pl, show: Game.pointer.over || Game.pointer.type !== 'mouse' };
    }
  }
  return scene;
}

// ---------------------------------------------------------------- settings

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    // Storage unavailable (private mode): settings just won't persist
  }
}
