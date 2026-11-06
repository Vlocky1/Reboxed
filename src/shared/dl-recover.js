// Finding a downloaded file for sure, and the downloads already lost: until 1.21 the path yt-dlp
// printed was read in the wrong encoding, so a title with an accent, Japanese or an emoji gave a path
// that does not exist ("Beyonc� - D�j� Vu.mp3"). The file was on disk, but never reached the library.

/** Name without extension, reduced to plain letters and digits: the part both spellings share. */
export const asciiKey = (path) => String(path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').normalize('NFC')
  .replace(/[^\x20-\x7e]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * The file of a finished download: the path yt-dlp reported, else the name it announced before
 * downloading with the final extension (a post-processing step such as the cover can fail after the
 * audio is already converted).
 * @param {string|null} reported
 * @param {string|null} expected path announced before the download (its extension is the source's)
 * @param {string} format 'mp3', 'm4a', 'flac', 'wav'
 * @param {(path: string) => Promise<boolean>} usable the file exists and is not empty
 * @returns {Promise<string|null>}
 */
export async function locateDownload(reported, expected, format, usable) {
  if (reported && await usable(reported)) return reported;
  if (!expected) return null;
  const final = `${expected.replace(/\.[^.\\/]+$/, '')}.${format}`;
  if (await usable(final)) return final;
  return await usable(expected) ? expected : null;
}

/**
 * Which file on disk each lost download is. Only an answer without doubt counts: one file for the
 * name, not already in the library, with enough of the name left to compare.
 * @param {{id: string, path: string}[]} lost downloads whose recorded path does not exist
 * @param {string[]} files audio files of the download folder that are not in the library
 * @returns {{id: string, path: string}[]}
 */
export function matchLostDownloads(lost, files) {
  const byKey = new Map();
  for (const f of files) { const k = asciiKey(f); byKey.set(k, [...(byKey.get(k) ?? []), f]); }
  const taken = new Set();
  const out = [];
  for (const l of lost) {
    const k = asciiKey(l.path);
    const hit = byKey.get(k);
    if (k.length < 3 || hit?.length !== 1 || taken.has(hit[0])) continue;
    taken.add(hit[0]);
    out.push({ id: l.id, path: hit[0] });
  }
  return out;
}
