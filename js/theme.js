// Single source of truth for colour, spacing and motion. The stylesheet reads these as
// custom properties (applyThemeVars) and the canvas reads the same objects, so a token
// change cannot land on one side only — which is how "one region tint" turns into forty.

export const Palette = {
  bgTop: '#080B16',
  bgBottom: '#131A2E',
  surface: '#101627',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#3A4A72',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // Amber is the player's own mark: the box being dragged, the region a hint just named, and
  // the win banner all borrow it, so "this is what you are doing" reads as one idea.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // The pencil is the player's own hand: a cut note is a thought, not a decision, so it stays
  // cooler and quieter than any border on the board.
  unlit: '#2B3A5E',
  pencil: 'rgba(242,245,251,0.30)',

  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  info: '#7BB8FF',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // Regions are told apart by tint, not by shape: eight soft fills cycling by clue index, with
  // the heavy border doing the separating. Indexing by clue means the same board always paints
  // the same colours, which is what lets the browser harness assert a pixel.
  tints: ['#2E4269', '#1F5158', '#46356B', '#2F5138', '#5C3A2E', '#5A2F47', '#33506B', '#5A4F2C'],
  // A settled region is lifted toward white by this much, so the hue ramp survives being
  // finished: a flat overlay colour would paint every region the same shade and the whole
  // point of tinting — telling regions apart at a glance — would vanish on the win screen.
  // The legend's sample of one lifted region is `tint-0` under the same lift.
  tintLift: 0.1,
  tintDone: '#42547A',
  tintEdge: 'rgba(242,245,251,0.86)',
  tintBad: 'rgba(255,92,122,0.30)',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = {
  min: 20,
  max: 58,
  clueScale: 0.44, // the digit has to leave room for the region's tint around it
  cutScale: 0.34, // a pencil note is a tick across half an edge, not a full border
  noteScale: 0.16,
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    // Arrays get their own loop below, one property per entry.
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  // The region ramp is an array, so it gets one property per tint: the legend's swatch and the
  // canvas then read the same colour rather than agreeing by eye.
  Palette.tints.forEach((c, i) => root.setProperty('--tint-' + i, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a
// player who asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
