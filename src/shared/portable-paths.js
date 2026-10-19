// Keeps a library usable when its database folder moves: files inside the database (artwork,
// DRUM CAPTURE loops) follow it, and when only the drive letter changed (a USB key that is J: on
// one PC and K: on another) every path on that drive follows too.

const norm = (p) => String(p).replace(/\//g, '\\');
const driveOf = (p) => (/^[A-Za-z]:\\/.test(norm(p)) ? norm(p).slice(0, 2).toUpperCase() : null);

/** Is `p` inside `dir` (or equal), Windows-style comparison? */
export function insidePath(p, dir) {
  const a = norm(p).toLowerCase(); const b = norm(dir).replace(/\\+$/, '').toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
}

/**
 * Rewrite every string path of a loaded library (tracks, artwork, playlists, settings).
 * @param {any} data parsed library.json
 * @param {string|null} fromDb database folder recorded when it was saved
 * @param {string} toDb database folder now
 * @returns {any} new data (input untouched)
 */
export function rebasePaths(data, fromDb, toDb) {
  if (!fromDb || norm(fromDb).toLowerCase() === norm(toDb).toLowerCase()) return data;
  const oldDrive = driveOf(fromDb); const newDrive = driveOf(toDb);
  // Same folder on another drive letter = the removable drive was remounted elsewhere.
  const remounted = oldDrive && newDrive && oldDrive !== newDrive && norm(fromDb).slice(2).toLowerCase() === norm(toDb).slice(2).toLowerCase();
  const base = norm(fromDb).replace(/\\+$/, '');
  const fix = (s) => {
    if (!/^[A-Za-z]:[\\/]/.test(s)) return s;
    if (insidePath(s, base)) return norm(toDb).replace(/\\+$/, '') + norm(s).slice(base.length);
    if (remounted && driveOf(s) === oldDrive) return newDrive + norm(s).slice(2);
    return s;
  };
  const walk = (v) => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(data);
}
