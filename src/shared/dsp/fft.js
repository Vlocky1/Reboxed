// In-place iterative radix-2 FFT (real input via complex arrays).

/** @type {Map<number, {cos: Float64Array, sin: Float64Array, rev: Uint32Array}>} */
const tables = new Map();

function tablesFor(n) {
  let t = tables.get(n);
  if (t) return t;
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two: ${n}`);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  tables.set(n, t);
  return t;
}

/**
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, rev } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step];
        const s = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/**
 * Spectrum of a real signal of length n, through a complex FFT of half that size: about twice as
 * fast as fft(), and audio is always real.
 */
export class RealFft {
  /** @param {number} n power of two */
  constructor(n) {
    this.n = n;
    const h = n / 2;
    this.re = new Float64Array(h);
    this.im = new Float64Array(h);
    this.cos = new Float64Array(h);
    this.sin = new Float64Array(h);
    for (let k = 0; k < h; k++) { this.cos[k] = Math.cos((2 * Math.PI * k) / n); this.sin[k] = -Math.sin((2 * Math.PI * k) / n); }
  }

  /**
   * Magnitudes of bins 0..n/2-1.
   * @param {Float64Array} x n windowed samples
   * @param {Float64Array} mag receives n/2 values
   */
  magnitudes(x, mag) {
    const { re, im, cos, sin } = this;
    const h = this.n / 2;
    for (let i = 0; i < h; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
    fft(re, im);
    mag[0] = Math.abs(re[0] + im[0]);
    for (let k = 1; k < h; k++) {
      // The half-size spectrum holds the even and odd samples' spectra, separated here.
      const m = h - k;
      const er = (re[k] + re[m]) / 2; const ei = (im[k] - im[m]) / 2;
      const or = (im[k] + im[m]) / 2; const oi = (re[m] - re[k]) / 2;
      const c = cos[k]; const s = sin[k];
      const xr = er + or * c - oi * s;
      const xi = ei + or * s + oi * c;
      mag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  }
}

/** Hann window of length n. */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
