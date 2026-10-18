// Key detection: averaged chroma from an STFT, correlated with Krumhansl-Kessler profiles.
import { fft, hann } from './fft.js';

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma; const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Average chroma (C = index 0).
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 */
export function chromagram(samples, sampleRate, { fftSize = 8192, hop = 4096, minHz = 60, maxHz = 2100 } = {}) {
  const chroma = new Float64Array(12);
  const win = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const binHz = sampleRate / fftSize;
  const k0 = Math.max(1, Math.ceil(minHz / binHz));
  const k1 = Math.min(fftSize / 2 - 1, Math.floor(maxHz / binHz));
  const pcOfBin = new Int8Array(k1 + 1);
  for (let k = k0; k <= k1; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const frame = new Float64Array(12);
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    for (let i = 0; i < fftSize; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    frame.fill(0);
    let energy = 0;
    for (let k = k0; k <= k1; k++) {
      const mag = Math.hypot(re[k], im[k]);
      frame[pcOfBin[k]] += mag;
      energy += mag;
    }
    if (energy <= 1e-9) continue;
    // Per-frame normalisation so loud passages don't dominate.
    for (let p = 0; p < 12; p++) chroma[p] += frame[p] / energy;
  }
  return chroma;
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @returns {{tonic: number, mode: 'major'|'minor', confidence: number} | null}
 */
export function detectKey(samples, sampleRate) {
  const chroma = chromagram(samples, sampleRate);
  if (chroma.every((v) => v === 0)) return null;
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    scores.push({ tonic, mode: 'major', r: pearson(rotated, MAJOR) });
    scores.push({ tonic, mode: 'minor', r: pearson(rotated, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const [best, second] = scores;
  return { tonic: best.tonic, mode: best.mode, confidence: Math.round(Math.max(0, best.r - second.r) * 1000) / 1000 };
}
