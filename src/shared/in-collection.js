// "Is this track already in my collection?" for the download window. A result (a video, a
// SoundCloud upload, a Spotify / Deezer track) is compared with every collection track under
// several readings of their names: as written, cleaned like downloads are (with the user's
// keywords), "Artist - Title (- Label)" split whatever the channel, "Title - Artist", without a
// "Genre | " prefix. Old downloads whose title is still the video's are read the same way.
// Same base title + same artist + same version, and the same length within a few seconds: sure.
// Same names but another length (album version vs radio edit, a clip with an intro): maybe; the
// sound decides after the download (see duplicates.js).
import { similarity, artistSimilarity, splitMix, norm } from './autotag.js';
import { cleanTrackName, cleanTitle, cleanArtist } from './clean-name.js';

const FEAT = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.|ft\.|feat\s|ft\s|featuring\s).+$/gi;
const ORIGINAL = /^(original( mix| version)?|album version|main mix|extended original mix)$/;
const OTHER_WORK = /\b(remix|rmx|rework|bootleg|flip|vip|cover|live|acoustic|unplugged|instrumental|acapella|a cappella|remake|mashup|sped up|slowed|nightcore)\b/;
const LENGTH_TOLERANCE = 5;       // seconds: same file, another encoder / platform
const BARE_TOLERANCE = 2;         // seconds: a match on the title alone (no artist on one side)
const TITLE_MIN = 0.86;
const ARTIST_MIN = 0.7;

/** Full-width signs ("｜", "＊"), emojis and stray symbols as plain text. */
const plain = (s) => String(s ?? '').normalize('NFKC')
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
  .replace(/[‐-―]/g, (c) => (c === '‐' || c === '‑' ? '-' : ' - '))
  .replace(/\s{2,}/g, ' ').trim();

const baseOf = (title) => norm(splitMix(String(title ?? '').replace(FEAT, '')).title);
const mixOf = (title, mixName) => {
  const m = norm(mixName || splitMix(String(title ?? '').replace(FEAT, '')).mixName);
  return ORIGINAL.test(m) ? '' : m;
};
const words = (s) => norm(s).split(' ').filter((w) => w.length > 1);

/**
 * The readings of a name worth comparing ({title, artist} pairs, the first one the most likely).
 * @param {{title?: string, artist?: string}} t
 * @param {string[]} [keywords] the name cleaner's keywords (Preferences > Downloads)
 */
export function nameReadings(t, keywords, { upload = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (title, artist) => {
    title = String(title ?? '').trim(); artist = cleanArtist(artist ?? '');
    const k = `${norm(title)}|${norm(artist)}`;
    if (title && !seen.has(k)) { seen.add(k); out.push({ title, artist }); }
  };
  const raw = plain(t.title);
  const artist = plain(t.artist);
  const c = cleanTrackName({ title: raw, artist }, keywords);
  add(c.title, c.artist);
  // "Genre | Artist - Title | Lyrics": the part with a dash, else the longest
  let s = cleanTitle(raw, keywords);
  const segs = s.split(/\s*\|\s*/).filter(Boolean);
  if (segs.length > 1) s = cleanTitle(segs.find((x) => /\s-\s/.test(x)) ?? [...segs].sort((a, b) => b.length - a.length)[0], keywords);
  const parts = s.split(/\s-\s/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    add(parts[1], parts[0]);              // Artist - Title (- Label / - Channel)
    add(parts[0], parts[1]);              // Title - Artist
    if (parts.length >= 3) add(parts.slice(1).join(' - '), parts[0]);
  }
  add(s, artist);
  if (artist && upload) add(c.title, '');   // an uploader (channel) may not be the artist at all
  return out;
}

/** One reading as compared. */
const comparable = (r, duration, mixName) => ({ base: baseOf(r.title), mix: mixOf(r.title, mixName), artist: r.artist, duration: Number(duration) || 0 });

const sameMix = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (similarity(a, b) >= 0.8) return true;
  const wa = new Set(a.split(' ')); const wb = new Set(b.split(' '));
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return [...small].every((w) => big.has(w));     // "edit" ⊂ "dvb trance edit"
};

/**
 * Two readings: null (not the same track) or {score, sure}. sure: the lengths agree too.
 */
export function sameTrack(a, b) {
  if (!a.base || !b.base) return null;
  const title = a.base === b.base ? 1 : similarity(a.base, b.base);
  if (title < TITLE_MIN) return null;
  const hasArtists = !!(a.artist && b.artist);
  const artist = hasArtists ? artistSimilarity(a.artist, b.artist) : 0;
  if (hasArtists && artist < ARTIST_MIN) return null;
  // versions: a remix / live / other named work is another track; two named mixes must agree
  if (a.mix !== b.mix) {
    if (a.mix && b.mix && !sameMix(a.mix, b.mix)) return null;
    if (!(a.mix && b.mix) && OTHER_WORK.test(a.mix || b.mix)) return null;
  }
  const timed = a.duration > 0 && b.duration > 0;
  const dd = timed ? Math.abs(a.duration - b.duration) : Infinity;
  const close = dd <= LENGTH_TOLERANCE;
  if (!hasArtists) {
    // a title alone: only with the same length to the second and a title that is not too generic
    if (!(dd <= BARE_TOLERANCE && title >= 0.95 && a.base.length >= 4)) return null;
    return { score: Math.round((0.5 * title + 0.18 + 0.2) * 100) / 100, sure: true };
  }
  // same names, another length (or an edit named on one side only and not the same length to the
  // second): maybe, the sound will tell
  const sure = a.mix !== b.mix && !(a.mix && b.mix) ? dd <= BARE_TOLERANCE : close;
  return { score: Math.round((0.5 * title + 0.3 * artist + (sure ? 0.2 : 0)) * 100) / 100, sure };
}

/**
 * Last resort for titles without a dash ("Martin Garrix Lauv MAD Official Video"): every word of
 * the collection title and of its main artist is in the result's name, and the length agrees.
 */
function wordsMatch(qWords, qDuration, item) {
  if (!item.needed || !(qDuration > 0 && item.duration > 0 && Math.abs(qDuration - item.duration) <= BARE_TOLERANCE)) return false;
  // "Dynamite (Hardstyle Remix)" is not "Dynamite"
  const extra = [...qWords].filter((w) => OTHER_WORK.test(w) && !item.allWords.has(w));
  return !extra.length && item.needed.every((w) => qWords.has(w));
}

/** The words a result's name must hold to be this track by the words alone (null: not usable). */
function neededWords(t) {
  const tw = words(baseOf(plain(t.title))); const aw = words(plain(t.artist).split(/,|&| x | and |;/i)[0]);
  return tw.join('').length >= 3 && aw.length ? [...tw, ...aw] : null;
}

/** The collection, ready to be asked "is this one already there?". */
export class CollectionIndex {
  /**
   * @param {{id: string, title: string, artist?: string, duration?: number, mixName?: string}[]} tracks
   * @param {{keywords?: string[]}} [o]
   */
  constructor(tracks, { keywords } = {}) {
    this.keywords = keywords;
    this.items = [];
    this.byWord = new Map();           // word of a base title → readings
    for (const t of tracks) {
      if (!t?.title) continue;
      const readings = nameReadings(t, keywords, { upload: false }).map((r) => ({ ...comparable(r, t.duration, t.mixName), id: t.id, track: t }));
      const item = { id: t.id, track: t, duration: Number(t.duration) || 0, readings, needed: neededWords(t),
        allWords: new Set(words(`${plain(t.title)} ${plain(t.mixName)}`)) };
      this.items.push(item);
      for (const r of readings) {
        for (const w of new Set(r.base.split(' ').filter((x) => x.length > 1))) {
          if (!this.byWord.has(w)) this.byWord.set(w, []);
          this.byWord.get(w).push(r);
        }
      }
    }
    this.common = Math.max(60, tracks.length / 15);   // words in more titles than this are not used to look up
  }

  /**
   * The collection track a result already is, or null.
   * @param {{title: string, artist?: string, duration?: number, mixName?: string}} t
   * @returns {null | {id: string, track: object, score: number, sure: boolean}}
   */
  find(t, o = {}) { return this.findAll(t, o)[0] ?? null; }

  /**
   * Every collection track a result may be, the surest first.
   * @param {{id?: string, title: string, artist?: string, duration?: number, mixName?: string}} t
   * @param {{upload?: boolean}} [o] upload: the artist is a channel / uploader, maybe not the artist
   * @returns {{id: string, track: object, score: number, sure: boolean}[]}
   */
  findAll(t, { upload = false } = {}) {
    const readings = nameReadings(t, this.keywords, { upload }).map((r) => comparable(r, t.duration, t.mixName));
    const found = new Map();
    const keep = (x, r) => {
      if (!r || x.id === t.id) return;
      const b = found.get(x.id);
      if (!b || (r.sure && !b.sure) || (r.sure === b.sure && r.score > b.score)) found.set(x.id, { id: x.id, track: x.track, ...r });
    };
    for (const q of readings) {
      if (!q.base) continue;
      const pool = new Set();
      const ws = q.base.split(' ').filter((x) => x.length > 1);
      for (const w of ws) { const l = this.byWord.get(w); if (l && l.length <= this.common) l.forEach((x) => pool.add(x)); }
      if (!pool.size) for (const w of ws) (this.byWord.get(w) ?? []).forEach((x) => pool.add(x));
      for (const x of pool) keep(x, sameTrack(q, x));
    }
    if (![...found.values()].some((x) => x.sure)) {
      const qWords = new Set(words(`${plain(t.artist)} ${plain(t.title)}`));
      const dur = Number(t.duration) || 0;
      for (const x of this.items) if (wordsMatch(qWords, dur, x)) keep(x, { score: 0.7, sure: true });
    }
    return [...found.values()].sort((a, b) => (b.sure - a.sure) || (b.score - a.score));
  }
}
