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
