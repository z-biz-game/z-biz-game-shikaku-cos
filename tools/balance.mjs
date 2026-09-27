// 难度实测台. Reads the difficulty of each tier off generated boards — it does not set it.
//
// The numbers printed here are what TIERS[].band has to contain. Editing a band without
// re-running this is how the ladder becomes decoration and the README's measured table
// becomes a lie.

import { performance } from 'node:perf_hooks';
import { TIERS, makePuzzle, solutionOf } from '../js/engine/generate.js';
import { createBoard, solve, verify } from '../js/engine/shikaku.js';
import { countSolutions, UNIQUE } from '../js/engine/count.js';

const N = Number(process.env.SAMPLES || 40);

const q = (sorted, p) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
};

let worst = 0;
const ladder = [];
for (const tier of TIERS) {
  const scores = [];
  const steps = [];
  const nishio = [];
  const clues = [];
  const tries = [];
  let accepted = 0;
  let inBand = 0;
  let ms = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const p = makePuzzle(`balance|${s}`, tier.key);
    ms += performance.now() - t0;
    if (!p) continue;
    accepted++;
    if (p.offBand === 0) inBand++;
    scores.push(p.score);
    steps.push(p.steps);
    nishio.push(p.nishio);
    clues.push(p.board.clues);
    tries.push(p.gen);
  }
  const sort = (a) => a.slice().sort((x, y) => x - y);
  const line = (label, arr, fmt = (v) => v) => {
    const a = sort(arr);
    console.log(`    ${label.padEnd(8)} p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  max ${fmt(a[a.length - 1])}`);
  };
  console.log(
    `\n${tier.name} ${tier.key} ${tier.w}×${tier.h}（合并概率 ${tier.mergeChance}，目标分 ${tier.band[0]}–${tier.band[1]}）`,
  );
  console.log(
    `    出题成功率 ${accepted}/${N}，命中目标区间 ${inBand}/${accepted}，平均抽 ${((tries.reduce((a, b) => a + b, 0) / Math.max(1, tries.length)) || 0).toFixed(1)} 次，耗时 ${(ms / N).toFixed(0)} ms/局`,
  );
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('推理步数', steps);
  line('反证次数', nishio);
  line('区域数', clues);
  ladder.push({ label: `${tier.name} ${tier.w}×${tier.h}`, median: q(sort(scores), 0.5) || 0, inBand, accepted });
  worst = Math.max(worst, ms / N);
}

// The ladder is the product promise: 初学 must read easier than 大师, and a tier that never
// lands in its own band means the band was never measured.
console.log('\n== 档位阶梯（中位分数必须单调，命中率不能是个位数）==');
let mono = true;
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median > prev;
    const okHit = l.accepted === 0 || l.inBand / l.accepted >= 0.8;
    if (!okScore || !okHit) mono = false;
    console.log(`  ${okScore && okHit ? '✓' : '✗'} ${l.label} 中位 ${l.median.toFixed(1)}  命中区间 ${l.inBand}/${l.accepted}`);
    prev = l.median;
  }
  console.log(mono ? '  阶梯成立' : '  阶梯不成立：band 需要重测');
}

// Cross-check one: the exhaustive counter is allowed to disagree with the pencil solver and
// must not. A capped count is never counted as agreement.
console.log('\n== 穷举复核（第二套独立实现，逐点比对切法）==');
let checked = 0;
let bad = 0;
for (const tier of TIERS) {
  for (let s = 0; s < 6; s++) {
    const p = makePuzzle(`cross|${s}`, tier.key);
    if (!p) continue;
    const c = countSolutions(p.board, { cap: 2, budget: 400_000 });
    checked++;
    if (c.status !== UNIQUE) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 穷举解数 ${c.solutions}（铅笔求解器判定唯一）`);
      continue;
    }
    // not just "one solution" — the one solution, cell by cell, against the pencil path
    const fromCounter = new Int16Array(p.board.n).fill(-1);
    for (const [clue, r0, c0, r1, c1] of c.placement) {
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) fromCounter[r * p.board.w + cc] = clue;
    }
    const mine = solve(p.board).state.owner;
    let diff = 0;
    for (let t = 0; t < p.board.n; t++) if (mine[t] !== fromCounter[t]) diff++;
    if (diff) {
      bad++;
      console.log(`  ✗ ${tier.name} seed ${s}: 两套实现的解答有 ${diff} 格不同`);
    }
  }
}
console.log(`  ${checked - bad}/${checked} 局穷举复核与铅笔判定一致（含逐格解答比对）`);

// Cross-check two: re-solving an accepted board must reproduce the same score, or the score
// is a property of the generator's state rather than of the board.
{
  let drift = 0;
  for (const tier of TIERS) {
    const p = makePuzzle(`drift|1`, tier.key);
    if (!p) continue;
    const board = createBoard({ w: tier.w, h: tier.h, values: p.givens });
    const r = solve(board);
    if (!r.ok || r.score !== p.score) {
      drift++;
      console.log(`  ✗ ${tier.name} 复解不一致`, r.ok, r.score, p.score);
    }
  }
  console.log(`  复解一致：${TIERS.length - drift}/${TIERS.length} 档`);
}

// Sanity for the cutter itself: the partition it drew must satisfy the rules of the game as
// checked by verify(), which reads none of the generator's internals.
{
  let total = 0;
  let broken = 0;
  for (let s = 0; s < 60; s++) {
    const p = makePuzzle(`cutter|${s}`, 'apprentice');
    if (!p) continue;
    total++;
    const owner = solutionOf(p.board, p.partition);
    const wrong = verify(p.board, owner).filter((x) => x.why !== '空格');
    if (wrong.length) {
      broken++;
      if (broken <= 3) console.log('  ✗ 切块器产出不合法:', wrong.slice(0, 2).map((x) => x.why).join('; '));
    }
  }
  console.log(`  切块器产出的划分合法：${total - broken}/${total}`);
}

console.log(`\n最慢档位 ${worst.toFixed(0)} ms/局`);
process.exit(mono && bad === 0 ? 0 : 1);
