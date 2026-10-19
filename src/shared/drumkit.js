// Built-in DRUM SWAP loops: a small synthesised drum kit and 8 patterns (bank A: four-on-the-floor
// styles, bank B: broken beats), rendered at the deck's tempo so they never need pitching.
// Pure functions (no Web Audio): tested under Node, rendered into AudioBuffers by groove.js.

/** 16th-note grids per bar, '|' separates bars. x = accent, o = soft, r = 32nd roll (two hits). */
export const DRUM_PATTERNS = [
  {
    name: 'House', bars: 1, swing: 0,
    tracks: { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'o.o.o.o.o.o.o.o.', ohat: '..x...x...x...x.' },
  },
  {
    name: 'Techno', bars: 1, swing: 0,
    tracks: { kick: 'x...x...x...x...', hat: 'xoxoxoxoxoxoxoxo', ohat: '..o...o...o...o.', rim: '...o..o....o..o.', ride: 'o...o...o...o...' },
  },
  {
    name: 'Tech House', bars: 1, swing: 0.14,
    tracks: { kick: 'x...x...x...x...', clap: '....x.......x...', shaker: 'xoooxoooxoooxooo', ohat: '..o...o...o...o.', rim: '...x.....x....o.' },
  },
  {
    name: 'Disco', bars: 1, swing: 0,
    tracks: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '..x...x...x...x.', tom: '..............o.' },
  },
  {
    name: 'Breakbeat', bars: 2, swing: 0,
    tracks: {
      kick: 'x.x.......x.....|..x.......x..x..',
      snare: '....x..o.o..x..o|.o..x..o.o..x...',
      hat: 'x.x.x.x.x.x.x.x.|x.x.x.x.x.x.x.x.',
      ride: '..............o.|..............o.',
    },
  },
  {
    name: 'UK Garage', bars: 1, swing: 0.22,
    tracks: { kick: 'x.........x..o..', clap: '....x.......x...', hat: '..x...x...x.x.x.', shaker: 'oooooooooooooooo', rim: '.......o......o.' },
  },
  {
    name: 'Hip-Hop', bars: 1, swing: 0.18,
    tracks: { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.o.x.o.x.o.x.o.', ohat: '..............o.' },
  },
  {
    name: 'Trap', bars: 2, swing: 0,
    tracks: {
      kick: 'x.....x...x.....|x.......x.x.....',
      clap: '........x.......|........x.......',
      hat: 'x.x.x.x.x.xrx.x.|x.x.rrx.x.x.xrrr',
      ohat: '..............o.|................',
    },
  },
];

/** Deterministic noise (the loops are identical every time). */
function noise(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296) * 2 - 1; };
}

/** One drum hit as mono samples. */
export function voice(name, rate = 44100, vel = 1) {
  const len = Math.round(rate * { kick: 0.45, snare: 0.25, clap: 0.32, hat: 0.07, ohat: 0.38, rim: 0.08, tom: 0.4, ride: 0.6, shaker: 0.09 }[name]);
  const out = new Float32Array(len);
  const rnd = noise(name.length * 7919 + 17);
  let phase = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const n = rnd();
    const hp = n - prev; prev = n; // crude high-pass for metallic noise
    let v = 0;
    switch (name) {
      case 'kick': {
        const f = 46 + 120 * Math.exp(-t * 32);
        phase += (2 * Math.PI * f) / rate;
        v = Math.sin(phase) * Math.exp(-t * 6.5) + (t < 0.004 ? n * 0.3 * (1 - t / 0.004) : 0);
        v = Math.tanh(v * 1.6);
        break;
      }
      case 'snare':
        phase += (2 * Math.PI * 190) / rate;
        v = 0.45 * Math.sin(phase) * Math.exp(-t * 28) + 0.55 * (n * 0.5 + hp * 0.5) * Math.exp(-t * 16);
        break;
      case 'clap': {
        const burst = [0, 0.011, 0.022].reduce((a, s) => a + (t >= s ? Math.exp(-(t - s) * 180) : 0), 0);
        v = (n * 0.4 + hp * 0.6) * (burst * 0.6 + Math.exp(-Math.max(0, t - 0.022) * 14) * 0.5);
        break;
      }
      case 'hat': v = hp * 0.55 * Math.exp(-t * 70); break;
      case 'ohat': v = hp * 0.45 * Math.exp(-t * 8.5); break;
      case 'rim':
        phase += (2 * Math.PI * 820) / rate;
        v = (Math.sin(phase) * 0.6 + hp * 0.3) * Math.exp(-t * 55);
        break;
      case 'tom': {
        const f = 95 + 60 * Math.exp(-t * 18);
        phase += (2 * Math.PI * f) / rate;
        v = Math.sin(phase) * Math.exp(-t * 8);
        break;
      }
      case 'ride': {
        const m = [3.1, 4.7, 6.3].reduce((a, k) => a + Math.sign(Math.sin(2 * Math.PI * 540 * k * t)), 0) / 3;
        v = (m * 0.25 + hp * 0.35) * Math.exp(-t * 4.5) * 0.6;
        break;
      }
      case 'shaker': v = hp * 0.35 * Math.sin(Math.PI * Math.min(1, t / 0.09)) ** 2; break;
      default: break;
    }
    out[i] = v * vel;
  }
  return out;
}

const PAN = { kick: 0, snare: 0, clap: 0, hat: 0.25, ohat: -0.2, rim: 0.35, tom: -0.3, ride: -0.35, shaker: 0.3 };
const LEVEL = { kick: 1, snare: 0.8, clap: 0.75, hat: 0.5, ohat: 0.45, rim: 0.45, tom: 0.6, ride: 0.35, shaker: 0.4 };

/**
 * Render a pattern at a tempo.
 * @param {typeof DRUM_PATTERNS[number]} pattern
 * @returns {{left: Float32Array, right: Float32Array, rate: number, bars: number, bpm: number}}
 */
export function renderPattern(pattern, bpm, rate = 44100) {
  const step = (60 / bpm / 4) * rate; // one 16th in samples
  const total = Math.round(step * 16 * pattern.bars);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const cache = new Map();
  const hit = (name, at, vel) => {
    const key = name;
    if (!cache.has(key)) cache.set(key, voice(name, rate));
    const v = cache.get(key);
    const g = LEVEL[name] * vel;
    const gl = g * Math.min(1, 1 - PAN[name]); const gr = g * Math.min(1, 1 + PAN[name]);
    for (let i = 0; i < v.length; i++) {
      const k = (at + i) % total; // wrap so tails continue at the loop start
      left[k] += v[i] * gl; right[k] += v[i] * gr;
    }
  };
  for (const [name, grid] of Object.entries(pattern.tracks)) {
    const cells = grid.replace(/\|/g, '');
    for (let s = 0; s < cells.length; s++) {
      const c = cells[s];
      if (c === '.') continue;
      const swing = s % 2 === 1 ? pattern.swing * step : 0;
      const at = Math.round(s * step + swing);
      const vel = c === 'x' ? 1 : c === 'o' ? 0.6 : 0.75;
      hit(name, at, vel);
      if (c === 'r') hit(name, at + Math.round(step / 2), 0.6);
    }
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;
  for (let i = 0; i < total; i++) { left[i] *= norm; right[i] *= norm; }
  return { left, right, rate, bars: pattern.bars, bpm };
}
