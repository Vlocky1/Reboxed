// Online track information: Deezer (always, no account) and Spotify (when its credentials are set).
// Spotify has no genre for most artists any more: a Spotify result takes the genre and label of the
// same recording on Deezer (same ISRC, or same artist and title).

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const key = (c) => `${norm(String(c.artist).split(',')[0])}|${norm(c.title)}`;

/** Spotify candidates completed from Deezer, then the Deezer candidates. */
export function mergeCandidates(spotify, deezer) {
  const out = spotify.map((s) => {
    const d = deezer.find((x) => s.isrc && x.isrc === s.isrc) ?? deezer.find((x) => key(x) === key(s));
    if (!d) return s;
    return {
      ...s,
      genres: [...new Set([...s.genres, ...d.genres])],
      genre: s.genre || d.genre,
      label: s.label || d.label,
      isrc: s.isrc || d.isrc,
      completedFrom: 'deezer',
    };
  });
  return [...out, ...deezer];
}

export class MetadataLookup {
  /** @param {{spotify: import('./spotify.js').Spotify, deezer: import('./deezer.js').Deezer, spotifyReady: () => boolean}} o */
  constructor({ spotify, deezer, spotifyReady }) {
    Object.assign(this, { spotify, deezer, spotifyReady });
  }

  /**
   * @param {object} q {title, artist} or {query}
   * @param {'deezer'|'spotify'} source the service the user chose
   * @param {{complete?: boolean, genres?: boolean, max?: number, duration?: number}} [opts] batch tagging:
   *   complete: false keeps Spotify results pure (no Deezer genres), genres / max / duration limit requests
   * @returns {Promise<{candidates: object[], errors: string[], sources: string[]}>}
   */
  async lookup(q, source = 'deezer', opts = {}) {
    if (source !== 'spotify') {
      const candidates = await this.deezer.lookup(q, opts);
      return { candidates, errors: [], sources: ['Deezer'] };
    }
    if (!this.spotifyReady()) throw new Error('Spotify is not set up: add your Client ID and Client Secret in Preferences > Library, or choose Deezer');
    const sp = await this.spotify.lookup(q, opts);
    if (opts.complete === false) return { candidates: sp, errors: [], sources: ['Spotify'] };
    // Spotify gives no genre for most artists: take it from the same recording on Deezer when found.
    const errors = [];
    const dz = sp.length ? await this.deezer.lookup(q).catch((err) => { errors.push(`genres from Deezer: ${err.message}`); return []; }) : [];
    return { candidates: mergeCandidates(sp, dz).filter((c) => c.source === 'spotify'), errors, sources: ['Spotify'] };
  }
}
