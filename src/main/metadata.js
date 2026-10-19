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

  /** @returns {Promise<{candidates: object[], errors: string[], sources: string[]}>} */
  async lookup(q) {
    const errors = [];
    const useSpotify = this.spotifyReady();
    const fail = (name) => (err) => { errors.push(`${name}: ${err.message}`); return []; };
    const [sp, dz] = await Promise.all([
      useSpotify ? this.spotify.lookup(q).catch(fail('Spotify')) : [],
      this.deezer.lookup(q).catch(fail('Deezer')),
    ]);
    return { candidates: mergeCandidates(sp, dz), errors, sources: useSpotify ? ['Spotify', 'Deezer'] : ['Deezer'] };
  }
}
