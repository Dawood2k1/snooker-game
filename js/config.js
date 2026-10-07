// Shared constants: table geometry (scene units), physics tuning and ball data.
// The playing surface spans x: 0..W, y: 0..H (cushion nose to cushion nose),
// with the baulk end on the left and the black spot on the right.

const CFG = (() => {
  const W = 800;
  const H = W / 2;
  const BALL_D = W / 36;
  const R = BALL_D / 2;
  const POCKET_D = BALL_D * 1.5;

  const CUSHION = 15;   // visible cushion depth
  const RAIL = 44;      // wooden rail width
  const CORNER_JAW = 26; // distance from the corner to where a corner jaw starts
  const MID_HALF = 20.5; // half the opening of a middle pocket
  const MID_TAPER = 0.2; // middle jaws narrow slightly towards the fall

  // Real 12ft table proportions (3569mm bed)
  const BAULK_X = W * 0.2065; // 737mm
  const D_R = W * 0.0818;     // 292mm
  const MID_Y = H / 2;

  const SPOTS = {
    yellow: { x: BAULK_X, y: MID_Y + D_R },
    green: { x: BAULK_X, y: MID_Y - D_R },
    brown: { x: BAULK_X, y: MID_Y },
    blue: { x: W / 2, y: MID_Y },
    pink: { x: W * 0.75, y: MID_Y },
    black: { x: W - W * 0.0908, y: MID_Y },
  };

  const pocketR = POCKET_D / 2;
  const POCKETS = [
    { id: 'tl', x: -3, y: -3, corner: true },
    { id: 'tm', x: W / 2, y: -12, corner: false },
    { id: 'tr', x: W + 3, y: -3, corner: true },
    { id: 'bl', x: -3, y: H + 3, corner: true },
    { id: 'bm', x: W / 2, y: H + 12, corner: false },
    { id: 'br', x: W + 3, y: H + 3, corner: true },
  ].map((p) => ({ ...p, r: pocketR, rim: pocketR + 4.5, capture: pocketR }));

  // Cushion quads for a given depth. Physics uses a deep version so fast balls
  // can never tunnel through; the renderer uses the visible depth.
  function cushions(depth) {
    const j = CORNER_JAW, m = MID_HALF, t = MID_TAPER, d = depth;
    const c = W / 2;
    return [
      { normal: { x: 0, y: 1 }, pts: [{ x: j, y: 0 }, { x: c - m, y: 0 }, { x: c - m + t * d, y: -d }, { x: j - d, y: -d }] },
      { normal: { x: 0, y: 1 }, pts: [{ x: c + m, y: 0 }, { x: W - j, y: 0 }, { x: W - j + d, y: -d }, { x: c + m - t * d, y: -d }] },
      { normal: { x: 0, y: -1 }, pts: [{ x: c - m, y: H }, { x: j, y: H }, { x: j - d, y: H + d }, { x: c - m + t * d, y: H + d }] },
      { normal: { x: 0, y: -1 }, pts: [{ x: W - j, y: H }, { x: c + m, y: H }, { x: c + m - t * d, y: H + d }, { x: W - j + d, y: H + d }] },
      { normal: { x: 1, y: 0 }, pts: [{ x: 0, y: H - j }, { x: 0, y: j }, { x: -d, y: j - d }, { x: -d, y: H - j + d }] },
      { normal: { x: -1, y: 0 }, pts: [{ x: W, y: j }, { x: W, y: H - j }, { x: W + d, y: H - j + d }, { x: W + d, y: j - d }] },
    ];
  }

  // The cloth "throat" between the jaws of each pocket, from the mouth back to the fall.
  function throats() {
    const j = CORNER_JAW, m = MID_HALF, t = MID_TAPER, d = CUSHION, c = W / 2;
    return [
      [{ x: j, y: 0 }, { x: 0, y: j }, { x: -d, y: j - d }, { x: j - d, y: -d }],
      [{ x: c - m, y: 0 }, { x: c - m + t * d, y: -d }, { x: c + m - t * d, y: -d }, { x: c + m, y: 0 }],
      [{ x: W - j, y: 0 }, { x: W - j + d, y: -d }, { x: W + d, y: j - d }, { x: W, y: j }],
      [{ x: 0, y: H - j }, { x: j, y: H }, { x: j - d, y: H + d }, { x: -d, y: H - j + d }],
      [{ x: c + m, y: H }, { x: c + m - t * d, y: H + d }, { x: c - m + t * d, y: H + d }, { x: c - m, y: H }],
      [{ x: W, y: H - j }, { x: W + d, y: H - j + d }, { x: W - j + d, y: H + d }, { x: W - j, y: H }],
    ];
  }

  const BALLS = {
    cue: { value: 0, color: '#f4f0e4', name: 'Cue ball' },
    red: { value: 1, color: '#b8141c', name: 'Red' },
    yellow: { value: 2, color: '#f2c21b', name: 'Yellow' },
    green: { value: 3, color: '#0b7a45', name: 'Green' },
    brown: { value: 4, color: '#6b3a1d', name: 'Brown' },
    blue: { value: 5, color: '#1446a8', name: 'Blue' },
    pink: { value: 6, color: '#f48db4', name: 'Pink' },
    black: { value: 7, color: '#151515', name: 'Black' },
  };

  return {
    W, H, R, BALL_D, POCKET_D, CUSHION, RAIL, CORNER_JAW, MID_HALF, MID_TAPER,
    BAULK_X, D_R, MID_Y, SPOTS, POCKETS, BALLS,
    COLOURS: ['yellow', 'green', 'brown', 'blue', 'pink', 'black'],
    cushions, throats,

    // Scene bounds drawn on the canvas (table plus a little breathing room)
    SCENE: { x: -CUSHION - RAIL - 26, y: -CUSHION - RAIL - 22, w: W + 2 * (CUSHION + RAIL + 26), h: H + 2 * (CUSHION + RAIL + 22) },

    PHYS: {
      HZ: 480,             // fixed simulation rate
      MAX_SPEED: 1550,     // px/s at full power
      ROLL_DECEL: 105,     // rolling resistance, px/s^2
      DRAG: 0.34,          // speed-proportional cloth drag, 1/s
      STOP_SPEED: 4,       // px/s, below this a ball is at rest
      BALL_E: 0.95,        // ball-to-ball restitution
      CUSHION_E: 0.78,     // cushion restitution
      CUSHION_GRIP: 0.97,  // fraction of along-cushion speed kept on impact
      SLIDE_ACCEL: 560,    // how fast spin "bites" after contact, px/s^2
      SLIDE_K: 0.0009,     // how long a struck ball slides before rolling naturally
      SPIN_MAX: 1.4,       // spin at the edge of the cue ball (1 = natural roll)
      SCREW_GAIN: 1.6,     // extra bite on backspin so screw shots feel satisfying
      SIDE_K: 0.26,        // sidespin effect on cushion rebounds
    },

    CUE: { LENGTH: 350, TIP_W: 4.4, BUTT_W: 12, MAX_PULL: 70, DRAG_FULL: 190 },
  };
})();
