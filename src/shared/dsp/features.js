// Compact audio "fingerprint" for track suggestions (sound-alike, not metadata):
// 12 chroma bins + brightness + energy + low/high balance + onset density + dynamics.
import { RealFft, hann } from './fft.js';
import { chromagram } from './key.js';
import { onsetEnvelope } from './onset.js';

export const FEATURE_DIM = 18;

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {number} bpm
 * @param {{chroma?: Float64Array, onset?: object}} [known] these samples' chromagram and onset
 *   envelope (onsetEnvelope), when they are already computed
 * @returns {number[]} FEATURE_DIM values, roughly in 0..1
 */
export function audioFeatures(samples, sampleRate, bpm, { chroma = chromagram(samples, sampleRate), onset = null } = {}) {
  const cn = Math.hypot(...chroma) || 1;
  const fftSize = 2048;
  const win = hann(fftSize);
  const spectrum = new RealFft(fftSize);
  const x = new Float64Array(fftSize);
  const mags = new Float64Array(fftSize / 2);
  const binHz = sampleRate / fftSize;
  let cSum = 0; let wSum = 0; let low = 0; let high = 0; let all = 0;
  const rmsFrames = [];
  const step = Math.max(fftSize, Math.floor(samples.length / 400));
  for (let s = 0; s + fftSize <= samples.length; s += step) {
    let fr = 0;
    for (let i = 0; i < fftSize; i++) { const v = samples[s + i]; x[i] = v * win[i]; fr += v * v; }
    rmsFrames.push(Math.sqrt(fr / fftSize));
    spectrum.magnitudes(x, mags);
    for (let k = 1; k < fftSize / 2; k++) {
      const m = mags[k];
      const f = k * binHz;
      cSum += f * m; wSum += m; all += m * m;
      if (f < 150) low += m * m; else if (f > 3000) high += m * m;
    }
  }
  const centroid = wSum ? cSum / wSum : 0;
  const rms = rmsFrames.reduce((a, b) => a + b, 0) / (rmsFrames.length || 1);
  const sorted = [...rmsFrames].sort((a, b) => a - b);
  const dyn = sorted.length ? (sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.1)]) / (sorted.at(-1) || 1) : 0;
  // The first minute's attacks: the same frames as the whole track's envelope.
  const first = samples.length > sampleRate * 60 ? samples.subarray(0, sampleRate * 60) : samples;
  const { env, rate } = onset
    ? { env: onset.env.subarray(0, Math.max(0, Math.floor((first.length - onset.fftSize) / onset.hop) + 1)), rate: onset.rate }
    : onsetEnvelope(first, sampleRate);
  const meanEnv = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  let peaks = 0;
  for (let i = 1; i < env.length - 1; i++) if (env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > 1.5 * meanEnv) peaks++;
  const onsetsPerBeat = bpm > 0 ? peaks / ((env.length / rate) * (bpm / 60)) : 0;
  return [
    ...Array.from(chroma, (v) => v / cn),
    Math.min(1, Math.log2(1 + centroid) / 12),
    Math.min(1, rms * 4),
    all ? low / all : 0,
    all ? Math.min(1, (high / all) * 4) : 0,
    Math.min(1, onsetsPerBeat / 4),
    Math.min(1, dyn),
  ].map((v) => Math.round(v * 1000) / 1000);
}

const WEIGHTS = [...new Array(12).fill(0.6), 1.5, 1, 1.5, 1.2, 1.2, 0.8];

/** Weighted cosine similarity in 0..1. */
export function featureSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const w = WEIGHTS[i] ?? 1;
    dot += w * a[i] * b[i]; na += w * a[i] * a[i]; nb += w * b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Rank tracks by sound similarity to the seed, gently favouring compatible tempo.
 * @param {{track: object, features: number[]}[]} candidates
 */
export function suggest(seed, seedFeatures, candidates, limit = 50) {
  return candidates
    .filter((c) => c.track.id !== seed.id && c.features)
    .map((c) => {
      let s = featureSimilarity(seedFeatures, c.features);
      if (seed.bpm && c.track.bpm) {
        const r = Math.abs(Math.log2(c.track.bpm / seed.bpm));
        s -= 0.15 * Math.min(1, Math.min(r, Math.abs(r - 1)) / 0.1);
      }
      return { track: c.track, score: s };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
