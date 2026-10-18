import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSmartList, evaluateSmartList, defaultCondition } from '../src/shared/smartlist.js';
import { findRelated, DEFAULT_RELATED } from '../src/shared/related.js';

const tracks = [
  { id: 1, title: 'Strobe', artist: 'deadmau5', genre: 'Progressive House', bpm: 128, key: '8A', year: 2009, rating: 5, color: 'Blue', myTags: ['Peak'], dateAdded: '2026-10-10', path: 'C:\\m\\strobe.mp3', label: 'mau5trap' },
  { id: 2, title: 'Opus', artist: 'Eric Prydz', genre: 'progressive house', bpm: 126, key: '9A', year: 2015, rating: 4, myTags: ['Peak', 'Long'], dateAdded: '2026-01-01', path: 'C:\\m\\opus.flac' },
  { id: 3, title: 'Sandstorm', artist: 'Darude', genre: 'Trance', bpm: 136, key: '4A', year: 1999, rating: 3, color: 'Red', dateAdded: '2026-10-15', path: 'C:\\m\\sand.mp3' },
  { id: 4, title: 'Liquid DnB', artist: 'Someone feat. deadmau5', genre: 'Drum & Bass', bpm: 256, key: '8B', year: 2010, rating: 2, dateAdded: '2025-05-05', path: 'C:\\m\\dnb.wav', label: 'mau5trap' },
  { id: 5, title: 'Halftime (deadmau5 edit)', artist: 'X', genre: 'Halftime', bpm: 64, key: '7A', year: 2011, rating: 0, dateAdded: '2026-10-16', path: 'C:\\m\\half.mp3' },
];
const now = new Date('2026-10-16T12:00:00Z');
const ids = (list) => list.map((t) => (t.track ?? t).id);
const smart = (match, ...conditions) => tracks.filter(compileSmartList({ match, conditions }, now));

test('smart list text operators are case/width-insensitive', () => {
  assert.deepEqual(ids(smart('all', { field: 'genre', op: 'contains', value: 'PROGRESSIVE' })), [1, 2]);
  assert.deepEqual(ids(smart('all', { field: 'genre', op: 'notContains', value: 'house' })), [3, 4, 5]);
  assert.deepEqual(ids(smart('all', { field: 'title', op: 'startsWith', value: 'ｓａｎｄ' })), [3]);
  assert.deepEqual(ids(smart('all', { field: 'fileName', op: 'endsWith', value: '.flac' })), [2]);
  assert.deepEqual(ids(smart('all', { field: 'genre', op: 'is', value: 'trance' })), [3]);
});

test('smart list numbers, dates, keys, tags, colors; all vs any', () => {
  assert.deepEqual(ids(smart('all', { field: 'bpm', op: 'range', value: 125, value2: 130 })), [1, 2]);
  assert.deepEqual(ids(smart('all', { field: 'rating', op: 'gte', value: 4 })), [1, 2]);
  assert.deepEqual(ids(smart('all', { field: 'dateAdded', op: 'inLast', value: 7 })), [1, 3, 5]);
  assert.deepEqual(ids(smart('all', { field: 'dateAdded', op: 'range', value: '2026-01-01', value2: '2026-10-10' })), [1, 2]);
  assert.deepEqual(ids(smart('all', { field: 'key', op: 'compatible', value: '8A' })), [1, 2, 4, 5]); // 8A 9A 8B 7A
  assert.deepEqual(ids(smart('all', { field: 'myTags', op: 'has', value: 'Long' })), [2]);
  assert.deepEqual(ids(smart('all', { field: 'color', op: 'is', value: 'Red' })), [3]);
  assert.deepEqual(ids(smart('all', { field: 'bpm', op: 'gte', value: 125 }, { field: 'year', op: 'lte', value: 2009 })), [1, 3]);
  assert.deepEqual(ids(smart('any', { field: 'color', op: 'is', value: 'Red' }, { field: 'rating', op: 'is', value: 5 })), [1, 3]);
  assert.deepEqual(ids(smart('all')), []);
});

test('smart list limit keeps the most recently added', () => {
  const r = evaluateSmartList({ match: 'all', conditions: [{ field: 'bpm', op: 'gte', value: 0 }], limit: 2 }, tracks, now);
  assert.deepEqual(ids(r), [5, 3]);
  assert.equal(defaultCondition('bpm').op, 'range');
});

test('related tracks: BPM with double/half + compatible key, ranked', () => {
  const r = findRelated(tracks, tracks[0], DEFAULT_RELATED);
  // 256 (=128x2)/8B and 64 (=128/2)/7A are exact tempo matches, so they rank above 126/9A.
  assert.deepEqual(ids(r), [4, 5, 2]);
  const noDouble = findRelated(tracks, tracks[0], { ...DEFAULT_RELATED, bpm: { on: true, pct: 6, doubleHalf: false } });
  assert.deepEqual(ids(noDouble), [2]);
});

test('related tracks: artist incl. feat. and title mentions, match any', () => {
  const c = { ...DEFAULT_RELATED, match: 'any', bpm: { on: false }, key: { on: false }, artist: { on: true, includeFeat: true } };
  assert.deepEqual(ids(findRelated(tracks, tracks[0], c)), [4, 5]);
  const strict = { ...c, artist: { on: true, includeFeat: false } };
  assert.deepEqual(ids(findRelated(tracks, tracks[0], strict)), [4]);
  const label = { ...c, artist: { on: false }, label: { on: true } };
  assert.deepEqual(ids(findRelated(tracks, tracks[0], label)), [4]);
  assert.deepEqual(findRelated(tracks, null, c), []);
});
