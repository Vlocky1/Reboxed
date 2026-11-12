// Followed Spotify / Deezer playlists (★ in the download window): the tracks a list had when it was
// followed (or last seen) are remembered; tracks added to it later show in New releases.
import { norm } from './autotag.js';

/** A track's identity in its list: the platform's id, else its names. */
export const trackKey = (t) => (t.spotifyId ? `sp:${t.spotifyId}`
  : t.deezerId ? `dz:${t.deezerId}`
    : `n:${norm(t.artist ?? '')}|${norm(t.title ?? '')}`);

const KEEP = 5000;

/** The entry stored when a list is followed: everything it holds now counts as seen. */
export function followEntry({ platform, url, name, src, cover = '' }, tracks) {
  return { platform, url, name, src, cover, known: [...new Set(tracks.map(trackKey))].slice(-KEEP), since: Date.now() };
}

/** The tracks of a list that were not there before. */
export function newTracks(entry, tracks) {
  const known = new Set(entry.known ?? []);
  const seen = new Set();
  return tracks.filter((t) => { const k = trackKey(t); if (known.has(k) || seen.has(k)) return false; seen.add(k); return true; });
}

/** The entry once its current tracks are seen. */
export function markListSeen(entry, tracks) {
  return { ...entry, known: [...new Set([...(entry.known ?? []), ...tracks.map(trackKey)])].slice(-KEEP) };
}
