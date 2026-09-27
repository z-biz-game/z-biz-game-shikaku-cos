// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no region
// is "done" here, no border is judged here — so the picture cannot disagree with the solver that
// the hints and the win check both use.
//
// Layout lives here too (cell size from the container, board origin, DPR) because hitTest and
// hitCut have to answer with the *same* numbers draw() used. Those two drifting apart is how a
// board renders correctly but takes clicks one cell off — and, for 画线, half a cell off.

import { Palette, Cell, Radius } from '../theme.js';
import { OPEN } from '../engine/shikaku.js';

export function layoutFor(w, h, availW, availH) {
  const pad = 10;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

const tintOf = (clue) => Palette.tints[((clue % Palette.tints.length) + Palette.tints.length) % Palette.tints.length];

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels:
  // one ctx.scale at the top keeps digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(t) {
    const { cell, x, y } = this.geo;
    const game = this.game;
    return { x: (t % game.w) * cell + x, y: (((t / game.w) | 0) * cell) + y, size: cell };
  }

  // Pointer position → cell index, or -1 outside the grid. The padding is deliberately not
  // part of the board: a tap beside the board should do nothing rather than paint a corner.
  hitCell(clientX, clientY) {
    const p = this.local(clientX, clientY);
    const game = this.game;
    if (!p || !game) return -1;
    const gx = Math.floor(p.x / this.geo.cell);
    const gy = Math.floor(p.y / this.geo.cell);
    if (gx < 0 || gy < 0 || gx >= game.w || gy >= game.h) return -1;
    return gy * game.w + gx;
  }

  // The same pointer, read as an edge: which internal grid line is it closest to. A cut is
  // drawn *between* two cells, so the hit test has to snap to the line rather than to a cell —
  // otherwise 画线 would be unusable on a 20 px cell.
  hitCut(clientX, clientY) {
    const p = this.local(clientX, clientY);
    const game = this.game;
    if (!p || !game) return -1;
    const { cell } = this.geo;
    const { w, h, pairOf } = game.board;
    // Which line is nearest, and which cell the line runs alongside. Rounding picks the line;
    // flooring picks the cell — rounding both makes a click on the line above a cell belong to
    // the row below it, because Math.round(0.5) is 1.
    const cx = Math.round(p.x / cell);
    const cy = Math.round(p.y / cell);
    const dx = Math.abs(p.x - cx * cell);
    const dy = Math.abs(p.y - cy * cell);
    const row = Math.floor(p.y / cell);
    const col = Math.floor(p.x / cell);
    const th = cell * 0.3;
    if (dx <= dy) {
      if (cx <= 0 || cx >= w || dx > th || row < 0 || row >= h) return -1;
      return pairOf(row * w + (cx - 1), row * w + cx);
    }
    if (cy <= 0 || cy >= h || dy > th || col < 0 || col >= w) return -1;
    return pairOf((cy - 1) * w + col, cy * w + col);
  }

  // Cell coordinates of a drag box, in CSS pixels, for the readout the DOM shows beside it.
  boxRect(box) {
    const a = this.cellRect(Math.min(box.r0, box.r1) * this.game.w + Math.min(box.c0, box.c1));
    const rows = Math.abs(box.r1 - box.r0) + 1;
    const cols = Math.abs(box.c1 - box.c0) + 1;
    return { x: a.x, y: a.y, w: a.size * cols, h: a.size * rows, cell: a.size };
  }

  local(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { x, y } = this.geo;
    if (!this.geo.cell) return null;
    return { x: clientX - rect.left - x, y: clientY - rect.top - y };
  }

  draw(game, { pulse = null, preview = null, notes = true } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell, x: ox, y: oy } = geo;
    const b = game.board;
    const st = game.st;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // Region fills first: an owned cell wears its clue's tint, a region whose area and shape
    // already add up wears a brighter one. Both come from the engine's own readouts.
    const done = new Set(diag.regions.filter((r) => r.done).map((r) => r.clue));
    for (let t = 0; t < b.n; t++) {
      const r = this.cellRect(t);
      const owner = st.owner[t];
      ctx.fillStyle = owner === OPEN ? (b.clueOf[t] === OPEN ? Palette.bgBottom : Palette.unlit) : tintOf(owner);
      ctx.fillRect(r.x, r.y, cell, cell);
      if (owner !== OPEN && (done.has(owner) || won)) {
        ctx.fillStyle = `rgba(242,245,251,${Palette.tintLift})`;
        ctx.fillRect(r.x, r.y, cell, cell);
      }
      if (owner !== OPEN && diag.shapeBad.has(owner)) {
        ctx.fillStyle = Palette.tintBad;
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // The base grid, quiet under everything: it is the paper, not the answer.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= game.w; i++) line(ctx, ox + i * cell, oy, ox + i * cell, oy + game.h * cell);
    for (let j = 0; j <= game.h; j++) line(ctx, ox, oy + j * cell, ox + game.w * cell, oy + j * cell);

    // Region borders. Two owned cells that disagree are separated hard — that line is the
    // answer. An owned cell against an empty one is separated softly, so a region you have
    // drawn reads as a rectangle before the board around it is finished.
    for (let t = 0; t < b.n; t++) {
      if (t % game.w + 1 < game.w) this.border(t, t + 1, 'v', st.owner[t], st.owner[t + 1]);
      if (t + game.w < b.n) this.border(t, t + game.w, 'h', st.owner[t], st.owner[t + game.w]);
    }

    // Pencil cuts: a tick across the edge, shorter and cooler than a real border, because a
    // note is a thought and a border is a decision.
    for (let p = 0; p < st.cuts.length; p++) {
      if (!st.cuts[p] || !notes) continue;
      const [a, z] = b.pairCells(p);
      const ra = this.cellRect(a);
      const rz = this.cellRect(z);
      const vertical = Math.abs(a - z) === 1;
      const x = vertical ? Math.max(ra.x, rz.x) : (ra.x + rz.x) / 2 + cell / 2;
      const y = vertical ? (ra.y + rz.y) / 2 + cell / 2 : Math.max(ra.y, rz.y);
      const half = cell * Cell.cutScale;
      ctx.strokeStyle = diag.dubiousCuts && b.rectsOfPair[p].some((rid) => st.alive[rid]) ? Palette.error : Palette.pencil;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.lineCap = 'round';
      if (vertical) line(ctx, x, y - half, x, y + half);
      else line(ctx, x - half, y, x + half, y);
      ctx.lineCap = 'butt';
    }

    // Clue digits, each on a small disc of its own region's colour so the number stays legible
    // whatever tint it ended up on.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < b.clues; i++) {
      const t = b.clueCell[i];
      const r = this.cellRect(t);
      const cx = r.x + cell / 2;
      const cy = r.y + cell / 2;
      const rad = cell * 0.32;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = st.owner[t] === i ? 'rgba(8,11,22,0.72)' : 'rgba(8,11,22,0.45)';
      ctx.fill();
      ctx.strokeStyle = done.has(i) || won ? Palette.success : Palette.inkFaint;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `700 ${Math.round(cell * Cell.clueScale)}px ${FontStack}`;
      ctx.fillStyle = Palette.ink;
      ctx.fillText(String(b.values[i]), cx, cy + 1);
    }

    // The box under the finger: dashed, amber, and never mistaken for ink already laid down.
    if (preview) {
      const q = this.boxRect(preview);
      ctx.save();
      ctx.fillStyle = Palette.accentSoft;
      ctx.fillRect(q.x, q.y, q.w, q.h);
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.setLineDash([Math.max(4, cell * 0.22), Math.max(3, cell * 0.16)]);
      ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2);
      ctx.restore();
    }

    // What a hint just named, and nothing else: the outline is the only place the UI is allowed
    // to say "look here".
    if (pulse && pulse.cells && pulse.cells.length) {
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      for (const t of pulse.cells) {
        if (t < 0 || t >= b.n) continue;
        const r = this.cellRect(t);
        roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
        ctx.stroke();
      }
    }
    if (pulse && pulse.box) {
      const q = this.boxRect(pulse.box);
      ctx.strokeStyle = pulse.color || Palette.warn;
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(q.x + 2, q.y + 2, q.w - 4, q.h - 4);
      ctx.setLineDash([]);
    }

    // The frame: the board's own outer border, which is also a real region edge.
    ctx.strokeStyle = won ? Palette.success : Palette.lineHeavy;
    ctx.lineWidth = 2;
    roundRect(ctx, ox - 1, oy - 1, game.w * cell + 2, game.h * cell + 2, Radius.cell);
    ctx.stroke();
  }

  border(a, z, dir, oa, oz) {
    if (oa === oz) return;
    const { ctx } = this;
    const { cell } = this.geo;
    const both = oa !== OPEN && oz !== OPEN;
    if (!both && oa === OPEN && oz === OPEN) return;
    const ra = this.cellRect(a);
    const x = dir === 'v' ? (oa === OPEN ? ra.x : ra.x + cell) : ra.x;
    const y = dir === 'h' ? (oa === OPEN ? ra.y : ra.y + cell) : ra.y;
    ctx.strokeStyle = both ? Palette.tintEdge : 'rgba(242,245,251,0.34)';
    ctx.lineWidth = both ? Math.max(2.5, cell * 0.11) : Math.max(1.5, cell * 0.06);
    ctx.lineCap = 'square';
    if (dir === 'v') line(ctx, x, ra.y, x, ra.y + cell);
    else line(ctx, ra.x, y, ra.x + cell, y);
    ctx.lineCap = 'butt';
  }
}

const FontStack = "-apple-system, 'SF Pro Text', system-ui, sans-serif";

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
