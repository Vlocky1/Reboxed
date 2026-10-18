export { normalizeForSearch, charClassMask, SearchString } from './normalize.js';
export {
  TEXT_FIELDS, SEARCH_FIELDS, tokenize, formatBpm, IndexedTrack, buildIndex, searchTracks, compileQuery,
} from './engine.js';
export { BPM_RANGE_PERCENTS, compileTrackFilter, filterSeedFromTrack } from './filters.js';
export { SearchController, TYPING_DELAY_MS } from './controller.js';

import { buildIndex, searchTracks } from './engine.js';
import { compileTrackFilter } from './filters.js';

/**
 * Convenience wrapper: one index per track list (collection or playlist), searched with
 * keywords and then narrowed by the Track Filter. Keeps normalization options consistent.
 */
export class TrackLibrary {
  /**
   * @param {import('./engine.js').Track[]} tracks in the list's current sort order
   * @param {import('./normalize.js').NormalizeOptions} [normalize]
   */
  constructor(tracks, normalize = {}) {
    this.normalize = normalize;
    this.index = buildIndex(tracks, normalize);
  }

  /**
   * @param {string} query
   * @param {{field?: string, filter?: import('./filters.js').TrackFilterState}} [opts]
   * @returns {import('./engine.js').Track[]}
   */
  search(query, opts = {}) {
    const passes = compileTrackFilter(opts.filter);
    return searchTracks(this.index, query, { field: opts.field, normalize: this.normalize })
      .map((entry) => entry.track)
      .filter(passes);
  }
}
