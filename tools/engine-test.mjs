// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`.
//
// The risk in this repo is not arithmetic but soundness: a single rule that wrote a cell the
// rules of the game do not force, and every board would still ship, the hints would still be
// self-consistent, and "每局都能推到底" would be a caption on a coin flip. So the expectations
// below are hand-derived from boards worked out on paper and written as literals — never read
// back off the solver.

import {
  createBoard,
  createState,
  solve,
  verify,
  complete,
  diagnose,
  nextDeduction,
  applyDeduction,
  findSeparation,
  findContradiction,
  tryBox,
  paintCell,
  toggleCut,
  eraseCell,
  undo,
  boxOf,
  rebuild,
  Rules,
  OPEN,
} from '../js/engine/shikaku.js';
import { countSolutions, UNIQUE, NONE, MANY } from '../js/engine/count.js';
import { layout, makePuzzle, generate, solutionOf, TIERS } from '../js/engine/generate.js';
import { Store } from '../js/store.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const boardOf = (w, h, pairs) => {
  const values = new Int16Array(w * h);
  for (const [i, v] of pairs) values[i] = v;
  return createBoard({ w, h, values });
};
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// ---------- the givens have to add up ----------

// Regions tile the board and each one's area is its clue, so the clues must sum to the cell
// count. Hand case: 4 cells, clues 2+3 — the third cell would have nowhere to belong.
eq('线索总和不够时直接拒绝', throws(() => boardOf(2, 2, [[0, 2], [1, 3]])), '线索总和 5 ≠ 格数 4，这种盘面不可能有解');
eq('线索总和超出时同样拒绝', throws(() => boardOf(2, 2, [[0, 9]])), '线索总和 9 ≠ 格数 4，这种盘面不可能有解');
eq('没有线索的盘没有解', throws(() => boardOf(3, 3, [])), '盘上没有线索');
eq('格子数不对的数组不放行', throws(() => createBoard({ w: 3, h: 3, values: new Int16Array(8) })), 'values length mismatch');
// 4×4 with a single 16 is the degenerate legal board: exactly one rectangle exists.
eq('整盘一块时只有一种放法', boardOf(4, 4, [[0, 16]]).rectsOf[0].length, 1);
// A clue whose area cannot be shaped inside the board has no candidate at all.
// 2×3 board, clue 5: 5 is prime, so only 1×5 or 5×1 fit — neither does.
eq('放不下任何矩形时开局即失败', throws(() => createState(boardOf(2, 3, [[0, 5], [5, 1]]))), '线索 5 @0 没有任何可放的矩形');

// ---------- candidate rectangles, hand-counted ----------

{
  // 2×4, a 4 in each opposite corner. The corner clue can be a whole row (1×4) or the 2×2
  // that grows inward — and nothing else, because 4×1 needs four rows.
  const b = boardOf(2, 4, [[0, 4], [7, 4]]);
  eq('对角 4 各有两种形状', `${b.rectsOf[0].length},${b.rectsOf[1].length}`, '2,2');
  eq('对角 4 的盘有两解', countSolutions(b).solutions, 2);
  eq('两解判定为 MANY', countSolutions(b).status, MANY);
  ok('MANY 的盘铅笔推不完', !solve(b).ok);
}
{
  // 2×3 with a 6 in a corner: the only rectangle of area 6 in a 2×3 is the whole board.
  const b = boardOf(2, 3, [[0, 6]]);
  eq('整盘一块的盘唯一', countSolutions(b).status, UNIQUE);
  eq('整盘一块推得完', solve(b).ok, true);
  eq('推完之后每格都有归属', solve(b).unowned, 0);
}
{
  // Hand-derived no-solution board: 3×3 with a 3 in the middle and a 2 in three corners.
  // The 3 must be the middle row or the middle column; either way the six cells left over
  // sit as two strips of three, and three cells in a strip cannot be tiled by dominoes.
  const b = boardOf(3, 3, [[0, 2], [2, 2], [4, 3], [8, 2]]);
  eq('这个无解盘的每个线索都有候选', b.rectsOf.map((r) => r.length).join(','), '2,2,2,2');
  eq('候选非空也可能无解', countSolutions(b).status, NONE);
  const p = solve(b);
  eq('无解盘不会被铅笔求解器推完', p.ok, false);
  eq('无解盘的求解结果不会自称完成', complete(b, p.state.owner), false);
}
{
  // Hand-counted 4×2: a 1 in the corner, a 3 that can only lie along the top row, and two
  // dominoes. Candidates per clue, in cell order: 1, 1, 2, 1. The cut is forced — top row
  // cells 1-3 to the 3, then the 2 at cell 6 has only 6-7, leaving 4-5 for the last 2.
  const b = boardOf(4, 2, [[0, 1], [5, 2], [6, 2], [2, 3]]);
  eq('1 格区域只有自身一种放法', b.rectsOf[b.clueOf[0]].length, 1);
  eq('手推的候选数逐条对上', b.rectsOf.map((r) => r.length).sort((x, y) => x - y).join(','), '1,1,1,2');
  eq('手推的这盘只有一种切法', countSolutions(b).status, UNIQUE);
  eq('手推的这盘铅笔能推完', solve(b).ok, true);
  eq('推完时没有空格', solve(b).unowned, 0);
}

// ---------- the two implementations must agree, cell by cell ----------

for (const tier of ['trainee', 'apprentice', 'regular']) {
  let matched = 0;
  for (let s = 0; s < 4; s++) {
    const p = makePuzzle(`unit|${s}`, tier);
    if (!p) continue;
    const pencil = solve(p.board).state.owner;
    const c = countSolutions(p.board, { cap: 2, budget: 400_000 });
    if (c.status !== UNIQUE) continue;
    const answer = new Int16Array(p.board.n).fill(OPEN);
    for (const [clue, r0, c0, r1, c1] of c.placement) {
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) answer[r * p.board.w + cc] = clue;
    }
    let diff = 0;
    for (let t = 0; t < p.board.n; t++) if (pencil[t] !== answer[t]) diff++;
    if (diff === 0) matched++;
  }
  eq(`${tier}：穷举解答与铅笔推导逐格一致`, matched, 4);
}

// A generated board that the pencil path finishes must be the one board the counter calls
// unique — and the generator's own partition must be that same board.
{
  let agree = 0;
  for (let s = 0; s < 8; s++) {
    const p = makePuzzle(`cut|${s}`, 'apprentice');
    if (!p) continue;
    const fromCutter = solutionOf(p.board, p.partition);
    const fromPencil = solve(p.board).state.owner;
    if (fromCutter.every((v, t) => v === fromPencil[t])) agree++;
  }
  eq('切块器的划分、铅笔的解答、穷举的答案三者同一', agree, 8);
}

// ---------- soundness: nothing the rules write may contradict the rules ----------

{
  // Mid-way through a solve, two things must hold at all times: no region is left with no
  // placement at all, and a region that has already reached its area is a legal rectangle
  // (a partial region may legitimately be an L — it is not finished yet).
  const p = makePuzzle('sound|1', 'regular');
  const st = createState(p.board);
  let violations = 0;
  let where = -1;
  for (let guard = 0; guard < 400; guard++) {
    const d = nextDeduction(st);
    if (!d) break;
    applyDeduction(st, d);
    const g = diagnose(st);
    const bad = (g.stuck ? 1 : 0) + g.regions.filter((r) => r.cells === r.want && !r.done).length;
    if (bad) {
      violations += bad;
      if (where < 0) where = guard;
    }
  }
  eq('每一步提示都不越界、不封死', violations, 0, `第 ${where} 步`);
  eq('提示能一路走到解完', complete(p.board, st.owner), true);
}

// Cuts are pencil notes. A *wrong* cut must not be able to strand a region, so the promise
// "marks never break the model" holds even when the player draws nonsense.
{
  const p = makePuzzle('notes|1', 'apprentice');
  const clean = solve(p.board).state.owner.slice();
  const st = createState(p.board);
  let wrong = 0;
  for (let pair = 0; pair < 2 * p.board.n && wrong < 6; pair++) {
    if (p.board.rectsOfPair[pair].some((rid) => st.alive[rid])) {
      toggleCut(st, pair);
      wrong++;
    }
  }
  ok('测试确实画了错的切线', wrong >= 3, `只画了 ${wrong} 条`);
  const d = diagnose(st);
  eq('错的切线不会让盘变成无解', d.stuck, false);
  eq('错的切线会被读出来', d.dubiousCuts, wrong);
  const after = solve(p.board, st).state.owner;
  eq('画了错切线之后解答不变', after.every((v, t) => v === clean[t]), true);
}

// ---------- undo and rebuild: one source of truth ----------

{
  const p = makePuzzle('undo|1', 'apprentice');
  const b = p.board;
  const st = createState(b);
  const empty = { cnts: Array.from(st.cnts), mask: Array.from(st.mask) };
  const sol = solutionOf(b, p.partition);
  const boxes = [];
  for (let i = 0; i < b.clues; i++) {
    const cells = [];
    for (let t = 0; t < b.n; t++) if (sol[t] === i) cells.push(t);
    const rs = cells.map((t) => Math.floor(t / b.w));
    const cs = cells.map((t) => t % b.w);
    boxes.push({ r0: Math.min(...rs), c0: Math.min(...cs), r1: Math.max(...rs), c1: Math.max(...cs) });
  }
  for (const box of boxes) tryBox(st, box);
  eq('按解答画满即胜', diagnose(st).owned, b.n);
  eq('按解答画满判胜', complete(b, st.owner), true);
  for (let k = 0; k < boxes.length; k++) undo(st);
  eq('一路撤销回到空盘', diagnose(st).owned, 0);
  eq('撤销后候选池与开局一致', Array.from(st.cnts).join(','), empty.cnts.join(','));
  eq('撤销后可见归属位一致', Array.from(st.mask).join(','), empty.mask.join(','));
}

{
  // The pool must be a function of the marks alone: re-deriving it from scratch has to
  // agree with the incremental pruning, cell for cell and rectangle for rectangle.
  const p = makePuzzle('rebuild|1', 'regular');
  const st = createState(p.board);
  for (let k = 0; k < 12; k++) {
    const d = nextDeduction(st);
    if (!d || d.kind !== 'own') break;
    paintCell(st, d.cell, d.clue);
  }
  const incremental = { alive: Array.from(st.alive).join(''), cnts: Array.from(st.cnts).join(','), mask: Array.from(st.mask).join(',') };
  const marks = Int16Array.from(st.owner);
  const fresh = createState(p.board);
  fresh.owner.set(marks);
  rebuild(fresh);
  eq('增量剪枝与整体重算给出同一个候选池', `${incremental.alive === Array.from(fresh.alive).join('')},${incremental.cnts === Array.from(fresh.cnts).join(',')},${incremental.mask === Array.from(fresh.mask).join(',')}`, 'true,true,true');
}

// ---------- the gesture acceptance test ----------

{
  // 2×4 board: clues 4 at cell 0 (row 0, col 0) and 4 at cell 7 (row 3, col 1).
  const b = boardOf(2, 4, [[0, 4], [7, 4]]);
  const st = createState(b);
  const empty = tryBox(st, { r0: 0, c0: 1, r1: 1, c1: 1 });
  eq('圈不到数字的方块被拒', empty.ok, false);
  ok('拒绝理由说清了', /没有数字/.test(empty.reason), empty.reason);
  eq('越界的方块先被挡下', tryBox(st, { r0: 0, c0: 1, r1: 1, c1: 2 }).reason, '出界了');
  const two = tryBox(st, { r0: 0, c0: 0, r1: 3, c1: 1 });
  eq('圈住两个数字的方块被拒', two.reason, '这块圈住了 2 个数字');
  const wrong = tryBox(st, { r0: 0, c0: 0, r1: 0, c1: 1 });
  eq('面积不符的方块被拒', wrong.reason, '面积 2，但这里的数字是 4');
  const good = tryBox(st, { r0: 0, c0: 0, r1: 1, c1: 1 });
  eq('面积相符的方块落子', good.ok, true);
  eq('落子后四格归同一区域', diagnose(st).placed[good.clue], 4);
  eq('落子不产生可疑切线', diagnose(st).dubiousCuts, 0);
  // reversed drag corners must mean the same box
  const rev = tryBox(createState(b), { r0: 1, c0: 1, r1: 0, c1: 0 });
  eq('反向拖动与正向同解', rev.ok, true);
  eq('反向拖动圈到同一个线索', rev.clue, good.clue);
  const readout = boxOf(b, 0, 0, 1, 1);
  eq('方块的读数是面积与线索', `${readout.area},${readout.clues.length}`, '4,1');
}

// A box may be legal by the rules of the game and still be impossible by the logic. That is
// not a rejected gesture — it is a move the player should be told is ruled out.
{
  const p = makePuzzle('ruled|1', 'apprentice');
  const b = p.board;
  const st = createState(b);
  const first = nextDeduction(st);
  ok('开局有提示可给', !!first, JSON.stringify(first && first.rule.name));
  if (first && first.kind === 'own') paintCell(st, first.cell, first.clue);
  let deadRid = -1;
  for (let rid = 0; rid < b.rectCount; rid++) if (!st.alive[rid] && deadRid < 0) deadRid = rid;
  ok('一次填格确实剪掉了放法', deadRid >= 0);
  if (deadRid >= 0) {
    const [r0, c0, r1, c1] = b.rectBox(deadRid);
    const res = tryBox(st, { r0, c0, r1, c1 });
    eq('被推理排除的方块仍然可画', res.ok, true);
    eq('但会被标为已被排除', res.ruled, true);
  }
}

// ---------- verify() reads only the board ----------

{
  // 3×2 board: clues 4 at cell 0 and 2 at cell 5, so the only solution is a 2×2 block on the
  // left and a 1×2 column on the right.
  const b = boardOf(3, 2, [[0, 4], [5, 2]]);
  const owner = new Int16Array(6).fill(OPEN);
  // An L of area 4 with a 4 written in it: the area is right, the shape is not.
  for (const t of [0, 1, 2, 4]) owner[t] = b.clueOf[0];
  for (const t of [3, 5]) owner[t] = b.clueOf[1];
  const why = verify(b, owner).map((x) => x.why);
  ok('面积对但形状不是矩形的被判错', why.includes('不是矩形'), why.join(';'));
  const hole = Int16Array.from(owner);
  hole[5] = OPEN;
  ok('留空格被判错', verify(b, hole).some((x) => x.why === '空格'));
  // both blocks have the right area and the right shape — they have just traded clues
  const steal = new Int16Array(6);
  for (const t of [1, 2, 4, 5]) steal[t] = b.clueOf[0];
  for (const t of [0, 3]) steal[t] = b.clueOf[1];
  const stolen = verify(b, steal).map((x) => x.why);
  ok('含了别人线索的矩形被判错', stolen.includes('区域含了别人的线索'), stolen.join(';'));
  ok('不含自己线索的矩形也被判错', stolen.includes('区域不含自己的线索'), stolen.join(';'));
  eq('这块盘的正确答案判得无罪', verify(b, solutionOf(b, [{ r0: 0, c0: 0, r1: 1, c1: 1 }, { r0: 0, c0: 2, r1: 1, c1: 2 }])).length, 0);
}

// ---------- hints are justified, and asking is free ----------

{
  const p = makePuzzle('hint|1', 'regular');
  const st = createState(p.board);
  const before = Array.from(st.owner).join(',');
  const d = nextDeduction(st);
  ok('问一步给得出内容', !!d, JSON.stringify(d && { kind: d.kind, rule: d.rule.name }));
  eq('问一步不改盘', Array.from(st.owner).join(','), before);
  ok('提示的规则都在规则表里', Object.values(Rules).includes(d.rule), d && d.rule.name);
  const text = d.rule.text(p.board, d);
  ok('提示文字带着坐标', /第[\d~]+[行列]/.test(text), text);
  // applying hints to the end must clear the board, and every hint must name a rule
  let used = 0;
  for (;;) {
    const nd = nextDeduction(st);
    if (!nd) break;
    if (nd.kind === 'own') paintCell(st, nd.cell, nd.clue);
    else if (nd.kind === 'cut') toggleCut(st, nd.pair);
    else break;
    used++;
    if (used > p.board.n * 3) break;
  }
  eq('一路用提示能走完这局', complete(p.board, st.owner), true);
  ok('走完一局用到的提示不少于区域数', used >= p.board.clues, `${used} vs ${p.board.clues}`);
}

// ---------- proof by contradiction: a safety net, and a sound one ----------

{
  // Measured claim (2026-09-27, 600 raw layouts across five configs): every board the
  // exhaustive counter calls unique is finished by the unit rules — 397/397. 反证 fires on
  // rare unique boards and on many ambiguous ones, and on ambiguous boards it never finishes
  // (0/62), which is why the picker can afford to prefer boards that do not need it. What the
  // rule must never do is wrong, so the three unique boards where it did fire are re-walked
  // and their kills compared against the counter's answer.
  let scanned = 0;
  let uniqueBoards = 0;
  let uniqueUnfinished = 0;
  const nets = [];
  outer: for (const cfg of [[6, 6, 0, 2, 6], [8, 8, 0, 2, 9], [8, 8, 0.35, 2, 9], [10, 10, 0.45, 2, 12]]) {
    for (let s = 0; s < 120; s++) {
      if (scanned > 500) break outer;
      const w = cfg[0];
      const h = cfg[1];
      let b;
      try {
        b = createBoard({ w, h, values: layout({ w, h, seed: `scan#${cfg.join('-')}#${s}`, mergeChance: cfg[2], minArea: cfg[3], maxArea: cfg[4] }).values });
      } catch {
        continue;
      }
      scanned++;
      const p = solve(b);
      const c = countSolutions(b, { cap: 2, budget: 150_000 });
      if (c.status !== UNIQUE) continue;
      uniqueBoards++;
      if (!p.ok) uniqueUnfinished++;
      if (p.ok && p.nishio > 0) nets.push({ b, p, c });
    }
  }
  ok('扫到的盘足够多', scanned >= 400, String(scanned));
  eq('唯一盘一律能用规则推到底', uniqueUnfinished, 0, `${uniqueBoards} 个唯一盘`);
  ok('反证作为安全网确实偶尔出手（不然是装饰）', nets.length >= 1, `${nets.length}/${scanned}`);
  ok('反证也不是摆设：唯一盘里它一两次就够', nets.every((x) => x.p.nishio <= 2), nets.map((x) => x.p.nishio).join(','));

  for (const { b, p, c } of nets) {
    // which rectangle the exhaustive answer uses for each region
    const answerRid = new Map();
    for (const [clue, r0, c0, r1, c1] of c.placement) {
      for (const rid of b.rectsOf[clue]) {
        const box = b.rectBox(rid);
        if (box[0] === r0 && box[1] === c0 && box[2] === r1 && box[3] === c1) answerRid.set(clue, rid);
      }
    }
    eq('穷举解答的每一块都在候选里', answerRid.size, b.clues);
    const st = createState(b);
    let seen = 0;
    let wrongKill = 0;
    for (let g = 0; g < b.n * 4; g++) {
      const d = nextDeduction(st);
      if (!d) break;
      if (d.kind === 'kill' && d.rule === Rules.nishio) {
        seen++;
        if (answerRid.get(d.clue) === d.rid) wrongKill++;
      }
      applyDeduction(st, d);
    }
    eq('反证从不排除正解', wrongKill, 0);
    ok('这局里反证至少出手一次', seen >= 1, String(seen));
    eq('用提示也能走完这局', complete(b, st.owner), true);
    eq('铅笔的解答与穷举逐格一致', verify(b, st.owner).length, 0);
  }
}

// ---------- what the picker actually ships ----------

{
  // The player-facing promise is stronger than "solvable": a shipped board must be walkable
  // with 问一步 alone, so no hint ever asks for a leap of faith.
  let worst = 0;
  let made = 0;
  for (const tier of TIERS) {
    for (let s = 0; s < 3; s++) {
      const p = makePuzzle(`ship|${s}`, tier.key);
      if (!p) continue;
      made++;
      worst = Math.max(worst, p.nishio);
      const st = createState(p.board);
      let g = 0;
      for (; g < p.board.n * 4; g++) {
        const d = nextDeduction(st);
        if (!d) break;
        applyDeduction(st, d);
      }
      eq(`${tier.key} 的盘能靠提示走完`, complete(p.board, st.owner), true);
    }
  }
  ok('出货盘足够多', made >= 12, String(made));
  eq('出货的盘一律不需要反证', worst, 0);
}

// ---------- separation lines: what the game will tell you to draw ----------

{
  const p = makePuzzle('sep|1', 'trainee');
  const b = p.board;
  const st = createState(b);
  for (let g = 0; g < b.n; g++) {
    const d = nextDeduction(st);
    if (!d || d.kind !== 'own') break;
    paintCell(st, d.cell, d.clue);
  }
  const sep = findSeparation(st);
  if (sep) {
    const [a, c] = b.pairCells(sep.pair);
    ok('分域线落在相邻两格之间', Math.abs(a - c) === 1 || Math.abs(a - c) === b.w, `${a},${c}`);
    eq('分域线不与已有归属冲突', st.owner[a] === OPEN || st.owner[a] !== st.owner[c], true);
    eq('分域线是必然的：没有任何矩形同时盖住这两格', b.rectsOfPair[sep.pair].some((rid) => st.alive[rid]), false);
  } else {
    ok('分域线在走完的盘上不再有新内容', complete(b, st.owner) || sep === null, String(sep));
  }
}

// ---------- difficulty is a measurement ----------

{
  const rows = [];
  for (const tier of TIERS) {
    const scores = [];
    for (let s = 0; s < 8; s++) {
      const p = makePuzzle(`band|${s}`, tier.key);
      if (p) scores.push(p.score);
    }
    scores.sort((a, b) => a - b);
    const inBand = scores.filter((v) => v >= tier.band[0] && v <= tier.band[1]).length;
    eq(`${tier.name} 的样本全部落在目标区间内`, inBand, scores.length);
    rows.push({ key: tier.key, median: scores[scores.length >> 1] });
  }
  for (let i = 1; i < rows.length; i++) {
    ok(`${rows[i - 1].key} → ${rows[i].key} 中位分数不下降`, rows[i].median >= rows[i - 1].median, `${rows[i - 1].median} → ${rows[i].median}`);
  }
  eq('档位是五档', TIERS.length, 5);
}

{
  // The same seed must produce the same board; a different seed must not.
  const a = makePuzzle('det|1', 'regular');
  const b = makePuzzle('det|1', 'regular');
  const c = makePuzzle('det|2', 'regular');
  eq('同一种子给出同一盘面', a.givens.join(','), b.givens.join(','));
  eq('同一种子给出同一难度分', a.score, b.score);
  ok('不同种子给出不同盘面', a.givens.join(',') !== c.givens.join(','));
}

{
  // A board the picker would not accept on its own band still has to be reported honestly.
  const r = generate({ w: 6, h: 6, seed: 'empty|1', band: [10_000, 10_001], tries: 6, mergeChance: 0.15, maxArea: 6 });
  ok('区间外没有候选时如实报告', !r.ok || r.offBand > 0, JSON.stringify({ ok: r.ok, offBand: r.offBand }));
}

// ---------- storage: the run's cost travels with the board ----------

{
  Store.reset();
  const p = makePuzzle('unit|store', 'regular');
  // A mid-run board, not a finished one: the encoding has to carry OPEN as faithfully as it
  // carries a clue index, and an empty cell stored in a byte array comes back as 255.
  const full = Int16Array.from(solutionOf(p.board, p.partition));
  const ink = full.map((v, t) => (t % 3 === 0 ? OPEN : v));
  Store.saveResume(p, ink, 61_000, { moves: 9, hints: 2 });
  const r = Store.resume();
  eq('存档带上步数', r.moves, 9);
  eq('存档带上提示数', r.hints, 2);
  eq('存档带计时', r.elapsedMs, 61000);
  eq('存档能一格不差地还原归属', Array.from(r.board).join(','), Array.from(ink).join(','));
  ok('空格还原后仍是空格', r.board.every((v) => v === OPEN || v >= 0) && r.board.some((v) => v === OPEN));
  eq('存档记的是原始种子', r.seed, p.originSeed);
  // An early quit is the save the encoding is really for: a board with three regions drawn is
  // almost all OPEN, and one number per cell would write a hundred of them to make a point.
  Store.saveResume(p, full.map((v, t) => (t < 8 ? v : OPEN)), 4_000, { moves: 3, hints: 0 });
  const early = Store.resume();
  ok('开局就退出时，存档明显小于一格一数', early.ink.length < p.board.n / 2, `${early.ink.length} vs ${p.board.n} 格`);
  eq('早退的存档也一格不差', Array.from(early.board).join(','), Array.from(full.map((v, t) => (t < 8 ? v : OPEN))).join(','));
  // That is the whole point of storing the seed: redrawing from the save has to give back the
  // board the player was looking at, or the resume would be a new puzzle with the old ink.
  const again = makePuzzle(r.seed, r.tier);
  eq('从存档种子重绘得到同一个盘', Array.from(again.board.values).join(','), Array.from(p.board.values).join(','));
  eq('重绘出来的盘尺寸也对', `${again.board.w}×${again.board.h}`, p.size);

  eq('首个纪录直接成立', Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '10×10' }), true);
  eq('更快但更靠提示的不算破纪录', Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '10×10' }), false);
  eq('同样求助次数下省步数的算破纪录', Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '10×10' }), true);
  eq('步数也相同时才比时间', Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '10×10' }), false);
  eq('纪录里存的是最好的那一次', Store.best('regular').moves, 12);
  Store.clearResume();
  eq('清档之后没有续局', Store.resume(), null);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
