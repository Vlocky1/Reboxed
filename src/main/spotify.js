// Track information lookup on Spotify (Web API, client credentials flow: no user login). The user
// creates a free app on developer.spotify.com and pastes its Client ID / Client Secret in
// Preferences > Library; the secret is encrypted with the OS keychain (safeStorage) on this machine.
// Development-mode limits (2026): 10 search results, no album label / popularity. Genres come from
// the artist (Spotify gives no genre per track).

import { splitMix } from '../shared/autotag.js';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

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

/** A Spotify track / playlist / album link (or spotify:…:… URI) -> {kind, id}, or null. */
export function spotifyLink(url) {
  const m = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(playlist|album|track)[/:]([A-Za-z0-9]{16,})/.exec(String(url ?? '').trim());
  return m ? { kind: m[1], id: m[2] } : null;
}

/** One track from Spotify's public embed page of a track. */
export function embedTrack(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Spotify page not understood');
  const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  const title = e?.name ?? e?.title;
  if (!title) throw new Error('No track on this Spotify page');
  const artist = (e.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || String(e.subtitle ?? '').replace(/ /g, ' ');
  return { title, artist, duration: (e.duration ?? 0) / 1000, spotifyId: String(e.uri ?? e.id ?? '').split(':').pop(), cover: e.visualIdentity?.image?.[0]?.url ?? e.coverArt?.sources?.[0]?.url ?? '' };
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

// ---- Spotify account (Authorization Code with PKCE) ------------------------------------------------
// Since 2026 Spotify gives the tracks of a playlist only to an app with a signed-in user. The user
// signs in once in the browser, on their own Spotify app (redirect URI below); Reboxed keeps the
// refresh token (encrypted) and reads whole playlists, and the user's own, with the official Web API.

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const SCOPES = 'playlist-read-private playlist-read-collaborative';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE pair: the verifier kept here, the challenge sent with the sign-in. */
export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** The Spotify sign-in page for the user's app. */
export function authorizeUrl({ clientId, challenge, state, redirectUri = REDIRECT_URI, scopes = SCOPES }) {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, code_challenge_method: 'S256', code_challenge: challenge, state, scope: scopes });
  return `https://accounts.spotify.com/authorize?${q}`;
}

/** A cover the app may fetch: Spotify (i.scdn.co, mosaic.scdn.co, image-cdn-*.spotifycdn.com) or Deezer images. */
export const isCoverUrl = (url) => /^https:\/\/([a-z0-9-]+\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com|cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net)\//.test(String(url ?? ''));

/**
 * An album's images -> {cover, coverLarge}: the smallest at least 64 px wide (lists), the largest
 * (the collection's artwork). Spotify lists them largest first; widths may be missing (null).
 */
export function covers(images) {
  const list = (images ?? []).filter((i) => i?.url);
  if (!list.length) return { cover: '', coverLarge: '' };
  const sized = list.filter((i) => i.width > 0).sort((a, b) => a.width - b.width);
  if (!sized.length) return { cover: list.at(-1).url, coverLarge: list[0].url };
  return { cover: (sized.find((i) => i.width >= 64) ?? sized.at(-1)).url, coverLarge: sized.at(-1).url };
}

/** One playlist entry -> track fields (2026 playlist items carry `item`, older ones `track`). */
export function itemTrack(it) {
  const tr = it?.item ?? it?.track ?? it;
  if (!tr?.name || tr.is_local || tr.type === 'episode') return null;
  return { title: tr.name, artist: (tr.artists ?? []).map((a) => a.name).join(', '), duration: (tr.duration_ms ?? 0) / 1000, spotifyId: tr.id ?? '', isrc: tr.external_ids?.isrc ?? '', album: tr.album?.name ?? '', ...covers(tr.album?.images) };
}

/**
 * Wait for the browser to come back to the redirect URI with the sign-in code (one request, then the
 * little server closes). Resolves with the code; rejects on refusal, wrong state or timeout.
 */
export function waitForCode({ state, port = 8888, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>Reboxed</title><body style="background:#0b0d12;color:#e8ecf3;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p style="color:#9aa3b2">${text}</p></div>`;
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? page('Spotify is connected', 'You can close this tab and go back to Reboxed.') : page('Spotify was not connected', err === 'access_denied' ? 'The access was refused.' : 'Go back to Reboxed and try again.'));
      done(ok ? null : new Error(err === 'access_denied' ? 'Spotify: access refused' : 'Spotify sign-in failed, try again'), ok ? u.searchParams.get('code') : null);
    });
    const timer = setTimeout(() => done(new Error('Spotify sign-in: no answer within 3 minutes')), timeoutMs);
    let finished = false;
    function done(err, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err); else resolve(code);
    }
    server.on('error', (e) => done(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is busy: close what uses it, then try again` : e.message)));
    server.listen(port, '127.0.0.1');
  });
}

export class Spotify {
  /**
   * @param {{credentials: () => {clientId, secret}|null, account?: {get: () => string|null, set: (refresh: string|null) => Promise<void>}, fetch?: typeof fetch}} opts
   *   account: the user's refresh token (stored encrypted by the caller)
   */
  constructor({ credentials, account = null, fetch: f = fetch }) {
    this.credentials = credentials;
    this.account = account;
    this.fetch = f;
    this.token = null;
    this.userToken = null;
  }

  /** Signed in with a Spotify account (whole playlists, "my playlists"). */
  get signedIn() { return !!this.account?.get(); }

  /**
   * Sign in: the browser opens Spotify's page, the user accepts, the code comes back to the
   * redirect URI; it is exchanged for tokens. open: opens a URL in the browser.
   */
  async signIn(open) {
    const c = this.credentials();
    if (!c?.clientId) throw new Error('Add your Spotify Client ID first (Preferences > Library)');
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(12));
    const waiting = waitForCode({ state });
    waiting.catch(() => {}); // awaited below; never an unhandled rejection if the browser fails to open
    await open(authorizeUrl({ clientId: c.clientId, challenge, state }));
    const code = await waiting;
    const res = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: c.clientId, code_verifier: verifier }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(/redirect_uri/i.test(j.error_description ?? '') ? `Spotify refused the redirect URI: add ${REDIRECT_URI} to your Spotify app (developer.spotify.com/dashboard)` : `Spotify sign-in failed (${j.error_description ?? res.status})`);
    this.userToken = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 60) * 1000 };
    await this.account?.set(j.refresh_token ?? null);
    return this.me();
  }

  async signOut() { this.userToken = null; await this.account?.set(null); }

  /** The user's access token (refreshed when needed). */
  async userAuth() {
    if (this.userToken && this.userToken.until > Date.now()) return this.userToken.value;
    const refresh = this.account?.get();
    const c = this.credentials();
    if (!refresh || !c?.clientId) throw new Error('Spotify account not connected');
    const res = await this.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.clientId }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') await this.account?.set(null); // revoked: signed out
      throw new Error(j.error === 'invalid_grant' ? 'Spotify account disconnected: connect it again' : `Spotify session failed (${res.status})`);
    }
    this.userToken = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 60) * 1000 };
    if (j.refresh_token && j.refresh_token !== refresh) await this.account?.set(j.refresh_token); // rotated
    return this.userToken.value;
  }

  /** Web API as the signed-in user. */
  async userGet(path) {
    const res = await this.fetch(path.startsWith('http') ? path : `${API}${path}`, { headers: { Authorization: `Bearer ${await this.userAuth()}` } });
    if (res.status === 401) { this.userToken = null; throw new Error('Spotify session expired, try again'); }
    if (res.status === 429) throw new Error('Spotify: too many requests, wait a moment');
    if (!res.ok) { const e = new Error(`Spotify error ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }

  /** The signed-in account: {name, id}. */
  async me() {
    const j = await this.userGet('/me');
    return { id: j.id, name: j.display_name || j.id };
  }

  /** The user's playlists (own and followed): name, link, track count, cover. */
  async myPlaylists() {
    const out = [];
    let next = '/me/playlists?limit=50';
    while (next && out.length < 1000) {
      const page = await this.userGet(next);
      for (const p of page.items ?? []) {
        if (!p?.id) continue;
        out.push({ id: p.id, name: p.name, url: `https://open.spotify.com/playlist/${p.id}`, total: p.items?.total ?? p.tracks?.total ?? 0, owner: p.owner?.display_name ?? p.owner?.id ?? '', cover: p.images?.at(-1)?.url ?? p.images?.[0]?.url ?? '' });
      }
      next = page.next;
    }
    return out;
  }

  /** Every track of a playlist / album as the signed-in user (paged, up to 2000). */
  async userList(link) {
    const head = await this.userGet(`/${link.kind}s/${link.id}?fields=name`).catch(() => ({}));
    const tracks = [];
    const paths = link.kind === 'album' ? [`/albums/${link.id}/tracks?limit=50`] : [`/playlists/${link.id}/items?limit=50`, `/playlists/${link.id}/tracks?limit=100`];
    let lastErr = null;
    for (const first of paths) {
      try {
        let next = first;
        while (next && tracks.length < 2000) {
          const page = await this.userGet(next);
          for (const it of page.items ?? []) { const t = itemTrack(it); if (t) tracks.push(t); }
          next = page.next;
        }
        return { kind: link.kind, name: head.name ?? 'Spotify playlist', tracks, via: 'account' };
      } catch (err) { lastErr = err; if (err.status !== 404 && err.status !== 403) throw err; tracks.length = 0; }
    }
    throw lastErr ?? new Error('Spotify refused this list');
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
    if (!link) throw new Error('Not a Spotify track, playlist or album link');
    if (link.kind === 'track') {
      if (useApi) {
        try {
          const tr = await this.get(`/tracks/${link.id}`);
          const t = { title: tr.name, artist: (tr.artists ?? []).map((a) => a.name).join(', '), duration: (tr.duration_ms ?? 0) / 1000, spotifyId: tr.id, isrc: tr.external_ids?.isrc ?? '', ...covers(tr.album?.images) };
          return { kind: 'track', name: `${t.artist} - ${t.title}`, tracks: [t], via: 'api' };
        } catch (err) {
          if (/not set up|refused/.test(err.message) === false && !/40[34]/.test(err.message)) throw err;
        }
      }
      const res = await this.fetch(`https://open.spotify.com/embed/track/${link.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' } });
      if (!res.ok) throw new Error(res.status === 404 ? 'This Spotify track does not exist' : `Spotify error ${res.status}`);
      const t = embedTrack(await res.text());
      return { kind: 'track', name: `${t.artist} - ${t.title}`, tracks: [t], via: 'embed' };
    }
    // signed in: the whole list, from the official Web API as the user
    let accountErr = null;
    if (this.signedIn) {
      try { return await this.userList(link); } catch (err) { accountErr = err; }
    }
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
            tracks.push({ title: tr.name, artist: (tr.artists ?? []).map((a) => a.name).join(', '), duration: (tr.duration_ms ?? 0) / 1000, spotifyId: tr.id ?? '', isrc: tr.external_ids?.isrc ?? '', album: tr.album?.name ?? '', ...covers(tr.album?.images) });
          }
          next = page.next;
        }
        return { kind: link.kind, name: head.name ?? 'Spotify playlist', tracks, via: 'api' };
      } catch (err) {
        if (/not set up|refused/.test(err.message) === false && !/40[34]/.test(err.message)) throw err;
      }
    }
    const res = await this.fetch(`https://open.spotify.com/embed/${link.kind}/${link.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'This Spotify playlist is private or does not exist' : `Spotify error ${res.status}`);
    return { kind: link.kind, ...embedTracks(await res.text()), via: 'embed', accountError: accountErr?.message ?? null };
  }

  /** Tracks of a Spotify search (needs the user's Spotify keys). */
  async searchTracks(q) {
    const r = await this.get(`/search?type=track&limit=10&q=${encodeURIComponent(String(q ?? '').slice(0, 200))}`);
    return (r.tracks?.items ?? []).map((tr) => ({
      title: tr.name, artist: (tr.artists ?? []).map((a) => a.name).join(', '), duration: (tr.duration_ms ?? 0) / 1000,
      spotifyId: tr.id, isrc: tr.external_ids?.isrc ?? '', album: tr.album?.name ?? '', ...covers(tr.album?.images),
    }));
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
