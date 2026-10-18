// Track Filter panel equivalent (Rekordbox browse::BrowseFilterView: BPM / KEY / RATING /
// COLOR / My Tag, each with an enable tick). Filters AND together and apply on top of the
// keyword search. BPM range 0-6% and My Tag "Match all / Match any" are confirmed from the
// binary; the exact Key/Rating/Color internals were not decompiled, so they are plain set
// membership here.

/**
 * @typedef {object} TrackFilterState
 * @property {{enabled: boolean, base: number, rangePercent: number}} [bpm] rangePercent 0..6
 * @property {{enabled: boolean, keys: string[]}} [key]
 * @property {{enabled: boolean, ratings: number[]}} [rating]
 * @property {{enabled: boolean, colors: string[]}} [color]
 * @property {{enabled: boolean, tags: string[], mode: 'all'|'any'}} [myTag]
 */

export const BPM_RANGE_PERCENTS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

/**
 * Build a predicate for the enabled filters. Disabled or empty filters pass everything.
 * @param {TrackFilterState} state
 * @returns {(track: import('./engine.js').Track) => boolean}
 */
export function compileTrackFilter(state = {}) {
  /** @type {((t: import('./engine.js').Track) => boolean)[]} */
  const checks = [];

  if (state.bpm?.enabled && state.bpm.base > 0) {
    const pct = Math.min(6, Math.max(0, state.bpm.rangePercent ?? 0));
    const tolerance = (state.bpm.base * pct) / 100;
    const lo = state.bpm.base - tolerance;
    const hi = state.bpm.base + tolerance;
    // Compare at 0.01 BPM resolution, as Rekordbox stores BPM x 100.
    checks.push((t) => t.bpm > 0 && Math.round(t.bpm * 100) >= Math.round(lo * 100)
      && Math.round(t.bpm * 100) <= Math.round(hi * 100));
  }
  if (state.key?.enabled && state.key.keys.length > 0) {
    const keys = new Set(state.key.keys);
    checks.push((t) => keys.has(t.key));
  }
  if (state.rating?.enabled && state.rating.ratings.length > 0) {
    const ratings = new Set(state.rating.ratings);
    checks.push((t) => ratings.has(t.rating ?? 0));
  }
  if (state.color?.enabled && state.color.colors.length > 0) {
    const colors = new Set(state.color.colors);
    checks.push((t) => colors.has(t.color));
  }
  if (state.myTag?.enabled && state.myTag.tags.length > 0) {
    const wanted = state.myTag.tags;
    checks.push(state.myTag.mode === 'any'
      ? (t) => wanted.some((tag) => t.myTags?.includes(tag))
      : (t) => wanted.every((tag) => t.myTags?.includes(tag)));
  }

  return (track) => checks.every((check) => check(track));
}

/**
 * Seed the BPM and Key filters from a track, like "Set [BPM] and [KEY] as those of the track
 * on MASTER DECK". Returns null fields when the track lacks them (Rekordbox shows a warning).
 * @param {import('./engine.js').Track} track
 */
export function filterSeedFromTrack(track) {
  return {
    bpm: track.bpm > 0 ? track.bpm : null,
    key: track.key || null,
  };
}
