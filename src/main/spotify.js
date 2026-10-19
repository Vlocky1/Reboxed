// Track information lookup on Spotify (Web API, client credentials flow: no user login). The user
// creates a free app on developer.spotify.com and pastes its Client ID / Client Secret in
// Preferences > Library; the secret is encrypted with the OS keychain (safeStorage) on this machine.
// Development-mode limits (2026): 10 search results, no album label / popularity. Genres come from
// the artist (Spotify gives no genre per track).

const API = 'https://api.spotify.com/v1';

/** "Song - Extended Mix" / "Song (Extended Mix)" -> {title: 'Song', mixName: 'Extended Mix'}. */
export function splitMix(name) {
  const m = /^(.*?)\s*(?:-\s+|\()([^()]*\b(?:mix|remix|edit|version|dub|rework|bootleg|vip)\b[^()]*)\)?\s*$/i.exec(name ?? '');
  return m && m[1] ? { title: m[1].trim(), mixName: m[2].trim() } : { title: name ?? '', mixName: '' };
}

const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Spotify track (+ its first artist's genres) -> Reboxed track fields. */
export function toFields(tr, genres = []) {
  const { title, mixName } = splitMix(tr.name);
  const album = tr.album ?? {};
  const images = album.images ?? [];
  return {
    spotifyId: tr.id,
    spotifyUrl: tr.external_urls?.spotify ?? '',
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
   * Candidates for a track, best first.
   * @param {{title: string, artist?: string, query?: string}} q
   */
  async lookup({ title, artist, query }) {
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
    for (const id of [...new Set(items.map((t) => t.artists?.[0]?.id).filter(Boolean))].slice(0, 5)) {
      try { genres.set(id, (await this.get(`/artists/${id}`)).genres ?? []); } catch { genres.set(id, []); }
    }
    return items.map((t) => toFields(t, genres.get(t.artists?.[0]?.id) ?? []));
  }
}
