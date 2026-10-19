// Batch auto-tagging: a recipe of steps (each one: a service and the fields to take from it) runs
// on every selected track. Each step searches with the track as the previous steps left it, keeps
// the result only when artist, title and duration agree, and proposes field changes.

/** "Song - Extended Mix" / "Song (Extended Mix)" -> {title: 'Song', mixName: 'Extended Mix'}. */
export function splitMix(name) {
  const m = /^(.*?)\s*(?:-\s+|\(|\[)([^()[\]]*\b(?:mix|remix|edit|version|dub|rework|bootleg|vip|remaster(?:ed)?(?: \d{4})?)\b[^()[\]]*)[)\]]?\s*$/i.exec(name ?? '');
  return m && m[1] ? { title: m[1].trim(), mixName: m[2].trim() } : { title: String(name ?? '').trim(), mixName: '' };
}

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

const bigrams = (s) => { const t = norm(s).replace(/ /g, ''); const out = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };

/** Dice similarity of two strings (0..1), on letter pairs, ignoring case, accents and punctuation. */
export function similarity(a, b) {
  const x = bigrams(a); const y = bigrams(b);
  if (!x.length || !y.length) return norm(a) === norm(b) ? 1 : 0;
  const count = new Map();
  for (const g of x) count.set(g, (count.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of y) { const n = count.get(g); if (n) { hit++; count.set(g, n - 1); } }
  return (2 * hit) / (x.length + y.length);
}

/** Artists of a "A, B & C feat. D" string. */
export const artistList = (s) => String(s ?? '').split(/\s*(?:,|&|;|\/| x | and | feat\.? | ft\.? | featuring | vs\.? )\s*/i).map((a) => a.trim()).filter(Boolean);

/** Best artist match (0..1): any artist of one side against any of the other. */
export function artistSimilarity(a, b) {
  let best = 0;
  for (const x of artistList(a)) for (const y of artistList(b)) best = Math.max(best, similarity(x, y));
  return best;
}

/**
 * What to search with: the track's artist and title; a track whose title is "Artist - Title" and
 * has no artist (downloads, rips) is split.
 */
export function queryFor(t) {
  let artist = t.artist ?? ''; let title = cleanTitle(t.title);
  if (!artist.trim() && / - /.test(title)) { const i = title.indexOf(' - '); artist = title.slice(0, i); title = title.slice(i + 3); }
  return { artist: artist.trim(), title: title.trim() };
}

/** Title without video decorations: (Official Video), [Clip officiel], (Lyrics), | Audio, HD… */
export function cleanTitle(s) {
  return String(s ?? '')
    .replace(/\s*[([][^)\]]*\b(official|officiel(le)?|clip|lyrics?|paroles|audio|video|vid[ée]o|visuali[sz]er|hd|4k|hq|m\/?v)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|\s*(official|lyrics?|audio|video|clip).*$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}

/**
 * The candidate that is really this track, or null.
 * @param {object[]} candidates service results ({title, mixName, artist, duration})
 * @param {object} t the track (as left by the previous steps)
 * @param {{tolerance?: number}} [opts] duration tolerance in seconds
 */
export function pickMatch(candidates, t, { tolerance = 4 } = {}) {
  const q = queryFor(t);
  const want = splitMix(q.title);
  let best = null;
  for (const c of candidates) {
    const titleSim = similarity(splitMix(c.title).title, want.title);
    const artistSim = q.artist ? artistSimilarity(c.artist, q.artist) : 1;
    const diff = t.duration && c.duration ? Math.abs(c.duration - t.duration) : null;
    if (titleSim < 0.6 || artistSim < 0.5 || (diff !== null && diff > tolerance)) continue;
    // Same version (Extended / Radio Edit…) when the track names one.
    const mixBonus = want.mixName ? (similarity(c.mixName, want.mixName) > 0.7 ? 0.15 : -0.1) : (c.mixName ? -0.05 : 0.05);
    const score = 0.5 * titleSim + 0.3 * artistSim + (diff === null ? 0.05 : 0.2 * (1 - diff / (tolerance + 1))) + mixBonus;
    if (!best || score > best.score) best = { candidate: c, score };
  }
  return best;
}

/** Fields a step can take; artwork is a URL turned into a cover when applied. */
export const TAG_FIELDS = [
  ['title', 'Title'], ['artist', 'Artist'], ['mixName', 'Mix name'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['genre', 'Genre'], ['year', 'Year'], ['trackNumber', 'Track number'], ['discNumber', 'Disc number'], ['label', 'Label'], ['artwork', 'Artwork'],
];

/** Value of a field from a candidate. titleWithMix: "Song (Extended Mix)" in the title, like rekordbox. */
export function valueOf(c, field, { titleWithMix = true } = {}) {
  if (field === 'title') return titleWithMix && c.mixName ? `${c.title} (${c.mixName})` : c.title;
  if (field === 'artwork') return c.artworkUrl ?? '';
  const v = c[field];
  return v === 0 || v === undefined || v === null ? '' : v;
}

/**
 * Changes one step makes on a track.
 * @param {object} t track (as left by the previous steps)
 * @param {object} c the matched candidate
 * @param {{fields: string[], onlyEmpty?: boolean, titleWithMix?: boolean}} step
 * @returns {{field: string, from: any, to: any}[]}
 */
export function changesFor(t, c, step) {
  const out = [];
  for (const field of step.fields) {
    const to = valueOf(c, field, step);
    if (to === '' || to === undefined) continue;
    const from = field === 'artwork' ? (t.artwork ?? '') : (t[field] ?? '');
    if (field !== 'artwork' && String(from) === String(to)) continue;
    if (step.onlyEmpty && from !== '' && from !== 0) continue;
    out.push({ field, from, to });
  }
  return out;
}

/** The default recipe: titles and artists from Spotify, then the genre from Deezer. */
export const DEFAULT_RECIPE = {
  tolerance: 4,
  steps: [
    { source: 'spotify', fields: ['title', 'artist'], onlyEmpty: false, titleWithMix: true },
    { source: 'deezer', fields: ['genre'], onlyEmpty: false, titleWithMix: true },
  ],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a recipe on tracks: per track, per step, the matched result and its changes (nothing saved).
 * @param {object[]} tracks
 * @param {{tolerance: number, steps: object[]}} recipe
 * @param {(q: object, source: string, opts: object) => Promise<{candidates: object[]}>} lookup
 * @param {{onProgress?: Function, stopped?: () => boolean, pause?: number}} [hooks] pause: ms between
 *   tracks (the services limit request rates)
 */
export async function runRecipe(tracks, recipe, lookup, { onProgress = () => {}, stopped = () => false, pause = 0 } = {}) {
  const results = [];
  for (const [i, t] of tracks.entries()) {
    if (stopped()) break;
    onProgress(i, tracks.length, t);
    const work = { ...t };
    const steps = [];
    for (const step of recipe.steps) {
      if (!step.fields.length) continue;
      const q = queryFor(work);
      const opts = { complete: false, genres: step.fields.includes('genre'), max: 3, duration: t.duration };
      let r = null; let error = '';
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try { r = await lookup({ title: q.title, artist: q.artist }, step.source, opts); } catch (err) {
          error = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          if (/too many|429/i.test(error) && attempt === 0) await wait(3000); else break;
        }
      }
      const match = r ? pickMatch(r.candidates, work, { tolerance: recipe.tolerance }) : null;
      const changes = match ? changesFor(work, match.candidate, step) : [];
      // The next steps search with what this one found (e.g. Deezer gets Spotify's clean title).
      for (const c of changes) if (c.field !== 'artwork') work[c.field] = c.to;
      steps.push({ source: step.source, match: match?.candidate ?? null, error: r ? '' : error, changes });
    }
    results.push({ track: t, steps });
    if (pause) await wait(pause);
  }
  onProgress(tracks.length, tracks.length, null);
  return results;
}
