// The playable state machine: what a drag commits, what an undo takes back, when a board
// counts as solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/shikaku.js:
//   * the ink lives in the engine's own `st.owner` / `st.cuts`. A UI-side copy of the board is
//     how a painted cell and a "this region is pinned" cell drift apart.
//   * the win check is the engine's independent `verify()`, written from the rules of the game
//     rather than from this file's bookkeeping, so "the UI said I won" and "the board is a
//     legal partition" cannot disagree.
//
// One snapshot is one gesture: the engine pushes it, `steps` mirrors it, and 撤销 pops both.

import {
  createState,
  rebuild,
  snapshot,
  undo as undoState,
  resetMarks,
  diagnose,
  nextDeduction,
  applyDeduction,
  tryBox,
  paintCell,
  toggleCut,
  eraseCell,
  complete,
  boxOf,
  OPEN,
} from '../engine/shikaku.js';

export { OPEN };

const ownerSum = (st) => {
  let s = 0;
  for (let t = 0; t < st.owner.length; t++) s += st.owner[t] + 1;
  return s;
};

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.w = puzzle.board.w;
    this.h = puzzle.board.h;
    this.board = puzzle.board;
    this.st = createState(puzzle.board);
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.mode = 'box';
    this.lastHint = null;
    this.recompute();
  }

  // 重开**同一道题**：把这一局整个归零，题面不动。
  //
  // 陷阱就在这里：引擎的 resetMarks() 只清了标记与引擎那份 history，而撤销栈
  // this.steps、步数 this.moves、提示次数 this.hints 全挂在 UI 这一层的 Game 实例上，
  // 它一个都碰不到。只调 resetMarks() 当重开，这半局的痕迹会原封不动当成新局开场白，
  // 玩家还按得动撤销回到走错那一步（实测 steps 6 → 6、moves 6 → 6、hints 2 → 2）。
  resetAll() {
    resetMarks(this.st);      // 标记全回空 + 引擎 history 清空
    this.steps = [];          // UI 撤销栈：resetMarks 管不到，清的是引擎那份
    this.moves = 0;           // 步数归零
    this.hints = 0;           // 提示次数归零：提示要收钱，留着等于让玩家白嫖上一局的帮助
    this.status = 'playing';  // 胜负回判：上一局赢了也不能把重开后的盘算成已通关
    this.mode = 'box';        // 临时态：操作模式回到默认
    this.lastHint = null;     // 上一条提示文案属于上一局
    this.recompute();
    return this;
  }

  recompute() {
    this.diag = diagnose(this.st);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  ownerOf(t) {
    return t >= 0 && t < this.board.n ? this.st.owner[t] : OPEN;
  }

  box(r0, c0, r1, c1) {
    return boxOf(this.board, Math.min(r0, r1), Math.min(c0, c1), Math.max(r0, r1), Math.max(c0, c1));
  }

  record(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else if (kind !== 'prune') this.moves++;
  }

  // A gesture that wrote nothing must not cost a step. The engine snapshots before it knows
  // whether the ink changes, so this is where the wasted snapshot gets taken back.
  protected(before, kind, info) {
    if (ownerSum(this.st) === before) {
      undoState(this.st);
      this.recompute();
      return null;
    }
    this.record(kind, info);
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  drawBox(box) {
    const before = ownerSum(this.st);
    const res = tryBox(this.st, box);
    if (!res.ok) return { ...res, step: null };
    return { ...res, step: this.protected(before, 'box', { cells: res.cells, clue: res.clue }) };
  }

  tap(t) {
    if (this.status === 'won') return null;
    if (this.st.owner[t] !== OPEN) return this.erase(t);
    return null;
  }

  paint(t, clue) {
    const before = ownerSum(this.st);
    if (!paintCell(this.st, t, clue)) return null;
    return this.protected(before, 'paint', { cells: [t], clue });
  }

  erase(t) {
    const before = ownerSum(this.st);
    if (!eraseCell(this.st, t)) return null;
    return this.protected(before, 'erase', { cells: [t] });
  }

  // A cut is a note: it changes no owner, so it cannot make a solvable board unsolvable, and
  // it is its own gesture in the engine's history.
  cut(pair) {
    const on = toggleCut(this.st, pair);
    this.steps.push({ kind: on ? 'cut' : 'uncut', pair });
    this.moves++;
    this.recompute();
    return this.steps[this.steps.length - 1];
  }

  // Restoring a saved board: the partition is redrawn from the origin seed, so a resume only
  // replays the player's own ink — and none of it counts as a move, because the run's cost
  // comes from the save.
  load(owners) {
    for (let t = 0; t < this.board.n; t++) {
      const v = owners[t];
      this.st.owner[t] = v === undefined || v === null ? OPEN : v;
    }
    rebuild(this.st);
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The engine's own next step. Pure prunes are walked through for free — they leave no ink a
  // player could act on — until the board gives something the player can actually draw.
  hint() {
    if (this.status === 'won') return null;
    for (let k = 0; k < 80; k++) {
      const d = nextDeduction(this.st);
      if (!d) return { stalled: true, text: '当前没有可推导的一步：这块盘要的是重新想一遍，不是提示。' };
      const before = ownerSum(this.st);
      snapshot(this.st);
      applyDeduction(this.st, d);
      const info = { rule: d.rule.name, kind: d.kind, rid: d.rid, clue: d.clue, why: d.rule.text(this.board, d), charged: true };
      if (d.kind === 'kill') {
        this.record('prune', { rid: d.rid, clue: d.clue });
        this.recompute();
        continue;
      }
      if (d.kind === 'cut') {
        // A note is not ink: the snapshot above is its undo, and it is the hint's own answer.
        this.record('hint', { pair: d.pair, cells: d.cells, rule: d.rule.name });
        this.recompute();
        info.cells = d.cells;
        this.lastHint = info;
        return info;
      }
      const cells = d.kind === 'own' ? [d.cell] : this.board.cellsOf[d.rid];
      const step = this.protected(before, 'hint', { cells, clue: d.clue, rule: d.rule.name });
      if (!step) continue;
      info.cells = cells;
      this.lastHint = info;
      return info;
    }
    return { stalled: true, text: '推导到此为止，剩下的要你自己想。' };
  }

  checkWin() {
    if (complete(this.board, this.st.owner)) this.status = 'won';
    else this.status = 'playing';
    return this.status === 'won';
  }

  // Used by the verification harness and nothing else: drive the engine's own deductions to
  // the end. Every cell it writes is one the pencil rules justify, so this can never light a
  // square the game would not accept as a hint.
  solveWithLogic({ cap = 600 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, steps: k };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      owned: g.owned,
      total: g.total,
      remaining: g.remaining,
      regions: g.regions.length,
      filled: g.filled,
      pinned: g.regions.filter((r) => r.pinned).length,
      problems: g.shapeBad.size,
      dubiousCuts: g.dubiousCuts,
      stuck: g.stuck,
      score: this.puzzle.score,
      steps: this.steps.length,
    };
  }
}

// The readout a drag shows before it commits: the rules of the game are exactly "one clue,
// area equal to it", so this is the same arithmetic the acceptance test uses.
export function boxReadout(board, box) {
  const b = boxOf(board, Math.min(box.r0, box.r1), Math.min(box.c0, box.c1), Math.max(box.r0, box.r1), Math.max(box.c0, box.c1));
  if (!b.clues.length) return { area: b.area, clues: 0, want: 0, ok: false, text: `${b.area} 格 · 里面没有数字` };
  if (b.clues.length > 1) return { area: b.area, clues: b.clues.length, want: 0, ok: false, text: `${b.area} 格 · ${b.clues.length} 个数字` };
  const clue = b.clues[0];
  const want = board.values[clue];
  return {
    area: b.area,
    clues: 1,
    clue,
    want,
    ok: b.area === want,
    text: `${b.area} 格 · 数字 ${want}${b.area === want ? ' ✓' : ''}`,
  };
}
