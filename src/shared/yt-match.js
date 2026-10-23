// Which YouTube result is a Spotify track: same title, same artist, same length, and not another
// version (live, cover, sped up, karaoke…) unless the track itself is one.
import { similarity, artistList, splitMix, norm } from './autotag.js';

/** Words that mean another version than the studio track. */
const OTHER_VERSION = ['live', 'cover', 'karaoke', 'instrumental', 'sped up', 'speed up', 'slowed', 'reverb', 'nightcore', '8d', 'acoustic',
  'remix', 'bass boosted', 'reaction', 'tutorial', 'lesson', 'piano version', 'extended', 'mashup', 'loop', '1 hour', '10 hours', 'concert'];
/** Words of an upload that is the studio track. */
const GOOD = ['official audio', 'audio', 'provided to youtube', 'topic', 'lyrics', 'lyric video', 'official video', 'official music video', 'visualizer', 'clip officiel'];

const has = (text, word) => ` ${norm(text)} `.includes(` ${norm(word)} `);

/** "Song (feat. X)" -> "Song": videos often leave the featured artist out of the title. */
const noFeat = (s) => s.replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '').replace(/\s+(?:feat\.?|ft\.?)\s.*$/i, '').trim();

/**
 * YouTube search query for a track ("audio" brings the official uploads up; the second search,
 * for club music, goes without it). "AKKI (DE)" is searched as "AKKI".
 */
export const youtubeQuery = (t, { audio = true } = {}) => `${(artistList(t.artist)[0] ?? '').replace(/\s*\([^)]*\)$/, '')} ${noFeat(splitMix(t.title).title)} ${splitMix(t.title).mixName}${audio ? ' audio' : ''}`.replace(/\s+/g, ' ').trim();

/** Longer club versions a DJ is glad to get when the playlist has the radio edit. */
const LONG_VERSION = /\b(extended|original mix|club mix|extended mix|12" ?mix|dub mix)\b/i;

/**
 * Score of a YouTube result for a track (higher is better), or -1 when it is not this track.
 * @param {{title: string, artist: string, duration?: number}} t
 * @param {{title: string, channel?: string, duration?: number}} r
 * @param {{extended?: boolean}} [opts] extended: an Extended / Original Mix longer than the track is
 *   accepted (Spotify playlists often hold the radio edit of club tracks)
 */
export function matchScore(t, r, { extended = false } = {}) {
  const longer = extended && LONG_VERSION.test(r.title) && !LONG_VERSION.test(t.title) && r.duration > (t.duration || 0);
  const want = splitMix(t.title);
  want.title = noFeat(want.title);
  const text = `${r.title} ${r.channel ?? ''}`;
  // The title of the video has the track's title somewhere ("Artist - Title (Official Video)").
  const plain = norm(r.title).replace(/\b(official|music|video|audio|lyrics?|clip|officiel|hd|hq|4k)\b/g, ' ');
  const titleSim = Math.max(similarity(r.title, want.title), norm(plain).includes(norm(want.title)) ? 0.95 : 0,
    ...r.title.split(/\s[-–|:]\s/).map((part) => similarity(part, want.title)));
  if (titleSim < 0.55) return -1;
  const artists = artistList(t.artist);
  const artistHit = artists.some((a) => has(text, a) || similarity(r.channel?.replace(/ - Topic$|VEVO$/i, '') ?? '', a) > 0.8) ? 1 : 0;
  let s = 0.5 * titleSim + 0.25 * artistHit;
  if (longer) {
    if (r.duration > Math.max(600, (t.duration || 0) * 2.5)) return -1; // a DJ set, not the track
    s += 0.1;
  } else if (t.duration && r.duration) {
    const d = Math.abs(t.duration - r.duration);
    if (d > 30) return -1; // another edit, a mix, a compilation
    s += 0.2 * Math.max(0, 1 - d / 15);
  }
  for (const w of OTHER_VERSION) if (has(r.title, w) && !has(t.title, w) && !(longer && w === 'extended')) s -= 0.4;
  // Official uploads first: the "Artist - Topic" channel (the label's own upload of the studio
  // track, best audio), the artist's channel, then "Official Audio"; lyrics re-uploads come last.
  const channel = (r.channel ?? '').replace(/ - Topic$|VEVO$|\s*official$/i, '').trim();
  if (/ - Topic$/i.test(r.channel ?? '')) s += 0.15;
  else if (artists.some((a) => similarity(channel, a) > 0.85)) s += 0.12;
  if (GOOD.slice(0, 2).some((w) => has(text, w))) s += 0.08;
  else if (GOOD.some((w) => has(text, w))) s += 0.03;
  return s;
}

/** Best result for a track, or null when none is good enough. extended: see matchScore. */
export function bestYoutubeMatch(t, results, opts = {}) {
  let best = null;
  for (const r of results) {
    const s = matchScore(t, r, opts);
    if (s >= 0.6 && (!best || s > best.score)) best = { item: r, score: Math.round(s * 100) / 100, longer: !!opts.extended && LONG_VERSION.test(r.title) && r.duration > (t.duration || 0) + 30 };
  }
  return best;
}

/**
 * Find a track on YouTube: the studio version first; else (club music) a second search, where the
 * Extended / Original Mix counts too.
 * @param {(q: string) => Promise<object[]>} search
 */
export async function findOnYoutube(t, search) {
  const first = await search(youtubeQuery(t));
  const best = bestYoutubeMatch(t, first);
  if (best) return best;
  const second = await search(youtubeQuery(t, { audio: false }));
  return bestYoutubeMatch(t, [...first, ...second], { extended: true });
}
