// The only thing in this app that runs per frame, so it is the only place frame-rate
// independence has to be proven.
//
// Two rules keep it honest:
//   * the accumulator consumes the **frame dt** (`accum += elapsed`) and hands the work to a
//     fixed step, so every integration inside step() sees a constant dt — 30/60/120 Hz produce
//     the same particle field at the same virtual time. The `+ STEP_EPS` tolerance absorbs the
//     float dust a frame-summed clock picks up (1e-9 s against a 8.3 ms step); without it the
//     step count can straddle a boundary between tiers and the difference is measurement noise,
//     not physics.
//   * particles are spawned by **events** (a region closed, the board partitioned, a hint
//     landed), never by a per-frame probability. `if (Math.random() < 0.02)` per frame is the
//     bug this file must not contain.
//
// Reduced motion is a real branch: nothing spawns, the ring stays a static outline instead of
// fading, and the celebration draws nothing at all.

import { prefersReducedMotion } from '../theme.js';

const SIM_STEP = 1 / 120;
const STEP_EPS = 1e-9;
const MAX_STEPS = 8; // never burn a frame catching up on a background tab
export const MAX_PARTICLES = 120;
const STRIDE = 8; // x, y, vx, vy, age, life, size, frame

const FRAME = { box: 0, hint: 1, win: 2, bad: 3 };

export class FxLayer {
  constructor() {
    this.p = new Float32Array(MAX_PARTICLES * STRIDE);
    this.slot = new Uint8Array(MAX_PARTICLES);
    this.count = 0;
    this.accum = 0;
    this.clock = 0;
    this.simSteps = 0;
    this.ring = { x: 0, y: 0, r: 0, age: 0, life: 0, kind: 'box' };
    this.dirty = false;
    this.sprites = { paper: null, spark: null };
    this.waiters = { paper: [], spark: [] };
  }

  reset() {
    this.p.fill(0);
    this.slot.fill(0);
    this.count = 0;
    this.accum = 0;
    this.clock = 0;
    this.simSteps = 0;
    this.ring.life = 0;
    this.ring.age = 0;
    this.dirty = true;
  }

  // The bitmaps are an upgrade, not a dependency: until they arrive the layer paints circles
  // and the board keeps its flat fill, so a slow or missing PNG cannot blank the screen.
  load(urls) {
    for (const [key, href] of Object.entries(urls)) {
      const img = new Image();
      img.onload = () => {
        this.sprites[key] = img;
        this.dirty = true;
        for (const cb of this.waiters[key] || []) cb(img);
        this.waiters[key] = [];
      };
      img.onerror = () => {};
      img.src = href;
    }
  }

  whenReady(key, cb) {
    const img = this.sprites[key];
    if (img) cb(img);
    else (this.waiters[key] || (this.waiters[key] = [])).push(cb);
  }

  burst(x, y, kind, n = 10) {
    if (prefersReducedMotion()) return 0;
    let placed = 0;
    for (let s = 0; s < MAX_PARTICLES && placed < n; s++) {
      if (this.slot[s]) continue;
      this.slot[s] = 1;
      placed++;
      this.count++;
      const o = s * STRIDE;
      const a = (placed / n) * Math.PI * 2 + (s % 5) * 0.11;
      const speed = 26 + (s % 7) * 9;
      this.p[o] = x;
      this.p[o + 1] = y;
      this.p[o + 2] = Math.cos(a) * speed;
      this.p[o + 3] = Math.sin(a) * speed - 12;
      this.p[o + 4] = 0;
      this.p[o + 5] = 0.5 + (s % 4) * 0.12;
      this.p[o + 6] = 5 + (s % 3) * 2.5;
      this.p[o + 7] = FRAME[kind] ?? FRAME.box;
    }
    this.dirty = true;
    return placed;
  }

  // A hint's highlight: one ring that fades. Under reduced motion it stays a static outline
  // for the same span instead of shrinking.
  pulse(x, y, r, ms, kind = 'hint') {
    this.ring = { x, y, r, age: 0, life: Math.max(0.001, ms / 1000), kind };
    this.dirty = true;
  }

  clearPulse() {
    if (!this.ring.life) return;
    this.ring.life = 0;
    this.dirty = true;
  }

  advance(elapsed) {
    this.accum += elapsed;
    let steps = 0;
    while (this.accum + STEP_EPS >= SIM_STEP && steps < MAX_STEPS) {
      this.accum -= SIM_STEP;
      steps++;
      this.step(SIM_STEP);
    }
    if (steps === MAX_STEPS) this.accum = 0; // dropped the backlog rather than stalling
    this.dirty = steps > 0 && (this.count > 0 || this.ring.life > 0);
    return steps;
  }

  step(dt) {
    this.clock += dt;
    this.simSteps++;
    const damp = Math.pow(0.94, dt * 60); // dt-scaled, so the decay is per second not per frame
    let live = 0;
    for (let s = 0; s < MAX_PARTICLES; s++) {
      if (!this.slot[s]) continue;
      const o = s * STRIDE;
      this.p[o + 2] *= damp;
      this.p[o + 3] = this.p[o + 3] * damp + 42 * dt; // a little gravity, in units per second²
      this.p[o] += this.p[o + 2] * dt;
      this.p[o + 1] += this.p[o + 3] * dt;
      this.p[o + 4] += dt;
      if (this.p[o + 4] >= this.p[o + 5]) {
        this.slot[s] = 0;
        this.p[o + 5] = 0;
        continue;
      }
      live++;
    }
    this.count = live;
    if (this.ring.life > 0) {
      this.ring.age += dt;
      if (this.ring.age >= this.ring.life) this.ring.life = 0;
    }
  }

  // 0..1 across a particle's life; reduced motion never reaches here (nothing spawns).
  static fade(t) {
    return t >= 1 ? 0 : 1 - t * t;
  }

  render(ctx, dpr) {
    if (!this.dirty) return false;
    ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
    const sheet = this.sprites.spark;
    for (let s = 0; s < MAX_PARTICLES; s++) {
      if (!this.slot[s]) continue;
      const o = s * STRIDE;
      const life = this.p[o + 5];
      const age = this.p[o + 4];
      const k = FxLayer.fade(life ? age / life : 1);
      if (k <= 0.002) continue;
      const size = this.p[o + 6] * (0.6 + 0.4 * k);
      ctx.globalAlpha = k;
      if (sheet) {
        const cell = sheet.width / 4;
        ctx.drawImage(sheet, (this.p[o + 7] | 0) * cell, 0, cell, cell, this.p[o] - size, this.p[o + 1] - size, size * 2, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(this.p[o], this.p[o + 1], size, 0, Math.PI * 2);
        ctx.fillStyle = '#FFC85C';
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    if (this.ring.life > 0) {
      const reduced = prefersReducedMotion();
      const t = this.ring.age / this.ring.life;
      const grow = reduced ? 0 : (1 - Math.pow(1 - t, 2)) * this.ring.r * 0.35;
      ctx.globalAlpha = reduced ? 0.9 : 1 - t;
      ctx.strokeStyle = this.ring.kind === 'bad' ? '#FF5C7A' : this.ring.kind === 'win' ? '#3DDC91' : '#FFC85C';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.ring.x, this.ring.y, this.ring.r + grow, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.dirty = this.count > 0 || this.ring.life > 0;
    return true;
  }
}
