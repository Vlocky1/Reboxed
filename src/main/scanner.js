import { readdir, stat } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { parseFile } from 'music-metadata';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.alac']);

/** Recursively collect audio files under the given files/folders. */
async function collect(paths, out = []) {
  for (const p of paths) {
    let s;
    try { s = await stat(p); } catch { continue; }
    if (s.isDirectory()) {
      const entries = await readdir(p);
      // Stems folders and a database folder kept among the music are not tracks of their own.
      if (entries.includes('reboxed-stems.json') || entries.includes('rbclone-stems.json') || p.endsWith('.part')) continue;
      if (entries.includes('library.json')) entries.splice(0, entries.length, ...entries.filter((e) => !['analysis', 'artwork', 'groove'].includes(e)));
      await collect(entries.filter((e) => !e.startsWith('.')).map((e) => join(p, e)), out);
    } else if (AUDIO_EXTENSIONS.has(extname(p).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Read tags into the track shape used by the renderer (no id/dateAdded). */
export async function readTags(path, { saveArtwork } = {}) {
  const base = { path, title: basename(path, extname(path)), fileSize: 0 };
  try {
    const s = await stat(path);
    base.fileSize = s.size;
    const { common, format } = await parseFile(path, { duration: false, skipCovers: !saveArtwork });
    const comment = first(common.comment);
    const picture = common.picture?.[0];
    const artwork = picture && saveArtwork ? await saveArtwork(picture.data).catch(() => '') : '';
    return {
      ...base,
      ...(artwork ? { artwork } : {}),
      title: common.title || base.title,
      artist: common.artist ?? '',
      album: common.album ?? '',
      albumArtist: common.albumartist ?? '',
      genre: first(common.genre) ?? '',
      composer: first(common.composer) ?? '',
      remixer: first(common.remixer) ?? '',
      label: first(common.label) ?? '',
      grouping: common.grouping ?? '',
      comments: typeof comment === 'string' ? comment : comment?.text ?? '',
      year: common.year ?? 0,
      trackNumber: common.track?.no ?? 0,
      bpm: common.bpm ? Number(common.bpm) : 0,
      key: common.key ?? '',
      duration: format.duration ?? 0,
      bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : 0,
      sampleRate: format.sampleRate ?? 0,
      kind: (format.container ?? extname(path).slice(1)).toUpperCase(),
    };
  } catch (err) {
    return { ...base, error: String(err?.message ?? err) };
  }
}

/** Scan paths and read tags, reporting progress. */
export async function scanPaths(paths, onProgress, opts) {
  const files = await collect(paths);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    results.push(await readTags(files[i], opts));
    if (i % 10 === 0 || i === files.length - 1) onProgress(i + 1, files.length);
  }
  return results;
}

/**
 * Find moved files by name under `dir` (rekordbox import relocation).
 * @param {string[]} names file names (any case)
 * @returns {Promise<Record<string, {path: string, size: number}[]>>} keyed by lower-cased name
 */
export async function findFiles(dir, names) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const found = {};
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (want.has(e.name.toLowerCase())) {
        let size = 0;
        try { size = (await stat(p)).size; } catch { /* unreadable */ }
        (found[e.name.toLowerCase()] ??= []).push({ path: p, size });
      }
    }
  };
  await walk(dir);
  return found;
}

/** Audio files under a folder with their sizes (linking the library to a USB drive). */
export async function listAudio(dir) {
  const files = await collect([dir]);
  return Promise.all(files.map(async (path) => {
    let size = 0;
    try { size = (await stat(path)).size; } catch { /* unreadable */ }
    return { path, size };
  }));
}
