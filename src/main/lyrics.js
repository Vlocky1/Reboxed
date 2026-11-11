// Lyrics lookup, free sources only (no scraping of sites that forbid it):
//  1. a ".lrc" file next to the music file, then the lyrics stored in the file's own tags;
//  2. LRCLIB (lrclib.net: free, open, no key; time-synced LRC lyrics), searched several ways;
//  3. last: the subtitles a YouTube video's uploader wrote (official lyric / music videos), through
//     the yt-dlp the downloads already use. Automatic captions are never used (too wrong on songs).
// Synced lyrics end the search at once; text-only ones are kept while a synced version is looked for.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseFile } from 'music-metadata';
import { bestLyrics, embeddedLyrics, mainArtist, splitArtistTitle, titleVariants, toLrc, vttToLines } from '../shared/lrc.js';

const API = 'https://lrclib.net/api';
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class Lyrics {
  /**
   * @param {{fetch: typeof fetch, userAgent: string, youtube?: () => ({json: Function, search: Function, tools: Function} | null)}} o
   */
  constructor({ fetch: f, userAgent, youtube = () => null }) {
    this.fetch = f;
    this.youtube = youtube;
    this.headers = { 'User-Agent': userAgent, Accept: 'application/json' };
  }

  async search(params) {
    const url = `${API}/search?${new URLSearchParams(params)}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`LRCLIB: ${res.status}`);
    return res.json();
  }

  /**
   * Lyrics of a track from the online sources.
   * @param {{title: string, artist: string, duration?: number}} track
   * @param {{youtube?: boolean}} [opts]
   * @returns {Promise<null | {source: string, id: number|string, synced: string|null, plain: string|null, instrumental: boolean, artist: string, title: string, album: string, duration: number}>}
   */
  async find(track, { youtube = true } = {}) {
    let plain = null;
    const take = (r) => { if (r?.syncedLyrics) return shape(r); plain ??= r ?? null; return null; };
    // a. title + artist, with and without the mix / featuring; "Artist - Title" written in the title
    const split = splitArtistTitle(track.title);
    const tracks = [track, ...(split ? [{ ...track, ...split }] : [])];
    for (const tr of tracks) {
      const artists = [...new Set([tr.artist, mainArtist(tr.artist)].filter(Boolean))];
      for (const title of titleVariants(tr.title)) {
        for (const artist of artists.length ? artists : ['']) {
          const hit = take(bestLyrics(await this.search(artist ? { track_name: title, artist_name: artist } : { track_name: title }), tr));
          if (hit) return hit;
        }
      }
      // b. free text
      const hit = take(bestLyrics(await this.search({ q: `${mainArtist(tr.artist)} ${titleVariants(tr.title).at(-1)}`.trim() }), tr));
      if (hit) return hit;
    }
    // c. the title alone, whoever the artist is written as, if the length matches within 3 s
    if (track.duration) {
      const hit = take(bestLyrics(await this.search({ track_name: titleVariants((split ?? track).title).at(-1) }), track, { anyArtist: true, maxDelta: 3 }));
      if (hit) return hit;
    }
    // d. subtitles written for a YouTube video of the song
    if (youtube) {
      const yt = await this.fromYoutube(split && !track.artist ? { ...track, ...split } : track).catch(() => null);
      if (yt) return yt;
    }
    return plain ? shape(plain) : null;
  }

  /** The uploader's own subtitles of a matching YouTube video (lyric / music videos), as synced lyrics. */
  async fromYoutube(track) {
    const dl = this.youtube();
    if (!dl || !(await dl.tools()).ytdlp) return null;
    const title = titleVariants(track.title).at(-1);
    const artist = mainArtist(track.artist);
    const items = await dl.search(`${artist} ${title} lyrics`.trim(), 6, 'youtube');
    const want = norm(title), wantArtist = norm(artist);
    const candidates = items.filter((it) => {
      const name = norm(`${it.title} ${it.channel ?? ''}`);
      return name.includes(want) && (!wantArtist || name.includes(wantArtist)) && (!track.duration || !it.duration || Math.abs(it.duration - track.duration) < 150);
    }).slice(0, 2);                                                  // each video takes yt-dlp ~10-15 s to open
    for (const it of candidates) {
      const info = await dl.json(it.url, ['--skip-download']).catch(() => null);
      const subs = info?.subtitles ?? {};                            // uploader subtitles only (not automatic_captions)
      const langs = Object.keys(subs).filter((l) => l !== 'live_chat');
      const lang = ['en', 'fr', 'es', 'de', 'it', 'pt'].find((l) => langs.includes(l)) ?? langs.find((l) => !l.includes('-')) ?? langs[0];
      const vtt = subs[lang]?.find((s) => s.ext === 'vtt');
      if (!vtt?.url) continue;
      const res = await this.fetch(vtt.url, {}).catch(() => null);
      if (!res?.ok) continue;
      const lines = vttToLines(await res.text());
      if (lines.length < 6) continue;
      return {
        source: 'YouTube', id: info.id ?? it.id, synced: toLrc(lines), plain: null, instrumental: false,
        artist: info.uploader ?? it.channel ?? '', title: info.title ?? it.title ?? '', album: '', duration: info.duration ?? it.duration ?? 0, url: info.webpage_url ?? it.url,
      };
    }
    return null;
  }

  /** Free search for the manual picker: every LRCLIB result, synced or not. */
  async list(query) {
    const results = await this.search({ q: String(query ?? '').slice(0, 200) });
    return results.filter((r) => r.syncedLyrics || r.plainLyrics).slice(0, 20).map(shape);
  }
}

function shape(r) {
  return {
    source: 'LRCLIB', id: r.id, synced: r.syncedLyrics || null, plain: r.plainLyrics || null, instrumental: !!r.instrumental,
    artist: r.artistName ?? '', title: r.trackName ?? '', album: r.albumName ?? '', duration: r.duration ?? 0,
  };
}

/** "song.mp3" → the text of "song.lrc" next to it, or null. */
export async function sidecarLrc(audioPath) {
  if (typeof audioPath !== 'string' || !extname(audioPath)) return null;
  try {
    const text = await readFile(audioPath.slice(0, -extname(audioPath).length) + '.lrc', 'utf8');
    return text.length < 500000 ? text : null;
  } catch { return null; }
}

/**
 * Lyrics that come with the music file: a ".lrc" next to it, else the file's tags.
 * @returns {Promise<{source: 'file'|'tags', lrc: string|null, plain: string|null} | null>}
 */
export async function localLyrics(audioPath) {
  const side = await sidecarLrc(audioPath);
  if (side) { const synced = /\[\d{1,3}:\d{1,2}/.test(side); return { source: 'file', lrc: synced ? side : null, plain: synced ? null : side }; }
  if (typeof audioPath !== 'string' || !audioPath) return null;
  try {
    const { common } = await parseFile(audioPath, { duration: false, skipCovers: true });
    const found = embeddedLyrics(common.lyrics);
    return found ? { source: 'tags', ...found } : null;
  } catch { return null; }
}
