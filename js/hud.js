// DOM heads-up display: broadcast scoreboard, power bar, spin selector,
// banners and the menu / help / result overlays.

const HUD = (() => {
  const $ = (id) => document.getElementById(id);
  let cb = {};
  let bannerTimer = null;
  let lastPower = -1;
  let selectedMode = 1;
  let selectedBest = 3;

  function init(callbacks) {
    cb = callbacks;

    // Menu
    $('modeSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      selectMode(+btn.dataset.mode);
    });
    $('bestSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-best]');
      if (!btn) return;
      selectBest(+btn.dataset.best);
    });
    $('btnStart').addEventListener('click', () => {
      const names = [0, 1].map((i) => $('inName' + i).value.trim() || `Player ${i + 1}`);
      cb.onStart(names, selectedMode, selectedBest);
    });
    $('btnResume').addEventListener('click', () => cb.onResume());
    $('btnNext').addEventListener('click', () => cb.onNext());
    $('btnHelpClose').addEventListener('click', () => toggleHelp(false));
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(false); });

    // Toolbar (blur after clicking so Space/Enter keep controlling the cue)
    const tool = (id, fn) => $(id).addEventListener('click', (e) => { e.currentTarget.blur(); fn(); });
    tool('btnGuide', () => cb.onToggleGuide());
    tool('btnSound', () => cb.onToggleSound());
    tool('btnHelp', () => toggleHelp());
    tool('btnMenu', () => cb.onMenu());

    // Spin selector: drag the tip position on the cue ball
    const pad = $('spinPad');
    const setFromEvent = (e) => {
      const r = pad.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const l = Math.hypot(x, y) / 0.82;
      if (l > 1) { x /= l; y /= l; }
      cb.onSpin(x / 0.82, y / 0.82);
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      setFromEvent(e);
      const move = (ev) => setFromEvent(ev);
      const up = () => {
        pad.removeEventListener('pointermove', move);
        pad.removeEventListener('pointerup', up);
        pad.removeEventListener('pointercancel', up);
      };
      pad.addEventListener('pointermove', move);
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
    });
    pad.addEventListener('dblclick', () => cb.onSpin(0, 0));

    // Power bar: drag to set, release to strike (essential on touch screens)
    const bar = $('powerBar');
    const frac = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    bar.addEventListener('pointerdown', (e) => {
      if (!cb.onPowerStart(frac(e))) return;
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => cb.onPowerMove(frac(ev));
      const up = (ev) => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        cb.onPowerEnd(ev.type === 'pointerup');
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });

    // Power bar tick marks
    const ticks = $('powerTicks');
    for (let i = 1; i < 10; i++) {
      const t = document.createElement('i');
      t.style.left = `${i * 10}%`;
      if (i === 5) t.className = 'major';
      ticks.appendChild(t);
    }
  }

  function selectMode(m) {
    selectedMode = m;
    for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.mode === m);
  }

  function selectBest(n) {
    selectedBest = n;
    for (const b of $('bestSeg').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.best === n);
  }

  function setMenuDefaults({ names, mode, bestOf }) {
    if (names) names.forEach((n, i) => { $('inName' + i).value = n; });
    if (mode) selectMode(mode);
    if (bestOf) selectBest(bestOf);
  }

  // ---------------------------------------------------------------- scoreboard

  function update() {
    const s = Rules.state;
    for (const i of [0, 1]) {
      $('name' + i).textContent = s.players[i];
      setNumber($('score' + i), s.scores[i]);
      $('frames' + i).textContent = s.frames[i];
      $('p' + i).classList.toggle('active', s.current === i);
    }
    $('bestOf').textContent = `(${s.bestOf})`;
    setNumber($('break'), s.breakPoints);
    $('reds').textContent = s.redsLeft;
    $('remaining').textContent = Rules.pointsRemaining();
    $('onText').textContent = Rules.onLabel();
    const chip = $('onChip');
    chip.className = 'chip ' + (s.on === 'colour' ? 'colour' : s.on);

    const balls = $('breakBalls');
    balls.innerHTML = '';
    for (const k of s.breakBalls.slice(-24)) {
      const d = document.createElement('i');
      d.className = 'mini ' + k;
      balls.appendChild(d);
    }
  }

  // Briefly pulse a number when it changes
  function setNumber(el, v) {
    const str = String(v);
    if (el.textContent === str) return;
    el.textContent = str;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function setPower(p) {
    if (Math.abs(p - lastPower) < 0.002) return;
    lastPower = p;
    $('powerFill').style.clipPath = `inset(0 ${(100 - p * 100).toFixed(1)}% 0 0)`;
    $('powerText').textContent = `${Math.round(p * 100)}%`;
  }

  function setSpin(x, y) {
    const dot = $('spinDot');
    dot.style.left = `${50 + x * 41}%`;
    dot.style.top = `${50 - y * 41}%`;
    let label = 'Centre';
    const parts = [];
    if (y > 0.15) parts.push(y > 0.6 ? 'Strong top' : 'Top');
    if (y < -0.15) parts.push(y < -0.6 ? 'Deep screw' : 'Screw');
    if (x > 0.15) parts.push('right side');
    if (x < -0.15) parts.push('left side');
    if (parts.length) label = parts.join(', ');
    $('spinText').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  }

  function setToggles(guide, muted) {
    $('btnGuide').classList.toggle('off', !guide);
    $('btnSound').classList.toggle('off', muted);
  }

  function setHint(text) {
    const el = $('hint');
    if (el.textContent !== text) el.textContent = text;
  }

  function banner(title, sub = '', kind = 'info', ms = 2400) {
    const el = $('banner');
    el.className = 'banner ' + kind;
    $('bannerTitle').textContent = title;
    $('bannerSub').textContent = sub;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- overlays

  function showMenu(resumable) {
    $('btnResume').classList.toggle('hidden', !resumable);
    $('btnStart').textContent = resumable ? 'New Match' : 'Start Match';
    $('menu').classList.remove('hidden');
  }

  function hideMenu() {
    $('menu').classList.add('hidden');
  }

  function menuOpen() {
    return !$('menu').classList.contains('hidden');
  }

  function toggleHelp(force) {
    const el = $('help');
    const show = force === undefined ? el.classList.contains('hidden') : force;
    el.classList.toggle('hidden', !show);
  }

  function helpOpen() {
    return !$('help').classList.contains('hidden');
  }

  function showResult(r) {
    const s = Rules.state;
    const w = r.winner;
    $('resEyebrow').textContent = r.matchOver ? 'Match complete' : `Frame ${s.frameNo}`;
    $('resTitle').textContent = r.matchOver ? `${s.players[w]} wins the match` : `${s.players[w]} takes the frame`;
    for (const i of [0, 1]) {
      $('resS' + i).textContent = r.frameScores[i];
      $('resN' + i).textContent = s.players[i];
      $('resS' + i).classList.toggle('win', i === w);
    }
    $('resFrames').textContent = `Frames  ${s.frames[0]} – ${s.frames[1]}`;
    const hb = Math.max(...s.highBreak);
    $('resBreak').textContent = hb > 0 ? `Highest break: ${hb} (${s.players[s.highBreak.indexOf(hb)]})` : '';
    $('btnNext').textContent = r.matchOver ? 'New Match' : 'Next Frame';
    $('result').classList.remove('hidden');
  }

  function hideResult() {
    $('result').classList.add('hidden');
  }

  return {
    init, update, setPower, setSpin, setToggles, setHint, banner, setMenuDefaults,
    showMenu, hideMenu, menuOpen, toggleHelp, helpOpen, showResult, hideResult,
  };
})();
