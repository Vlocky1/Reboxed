// Intelligent playlists: a list of conditions combined with "match all" / "match any",
// re-evaluated against the collection whenever it changes (Rekordbox smartlist semantics:
// text contains / does not contain / starts with / ends with, numeric and date ranges,
// "in the last N days").
import { normalizeForSearch } from '../search/normalize.js';
import { compatibleKeys } from './keys.js';

export const SMART_FIELDS = {
  title: { label: 'Track Title', type: 'text' },
  artist: { label: 'Artist', type: 'text' },
  album: { label: 'Album', type: 'text' },
  albumArtist: { label: 'Album Artist', type: 'text' },
  genre: { label: 'Genre', type: 'text' },
  comments: { label: 'Comments', type: 'text' },
  composer: { label: 'Composer', type: 'text' },
  label: { label: 'Label', type: 'text' },
  mixName: { label: 'Mix Name', type: 'text' },
  originalArtist: { label: 'Original Artist', type: 'text' },
  remixer: { label: 'Remixer', type: 'text' },
  grouping: { label: 'Grouping', type: 'text' },
  fileName: { label: 'File Name', type: 'text', get: (t) => String(t.path ?? '').split(/[\\/]/).pop() },
  key: { label: 'Key', type: 'key' },
  myTags: { label: 'My Tag', type: 'tags' },
  color: { label: 'Color', type: 'enum' },
  bpm: { label: 'BPM', type: 'number' },
  year: { label: 'Year', type: 'number' },
  rating: { label: 'Rating', type: 'number' },
  playCount: { label: 'DJ Play Count', type: 'number' },
  duration: { label: 'Time (sec)', type: 'number' },
  dateAdded: { label: 'Date Added', type: 'date' },
};

export const SMART_OPS = {
  text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is'], ['isNot', 'is not'], ['startsWith', 'starts with'], ['endsWith', 'ends with']],
  key: [['is', 'is'], ['isNot', 'is not'], ['compatible', 'is compatible with']],
  tags: [['has', 'has'], ['hasNot', 'does not have']],
  enum: [['is', 'is'], ['isNot', 'is not']],
  number: [['range', 'is in the range'], ['is', 'is'], ['gte', 'is at least'], ['lte', 'is at most']],
  date: [['inLast', 'is in the last (days)'], ['notInLast', 'is not in the last (days)'], ['range', 'is in the range']],
};

/** @typedef {{field: string, op: string, value: any, value2?: any}} Condition */
/** @typedef {{match: 'all'|'any', conditions: Condition[], limit?: number}} SmartRules */

const DAY = 86400000;

function compileCondition(c, now) {
  const def = SMART_FIELDS[c.field];
  if (!def) return () => false;
  const get = def.get ?? ((t) => t[c.field]);
  switch (def.type) {
    case 'text': {
      const needle = normalizeForSearch(c.value ?? '');
      const norm = (t) => normalizeForSearch(get(t) ?? '');
      switch (c.op) {
        case 'contains': return (t) => norm(t).includes(needle);
        case 'notContains': return (t) => !norm(t).includes(needle);
        case 'is': return (t) => norm(t) === needle;
        case 'isNot': return (t) => norm(t) !== needle;
        case 'startsWith': return (t) => norm(t).startsWith(needle);
        case 'endsWith': return (t) => norm(t).endsWith(needle);
        default: return () => false;
      }
    }
    case 'key': {
      if (c.op === 'compatible') { const set = new Set(compatibleKeys(c.value)); return (t) => set.has(get(t)); }
      return c.op === 'isNot' ? (t) => get(t) !== c.value : (t) => get(t) === c.value;
    }
    case 'tags': {
      const has = (t) => (get(t) ?? []).includes(c.value);
      return c.op === 'hasNot' ? (t) => !has(t) : has;
    }
    case 'enum': return c.op === 'isNot' ? (t) => (get(t) ?? '') !== c.value : (t) => (get(t) ?? '') === c.value;
    case 'number': {
      const a = Number(c.value); const b = Number(c.value2);
      const val = (t) => Number(get(t) ?? 0);
      switch (c.op) {
        case 'range': return (t) => val(t) >= Math.min(a, b) && val(t) <= Math.max(a, b);
        case 'is': return (t) => Math.abs(val(t) - a) < 1e-6;
        case 'gte': return (t) => val(t) >= a;
        case 'lte': return (t) => val(t) <= a;
        default: return () => false;
      }
    }
    case 'date': {
      const ts = (t) => Date.parse(get(t) ?? '') || 0;
      if (c.op === 'inLast' || c.op === 'notInLast') {
        const since = now.getTime() - Number(c.value) * DAY;
        return c.op === 'inLast' ? (t) => ts(t) >= since : (t) => ts(t) < since;
      }
      const lo = Date.parse(c.value) || 0; const hi = (Date.parse(c.value2) || Infinity) + DAY - 1;
      return (t) => ts(t) >= lo && ts(t) <= hi;
    }
    default: return () => false;
  }
}

/**
 * @param {SmartRules} rules
 * @param {Date} [now]
 * @returns {(track: object) => boolean}
 */
export function compileSmartList(rules, now = new Date()) {
  const preds = (rules.conditions ?? []).map((c) => compileCondition(c, now));
  if (preds.length === 0) return () => false;
  return rules.match === 'any' ? (t) => preds.some((p) => p(t)) : (t) => preds.every((p) => p(t));
}

/** Evaluate a smart list over tracks, honouring an optional limit (most recently added first). */
export function evaluateSmartList(rules, tracks, now = new Date()) {
  const pred = compileSmartList(rules, now);
  const out = tracks.filter(pred);
  if (rules.limit > 0) {
    out.sort((a, b) => String(b.dateAdded ?? '').localeCompare(String(a.dateAdded ?? '')));
    return out.slice(0, rules.limit);
  }
  return out;
}

/** A sensible new condition for a field. */
export function defaultCondition(field = 'genre') {
  const type = SMART_FIELDS[field]?.type ?? 'text';
  const op = SMART_OPS[type][0][0];
  const value = { text: '', key: '8A', tags: '', enum: 'Red', number: type === 'number' && field === 'bpm' ? 120 : 0, date: 30 }[type];
  return { field, op, value, value2: field === 'bpm' ? 130 : type === 'number' ? 0 : '' };
}
