// Phrase analysis: split a track into musical sections on bar boundaries and label them with
// Rekordbox-style phrase names. Mood "high" (club music): INTRO / UP / CHORUS / DOWN / OUTRO;
// "mid" and "low": INTRO / VERSE / CHORUS / BRIDGE / OUTRO.
import { fft, hann } from './fft.js';

export const PHRASE_COLORS = {
  INTRO: '#3d7dff', UP: '#ff9a1f', CHORUS: '#ff3f6c', DOWN: '#25e6d6', OUTRO: '#5b6cff',
  VERSE: '#3fdc5a', BRIDGE: '#a24dff',
};

/** Every phrase type, in the order the editing menu shows them. */
export const PHRASE_LABELS = ['INTRO', 'UP', 'VERSE', 'CHORUS', 'BRIDGE', 'DOWN', 'OUTRO'];

/** Number the phrases of each type in order (CHORUS 1, CHORUS 2…), as the analysis does. */
export function renumberPhrases(phrases) {
  const counts = {};
  return phrases.map((p) => { counts[p.label] = (counts[p.label] ?? 0) + 1; return { ...p, num: counts[p.label] }; });
}

/** Index of the phrase playing at time t, or -1. */
export const phraseAt = (phrases, t) => phrases.findIndex((p) => t >= p.start && t < p.end);

/** Give phrase i another type (hand correction). */
export function relabelPhrase(phrases, i, label) {
  return renumberPhrases(phrases.map((p, k) => (k === i ? { ...p, label } : p)));
}

/**
 * Cut phrase i in two at the bar nearest to time t (the second half keeps its type). Unchanged if
 * the cut would leave an empty part.
 */
export function splitPhrase(phrases, i, t) {
  const p = phrases[i];
  if (!p || !(p.bars > 1)) return phrases;
  const barLen = (p.end - p.start) / p.bars;
  const k = Math.round((t - p.start) / barLen);
  if (k <= 0 || k >= p.bars) return phrases;
  const cut = Math.round((p.start + k * barLen) * 1000) / 1000;
  const a = { ...p, end: cut, bars: k };
  const b = { ...p, start: cut, startBar: p.startBar + k, bars: p.bars - k };
  return renumberPhrases([...phrases.slice(0, i), a, b, ...phrases.slice(i + 1)]);
}

/** Join phrase i with the next one (the first one's type is kept). */
export function mergePhrase(phrases, i) {
  const a = phrases[i]; const b = phrases[i + 1];
  if (!a || !b) return phrases;
  return renumberPhrases([...phrases.slice(0, i), { ...a, end: b.end, bars: a.bars + b.bars }, ...phrases.slice(i + 2)]);
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Move the start of phrase i to time t (the previous phrase ends there). Bar counts follow the
 * phrases' own bar length. Unchanged when t would leave a phrase shorter than a beat.
 */
export function moveBoundary(phrases, i, t) {
  const p = phrases[i]; const prev = phrases[i - 1];
  if (!p || !prev) return phrases;
  const barOf = (x) => (x.end - x.start) / (x.bars || 1);
  if (t <= prev.start + barOf(prev) / 4 || t >= p.end - barOf(p) / 4) return phrases;
  const a = { ...prev, end: r3(t), bars: Math.max(1, Math.round((t - prev.start) / barOf(prev))) };
  const b = { ...p, start: r3(t), bars: Math.max(1, Math.round((p.end - t) / barOf(p))), startBar: a.startBar + a.bars };
  return [...phrases.slice(0, i - 1), a, b, ...phrases.slice(i + 1)];
}

/** Shift every phrase by dt seconds (a beat, a bar…): the analysis put the sections a bit off. */
export function shiftPhrases(phrases, dt) {
  return phrases.map((p) => ({ ...p, start: r3(Math.max(0, p.start + dt)), end: r3(Math.max(0, p.end + dt)) })).filter((p) => p.end > p.start);
}

/** Per-bar features: overall energy, low band (kick/bass), high band (hats/air). */
function barFeatures(samples, sampleRate, barStarts) {
  const fftSize = 2048;
  const win = hann(fftSize);
  const re = new Float64Array(fftSize); const im = new Float64Array(fftSize);
  const binHz = sampleRate / fftSize;
  return barStarts.slice(0, -1).map((t0, k) => {
    const a = Math.round(t0 * sampleRate);
    const b = Math.min(samples.length - fftSize, Math.round(barStarts[k + 1] * sampleRate));
    let all = 0; let low = 0; let high = 0; let frames = 0;
    for (let s = a; s < b; s += fftSize) {
      for (let i = 0; i < fftSize; i++) { re[i] = samples[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let i = 1; i < fftSize / 2; i++) {
        const e = re[i] * re[i] + im[i] * im[i];
        const f = i * binHz;
        all += e;
        if (f < 150) low += e;
        else if (f > 3000) high += e;
      }
      frames++;
    }
    const n = frames || 1;
    return { energy: Math.sqrt(all / n), low: Math.sqrt(low / n), high: Math.sqrt(high / n) };
  });
}

const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 1; };

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {import('../beatgrid.js').Beatgrid} grid with downbeat info
 * @param {number} duration seconds
 * @returns {{mood: 'high'|'mid'|'low', phrases: {start: number, end: number, startBar: number, bars: number, label: string, num: number}[]}}
 */
export function analyzePhrases(samples, sampleRate, grid, duration) {
  // Bar starts from the first downbeat at or after 0.
  // A bar starting a few ms before 0 (grid rounding) is still the first bar.
  let i0 = Math.ceil(grid.indexAt(-0.05));
  while (!grid.isDownbeat(i0)) i0++;
  // Complete bars only: a trailing partial bar would just be tail/silence.
  const barStarts = [];
  for (let i = i0; grid.timeOf(i + 4) <= duration + 0.05; i += 4) barStarts.push(Math.max(0, grid.timeOf(i)));
  barStarts.push(grid.timeOf(i0 + 4 * barStarts.length));
  const nBars = barStarts.length - 1;
  if (nBars < 8) return { mood: 'mid', phrases: [] };

  const feats = barFeatures(samples, sampleRate, barStarts);
  const eRef = pct(feats.map((f) => f.energy), 0.95);
  const lRef = pct(feats.map((f) => f.low), 0.95);
  const hRef = pct(feats.map((f) => f.high), 0.95);
  const vec = feats.map((f) => [f.energy / eRef, f.low / lRef, f.high / hRef]);

  // Novelty at each 4-bar boundary: distance between the 4 bars before and after.
  const mean = (a, b) => { const m = [0, 0, 0]; for (let k = a; k < b; k++) for (let j = 0; j < 3; j++) m[j] += vec[k][j] / (b - a); return m; };
  const novelty = new Array(nBars + 1).fill(0);
  for (let k = 4; k <= nBars - 4; k += 4) {
    const x = mean(k - 4, k); const y = mean(k, k + 4);
    novelty[k] = Math.hypot(x[0] - y[0], 1.5 * (x[1] - y[1]), x[2] - y[2]) * (k % 8 === 0 ? 1.15 : 1);
  }
  const vals = novelty.filter((v) => v > 0);
  const mu = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / (vals.length || 1));
  const thr = Math.max(0.12, mu + 0.25 * sd);
  const bounds = [0];
  for (let k = 4; k <= nBars - 4; k += 4) {
    const peak = novelty[k] >= thr && novelty[k] >= (novelty[k - 4] ?? 0) && novelty[k] >= (novelty[k + 4] ?? 0);
    if (peak && k - bounds.at(-1) >= 8) bounds.push(k);
  }
  if (nBars - bounds.at(-1) < 4 && bounds.length > 1) bounds.pop();
  bounds.push(nBars);

  const segs = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const m = mean(bounds[s], bounds[s + 1]);
    segs.push({ startBar: bounds[s], bars: bounds[s + 1] - bounds[s], energy: m[0], low: m[1], high: m[2] });
  }

  // Mood: club music keeps a steady kick in most bars and sits at a dance tempo.
  const kickBars = vec.filter((v) => v[1] > 0.45).length / nBars;
  const avgBpm = 60 / grid.period;
  const mood = kickBars > 0.55 && avgBpm >= 110 ? 'high' : avgBpm < 95 && mu < 0.2 ? 'low' : 'mid';

  const eMax = Math.max(...segs.map((s) => s.energy));
  const labelOf = (s, idx) => {
    if (idx === segs.length - 1 && segs.length > 1) return 'OUTRO';
    if (idx === 0 && s.energy < 0.85 * eMax) return 'INTRO';
    if (s.low < 0.35) return mood === 'high' ? 'DOWN' : 'BRIDGE';
    if (s.energy >= 0.85 * eMax) return 'CHORUS';
    const next = segs[idx + 1];
    if (mood === 'high') return next && next.energy >= 0.85 * eMax ? 'UP' : 'UP';
    return 'VERSE';
  };
  const counts = {};
  const phrases = segs.map((s, idx) => {
    const label = labelOf(s, idx);
    counts[label] = (counts[label] ?? 0) + 1;
    return {
      start: Math.round(barStarts[s.startBar] * 1000) / 1000,
      end: Math.round(barStarts[s.startBar + s.bars] * 1000) / 1000,
      startBar: s.startBar, bars: s.bars, label, num: counts[label],
    };
  });
  return { mood, phrases };
}
