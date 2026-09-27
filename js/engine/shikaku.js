// Shikaku engine. The board is cut into rectangles; each rectangle holds exactly one
// clue and its area equals that clue. Because a rectangle is fully described by its four
// corners, "which region owns this cell" is the only fact worth storing, so the board
// state is one owner map plus pencil cuts.
//
// `solve()` below is the pencil path: it is the player's route through the board, the
// acceptance test for a generated puzzle and the source of every hint, so it never
// backtracks. Search lives only in count.js, and the generator trusts neither.

export const OPEN = -1;

// rects are stored flat, RECT_STRIDE ints each: [clue, r0, c0, r1, c1, area]
export const RECT_STRIDE = 6;

const pop32 = (m) => {
  m -= (m >>> 1) & 0x55555555;
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const lowBit = (m) => Math.log2(m & -m) | 0;

export function createBoard({ w, h, values }) {
  if (!(w > 1 && h > 1)) throw new Error('board too small');
  const n = w * h;
  if (values.length !== n) throw new Error('values length mismatch');

  const clueOf = new Int16Array(n).fill(OPEN);
  const clueCell = [];
  const valuesOf = [];
  for (let t = 0; t < n; t++) {
    const v = values[t] | 0;
    if (v > 0) {
      clueOf[t] = clueCell.length;
      clueCell.push(t);
      valuesOf.push(v);
    }
  }
  const clues = clueCell.length;
  if (!clues) throw new Error('盘上没有线索');
  // Ownership is tracked as one bit per region, so a board cannot have more than 30 of
  // them. The generator is told the cap and never asks for a denser board.
  if (clues > 30) throw new Error(`线索太多，位掩码放不下 (${clues})`);
  let sum = 0;
  for (const v of valuesOf) sum += v;
  // Regions tile the board and each one's area is its clue, so the clues must add up to
  // the cell count exactly. A board that misses this cannot have a solution at all.
  if (sum !== n) throw new Error(`线索总和 ${sum} ≠ 格数 ${n}，这种盘面不可能有解`);

  const rectsOf = Array.from({ length: clues }, () => []);
  const rectArr = [];
  const cellsOf = [];
  const atCell = Array.from({ length: n }, () => []);
  for (let i = 0; i < clues; i++) {
    const v = valuesOf[i];
    const cr = Math.floor(clueCell[i] / w);
    const cc = clueCell[i] % w;
    for (let rows = 1; rows <= Math.min(h, v); rows++) {
      if (v % rows) continue;
      const cols = v / rows;
      if (cols > w) continue;
      for (let r0 = Math.max(0, cr - rows + 1); r0 <= Math.min(cr, h - rows); r0++) {
        for (let c0 = Math.max(0, cc - cols + 1); c0 <= Math.min(cc, w - cols); c0++) {
          const cells = [];
          let clash = false;
          for (let r = r0; r < r0 + rows && !clash; r++) {
            for (let c = c0; c < c0 + cols; c++) {
              const t = r * w + c;
              if (clueOf[t] !== OPEN && clueOf[t] !== i) {
                clash = true;
                break;
              }
              cells.push(t);
            }
          }
          if (clash) continue;
          const id = rectArr.length / RECT_STRIDE;
          rectArr.push(i, r0, c0, r0 + rows - 1, c0 + cols - 1, v);
          cellsOf.push(Int32Array.from(cells));
          for (const t of cells) atCell[t].push(id);
          rectsOf[i].push(id);
        }
      }
    }
  }
  const rectCount = rectArr.length / RECT_STRIDE;
  // A clue that no rectangle can satisfy is not a board: say so here rather than letting a
  // zero-candidate region read as "已推完" downstream.
  for (let i = 0; i < clues; i++) {
    if (!rectsOf[i].length) throw new Error(`线索 ${valuesOf[i]} @${clueCell[i]} 没有任何可放的矩形`);
  }

  // Two rectangles that share a cell can never both be placed. Recording that once turns
  // "would this placement leave another region nowhere?" into a count, not a search.
  const conflictOf = Array.from({ length: rectCount }, () => []);
  for (let t = 0; t < n; t++) {
    const list = atCell[t];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        conflictOf[list[a]].push(list[b]);
        conflictOf[list[b]].push(list[a]);
      }
    }
  }
  for (let r = 0; r < rectCount; r++) conflictOf[r] = Int32Array.from(new Set(conflictOf[r]));

  // A cut is drawn between two side-adjacent cells: "these two can never share a region".
  const pairOf = (a, b) => {
    const lo = a < b ? a : b;
    return b - lo === 1 && a !== b ? lo : n + lo;
  };
  const rectsOfPair = Array.from({ length: 2 * n }, () => []);
  for (let i = 0; i < clues; i++) {
    for (const rid of rectsOf[i]) {
      const cells = new Set(cellsOf[rid]);
      for (const t of cells) {
        const r = Math.floor(t / w);
        const c = t % w;
        if (c + 1 < w && cells.has(t + 1)) rectsOfPair[pairOf(t, t + 1)].push(rid);
        if (r + 1 < h && cells.has(t + w)) rectsOfPair[pairOf(t, t + w)].push(rid);
      }
    }
  }

  return {
    w,
    h,
    n,
    clues,
    values: valuesOf,
    clueOf,
    clueCell,
    rects: Int32Array.from(rectArr),
    rectCount,
    rectsOf,
    cellsOf,
    atCell,
    conflictOf,
    rectsOfPair,
    pairOf,
    cells: Array.from({ length: n }, (_, i) => i),
    ownerCells: Array.from({ length: clues }, () => []),
    rectClue: (rid) => rectArr[rid * RECT_STRIDE],
    rectBox: (rid) => rectArr.slice(rid * RECT_STRIDE + 1, rid * RECT_STRIDE + 5),
    rectArea: (rid) => rectArr[rid * RECT_STRIDE + 5],
    pairCells: (p) => {
      const lo = p < n ? p : p - n;
      return [lo, lo + (p < n ? 1 : w)];
    },
  };
}

export function createState(board) {
  const { n, clues } = board;
  const st = {
    board,
    alive: new Uint8Array(board.rectCount).fill(1),
    cnts: new Int32Array(clues),
    cover: new Int32Array(clues * n),
    mask: new Uint32Array(n),
    owner: new Int16Array(n).fill(OPEN),
    cuts: new Uint8Array(2 * n),
    writes: 0,
    log: [],
    history: [],
    dead: false,
  };
  rebuild(st);
  return st;
}

// Recompute the candidate pool from the marks on the board. Every prune below is derived
// from the owner map, never remembered from a previous run, so dropping a mark snaps the
// pool back to exactly what the remaining marks justify.
export function rebuild(st) {
  const { board } = st;
  const { n, clues } = board;
  st.alive.fill(1);
  st.cnts.fill(0);
  st.cover.fill(0);
  st.mask.fill(0);
  st.dead = false;
  for (let i = 0; i < clues; i++) st.cnts[i] = board.rectsOf[i].length;
  for (let i = 0; i < clues; i++) {
    const base = i * n;
    const bit = 1 << i;
    for (const rid of board.rectsOf[i]) {
      for (const t of board.cellsOf[rid]) {
        if (!(st.cover[base + t]++)) st.mask[t] |= bit;
      }
    }
  }
  // The marks are applied to a cleared owner map: applyOwner ignores a write that is
  // already there, and rebuild's whole job is to re-derive the prunes from nothing.
  const marks = Int16Array.from(st.owner);
  st.owner.fill(OPEN);
  for (let t = 0; t < n; t++) if (marks[t] !== OPEN) applyOwner(st, t, marks[t], null);
  // A cut is a pencil note and never constrains anything: a wrong line must not be able to
  // make a solvable board unsolvable. It is reported back to the player instead.
  for (let i = 0; i < clues; i++) if (!st.cnts[i]) st.dead = true;
  for (let t = 0; t < n; t++) if (!st.mask[t] && st.owner[t] === OPEN) st.dead = true;
  return st;
}

export function kill(st, rid) {
  if (!st.alive[rid]) return false;
  const { board } = st;
  st.alive[rid] = 0;
  const i = board.rects[rid * RECT_STRIDE];
  const base = i * board.n;
  st.cnts[i]--;
  for (const t of board.cellsOf[rid]) {
    if (--st.cover[base + t] === 0) st.mask[t] &= ~(1 << i);
  }
  if (st.cnts[i] === 0) st.dead = true;
  return true;
}

// The single way a cell gains an owner: it also drops every rectangle that contradicts it.
// `rule` is the justification recorded for the write — passing null re-derives without
// logging, which is what rebuild does.
function applyOwner(st, t, i, rule) {
  const { board } = st;
  if (st.owner[t] === i) return false;
  const before = st.owner[t];
  let killed = 0;
  for (const rid of board.rectsOf[i]) {
    if (st.alive[rid] && !board.cellsOf[rid].includes(t)) killed += kill(st, rid) ? 1 : 0;
  }
  for (const rid of board.atCell[t]) {
    if (board.rects[rid * RECT_STRIDE] === i) continue;
    if (st.alive[rid]) killed += kill(st, rid) ? 1 : 0;
  }
  st.owner[t] = i;
  if (rule) {
    st.log.push({ rule, cell: t, clue: i, before, killed });
    st.writes++;
  }
  return true;
}

// ---- the rules ---------------------------------------------------------------
// Each one states something that is true in *every* solution, so applying them in any
// order, to any depth, can never rule out the real answer.

export const Rules = {
  // Only one region could ever reach this cell, so it is in it.
  onlyOwner: {
    name: '唯一归属',
    weight: 1,
    text: (b, d) => `${cellName(b, d.cell)} 只有 ${areaName(b, d.clue)} 放得下`,
  },
  // Every rectangle still possible for a region covers this cell.
  insideAll: {
    name: '全线穿透',
    weight: 2,
    text: (b, d) => `${areaName(b, d.clue)} 无论怎么放都盖住 ${cellName(b, d.cell)}`,
  },
  // A region with one surviving rectangle is completely known.
  regionPinned: {
    name: '区域锁定',
    weight: 1.5,
    text: (b, d) => `${areaName(b, d.clue)} 只剩一种形状：${rectName(b, d.rid)}`,
  },
  // Placing this rectangle would leave some other region with nothing to place at all.
  noSupport: {
    name: '无处安放',
    weight: 3,
    text: (b, d) => `若 ${areaName(b, d.clue)} 放在 ${rectName(b, d.rid)}，${areaName(b, d.blocked)} 就无处可放`,
  },
  // Two adjacent cells that no rectangle can ever cover together: draw the line.
  separate: {
    name: '必然分域',
    weight: 1,
    text: (b, d) => `${cellName(b, d.cells[0])} 与 ${cellName(b, d.cells[1])} 不可能同域`,
  },
  // Proof by contradiction, one assumption deep, only once the rules above have stalled.
  nishio: {
    name: '反证',
    weight: 6,
    text: (b, d) => `假设 ${areaName(b, d.clue)} 放在 ${rectName(b, d.rid)}，推到底会矛盾`,
  },
};

const cellName = (b, t) => `第${Math.floor(t / b.w) + 1}行${(t % b.w) + 1}列`;
const areaName = (b, i) => `${b.values[i]} 格区域`;
const rectName = (b, rid) => {
  const [r0, c0, r1, c1] = b.rectBox(rid);
  return `第${r0 + 1}~${r1 + 1}行 × 第${c0 + 1}~${c1 + 1}列`;
};

// One sweep of the unit rules. Returns 'dead', 'idle' or the deductions applied.
export function propagate(st, opts = {}) {
  const { board } = st;
  const found = [];
  // 1. a cell that only one region can reach
  for (let t = 0; t < board.n; t++) {
    const m = st.mask[t];
    if (!m) {
      st.dead = true;
      return { status: 'dead', found };
    }
    if (st.owner[t] === OPEN && pop32(m) === 1) {
      const i = lowBit(m);
      if (!opts.previewOnly) applyOwner(st, t, i, Rules.onlyOwner.name);
      found.push({ kind: 'own', cell: t, clue: i, rule: Rules.onlyOwner });
    }
  }
  // 2. regions whose surviving rectangles agree on cells, or have collapsed to one
  for (let i = 0; i < board.clues; i++) {
    if (st.cnts[i] === 0) {
      st.dead = true;
      return { status: 'dead', found };
    }
    let common = null;
    let pinnedRid = OPEN;
    for (const rid of board.rectsOf[i]) {
      if (!st.alive[rid]) continue;
      pinnedRid = rid;
      const cells = board.cellsOf[rid];
      if (common === null) common = new Set(cells);
      else for (const t of Array.from(common)) if (!cells.includes(t)) common.delete(t);
      if (!common.size) break;
    }
    if (!common || !common.size) continue;
    const fresh = [...common].filter((t) => st.owner[t] === OPEN);
    if (!fresh.length) continue;
    const rule = st.cnts[i] === 1 ? Rules.regionPinned : Rules.insideAll;
    for (const t of fresh) {
      if (!opts.previewOnly) applyOwner(st, t, i, rule.name);
      found.push({ kind: 'own', cell: t, clue: i, rid: pinnedRid, rule });
    }
    if (st.cnts[i] === 1) found.push({ kind: 'rect', clue: i, rid: pinnedRid, rule: Rules.regionPinned });
  }
  // 3. a rectangle that starves another region cannot be the one
  const starving = findUnsupported(st);
  for (const [rid, blocked] of starving) {
    const i = board.rects[rid * RECT_STRIDE];
    if (!opts.previewOnly) {
      kill(st, rid);
      st.log.push({ rule: Rules.noSupport.name, rid, clue: i, killed: 1, undo: false });
    }
    found.push({ kind: 'kill', clue: i, rid, blocked, rule: Rules.noSupport });
  }
  return { status: starving.length || found.length ? 'progress' : 'idle', found };
}

// For every rectangle still on the table: is there a surviving rectangle somewhere else
// that stays out of its way, for each of the other regions? A region that has nowhere
// left to go condemns it.
function findUnsupported(st) {
  const { board } = st;
  const out = [];
  const tally = new Int32Array(board.clues);
  for (let i = 0; i < board.clues; i++) {
    if (st.cnts[i] < 2) continue;
    for (const rid of board.rectsOf[i]) {
      if (!st.alive[rid]) continue;
      tally.fill(0);
      let touched = 0;
      for (const other of board.conflictOf[rid]) {
        if (!st.alive[other]) continue;
        const j = board.rects[other * RECT_STRIDE];
        if (j === i) continue;
        if (!tally[j]++) touched++;
      }
      for (let j = 0; j < board.clues; j++) {
        if (j === i || st.cnts[j] === 0) continue;
        if (tally[j] === st.cnts[j]) {
          out.push([rid, j]);
          break;
        }
      }
    }
  }
  return out;
}

// One assumption deep: place a rectangle, run the unit rules, and if the board dies the
// rectangle was impossible. This is the only place anything is hypothesised, and its
// conclusion is still a proof.
export function findContradiction(st) {
  const { board } = st;
  for (let i = 0; i < board.clues; i++) {
    if (st.cnts[i] < 2) continue;
    for (const rid of board.rectsOf[i]) {
      if (!st.alive[rid]) continue;
      const probe = cloneState(board, st);
      for (const t of board.cellsOf[rid]) applyOwner(probe, t, i, null);
      let dead = false;
      for (let guard = 0; guard < 64; guard++) {
        const r = propagate(probe, { previewOnly: false });
        if (r.status === 'dead') {
          dead = true;
          break;
        }
        if (r.status === 'idle') break;
      }
      if (dead) return { kind: 'kill', clue: i, rid, rule: Rules.nishio };
    }
  }
  return null;
}

export function cloneState(board, st) {
  return {
    board,
    alive: Uint8Array.from(st.alive),
    cnts: Int32Array.from(st.cnts),
    cover: Int32Array.from(st.cover),
    mask: Uint32Array.from(st.mask),
    owner: Int16Array.from(st.owner),
    cuts: Uint8Array.from(st.cuts),
    writes: 0,
    log: [],
    history: [],
    dead: st.dead,
  };
}

// ---- the pencil path ---------------------------------------------------------

export function resetMarks(st) {
  st.owner.fill(OPEN);
  st.cuts.fill(0);
  st.log.length = 0;
  st.history.length = 0;
  st.writes = 0;
  rebuild(st);
  return st;
}

// ---- what a gesture is allowed to write --------------------------------------

// Undo works on whole gestures: one drag, one line, one erase. The snapshot is the board,
// so a gesture that took cells away from three other regions comes back as a unit.
export function snapshot(st) {
  st.history.push({ owner: Int16Array.from(st.owner), cuts: Uint8Array.from(st.cuts) });
  if (st.history.length > 500) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.owner.set(last.owner);
  st.cuts.set(last.cuts);
  st.writes = Math.max(0, st.writes - 1);
  rebuild(st);
  return true;
}

// Reading a box off the board: which clues it holds, and how big it is. The rules of the
// game are exactly "one clue, area equal to it", so this is also the acceptance test.
export function boxOf(board, r0, c0, r1, c1) {
  const cells = [];
  const clues = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const t = r * board.w + c;
      cells.push(t);
      const k = board.clueOf[t];
      if (k !== OPEN && !clues.includes(k)) clues.push(k);
    }
  }
  return { r0, c0, r1, c1, cells, clues, area: cells.length };
}

const findRect = (board, clue, box) =>
  board.rectsOf[clue].find((rid) => {
    const [r0, c0, r1, c1] = board.rectBox(rid);
    return r0 === box.r0 && c0 === box.c0 && r1 === box.r1 && c1 === box.c1;
  });

export function tryBox(st, box) {
  const { board } = st;
  const r0 = Math.min(box.r0, box.r1);
  const c0 = Math.min(box.c0, box.c1);
  const r1 = Math.max(box.r0, box.r1);
  const c1 = Math.max(box.c0, box.c1);
  // A box with one corner off the board would otherwise read cells out of neighbouring
  // rows and call them clues.
  if (r0 < 0 || c0 < 0 || r1 > board.h - 1 || c1 > board.w - 1) {
    return { ok: false, reason: '出界了', box: { r0, c0, r1, c1, cells: [], clues: [], area: 0 } };
  }
  const b = boxOf(board, r0, c0, r1, c1);
  if (!b.clues.length) return { ok: false, reason: '这块里没有数字：每一块都要围住一个数字', box: b };
  if (b.clues.length > 1) return { ok: false, reason: `这块圈住了 ${b.clues.length} 个数字`, box: b };
  const clue = b.clues[0];
  if (b.area !== board.values[clue]) {
    return { ok: false, reason: `面积 ${b.area}，但这里的数字是 ${board.values[clue]}`, box: b, clue };
  }
  const rid = findRect(board, clue, b);
  if (rid === undefined) return { ok: false, reason: '这块放不下', box: b, clue };
  snapshot(st);
  for (const t of b.cells) applyOwner(st, t, clue, '手填');
  return { ok: true, clue, rid, cells: b.cells, ruled: !st.alive[rid] };
}

export function paintCell(st, t, clue) {
  if (clue === OPEN) return false;
  snapshot(st);
  applyOwner(st, t, clue, '手填');
  return true;
}

export function toggleCut(st, pair) {
  snapshot(st);
  st.cuts[pair] ^= 1;
  st.writes++;
  rebuild(st);
  return !!st.cuts[pair];
}

export function eraseCell(st, t) {
  if (st.owner[t] === OPEN) return false;
  snapshot(st);
  st.owner[t] = OPEN;
  rebuild(st);
  return true;
}

// The clue a cell should get when the player taps it in 顺延 mode: the region the cell is
// most constrained by, which is the one the logic has narrowed it down to.
export function ownersFor(st, t) {
  const { board } = st;
  const out = [];
  for (let i = 0; i < board.clues; i++) if (st.cover[i * board.n + t]) out.push(i);
  return out;
}

// Solve from the givens alone: no marks, no input, no backtracking. The result is both the
// verdict on a generated board and the script the hints play out.
export function solve(board, seedState = null) {
  const st = seedState || createState(board);
  if (!seedState) resetMarks(st);
  const used = new Map();
  let nishioUsed = 0;
  let guard = 0;
  for (;;) {
    const sweep = propagate(st);
    if (sweep.status === 'dead') {
      return { ok: false, dead: true, steps: count(used), nishio: nishioUsed, score: score(used), state: st, rows: [] };
    }
    for (const d of sweep.found) bump(used, d.rule.name, d.rule.weight);
    if (sweep.status === 'progress') {
      if (++guard > 400) return { ok: false, dead: false, unfinished: true, steps: count(used), nishio: nishioUsed, score: score(used), state: st, rows: [] };
      continue;
    }
    if (complete(board, st.owner)) break;
    // unit propagation has stalled and the board is not finished: the only way forward is
    // a proof by contradiction, and if even that finds nothing the board is ambiguous
    const hard = findContradiction(st);
    if (!hard) break;
    applyDeduction(st, hard);
    bump(used, hard.rule.name, hard.rule.weight);
    nishioUsed++;
  }
  const unowned = board.cells.filter((t) => st.owner[t] === OPEN).length;
  const ok = complete(board, st.owner) && unowned === 0;
  return {
    ok,
    dead: false,
    unowned,
    steps: count(used),
    nishio: nishioUsed,
    score: score(used),
    breakdown: Object.fromEntries(used),
    state: st,
    rows: [],
  };
}

export function applyDeduction(st, d) {
  const { board } = st;
  snapshot(st);
  if (d.kind === 'own') applyOwner(st, d.cell, d.clue, d.rule.name);
  else if (d.kind === 'kill') {
    kill(st, d.rid);
    st.log.push({ rule: d.rule.name, rid: d.rid, clue: d.clue, killed: 1, undo: false });
  } else if (d.kind === 'rect') {
    for (const t of board.cellsOf[d.rid]) applyOwner(st, t, d.clue, d.rule.name);
  } else if (d.kind === 'cut') {
    st.cuts[d.pair] = 1;
  }
}

function bump(map, name, weight) {
  const cur = map.get(name) || { n: 0, weight };
  cur.n++;
  map.set(name, cur);
}
const count = (map) => [...map.values()].reduce((a, x) => a + x.n, 0);
const score = (map) => {
  let s = 0;
  for (const x of map.values()) s += x.n * x.weight;
  return Math.round(s * 10) / 10;
};

// The next single deduction the board offers, for 问一步 and for hints. Paint-type
// deductions come first because those are the ones a player can act on.
export function nextDeduction(st) {
  const { board } = st;
  const preview = propagate(cloneState(board, st), { previewOnly: true });
  if (preview.status === 'dead') return null;
  const ownable = preview.found.filter((d) => d.kind === 'own');
  if (ownable.length) {
    const pinned = ownable.find((d) => d.rule === Rules.regionPinned);
    return pinned || ownable[0];
  }
  const killable = preview.found.filter((d) => d.kind === 'kill');
  if (killable.length) return killable[0];
  const cut = findSeparation(st);
  if (cut) return cut;
  return findContradiction(st);
}

// Cells that no single rectangle can ever join: the line a player draws on paper.
export function findSeparation(st) {
  const { board } = st;
  for (let p = 0; p < 2 * board.n; p++) {
    if (st.cuts[p]) continue;
    const list = board.rectsOfPair[p];
    if (!list.length) continue;
    if (list.some((rid) => st.alive[rid])) continue;
    const [a, b] = board.pairCells(p);
    if (st.owner[a] !== OPEN && st.owner[a] === st.owner[b]) continue;
    return { kind: 'cut', cells: [a, b], pair: p, rule: Rules.separate };
  }
  return null;
}

// ---- acceptance test, independent of the candidate pool ----------------------

// A finished board is checked from the owner map alone: every cell owned, and every
// region a rectangle whose area is its clue and which holds its own clue and no other.
// Nothing here reads `alive`, so a bug in the pruning cannot fake a win.
export function verify(board, owner) {
  const bad = [];
  for (let t = 0; t < board.n; t++) if (owner[t] === OPEN) bad.push({ why: '空格', cell: t });
  for (let i = 0; i < board.clues; i++) {
    const cells = [];
    for (let t = 0; t < board.n; t++) if (owner[t] === i) cells.push(t);
    if (!cells.length) {
      bad.push({ why: '区域没有格子', clue: i });
      continue;
    }
    let r0 = 1e9;
    let c0 = 1e9;
    let r1 = -1;
    let c1 = -1;
    for (const t of cells) {
      const r = Math.floor(t / board.w);
      const c = t % board.w;
      if (r < r0) r0 = r;
      if (c < c0) c0 = c;
      if (r > r1) r1 = r;
      if (c > c1) c1 = c;
    }
    const area = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (area !== cells.length) bad.push({ why: '不是矩形', clue: i, cells: cells.slice() });
    if (cells.length !== board.values[i]) bad.push({ why: '面积与线索不符', clue: i, cells: cells.slice() });
    const own = board.clueCell[i];
    if (own < r0 * board.w + c0 || own > r1 * board.w + c1 || Math.floor(own / board.w) < r0 || Math.floor(own / board.w) > r1 || own % board.w < c0 || own % board.w > c1) {
      bad.push({ why: '区域不含自己的线索', clue: i, cells: cells.slice() });
    }
    for (const t of cells) if (board.clueOf[t] !== OPEN && board.clueOf[t] !== i) bad.push({ why: '区域含了别人的线索', clue: i, cells: [t] });
  }
  return bad;
}

export function complete(board, owner) {
  for (let t = 0; t < board.n; t++) if (owner[t] === OPEN) return false;
  return verify(board, owner).length === 0;
}

// ---- readouts for the UI -----------------------------------------------------

export function diagnose(st) {
  const { board } = st;
  const cellsPerClue = new Int32Array(board.clues);
  const listOf = Array.from({ length: board.clues }, () => []);
  let owned = 0;
  for (let t = 0; t < board.n; t++) {
    const i = st.owner[t];
    if (i === OPEN) continue;
    owned++;
    cellsPerClue[i]++;
    listOf[i].push(t);
  }
  const problems = verify(board, st.owner).filter((p) => p.why !== '空格');
  // A half-painted region is not a mistake yet: three cells in an L can still grow into the
  // rectangle its clue asks for. What *is* a mistake is ink that no surviving candidate can
  // hold — the pool is sound, so if the real partition were still reachable some alive rect
  // would cover these cells. Only that counts as contradicted, and only that is reported.
  const shapeBad = new Set();
  const fitsAlive = (i) => {
    const cells = listOf[i];
    if (!cells.length) return true;
    if (cells.length > board.values[i]) return false;
    for (const rid of board.rectsOf[i]) {
      if (!st.alive[rid]) continue;
      const rect = board.cellsOf[rid];
      if (rect.length < cells.length) continue;
      if (cells.every((t) => rect.includes(t))) return true;
    }
    return false;
  };
  for (let i = 0; i < board.clues; i++) if (!fitsAlive(i)) shapeBad.add(i);
  // the pool is read directly rather than trusting st.dead, which only the propagation
  // loop sets: a mark can strand a region without any rule having run since
  let stuck = false;
  for (let i = 0; i < board.clues; i++) if (!st.cnts[i]) stuck = true;
  for (let t = 0; t < board.n; t++) if (!st.mask[t] && st.owner[t] === OPEN) stuck = true;
  let dubiousCuts = 0;
  for (let p = 0; p < st.cuts.length; p++) {
    if (!st.cuts[p]) continue;
    if (board.rectsOfPair[p].some((rid) => st.alive[rid])) dubiousCuts++;
  }
  const regions = [];
  for (let i = 0; i < board.clues; i++) {
    // Same count as the clue and still fitting one candidate means the region *is* that
    // candidate: equal counts make the containment an equality.
    const done = cellsPerClue[i] === board.values[i] && fitsAlive(i);
    regions.push({ clue: i, cells: cellsPerClue[i], want: board.values[i], done, bad: shapeBad.has(i), pinned: st.cnts[i] === 1, list: listOf[i] });
  }
  return {
    owned,
    total: board.n,
    placed: cellsPerClue,
    regions,
    shapeBad,
    problems,
    dubiousCuts,
    stuck,
    remaining: board.n - owned,
    clues: board.clues,
    filled: regions.filter((r) => r.done).length,
  };
}
