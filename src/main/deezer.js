// Track information lookup on Deezer (public API, no account or key). Deezer gives genres (per
// album), label, release date, track / disc number, ISRC and covers.
import { splitMix } from './spotify.js';

const API = 'https://api.deezer.com';

/** Deezer track + its album -> Reboxed track fields (same shape as Spotify's). */
export function deezerFields(tr, album = {}) {
  const { title, mixName } = splitMix(tr.title_version ? `${tr.title_short ?? tr.title} (${tr.title_version.replace(/^\(|\)$/g, '')})` : tr.title);
  const artists = (tr.contributors?.length ? tr.contributors : [tr.artist]).filter(Boolean).map((a) => a.name);
  const genres = (album.genres?.data ?? []).map((g) => g.name);
  const date = tr.release_date || album.release_date || tr.album?.release_date || '';
  return {
    source: 'deezer',
    deezerId: tr.id,
    url: tr.link ?? '',
    title,
    mixName,
    artist: [...new Set(artists)].join(', '),
    album: tr.album?.title ?? album.title ?? '',
    albumArtist: album.artist?.name ?? '',
    genre: genres[0] ?? '',
    genres,
    year: Number(String(date).slice(0, 4)) || 0,
    trackNumber: tr.track_position ?? 0,
    discNumber: tr.disk_number ?? 0,
    label: album.label ?? '',
    isrc: tr.isrc ?? '',
    duration: tr.duration ?? 0,
    artworkUrl: tr.album?.cover_xl ?? album.cover_xl ?? tr.album?.cover_big ?? '',
    thumbUrl: tr.album?.cover_medium ?? album.cover_medium ?? '',
  };
}

export class Deezer {
  constructor({ fetch: f = fetch } = {}) {
    this.fetch = f;
    this.albums = new Map();
  }

  async get(path) {
    const res = await this.fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`Deezer error ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Deezer: ${j.error.message ?? j.error.type ?? 'error'}`);
    return j;
  }

  async album(id) {
    if (!this.albums.has(id)) this.albums.set(id, this.get(`/album/${id}`).catch(() => ({})));
    return this.albums.get(id);
  }

  /**
   * Candidates for a track, best first (details of the first 6).
   * @param {{title: string, artist?: string, query?: string}} q
   */
  async lookup({ title, artist, query }) {
    const clean = (s) => String(s ?? '').replace(/["]/g, ' ').replace(/\s+/g, ' ').trim();
    const tries = query ? [clean(query)] : [`${clean(artist?.split(/,|&| feat\.? | ft\.? /i)[0])} ${clean(splitMix(title).title)}`.trim(), clean(splitMix(title).title)];
    let items = [];
    for (const q of [...new Set(tries)]) {
      if (!q) continue;
      items = (await this.get(`/search?limit=10&q=${encodeURIComponent(q)}`)).data ?? [];
      if (items.length) break;
    }
    const out = [];
    for (const it of items.slice(0, 6)) {
      const tr = await this.get(`/track/${it.id}`).catch(() => it);
      out.push(deezerFields(tr, tr.album?.id ? await this.album(tr.album.id) : {}));
    }
    return out;
  }
}
