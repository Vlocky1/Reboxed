// Pad lights: the 8x8 grid (and the side/top buttons) as RGB 0..127, computed each frame from the
// pad colours, a background animation synced to the master tempo and the press effects running.
// Pure (time is passed in): the same frame lights the Launchpad X and the on-screen grid.

const clamp = (v) => Math.max(0, Math.min(127, Math.round(v)));
export const scale = (c, k) => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
const max3 = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];

/** Hue 0..1 to RGB 0..127. */
export function hue(hh, v = 1) {
  const h6 = (((hh % 1) + 1) % 1) * 6;
  const f = h6 - Math.floor(h6);
  const [r, g, b] = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][Math.floor(h6) % 6];
  return [clamp(r * 127 * v), clamp(g * 127 * v), clamp(b * 127 * v)];
}

/** Deterministic 0..1 noise for cell / seed. */
const hash = (a, b, c = 0) => {
  let x = (a * 374761393 + b * 668265263 + c * 2147483647) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/**
 * Intensity 0..1 of a press effect at cell (x, y).
 * @param {string} fx
 * @param {number} p progress 0..1
 */
export function effectAt(fx, ox, oy, x, y, p, seed = 0) {
  const fade = 1 - p;
  const dx = x - ox; const dy = y - oy;
  switch (fx) {
    case 'flash': return dx === 0 && dy === 0 ? fade : 0;
    case 'ripple': {
      const r = p * 9;
      const d = Math.hypot(dx, dy);
      return Math.max(0, 1 - Math.abs(d - r) / 0.9) * fade;
    }
    case 'cross': return (dx === 0 || dy === 0) ? fade * Math.max(0.25, 1 - Math.max(Math.abs(dx), Math.abs(dy)) * p * 0.5) : 0;
    case 'row': return dy === 0 ? fade : 0;
    case 'column': return dx === 0 ? fade : 0;
    case 'square': return Math.max(Math.abs(dx), Math.abs(dy)) === Math.floor(p * 8) ? 1 : 0;
    case 'sparkle': return hash(x, y, seed + Math.floor(p * 12)) > 0.78 ? fade : 0;
    case 'fill': return fade * fade;
    default: return 0;
  }
}

export class LightShow {
  constructor() {
    /** @type {{fx: string, x: number, y: number, color: number[], start: number, dur: number, seed: number}[]} */
    this.effects = [];
  }

  /** A pad press effect starting at time t (seconds). */
  trigger(fx, x, y, color, t, dur = 0.4) {
    if (!fx || fx === 'none') return;
    this.effects.push({ fx, x, y, color, start: t, dur: Math.max(0.08, dur), seed: Math.floor(t * 1000) });
    if (this.effects.length > 48) this.effects.shift();
  }

  clear() { this.effects = []; }

  /**
   * The grid at time t.
   * @param {number} t seconds
   * @param {{cells: (number[]|null)[], active: boolean[], idle: string, cover: boolean, brightness?: number,
   *   beat?: {bpm: number, phase: number, beatInBar: number}|null, level?: number}} s
   *   cells: 64 base colours (null = empty pad), active: pads playing / held, cover: the background
   *   animation covers the loaded pads too (show mode)
   * @returns {number[][]} 64 RGB colours, row major from the top-left
   */
  frame(t, s) {
    const beat = s.beat;
    const phase = beat?.bpm > 0 ? beat.phase : (t * 2) % 1;
    const bars = beat?.bpm > 0 ? (beat.beatInBar + phase) / 4 : (t / 2) % 1;
    const level = s.level ?? 0;
    const out = new Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = y * 8 + x;
        const base = s.cells[i];
        let bg;
        switch (s.idle) {
          case 'pulse': bg = scale(base ?? [40, 40, 60], 0.25 + 0.75 * (1 - phase) ** 2); break;
          case 'rainbow': bg = hue((x + y) / 16 + bars / 2, 0.55); break;
          case 'wave': bg = hue(0.55 + y * 0.02, Math.max(0, Math.sin((x / 8 - bars) * Math.PI * 2)) * 0.7); break;
          case 'spectrum': {
            const hgt = level * 8 * (0.6 + 0.4 * hash(x, Math.floor(t * 12)));
            bg = 7 - y < hgt ? (y < 2 ? [127, 0, 0] : y < 4 ? [127, 100, 0] : [0, 127, 20]) : [0, 0, 0];
            break;
          }
          case 'rain': {
            const head = ((t * (beat?.bpm > 0 ? beat.bpm / 60 : 2) * 2 + hash(x, 7) * 8) % 10);
            const d = head - y;
            bg = d >= 0 && d < 3 ? scale([0, 90, 127], 1 - d / 3) : [0, 0, 0];
            break;
          }
          case 'off': bg = [0, 0, 0]; break;
          default: bg = base ? scale(base, 0.35) : [0, 0, 0];
        }
        let c;
        if (base && !s.cover) c = s.active[i] ? base : (s.idle === 'pulse' ? bg : scale(base, s.idle === 'off' ? 0.15 : 0.35));
        else c = s.active[i] ? base ?? [127, 127, 127] : bg;
        out[i] = c;
      }
    }
    this.effects = this.effects.filter((e) => t - e.start < e.dur);
    for (const e of this.effects) {
      const p = Math.max(0, (t - e.start) / e.dur);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const k = effectAt(e.fx, e.x, e.y, x, y, p, e.seed);
          if (k > 0.02) out[y * 8 + x] = max3(out[y * 8 + x], scale(e.color, k));
        }
      }
    }
    const b = (s.brightness ?? 100) / 100;
    return b === 1 ? out : out.map((c) => scale(c, b));
  }
}
