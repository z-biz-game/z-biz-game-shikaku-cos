// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM, the geometry and the canvas pixels, not a
// flag. A `.hidden` boolean says what the code intended; a client rect and a pixel say what the
// player got. The interesting failures in this game are exactly the ones where the state is
// right and the picture or the click is wrong — a region painted in the engine but invisible on
// screen, or a border drawn one cell away from where the pointer lands.
//
// window.shikaku.engine is the shipped module graph, so a scenario that passes here has passed
// on the same solver the player's hints come from — not a second copy kept for testing. Engine
// constants are read *inside* each scenario: this file is installed before the app's module has
// run, so window.shikaku does not exist yet at load time.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  // Equality is spelled separately from truthiness on purpose: `ck('count', 0)` reads as a
  // pass to a boolean test and as a failure to a human, so every "this must equal that" here
  // goes through eq, and every "this must hold" through ck.
  const eq = (test, got, want) => ck(test, String(got) === String(want), `${got} vs ${want}`);
  const over = (base, top, alpha) => base.map((c, i) => Math.round(c * (1 - alpha) + top[i] * alpha));
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would hand
    // back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.shikaku;
  const E = () => w.shikaku.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- real gestures --------------------------------------------------------

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }

  const at = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2, size: r.size };
  };

  // A drag from cell to cell, through the canvas: hitTest, the DPR transform, the preview and
  // the acceptance test all have to agree for this to land where the player meant it to.
  async function drag(from, to) {
    const a = at(from);
    const b = at(to);
    pointer('pointerdown', a.x, a.y);
    pointer('pointermove', (a.x + b.x) / 2, (a.y + b.y) / 2);
    pointer('pointermove', b.x, b.y);
    pointer('pointerup', b.x, b.y);
    return wait(24);
  }

  async function tap(t) {
    const p = at(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    return wait(24);
  }

  // ---- pixel reads ----------------------------------------------------------

  const hex = (h) => {
    const m = String(h).replace('#', '');
    if (m.length < 6) return [-1, -1, -1];
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  };
  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [-1, -1, -1];
  };
  const near = (p, c, tol = 8) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) <= tol);

  function pixel(x, y) {
    const v = A().view;
    const d = v.geo.dpr;
    const p = v.ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  const cellPixel = (t) => {
    const r = A().view.cellRect(t);
    return pixel(r.x + r.size / 2, r.y + r.size / 2);
  };
  // Sampled exactly on the shared edge, which is where both a region border and a cut note go.
  const edgePixel = (a, z) => {
    const va = A().view.cellRect(a);
    const vz = A().view.cellRect(z);
    const vertical = va.x !== vz.x;
    return pixel(vertical ? va.x + va.size : va.x + va.size / 2, vertical ? va.y + va.size / 2 : va.y + va.size);
  };

  const owners = () => Array.from(A().game.st.owner);
  const ownedCount = () => owners().filter((v) => v !== E().OPEN).length;
  const sum = (p) => Array.from(p.board.values).reduce((a, v) => a + v, 0);
  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  // A cell inside a rectangle that carries no digit — the digit's own disc sits over the tint.
  const plainCellIn = (board, rect) => {
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) if (board.clueOf[r * board.w + c] === E().OPEN) return r * board.w + c;
    }
    return -1;
  };

  // ---------- engine: the shipped solver, in the shipped page ----------

  const engine = async () => {
    const en = E();
    ck('页面挂出了可测的引擎', !!(en && en.createBoard && en.solve));
    eq('OPEN 是 -1', en.OPEN, -1);
    eq('规则表里有六条', Object.keys(en.Rules).length, 6);
    eq('档位有五级', en.TIERS.length, 5);
    let ordered = true;
    for (let i = 1; i < en.TIERS.length; i++) {
      if (!(en.TIERS[i].band[0] > en.TIERS[i - 1].band[0])) ordered = false;
      if (!(en.TIERS[i].w > en.TIERS[i - 1].w)) ordered = false;
    }
    ck('档位按难度与尺寸同时递增', ordered, JSON.stringify(en.TIERS.map((t) => [t.w, t.band])));
    eq('档位不认识时退回上手', en.tierFor('nope').key, 'apprentice');

    const p = en.makePuzzle('scen|engine', 'apprentice');
    ck('出一局', !!p);
    const b = p.board;
    eq('盘面尺寸就是档位', `${b.w}×${b.h}`, '8×8');
    eq('线索总和等于格数', sum(p), b.n);
    ck('线索不超过位掩码上限', b.clues <= 30, b.clues);
    eq('每个数字都在盘上', b.clueCell.length, b.clues);
    ck('开局没有任何归属', Array.from(en.createState(b).owner).every((v) => v === en.OPEN));
    const s = en.solve(b);
    eq('铅笔求解推到底', s.ok, true);
    eq('这一局不需要反证', s.nishio, 0);
    eq('推到底的盘合法', en.verify(b, s.state.owner).length, 0);
    eq('推到底即完整', en.complete(b, s.state.owner), true);
    const c = en.countSolutions(b, { cap: 2, budget: 120000 });
    eq('穷举计数判定唯一', c.status, 'UNIQUE');
    eq('穷举解数为 1', c.solutions, 1);
    // Two independent implementations must agree cell by cell, not merely both say "one".
    const fromCounter = new Int16Array(b.n).fill(en.OPEN);
    for (const [clue, r0, c0, r1, c1] of c.placement) {
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) fromCounter[r * b.w + cc] = clue;
    }
    ck('铅笔与穷举逐格同解', Array.from(fromCounter).join(',') === Array.from(s.state.owner).join(','), `${Array.from(fromCounter).slice(0, 8)} vs ${Array.from(s.state.owner).slice(0, 8)}`);
    eq('切块器给的划分也通过独立校验', en.verify(b, en.solutionOf(b, p.partition)).length, 0);
    eq('切块器的划分与铅笔同解', Array.from(en.solutionOf(b, p.partition)).join(','), Array.from(s.state.owner).join(','));
    const st = en.createState(b);
    const d0 = en.nextDeduction(st);
    ck('新盘上没有任何归属', Array.from(st.owner).every((v) => v === en.OPEN));
    ck('开局给得出提示', !!d0);
    ck('提示的规则在规则表里', Object.values(en.Rules).includes(d0.rule), d0 && d0.rule.name);
    ck('提示文字带坐标', /第[\d~]+[行列]/.test(d0.rule.text(b, d0)), d0.rule.text(b, d0));
    ck('提示不改盘面', Array.from(st.owner).every((v) => v === en.OPEN), Array.from(st.owner).join(','));
    ck('总和不对的盘直接拒绝', (() => {
      try {
        en.createBoard({ w: 3, h: 3, values: Int16Array.from([2, 0, 0, 0, 0, 0, 0, 0, 0]) });
        return false;
      } catch (e) {
        return /不可能有解/.test(e.message);
      }
    })());
    ck('放不下的数字直接拒绝', (() => {
      try {
        en.createBoard({ w: 2, h: 3, values: Int16Array.from([5, 0, 0, 0, 0, 1]) });
        return false;
      } catch (e) {
        return /没有任何可放的矩形/.test(e.message);
      }
    })());
    const q = en.makePuzzle('scen|same', 'trainee');
    ck('同种子同盘', Array.from(en.makePuzzle('scen|same', 'trainee').board.values).join(',') === Array.from(q.board.values).join(','));
    ck('不同种子不同盘', Array.from(en.makePuzzle('scen|other', 'trainee').board.values).join(',') !== Array.from(q.board.values).join(','));
    eq('出货记下原始种子', q.originSeed, 'scen|same');
    eq('派生种子带 trials 编号', q.seed, 'scen|same#0');
    const rd = en.boxReadout(b, { r0: 0, c0: 0, r1: 1, c1: 1 });
    eq('方块读数算得出面积', rd.area, 4);
    ck('方块读数说人话', /格/.test(rd.text), rd.text);
    return report({ score: p.score, clues: b.clues });
  };

  // ---------- gen: the ladder is measured, not asserted ----------

  const gen = async () => {
    const en = E();
    const medians = [];
    for (const tier of en.TIERS) {
      const scores = [];
      let inBand = 0;
      let unique = 0;
      let nishio = 0;
      let bad = 0;
      let ms = 0;
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = en.makePuzzle(`gen|${tier.key}|${s}`, tier.key);
        ms += performance.now() - t0;
        if (!p) continue;
        scores.push(p.score);
        if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
        if (p.nishio > 0) nishio++;
        if (en.verify(p.board, en.solutionOf(p.board, p.partition)).length) bad++;
        if (en.countSolutions(p.board, { cap: 2, budget: 120000 }).status === 'UNIQUE') unique++;
      }
      const m = median(scores);
      eq(`${tier.key} 出题 4/4`, scores.length, 4);
      ck(`${tier.key} 命中难度区间`, inBand >= 3, `${inBand}/4 落在 ${tier.band}`);
      eq(`${tier.key} 每局唯一解`, unique, scores.length);
      eq(`${tier.key} 出货不需要反证`, nishio, 0);
      eq(`${tier.key} 划分本身合法`, bad, 0);
      ck(`${tier.key} 出题够快`, ms / 4 < 500, `${(ms / 4).toFixed(0)} ms/局`);
      medians.push({ key: tier.key, m, size: `${tier.w}×${tier.h}` });
    }
    let mono = true;
    for (let i = 1; i < medians.length; i++) if (!(medians[i].m > medians[i - 1].m)) mono = false;
    ck('档位中位分数单调递增', mono, medians.map((o) => `${o.key}:${o.m}`).join(' '));
    eq('每档盘面都比上一档大', new Set(medians.map((o) => o.size)).size, 5);
    const noband = en.generate({ w: 8, h: 8, seed: 'gen|noband', tries: 10 });
    ck('不给区间也能出货', noband.ok && noband.drawn > 0, JSON.stringify(noband.stats));
    return report({ medians: medians.map((o) => o.m) });
  };

  // ---------- play: the menu, the buttons, the readouts ----------

  const play = async () => {
    const en = E();
    A().show('menu');
    await wait(40);
    ck('选档页可见', shown('#view-menu'));
    ck('棋局页藏起', !shown('#view-game'));
    eq('标题是数间', text('#app h1'), '数间');
    ck('副标题点出玩法', /Shikaku/.test(text('.brand .sub')), text('.brand .sub'));
    const tiers = [...document.querySelectorAll('#tier-list .tier')];
    eq('档位按钮五个', tiers.length, 5);
    ck('档位按钮写着尺寸', tiers.every((x) => /×/.test(x.textContent)));
    ck('档位按钮写着实测分', tiers.every((x) => /实测/.test(x.textContent)));
    eq('玩法说明写了六条规则', document.querySelectorAll('.rules li').length, 6);
    eq('纪录表按档位排', document.querySelectorAll('#record-list li').length, 5);
    ck('页脚提到验证脚本', /tools\/verify\.sh/.test(text('footer')));

    tiers[0].click();
    await wait(80);
    ck('点档位进入棋局', shown('#view-game'));
    ck('选档页让位', !shown('#view-menu'));
    const g = A().game;
    eq('进入的是初学档', g.puzzle.tier, 'trainee');
    ck('棋头写了档位名', text('#stat-name').includes('初学'), text('#stat-name'));
    ck('棋头写了尺寸', text('#stat-name').includes('6×6'), text('#stat-name'));
    eq('计时从 00:00 起', text('#stat-time'), '00:00');
    eq('步数为 0', text('#stat-moves'), '0');
    eq('提示为 0', text('#stat-hints'), '0');
    eq('已围格读数 0/36', text('#stat-owned'), '0/36');
    eq('待围格 36', text('#stat-remaining'), '36');
    ck('围好的块从 0 起', text('#stat-regions').startsWith('0/'), text('#stat-regions'));
    eq('矛盾 0', text('#stat-problems'), '0');
    eq('难度实测显示分数', text('#stat-score'), g.puzzle.score.toFixed(1));
    ck('胜利遮罩藏起', !shown('#win-veil'));
    ck('提示语先讲怎么用', /按/.test(text('#hint-line')), text('#hint-line'));
    eq('开局棋盘行是空的', text('#box-line'), '');

    const geo = A().view.geo;
    const rect = A().view.canvas.getBoundingClientRect();
    ck('画布按棋盘铺开', Math.abs(rect.width - (geo.cell * g.w + geo.x * 2)) <= 1, `${rect.width} vs ${geo.cell * g.w}`);
    ck('格子边长是整数', Number.isInteger(geo.cell), geo.cell);
    ck('画不出视口', rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ r: rect.right, b: rect.bottom, w: window.innerWidth, h: window.innerHeight }));
    eq('默认围块模式', $('#board').dataset.mode, 'box');
    eq('围块按钮按下态', $('#btn-mode-box').getAttribute('aria-pressed'), 'true');
    eq('画线按钮未按下', $('#btn-mode-cut').getAttribute('aria-pressed'), 'false');
    ck('围块模式有无障碍说明', /拖动/.test($('#board').getAttribute('aria-label')));

    $('#btn-mode-cut').click();
    await wait(30);
    eq('切模式写进 data-mode', $('#board').dataset.mode, 'cut');
    ck('切模式改无障碍说明', /线/.test($('#board').getAttribute('aria-label')));
    eq('画线按钮亮起', $('#btn-mode-cut').getAttribute('aria-pressed'), 'true');
    eq('围块按钮熄灭', $('#btn-mode-box').getAttribute('aria-pressed'), 'false');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    await wait(30);
    eq('M 键切回围块', $('#board').dataset.mode, 'box');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    await wait(60);
    eq('H 键给一次提示', text('#stat-hints'), '1');
    ck('提示理由写出规则名', /规则：/.test(text('#hint-rule')), text('#hint-rule'));
    ck('提示不是空话', text('#hint-line').length > 6, text('#hint-line'));
    eq('提示按钮角标同步', text('#hint-count'), '1');
    ck('提示真的围下了格子', ownedCount() > 0, ownedCount());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    await wait(60);
    eq('Z 键退掉提示写的格子', ownedCount(), 0);
    eq('撤销不退提示次数', text('#stat-hints'), '1');
    eq('撤销不退待围格', text('#stat-remaining'), '36');

    const wasOn = $('#btn-sound').getAttribute('aria-pressed') === 'true';
    $('#btn-sound').click();
    await wait(30);
    eq('音效按钮改文案', text('#btn-sound'), wasOn ? '音效 关' : '音效 开');
    ck('音效选择进存档', JSON.parse(localStorage.getItem('shikaku.save.v1')).settings.sound === !wasOn);
    $('#btn-sound').click();
    $('#btn-motion').click();
    await wait(30);
    eq('动效按钮改文案', text('#btn-motion'), '动效 省');
    ck('减少动效写进 body', document.body.classList.contains('reduce-motion'));
    $('#btn-motion').click();
    $('#btn-notes').click();
    await wait(30);
    eq('笔记按钮改文案', text('#btn-notes'), '笔记 藏');
    $('#btn-notes').click();

    $('#btn-new').click();
    await wait(80);
    eq('换一局留在同档', A().game.puzzle.tier, 'trainee');
    eq('换一局清零步数', text('#stat-moves'), '0');
    eq('换一局清零提示', text('#stat-hints'), '0');
    ck('换一局关掉遮罩', !shown('#win-veil'));
    $('#btn-menu').click();
    await wait(40);
    ck('回选档显示菜单', shown('#view-menu'));
    ck('回选档留下可继续的一局', shown('#resume-card'));
    ck('继续卡写了花费', /步 · 提示/.test(text('#resume-meta')), text('#resume-meta'));
    $('#btn-resume').click();
    await wait(60);
    ck('继续回到棋局', shown('#view-game'));
    return report({});
  };

  // ---------- hint: every hint must be a step the board actually supports ----------

  const hint = async () => {
    const en = E();
    A().begin({ tier: 'regular', seed: 'scen|hint' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    eq('提示局开局干净', ownedCount(), 0);
    const names = new Set(Object.values(en.Rules).map((r) => r.name));
    const seen = new Set();
    let charged = 0;
    let painted = 0;
    let badRule = 0;
    let outOfBoard = 0;
    let empty = 0;
    for (let k = 0; k < 300 && g.status !== 'won'; k++) {
      const before = Array.from(g.st.owner);
      const info = A().useHint();
      if (!info) break;
      if (info.stalled) {
        ck('推完之前不喊停', false, info.text);
        break;
      }
      charged++;
      seen.add(info.rule);
      if (!names.has(info.rule)) badRule++;
      if (!/规则：/.test(text('#hint-rule'))) badRule++;
      const now = Array.from(g.st.owner);
      const wrote = now.map((v, t) => (v !== en.OPEN && v !== before[t] ? t : -1)).filter((t) => t >= 0);
      painted += wrote.length;
      if (info.kind !== 'cut' && !wrote.length) empty++;
      // the hint named a clue for these cells — the ink has to agree with it
      if (wrote.some((t) => now[t] !== info.clue)) outOfBoard++;
      for (const t of info.cells || []) if (!(t >= 0 && t < b.n)) outOfBoard++;
      // a region the readout calls finished must really hold its own clue's area
      if (g.diag.regions.some((r) => r.done && (r.cells !== r.want || g.diag.shapeBad.has(r.clue)))) outOfBoard++;
    }
    eq('一路提示能走完这局', g.status, 'won');
    eq('提示次数等于充电次数', g.hints, charged);
    eq('每次提示都写了格子', empty, 0);
    ck('提示围下的格不少于全盘', painted >= b.n, `${painted} vs ${b.n}`);
    eq('提示不越界、不写坏块', outOfBoard, 0);
    eq('提示说的规则都在规则表里', badRule, 0);
    ck('用到的规则不止一种', seen.size >= 3, [...seen].join(','));
    eq('反证不在出货提示里', seen.has('反证'), false);
    eq('终局盘面通过独立校验', en.verify(b, g.st.owner).length, 0);
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带花费', /步 · 提示/.test(text('#win-meta')), text('#win-meta'));
    ck('胜利后再按提示不充电', (() => {
      const h = g.hints;
      A().useHint();
      return g.hints === h;
    })());
    eq('胜利后续局被清掉', en.Store.resume(), null);
    return report({ hints: charged, rules: [...seen] });
  };

  // ---------- box: the rectangle drag, and everything it must refuse ----------

  const box = async () => {
    const en = E();
    A().begin({ tier: 'apprentice', seed: 'scen|box' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    const part = g.puzzle.partition[0];
    const partClue = en.boxOf(b, part.r0, part.c0, part.r1, part.c1).clues[0];
    await drag(part.r0 * b.w + part.c0, part.r1 * b.w + part.c1);
    ck('拖出的合法方块被接受', ownedCount() > 0, ownedCount());
    const painted = Array.from(g.st.owner).filter((v) => v !== en.OPEN).length;
    eq('围下的格数等于面积', painted, (part.r1 - part.r0 + 1) * (part.c1 - part.c0 + 1));
    eq('围块计一步', text('#stat-moves'), '1');
    eq('已围格跟着涨', text('#stat-owned').split('/')[0], String(painted));
    eq('围好的块 +1', text('#stat-regions').split('/')[0], '1');
    eq('围块之后不报矛盾', text('#stat-problems'), '0');
    ck('围块之后待围格变少', Number(text('#stat-remaining')) === b.n - painted, text('#stat-remaining'));

    // three refusals, all through the same pointer path
    const twoClues = (() => {
      for (let r0 = 0; r0 < b.h; r0++) for (let c0 = 0; c0 < b.w; c0++) for (let r1 = r0; r1 < b.h; r1++) for (let c1 = c0; c1 < b.w; c1++) {
        const bx = en.boxOf(b, r0, c0, r1, c1);
        if (bx.clues.length > 1 && bx.cells.every((t) => g.st.owner[t] === en.OPEN)) return { r0, c0, r1, c1, n: bx.clues.length };
      }
      return null;
    })();
    if (twoClues) {
      const moves = text('#stat-moves');
      await drag(twoClues.r0 * b.w + twoClues.c0, twoClues.r1 * b.w + twoClues.c1);
      ck('圈住两个数字被拒', new RegExp(`圈住了 ${twoClues.n} 个数字`).test(A().boxLine()), A().boxLine());
      eq('被拒不进步数', text('#stat-moves'), moves);
      eq('被拒不写归属', ownedCount(), painted);
    } else ck('盘面留有跨两个数字的空框', false);

    const noClue = (() => {
      for (let t = 0; t < b.n; t++) if (b.clueOf[t] === en.OPEN && g.st.owner[t] === en.OPEN && t % b.w === b.w - 1) return t;
      return -1;
    })();
    if (noClue >= 0) {
      await tap(noClue);
      ck('单点空格不落子只教操作', /拖动/.test(A().boxLine()), A().boxLine());
      eq('单点空格不写归属', g.st.owner[noClue], en.OPEN);
    } else ck('盘面留有空白边缘格', false);

    const wrongArea = (() => {
      const clue = (() => {
        for (let i = 0; i < b.clues; i++) if (b.clueCell[i] !== part.r0 * b.w + part.c0) return i;
        return 0;
      })();
      const cr = Math.floor(b.clueCell[clue] / b.w);
      const cc = b.clueCell[clue] % b.w;
      for (let rows = 1; rows <= b.h; rows++) for (let cols = 1; cols <= b.w; cols++) {
        const area = rows * cols;
        if (area === b.values[clue] || area < 2) continue;
        const r1 = cr + rows - 1;
        const c1 = cc + cols - 1;
        if (r1 >= b.h || c1 >= b.w || (r1 === cr && c1 === cc)) continue;
        const bx = en.boxOf(b, cr, cc, r1, c1);
        if (bx.clues.length === 1 && bx.cells.every((t) => g.st.owner[t] === en.OPEN)) return { r0: cr, c0: cc, r1, c1, area, want: b.values[clue] };
      }
      return null;
    })();
    if (wrongArea) {
      await drag(wrongArea.r0 * b.w + wrongArea.c0, wrongArea.r1 * b.w + wrongArea.c1);
      ck('面积与数字不符被拒', new RegExp(`面积 ${wrongArea.area}，但这里的数字是 ${wrongArea.want}`).test(A().boxLine()), `${A().boxLine()} / ${JSON.stringify(wrongArea)}`);
    } else ck('盘面留有面积不符的空框', false);

    const moves2 = Number(text('#stat-moves'));
    await drag(part.r0 * b.w + part.c0, part.r1 * b.w + part.c1);
    eq('重复围同一块不进步数', Number(text('#stat-moves')), moves2);
    ck('重复围同一块会说明', /已经围好/.test(A().boxLine()), A().boxLine());

    const corner = part.r0 * b.w + part.c0;
    await tap(corner);
    eq('点已围的格擦掉', g.st.owner[corner], en.OPEN);
    eq('擦掉算一步', Number(text('#stat-moves')), moves2 + 1);
    ck('擦掉后待围格变多', Number(text('#stat-remaining')) > b.n - painted, text('#stat-remaining'));
    A().undo();
    await wait(30);
    eq('撤销把格子还回来', g.st.owner[corner], partClue);
    eq('撤销也退步数', Number(text('#stat-moves')), moves2);

    const other = g.puzzle.partition.find((x) => !(x.r0 === part.r0 && x.c0 === part.c0 && x.r1 === part.r1 && x.c1 === part.c1));
    await drag(other.r0 * b.w + other.c0, other.r1 * b.w + other.c1);
    ck('再围一块真的写了格子', ownedCount() >= painted, `${ownedCount()} vs ${painted}`);
    A().undo();
    await wait(30);
    eq('一次撤销退掉整块', ownedCount(), painted);

    const c = A().view.canvas.getBoundingClientRect();
    const moves3 = Number(text('#stat-moves'));
    pointer('pointerdown', c.left - 4, c.top + 4);
    pointer('pointerup', c.left - 4, c.top + 4);
    await wait(30);
    eq('画布外的按下不落子', Number(text('#stat-moves')), moves3);

    A().begin({ tier: 'trainee', seed: 'scen|box-win' });
    await wait(60);
    const g2 = A().game;
    for (const r of g2.puzzle.partition) A().drawBox(r.r0, r.c0, r.r1, r.c1);
    eq('逐块围满即胜利', g2.status, 'won');
    eq('围满的盘通过独立校验', en.verify(g2.board, g2.st.owner).length, 0);
    eq('围满不需要任何提示', g2.hints, 0);
    ck('胜利文案写 0 次提示', /提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('围满会写下纪录', !!en.Store.best('trainee'), JSON.stringify(en.Store.best('trainee')));
    eq('围满的步数等于区域数', g2.moves, g2.board.clues);
    return report({ partClue });
  };

  // ---------- cut: a note the player can draw, and that can never hurt them ----------

  const cut = async () => {
    const en = E();
    A().begin({ tier: 'regular', seed: 'scen|cut' });
    await wait(60);
    A().setMode('cut');
    await wait(30);
    const g = A().game;
    const b = g.board;
    const cv = A().view.canvas.getBoundingClientRect();

    const mid = at(0);
    eq('格子正中不算分域线', A().view.hitCut(mid.x, mid.y), -1);
    const r0 = A().view.cellRect(0);
    const edgeX = cv.left + r0.x + r0.size;
    const edgeY = cv.top + r0.y + r0.size / 2;
    const pair = A().view.hitCut(edgeX, edgeY);
    ck('边线正中认得出分域位置', pair >= 0, pair);
    eq('认出的正是 0|1 这条边', pair, b.pairOf(0, 1));
    const baseline = edgePixel(0, 1);
    const moves = Number(text('#stat-moves'));
    const ink = owners().join(',');
    pointer('pointerdown', edgeX, edgeY);
    await wait(30);
    eq('点边线记一条笔记', g.st.cuts[pair], 1);
    eq('笔记算一步', Number(text('#stat-moves')), moves + 1);
    eq('笔记不改任何归属', owners().join(','), ink);
    ck('笔记会写进存档', en.Store.resume().ink.length > 0);
    const withNote = edgePixel(0, 1);
    ck('笔记真的画在边上', !near(withNote, baseline), `${withNote} vs ${baseline}`);
    $('#btn-notes').click();
    await wait(40);
    ck('藏笔记后边线回到无笔记的样子', near(edgePixel(0, 1), baseline), `${edgePixel(0, 1)} vs ${baseline}`);
    $('#btn-notes').click();
    await wait(40);
    ck('再显笔记又画回来', near(edgePixel(0, 1), withNote), `${edgePixel(0, 1)} vs ${withNote}`);
    pointer('pointerdown', edgeX, edgeY);
    await wait(30);
    eq('再点一次擦掉笔记', g.st.cuts[pair], 0);
    ck('擦掉后回到基线', near(edgePixel(0, 1), baseline), `${edgePixel(0, 1)} vs ${baseline}`);

    // a note inside a drawn region must be reported and never obeyed
    A().setMode('box');
    const rect = g.puzzle.partition[0];
    A().drawBox(rect.r0, rect.c0, rect.r1, rect.c1);
    await wait(40);
    const inkAfter = owners().join(',');
    ck('先围好一块', ownedCount() > 0);
    const inner = rect.r0 * b.w + rect.c0;
    const innerPair = b.pairOf(inner, inner + 1);
    const ri = A().view.cellRect(inner);
    const rz = A().view.cellRect(inner + 1);
    A().setMode('cut');
    pointer('pointerdown', cv.left + rz.x, cv.top + ri.y + ri.size / 2);
    await wait(40);
    ck('画在已围区域内的笔记被记为可疑', g.diag.dubiousCuts >= 1, `${g.diag.dubiousCuts} @${innerPair}`);
    ck('可疑笔记会被说出来', /笔记/.test(A().boxLine()), A().boxLine());
    eq('可疑笔记不会让盘围不下', g.diag.stuck, false);
    eq('可疑笔记不改归属表', owners().join(','), inkAfter);
    eq('可疑笔记不改归属数量', ownedCount(), inkAfter.split(',').filter((v) => v != en.OPEN).length);
    A().cut(b.pairOf(0, b.w));
    eq('程序化画线也走得通', g.st.cuts[b.pairOf(0, b.w)], 1);
    A().undo();
    await wait(30);
    eq('撤销退掉最后一条线', g.st.cuts[b.pairOf(0, b.w)], 0);
    const settings = JSON.parse(localStorage.getItem('shikaku.save.v1')).settings;
    ck('笔记开关进存档', 'showNotes' in settings, JSON.stringify(settings));
    ck('存档里没有上一作的字段', !('showLight' in settings));
    return report({});
  };

  // ---------- save: what a resume has to carry ----------

  const save = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'regular', seed: 'scen|save' });
    await wait(60);
    const g = A().game;
    const b = g.board;
    for (const r of g.puzzle.partition.slice(0, 3)) A().drawBox(r.r0, r.c0, r.r1, r.c1);
    A().useHint();
    await wait(30);
    const raw = JSON.parse(localStorage.getItem('shikaku.save.v1'));
    ck('存档键名是本作的', !!raw && !!raw.resume, Object.keys(raw || {}).join(','));
    eq('存档写原始种子', raw.resume.seed, g.puzzle.originSeed);
    eq('存档写档位', raw.resume.tier, 'regular');
    eq('存档写格数', raw.resume.cells, b.n);
    eq('存档写步数', raw.resume.moves, g.moves);
    eq('存档写提示数', raw.resume.hints, g.hints);
    ck('存档写用时', raw.resume.elapsedMs > 0, raw.resume.elapsedMs);
    ck('存档不过几千字节', JSON.stringify(raw.resume).length < 4000, JSON.stringify(raw.resume).length);
    const back = en.Store.resume();
    eq('归属一格不差地回来', Array.from(back.board).join(','), Array.from(g.st.owner).join(','));
    ck('空格在存档里还是空格', back.board.some((v) => v === en.OPEN) && back.board.every((v) => v === en.OPEN || v >= 0), Array.from(back.board).slice(0, 10).join(','));
    ck('游程编码比一格一数省', back.ink.length < b.n * 2, `${back.ink.length} vs ${b.n * 2}`);
    eq('设置默认音效开', en.Store.setting('sound'), true);
    eq('设置默认笔记显', en.Store.setting('showNotes'), true);
    const solvedBefore = en.Store.data.totals.solved;
    en.Store.recordSolve(1000, 2);
    eq('总局数按局累加', en.Store.data.totals.solved, solvedBefore + 1);
    ck('累计提示累加', en.Store.data.totals.hints >= 2, en.Store.data.totals.hints);
    // Records rank by help taken first — a fast run built on hints is not a record.
    en.Store.data.best = {};
    eq('首个纪录直接成立', en.Store.recordBest('regular', { ms: 50000, hints: 1, moves: 20, size: '10×10' }), true);
    eq('更快但更靠提示的不算破纪录', en.Store.recordBest('regular', { ms: 1000, hints: 2, moves: 5, size: '10×10' }), false);
    eq('同求助次数下省步算破纪录', en.Store.recordBest('regular', { ms: 60000, hints: 1, moves: 12, size: '10×10' }), true);
    eq('步数也相同时才比时间', en.Store.recordBest('regular', { ms: 90000, hints: 1, moves: 12, size: '10×10' }), false);
    eq('纪录留的是最好的那次', en.Store.best('regular').moves, 12);
    en.Store.data.best = {};
    // A leftover save from another repo's key must not be read.
    localStorage.setItem('akari.save.v1', JSON.stringify({ settings: { showLight: false }, resume: { seed: 'x' } }));
    eq('不读上一作的存档键', en.Store.setting('showNotes'), true);
    localStorage.removeItem('akari.save.v1');
    return report({});
  };

  // ---------- resume: leave and come back to the same board ----------

  const resume = async () => {
    const en = E();
    en.Store.reset();
    A().begin({ tier: 'expert', seed: 'scen|resume' });
    await wait(60);
    const g = A().game;
    const valuesBefore = Array.from(g.board.values).join(',');
    for (const r of g.puzzle.partition.slice(0, 4)) A().drawBox(r.r0, r.c0, r.r1, r.c1);
    A().useHint();
    A().useHint();
    A().cut(g.board.pairOf(0, 1));
    await wait(30);
    const saved = { owner: owners().join(','), moves: g.moves, hints: g.hints, cuts: Array.from(g.st.cuts).join(',') };
    A().show('menu');
    await wait(40);
    ck('回选档留下继续卡', shown('#resume-card'));
    ck('继续卡写着档位', /高阶/.test(text('#resume-name')), text('#resume-name'));
    const r = en.Store.resume();
    eq('续局带回了切线笔记', Array.from(r.board).join(','), saved.owner);
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g2 = A().game;
    eq('续局重绘出同一块盘', Array.from(g2.board.values).join(','), valuesBefore);
    eq('续局还原全部归属', owners().join(','), saved.owner);
    eq('续局还原步数', g2.moves, saved.moves);
    eq('续局还原提示数', g2.hints, saved.hints);
    eq('面板显示还原后的提示', text('#stat-hints'), String(saved.hints));
    eq('面板显示还原后的步数', text('#stat-moves'), String(saved.moves));
    ck('续局接着计时', A().elapsed() >= r.elapsedMs, `${A().elapsed()} vs ${r.elapsedMs}`);
    eq('面板已围格与引擎一致', text('#stat-owned').split('/')[0], String(g2.diag.owned));
    eq('续局不能撤销到重开之前', A().undo(), null);
    eq('续局之后归属还在', owners().join(','), saved.owner);
    eq('提示计数不被撤销退掉', g2.hints, saved.hints);
    const hintsAtResume = g2.hints;
    A().begin({ tier: r.tier, seed: r.seed, resume: r });
    await wait(60);
    const g3 = A().game;
    // through the app's own wrapper, so the win bookkeeping (record, totals, cleared save) runs
    // the way it does when a player finishes with hints
    const res = A().solveWithLogic();
    eq('续局可以推到胜利', g3.status, 'won', JSON.stringify(res));
    ck('推到底靠的是逻辑', res.steps > 1, res.steps);
    ck('胜利按求助最少记档', !en.Store.best('expert') || en.Store.best('expert').hints <= g3.hints, JSON.stringify(en.Store.best('expert')));
    ck('提示次数没有因续局清零', g3.hints >= hintsAtResume, `${g3.hints} vs ${hintsAtResume}`);
    eq('胜利后续局被清掉', en.Store.resume(), null);
    ck('胜利遮罩可见', shown('#win-veil'));
    $('#btn-menu-2').click();
    await wait(40);
    ck('胜利后回选档不再给继续', !shown('#resume-card'));
    ck('总局数累加了', en.Store.data.totals.solved >= 1, en.Store.data.totals.solved);
    $('#btn-reset').click();
    await wait(40);
    eq('清空存档清掉纪录', en.Store.best('expert'), null);
    ck('清空存档回到选档', shown('#view-menu'));
    eq('清空后续档也没了', en.Store.resume(), null);
    return report({});
  };

  // ---------- layout: the biggest board, drawn where the pixels are read ----------

  const layout = async () => {
    const en = E();
    A().begin({ tier: 'master', seed: 'scen|layout' });
    await wait(80);
    const g = A().game;
    const b = g.board;
    eq('大师档 14×14', `${g.w}×${g.h}`, '14×14');
    const rect = A().view.canvas.getBoundingClientRect();
    ck('最大盘也在视口里', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, JSON.stringify({ l: rect.left, r: rect.right, b: rect.bottom }));
    ck('格子不小于可点最小值', A().view.geo.cell >= 20, A().view.geo.cell);
    ck('页面没有横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    let misses = 0;
    for (let t = 0; t < b.n; t++) {
      const p = at(t);
      if (A().view.hitCell(p.x, p.y) !== t) misses++;
    }
    eq('大棋盘每一格都点得中', misses, 0);

    const drawn = g.puzzle.partition.slice(0, 4);
    for (const r of drawn) A().drawBox(r.r0, r.c0, r.r1, r.c1);
    await wait(60);
    const probe = plainCellIn(b, drawn[0]);
    ck('围下的区域有非数字格可采样', probe >= 0);
    const tintVar = cssVar('--tint-0');
    ck('区域颜色来自主题变量', /^#/.test(tintVar), tintVar);
    // An accepted box always finishes its region, so the lifted "settled" tint is what the
    // centre of that cell must read as — composed from the same two tokens the canvas uses.
    const settled = over(hex(tintVar), [242, 245, 251], en.theme.tintLift);
    ck('围好的格涂的是提亮后的区域色', near(cellPixel(probe), settled), `${cellPixel(probe)} vs ${settled} (lift ${en.theme.tintLift})`);
    const unowned = (() => {
      for (let t = 0; t < b.n; t++) if (g.st.owner[t] === en.OPEN && b.clueOf[t] === en.OPEN) return t;
      return -1;
    })();
    ck('还有没围的格可采样', unowned >= 0);
    const paper = cssVar('--bg-bottom');
    ck('没围的格还是纸色', near(cellPixel(unowned), hex(paper)), `${cellPixel(unowned)} vs ${paper}`);
    const borderPair = (() => {
      for (let t = 0; t < b.n; t++) {
        if (t % b.w + 1 >= b.w) continue;
        const a = g.st.owner[t];
        const z = g.st.owner[t + 1];
        if (a !== en.OPEN && z !== en.OPEN && a !== z) return [t, t + 1];
      }
      return null;
    })();
    if (borderPair) {
      const edge = edgePixel(borderPair[0], borderPair[1]);
      const fill = cellPixel(borderPair[0]);
      ck('两块之间画出亮边界', edge[0] > fill[0] + 25 && edge[1] > fill[1] + 20, JSON.stringify({ edge, fill }));
    } else ck('相邻两块可采样', false, '前四块没有左右相邻的');
    const cr = A().view.cellRect(b.clueCell[0]);
    const dpr = A().view.geo.dpr;
    const glyph = A().view.ctx.getImageData(Math.round((cr.x + cr.size * 0.32) * dpr), Math.round((cr.y + cr.size * 0.34) * dpr), Math.round(cr.size * 0.36 * dpr), Math.round(cr.size * 0.32 * dpr)).data;
    let bright = 0;
    for (let k = 0; k < glyph.length; k += 4) if (glyph[k] + glyph[k + 1] + glyph[k + 2] > 380) bright++;
    ck('数字真的被画出来', bright >= 4, `亮像素 ${bright} @${b.values[0]}`);
    const sw = getComputedStyle($('.sw-region')).backgroundColor;
    ck('图例色块与画布同一个颜色', near(rgb(sw), hex(tintVar)), `${sw} vs ${tintVar}`);
    ck('图例的提亮色块就是提亮后的样本', near(rgb(getComputedStyle($('.sw-done')).backgroundColor), settled), `${getComputedStyle($('.sw-done')).backgroundColor} vs ${settled}`);
    eq('图例五项', document.querySelectorAll('.legend span').length, 5);
    ck('图例说明分域笔记', [...document.querySelectorAll('.legend span')].some((x) => /分域笔记/.test(x.textContent)));
    ck('操作提示行讲清三种手势', /拖动/.test(text('.keyhint')) && /画线/.test(text('.keyhint')), text('.keyhint'));
    eq('统计项七条', document.querySelectorAll('.stats .stat').length, 7);
    ck('按钮都够点', [...document.querySelectorAll('.acts button, .modes button, .top-actions button')].every((x) => x.getBoundingClientRect().height >= 28));
    ck('按钮不重叠', (() => {
      const bs = [...document.querySelectorAll('.top-actions button')].map((x) => x.getBoundingClientRect());
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) return false;
      return true;
    })());
    ck('提示框有宽度且不溢出', (() => {
      const e = $('.hint-box');
      return e.scrollWidth <= e.clientWidth + 1;
    })());
    A().useHint();
    await wait(40);
    ck('提示理由能换行显示', $('.hint-box p').getBoundingClientRect().height > 12);
    A().begin({ tier: 'trainee', seed: 'scen|layout-win' });
    await wait(40);
    for (const r of A().game.puzzle.partition) A().drawBox(r.r0, r.c0, r.r1, r.c1);
    await wait(60);
    ck('胜利卡居中在棋盘内', (() => {
      const card = $('.win-card').getBoundingClientRect();
      const wrap = $('#board-wrap').getBoundingClientRect();
      return card.left >= wrap.left - 1 && card.right <= wrap.right + 1 && card.top >= wrap.top - 1 && card.bottom <= wrap.bottom + 1;
    })(), JSON.stringify({ c: $('.win-card').getBoundingClientRect(), w: $('#board-wrap').getBoundingClientRect() }));
    ck('胜利卡不挡成打不开的界面', $('#btn-again').getBoundingClientRect().width > 40);
    return report({ cell: A().view.geo.cell, dpr: A().view.geo.dpr });
  };

  w.__ng = { engine, gen, play, hint, box, cut, save, resume, layout };
})(window);
