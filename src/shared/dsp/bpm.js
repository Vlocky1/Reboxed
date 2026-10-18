// Tempo + beat-phase detection: spectral-flux onsets, autocorrelation for a coarse tempo,
// then a comb search over the whole track for a precise BPM and the first-beat offset.
import { onsetEnvelope, detrend } from './onset.js';

/**
 * @typedef {object} BeatAnalysis
 * @property {number} bpm          rounded to 0.01
 * @property {number} firstBeat    seconds, first beat >= 0
 * @property {number} confidence   0..1
 */

/** Linear-interpolated read. */
function at(env, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  const f = x - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

/** Best phase and its score for a given period (in envelope frames). */
function combScore(env, period, phaseSteps) {
  let best = -1;
  let bestPhase = 0;
  let total = 0;
  for (let s = 0; s < phaseSteps; s++) {
    const phase = (s / phaseSteps) * period;
    let score = 0;
    for (let x = phase; x < env.length - 1; x += period) score += at(env, x);
    total += score;
    if (score > best) { best = score; bestPhase = phase; }
  }
  return { score: best, phase: bestPhase, mean: total / phaseSteps };
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {{minBpm?: number, maxBpm?: number}} [opts] fold range (Rekordbox lets users pick one)
 * @returns {BeatAnalysis}
 */
export function detectBeats(samples, sampleRate, { minBpm = 78, maxBpm = 156 } = {}) {
  const { env: raw, low: rawLow, rate, offsetSec } = onsetEnvelope(samples, sampleRate);
  const env = detrend(raw, rate);
  if (env.length < rate * 4) return { bpm: 0, firstBeat: 0, confidence: 0 };

  // 1. Coarse tempo: autocorrelation over 50..220 BPM with a mild preference around 120.
  const minLag = Math.floor((rate * 60) / 220);
  const maxLag = Math.ceil((rate * 60) / 50);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    const bpm = (rate * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    // Reward lags whose double is also periodic (bar-level reinforcement).
    const v = (ac[lag] + 0.5 * (ac[lag * 2] ?? 0)) * prior;
    if (v > bestVal && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { bestVal = v; bestLag = lag; }
  }
  // Parabolic refinement of the peak.
  const y0 = ac[bestLag - 1]; const y1 = ac[bestLag]; const y2 = ac[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const lag = bestLag + (denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0);
  let coarse = (rate * 60) / lag;
  while (coarse < minBpm) coarse *= 2;
  while (coarse > maxBpm) coarse /= 2;

  // 2. Fine tempo: comb search +-4% in 0.01 BPM steps (coarse pass 0.05, then 0.01).
  const search = (lo, hi, step, phaseSteps) => {
    let best = { bpm: coarse, score: -1, phase: 0, mean: 0 };
    for (let b = lo; b <= hi + 1e-9; b += step) {
      const r = combScore(env, (rate * 60) / b, phaseSteps);
      if (r.score > best.score) best = { bpm: b, ...r };
    }
    return best;
  };
  let best = search(coarse * 0.96, coarse * 1.04, 0.05, 24);
  best = search(best.bpm - 0.06, best.bpm + 0.06, 0.01, 48);

  let bpm = Math.round(best.bpm * 100) / 100;
  const offInteger = Math.abs(bpm - Math.round(bpm));
  if (offInteger <= 0.05) {
    // Most club music sits on an integer BPM: snap when within 0.03, or up to 0.05 if the comb agrees.
    const integer = combScore(env, (rate * 60) / Math.round(bpm), 48);
    if (offInteger <= 0.03 || integer.score >= best.score * 0.985) { bpm = Math.round(bpm); best = { ...best, ...integer }; }
  }

  // 3. Beat phase: the kick (low-band attacks) marks the beat; the full band breaks ties
  //    when a track has no low end.
  const lowEnv = detrend(rawLow, rate);
  const norm = (a) => { let m = 0; for (const v of a) m = Math.max(m, v); return m || 1; };
  const lowScale = 1 / norm(lowEnv);
  const fullScale = 0.25 / norm(env);
  const phaseEnv = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) phaseEnv[i] = lowEnv[i] * lowScale + env[i] * fullScale;
  const period = (rate * 60) / bpm;
  const phase = combScore(phaseEnv, period, Math.ceil(period * 2)).phase;

  const periodSec = 60 / bpm;
  let firstBeat = phase / rate + offsetSec;
  firstBeat -= Math.floor(firstBeat / periodSec) * periodSec;
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, 1 - best.mean / best.score)) : 0;
  return { bpm, firstBeat: Math.round(firstBeat * 1000) / 1000, confidence: Math.round(confidence * 100) / 100 };
}
