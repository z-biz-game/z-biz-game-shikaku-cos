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
import { FxLayer } from './render/fx.js';
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
  pauseVeil: $('#pause-veil'),
  pauseMeta: $('#pause-meta'),
  helpVeil: $('#help-veil'),
  btnPause: $('#btn-pause'),
  btnFull: $('#btn-full'),
  btnHelp: $('#btn-help'),
  fx: $('#fx'),
};

const view = new BoardView(el.canvas);
const fx = new FxLayer();
// Relative to document.baseURI so the bitmaps resolve under the Pages path prefix too.
fx.load({
  spark: new URL('assets/img/spark-64.png', document.baseURI).href,
  paper: new URL('assets/img/paper-256.png', document.baseURI).href,
});
fx.whenReady('paper', (img) => view.usePaper(img));
let rafId = 0;
let lastFrame = 0;
let game = null;
let pulse = null;
let drag = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let paused = false;
let helpOpen = false;
let selectedTier = 'trainee';

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

// Where an effect belongs on screen, in the same CSS pixels the overlay canvas is drawn in.
function fxCenterOfBox(box) {
  const q = view.boxRect(box);
  return { x: q.x + q.w / 2, y: q.y + q.h / 2, r: Math.max(q.w, q.h) / 2 };
}

function fxCenterOfCells(cells) {
  if (!cells || !cells.length) return null;
  let x = 0;
  let y = 0;
  for (const t of cells) {
    const r = view.cellRect(t);
    x += r.x + r.size / 2;
    y += r.y + r.size / 2;
  }
  return { x: x / cells.length, y: y / cells.length, r: view.geo.cell };
}

function sizeFx() {
  const geo = view.geo;
  const style = el.fx.style;
  style.width = `${geo.w}px`;
  style.height = `${geo.h}px`;
  el.fx.width = Math.round(geo.w * geo.dpr);
  el.fx.height = Math.round(geo.h * geo.dpr);
  el.fx.getContext('2d').setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  sizeFx();
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

// ---- run controls: 暂停 / 重开 / 全屏 / 静音 / 教学 ------------------------------------------

// Pause is a clock stop and an audio stop, not a dim overlay: `stopClock()` folds the running
// span into baseElapsed, so the timer cannot advance while the player is away, and
// Sound.suspend() suspends the real AudioContext instead of queueing notes into it.
function setPaused(v) {
  const want = !!v;
  if (want && (!game || game.status === 'won')) return paused;
  if (want === paused) return paused;
  paused = want;
  if (paused) {
    stopClock();
    Sound.suspend();
    drag = null;
    el.pauseMeta.textContent = `${game.puzzle.tierName} · ${game.w}×${game.h} · ${fmtMs(clock())} · ${game.moves} 步 · 提示 ${game.hints} 次`;
    el.pauseVeil.hidden = false;
  } else {
    Sound.resume();
    el.pauseVeil.hidden = true;
    startClock();
  }
  syncPauseButton();
  syncAll();
  return paused;
}

function syncPauseButton() {
  const live = !!game && game.status !== 'won';
  el.btnPause.disabled = !live || el.viewGame.hidden;
  el.btnPause.setAttribute('aria-pressed', String(paused));
  el.btnPause.textContent = paused ? '继续' : '暂停';
}

function toggleFullscreen() {
  const node = document.fullscreenElement ? null : document.documentElement;
  const request = node && (node.requestFullscreen ? node.requestFullscreen.bind(node) : node.webkitRequestFullscreen && node.webkitRequestFullscreen.bind(node));
  if (!request && !document.fullscreenElement) {
    boxLine('这个浏览器不让网页自己全屏，用系统菜单的全屏。');
    return false;
  }
  const done = document.fullscreenElement ? document.exitFullscreen() : request();
  Promise.resolve(done).catch(() => boxLine('全屏被系统拦下了。'));
  return true;
}

function setHelp(v) {
  helpOpen = !!v;
  el.helpVeil.hidden = !helpOpen;
  el.btnHelp.setAttribute('aria-expanded', String(helpOpen));
  if (helpOpen && paused) setPaused(false);
  return helpOpen;
}

// Mute goes through the same path as the 音效 button so the two can never disagree about the
// setting that is written to storage.
function toggleMute() {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  if (Store.setting('sound')) Sound.box();
  return !!Store.setting('sound');
}

function resetFx() {
  pulse = null;
  drag = null;
  fx.reset();
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
  const at = info.kind === 'kill' ? fxCenterOfBox(pulse.box) : fxCenterOfCells(info.cells);
  if (at) fx.pulse(at.x, at.y, at.r, 1600, 'hint');
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
  const mid = { x: view.geo.x + game.w * view.geo.cell / 2, y: view.geo.y + game.h * view.geo.cell / 2 };
  fx.pulse(mid.x, mid.y, Math.max(view.geo.w, view.geo.h) / 2.4, 900, 'win');
  for (let i = 0; i < 5; i++) {
    const r = view.cellRect(game.board.clueCell[i % game.board.clues]);
    fx.burst(r.x + r.size / 2, r.y + r.size / 2, 'win', 10);
  }
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

// One place puts a puzzle on screen, so 换一局 / 继续 / 重开本局 cannot differ by what they
// forgot to clear: the clock, the gesture buffer, the fx buffers, both veils and the pause flag.
function mount(puzzle, resume = null) {
  game = new Game(puzzle);
  pulse = null;
  drag = null;
  resetFx();
  paused = false;
  el.pauseVeil.hidden = true;
  el.winVeil.hidden = true;
  syncPauseButton();
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

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const puzzle = makePuzzle(origin, tier);
  if (!puzzle) return null;
  selectedTier = puzzle.tier;
  return mount(puzzle, resume);
}

// 重开本局: the same board, from nothing. The generator is deterministic on the origin seed, so
// reusing the puzzle object keeps the run identical without paying for regeneration.
function restartRun() {
  if (!game) return null;
  return mount(game.puzzle, null);
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    paused = false;
    el.pauseVeil.hidden = true;
    Sound.resume();
    syncPauseButton();
    stopClock();
    renderMenu();
  }
  if (which === 'game') draw();
  syncPauseButton();
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
    b.addEventListener('pointerenter', () => { selectedTier = t.key; });
    b.addEventListener('focus', () => { selectedTier = t.key; });
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
  if (!game || game.status === 'won' || paused || helpOpen) return;
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
    const at = fxCenterOfBox(box);
    fx.pulse(at.x, at.y, at.r, 420, 'bad');
    if (!res.step) Sound.conflict();
    return null;
  }
  if (!res.step) {
    boxLine('这块已经围好了，不需要再画一次');
    return null;
  }
  boxLine(res.ruled ? '这块合规则，但逻辑上已经放不下了：留意它为什么被排除' : '', false);
  const at = fxCenterOfBox(res.box || box);
  fx.burst(at.x, at.y, res.ruled ? 'box' : 'bad', res.ruled ? 12 : 6);
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

// Pointer Events is the preferred path, but a browser without it still has to be playable:
// these fall back to touch/mouse and hand the same {clientX, clientY} the hit test already
// scales by getBoundingClientRect. Without this branch, 触屏 Safari-era engines read a click
// on cell A as a click on cell B because the drag never started.
if (!('onpointerdown' in el.canvas)) {
  const point = (ev) => (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
  const asEvent = (ev) => {
    const p = point(ev);
    return { clientX: p.clientX, clientY: p.clientY, pointerId: 0, preventDefault: () => ev.preventDefault() };
  };
  const down = (ev) => {
    ev.preventDefault();
    pointerDown(asEvent(ev));
  };
  const move = (ev) => pointerMove(asEvent(ev));
  const up = () => pointerUp();
  el.canvas.addEventListener('touchstart', down, { passive: false });
  el.canvas.addEventListener('touchmove', move, { passive: false });
  el.canvas.addEventListener('touchend', up);
  el.canvas.addEventListener('touchcancel', () => {
    drag = null;
    syncAll();
  });
  el.canvas.addEventListener('mousedown', down);
  addEventListener('mousemove', (ev) => {
    if (drag) pointerMove(asEvent(ev));
  });
  addEventListener('mouseup', up);
}

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
$('#btn-sound').addEventListener('click', toggleMute);
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-resume-run').addEventListener('click', () => setPaused(false));
$('#btn-restart-run').addEventListener('click', () => { setPaused(false); restartRun(); });
$('#btn-full').addEventListener('click', toggleFullscreen);
$('#btn-help').addEventListener('click', () => setHelp(!helpOpen));
$('#btn-help-close').addEventListener('click', () => setHelp(false));
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  el.btnFull.setAttribute('aria-pressed', String(on));
  el.btnFull.textContent = on ? '退出全屏' : '全屏';
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

// ---- the frame loop ---------------------------------------------------------------------
//
// Everything time-based in this app runs here, off one number: the fixed-step accumulator
// inside FxLayer. `window.game` mirrors the live state so any probe — the official frame-rate
// one included — reads the same truth the screen is drawn from instead of guessing at it.

const telemetry = {
  state: 'menu',
  phase: 'wait',
  elapsedMs: 0,
  animClock: 0,
  simSteps: 0,
  particles: 0,
  moves: 0,
  hints: 0,
  owned: 0,
  remaining: 0,
  score: 0,
  cells: null,
  fx: fx.p,
};

// Direct field reads, no game.state() allocation: this runs every frame, and an object built
// 120 times a second to be thrown away is how a puzzle game starts dropping frames.
function syncTelemetry() {
  telemetry.state = !game ? 'menu' : paused ? 'paused' : game.status === 'won' ? 'finished' : 'playing';
  telemetry.elapsedMs = game ? clock() : 0;
  telemetry.animClock = fx.clock;
  telemetry.simSteps = fx.simSteps;
  telemetry.particles = fx.count;
  if (!game) {
    telemetry.phase = 'wait';
    telemetry.cells = null;
    telemetry.moves = telemetry.hints = telemetry.owned = telemetry.remaining = 0;
    return;
  }
  const d = game.diag;
  telemetry.phase = drag ? 'drag' : pulse ? 'hint' : game.status === 'won' ? 'celebrate' : 'settle';
  telemetry.moves = game.moves;
  telemetry.hints = game.hints;
  telemetry.owned = d.owned;
  telemetry.remaining = d.remaining;
  telemetry.score = game.puzzle.score;
  telemetry.cells = game.st.owner;
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  // The first frame carries no delta: pretending it did would invent a 16 ms step that the
  // 30 Hz tier gets and the 120 Hz tier doesn't.
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  const live = !el.viewGame.hidden && !paused && !helpOpen;
  if (live) fx.advance(dt);
  // `fx.dirty` — not the live counts: on the frame the last particle dies there is nothing left
  // to animate yet the canvas still holds the previous frame's pixels, and only render() clears.
  if (fx.dirty) fx.render(el.fx.getContext('2d'), view.geo.dpr || 1);
  syncTelemetry();
}

rafId = requestAnimationFrame(frame);

// Enter/Space 开局 · P 暂停 · R 重开本局 · N 再来一局 · H 提示 · Z 撤销 · K 换模式 ·
// M 静音 · F 全屏 · ? 教学 · Esc 收掉浮层。M used to be 换模式; it is 静音 here because that is
// the key every other screen already means by it, and 换模式 moved to K.
function onKeydown(ev) {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  const inGame = !el.viewGame.hidden;
  // A focused button already turns Space into a click; handling it here would fire twice.
  const onButton = ev.target && ev.target.tagName === 'BUTTON';

  if (k === '?' || k === '/') { ev.preventDefault(); setHelp(!helpOpen); return; }
  if (k === 'Escape') { if (helpOpen) setHelp(false); else if (drag) { drag = null; syncAll(); } return; }
  if (!inGame) {
    if (k === 'Enter' || (k === ' ' && !onButton)) { ev.preventDefault(); begin({ tier: selectedTier }); }
    return;
  }
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'k') setMode(game && game.mode === 'cut' ? 'box' : 'cut');
  else if (k === 'm') toggleMute();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'r') { ev.preventDefault(); restartRun(); }
  else if (k === 'n') begin({ tier: game ? game.puzzle.tier : selectedTier });
  else if (k === 'p' || (k === ' ' && !onButton)) { ev.preventDefault(); setPaused(!paused); }
}

window.addEventListener('keydown', onKeydown);

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

// file:// has no service workers — the Electron window loads this same tree off disk, so the
// protocol is checked rather than the API being called and the rejection swallowed. The URL is
// resolved against document.baseURI because Pages serves the app under /z-biz-game-shikaku-cos/.
if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href).catch(() => {
      /* offline support is an upgrade, not a dependency */
    });
  });
}

// `window.game` is the state surface a frame-rate probe reads: strings for the state machine,
// scalars that advance with virtual time, and the engine's own per-cell truth.
window.game = telemetry;

window.shikaku = {
  fx,
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
  get paused() {
    return paused;
  },
  setPaused,
  restartRun,
  toggleFullscreen,
  toggleMute,
  setHelp,
  get helpOpen() {
    return helpOpen;
  },
  soundState: () => Sound.state(),
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
