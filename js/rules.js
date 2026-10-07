// Snooker referee: tracks the ball "on", scores, breaks and frames, and judges
// each shot (legal pots, fouls and penalties, re-spotting, end of frame).

const Rules = (() => {
  const value = (k) => CFG.BALLS[k].value;
  const name = (k) => CFG.BALLS[k].name;
  const isColour = (k) => CFG.COLOURS.includes(k);

  const state = {
    players: ['Player 1', 'Player 2'],
    frames: [0, 0],
    bestOf: 3,
    frameNo: 0,
    scores: [0, 0],
    current: 0,
    on: 'red',            // 'red', 'colour' (any colour after a red) or a specific colour
    redsLeft: 15,
    coloursDown: [],      // colours potted for good during the final sequence
    breakPoints: 0,
    breakBalls: [],
    highBreak: [0, 0],
    frameOver: false,
    matchOver: false,
  };

  function newMatch(players, bestOf) {
    state.players = players;
    state.bestOf = bestOf;
    state.frames = [0, 0];
    state.frameNo = 0;
    state.highBreak = [0, 0];
    state.matchOver = false;
  }

  function newFrame(reds) {
    state.scores = [0, 0];
    state.current = state.frameNo % 2; // players alternate breaking off
    state.redsLeft = reds;
    state.coloursDown = [];
    state.on = reds > 0 ? 'red' : 'yellow';
    state.breakPoints = 0;
    state.breakBalls = [];
    state.frameOver = false;
  }

  function lowestColour() {
    return CFG.COLOURS.find((c) => !state.coloursDown.includes(c)) || 'black';
  }

  function nextOn() {
    return state.redsLeft > 0 ? 'red' : lowestColour();
  }

  // Whether hitting a ball of this kind first would be legal right now
  function isOn(kind) {
    if (state.on === 'red') return kind === 'red';
    if (state.on === 'colour') return isColour(kind);
    return kind === state.on;
  }

  function onLabel() {
    if (state.on === 'red') return 'Red';
    if (state.on === 'colour') return 'Colour';
    return name(state.on);
  }

  function pointsRemaining() {
    const seq = (from) => CFG.COLOURS.slice(CFG.COLOURS.indexOf(from)).reduce((s, c) => s + value(c), 0);
    if (state.on === 'red') return state.redsLeft * 8 + 27;
    if (state.on === 'colour') return state.redsLeft * 8 + 7 + 27;
    return seq(state.on);
  }

  function endBreak() {
    const p = state.current;
    state.highBreak[p] = Math.max(state.highBreak[p], state.breakPoints);
    const finished = state.breakPoints;
    state.breakPoints = 0;
    state.breakBalls = [];
    return finished;
  }

  // Referee's verdict on a shot without changing any state.
  // shot: { firstHit: kind | null, potted: [kind, ...] }
  function assess(shot) {
    const on = state.on;
    const first = shot.firstHit;
    const pots = shot.potted.filter((k) => k !== 'cue');
    const cueIn = shot.potted.includes('cue');
    const colourPots = pots.filter(isColour);
    const reasons = [];
    let penalty = 4;

    // Value of the ball on, for the purpose of penalties
    let onValue = 1;
    if (on === 'colour') onValue = first && isColour(first) ? value(first) : 4;
    else if (isColour(on)) onValue = value(on);
    penalty = Math.max(penalty, onValue);

    if (!first) {
      reasons.push('Failed to hit the ball on');
    } else if (!isOn(first)) {
      reasons.push(`${name(first)} hit first`);
      penalty = Math.max(penalty, value(first));
    }

    for (const k of pots) {
      let legal;
      if (on === 'red') legal = k === 'red';
      else if (on === 'colour') legal = isColour(k) && k === first && colourPots.length === 1;
      else legal = k === on;
      if (!legal) {
        penalty = Math.max(penalty, value(k));
        const why = `${name(k)} potted`;
        if (!reasons.includes(why)) reasons.push(why);
      }
    }
    if (cueIn) reasons.push('Cue ball in-off');

    const foul = reasons.length > 0;
    const points = foul ? 0 : pots.reduce((sum, k) => sum + value(k), 0);
    return { foul, penalty: foul ? penalty : 0, reasons, points, pots, colourPots, cueIn };
  }

  // Applies a shot's outcome to the frame and returns what happened so the game
  // can update the table and show messages.
  function judge(shot) {
    const on = state.on;
    const { foul, penalty, reasons, pots, colourPots, cueIn } = assess(shot);
    const redPots = pots.filter((k) => k === 'red');
    const shooter = state.current;
    const opponent = 1 - shooter;
    const result = {
      foul, penalty: foul ? penalty : 0, reasons, shooter,
      points: 0, respot: [], ballInHand: cueIn, switched: false,
      breakEnded: 0, frameOver: false, respottedBlack: false,
    };

    // Reds always stay down, legally potted or not
    state.redsLeft = Math.max(0, state.redsLeft - redPots.length);

    if (foul) {
      state.scores[opponent] += penalty;
      result.breakEnded = endBreak();
      state.current = opponent;
      result.switched = true;
      result.respot = colourPots.slice();
      if (on === 'black') result.frameOver = true; // only the black left: a foul ends the frame
      state.on = nextOn();
    } else if (pots.length > 0) {
      const pts = pots.reduce((s, k) => s + value(k), 0);
      result.points = pts;
      state.scores[shooter] += pts;
      state.breakPoints += pts;
      state.breakBalls.push(...pots);
      if (on === 'red') {
        state.on = 'colour';
      } else if (on === 'colour') {
        result.respot = colourPots.slice();
        state.on = nextOn();
      } else {
        state.coloursDown.push(on);
        if (on === 'black') result.frameOver = true;
        else state.on = nextOn();
      }
    } else {
      result.breakEnded = endBreak();
      state.current = opponent;
      result.switched = true;
      state.on = nextOn();
    }

    if (result.frameOver) {
      if (state.scores[0] === state.scores[1]) {
        // Tied on the last black: re-spot it and play on with ball in hand
        result.frameOver = false;
        state.coloursDown = state.coloursDown.filter((c) => c !== 'black');
        result.respot = ['black'];
        state.on = 'black';
        result.respottedBlack = true;
        result.ballInHand = true;
        if (!result.switched) {
          result.breakEnded = endBreak();
          state.current = opponent;
          result.switched = true;
        }
      } else {
        if (!result.breakEnded) result.breakEnded = endBreak();
        const winner = state.scores[0] > state.scores[1] ? 0 : 1;
        state.frames[winner]++;
        state.frameOver = true;
        state.frameNo++;
        result.winner = winner;
        result.matchOver = state.frames[winner] > state.bestOf / 2;
        state.matchOver = result.matchOver;
      }
    }
    return result;
  }

  return {
    state, newMatch, newFrame, assess, judge, isOn, onLabel, pointsRemaining, isColour, value, name,
    get on() { return state.on; },
  };
})();
