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
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = pairs[p] - SHIFT;
    const n = pairs[p + 1];
    // A short run list used to leave the tail at 0, and 0 is *clue 0*, not OPEN (-1): the
    // resume would silently hand back a board half-"filled" by a region the player never drew.
    if (i + n > len) return null;
    for (let k = 0; k < n; k++) b[i++] = v;
  }
  return i === len ? b : null;
}

const num = (v, want = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : want);
const flag = (v, want) => (typeof v === 'boolean' ? v : want);
const MAX_CELLS = 4096; // 64×64: past this it is not one of our boards

// 两段式解码第一段：只看形状，不看棋盘。任何一条不合格就只丢那一条，游戏照常起。
function cleanSettings(raw) {
  const base = defaults().settings;
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    sound: flag(s.sound, base.sound),
    reduceMotion: flag(s.reduceMotion, base.reduceMotion),
    showNotes: flag(s.showNotes, base.showNotes),
  };
}

function cleanTotals(raw) {
  const base = defaults().totals;
  const t = raw && typeof raw === 'object' ? raw : {};
  return { solved: Math.max(0, num(t.solved)), hints: Math.max(0, num(t.hints)), ms: Math.max(0, num(t.ms)) };
}

function cleanBest(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [tier, b] of Object.entries(src)) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    out[tier] = { ms: Math.max(0, num(b.ms)), hints: Math.max(0, num(b.hints)), moves: Math.max(0, num(b.moves)), size: typeof b.size === 'string' || typeof b.size === 'number' ? b.size : '', at: num(b.at) };
  }
  return out;
}

function cleanResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.tier !== 'string') return null;
  if (typeof raw.seed !== 'string' && typeof raw.seed !== 'number') return null;
  if (!Number.isInteger(raw.cells) || raw.cells <= 0 || raw.cells > MAX_CELLS) return null;
  if (!Array.isArray(raw.ink) || raw.ink.length % 2 !== 0) return null;
  const ink = [];
  for (let p = 0; p < raw.ink.length; p += 2) {
    const v = raw.ink[p];
    const n = raw.ink[p + 1];
    // 值域：SHIFT 后的 clue 索引 0..n，游程 1..255。越界的存档不是存档，是乱码。
    if (!Number.isInteger(v) || v < 0 || v > MAX_CELLS + 1) return null;
    if (!Number.isInteger(n) || n <= 0 || n > 255) return null;
    ink.push(v, n);
  }
  return {
    seed: raw.seed,
    tier: raw.tier,
    elapsedMs: Math.max(0, num(raw.elapsedMs)),
    cells: raw.cells,
    ink,
    moves: Math.max(0, num(raw.moves)),
    hints: Math.max(0, num(raw.hints)),
    at: num(raw.at),
  };
}

function decode(raw) {
  const parsed = JSON.parse(raw);
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    settings: cleanSettings(src.settings),
    best: cleanBest(src.best),
    resume: cleanResume(src.resume),
    totals: cleanTotals(src.totals),
  };
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return defaults(); // 隐私模式 / storage 被禁：默认档照样能玩
  }
  if (!raw) return defaults();
  try {
    return decode(raw);
  } catch {
    return defaults(); // 整档是乱码：丢档，不丢游戏
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

  // 第二段：把形状过关的记录解成棋盘。坏在这里也一样——丢这一条续局，不丢这一局之后的启动。
  resume() {
    const r = cleanResume(this.data.resume);
    const board = r ? rleDecode(r.ink, r.cells) : null;
    if (!board) {
      if (this.data.resume !== null) {
        this.data.resume = null;
        this.save();
      }
      return null;
    }
    return { ...r, board };
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
