import { fft, hann } from './fft.js';

/** Position of a detected attack within the analysis window (fraction of fftSize), calibrated on synthetic drums. */
export const ONSET_LAG = 0.8;

/**
 * Spectral-flux onset envelope (log-compressed magnitudes, half-wave rectified difference).
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * Also returns a low-band (< lowHz) flux, which follows the kick drum and is used for beat phase.
 * @param {{fftSize?: number, hop?: number, lowHz?: number}} [opts]
 * @returns {{env: Float32Array, low: Float32Array, rate: number, offsetSec: number}}
 *   offsetSec = time of the onset that peaks at frame 0
 */
export function onsetEnvelope(samples, sampleRate, { fftSize = 512, hop = 64, lowHz = 160 } = {}) {
  const frames = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  const lowBins = Math.max(2, Math.round((lowHz * fftSize) / sampleRate));
  const win = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const bins = fftSize / 2;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) { flux += d; if (k <= lowBins) lowFlux += d; }
    }
    env[f] = f === 0 ? 0 : flux;
    low[f] = f === 0 ? 0 : lowFlux;
    [prev, cur] = [cur, prev];
  }
  // Log-compressed flux peaks as soon as an attack enters the window, i.e. near its end.
  return { env, low, rate: sampleRate / hop, offsetSec: (fftSize * ONSET_LAG) / sampleRate };
}

/** Subtract a moving average and half-wave rectify (in place). */
export function detrend(env, rate, windowSec = 0.5) {
  const w = Math.max(1, Math.round(windowSec * rate));
  const out = new Float32Array(env.length);
  let sum = 0;
  const half = Math.floor(w / 2);
  // Prefix sums for a centred moving average.
  const prefix = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) prefix[i + 1] = prefix[i] + env[i];
  for (let i = 0; i < env.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(env.length, i + half + 1);
    sum = (prefix[b] - prefix[a]) / (b - a);
    out[i] = Math.max(0, env[i] - sum);
  }
  return out;
}
