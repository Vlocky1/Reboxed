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

/** A Deezer link → {kind: 'track'|'album'|'playlist', id}, or null (short links: resolve them first). */
export function deezerLink(url) {
  const m = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist)\/(\d+)/i.exec(String(url ?? ''));
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}

/** Short share links (link.deezer.com/s/…, deezer.page.link/…) that redirect to a deezer.com page. */
export const isDeezerShortLink = (url) => /^https?:\/\/(link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)\//i.test(String(url ?? '').trim());

/** A Deezer API track → what the download window lists (the audio is then found on YouTube). */
export function deezerTrack(t) {
  const version = t.title_version ? ` ${t.title_version}` : '';
  return {
    title: t.title_short ? `${t.title_short}${version}`.trim() : t.title ?? '',
    artist: t.artist?.name ?? '', duration: t.duration ?? 0, deezerId: t.id, isrc: t.isrc ?? '',
    album: t.album?.title ?? '', cover: t.album?.cover_medium ?? t.album?.cover_small ?? '',
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

  /** Tracks of a Deezer search (public API, no account). */
  async searchTracks(q, limit = 25) {
    return ((await this.get(`/search?limit=${limit}&q=${encodeURIComponent(String(q ?? '').slice(0, 200))}`)).data ?? []).filter((t) => t.type !== 'podcast').map(deezerTrack);
  }

  /**
   * A Deezer track / album / playlist link → its name and tracks (up to 2000).
   * @returns {Promise<{kind: string, name: string, tracks: object[], via: 'deezer'}>}
   */
  async readLink(url) {
    let link = deezerLink(url);
    if (!link && isDeezerShortLink(url)) {
      const res = await this.fetch(String(url).trim(), { redirect: 'follow' });
      link = deezerLink(res.url) ?? deezerLink(await res.text().catch(() => ''));
    }
    if (!link) throw new Error('Not a Deezer track, album or playlist link');
    if (link.kind === 'track') {
      const t = await this.get(`/track/${link.id}`);
      return { kind: 'track', name: `${t.artist?.name ?? ''} - ${t.title ?? ''}`, tracks: [deezerTrack(t)], via: 'deezer' };
    }
    const head = await this.get(`/${link.kind}/${link.id}`);
    const tracks = [];
    let next = `/${link.kind}/${link.id}/tracks?limit=100&index=0`;
    while (next && tracks.length < 2000) {
      const page = await this.get(next.replace(API, ''));
      // album tracks carry no album: the album's own cover and title
      for (const t of page.data ?? []) tracks.push(deezerTrack(link.kind === 'album' ? { ...t, album: t.album ?? head } : t));
      next = page.next ?? null;
    }
    return { kind: link.kind, name: head.title ?? 'Deezer playlist', tracks: tracks.filter((t) => t.title), via: 'deezer' };
  }

  async album(id) {
    if (!this.albums.has(id)) this.albums.set(id, this.get(`/album/${id}`).catch(() => ({})));
    return this.albums.get(id);
  }

  /**
   * Candidates for a track, best first (details of the first `max`).
   * @param {{title: string, artist?: string, query?: string}} q
   * @param {{max?: number, duration?: number}} [opts] batch tagging asks fewer details (Deezer allows
   *   50 requests / 5 s); with a duration, the results closest to it get their details first
   */
  async lookup({ title, artist, query }, { max = 6, duration = 0 } = {}) {
    const clean = (s) => String(s ?? '').replace(/["]/g, ' ').replace(/\s+/g, ' ').trim();
    const tries = query ? [clean(query)] : [`${clean(artist?.split(/,|&| feat\.? | ft\.? /i)[0])} ${clean(splitMix(title).title)}`.trim(), clean(splitMix(title).title)];
    let items = [];
    for (const q of [...new Set(tries)]) {
      if (!q) continue;
      items = (await this.get(`/search?limit=10&q=${encodeURIComponent(q)}`)).data ?? [];
      if (items.length) break;
    }
    const out = [];
    if (duration) items = items.map((it, i) => [it, i]).sort((a, b) => (Math.abs((a[0].duration ?? 0) - duration) > 3) - (Math.abs((b[0].duration ?? 0) - duration) > 3) || a[1] - b[1]).map(([it]) => it);
    for (const it of items.slice(0, max)) {
      const tr = await this.get(`/track/${it.id}`).catch(() => it);
      out.push(deezerFields(tr, tr.album?.id ? await this.album(tr.album.id) : {}));
    }
    return out;
  }
}
