// Procedural sound effects built with the Web Audio API (no audio assets needed).

const SFX = (() => {
  let ctx = null;
  let master = null;
  let noise = null;
  let muted = false;
  let lastClick = 0;

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;

    // Gentle compression keeps a busy break from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.02);
  }

  function ready() {
    return ctx && ctx.state === 'running';
  }

  function noiseBurst(t, { gain, decay, type, freq, q = 1, dur = 0.12 }) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, dur);
  }

  function tone(t, { freq, endFreq, gain, decay, type = 'sine' }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  }

  // Phenolic resin balls give a bright, very short "clack"
  function ballHit(intensity) {
    if (!ready() || intensity < 0.01) return;
    const t = ctx.currentTime;
    if (t - lastClick < 0.012) return;
    lastClick = t;
    const v = Math.min(1, intensity);
    const g = 0.06 + v * 0.9;
    noiseBurst(t, { gain: g * 0.8, decay: 0.035, type: 'bandpass', freq: 3600 + Math.random() * 500, q: 1.2, dur: 0.05 });
    tone(t, { freq: 2300 + Math.random() * 300, endFreq: 1900, gain: g * 0.35, decay: 0.03 });
    tone(t, { freq: 5200, gain: g * 0.12, decay: 0.012 });
  }

  function cushion(intensity) {
    if (!ready() || intensity < 0.02) return;
    const t = ctx.currentTime;
    const g = Math.min(1, intensity) * 0.75;
    noiseBurst(t, { gain: g, decay: 0.09, type: 'lowpass', freq: 520, q: 0.7, dur: 0.12 });
    tone(t, { freq: 150, endFreq: 95, gain: g * 0.7, decay: 0.09 });
  }

  function cueStrike(power) {
    if (!ready()) return;
    const t = ctx.currentTime;
    const g = 0.15 + power * 0.7;
    noiseBurst(t, { gain: g * 0.7, decay: 0.03, type: 'bandpass', freq: 1700, q: 1.4, dur: 0.05 });
    tone(t, { freq: 980, endFreq: 640, gain: g * 0.35, decay: 0.045, type: 'triangle' });
    noiseBurst(t, { gain: g * 0.4, decay: 0.06, type: 'lowpass', freq: 400, dur: 0.08 });
  }

  // A soft thud into the pocket followed by the ball settling
  function pocket(intensity) {
    if (!ready()) return;
    const t = ctx.currentTime;
    const g = 0.35 + Math.min(1, intensity) * 0.5;
    tone(t, { freq: 120, endFreq: 55, gain: g * 0.8, decay: 0.22 });
    noiseBurst(t, { gain: g * 0.6, decay: 0.16, type: 'lowpass', freq: 700, dur: 0.2 });
    noiseBurst(t + 0.09, { gain: g * 0.25, decay: 0.05, type: 'bandpass', freq: 900, q: 2, dur: 0.06 });
    noiseBurst(t + 0.16, { gain: g * 0.14, decay: 0.05, type: 'bandpass', freq: 750, q: 2, dur: 0.06 });
  }

  // Crowd applause: hundreds of tiny filtered noise "claps"
  function applause(duration = 3.5, strength = 1) {
    if (!ready()) return;
    const t0 = ctx.currentTime + 0.05;
    const claps = Math.floor(320 * duration * strength);
    for (let i = 0; i < claps; i++) {
      const u = Math.random();
      const at = t0 + Math.pow(u, 1.6) * duration;
      const env = 1 - Math.pow(u, 1.6);
      noiseBurst(at, {
        gain: (0.02 + Math.random() * 0.05) * env * strength,
        decay: 0.02 + Math.random() * 0.02,
        type: 'bandpass',
        freq: 900 + Math.random() * 1800,
        q: 0.9,
        dur: 0.05,
      });
    }
  }

  // A short two-note chime for fouls and frame events
  function chime(up = true) {
    if (!ready()) return;
    const t = ctx.currentTime;
    const notes = up ? [660, 990] : [520, 390];
    notes.forEach((f, i) => tone(t + i * 0.11, { freq: f, gain: 0.08, decay: 0.35, type: 'sine' }));
  }

  return { init, setMuted, ballHit, cushion, cueStrike, pocket, applause, chime, get muted() { return muted; } };
})();
