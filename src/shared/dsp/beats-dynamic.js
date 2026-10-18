// Dynamic beat tracking (variable tempo) and downbeat detection.
//
// Beats: dynamic programming over an onset envelope (Ellis 2007): each frame's score is its
// onset strength plus the best previous beat's score, penalised by how far the interval
// deviates (log-ratio) from the local beat period. The local period comes from windowed
// autocorrelation around the global tempo, so gradual tempo changes are followed.
import { onsetEnvelope, detrend } from './onset.js';
import { fft, hann } from './fft.js';

function normalise(a) {
  let m = 0; let s = 0;
  for (const v of a) { m += v; }
  m /= a.length || 1;
  for (const v of a) s += (v - m) ** 2;
  const sd = Math.sqrt(s / (a.length || 1)) || 1;
  return Float32Array.from(a, (v) => v / sd);
}

/** Local beat period (frames) every `hop` frames, searched within ±maxDev of p0. */
function localPeriods(env, rate, p0, { winSec = 8, hopSec = 1, maxDev = 0.15 } = {}) {
  const win = Math.round(winSec * rate);
  const hop = Math.round(hopSec * rate);
  const lo = Math.floor(p0 * (1 - maxDev)); const hi = Math.ceil(p0 * (1 + maxDev));
  const centres = []; const periods = [];
  for (let c = 0; c < env.length; c += hop) {
    const a = Math.max(0, c - win / 2); const b = Math.min(env.length, c + win / 2);
    let best = p0; let bestV = -Infinity;
    const ac = new Float64Array(hi + 2);
    for (let lag = lo - 1; lag <= hi + 1; lag++) {
      let s = 0;
      for (let i = a + lag; i < b; i++) s += env[i] * env[i - lag];
      ac[lag] = s;
    }
    for (let lag = lo; lag <= hi; lag++) {
      // Prefer the global period slightly to avoid locking to noise.
      const v = ac[lag] * (1 - 0.3 * Math.abs(lag - p0) / p0);
      if (v > bestV) { bestV = v; best = lag; }
    }
    // Parabolic refinement.
    const y0 = ac[best - 1]; const y1 = ac[best]; const y2 = ac[best + 1];
    const d = y0 - 2 * y1 + y2;
    centres.push(c);
    periods.push(best + (d < 0 ? (0.5 * (y0 - y2)) / d : 0));
  }
  // Median smoothing (5 points) to reject outliers.
  const smooth = periods.map((_, i) => {
    const w = periods.slice(Math.max(0, i - 2), i + 3).sort((x, y) => x - y);
    return w[w.length >> 1];
  });
  return (frame) => {
    const k = Math.min(smooth.length - 1, Math.max(0, Math.round(frame / hop)));
    return smooth[k];
  };
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {number} bpm global tempo (from detectBeats)
 * @returns {number[]} beat times in seconds
 */
export function trackBeatsDynamic(samples, sampleRate, bpm, { tightness = 100 } = {}) {
  const { env: raw, low: rawLow, rate, offsetSec } = onsetEnvelope(samples, sampleRate);
  const full = normalise(detrend(raw, rate));
  const low = normalise(detrend(rawLow, rate));
  const env = Float32Array.from(full, (v, i) => low[i] + 0.25 * v);
  const p0 = (rate * 60) / bpm;
  const periodAt = localPeriods(env, rate, p0);
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const p = periodAt(t);
    const from = Math.max(0, Math.round(t - 2 * p));
    const to = Math.round(t - p / 2);
    let best = 0; let arg = -1;
    for (let prev = from; prev <= to; prev++) {
      const dev = Math.log((t - prev) / p);
      const v = score[prev] - tightness * dev * dev;
      if (arg < 0 || v > best) { best = v; arg = prev; }
    }
    score[t] = env[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // Start from the best-scoring frame within the last beat period.
  const lastP = periodAt(n - 1);
  let t = n - 1;
  for (let i = Math.max(0, Math.round(n - lastP)); i < n; i++) if (score[i] > score[t]) t = i;
  const frames = [];
  while (t >= 0) { frames.push(t); t = back[t]; }
  frames.reverse();
  const times = frames.map((f) => f / rate + offsetSec);
  return smoothBeats(times);
}

/** Local linear fit (±4 beats) to remove frame-quantisation jitter while keeping tempo drift. */
export function smoothBeats(times, half = 4) {
  const n = times.length;
  return times.map((_, i) => {
    const a = Math.max(0, i - half); const b = Math.min(n - 1, i + half);
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let k = 0;
    for (let j = a; j <= b; j++) { sx += j; sy += times[j]; sxx += j * j; sxy += j * times[j]; k++; }
    const den = k * sxx - sx * sx;
    if (den === 0) return times[i];
    const slope = (k * sxy - sx * sy) / den;
    const icpt = (sy - slope * sx) / k;
    return Math.round((icpt + slope * i) * 1000) / 1000;
  });
}

/** True when beat intervals are steady enough that a constant grid is the better choice. */
export function isSteadyTempo(times, maxRelStd = 0.006) {
  if (times.length < 8) return true;
  const iv = [];
  for (let i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
  // Compare tempo in the first and last quarters rather than per-beat jitter.
  const q = Math.max(4, Math.floor(iv.length / 4));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const first = mean(iv.slice(0, q)); const last = mean(iv.slice(-q)); const all = mean(iv);
  return Math.abs(first - last) / all < maxRelStd * 2 && Math.abs(Math.max(...iv.slice(q, -q)) - all) / all < 0.08;
}

/**
 * Downbeat detection: which of the 4 beat positions starts the bar. Bars tend to begin
 * where harmony changes, energy rises and the kick is strongest.
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {(i: number) => number} beatTime time of beat i (s)
 * @param {number} beatCount
 * @returns {number} beat number (1..4) of beat index 0 inside its bar
 */
export function detectDownbeat(samples, sampleRate, beatTime, beatCount) {
  const fftSize = 4096;
  const win = hann(fftSize);
  const re = new Float64Array(fftSize); const im = new Float64Array(fftSize);
  const binHz = sampleRate / fftSize;
  const chroma = []; const lowE = []; const energy = [];
  for (let i = 0; i < beatCount; i++) {
    const t = beatTime(i);
    const start = Math.round(t * sampleRate);
    if (start < 0 || start + fftSize > samples.length) { chroma.push(null); lowE.push(0); energy.push(0); continue; }
    for (let k = 0; k < fftSize; k++) { re[k] = samples[start + k] * win[k]; im[k] = 0; }
    fft(re, im);
    const c = new Float64Array(12);
    let lo = 0; let all = 0;
    for (let k = 1; k < fftSize / 2; k++) {
      const f = k * binHz;
      const mag = Math.hypot(re[k], im[k]);
      all += mag * mag;
      if (f < 150) lo += mag * mag;
      if (f >= 60 && f <= 2000) c[((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12] += mag;
    }
    const norm = Math.hypot(...c) || 1;
    chroma.push(Array.from(c, (v) => v / norm));
    lowE.push(Math.sqrt(lo)); energy.push(Math.sqrt(all));
  }
  const maxLow = Math.max(...lowE) || 1; const maxE = Math.max(...energy) || 1;
  const score = [0, 0, 0, 0];
  for (let i = 1; i < beatCount; i++) {
    const a = chroma[i - 1]; const b = chroma[i];
    const change = a && b ? 1 - a.reduce((s, v, k) => s + v * b[k], 0) : 0;
    const rise = Math.max(0, energy[i] - energy[i - 1]) / maxE;
    score[i % 4] += 2 * change + 0.5 * (lowE[i] / maxLow) + rise;
  }
  // Section changes (4 beats before vs after) almost always land on bar starts.
  const mean = (a, b) => { let s = 0; for (let j = a; j < b; j++) s += energy[j]; return s / (b - a); };
  const novelty = [];
  for (let i = 4; i <= beatCount - 4; i++) novelty[i] = Math.abs(mean(i, i + 4) - mean(i - 4, i)) / maxE;
  const nv = novelty.filter((v) => v !== undefined).sort((x, y) => x - y);
  const strong = nv[Math.floor(nv.length * 0.9)] ?? Infinity;
  for (let i = 4; i <= beatCount - 4; i++) {
    const isPeak = novelty[i] >= strong && novelty[i] >= (novelty[i - 1] ?? 0) && novelty[i] >= (novelty[i + 1] ?? 0);
    if (isPeak) score[i % 4] += 8 * novelty[i];
  }
  // Without clear evidence, keep the first analysed beat as a downbeat.
  score[0] *= 1.05;
  const k = score.indexOf(Math.max(...score)); // beats with index ≡ k (mod 4) are downbeats
  return ((((0 - k) % 4) + 4) % 4) + 1;
}
