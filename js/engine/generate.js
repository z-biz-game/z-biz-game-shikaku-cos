// Puzzle generator. It cuts the board into rectangles at random, writes one clue into
// each, then merges a few neighbouring regions so the answer is no longer a set of
// obvious boxes. Nothing here decides whether a board is good: the pencil solver has to
// be able to finish it and the independent counter has to call it unique, and only the
// measured score picks which candidate ships.

import { makeRng } from './rng.js';
import { createBoard, solve, OPEN } from './shikaku.js';
import { countSolutions } from './count.js';

// A random tiling by axis-aligned rectangles. The cell that is furthest up and left is
// always the one we fill next, which forces each new rectangle's top-left corner onto it
// and makes the tiling exact without any retrying.
function randomRects(w, h, rng, { minArea = 2, maxArea = 12 }) {
  const taken = new Uint8Array(w * h);
  const rects = [];
  for (let t = 0; t < w * h; t++) {
    if (taken[t]) continue;
    const r0 = Math.floor(t / w);
    const c0 = t % w;
    const options = [];
    for (let rows = 1; r0 + rows <= h; rows++) {
      for (let cols = 1; c0 + cols <= w; cols++) {
        const area = rows * cols;
        if (area > maxArea) break;
        let free = true;
        for (let r = r0; r < r0 + rows && free; r++) {
          for (let c = c0; c < c0 + cols; c++) {
            if (taken[r * w + c]) {
              free = false;
              break;
            }
          }
        }
        if (!free) break;
        const leftover = w * h - rects.reduce((a, x) => a + x.area, 0) - area;
        if (leftover > 0 && leftover < minArea) continue;
        if (area >= minArea || leftover === 0) options.push({ r0, c0, r1: r0 + rows - 1, c1: c0 + cols - 1, area });
        else if (area === 1 && leftover >= 0) options.push({ r0, c0, r1: r0 + rows - 1, c1: c0 + cols - 1, area });
      }
    }
    if (!options.length) {
      rects.push({ r0, c0, r1: r0, c1: c0, area: 1 });
      taken[t] = 1;
      continue;
    }
    // wider choices make for weirder tilings, and weirder tilings make for better puzzles
    const pick = options[rng.int(options.length)];
    for (let r = pick.r0; r <= pick.r1; r++) for (let c = pick.c0; c <= pick.c1; c++) taken[r * w + c] = 1;
    rects.push(pick);
  }
  return rects;
}

// Two regions whose union is still a rectangle can share one clue. That is what turns a
// solved-at-a-glance board into one where a box has to be argued for.
function mergeRects(w, h, rects, rng, chance) {
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < rects.length && !merged; a++) {
      for (let b = a + 1; b < rects.length && !merged; b++) {
        const x = rects[a];
        const y = rects[b];
        const box = {
          r0: Math.min(x.r0, y.r0),
          c0: Math.min(x.c0, y.c0),
          r1: Math.max(x.r1, y.r1),
          c1: Math.max(x.c1, y.c1),
        };
        if ((box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) !== x.area + y.area) continue;
        if (x.area + y.area > 20 || !rng.chance(chance)) continue;
        box.area = x.area + y.area;
        rects.splice(b, 1);
        rects.splice(a, 1, box);
        merged = true;
        break;
      }
    }
  }
  return rects;
}

export function layout({ w, h, seed, mergeChance = 0.35, minArea = 2, maxArea = 12 } = {}) {
  const rng = makeRng(`${seed}|layout|${w}x${h}`);
  let rects = randomRects(w, h, rng, { minArea, maxArea });
  rects = mergeRects(w, h, rects, rng, mergeChance);
  const values = new Int16Array(w * h);
  const cells = [];
  for (const r of rects) {
    const list = [];
    for (let rr = r.r0; rr <= r.r1; rr++) for (let cc = r.c0; cc <= r.c1; cc++) list.push(rr * w + cc);
    // the clue may sit anywhere inside its region, and where it sits changes which
    // rectangles are possible for it — so this choice is part of the puzzle, not cosmetics
    const cell = list[rng.int(list.length)];
    values[cell] = r.area;
    cells.push(cell);
  }
  return { values, rects, clueCells: cells };
}

export function build(opts) {
  const { values } = layout(opts);
  return createBoard({ w: opts.w, h: opts.h, values });
}

// The picker is the measurement: candidates are generated, solved with the pencil path and
// counted with the independent search, and the closest score to the band wins. `offBand`
// is reported so the harness can tell a selected difficulty from an accidental one.
export function generate(opts = {}) {
  const {
    w = 8,
    h = 8,
    seed = 'plain',
    band = null,
    tries = 200,
    mergeChance = 0.35,
    minArea = 2,
    maxArea = 12,
    report = () => {},
  } = opts;
  let best = null;
  let drawn = 0;
  const stats = { inBand: 0, unsolvable: 0, ambiguous: 0, overbudget: 0 };
  const keyOf = (c) => c.offBand + 4 * c.nishio;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    let board;
    let rects;
    let givens;
    try {
      const cut = layout({ w, h, seed: trial, mergeChance, minArea, maxArea });
      rects = cut.rects;
      givens = Int16Array.from(cut.values);
      board = createBoard({ w, h, values: cut.values });
    } catch {
      continue;
    }
    drawn++;
    const t0 = performance.now();
    const p = solve(board);
    const ms = performance.now() - t0;
    if (!p.ok) {
      stats.unsolvable++;
      report({ k, stage: 'pencil', ok: false, score: p.score });
      continue;
    }
    const c = countSolutions(board, { cap: 2, budget: 120_000 });
    if (c.status === 'OVERBUDGET') {
      stats.overbudget++;
      continue;
    }
    if (c.status !== 'UNIQUE') {
      stats.ambiguous++;
      continue;
    }
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    if (band && p.score >= band[0] && p.score <= band[1]) stats.inBand++;
    const cand = {
      board,
      seed: trial,
      score: p.score,
      steps: p.steps,
      nishio: p.nishio,
      ms,
      offBand,
      breakdown: p.breakdown,
      gen: k + 1,
      partition: rects,
      givens,
    };
    if (!best || keyOf(cand) < keyOf(best)) best = cand;
    report({ k, stage: 'ready', score: p.score, offBand, ms });
    // a board inside the band that also needed no contradiction is shipped straight away. The
    // test is deliberately free of wall-clock: the save stores this seed to redraw the same
    // board on resume, so a draw that depended on how loaded the machine is would not be
    // reproducible.
    if (band && cand.offBand === 0 && cand.nishio === 0) break;
  }
  if (!best) {
    return { ok: false, stats, drawn, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  }
  return { ok: true, stats, drawn, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed, tries: tier.tries || 240 });
  if (!r.ok) return null;
  return {
    ...r,
    // The save and the record book key on the tier *key*, and a resume has to be able to
    // redraw the same board — so the caller's seed travels alongside the trial seed the
    // generator derived from it.
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
  };
}

// The partition the layout was cut from, as an owner map. verify() checks it without
// looking at any of the machinery that built it — which is the point of the check.
export function solutionOf(board, rects) {
  const owner = new Int16Array(board.n).fill(OPEN);
  for (const r of rects) {
    let clue = OPEN;
    for (let rr = r.r0; rr <= r.r1 && clue === OPEN; rr++) {
      for (let cc = r.c0; cc <= r.c1; cc++) {
        const k = board.clueOf[rr * board.w + cc];
        if (k !== OPEN) {
          clue = k;
          break;
        }
      }
    }
    if (clue === OPEN) throw new Error('切出来一块没有线索的区域');
    for (let rr = r.r0; rr <= r.r1; rr++) for (let cc = r.c0; cc <= r.c1; cc++) owner[rr * board.w + cc] = clue;
  }
  return owner;
}

// Bands are selection targets, not adjectives: each one is the measured spread of pencil
// scores at that board size (probe over 40 layouts per config, 2026-09-27). Medians came
// out 47 / 87 / 143 / 214 / 291, and the score is a sum over deductions, so it grows with
// the board — the bands order the tiers by work, and the harness asserts that ordering.
export const TIERS = [
  { key: 'trainee', name: '初学', w: 6, h: 6, band: [38, 58], mergeChance: 0.15, minArea: 2, maxArea: 6 },
  { key: 'apprentice', name: '上手', w: 8, h: 8, band: [70, 106], mergeChance: 0.35, minArea: 2, maxArea: 9 },
  { key: 'regular', name: '熟练', w: 10, h: 10, band: [118, 172], mergeChance: 0.45, minArea: 2, maxArea: 12 },
  { key: 'expert', name: '高阶', w: 12, h: 12, band: [180, 258], mergeChance: 0.5, minArea: 2, maxArea: 14 },
  { key: 'master', name: '大师', w: 14, h: 14, band: [240, 345], mergeChance: 0.55, minArea: 2, maxArea: 16 },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export { OPEN };
