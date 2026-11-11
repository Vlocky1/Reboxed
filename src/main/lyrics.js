// Lyrics lookup on LRCLIB (lrclib.net: free, open, no key; time-synced LRC lyrics), plus a ".lrc"
// file next to the music file when there is one. LRCLIB asks clients to say who they are (User-Agent).
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { bestLyrics, mainArtist, titleVariants } from '../shared/lrc.js';

const API = 'https://lrclib.net/api';

export class Lyrics {
  /** @param {{fetch: typeof fetch, userAgent: string}} o */
  constructor({ fetch: f, userAgent }) {
    this.fetch = f;
    this.headers = { 'User-Agent': userAgent, Accept: 'application/json' };
  }

  async search(params) {
    const url = `${API}/search?${new URLSearchParams(params)}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`LRCLIB: ${res.status}`);
    return res.json();
  }

  /**
   * Lyrics of a track: the best LRCLIB match over a few title / artist variants.
   * @param {{title: string, artist: string, duration?: number}} track
   * @returns {Promise<null | {source: string, id: number, synced: string|null, plain: string|null, instrumental: boolean, artist: string, title: string, album: string, duration: number}>}
   */
  async find(track) {
    const artists = [...new Set([track.artist, mainArtist(track.artist)].filter(Boolean))];
    const titles = titleVariants(track.title);
    let found = null;
    // precise searches first (title + artist), then free text
    for (const title of titles) {
      for (const artist of artists) {
        const r = bestLyrics(await this.search({ track_name: title, artist_name: artist }), track);
        if (r?.syncedLyrics) return shape(r);
        found ??= r;                                             // plain lyrics: keep looking for synced ones
      }
    }
    if (!found) found = bestLyrics(await this.search({ q: `${mainArtist(track.artist)} ${titles.at(-1)}`.trim() }), track);
    return found ? shape(found) : null;
  }

  /** Free search for the manual picker: every result, synced or not. */
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
