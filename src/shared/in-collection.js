// "Is this track already in my collection?" for the download window: a result (a video, a SoundCloud
// track, a Spotify / Deezer track) is compared with the collection by its names and length. Same base
// title, same artist, same version (an Extended Mix is not the Radio Edit) and, when both are known,
// the same length within a few seconds.
import { similarity, artistSimilarity, splitMix, norm } from './autotag.js';
import { cleanTrackName } from './clean-name.js';

const FEAT = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.+$/gi;
/** Title without the mix name and the featured artists. */
const baseOf = (title) => norm(splitMix(String(title ?? '').replace(FEAT, '')).title);
/** The version, "" for the original one ("Original Mix", "Original", "Album Version"…). */
const mixOf = (title, mixName) => {
  const m = norm(mixName || splitMix(String(title ?? '').replace(FEAT, '')).mixName);
  return /^(original( mix)?|album version|main mix|original version)$/.test(m) ? '' : m;
};

const OTHER_WORK = /\b(remix|rmx|rework|bootleg|flip|vip|cover|live|acoustic|unplugged|instrumental|acapella|a cappella|remake|mashup|sped up|slowed)\b/;
const LENGTH_TOLERANCE = 5;   // seconds
const TITLE_MIN = 0.86;
const ARTIST_MIN = 0.7;

/** A track as compared (names cleaned like downloads are). */
export function comparable(t, { fromUpload = false } = {}) {
  const named = fromUpload ? cleanTrackName({ title: t.title, artist: t.artist }) : { title: t.title, artist: t.artist };
  return { base: baseOf(named.title), mix: mixOf(named.title, t.mixName), artist: String(named.artist ?? '').trim(), duration: Number(t.duration) || 0 };
}

/**
 * How well a candidate matches a collection track: null (not the same track) or a score (higher =
 * surer). Both are comparable().
 */
export function sameTrack(a, b) {
  if (!a.base || !b.base) return null;
  const title = a.base === b.base ? 1 : similarity(a.base, b.base);
  if (title < TITLE_MIN) return null;
  const hasArtists = a.artist && b.artist;
  const artist = hasArtists ? artistSimilarity(a.artist, b.artist) : 0;
  // an upload titled "Title" by a channel that is not the artist: the title and the length must agree
  if (hasArtists && artist < ARTIST_MIN && !(a.base.includes(norm(b.artist)) || b.base.includes(norm(a.artist)))) return null;
  const timed = a.duration > 0 && b.duration > 0;
  const close = timed && Math.abs(a.duration - b.duration) <= LENGTH_TOLERANCE;
  // two named versions that differ are two tracks, whatever their length
  if (a.mix && b.mix && similarity(a.mix, b.mix) < 0.8) return null;
  // one version named, the other not: a remix / live / acoustic… is another track; an edit or an
  // extended mix ("Song" vs "Song (Extended Mix)") can be the same file named differently, the length tells
  if (a.mix !== b.mix && !(a.mix && b.mix) && (OTHER_WORK.test(a.mix || b.mix) || !close)) return null;
  if (timed && !close) return null;
  if (!hasArtists && !(timed && close && title >= 0.95)) return null;
  return Math.round((title * 0.5 + (hasArtists ? artist : 0.6) * 0.3 + (close ? 0.2 : 0.1)) * 100) / 100;
}

/** The collection, ready to be asked "is this one already there?". */
export class CollectionIndex {
  /** @param {{id: string, title: string, artist?: string, duration?: number, mixName?: string}[]} tracks */
  constructor(tracks) {
    this.items = [];
    this.byWord = new Map();               // first word of the base title → items
    for (const t of tracks) {
      if (!t?.title) continue;
      const c = { ...comparable(t), id: t.id, track: t };
      if (!c.base) continue;
      this.items.push(c);
      const w = c.base.split(' ')[0];
      if (!this.byWord.has(w)) this.byWord.set(w, []);
      this.byWord.get(w).push(c);
    }
  }

  /**
   * The collection track a result already is, or null.
   * @param {{title: string, artist?: string, duration?: number, mixName?: string}} t
   * @param {{fromUpload?: boolean}} [o] fromUpload: a video / upload title ("Artist - Title (Official Video)", channel as artist)
   * @returns {null | {id: string, track: object, score: number}}
   */
  find(t, o = {}) {
    const c = comparable(t, o);
    if (!c.base) return null;
    // same first word first (cheap), then everything when that found nothing (a typo in the first word)
    const pool = this.byWord.get(c.base.split(' ')[0]) ?? [];
    let best = null;
    for (const list of [pool, this.items]) {
      for (const x of list) {
        const s = sameTrack(c, x);
        if (s !== null && (!best || s > best.score)) best = { id: x.id, track: x.track, score: s };
      }
      if (best) break;
    }
    return best;
  }
}
