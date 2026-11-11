// Lyrics: LRC parsing / writing, the line playing at a time, and picking the best LRCLIB result for a
// track. Shared by the main process (search) and both windows (display, manual sync).

/** BroadcastChannel between the decks' window and the lyrics window. */
export const LYRICS_CHANNEL = 'reboxed-lyrics';

const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)\]/g;

/**
 * LRC text → lines sorted by time. A line can carry several stamps ("[00:12.00][01:30.50]chorus");
 * the [offset:+/-ms] tag is folded into the times (LRC: a positive offset shows the lyrics sooner).
 * @param {string} text
 * @returns {{t: number, text: string}[]}
 */
export function parseLrc(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const words = raw.replace(STAMP, '').replace(/<\d{1,3}:\d{1,2}(?:[.,]\d{1,3})?>/g, '').trim();   // drop word-level <mm:ss.xx>
    for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2].replace(',', '.')), text: words });
  }
  for (const l of lines) l.t = Math.max(0, l.t - offset);
  return lines.sort((a, b) => a.t - b.t);
}

/** Seconds → "mm:ss.xx". */
export function formatStamp(t) {
  const cs = Math.max(0, Math.round(t * 100));
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Lines → LRC text (one stamp per line). */
export function toLrc(lines) {
  return lines.map((l) => `[${formatStamp(l.t)}]${l.text}`).join('\n');
}

/** Plain text → lines without times (t = null), empty lines kept as breaks. */
export function plainLines(text) {
  return String(text ?? '').split(/\r?\n/).map((s) => ({ t: null, text: s.trim() }));
}

/**
 * Index of the line sung at time t (lyrics time = track time - offset), -1 before the first line.
 * Lines without a time are skipped.
 */
export function lineAt(lines, t, offset = 0) {
  const x = t - offset;
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lt = lines[mid].t;
    if (lt === null || lt === undefined || lt <= x) { if (lt !== null && lt !== undefined) found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** How far through line i we are at t (0..1), for the karaoke fill. */
export function lineProgress(lines, i, t, offset = 0) {
  if (i < 0 || !lines[i]) return 0;
  const start = lines[i].t + offset;
  const next = lines.slice(i + 1).find((l) => l.t !== null && l.t !== undefined);
  const end = next ? next.t + offset : start + 4;
  return Math.max(0, Math.min(1, (t - start) / Math.max(0.3, Math.min(end - start, 8))));
}

/** Mix / version words that lyrics sites leave out of titles. */
const MIX = /\s*[([][^)\]]*\b(mix|edit|remix|version|vip|dub|extended|original|radio|club|instrumental|acapella|a cappella|bootleg|rework|remaster(ed)?|live|feat\.?|ft\.?)\b[^)\]]*[)\]]/gi;

/** Title variants to search, most precise first: as is, without the mix in brackets, without "feat.". */
export function titleVariants(title) {
  const base = String(title ?? '').trim();
  const out = [base];
  const noMix = base.replace(MIX, '').trim();
  if (noMix) out.push(noMix);
  const noFeat = noMix.replace(/\s+(feat\.?|ft\.?|featuring)\s.+$/i, '').trim();
  if (noFeat) out.push(noFeat);
  return [...new Set(out.filter(Boolean))];
}

/** "Artist - Title" written in the title field (downloads): {artist, title}, or null. */
export function splitArtistTitle(title) {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(String(title ?? '').trim());
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

/**
 * WebVTT subtitles → lines. Rolling captions (a cue repeating the previous text) are merged; tags,
 * entities and "[Music]"-like cues are dropped.
 */
export function vttToLines(vtt) {
  const out = [];
  const time = (s) => { const p = s.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  for (const block of String(vtt ?? '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const t = time(lines[at].split('-->')[0]);
    const text = lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&(#?\w+);/g, (m, k) => ent[k] ?? m).replace(/[♪♫]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || /^[[(].*[\])]$/.test(text) || !Number.isFinite(t)) continue;
    const last = out.at(-1);
    if (last && (last.text === text || text.startsWith(last.text) && t - last.t < 1.5)) { last.text = text; continue; }
    out.push({ t, text });
  }
  return out;
}

/**
 * Lyrics stored in the music file's tags (music-metadata common.lyrics): synchronized ones (times in
 * ms) as LRC, else the text (an LRC text in a plain tag stays LRC).
 * @returns {{lrc: string|null, plain: string|null} | null}
 */
export function embeddedLyrics(tags) {
  for (const tag of tags ?? []) {
    const sync = (tag?.syncText ?? []).filter((s) => Number.isFinite(s.timestamp) && s.text?.trim());
    if (sync.length >= 3 && tag.timeStampFormat === 2) return { lrc: toLrc(sync.map((s) => ({ t: s.timestamp / 1000, text: s.text.trim() }))), plain: null };
  }
  for (const tag of tags ?? []) {
    const text = (typeof tag === 'string' ? tag : tag?.text ?? '').trim();
    if (!text) continue;
    if (parseLrc(text).length >= 3) return { lrc: text, plain: null };
    return { lrc: null, plain: text };
  }
  return null;
}

/** The main artist ("A, B", "A & B", "A feat. B", "A x B" → "A"). */
export function mainArtist(artist) {
  return String(artist ?? '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?)\s*/i)[0].trim();
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(MIX, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Best LRCLIB result for a track: same title and artist, synced lyrics preferred, then the duration
 * closest to the track's. Returns null when nothing has the right title.
 * @param {{trackName: string, artistName: string, duration: number, syncedLyrics?: string, plainLyrics?: string, instrumental?: boolean}[]} results
 * @param {{title: string, artist: string, duration?: number}} track
 */
export function bestLyrics(results, track, { anyArtist = false, maxDelta = Infinity } = {}) {
  const wantTitle = norm(titleVariants(track.title).at(-1));
  const wantArtist = anyArtist ? '' : norm(mainArtist(track.artist));
  let best = null, bestScore = -Infinity;
  for (const r of results ?? []) {
    if (!r || (!r.syncedLyrics && !r.plainLyrics && !r.instrumental)) continue;
    const title = norm(r.trackName);
    if (!title || !(title === wantTitle || title.startsWith(`${wantTitle} `) || wantTitle.startsWith(`${title} `))) continue;
    const artist = norm(r.artistName);
    const artistOk = !wantArtist || artist.includes(wantArtist) || wantArtist.includes(artist);
    if (!artistOk) continue;
    const dd = track.duration ? Math.abs((r.duration ?? 0) - track.duration) : 0;
    if (dd > maxDelta) continue;
    const score = (r.syncedLyrics ? 1000 : 0) + (title === wantTitle ? 50 : 0) - Math.min(dd, 600);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}
