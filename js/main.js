// Wiring: DOM, pointer gestures, the clock, storage, and the `window.shikaku` surface the
// verification harness drives. No rule about the board lives here — every judgement comes from
// js/engine/shikaku.js through js/ui/game.js.

import { Palette, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, solutionOf } from './engine/generate.js';
import * as Engine from './engine/shikaku.js';
import { countSolutions } from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game, boxReadout, OPEN } from './ui/game.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  owned: $('#stat-owned'),
  remaining: $('#stat-remaining'),
  regions: $('#stat-regions'),
  problems: $('#stat-problems'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  boxLine: $('#box-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let drag = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function availBox() {
  const narrow = window.innerWidth <= 900;
  const w = narrow ? window.innerWidth - 60 : el.viewGame.clientWidth - 340;
  return {
    w: Math.max(240, w),
    h: Math.max(240, window.innerHeight - 250),
  };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulse,
    preview: drag && game.mode === 'box' ? drag : null,
    notes: Store.setting('showNotes') !== false,
  });
}

// One place writes the readouts, so a stat can never be updated by half the file.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = `${st.name} · ${game.w}×${game.h}`;
  el.tier.textContent = tierFor(st.tier).name;
  el.tier.dataset.tier = st.tier;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.owned.textContent = `${st.owned}/${st.total}`;
  el.remaining.textContent = st.remaining;
  el.regions.textContent = `${st.filled}/${st.regions}`;
  el.problems.textContent = st.problems + st.dubiousCuts;
  el.score.textContent = st.score.toFixed(1);
  el.problems.closest('.stat').classList.toggle('bad', st.problems > 0);
  el.remaining.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.remaining > 0);
  renderBoxLine();
}

// Two things want that one line: what the board says about itself, and what the gesture just
// said back to the player. The board wins while it is complaining; otherwise the last thing the
// player did stays on screen until the next gesture, instead of being wiped by a redraw.
let note = { text: '', good: false };
const stateLine = () => {
  if (!game) return '';
  const st = game.diag;
  if (st.stuck) return '围不下了：这些归属互相矛盾，撤销一步再想。';
  if (st.dubiousCuts) return `有 ${st.dubiousCuts} 条分域线和已围出的区域冲突，它们只是笔记，擦掉不影响盘面。`;
  return '';
};
function renderBoxLine() {
  const line = stateLine() || note.text;
  el.boxLine.textContent = line;
  el.boxLine.classList.toggle('good', !stateLine() && note.good);
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st.owner, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

function setMode(mode) {
  if (!game) return;
  game.mode = mode;
  $('#btn-mode-box').setAttribute('aria-pressed', String(mode === 'box'));
  $('#btn-mode-cut').setAttribute('aria-pressed', String(mode === 'cut'));
  el.canvas.dataset.mode = mode;
  el.canvas.setAttribute('aria-label', mode === 'box' ? '数间棋盘：拖动围出一个矩形区域' : '数间棋盘：点击两格之间的线做分域笔记');
  draw();
}

function showHint(info) {
  if (!info) return;
  if (info.stalled) {
    el.hintRule.textContent = '推不动了';
    el.hintLine.textContent = info.text;
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  el.hintLine.textContent = info.why;
  pulse = info.kind === 'kill' ? { box: rectBox(info.rid), color: Palette.warn } : { cells: info.cells };
  const mine = pulse;
  setTimeout(() => {
    if (pulse === mine) pulse = null;
    draw();
  }, 1600);
  Sound.hint();
}

const rectBox = (rid) => {
  const [r0, c0, r1, c1] = game.board.rectBox(rid);
  return { r0, c0, r1, c1 };
};

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    size: `${game.w}×${game.h}`,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(game.puzzle.tier).name} · ${game.w}×${game.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better ? '新纪录：这一局比存档里的更不求人。' : '未破纪录：同档先比提示次数。';
  el.winVeil.hidden = false;
  Sound.win();
  renderRecords();
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (soundKey) Sound[soundKey]();
    if (game.diag.stuck) Sound.conflict();
  }
}

function useHint() {
  if (!game || game.status === 'won') return null;
  const info = game.hint();
  if (!info) return null;
  if (info.stalled) {
    showHint(info);
    return info;
  }
  showHint(info);
  afterStep(null);
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  pulse = null;
  drag = null;
  el.winVeil.hidden = true;
  baseElapsed = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.load(resume.board);
  }
  setMode('box');
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一步，以及它依据哪条规则。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

// 重开：**同一道题**从头再来 —— 标记、撤销栈、步数、提示次数、计时、结算遮罩全归零，
// 但不换题。跟「换一局」的分工：换一局是重抽一道新题（那是"再来一局"），这里是
// "这题我走错了，原地重来"——玩家要的是同一个题。
//
// 为什么不能只调一次 resetMarks() 就完事：它只碰得到引擎里的标记与 history，
// UI 层的撤销栈、步数、提示次数都是各自独立存着的缓存，不挨个点名就会把半局的痕迹
// 留在新局里（详见 Game.resetAll 的注释）。
function restart() {
  if (!game) return null;
  game.resetAll();               // 标记 + steps + moves + hints + status + mode + lastHint
  pulse = null;                  // 上一条提示留下的高亮，属于上一局
  drag = null;                   // 上一次没画完的拖拽手势
  el.winVeil.hidden = true;      // 结算遮罩收起：上一局赢了的遮罩不能压在重开后的盘上
  baseElapsed = 0;               // 耗时归零
  // 暂停中重开就保持停表，否则 startClock() 会把暂停期间憋下的墙钟一次性灌进计时。
  if (paused) {
    startedAt = 0;
    clearInterval(ticker);
    ticker = 0;
  } else {
    startClock();                // 没暂停就重新起跑，重开后的计时是这一局自己的
  }
  setMode('box');                // 临时态：操作模式回默认，HUD 的 aria-pressed 一起回写
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一步，以及它依据哪条规则。';
  show('game');
  syncAll();
  // 存档覆盖成本局的空盘：刷新页面不会又冒出走错那半局的线。
  // 特意**不**碰 Store 的偏好（静音 / 减动效 / 最好成绩）——那些是玩家的东西，不是这一局的东西。
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  return which;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderResumeCard();
}

const TIER_NOTE = {
  trainee: '盘小、数字密，围满就是答案',
  apprentice: '两块不能重叠，先想谁占哪一格',
  regular: '大块只剩一种形状，锁定它',
  expert: '全线穿透和无处安放要连着用',
  master: '一格一格排除完，才敢围下最后一块',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.w}×${t.h} · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.key }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the board already on screen.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.seed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-notes').setAttribute('aria-pressed', String(!!Store.setting('showNotes')));
  $('#btn-notes').textContent = Store.setting('showNotes') ? '笔记 显' : '笔记 藏';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer gestures: 围块 drags a rectangle, 画线 taps an edge --------------------------

function boxLine(text, good) {
  note = { text: text || '', good: !!good };
  renderBoxLine();
}

function pointerDown(ev) {
  if (!game || game.status === 'won') return;
  note = { text: '', good: false };
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  if (game.mode === 'cut') {
    const pair = view.hitCut(ev.clientX, ev.clientY);
    if (pair < 0) return;
    const on = game.cut(pair);
    boxLine(on ? '记一条分域线：这两格不可能同域' : '擦掉这条笔记');
    afterStep('note');
    return;
  }
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  drag = { r0: (t / game.w) | 0, c0: t % game.w, r1: (t / game.w) | 0, c1: t % game.w, cell: t };
  showPreview();
}

function pointerMove(ev) {
  if (!drag || !game || game.mode !== 'box') return;
  const t = view.hitCell(ev.clientX, ev.clientY);
  if (t < 0) return;
  const r = (t / game.w) | 0;
  const c = t % game.w;
  if (r === drag.r1 && c === drag.c1) return;
  drag.r1 = r;
  drag.c1 = c;
  showPreview();
}

// The preview is read-only arithmetic on the board: the player sees what the box *would* mean
// before it is committed, so a wrong drag costs nothing.
function showPreview() {
  const r = boxReadout(game.board, drag);
  boxLine(`${r.text} — 松手围下这块`, r.ok);
  draw();
}

function pointerUp() {
  if (!drag || !game) return null;
  const d = drag;
  drag = null;
  const moved = d.r0 !== d.r1 || d.c0 !== d.c1;
  const step = moved ? commit(d) : tapCell(d.cell);
  syncAll();
  return step;
}

function commit(box) {
  const res = game.drawBox(box);
  if (!res.ok) {
    boxLine(res.reason);
    if (!res.step) Sound.conflict();
    return null;
  }
  if (!res.step) {
    boxLine('这块已经围好了，不需要再画一次');
    return null;
  }
  boxLine(res.ruled ? '这块合规则，但逻辑上已经放不下了：留意它为什么被排除' : '', false);
  afterStep('box');
  return res.step;
}

function tapCell(t) {
  if (game.st.owner[t] === OPEN) {
    const k = game.board.clueOf[t];
    boxLine(k === OPEN ? '按住并拖动，才能围出一块区域' : `数字 ${game.board.values[k]} 要圈住 ${game.board.values[k]} 格：按住它拖出一个方块`);
    return null;
  }
  const step = game.tap(t);
  if (step) afterStep('erase');
  return step;
}

el.canvas.addEventListener('pointerdown', pointerDown);
el.canvas.addEventListener('pointermove', pointerMove);
el.canvas.addEventListener('pointerup', pointerUp);
el.canvas.addEventListener('pointercancel', () => {
  drag = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

$('#btn-mode-box').addEventListener('click', () => setMode('box'));
$('#btn-mode-cut').addEventListener('click', () => setMode('cut'));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.seed, resume: r });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.box();
});
$('#btn-notes').addEventListener('click', () => {
  Store.setSetting('showNotes', !Store.setting('showNotes'));
  applySettings();
  draw();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  if (ev.key === 'h') useHint();
  else if (ev.key === 'z') undo();
  else if (ev.key === 'm') setMode(game && game.mode === 'cut' ? 'box' : 'cut');
  // R 重开同一题，**局中就能按**（不只结算后）：玩家划到一半发现框错了，当场 R 一下重来。
  // 本仓原先没有任何键占着 R（h/z/m 是玩法与模式，P 暂停，F 全屏，N 静音），所以不需要换键。
  else if (ev.key === 'r' || ev.key === 'R') restart();
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

window.shikaku = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  restart,
  useHint,
  undo,
  setMode,
  // The harness commits the same way a pointer release does, so a scenario that passes here
  // has driven the real acceptance test rather than a copy of it.
  drawBox(r0, c0, r1, c1) {
    if (!game) return null;
    const step = commit({ r0, c0, r1, c1 });
    if (step) syncAll();
    return step;
  },
  tap(t) {
    if (!game) return null;
    const step = tapCell(t);
    if (step) syncAll();
    return step;
  },
  cut(pair) {
    if (!game) return null;
    const step = game.cut(pair);
    if (step) afterStep('note');
    return step;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), mode: game.mode } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  ownerOf: (t) => (game ? game.ownerOf(t) : OPEN),
  boxLine: () => el.boxLine.textContent,
  // The palette travels with the surface so a pixel assertion can name the token it expects
  // rather than a hex copied out of this file.
  engine: { ...Engine, makePuzzle, generate, solutionOf, countSolutions, TIERS, tierFor, Game, boxReadout, Store, theme: Palette, OPEN },
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P' || k === ' ') { ev.preventDefault(); togglePause(); }
});

// ---- 静音开关（N）-----------------------------------------------------------------
// M 在本仓已被玩法占用（见 keydown 里的模式切换），所以静音走 N。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'n' || ev.key === 'N') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});
