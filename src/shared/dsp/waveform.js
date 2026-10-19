// Waveform data: per-point peaks of three frequency bands (low / mid / high), Uint8 scaled.

export const WAVEFORM_PPS = 150; // points per second, same density as Rekordbox's detail waveform

/**
 * @param {Float32Array[]} bands [low, mid, high] filtered signals at `sampleRate`
 * @param {number} sampleRate
 * @param {number} [pps]
 * @returns {{pps: number, low: Uint8Array, mid: Uint8Array, high: Uint8Array}}
 */
export function reduceBands(bands, sampleRate, pps = WAVEFORM_PPS) {
  const len = bands[0].length;
  const points = Math.ceil((len / sampleRate) * pps);
  const peaks = bands.map(() => new Float32Array(points));
  for (let b = 0; b < bands.length; b++) {
    const src = bands[b];
    const out = peaks[b];
    for (let p = 0; p < points; p++) {
      const a = Math.floor((p * sampleRate) / pps);
      const z = Math.min(len, Math.floor(((p + 1) * sampleRate) / pps));
      let m = 0;
      for (let i = a; i < z; i++) { const v = Math.abs(src[i]); if (v > m) m = v; }
      out[p] = m;
    }
  }
  const scaled = peaks.map((arr) => {
    // Scale to the 99.5th percentile so a single spike doesn't flatten the whole band.
    const sorted = Float32Array.from(arr).sort();
    const ref = sorted[Math.floor(sorted.length * 0.995)] || sorted[sorted.length - 1] || 1;
    const u8 = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) u8[i] = Math.min(255, Math.round((arr[i] / ref) * 255));
    return u8;
  });
  return { pps, low: scaled[0], mid: scaled[1], high: scaled[2] };
}

export const FINE_BLOCK = 16; // samples per point of the fine (zoomed-in) waveform: ~2756 points/s

/**
 * Fine waveform for the zoomed-in view: the real signal's min and max (mono mix) every FINE_BLOCK
 * samples, scaled like the bands (99.5th percentile = full height), so the drawn shape is the
 * actual wave, with its asymmetric top and bottom.
 * @param {Float32Array[]} channels 1 or 2 channels
 * @param {number} sampleRate
 * @returns {{pps: number, min: Int8Array, max: Int8Array}}
 */
export function finePeaks(channels, sampleRate, block = FINE_BLOCK) {
  const [l, r = channels[0]] = channels;
  const n = Math.ceil(l.length / block);
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++) {
    let mn = 0; let mx = 0;
    for (const end = Math.min(l.length, i + block); i < end; i++) {
      const v = (l[i] + r[i]) * 0.5;
      if (v < mn) mn = v; else if (v > mx) mx = v;
    }
    lo[p] = mn; hi[p] = mx;
  }
  // Reference level from a subsample of the peaks (sorting all of them is slow on long tracks).
  const stride = Math.max(1, Math.floor(n / 50000));
  const sample = [];
  for (let p = 0; p < n; p += stride) sample.push(Math.max(-lo[p], hi[p]));
  sample.sort((a, b) => a - b);
  const ref = sample[Math.floor(sample.length * 0.995)] || sample[sample.length - 1] || 1;
  const min = new Int8Array(n);
  const max = new Int8Array(n);
  for (let p = 0; p < n; p++) {
    min[p] = Math.max(-127, Math.round((lo[p] / ref) * 127));
    max[p] = Math.min(127, Math.round((hi[p] / ref) * 127));
  }
  return { pps: sampleRate / block, min, max };
}

/** Linear interpolation of a point array at a fractional position (points are centred on their span). */
export function lerpAt(arr, pos) {
  const x = pos - 0.5;
  const i = Math.floor(x);
  if (i < 0) return arr[0] ?? 0;
  if (i >= arr.length - 1) return arr[arr.length - 1] ?? 0;
  const f = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

/**
 * Loudness estimate (RMS in dBFS over blocks above a gate) for auto-gain.
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 */
export function loudnessDb(samples, sampleRate) {
  const block = Math.round(sampleRate * 0.4);
  const values = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += samples[j] * samples[j];
    const db = 10 * Math.log10(s / block + 1e-12);
    if (db > -70) values.push(db);
  }
  if (values.length === 0) return -70;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const gated = values.filter((v) => v > mean - 10);
  const energy = gated.reduce((a, v) => a + 10 ** (v / 10), 0) / gated.length;
  return Math.round(10 * Math.log10(energy) * 10) / 10;
}

/** Base64 encoding that works for large arrays in browsers too. */
export function u8ToBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToU8(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
