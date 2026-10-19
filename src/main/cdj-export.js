// Export to a USB drive for Pioneer CDJ / XDJ players: music files, PIONEER/rekordbox/export.pdb,
// one set of ANLZ analysis files per track, artwork and the "My Settings" preference files.
// Tracks already on the drive are referenced in place; others are copied to /Contents/<artist>/<album>/.
// A previous export on the drive (rekordbox or Reboxed) is moved to PIONEER/rekordbox/backup-<date>/
// first: newer players read exportLibrary.db before export.pdb, so a stale one must not stay.
import { access, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { buildPdb, TABLE, trackRow, artistRow, albumRow, idNameRow, keyRow, colorRow, artworkRow, playlistTreeRow, playlistEntryRow, COLORS } from '../shared/cdj/pdb.js';
import { COLUMNS_ROWS, MENU17_ROWS, MENU18_ROWS, hexRows } from '../shared/cdj/menu-tables.js';
import { buildAnlz, cssToRgb } from '../shared/cdj/anlz.js';
import { buildSettingFiles } from '../shared/cdj/mysettings.js';
import { toBeatgrid } from '../shared/beatgrid.js';
import { displayKey } from '../shared/keys.js';

const exists = (p) => access(p).then(() => true, () => false);
const today = () => new Date().toISOString().slice(0, 10);

/** FNV-1a, for stable ANLZ folder names. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const safeName = (s) => String(s || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'Unknown';

/** Path on the drive as the players want it: from the drive root, forward slashes. */
function drivePath(abs, root) {
  return `/${abs.slice(root.length).replace(/^[\\/]+/, '').split(sep).join('/').replace(/\\/g, '/')}`;
}

/** Already inside the export root (a drive, or a folder used as one)? */
const inside = (path, root) => path.toLowerCase().startsWith(root.replace(/[\\/]+$/, '').toLowerCase() + sep);

/** Beats with their position in the bar, from Reboxed's grid. */
function beatsOf(track) {
  const bg = toBeatgrid(track.beatgrid);
  if (!bg || !track.duration) return [];
  const out = [];
  for (let i = Math.ceil(bg.indexAt(0) - 1e-6); out.length < 20000; i++) {
    const t = bg.timeOf(i);
    if (t >= track.duration) break;
    if (t >= 0) out.push({ time: t, bpm: bg.bpmAt(t), beatInBar: bg.barPos(i) + 1 });
  }
  return out;
}

const TRACK_COLOR_IDS = Object.fromEntries(COLORS.map((c, i) => [c, i + 1]));

/** Reboxed cues -> player cues (hot cues A-H, memory cues; mix points become memory cues). */
function cuesOf(track) {
  const out = [];
  for (const c of track.cues ?? []) {
    const loop = c.end !== undefined && c.end > c.start;
    const bpm = toBeatgrid(track.beatgrid)?.bpmAt(c.start) || track.bpm || 120;
    const base = { time: c.start, loopTime: loop ? c.end : null, loopBeats: loop ? ((c.end - c.start) * bpm) / 60 : 0, comment: c.name || '' };
    if (c.kind === 'hot' && c.slot >= 0 && c.slot < 8) out.push({ ...base, hotCue: c.slot + 1, rgb: cssToRgb(c.color) });
    else if (c.kind !== 'hot') out.push({ ...base, hotCue: 0, colorId: 0, comment: c.name || (c.kind === 'mixin' ? 'MIX IN' : c.kind === 'mixout' ? 'MIX OUT' : '') });
  }
  return out;
}

function waveformOf(analysis) {
  const w = analysis?.waveform;
  if (!w?.low) return null;
  const dec = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
  return { low: dec(w.low), mid: dec(w.mid), high: dec(w.high) };
}

/** Move an existing export aside (export.pdb, exportExt.pdb, exportLibrary.db). */
async function backupPrevious(rbDir) {
  const names = ['export.pdb', 'exportExt.pdb', 'exportLibrary.db'];
  const present = [];
  for (const n of names) if (await exists(join(rbDir, n))) present.push(n);
  if (!present.length) return null;
  const dir = join(rbDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });
  for (const n of present) await rename(join(rbDir, n), join(dir, n));
  return dir;
}

/**
 * @param {object} job
 * @param {string} job.root drive root, e.g. "J:\\"
 * @param {object[]} job.tracks library tracks to export
 * @param {object[]} job.playlists tree of {type: 'folder'|'playlist', name, children?, trackIds?}
 * @param {Record<string,string>} job.settings My Settings choices
 * @param {(id: string) => Promise<object|null>} getAnalysis
 * @param {(buf: Buffer, size: number) => Buffer|null} resizeJpeg artwork resizer
 * @param {(p: {phase: string, done: number, total: number, file?: string}) => void} progress
 */
export async function exportToDrive(job, { getAnalysis, resizeJpeg, progress = () => {} }) {
  const root = job.root.length > 3 ? job.root.replace(/[\\/]+$/, '') : job.root;
  const pioneer = join(root, 'PIONEER');
  const rbDir = join(pioneer, 'rekordbox');
  await mkdir(rbDir, { recursive: true });
  const backup = await backupPrevious(rbDir);
  const report = { tracks: 0, copied: 0, inPlace: 0, missing: [], playlists: 0, backup };

  // Lookup tables.
  const tables = {};
  const ids = (type) => { const m = new Map(); tables[type] = []; return { get: (name, make) => { if (!name) return 0; if (!m.has(name)) { const id = m.size + 1; m.set(name, id); tables[type].push(make(id, name)); } return m.get(name); } }; };
  const artists = ids(TABLE.ARTISTS); const albums = ids(TABLE.ALBUMS); const genres = ids(TABLE.GENRES);
  const labels = ids(TABLE.LABELS); const keys = ids(TABLE.KEYS);
  tables[TABLE.COLORS] = COLORS.map((c, i) => colorRow(i + 1, c));
  tables[TABLE.ARTWORK] = [];
  tables[TABLE.TRACKS] = [];
  const trackIds = new Map();

  const total = job.tracks.length;
  let k = 0;
  for (const t of job.tracks) {
    k++;
    progress({ phase: 'tracks', done: k, total, file: t.title });
    if (!(await exists(t.path))) { report.missing.push(t.path); continue; }
    // Music file on the drive.
    let onDrive = t.path;
    if (!inside(t.path, root)) {
      const dir = join(root, 'Contents', safeName(t.artist), safeName(t.album));
      await mkdir(dir, { recursive: true });
      onDrive = join(dir, basename(t.path));
      const size = (await stat(t.path)).size;
      const there = await stat(onDrive).catch(() => null);
      if (!there || there.size !== size) await copyFile(t.path, onDrive);
      report.copied++;
    } else report.inPlace++;
    const id = trackIds.size + 1;
    trackIds.set(t.id, id);
    const filePath = drivePath(onDrive, root);
    const h = fnv(filePath);
    const anlzDir = `/PIONEER/USBANLZ/P${(h >>> 20).toString(16).toUpperCase().padStart(3, '0')}/${h.toString(16).toUpperCase().padStart(8, '0')}`;
    const analysis = await getAnalysis(t.id).catch(() => null);
    const files = buildAnlz({ path: filePath, beats: beatsOf(t), cues: cuesOf(t), waveform: waveformOf(analysis) });
    const absAnlz = join(root, ...anlzDir.split('/').filter(Boolean));
    await mkdir(absAnlz, { recursive: true });
    await writeFile(join(absAnlz, 'ANLZ0000.DAT'), files.dat);
    await writeFile(join(absAnlz, 'ANLZ0000.EXT'), files.ext);
    if (files.ex2) await writeFile(join(absAnlz, 'ANLZ0000.2EX'), files.ex2);
    // Artwork: 80 px and 240 px ("_m") JPEGs.
    let artworkId = 0;
    if (t.artwork && (await exists(t.artwork))) {
      const src = await readFile(t.artwork);
      artworkId = tables[TABLE.ARTWORK].length + 1;
      const folder = String(Math.floor(artworkId / 1000) + 1).padStart(5, '0');
      const dir = join(pioneer, 'Artwork', folder);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `a${artworkId}.jpg`), resizeJpeg(src, 80) ?? src);
      await writeFile(join(dir, `a${artworkId}_m.jpg`), resizeJpeg(src, 240) ?? src);
      tables[TABLE.ARTWORK].push(artworkRow(artworkId, `/PIONEER/Artwork/${folder}/a${artworkId}.jpg`));
    }
    const keyName = t.key ? displayKey(t.key, 'musical') : '';
    const artistId = artists.get(t.artist, artistRow);
    tables[TABLE.TRACKS].push(trackRow({
      id, title: t.title || basename(t.path, extname(t.path)), artistId, albumId: albums.get(t.album, (i, n) => albumRow(i, n, artistId)),
      genreId: genres.get(t.genre, idNameRow), labelId: labels.get(t.label, idNameRow), keyId: keys.get(keyName, keyRow),
      remixerId: artists.get(t.remixer, artistRow), composerId: artists.get(t.composer, artistRow), originalArtistId: artists.get(t.originalArtist, artistRow),
      artworkId, colorId: TRACK_COLOR_IDS[t.color] ?? 0, rating: Math.max(0, Math.min(5, t.rating ?? 0)),
      bpm: t.bpm ?? 0, duration: t.duration ?? 0, bitrate: t.bitrate ?? 0, sampleRate: t.sampleRate || 44100, fileSize: (await stat(onDrive)).size,
      year: t.year ?? 0, trackNumber: t.trackNumber ?? 0, discNumber: t.discNumber ?? 0, playCount: t.playCount ?? 0,
      comment: t.comments ?? '', mixName: t.mixName ?? '', dateAdded: t.dateAdded ?? today(), analyzeDate: today(),
      analyzePath: `${anlzDir}/ANLZ0000.DAT`, filename: basename(onDrive), filePath, checksum: h,
    }));
    report.tracks++;
  }

  // Playlist tree.
  tables[TABLE.PLAYLIST_TREE] = [];
  tables[TABLE.PLAYLIST_ENTRIES] = [];
  let nodeId = 0;
  const walk = (nodes, parentId) => nodes.forEach((n, sortOrder) => {
    const id = ++nodeId;
    if (n.type === 'folder') {
      tables[TABLE.PLAYLIST_TREE].push(playlistTreeRow({ id, parentId, sortOrder, isFolder: true, name: n.name }));
      walk(n.children ?? [], id);
      return;
    }
    tables[TABLE.PLAYLIST_TREE].push(playlistTreeRow({ id, parentId, sortOrder, isFolder: false, name: n.name }));
    let entry = 0;
    for (const tid of n.trackIds ?? []) { const pid = trackIds.get(tid); if (pid) tables[TABLE.PLAYLIST_ENTRIES].push(playlistEntryRow(++entry, pid, id)); }
    report.playlists++;
  });
  walk(job.playlists ?? [], 0);
  tables[TABLE.COLUMNS] = hexRows(COLUMNS_ROWS);
  tables[TABLE.UNKNOWN_17] = hexRows(MENU17_ROWS);
  tables[TABLE.UNKNOWN_18] = hexRows(MENU18_ROWS);

  progress({ phase: 'database', done: total, total });
  const pdb = buildPdb(tables);
  await writeFile(join(rbDir, 'export.pdb.part'), pdb);
  await rename(join(rbDir, 'export.pdb.part'), join(rbDir, 'export.pdb'));
  for (const [name, bytes] of Object.entries(buildSettingFiles(job.settings ?? {}))) await writeFile(join(pioneer, name), bytes);
  progress({ phase: 'done', done: total, total });
  return report;
}

/** Removable / other drives that could take an export (Windows drive letters). */
export async function listDrives() {
  const out = [];
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      await readdir(root);
      out.push({ root, hasExport: await exists(join(root, 'PIONEER', 'rekordbox', 'export.pdb')) });
    } catch { /* not mounted */ }
  }
  return out;
}

