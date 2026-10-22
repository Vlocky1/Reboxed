// What MusicBrainz (free, no account) and Discogs (free personal token) say about a track's genre.
// Only raw tags here; shared/genre.js turns them into one DJ genre.
import { similarity, artistSimilarity, splitMix } from '../shared/autotag.js';

const UA = 'Reboxed/1.0 ( https://reboxed.github.io )';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rate limiter: at most one call every `gap` ms (MusicBrainz asks for one per second). */
function paced(gap) {
  let next = 0;
  return async (fn) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await wait(at - now);
    return fn();
  };
}

export class GenreSources {
  /** @param {{fetch: typeof fetch, discogsToken: () => string|null}} o */
  constructor({ fetch: f, discogsToken }) {
    this.fetch = f;
    this.discogsToken = discogsToken;
    this.mbPace = paced(1500);
    this.dcPace = paced(1100);
  }

  async json(url, headers = {}) {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await this.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
      if (res.status !== 429 && res.status !== 503) break;
      await wait(2000 * (attempt + 1)); // busy: wait and try again
    }
    if (res.status === 429 || res.status === 503) throw new Error(`${new URL(url).hostname}: too many requests`);
    if (!res.ok) throw new Error(`${new URL(url).hostname} error ${res.status}`);
    return res.json();
  }

  /**
   * MusicBrainz genres of the recording, its release group and its artist (vote counts as weights).
   * @returns {Promise<{source: 'musicbrainz', tags: string[], weights: number[]} | null>}
   */
  async musicbrainz({ artist, title, duration = 0 }) {
    const t = splitMix(title).title;
    const q = `recording:"${t.replace(/"/g, '')}"${artist ? ` AND artist:"${artist.split(/,|&| feat\.? /i)[0].trim().replace(/"/g, '')}"` : ''}`;
    const found = await this.mbPace(() => this.json(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=8&query=${encodeURIComponent(q)}`));
    // Every recording of this artist and title (the original, remasters, radio edits…) adds its tags:
    // one recording's tags are often few or odd. Albums are left out (compilations tag everything "pop").
    const mix = splitMix(title).mixName;
    // A remix is another track (a techno remix of a house song): only the same version counts.
    const sameVersion = (r) => { const m = splitMix(r.title).mixName; return !m || /original|extended|radio|edit|album|remaster/i.test(m) || (mix && similarity(m, mix) > 0.6); };
    const matches = (found.recordings ?? []).filter((r) => similarity(splitMix(r.title).title, t) > 0.7 && sameVersion(r)
      && (!artist || artistSimilarity((r['artist-credit'] ?? []).map((a) => a.name).join(', '), artist) > 0.6)
      && (!duration || !r.length || Math.abs(r.length / 1000 - duration) < 20));
    if (!matches.length) return null;
    const counts = new Map();
    const add = (list, factor) => (list ?? []).forEach((g) => counts.set(g.name, (counts.get(g.name) ?? 0) + (g.count || 1) * factor));
    matches.forEach((r) => add(r.tags, 1));
    const detail = await this.mbPace(() => this.json(`https://musicbrainz.org/ws/2/recording/${matches[0].id}?fmt=json&inc=genres+artists`)).catch(() => null);
    add(detail?.genres, 1.5);
    const artistId = (detail ?? matches[0])['artist-credit']?.[0]?.artist?.id;
    if (artistId && counts.size < 2) {
      const a = await this.mbPace(() => this.json(`https://musicbrainz.org/ws/2/artist/${artistId}?fmt=json&inc=genres+tags`)).catch(() => null);
      add(a?.genres, 0.5); add(a?.tags, 0.3); // an artist's genres are a weaker hint than the track's
    }
    if (!counts.size) return null;
    const sorted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
    // A tag one person added is a weak hint; several votes make it reliable.
    return { source: 'musicbrainz', tags: sorted.map(([n]) => n), weights: sorted.map(([, c]) => Math.min(1, 0.25 + 0.2 * c)) };
  }

  /**
   * Discogs styles of the release holding the track (needs a personal token: Preferences > Library).
   * @returns {Promise<{source: 'discogs', tags: string[]} | null>}
   */
  async discogs({ artist, title }) {
    const token = this.discogsToken();
    if (!token) return null;
    const t = splitMix(title).title;
    const params = new URLSearchParams({ type: 'release', track: t, per_page: '8' });
    if (artist) params.set('artist', artist.split(/,|&| feat\.? /i)[0].trim());
    const r = await this.dcPace(() => this.json(`https://api.discogs.com/database/search?${params}`, { Authorization: `Discogs token=${token}` }));
    const results = (r.results ?? []).filter((x) => x.style?.length || x.genre?.length);
    if (!results.length) return null;
    // Styles that come back on several releases of the track are the reliable ones.
    const counts = new Map();
    results.forEach((x, i) => [...(x.style ?? []), ...(x.genre ?? [])].forEach((s, k) => counts.set(s, (counts.get(s) ?? 0) + (k < (x.style?.length ?? 0) ? 1 : 0.4) / (1 + i * 0.3))));
    const sorted = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const top = sorted[0][1];
    return { source: 'discogs', tags: sorted.map(([n]) => n), weights: sorted.map(([, c]) => Math.max(0.3, c / top)) };
  }

  /** Check a Discogs token (Preferences > Library > Save). */
  async checkDiscogs(token) {
    await this.json('https://api.discogs.com/oauth/identity', { Authorization: `Discogs token=${token}` });
  }
}
