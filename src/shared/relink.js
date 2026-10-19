// Link the library to a music folder (typically a USB drive): each track whose file also exists in
// that folder is pointed at the copy there. Matching is by file name; the size only breaks ties
// (tags edited on one copy change its size) and tells how sure the match is.
import { insidePath } from './portable-paths.js';

const fileName = (p) => String(p).split(/[\\/]/).pop().toLowerCase();

/**
 * @param {{id: string, path: string, fileSize?: number}[]} tracks library tracks
 * @param {{path: string, size: number}[]} files audio files found in `root`
 * @param {string} root the linked folder (e.g. J:\Tracks)
 * @returns {{
 *   matches: {id: string, from: string, to: string, sure: boolean}[],
 *   already: string[], newFiles: string[], notFound: string[]
 * }} already = ids already in root; newFiles = files of root no track uses; notFound = ids not in root
 */
export function planRelink(tracks, files, root) {
  const byName = new Map();
  for (const f of files) {
    const k = fileName(f.path);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  const used = new Set();
  const already = [];
  for (const t of tracks) {
    if (insidePath(t.path, root)) { already.push(t.id); used.add(t.path.toLowerCase()); }
  }
  const matches = [];
  const notFound = [];
  for (const t of tracks) {
    if (insidePath(t.path, root)) continue;
    const cands = (byName.get(fileName(t.path)) ?? []).filter((f) => !used.has(f.path.toLowerCase()));
    if (!cands.length) { notFound.push(t.id); continue; }
    const exact = t.fileSize ? cands.find((f) => f.size === t.fileSize) : null;
    const pick = exact ?? cands.reduce((a, b) => (Math.abs(b.size - (t.fileSize ?? 0)) < Math.abs(a.size - (t.fileSize ?? 0)) ? b : a));
    used.add(pick.path.toLowerCase());
    matches.push({ id: t.id, from: t.path, to: pick.path, sure: !!exact || cands.length === 1 });
  }
  const newFiles = files.filter((f) => !used.has(f.path.toLowerCase())).map((f) => f.path);
  return { matches, already, newFiles, notFound };
}
