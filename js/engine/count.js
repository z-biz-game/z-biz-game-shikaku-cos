// Independent solution counter. It shares nothing with solve(): no candidate pool, no
// owner masks, no rules. It enumerates rectangles from the board dimensions and the clue
// values alone, the way a person checking an answer sheet would. The generator only ships
// a board when this and the pencil solver agree.

import { OPEN } from './shikaku.js';

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

export function countSolutions(board, { cap = 2, budget = 250_000 } = {}) {
  const { w, h, n } = board;
  const taken = new Uint8Array(n);
  const maxArea = Math.max(...board.values);
  let solutions = 0;
  let nodes = 0;
  let exhausted = true;
  let first = null;
  const placement = [];

  const firstFree = () => {
    for (let t = 0; t < n; t++) if (!taken[t]) return t;
    return -1;
  };

  const walk = () => {
    nodes++;
    if (nodes > budget) {
      exhausted = false;
      return;
    }
    const t = firstFree();
    if (t === -1) {
      solutions++;
      // the trail is unwound as the search backs out, so the answer has to be copied at
      // the moment it is found rather than read off the stack afterwards
      if (!first) first = placement.map((p) => p.slice());
      return;
    }
    const r = Math.floor(t / w);
    const c = t % w;
    for (let r0 = r; r0 >= 0; r0--) {
      for (let r1 = r; r1 < h; r1++) {
        const rows = r1 - r0 + 1;
        for (let c0 = c; c0 >= 0; c0--) {
          for (let c1 = c; c1 < w; c1++) {
            const cols = c1 - c0 + 1;
            const area = rows * cols;
            if (area > maxArea) continue;
            let clue = OPEN;
            let ok = true;
            for (let rr = r0; rr <= r1 && ok; rr++) {
              for (let cc = c0; cc <= c1; cc++) {
                const u = rr * w + cc;
                if (taken[u]) {
                  ok = false;
                  break;
                }
                const k = board.clueOf[u];
                if (k !== OPEN) {
                  if (clue !== OPEN) {
                    ok = false;
                    break;
                  }
                  clue = k;
                }
              }
            }
            // one rectangle, one clue, and the area has to answer to that clue
            if (!ok || clue === OPEN || board.values[clue] !== area) continue;
            for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) taken[rr * w + cc] = 1;
            placement.push([clue, r0, c0, r1, c1]);
            walk();
            placement.pop();
            for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) taken[rr * w + cc] = 0;
            if (solutions >= cap || !exhausted) return;
          }
        }
      }
    }
  };

  walk();
  const status = !exhausted && solutions < 2 ? OVERBUDGET : solutions === 0 ? NONE : solutions === 1 ? UNIQUE : MANY;
  return { solutions, status, nodes, placement: first || [] };
}

// The answer the counter walked into, as an owner map. Used by the tests to compare the
// two independent views of the same board cell by cell.
export function ownerMap(board, placement) {
  const owner = new Int16Array(board.n).fill(OPEN);
  for (const [clue, r0, c0, r1, c1] of placement) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) owner[r * board.w + c] = clue;
  }
  return owner;
}
