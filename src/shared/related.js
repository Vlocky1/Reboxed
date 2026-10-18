// Related Tracks: rule-based suggestions from a seed track (Rekordbox criteria: BPM range incl.
// double/half, same or related key, same artist/genre/label/color, year ±N, rating, My Tag),
// combined with "match all" / "match any". Results are ranked by how many rules match.
import { compatibleKeys } from './keys.js';
import { normalizeForSearch } from '../search/normalize.js';

export const DEFAULT_RELATED = {
  match: 'all',
  bpm: { on: true, pct: 6, doubleHalf: true },
  key: { on: true, mode: 'compatible' },  // 'same' | 'compatible'
  genre: { on: false },
  artist: { on: false, includeFeat: true },
  label: { on: false },
  year: { on: false, range: 2 },
  rating: { on: false, min: 3 },
  color: { on: false },
  myTag: { on: false },
};

const norm = (s) => normalizeForSearch(s ?? '').trim();

/** Artist names split on "feat./ft./&/,/x/vs" so "A feat. B" relates to B. */
function artistNames(s) {
  return norm(s).split(/\s*(?:,|&|\bFEAT\.?|\bFT\.?|\bVS\.?|\bX\b|\bAND\b)\s*/).map((x) => x.trim()).filter(Boolean);
}

/**
 * @returns {{name: string, test: (t: object) => boolean}[]} active rules for this seed
 */
function rulesFor(seed, c) {
  const rules = [];
  if (c.bpm?.on && seed.bpm > 0) {
    const within = (bpm, ref) => Math.abs(bpm - ref) <= (ref * c.bpm.pct) / 100;
    rules.push({ name: 'bpm', test: (t) => t.bpm > 0 && (within(t.bpm, seed.bpm) || (c.bpm.doubleHalf && (within(t.bpm, seed.bpm * 2) || within(t.bpm, seed.bpm / 2)))) });
  }
  if (c.key?.on && seed.key) {
    const keys = new Set(c.key.mode === 'same' ? [seed.key] : compatibleKeys(seed.key));
    rules.push({ name: 'key', test: (t) => keys.has(t.key) });
  }
  if (c.genre?.on && seed.genre) { const g = norm(seed.genre); rules.push({ name: 'genre', test: (t) => norm(t.genre) === g }); }
  if (c.artist?.on && seed.artist) {
    const names = new Set(artistNames(seed.artist));
    rules.push({ name: 'artist', test: (t) => {
      const other = artistNames(t.artist);
      if (other.some((n) => names.has(n))) return true;
      // "Including when the title contains the artist name (e.g. feat.)"
      return c.artist.includeFeat && [...names].some((n) => n.length > 2 && norm(t.title).includes(n));
    } });
  }
  if (c.label?.on && seed.label) { const l = norm(seed.label); rules.push({ name: 'label', test: (t) => norm(t.label) === l }); }
  if (c.year?.on && seed.year > 0) rules.push({ name: 'year', test: (t) => t.year > 0 && Math.abs(t.year - seed.year) <= c.year.range });
  if (c.rating?.on) rules.push({ name: 'rating', test: (t) => (t.rating ?? 0) >= c.rating.min });
  if (c.color?.on && seed.color) rules.push({ name: 'color', test: (t) => t.color === seed.color });
  if (c.myTag?.on && seed.myTags?.length) { const tags = new Set(seed.myTags); rules.push({ name: 'myTag', test: (t) => (t.myTags ?? []).some((x) => tags.has(x)) }); }
  return rules;
}

/**
 * @param {object[]} tracks candidates (collection or a playlist)
 * @param {object} seed
 * @param {typeof DEFAULT_RELATED} criteria
 * @returns {{track: object, score: number, matched: string[]}[]}
 */
export function findRelated(tracks, seed, criteria = DEFAULT_RELATED) {
  if (!seed) return [];
  const rules = rulesFor(seed, criteria);
  if (rules.length === 0) return [];
  const out = [];
  for (const t of tracks) {
    if (t.id === seed.id) continue;
    const matched = rules.filter((r) => r.test(t)).map((r) => r.name);
    const ok = criteria.match === 'any' ? matched.length > 0 : matched.length === rules.length;
    if (ok) out.push({ track: t, score: matched.length, matched });
  }
  const bpmDist = (t) => (seed.bpm && t.bpm ? Math.abs(Math.log2(t.bpm / seed.bpm) - Math.round(Math.log2(t.bpm / seed.bpm))) : 1);
  return out.sort((a, b) => b.score - a.score || bpmDist(a.track) - bpmDist(b.track));
}
