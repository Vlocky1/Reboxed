// Track information lookup on Spotify (Web API, client credentials flow: no user login). The user
// creates a free app on developer.spotify.com and pastes its Client ID / Client Secret in
// Preferences > Library; the secret is encrypted with the OS keychain (safeStorage) on this machine.
// Development-mode limits (2026): 10 search results, no album label / popularity. Genres come from
// the artist (Spotify gives no genre per track).

import { splitMix } from '../shared/autotag.js';

export { splitMix };

const API = 'https://api.spotify.com/v1';

const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Spotify track (+ its first artist's genres) -> Reboxed track fields. */
export function toFields(tr, genres = []) {
  const { title, mixName } = splitMix(tr.name);
  const album = tr.album ?? {};
  const images = album.images ?? [];
  return {
    source: 'spotify',
    spotifyId: tr.id,
    url: tr.external_urls?.spotify ?? '',
    title,
    mixName,
    artist: (tr.artists ?? []).map((a) => a.name).join(', '),
    album: album.name ?? '',
    albumArtist: (album.artists ?? []).map((a) => a.name).join(', '),
    genre: genres.length ? titleCase(genres[0]) : '',
    genres: genres.map(titleCase),
    year: Number(String(album.release_date ?? '').slice(0, 4)) || 0,
    trackNumber: tr.track_number ?? 0,
    discNumber: tr.disc_number ?? 0,
    label: album.label ?? '',
    isrc: tr.external_ids?.isrc ?? '',
    duration: (tr.duration_ms ?? 0) / 1000,
    artworkUrl: images[0]?.url ?? '',
    thumbUrl: images.at(-1)?.url ?? images[0]?.url ?? '',
  };
}

/** A Spotify playlist / album link (or spotify:playlist:… URI) -> {kind, id}, or null. */
export function spotifyLink(url) {
  const m = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]{16,})/.exec(String(url ?? '').trim());
  return m ? { kind: m[1], id: m[2] } : null;
}

/**
 * Tracks of a playlist / album from Spotify's public embed page (no account; also the playlists
 * Spotify itself makes, which the Web API refuses to new apps).
 * @param {string} html the embed page
 */
export function embedTracks(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Spotify page not understood');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw new Error('No tracks on this Spotify page');
  return {
    name: entity.name ?? entity.title ?? 'Spotify playlist',
    tracks: entity.trackList.map((t) => ({ title: t.title ?? '', artist: (t.subtitle ?? '').replace(/ /g, ' '), duration: (t.duration ?? 0) / 1000, spotifyId: String(t.uri ?? '').split(':').pop() }))
      .filter((t) => t.title),
  };
}

export class Spotify {
  /** @param {{get: () => {clientId, secret}|null, fetch?: typeof fetch}} opts */
  constructor({ credentials, fetch: f = fetch }) {
    this.credentials = credentials;
    this.fetch = f;
    this.token = null;
  }

  async auth() {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const c = this.credentials();
    if (!c?.clientId || !c?.secret) throw new Error('Spotify is not set up: add your Client ID and Client Secret in Preferences > Library');
    const res = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? 'Spotify refused the Client ID / Client Secret' : `Spotify login failed (${res.status})`);
    const j = await res.json();
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return this.token.value;
  }

  forget() { this.token = null; }

  async get(path) {
    const res = await this.fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.auth()}` } });
    if (res.status === 401) { this.token = null; throw new Error('Spotify session expired, try again'); }
    if (res.status === 429) throw new Error('Spotify: too many requests, wait a moment');
    if (!res.ok) throw new Error(`Spotify error ${res.status}`);
    return res.json();
  }

  /**
   * Every track of a playlist or album: title, artists, duration (Web API when the credentials are
   * set, else / when it refuses, the public embed page, which may stop at 100 tracks).
   * @param {string} url Spotify link
   * @param {boolean} [useApi]
   * @returns {Promise<{name: string, tracks: {title: string, artist: string, duration: number, spotifyId: string, isrc?: string}[], via: string}>}
   */
  async playlist(url, useApi = true) {
    const link = spotifyLink(url);
    if (!link) throw new Error('Not a Spotify playlist or album link');
    if (useApi) {
      try {
        const head = await this.get(`/${link.kind}s/${link.id}?fields=name`);
        const tracks = [];
        let next = `/${link.kind}s/${link.id}/tracks?limit=${link.kind === 'album' ? 50 : 100}`;
        while (next && tracks.length < 2000) {
          const page = await this.get(next.replace(API, ''));
          for (const it of page.items ?? []) {
            const tr = it.track ?? it; // playlist items wrap the track, album items are the track
            if (!tr?.name || tr.is_local || tr.type === 'episode') continue;
            tracks.push({ title: tr.name, artist: (tr.artists ?? []).map((a) => a.name).join(', '), duration: (tr.duration_ms ?? 0) / 1000, spotifyId: tr.id ?? '', isrc: tr.external_ids?.isrc ?? '' });
          }
          next = page.next;
        }
        return { name: head.name ?? 'Spotify playlist', tracks, via: 'api' };
      } catch (err) {
        if (/not set up|refused/.test(err.message) === false && !/40[34]/.test(err.message)) throw err;
      }
    }
    const res = await this.fetch(`https://open.spotify.com/embed/${link.kind}/${link.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'This Spotify playlist is private or does not exist' : `Spotify error ${res.status}`);
    return { ...embedTracks(await res.text()), via: 'embed' };
  }

  /**
   * Candidates for a track, best first.
   * @param {{title: string, artist?: string, query?: string}} q
   * @param {{genres?: boolean}} [opts] genres: false skips the artist requests (batch tagging without genre)
   */
  async lookup({ title, artist, query }, { genres: withGenres = true } = {}) {
    const clean = (s) => String(s ?? '').replace(/["]/g, ' ').trim();
    const tries = query ? [clean(query)] : [
      `track:"${clean(splitMix(title).title)}"${artist ? ` artist:"${clean(artist.split(/,|&| feat\.? | ft\.? /i)[0])}"` : ''}`,
      `${clean(artist)} ${clean(title)}`.trim(),
    ];
    let items = [];
    for (const q of tries) {
      if (!q) continue;
      const r = await this.get(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
      items = r.tracks?.items ?? [];
      if (items.length) break;
    }
    // Genres of each first artist (one request per distinct artist: batch endpoints are gone).
    const genres = new Map();
    for (const id of withGenres ? [...new Set(items.map((t) => t.artists?.[0]?.id).filter(Boolean))].slice(0, 5) : []) {
      try { genres.set(id, (await this.get(`/artists/${id}`)).genres ?? []); } catch { genres.set(id, []); }
    }
    return items.map((t) => toFields(t, genres.get(t.artists?.[0]?.id) ?? []));
  }
}
