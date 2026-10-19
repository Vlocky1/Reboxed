// "Move my collection to the USB drive": find, for every track still on the computer, the same
// music among the files of the drive, even when its file name or format differs
// ("01 - Title.mp3" vs "Artist - Title (Original Mix).aiff"). Pure functions, tested under Node.
//   1. same file name (same size = sure)          2. same name, another format
//   3. close name: the title / artist words are in the file name
//   4. confirmation by the drive file's tags (title, artist) and duration (±2 s; a very different
//      duration is another edit, e.g. Original vs Extended Mix, and is rejected)
import { insidePath } from './portable-paths.js';

const fileName = (p) => String(p).split(/[\\/]/).pop();
const stem = (p) => fileName(p).replace(/\.[^.]+$/, '');

/** Words of a name: lower case, no accents, no track number, no punctuation, no feat. */
export function words(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^\s*[a-d]?\d{1,3}\s*[-._)\]]\s*/, '')
    .replace(/\b(feat|ft|featuring)\b\.?/g, ' ')
    .split(/[^a-z0-9]+/).filter((w) => w && w !== 'the' && w !== 'and');
}

const contain = (need, have) => (need.length ? need.filter((w) => have.has(w)).length / need.length : 0);

/** Name-based score of a drive file for a track (0..1) and why. */
export function nameScore(track, file) {
  const fn = fileName(file.path).toLowerCase();
  if (fn === fileName(track.path).toLowerCase()) return { score: 1, why: 'same file name' };
  if (stem(file.path).toLowerCase() === stem(track.path).toLowerCase()) return { score: 0.95, why: 'same name, other format' };
  const have = new Set(words(stem(file.path)));
  const title = words(track.title || stem(track.path));
  const artist = words(track.artist);
  const mix = words(track.mixName);
  const t = contain(title, have);
  if (t < 0.75) return { score: 0, why: '' };
  const a = artist.length ? contain(artist, have) : 0.5;
  const m = mix.length ? contain(mix, have) : 1;
  const extra = [...have].filter((w) => !title.includes(w) && !artist.includes(w) && !mix.includes(w)).length;
  return { score: Math.max(0, 0.55 * t + 0.3 * a + 0.1 * m + 0.05 - Math.min(0.2, extra * 0.04)), why: 'similar name' };
}

/** Do the drive file's tags confirm it is the same recording? */
export function tagCheck(track, tags) {
  if (!tags) return { ok: null, why: '' };
  const d = track.duration && tags.duration ? Math.abs(track.duration - tags.duration) : null;
  if (d !== null && d > 5) return { ok: false, why: `duration differs by ${Math.round(d)} s` };
  const same = (a, b) => words(a).join(' ') === words(b).join(' ');
  const titleOk = tags.title && track.title && (same(tags.title, track.title) || contain(words(track.title), new Set(words(tags.title))) >= 0.9);
  const artistOk = !track.artist || !tags.artist || contain(words(track.artist), new Set(words(tags.artist))) >= 0.6;
  if (titleOk && artistOk && (d === null || d <= 2)) return { ok: true, strong: d !== null, why: d === null ? 'same tags' : 'same tags and duration' };
  if (d !== null && d <= 2) return { ok: true, why: 'same duration' };
  return { ok: null, why: '' };
}

/**
 * Candidates on the drive for one track, best first.
 * @param {{path, title, artist, mixName?, duration?, fileSize?}} track
 * @param {{path: string, size: number}[]} files
 * @param {Map<string, object>} [tags] drive file path -> tags (title, artist, duration)
 * @returns {{path, size, score, why, confidence: 'sure'|'likely'|'check'}[]}
 */
export function candidatesFor(track, files, tags = new Map(), limit = 5) {
  const out = [];
  for (const f of files) {
    const n = nameScore(track, f);
    if (n.score < 0.45) continue;
    const c = tagCheck(track, tags.get(f.path));
    if (c.ok === false) continue;
    let score = n.score + (c.ok ? 0.25 : 0);
    if (track.fileSize && f.size === track.fileSize) score += 0.3;
    const sure = (n.score === 1 && track.fileSize && f.size === track.fileSize) || (n.score >= 0.95 && c.ok) || (c.ok && n.score >= 0.7) || !!c.strong;
    const confidence = sure ? 'sure' : score >= 0.9 ? 'likely' : 'check';
    out.push({ path: f.path, size: f.size, score, why: [n.why, c.why].filter(Boolean).join(', '), confidence });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Tracks still on the computer (outside the drive folder) and, for each, the drive candidates.
 * A drive file goes to one track only (the best-scored first).
 */
export function planMigration(tracks, files, root, tags = new Map()) {
  const local = tracks.filter((t) => !insidePath(t.path, root));
  const plans = local.map((t) => ({ track: t, candidates: candidatesFor(t, files, tags) }));
  const taken = new Set(tracks.filter((t) => insidePath(t.path, root)).map((t) => t.path.toLowerCase()));
  const order = [...plans].sort((a, b) => (b.candidates[0]?.score ?? 0) - (a.candidates[0]?.score ?? 0));
  for (const p of order) {
    p.candidates = p.candidates.filter((c) => !taken.has(c.path.toLowerCase()));
    if (p.candidates[0]) taken.add(p.candidates[0].path.toLowerCase());
  }
  return plans;
}

/** Drive files worth reading the tags of (candidates that names alone do not settle). */
export function filesToConfirm(plans) {
  const out = new Set();
  for (const p of plans) for (const c of p.candidates) if (c.confidence !== 'sure') out.add(c.path);
  return [...out];
}
