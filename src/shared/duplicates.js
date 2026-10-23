// Duplicate finder: the same music twice in a playlist or the collection (another file, another
// format, another name, another edit). Metadata only proposes pairs; the decision comes from the
// audio: the energy curves of the two tracks (low / mid / high bands, from the analysis) slid
// against each other. The same recording lines up almost perfectly, whatever its level or format;
// another edit lines up over a long stretch; a remix with the same name does not.
import { similarity, artistSimilarity, splitMix, norm } from './autotag.js';
import { featureSimilarity } from './dsp/features.js';

/** Points per second of the curves compared (enough to tell recordings apart, cheap to slide). */
export const ENV_PPS = 1;

/** Title without the mix name or the featured artist, for comparing names. */
const baseTitle = (t) => norm(splitMix(t ?? '').title.replace(/\s*[([]\s*(?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, ''));

/** How much the names say "same track" (0..1). */
export function metaSimilarity(a, b) {
  const title = similarity(baseTitle(a.title), baseTitle(b.title));
  const artist = a.artist && b.artist ? artistSimilarity(a.artist, b.artist) : 0.6;
  return Math.round((0.65 * title + 0.35 * artist) * 100) / 100;
}

const tempoClose = (a, b) => {
  if (!a || !b) return true;
  const r = Math.abs(Math.log2(a / b));
  return Math.min(r, Math.abs(r - 1)) < 0.03; // same, or half / double time
};

/**
 * Pairs worth an audio check: similar names, or the same sound fingerprint at the same tempo.
 * @param {object[]} tracks
 * @returns {[object, object, number][]} [a, b, metaSimilarity]
 */
export function candidatePairs(tracks) {
  const out = [];
  const meta = tracks.map((t) => ({ t, title: baseTitle(t.title) }));
  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      const a = meta[i].t; const b = meta[j].t;
      if (a.id === b.id) continue;
      const titleSim = similarity(meta[i].title, meta[j].title);
      const m = titleSim > 0.75 ? metaSimilarity(a, b) : 0;
      const sound = a.features && b.features && tempoClose(a.bpm, b.bpm) ? featureSimilarity(a.features, b.features) : 0;
      if (m >= 0.75 || sound >= 0.985) out.push([a, b, m]);
    }
  }
  return out;
}

/**
 * Energy curves at ENV_PPS from the stored analysis waveform ({pps, low, mid, high} as Uint8Arrays).
 * @returns {Float32Array[]} [low, mid, high]
 */
export function energyCurves(wf) {
  const step = Math.max(1, Math.round(wf.pps / ENV_PPS));
  return [wf.low, wf.mid, wf.high].map((band) => {
    const n = Math.floor(band.length / step);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) { let s = 0; for (let i = k * step; i < (k + 1) * step; i++) s += band[i]; out[k] = s / step; }
    return out;
  });
}

const BAND_W = [0.4, 0.35, 0.25];

/** Pearson correlation of a[i] and b[i + lag] over their overlap. */
function corrAt(a, b, lag) {
  const i0 = Math.max(0, -lag); const i1 = Math.min(a.length, b.length - lag);
  const n = i1 - i0;
  if (n < 3) return { r: 0, n: 0 };
  let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
  for (let i = i0; i < i1; i++) { const x = a[i]; const y = b[i + lag]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
  const va = saa - (sa * sa) / n; const vb = sbb - (sb * sb) / n;
  return { r: va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0, n };
}

/**
 * Do two tracks hold the same audio? The curves are slid against each other; the best alignment
 * over at least 40 s (or 60 % of the shorter track) counts.
 * @param {Float32Array[]} A curves of track a
 * @param {Float32Array[]} B curves of track b
 * @returns {{score: number, lag: number, overlap: number}} score 0..1, lag in seconds (b vs a)
 */
export function audioSimilarity(A, B) {
  const na = A[0].length; const nb = B[0].length;
  const minOverlap = Math.max(10, Math.min(40 * ENV_PPS, Math.floor(0.6 * Math.min(na, nb))));
  let best = { score: 0, lag: 0, overlap: 0 };
  for (let lag = -(na - minOverlap); lag <= nb - minOverlap; lag++) {
    let s = 0; let n = 0;
    for (let k = 0; k < 3; k++) { const c = corrAt(A[k], B[k], lag); s += BAND_W[k] * c.r; n = c.n; }
    if (n >= minOverlap && s > best.score) best = { score: s, lag: lag / ENV_PPS, overlap: n / ENV_PPS };
  }
  return { ...best, score: Math.max(0, Math.round(best.score * 1000) / 1000) };
}

/**
 * What a pair is. audio: audioSimilarity result or null (not analysed).
 * @returns {{kind: 'same'|'edit'|'renamed'|'version'|'name', label: string, score: number, duplicate: boolean}}
 */
export function verdict(a, b, meta, audio) {
  const dd = Math.abs((a.duration ?? 0) - (b.duration ?? 0));
  if (!audio) {
    // Not analysed: only the names and the length can tell.
    const sure = meta >= 0.9 && dd < 2;
    return { kind: 'name', label: sure ? 'Same name and length (not analysed)' : 'Similar name (not analysed)', score: Math.round(meta * (sure ? 0.9 : 0.6) * 100), duplicate: sure };
  }
  const s = audio.score;
  if (s >= 0.9 && dd < 3) return { kind: meta >= 0.6 ? 'same' : 'renamed', label: meta >= 0.6 ? 'Same recording' : 'Same recording, another name', score: Math.round((0.75 * s + 0.25 * Math.max(meta, 0.8)) * 100), duplicate: true };
  if (s >= 0.82) return { kind: 'edit', label: `Same track, another edit (${dd >= 1 ? `${Math.round(dd)} s ${b.duration > a.duration ? 'longer' : 'shorter'}` : 'shifted'})`, score: Math.round((0.75 * s + 0.25 * meta) * 100), duplicate: true };
  return { kind: 'version', label: 'Same name, different audio (remix / other version)', score: Math.round(s * 60), duplicate: false };
}

/** Groups of tracks linked by duplicate pairs (a = b and b = c: one group). */
export function groupPairs(pairs) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  for (const p of pairs) { add(p.a.id); add(p.b.id); parent.set(find(p.a.id), find(p.b.id)); }
  const groups = new Map();
  for (const p of pairs) {
    const root = find(p.a.id);
    const g = groups.get(root) ?? { tracks: new Map(), pairs: [] };
    g.tracks.set(p.a.id, p.a); g.tracks.set(p.b.id, p.b); g.pairs.push(p);
    groups.set(root, g);
  }
  return [...groups.values()].map((g) => ({ tracks: [...g.tracks.values()], pairs: g.pairs, score: Math.max(...g.pairs.map((p) => p.verdict.score)) }))
    .sort((x, y) => y.score - x.score);
}

const LOSSLESS = /^(wav|aiff?|flac|alac)$/i;
const extOf = (t) => (t.kind || t.path?.split('.').pop() || '').toLowerCase();

/** The version to keep: lossless, then the best bitrate, then the most DJ work (cues, grid, rating, plays). */
export function keeperScore(t) {
  return (LOSSLESS.test(extOf(t)) ? 2000 : Math.min(320, t.bitrate || 0) * 3)
    + (t.cues?.length ?? 0) * 25 + (t.beatgrid ? 30 : 0) + (t.rating ?? 0) * 10 + Math.min(50, t.playCount ?? 0) + (t.analyzed ? 10 : 0) + (t.missing ? -5000 : 0);
}

export const pickKeeper = (tracks) => [...tracks].sort((a, b) => keeperScore(b) - keeperScore(a))[0];
