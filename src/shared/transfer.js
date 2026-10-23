// Moving a library to another Reboxed on another computer with a USB drive: the music and an XML
// (playlists, cues, grids, tags) go on the drive; the other computer copies the music into a local
// folder and keeps everything. Pure helpers, shared by the export and the import.

const keyOf = (p) => (/^[A-Za-z]:\\/.test(p) ? p.toLowerCase() : p);
const driveOf = (p) => (/^[A-Za-z]:/.test(p) ? p.slice(0, 2).toUpperCase() : '');
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = (p) => p.split(/[\\/]/).pop();

/** Folder of the music copied next to the XML. */
export const TRANSFER_MUSIC = 'Music';
/** Folder of the stems sent along, one sub-folder per track. */
export const TRANSFER_STEMS = 'Stems';

/**
 * What to export. selected: ids of playlists / intelligent playlists (null = the whole collection
 * and every playlist). Intelligent playlists become plain playlists of their current tracks.
 * @param {{get: (id: string) => object, all: () => object[], playlists: object[], rowsFor: (id: string) => {track: object}[]}} lib
 * @returns {{tracks: object[], playlists: object[]}}
 */
export function collectForTransfer(lib, selected = null) {
  const flat = (n) => (n.type === 'smart' ? { type: 'playlist', name: n.name, trackIds: lib.rowsFor(n.id).map((r) => r.track.id) } : n);
  const keep = (nodes) => nodes.flatMap((n) => {
    if (n.type === 'folder') { const children = keep(n.children); return children.length ? [{ ...n, children }] : []; }
    return !selected || selected.has(n.id) ? [flat(n)] : [];
  });
  const playlists = keep(lib.playlists);
  if (!selected) return { tracks: lib.all(), playlists };
  const ids = new Set();
  const walk = (nodes) => nodes.forEach((n) => (n.type === 'folder' ? walk(n.children) : n.trackIds.forEach((id) => ids.add(id))));
  walk(playlists);
  return { tracks: [...ids].map((id) => lib.get(id)).filter(Boolean), playlists };
}

/** Tracks already on the export drive stay where they are; the others are copied. */
export const needsCopy = (path, folder) => driveOf(path) !== driveOf(folder) || !driveOf(folder);

/**
 * Where a track of a transfer XML may be on this computer, best first: the path as written; the
 * same path on the drive the XML is on now (its letter changed); the transfer's Music folder.
 */
export function transferCandidates(path, xmlPath) {
  const out = [path];
  const drive = driveOf(xmlPath);
  if (drive && driveOf(path) && driveOf(path) !== drive) out.push(drive + path.slice(2));
  out.push(`${dirOf(xmlPath)}\\${TRANSFER_MUSIC}\\${baseOf(path)}`);
  return [...new Set(out)];
}

/** Map of old path (key) -> path found, from candidates and their existence flags. */
export function pickFound(paths, candidates, exists) {
  const found = new Map();
  let k = 0;
  paths.forEach((p, i) => {
    for (const c of candidates[i]) { if (exists[k++] && !found.has(keyOf(p))) found.set(keyOf(p), c); }
  });
  return found;
}
