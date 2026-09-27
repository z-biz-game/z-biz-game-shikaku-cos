// Persistence. Everything lives under one key so a reset is one line, and a run in progress
// is stored as (origin seed, tier, cell owners, what the run has cost) rather than a copy of
// the partition or the solution — the generator is deterministic, so the board never has to
// travel through storage and even a solved 14×14 comes to well under a kilobyte.

const KEY = 'shikaku.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false, showNotes: true },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// A cell holds the index of the clue that owns it, or OPEN = -1. The shift is what keeps -1
// alive inside a byte-wide JSON array; run-length coding pays for itself on the saves players
// actually make — quitting early leaves a board almost all OPEN — and costs little otherwise.
const SHIFT = 1;

function rleEncode(board) {
  const out = [];
  let run = (board[0] ?? 0) + SHIFT;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] + SHIFT === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i] + SHIFT;
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Int16Array(len);
  let i = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const v = pairs[p] - SHIFT;
    const n = pairs[p + 1];
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I fenced this board
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to
      // store the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six
      // hints, close the tab, come back, and finish with a clean 提示 0 record — the score
      // that decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
