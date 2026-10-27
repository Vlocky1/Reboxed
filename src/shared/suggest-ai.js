// Track suggestion: what to play next after a seed track. A local engine (no account, nothing
// leaves the computer) scores every analysed track on:
//   sound   the audio fingerprint (timbre, harmony, energy, groove; dsp/features.js)
//   key     harmonic mixing (same key, ±1 on the Camelot wheel, relative major/minor, +2 boost)
//   tempo   reachable with the tempo fader (±8 %, double / half time)
//   energy  the direction asked for: keep the energy, build up, cool down
//   habits  what the DJ already played after this track (or after tracks that sound like it) in
//           the histories, and what was not played today yet
// Each suggestion carries its reasons. An optional language model (Gemini) can re-rank the best
// candidates and name tracks to discover, from titles / artists / BPM / keys only (see main/ai.js).
import { featureSimilarity } from './dsp/features.js';

export const MOODS = { keep: 'Keep the energy', up: 'Build up', down: 'Cool down' };

/** Energy 0..1 from the fingerprint (loudness, onset density, brightness). */
export function energyOf(f) {
  if (!f || f.length < 18) return null;
  return Math.max(0, Math.min(1, 0.5 * f[13] + 0.3 * f[16] + 0.2 * f[15]));
}

function camelot(k) {
  const m = /^(\d{1,2})([AB])$/.exec(k ?? '');
  return m ? { n: Number(m[1]), l: m[2] } : null;
}

/** Harmonic match 0..1 and its name. */
export function keyMatch(a, b) {
  const x = camelot(a); const y = camelot(b);
  if (!x || !y) return { score: 0.4, label: '' };
  const d = ((y.n - x.n) % 12 + 12) % 12;
  if (d === 0 && x.l === y.l) return { score: 1, label: 'same key' };
  if (d === 0) return { score: 0.85, label: 'relative key' };
  if (x.l === y.l && (d === 1 || d === 11)) return { score: 0.9, label: `${d === 1 ? '+1' : '−1'} on the key wheel` };
  if (x.l === y.l && d === 2) return { score: 0.6, label: 'energy boost (+2)' };
  if (x.l === y.l && d === 7) return { score: 0.55, label: '+7 (mood change)' };
  return { score: 0, label: '' };
}

/** Tempo match 0..1: how far the fader has to go (double / half time count). */
export function tempoMatch(a, b) {
  if (!(a > 0) || !(b > 0)) return { score: 0.4, label: '' };
  const r = Math.log2(b / a);
  const off = Math.min(Math.abs(r), Math.abs(r - 1), Math.abs(r + 1));
  const pct = (2 ** off - 1) * 100;
  if (pct <= 2) return { score: 1, label: 'same tempo' };
  if (pct <= 8) return { score: 1 - (pct - 2) / 10, label: `${pct.toFixed(0)} % tempo` };
  return { score: Math.max(0, 0.4 - (pct - 8) / 20), label: '' };
}

/**
 * Transitions the DJ played: next[a] = Map(b -> times played right after a).
 * @param {{trackIds: string[]}[]} histories
 */
export function transitions(histories) {
  const next = new Map();
  for (const h of histories ?? []) {
    const ids = h.trackIds ?? [];
    for (let i = 0; i + 1 < ids.length; i++) {
      if (ids[i] === ids[i + 1]) continue;
      if (!next.has(ids[i])) next.set(ids[i], new Map());
      const m = next.get(ids[i]);
      m.set(ids[i + 1], (m.get(ids[i + 1]) ?? 0) + 1);
    }
  }
  return next;
}

/**
 * Suggestions after `seed`.
 * @param {object} seed track (with features, bpm, key)
 * @param {object[]} tracks the collection
 * @param {{mood?: keyof MOODS, histories?: object[], playedToday?: Set<string>, onDeck?: Set<string>, exclude?: Set<string>, limit?: number}} [o]
 *   onDeck: tracks loaded on a deck (ranked last), exclude: left out
 * @returns {{track: object, score: number, reasons: string[]}[]}
 */
export function suggestNext(seed, tracks, o = {}) {
  if (!seed) return [];
  const mood = o.mood ?? 'keep';
  const next = transitions(o.histories);
  const played = o.playedToday ?? new Set();
  const exclude = o.exclude ?? new Set();
  const onDeck = o.onDeck ?? new Set();
  const seedEnergy = energyOf(seed.features);
  // Tracks the DJ played after the seed, and after the 5 tracks that sound most like it.
  const habit = new Map();
  const addHabit = (from, weight) => { for (const [id, n] of next.get(from) ?? []) habit.set(id, (habit.get(id) ?? 0) + weight * n); };
  addHabit(seed.id, 1);
  if (seed.features) {
    tracks.filter((t) => t.id !== seed.id && t.features && next.has(t.id))
      .map((t) => [t, featureSimilarity(seed.features, t.features)])
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([t, sim]) => addHabit(t.id, 0.4 * Math.max(0, sim)));
  }
  const habitMax = Math.max(1, ...habit.values());
  const out = [];
  for (const t of tracks) {
    if (t.id === seed.id || exclude.has(t.id)) continue;
    const reasons = [];
    const sound = seed.features && t.features ? Math.max(0, featureSimilarity(seed.features, t.features)) : null;
    const key = keyMatch(seed.key, t.key);
    const tempo = tempoMatch(seed.bpm, t.bpm);
    const e = energyOf(t.features);
    let energy = 0.5;
    if (seedEnergy !== null && e !== null) {
      const d = e - seedEnergy;
      energy = mood === 'up' ? (d >= 0 ? Math.min(1, 0.6 + d * 4) : Math.max(0, 0.6 + d * 6))
        : mood === 'down' ? (d <= 0 ? Math.min(1, 0.6 - d * 4) : Math.max(0, 0.6 - d * 6))
          : Math.max(0, 1 - Math.abs(d) * 6);
      if (mood === 'up' && d > 0.03) reasons.push('more energy');
      if (mood === 'down' && d < -0.03) reasons.push('calmer');
    }
    const h = (habit.get(t.id) ?? 0) / habitMax;
    let score = 0.34 * (sound ?? 0.35) + 0.2 * key.score + 0.16 * tempo.score + 0.1 * energy + 0.2 * h;
    if (seed.genre && t.genre && seed.genre.toLowerCase() === t.genre.toLowerCase()) { score += 0.03; reasons.push(t.genre); }
    if (played.has(t.id)) score -= 0.25;
    if (onDeck.has(t.id)) { score -= 0.3; reasons.push('on a deck'); }
    if (sound !== null && sound > 0.92) reasons.unshift('sounds alike');
    if (key.label && key.score >= 0.55) reasons.push(key.label);
    if (tempo.label && tempo.score >= 0.6) reasons.push(tempo.label);
    if (h > 0) reasons.push(next.get(seed.id)?.has(t.id) ? 'you played it after this one' : 'you play it after similar tracks');
    if (played.has(t.id)) reasons.push('already played today');
    out.push({ track: t, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, o.limit ?? 50);
}

/**
 * The prompt for the language model: metadata only (never audio), the candidates to pick from.
 * @returns {string}
 */
export function aiPrompt(seed, candidates, recent, mood) {
  const line = (t) => [t.artist || '?', t.title || '?', t.bpm ? `${Math.round(t.bpm)} BPM` : '', t.key || '', t.genre || ''].filter(Boolean).join(' | ');
  return [
    'You are helping a DJ choose the next track during a live set.',
    `Now playing: ${line(seed)}`,
    recent.length ? `Played before (oldest first):\n${recent.map(line).join('\n')}` : '',
    `Direction: ${MOODS[mood] ?? MOODS.keep}.`,
    'Candidates from the DJ\'s collection (id: artist | title | BPM | Camelot key | genre):',
    ...candidates.map((t, i) => `${i}: ${line(t)}`),
    'Reply with JSON only: {"picks":[{"i":<candidate number>,"why":"<max 8 words>"}],"discover":[{"artist":"","title":"","why":"<max 8 words>"}]}',
    'picks: the 12 best next tracks from the candidates, best first (musical flow, harmonic and tempo compatibility, crowd energy).',
    'discover: 8 real, existing tracks NOT in the list that would fit next (well-known releases, correct artist and title).',
  ].filter(Boolean).join('\n');
}

/** Parse the model's JSON answer (tolerates a ```json fence). */
export function parseAiAnswer(text, candidates) {
  const raw = String(text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  const data = JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw);
  const picks = (data.picks ?? []).map((p) => ({ track: candidates[Number(p.i)], why: String(p.why ?? '').slice(0, 80) })).filter((p) => p.track);
  const discover = (data.discover ?? []).map((d) => ({ artist: String(d.artist ?? '').slice(0, 80), title: String(d.title ?? '').slice(0, 120), why: String(d.why ?? '').slice(0, 80) })).filter((d) => d.title);
  return { picks, discover };
}
