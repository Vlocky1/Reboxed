// Keyword search over in-memory tracks, modelled on Rekordbox's db::DbSearchEngine
// (rekordbox.exe 7.2.18: filter loop @ 0x141f24350, field set @ 0x141f24d20,
// per-field dispatch @ 0x141f24a60). No SQL: tracks are filtered in place, order preserved.

import { SearchString } from './normalize.js';

/**
 * @typedef {object} Track
 * @property {string|number} id
 * @property {string} [title]
 * @property {string} [album]
 * @property {string} [artist]
 * @property {string} [genre]
 * @property {string} [albumArtist]
 * @property {string} [composer]
 * @property {string} [remixer]
 * @property {string} [originalArtist]
 * @property {string} [label]
 * @property {string} [comments]
 * @property {string} [mixName]
 * @property {string} [grouping]
 * @property {number} [year]   0 or missing = unknown, never matches
 * @property {number} [bpm]    e.g. 128 or 127.5; 0 or missing = unknown, never matches
 * @property {string} [key]
 * @property {number} [rating] 0..5
 * @property {string} [color]
 * @property {string[]} [myTags]
 */

/** Text fields that get a precomputed search form. */
export const TEXT_FIELDS = Object.freeze([
  'title', 'album', 'artist', 'genre', 'albumArtist', 'composer', 'remixer',
  'originalArtist', 'label', 'comments', 'mixName', 'grouping',
]);

/** Field-selector entries, in the order of Rekordbox's search-target popup (0x141556bb0). */
export const SEARCH_FIELDS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'title', label: 'Track Title' },
  { id: 'artist', label: 'Artist' },
  { id: 'album', label: 'Album' },
  { id: 'genre', label: 'Genre' },
  { id: 'year', label: 'Year' },
  { id: 'bpm', label: 'BPM' },
  { id: 'composer', label: 'Composer' },
  { id: 'albumArtist', label: 'Album Artist' },
  { id: 'remixer', label: 'Remixer' },
  { id: 'label', label: 'Label' },
  { id: 'comments', label: 'Comments' },
  { id: 'originalArtist', label: 'Original Artist' },
  { id: 'mixName', label: 'Mix Name' },
  { id: 'grouping', label: 'Grouping' },
]);

// "All" field order from 0x141f24d20; year and BPM join only for numeric tokens.
const ALL_TEXT_ORDER = [
  'title', 'album', 'artist', 'genre', 'albumArtist', 'composer', 'remixer',
  'originalArtist', 'label',
];
const ALL_TAIL_ORDER = ['comments', 'mixName', 'grouping'];
const NUMERIC_TOKEN_RE = /^[0-9.]+$/;
const TOKEN_SPLIT_RE = /[ 　\t]+/;

/**
 * Split a query the way Rekordbox does (0x1414b8c30): on space, ideographic space and tab.
 * No quoted phrases, no operators.
 * @param {string} query
 * @returns {string[]}
 */
export function tokenize(query) {
  return String(query ?? '').split(TOKEN_SPLIT_RE).filter(Boolean);
}

/**
 * Wraps a track with precomputed search forms. Rebuild it when the track is edited.
 */
export class IndexedTrack {
  /**
   * @param {Track} track
   * @param {import('./normalize.js').NormalizeOptions} [options]
   */
  constructor(track, options) {
    this.track = track;
    /** @type {Record<string, SearchString>} */
    this.fields = {};
    for (const name of TEXT_FIELDS) this.fields[name] = new SearchString(track[name], options);
    this.yearText = track.year ? String(track.year) : '';
    this.bpmText = formatBpm(track.bpm);
  }
}

/**
 * BPM text as Rekordbox formats it for search ("%d.%02d" of BPM x 100), e.g. 128 -> "128.00".
 * @param {number|undefined} bpm
 */
export function formatBpm(bpm) {
  const bpm100 = Math.round((bpm ?? 0) * 100);
  if (bpm100 <= 0) return '';
  return `${Math.floor(bpm100 / 100)}.${String(bpm100 % 100).padStart(2, '0')}`;
}

/**
 * @param {Track[]} tracks
 * @param {import('./normalize.js').NormalizeOptions} [options]
 * @returns {IndexedTrack[]}
 */
export function buildIndex(tracks, options) {
  return tracks.map((t) => new IndexedTrack(t, options));
}

/** @typedef {{raw: string, search: SearchString}} QueryToken */

/**
 * Fields a token is tested against.
 * @param {QueryToken} token
 * @param {string} field
 */
function fieldsFor(token, field) {
  if (field !== 'all') return [field];
  return NUMERIC_TOKEN_RE.test(token.raw)
    ? [...ALL_TEXT_ORDER, 'year', 'bpm', ...ALL_TAIL_ORDER]
    : [...ALL_TEXT_ORDER, ...ALL_TAIL_ORDER];
}

/**
 * @param {IndexedTrack} entry
 * @param {string} field
 * @param {QueryToken} token
 */
function fieldMatches(entry, field, token) {
  // Year and BPM compare the raw token against formatted text (strstr in Rekordbox).
  if (field === 'year') return entry.yearText !== '' && entry.yearText.includes(token.raw);
  if (field === 'bpm') return entry.bpmText !== '' && entry.bpmText.includes(token.raw);
  const value = entry.fields[field];
  if (!value) throw new Error(`Unknown search field: ${field}`);
  return value.contains(token.search);
}

/**
 * Keyword search: a track survives if EVERY token is a substring of AT LEAST ONE field.
 * Returns matching tracks in their original order (no ranking).
 * @param {IndexedTrack[]} index
 * @param {string} query
 * @param {{field?: string, normalize?: import('./normalize.js').NormalizeOptions}} [opts]
 * @returns {IndexedTrack[]}
 */
export function searchTracks(index, query, opts = {}) {
  return index.filter(compileQuery(query, opts));
}

/**
 * Compile a query once into a predicate over IndexedTrack entries (for callers that filter
 * their own row objects, e.g. playlist rows that may repeat a track).
 * @param {string} query
 * @param {{field?: string, normalize?: import('./normalize.js').NormalizeOptions}} [opts]
 * @returns {(entry: IndexedTrack) => boolean}
 */
export function compileQuery(query, opts = {}) {
  const field = opts.field ?? 'all';
  const tokens = tokenize(query).map((raw) => ({ raw, search: new SearchString(raw, opts.normalize) }));
  if (tokens.length === 0) return () => true;
  const plan = tokens.map((token) => ({ token, fields: fieldsFor(token, field) }));
  return (entry) => plan.every(({ token, fields }) => fields.some((f) => fieldMatches(entry, f, token)));
}
