// Phrase analysis: split a track into musical sections on bar boundaries and label them with
// Rekordbox-style phrase names. Mood "high" (club music): INTRO / UP / CHORUS / DOWN / OUTRO;
// "mid" and "low": INTRO / VERSE / CHORUS / BRIDGE / OUTRO.
import { RealFft, hann } from './fft.js';

export const PHRASE_COLORS = {
  INTRO: '#3d7dff', UP: '#ff9a1f', CHORUS: '#ff3f6c', DOWN: '#25e6d6', OUTRO: '#5b6cff',
  VERSE: '#3fdc5a', BRIDGE: '#a24dff',
};

/**
 * Version of the phrase analysis stored with each track: 2 = 4-bar phrases counted from the bar the
 * music says (1.23.2). Older phrases, not edited by hand, are redone when the track is loaded.
 */
export const PHRASES_VERSION = 2;

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

/**
 * Shift every boundary between phrases by dt seconds (a beat, a bar…): the analysis put the sections
 * a bit off. The first phrase keeps its start and the last its end (no hole at the start of the track,
 * nothing past its end); bar counts follow.
 */
export function shiftPhrases(phrases, dt) {
  if (phrases.length < 2) return phrases;
  const lens = phrases.map((p) => (p.end - p.start) / (p.bars || 1)).sort((a, b) => a - b);
  const bar = lens[lens.length >> 1] || 1;
  const last = phrases.length - 1;
  const moved = phrases.map((p, i) => ({ ...p, start: i === 0 ? p.start : r3(p.start + dt), end: i === last ? p.end : r3(p.end + dt) }))
    .filter((p) => p.end - p.start > bar / 8);
  let startBar = moved[0]?.startBar ?? 0;
  return moved.map((p) => { const bars = Math.max(1, Math.round((p.end - p.start) / bar)); const q = { ...p, bars, startBar }; startBar += bars; return q; });
}

/** Per-beat band powers: overall, low band (kick/bass), high band (hats/air), and FFT frame counts. */
function beatPowers(samples, sampleRate, beatTimes) {
  const fftSize = 2048;
  const win = hann(fftSize);
  const spectrum = new RealFft(fftSize);
  const x = new Float64Array(fftSize);
  const mags = new Float64Array(fftSize / 2);
  const binHz = sampleRate / fftSize;
  return beatTimes.slice(0, -1).map((t0, k) => {
    const a = Math.round(t0 * sampleRate);
    const b = Math.min(samples.length - fftSize, Math.round(beatTimes[k + 1] * sampleRate));
    let all = 0; let low = 0; let high = 0; let frames = 0;
    // a beat can be shorter than two frames: hop by half a frame
    for (let s = a; s < b; s += fftSize / 2) {
      for (let i = 0; i < fftSize; i++) x[i] = samples[s + i] * win[i];
      spectrum.magnitudes(x, mags);
      for (let i = 1; i < fftSize / 2; i++) {
        const e = mags[i] * mags[i];
        const f = i * binHz;
        all += e;
        if (f < 150) low += e;
        else if (f > 3000) high += e;
      }
      frames++;
    }
    return { all, low, high, frames };
  });
}

const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 1; };

/**
 * Sections for one way of counting: bars of 4 beats from beat `p`, phrase boundaries every 4 bars
 * from bar `h`. Returns the sections and how sharp the strongest changes are (the score).
 */
function sections(pow, beatTimes, p, h, period) {
  const nBars = Math.floor((pow.length - p) / 4);
  if (nBars < 8) return null;
  const barStarts = Array.from({ length: nBars + 1 }, (_, j) => beatTimes[p + 4 * j]);
  const feats = Array.from({ length: nBars }, (_, j) => {
    let all = 0, low = 0, high = 0, frames = 0;
    for (let k = p + 4 * j; k < p + 4 * j + 4; k++) { all += pow[k].all; low += pow[k].low; high += pow[k].high; frames += pow[k].frames; }
    const n = frames || 1;
    return { energy: Math.sqrt(all / n), low: Math.sqrt(low / n), high: Math.sqrt(high / n) };
  });
  const eRef = pct(feats.map((f) => f.energy), 0.95);
  const lRef = pct(feats.map((f) => f.low), 0.95);
  const hRef = pct(feats.map((f) => f.high), 0.95);
  const vec = feats.map((f) => [f.energy / eRef, f.low / lRef, f.high / hRef]);

  // Novelty at each 4-bar boundary: distance between the 4 bars before and after.
  const mean = (a, b) => { const m = [0, 0, 0]; for (let k = a; k < b; k++) for (let j = 0; j < 3; j++) m[j] += vec[k][j] / (b - a); return m; };
  const novelty = new Array(nBars + 1).fill(0);
  const cands = [];
  for (let k = 4; k <= nBars - 4; k++) {
    if ((k - h) % 4 !== 0) continue;
    const x = mean(k - 4, k); const y = mean(k, k + 4);
    novelty[k] = Math.hypot(x[0] - y[0], 1.5 * (x[1] - y[1]), x[2] - y[2]) * ((k - h) % 8 === 0 ? 1.15 : 1);
    cands.push(k);
  }
  if (!cands.length) return null;
  const vals = cands.map((k) => novelty[k]);
  // the sharpest changes (drops, breaks) are sharpest when the boundaries sit right on them
  const top = [...vals].sort((a, b) => b - a).slice(0, Math.max(2, Math.ceil(vals.length / 3)));
  const score = top.reduce((a, b) => a + b, 0) / top.length;
  const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length);
  const thr = Math.max(0.12, mu + 0.25 * sd);
  const bounds = [0];
  for (const k of cands) {
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
  const avgBpm = 60 / period;
  const mood = kickBars > 0.55 && avgBpm >= 110 ? 'high' : avgBpm < 95 && mu < 0.2 ? 'low' : 'mid';

  const eMax = Math.max(...segs.map((s) => s.energy));
  const labelOf = (s, idx) => {
    if (idx === segs.length - 1 && segs.length > 1) return 'OUTRO';
    if (idx === 0 && s.energy < 0.85 * eMax) return 'INTRO';
    if (s.low < 0.35) return mood === 'high' ? 'DOWN' : 'BRIDGE';
    if (s.energy >= 0.85 * eMax) return 'CHORUS';
    if (mood === 'high') return 'UP';
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
  return { mood, phrases, score };
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {import('../beatgrid.js').Beatgrid} grid with downbeat info
 * @param {number} duration seconds
 * @returns {{mood: 'high'|'mid'|'low', phrases: {start: number, end: number, startBar: number, bars: number, label: string, num: number}[], barOffset?: number}}
 */
export function analyzePhrases(samples, sampleRate, grid, duration) {
  // Every beat from the first one at or after 0 (a beat a few ms before 0, grid rounding, counts).
  const b0 = Math.ceil(grid.indexAt(-0.05));
  const beatTimes = [];
  for (let i = b0; grid.timeOf(i + 1) <= duration + 0.05; i++) beatTimes.push(Math.max(0, grid.timeOf(i)));
  beatTimes.push(grid.timeOf(b0 + beatTimes.length));
  if (beatTimes.length - 1 < 35) return { mood: 'mid', phrases: [] };
  const pow = beatPowers(samples, sampleRate, beatTimes);

  // Bars start on the grid's downbeats. Which bar the 4-bar phrases count from is decided by the
  // music: counting from the very first bar put the phrases a bar (4 beats) early on many tracks
  // (measured on 40 club tracks: boundaries on the change 24 % → 38 %, the "a bar early" ones
  // halved). Try the 4 starting bars and keep the one whose strongest changes are sharpest.
  let gp = 0;
  while (gp < 4 && !grid.isDownbeat(b0 + gp)) gp++;
  gp %= 4;
  let best = null;
  for (let h = 0; h < 4; h++) {
    const res = sections(pow, beatTimes, gp, h, grid.period);
    if (!res) continue;
    const score = res.score * (h === 0 ? 1.02 : 1);
    if (!best || score > best.score + 1e-9) best = { ...res, score, barOffset: h };
  }
  return best ? { mood: best.mood, phrases: best.phrases, barOffset: best.barOffset } : { mood: 'mid', phrases: [] };
}
