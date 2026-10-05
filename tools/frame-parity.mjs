#!/usr/bin/env node
// 帧率对拍闸（仓内常驻，CI 跑）。
//
// 为什么要有这一份：官方量具 cos_frame_probe.js 用 `vm.runInContext` 执行 <script> 正文，
// 而本仓是 `<script type="module">` + 真 import —— 探针在装载阶段就 SyntaxError，
// 报「结论：无法比对」。派工简报 §3 明确「无法比对」不算通过，所以判尺得自己带。
//
// 三件事在这一份里，缺一不可：
//   1) 三档对拍：同一 LCG 随机流、同一串虚拟时长，分别按 30/60/120Hz 喂 rAF，
//      按 **sim 步号**（不是墙钟秒）逐字段对拍粒子数组、animClock、光环年龄。
//   2) 时长加测：同一档把虚拟时长从 3s 缩到 1s，状态必须跟着变 —— 三档全等但
//      缩短时长也不变的「静止快照」不算通过。
//   3) 阴性对照：把 fx.js 里仍在吃帧 dt 的那一行 `this.accum += elapsed` 改成常量，
//      同一套判尺必须变红。不变红说明尺子空跑，闸自己先失败。
//      （简报 §6：定步长改造完成后，改粒子位移行不再红 —— 那是结构性质不是尺子坏，
//       所以靶子钉在累加器上。）
//
// 用法：node tools/frame-parity.mjs [--verbose]  退出码 0=全绿
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 'parity-seed-7';
const TIERS = [30, 60, 120];
const LONG_S = 3;
const SHORT_S = 1;
// 粒子在固定 sim 步号注入：三档同一步同一批，否则年龄差一步就凭空分叉
const TRIGGERS = [100, 300, 340];
const VERBOSE = process.argv.includes('--verbose');
const log = console.log.bind(console);

/* ---------------------------------------------------------------- 浏览器桩 */

function makeCtx2d(canvas) {
  const isFx = canvas && canvas.id === 'fx';
  const base = { canvas, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '' };
  return new Proxy(base, {
    get(t, k) {
      if (isFx && k in paint) { const key = k; return () => { paint[key]++; }; }
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

// 画布绘制指令的计数：散场清屏那一判要看 clearRect 有没有在粒子归零后再来过一次。
const paint = { clearRect: 0, drawImage: 0, arc: 0 };

function buildSandbox(repo) {
  const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const els = new Map();
  const parentStub = { children: [], appendChild() {}, removeChild() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
  const stats = { osc: 0 };
  let clock = 1000; // 沙箱时钟从 1000ms 起：从 0 起步会被游戏的首帧哨兵吃掉一帧

  function stubEl(id) {
    const h = {};
    const style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] ?? ''; } };
    return {
      id, hidden: true, tagName: 'DIV', className: '', innerHTML: '', textContent: '', value: '', dataset: {}, style,
      classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, toggle(c, on) { const w = on === undefined ? !this._s.has(c) : !!on; if (w) this._s.add(c); else this._s.delete(c); return w; }, contains(c) { return this._s.has(c); } },
      children: [], width: 800, height: 600, clientWidth: 1200, clientHeight: 900,
      get offsetWidth() { return 1200; }, get offsetHeight() { return 900; },
      appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      setAttribute(k, v) { this[k] = String(v); }, getAttribute(k) { return this[k] ?? null; }, hasAttribute(k) { return this[k] !== undefined; }, removeAttribute(k) { delete this[k]; },
      addEventListener(t, cb) { (h[t] = h[t] || []).push(cb); }, removeEventListener(t, cb) { h[t] = (h[t] || []).filter((f) => f !== cb); },
      dispatch(t, ev) { for (const cb of h[t] || []) cb(ev); }, _h: h,
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return this; }, matches() { return false; },
      insertBefore(c) { this.children.unshift(c); return c; }, replaceChildren(...c) { this.children = c; }, contains() { return false; },
      focus() {}, blur() {}, click() {}, remove() {}, scrollTo() {}, scrollIntoView() {}, getClientRects() { return []; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
      getContext() { return (this._ctx = this._ctx || makeCtx2d(this)); }, putImageData() {}, drawImage() { paint.drawImage++; },
      get parentElement() { return parentStub; }, parentNode: null, firstElementChild: null, nextElementSibling: null,
    };
  }
  function byId(i) { if (!ids.has(i)) return null; if (!els.has(i)) els.set(i, stubEl(i)); return els.get(i); }
  const doc = {
    getElementById: byId,
    querySelector(sel) { const key = String(sel); if (key[0] === '#') { const by = byId(key.slice(1)); if (by) return by; } if (!doc._q.has(key)) doc._q.set(key, stubEl('q:' + key)); return doc._q.get(key); },
    _q: new Map(),
    querySelectorAll: () => [], createElement: (t) => stubEl('c-' + t), createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => stubEl('frag'), createEvent: () => ({ initEvent() {} }),
    body: stubEl('body'), documentElement: stubEl('html'), head: stubEl('head'),
    addEventListener(t, cb) { (doc._h[t] = doc._h[t] || []).push(cb); }, removeEventListener(t, cb) { doc._h[t] = (doc._h[t] || []).filter((f) => f !== cb); },
    _h: {}, activeElement: null, fullscreenElement: null, exitFullscreen: () => Promise.resolve(),
    baseURI: pathToFileURL(path.join(repo, 'index.html')).href, title: '', hidden: false, visibilityState: 'visible',
    fonts: { ready: Promise.resolve() }, dispatchEvent() { return true; },
  };

  const storage = {};
  const timers = [];
  const pending = [];
  let rs = 0x2f6e2b1; // LCG：三档同一条随机流，且可复现
  const seeded = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  let timerId = 1;

  const env = {
    document: doc, console: { log() {}, warn() {}, error() {} },
    requestAnimationFrame(cb) { pending.push(cb); return pending.length; }, cancelAnimationFrame() {},
    setTimeout(cb, ms) { const id = timerId++; timers.push({ at: clock + Math.max(0, Number(ms) || 0), cb, id }); return id; },
    setInterval(cb, ms) { const iv = Math.max(1, Number(ms) || 1), id = timerId++; timers.push({ at: clock + iv, cb, id, interval: iv }); return id; },
    clearTimeout(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    clearInterval(id) { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    performance: { now: () => clock },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; }, clear() { for (const k of Object.keys(storage)) delete storage[k]; } },
    devicePixelRatio: 2, innerWidth: 1200, innerHeight: 900,
    addEventListener(t, cb) { (env._h[t] = env._h[t] || []).push(cb); }, removeEventListener(t, cb) { env._h[t] = (env._h[t] || []).filter((f) => f !== cb); }, _h: {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty() {}, removeProperty() {} }),
    location: { href: '', protocol: 'https:', hash: '', search: '', pathname: '/index.html', host: 'parity.test', hostname: 'parity.test', origin: 'https://parity.test', port: '', reload() {}, assign() {}, replace() {} },
    navigator: { userAgent: 'frame-parity', maxTouchPoints: 1, serviceWorker: undefined },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    Image: function () { const i = stubEl('img'); i.onload = null; i.onerror = null; let src = ''; Object.defineProperty(i, 'src', { get: () => src, set(v) { src = v; i.width = 256; i.height = 256; } }); return i; },
    Audio: function () { return { play() { return { then() {} }; }, pause() {}, load() {}, addEventListener() {} }; },
    AudioContext: function () {
      const node = (extra) => { const n = { connect() { return n; }, disconnect() { return n; }, ...extra }; return n; };
      return {
        _state: 'suspended',
        createOscillator: () => { stats.osc++; return node({ start() {}, stop() {}, type: 'sine', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }); },
        createGain: () => node({ gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} } }),
        createBuffer: () => ({ getChannelData: () => new Float32Array(64) }),
        destination: {}, sampleRate: 44100, get currentTime() { return clock / 1000; },
        get state() { return this._state; }, set state(v) { this._state = v; },
        resume() { this._state = 'running'; return Promise.resolve(); },
        suspend() { this._state = 'suspended'; return Promise.resolve(); },
        close() { this._state = 'closed'; return Promise.resolve(); },
      };
    },
    CustomEvent: globalThis.CustomEvent, Event: globalThis.Event, Worker: function () { return { postMessage() {}, terminate() {}, addEventListener() {} }; },
    Path2D: function () { return { addPath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {}, closePath() {} }; },
    ResizeObserver: function () { return { observe() {}, unobserve() {}, disconnect() {} }; },
    CSS: { supports: () => false, escape: (s) => String(s) },
  };
  env.location.href = env.document.baseURI;
  env.Math = new Proxy(globalThis.Math, { get: (o, k) => (k === 'random' ? seeded : o[k]) });
  class FakeDate extends Date { static now() { return clock; } }
  env.Date = FakeDate;
  env.window = env; env.global = env; env.self = env;

  const FORCE = new Set(['document', 'window', 'navigator', 'location', 'localStorage', 'Image', 'AudioContext', 'Worker',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'devicePixelRatio', 'innerWidth', 'innerHeight',
    'addEventListener', 'removeEventListener', 'CustomEvent', 'Event', 'alert', 'confirm', 'self', 'global',
    'dispatchEvent', 'getComputedStyle', 'ResizeObserver', 'Path2D', 'Audio', 'CSS', 'Date', 'Math',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch']);
  for (const k of Object.keys(env)) {
    if (globalThis[k] === undefined || FORCE.has(k)) {
      try { globalThis[k] = env[k]; } catch { Object.defineProperty(globalThis, k, { value: env[k], writable: true, configurable: true }); }
    }
  }
  globalThis.window = globalThis; globalThis.global = globalThis; globalThis.self = globalThis;

  return {
    env, els, byId, stats, clock: () => clock,
    frame(ms) {
      clock += ms;
      for (const t of timers) {
        if (t.dead || clock < t.at) continue;
        if (t.interval) t.at = clock + t.interval; else t.dead = true;
        try { t.cb(); } catch { /* 定时器回调抛错不该中断推进 */ }
      }
      for (let i = timers.length - 1; i >= 0; i--) if (timers[i].dead) timers.splice(i, 1);
      const q = pending.splice(0, pending.length);
      for (const cb of q) cb(clock);
    },
  };
}

/* ------------------------------------------------------------ 装载与推进 */

function tmpCopy(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shikaku-parity-' + tag + '-'));
  fs.cpSync(REPO, tmp, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|dist|build)[\\/]/.test(s + '/') });
  return tmp;
}

// 阴性对照的靶子：仍在吃帧 dt 的那一行（简报 §6）。改的是临时副本，产品仓一个字节都不动。
function mutateAccumulator(tmp) {
  const f = path.join(tmp, 'js/render/fx.js');
  const src = fs.readFileSync(f, 'utf8');
  const target = 'this.accum += elapsed;';
  if (!src.includes(target)) throw new Error('阴性对照靶子不在位（fx.js 里找不到 `this.accum += elapsed;`）—— 尺子该重新对准，不许跳过对照');
  fs.writeFileSync(f, src.replace(target, 'this.accum += 1 / 60;'));
  return 'fx.js: this.accum += elapsed  →  this.accum += 1/60';
}

async function boot(repo, entryTag) {
  const sb = buildSandbox(repo);
  const url = pathToFileURL(path.join(repo, 'js/main.js')).href + '?' + entryTag;
  await import(url);
  const api = globalThis.shikaku;
  const telemetry = globalThis.game;
  if (!api || !telemetry) throw new Error('window.shikaku / window.game 未挂载：判尺读不到状态');
  // 首帧 dt 恒为 0（main.js 的 lastFrame 哨兵）：先空跑一帧吃掉哨兵，且不推进时钟
  sb.frame(0);
  return { api, telemetry, sb };
}

// 三档必须喂入**同一串虚拟时长**：整帧 + 末尾补零头，否则 round 出来的帧数让 30Hz 多跑一帧，
// 凭空多出 4 步 —— 那是尺子的误差不是缺陷。
function drive(sb, fps, seconds, onFrame) {
  const ms = 1000 / fps;
  const total = seconds * 1000;
  const n = Math.floor(total / ms);
  for (let i = 0; i < n; i++) { sb.frame(ms); if (onFrame) onFrame(i + 1); }
  const rem = total - n * ms;
  if (rem > 1e-9) { sb.frame(rem); if (onFrame) onFrame(n + 1); }
}

function arrDiff(a, b) {
  let n = 0, first = -1, l1 = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; l1 += Math.abs(a[i] - b[i]); }
  return { n, first, l1: +l1.toFixed(6) };
}

const defaultSpawn = (fx) => { fx.burst(120, 90, 'box', 10); fx.burst(200, 140, 'win', 8); fx.pulse(150, 120, 40, 900, 'hint'); };

// 一次跑完一个档：包住 fx.step 逐 sim 步留副本（按帧采会漏掉中间步），并记下叠加画布的
// 最后一次清屏 / 最后一次真画出粒子像素的步号 —— 粒子散场后若没有再来一次 clearRect，
// 最后一帧的粒子就永远糊在屏上（残影）。
async function runTier(fps, repo, seconds, scenario = {}) {
  const triggers = scenario.triggers || TRIGGERS;
  const spawn = scenario.spawn || defaultSpawn;
  const tag = scenario.tag || 'main';
  const { api, telemetry, sb } = await boot(repo, `${tag}-${fps}-${seconds}`);
  if (!api.begin({ tier: 'trainee', seed: SEED })) throw new Error('begin() 没把牌局挂上');
  const st = api.state();
  if (!st || st.status !== 'playing') throw new Error(`未进关卡：status=${st && st.status}（标题态快照不算通过）`);
  const fx = api.fx;
  const byStep = new Map();
  const fired = new Set();
  const origStep = fx.step;
  const origRender = fx.render;
  let prevLive = false;
  let quietStep = -1;
  let lastClearStep = -1;
  let lastDrawStep = -1;
  fx.step = function (dt) {
    origStep.call(this, dt);
    for (const t of triggers) if (!fired.has(t) && this.simSteps >= t) { fired.add(t); spawn(this); }
    byStep.set(this.simSteps, { animClock: this.clock, particles: this.count, ringAge: this.ring.age, p: Float32Array.from(this.p) });
    const live = this.count > 0 || this.ring.life > 0;
    if (prevLive && !live) quietStep = this.simSteps;
    prevLive = live;
  };
  fx.render = function (ctx, dpr) {
    const c0 = paint.clearRect, d0 = paint.arc + paint.drawImage;
    const r = origRender.call(this, ctx, dpr);
    if (paint.clearRect > c0) lastClearStep = this.simSteps;
    if (paint.arc + paint.drawImage > d0) lastDrawStep = this.simSteps;
    return r;
  };
  let frames = 0;
  let peak = 0;
  drive(sb, fps, seconds, () => {
    frames++;
    peak = Math.max(peak, fx.count);
  });
  return {
    fps, tag, byStep, frames, peak, final: byStep.get(fx.simSteps), simSteps: fx.simSteps,
    animClock: fx.clock, elapsedMs: telemetry.elapsedMs, clears: paint.clearRect,
    quietStep, lastClearStep, lastDrawStep, clockMs: sb.clock() - 1000,
  };
}

// clearRect 计数要真实来自 ctx 桩：把计数挂进 makeCtx2d（见下），这里只做读取与清零。
function resetPaint() { paint.clearRect = 0; paint.drawImage = 0; paint.arc = 0; }

async function main() {
  resetPaint();
  const repo = REPO;
  const runs = [];
  for (const f of TIERS) runs.push(await runTier(f, repo, LONG_S));
  const [A, B, C] = runs;
  log(`## 三档对拍 ${TIERS.join('/')}Hz 虚拟 ${LONG_S}s 种子=${SEED}（LCG 钉死，三档同一条随机流）`);
  for (const r of runs) log(`  ${r.fps}Hz: 帧=${r.frames} simSteps=${r.simSteps} animClock=${r.animClock.toFixed(9)}s 虚拟=${r.clockMs.toFixed(6)}ms 粒子峰=${r.peak} 末粒子=${r.final.particles} elapsed=${r.elapsedMs.toFixed(4)}ms`);

  const minFinal = Math.min(...runs.map((r) => r.simSteps));
  const probes = [...new Set([60, 100, 130, 240, 300, 341, minFinal])].filter((s) => s <= minFinal && A.byStep.has(s) && B.byStep.has(s) && C.byStep.has(s));
  let stepBad = 0;
  log('  --- 轴①：同 sim 步号逐字段对拍');
  for (const s of probes) {
    const a = A.byStep.get(s), b = B.byStep.get(s), c = C.byStep.get(s);
    const d1 = arrDiff(b.p, c.p), d2 = arrDiff(a.p, c.p);
    const okClock = Math.abs(a.animClock - c.animClock) < 1e-9 && Math.abs(b.animClock - c.animClock) < 1e-9;
    const okPart = a.particles === b.particles && a.particles === c.particles;
    const okRing = Math.abs(a.ringAge - c.ringAge) < 1e-9 && Math.abs(b.ringAge - c.ringAge) < 1e-9;
    if (d1.n || d2.n || !okClock || !okPart || !okRing) stepBad++;
    if (VERBOSE || d1.n || d2.n || !okClock || !okPart || !okRing) {
      log(`    step ${s}: 粒子 ${a.particles}/${b.particles}/${c.particles} animClock ${a.animClock.toFixed(9)} 60↔120{n=${d1.n},first=${d1.first},L1=${d1.l1}} 30↔120{n=${d2.n},first=${d2.first},L1=${d2.l1}} clock=${okClock} ring=${okRing}`);
    }
  }
  if (!stepBad) log(`    （${probes.length} 个公共步号 × ${A.byStep.get(probes[0]).p.length} 个 float 全等）`);

  log('  --- 轴②：同虚拟时长末态对拍');
  const w1 = arrDiff(B.final.p, C.final.p), w0 = arrDiff(A.final.p, C.final.p);
  const simAtWall = runs.map((r) => r.simSteps).join('/');
  log(`    simSteps ${simAtWall} animClock ${runs.map((r) => r.animClock.toFixed(9)).join(' / ')} 粒子 ${runs.map((r) => r.final.particles).join(' / ')}`);
  log(`    p 差异 60↔120 {n=${w1.n},first=${w1.first},L1=${w1.l1}} 30↔120 {n=${w0.n},first=${w0.first},L1=${w0.l1}}`);
  const wallOk = w0.n === 0 && w1.n === 0 && new Set(simAtWall.split('/')).size === 1;

  log('  --- 轴③：时长加测（缩到 1s 必须变，否则是静止快照）');
  const short = [];
  for (const f of TIERS) short.push(await runTier(f, repo, SHORT_S));
  const dShort = arrDiff(short[2].final.p, C.final.p);
  log(`    120Hz simSteps ${short[2].simSteps} → ${C.simSteps}，p 差异 n=${dShort.n} first=${dShort.first} L1=${dShort.l1}；三档 1s simSteps=${short.map((r) => r.simSteps).join('/')}`);
  const grewOk = dShort.n > 0 && short[2].simSteps < C.simSteps;

  log('  --- 轴④：粒子散场后叠加画布要再清一次（残影）');
  // 单独一场：只注入一次，且光环很短 —— 三秒窗口里叠加层必须彻底安静下来，
  // 安静之后画布若不再清一次，最后一帧的粒子像素就留在屏上。
  const QUIET = { tag: 'quiet', triggers: [20], spawn: (f) => { f.burst(120, 90, 'box', 10); f.pulse(150, 120, 40, 80, 'hint'); } };
  const residueRuns = [];
  for (const f of TIERS) residueRuns.push(await runTier(f, repo, LONG_S, QUIET));
  const residueBad = [];
  for (const r of residueRuns) {
    const wentQuiet = r.quietStep > 0;
    const drew = r.lastDrawStep > 0;
    const cleared = wentQuiet && drew && r.lastClearStep >= r.quietStep && r.lastClearStep >= r.lastDrawStep;
    const ok = wentQuiet && drew && cleared;
    if (!ok) residueBad.push(r.fps);
    log(`    ${r.fps}Hz: ${ok ? '✅' : '❌'} 散场于 step ${r.quietStep}（峰 ${r.peak} 粒），最后一次画粒子 step ${r.lastDrawStep}，最后一次 clearRect step ${r.lastClearStep}，总清屏 ${r.clears} 次`);
    if (!wentQuiet) log(`      —— 本场叠加层未安静，判不了残影（场景失效）`);
    else if (!drew) log(`      —— 一帧粒子都没画出来，判不了残影（场景失效）`);
    else if (!cleared) log(`      —— 散场后没有再清屏：残影留在 fx 画布上`);
  }
  const residueOk = residueBad.length === 0;

  const parityOk = stepBad === 0 && wallOk && grewOk;
  log(`  判定: 同步步${stepBad === 0 ? '全等 ✅' : `分叉 ${stepBad} 处 ❌`} | 同时长${wallOk ? '全等 ✅' : '分叉 ❌'} | 随时长推进${grewOk ? '成立 ✅' : '静止 ❌'} | 散场清屏${residueOk ? '成立 ✅' : '有残影 ❌'}`);
  log(`  帧率无关: ${parityOk ? '成立 ✅' : '不成立 ❌'}`);

  // 阴性对照：尺子必须能被一行真缺陷打红
  log('## 阴性对照');
  const bad = tmpCopy('mut');
  const note = mutateAccumulator(bad);
  log('  变异：' + note);
  resetPaint();
  const mutRuns = [];
  for (const f of TIERS) mutRuns.push(await runTier(f, bad, LONG_S));
  const mSim = mutRuns.map((r) => r.simSteps).join('/');
  const mDiff = arrDiff(mutRuns[0].final.p, mutRuns[2].final.p);
  const mDiff1 = arrDiff(mutRuns[1].final.p, mutRuns[2].final.p);
  log(`  变异后 simSteps 30/60/120 = ${mSim}（同一串虚拟时长）p 差异 30↔120{n=${mDiff.n},L1=${mDiff.l1}} 60↔120{n=${mDiff1.n},L1=${mDiff1.l1}}`);
  const redAsExpected = !(new Set(mSim.split('/')).size === 1 && mDiff.n === 0 && mDiff1.n === 0);
  log(`  尺子自证: ${redAsExpected ? '✅ 变异被定罪（尺子不是空跑）' : '❌ 变异未变红 —— 判尺失效，本闸不许放行'}`);
  fs.rmSync(bad, { recursive: true, force: true });

  const pass = parityOk && residueOk && redAsExpected;
  log(pass ? '结论：帧率无关成立，散场清屏成立，尺子有效' : '结论：未通过');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { log('闸自身异常：' + (e && e.stack || e)); process.exit(2); });
