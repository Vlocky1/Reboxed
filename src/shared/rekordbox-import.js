// Merge rules for bringing a parsed rekordbox.xml (see rekordbox-xml.js) into the RBClone library:
// which fields win, how cues combine, which playlists and tracks are taken, moved-file paths.

/** Fields where an empty / 0 value in rekordbox means "unknown", never "cleared by the DJ". */
const UNKNOWN_WHEN_EMPTY = new Set(['duration', 'fileSize', 'bitrate', 'sampleRate', 'kind', 'bpm', 'key', 'dateAdded']);
/** Import bookkeeping, not track metadata. */
const NOT_FIELDS = new Set(['path', 'cues', 'beatgrid', 'xmlId', 'source']);

const isEmpty = (v) => v === undefined || v === null || v === '' || v === 0;
const keyOf = (p) => (/^[A-Za-z]:\\/.test(p) ? p.toLowerCase() : p);

/** Playlist tree node key: index path from the root ("0/2/1"), stable for one parsed file. */
export function forEachNode(nodes, fn, prefix = '') {
  nodes.forEach((n, i) => {
    const key = prefix ? `${prefix}/${i}` : String(i);
    fn(n, key);
    if (n.type === 'folder') forEachNode(n.children, fn, key);
  });
}

/** Keep the playlists whose key is selected (null = all); folders survive when they still hold something. */
export function selectPlaylists(nodes, selected, prefix = '') {
  const out = [];
  nodes.forEach((n, i) => {
    const key = prefix ? `${prefix}/${i}` : String(i);
    if (n.type === 'folder') {
      const children = selectPlaylists(n.children, selected, key);
      if (children.length) out.push({ ...n, children });
    } else if (!selected || selected.has(key)) out.push(n);
  });
  return out;
}

/** All paths referenced by a playlist tree (drive paths lower-cased). */
export function playlistPaths(nodes) {
  const out = new Set();
  forEachNode(nodes, (n) => { if (n.type !== 'folder') n.paths.forEach((p) => out.add(keyOf(p))); });
  return out;
}

/**
 * Moved music: explicit per-file relocations first, then folder rules (old folder -> new folder).
 * @param {Map<string,string>} [relocated] keys lower-cased for drive paths
 * @param {[string,string][]} [rules] longest first
 */
export function remapPath(path, { relocated, rules } = {}) {
  const k = keyOf(path);
  if (relocated?.has(k)) return relocated.get(k);
  for (const [from, to] of rules ?? []) {
    if (from && path.toLowerCase().startsWith(from.toLowerCase())) return to + path.slice(from.length);
  }
  return path;
}

/**
 * Guess folder rules from relocated files: "D:\Music\House\a.mp3" found at "E:\DJ\Music\House\a.mp3"
 * gives D:\ -> E:\DJ\ (the longest common tail of folder names is kept).
 */
export function inferRules(pairs) {
  const rules = new Map();
  for (const [from, to] of pairs) {
    const a = from.split(/[\\/]/); const b = to.split(/[\\/]/);
    let k = 1; // the file name itself matched
    while (k < a.length - 1 && k < b.length - 1 && a[a.length - 1 - k].toLowerCase() === b[b.length - 1 - k].toLowerCase()) k++;
    const sepA = from.includes('\\') ? '\\' : '/'; const sepB = to.includes('\\') ? '\\' : '/';
    const pa = a.slice(0, a.length - k).join(sepA) + sepA;
    const pb = b.slice(0, b.length - k).join(sepB) + sepB;
    if (pa.length > 1 && !rules.has(pa)) rules.set(pa, pb);
  }
  return [...rules].sort((x, y) => y[0].length - x[0].length);
}

/**
 * Combine cues. 'replace': rekordbox's cues when it has any; 'merge': keep ours and add
 * rekordbox cues on free hot cue slots / new positions; 'keep': ours untouched.
 */
export function mergeCues(ours = [], theirs = [], mode = 'replace') {
  if (mode === 'keep' || !theirs.length) return ours;
  if (mode === 'replace') return theirs.map((c) => ({ ...c }));
  const out = ours.map((c) => ({ ...c }));
  for (const c of theirs) {
    const clash = c.kind === 'hot'
      ? out.some((o) => o.kind === 'hot' && o.slot === c.slot)
      : out.some((o) => o.kind === c.kind && Math.abs(o.start - c.start) < 0.01);
    if (!clash) out.push({ ...c });
  }
  return out;
}

/**
 * Track fields after import.
 * metadata 'overwrite': rekordbox wins, including text the DJ cleared there (empty comment, 0 stars);
 * 'fill': only fields that are empty in RBClone take rekordbox's value.
 * @returns {object} patch for `existing`, or all fields of a new track when existing is null
 */
export function trackPatch(existing, x, { metadata = 'overwrite', cues = 'replace', beatgrid = true } = {}) {
  const patch = {};
  for (const [k, v] of Object.entries(x)) {
    if (NOT_FIELDS.has(k) || v === undefined) continue;
    if (UNKNOWN_WHEN_EMPTY.has(k) && isEmpty(v)) continue;
    if (!existing || metadata === 'overwrite') patch[k] = v;
    else if (isEmpty(existing[k]) && !isEmpty(v)) patch[k] = v;
  }
  if (beatgrid && x.beatgrid && (!existing || metadata === 'overwrite' || !existing.beatgrid)) {
    patch.beatgrid = x.beatgrid;
    if (!patch.bpm && x.beatgrid.bpm) patch.bpm = x.beatgrid.bpm;
  }
  const merged = mergeCues(existing?.cues ?? [], x.cues ?? [], cues);
  if (!existing || merged !== existing.cues) patch.cues = merged;
  patch.source = 'rekordbox';
  return patch;
}
