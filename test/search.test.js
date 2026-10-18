import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForSearch, charClassMask, SearchString, tokenize, formatBpm,
  TrackLibrary, compileTrackFilter, SearchController,
} from '../src/search/index.js';

const tracks = [
  { id: 1, title: 'Strobe', artist: 'deadmau5', album: 'For Lack of a Better Name', genre: 'Progressive House', year: 2009, bpm: 128, key: '8A', rating: 5, color: 'Blue', myTags: ['Peak', 'Long'] },
  { id: 2, title: 'Café del Mar', artist: 'Energy 52', genre: 'Trance', year: 1993, bpm: 133.5, key: '10A', rating: 4, myTags: ['Classic'] },
  { id: 3, title: 'Ｏｐｕｓ', artist: 'Eric Prydz', genre: 'Progressive House', year: 2015, bpm: 126, key: '1A', rating: 5, myTags: ['Peak'] },
  { id: 4, title: 'Sandstorm', artist: 'Darude', genre: 'Trance', comments: 'Øresund opener', year: 1999, bpm: 136, key: '4A', rating: 3, color: 'Red' },
  { id: 5, title: 'Untitled', artist: 'Unknown', year: 0, bpm: 0 },
];
const lib = new TrackLibrary(tracks);
const ids = (list) => list.map((t) => t.id);

test('normalization: NFKD, extra folds, uppercase', () => {
  assert.equal(normalizeForSearch('Ｏｐｕｓ'), 'OPUS');           // full-width -> half-width
  assert.equal(normalizeForSearch('Ðøƒı'), 'DOFI');              // letters NFKD leaves alone
  assert.equal(normalizeForSearch('café'), 'CAFÉ');         // combining mark kept
  assert.equal(normalizeForSearch('café', { foldAccents: true }), 'CAFE');
  assert.equal(normalizeForSearch('カタ', { foldKana: true }), 'かた');
});

test('char-class mask buckets', () => {
  assert.deepEqual(charClassMask('0'), { lo: 1, hi: 0 });
  assert.deepEqual(charClassMask('A'), { lo: 1 << 10, hi: 0 });
  assert.deepEqual(charClassMask(' '), { lo: 0, hi: 1 << (36 - 32) });
  assert.deepEqual(charClassMask('あ'), { lo: 0, hi: 1 << (40 + 2 - 32) });
  // Mask pre-reject: token has a class ('Z') the field lacks.
  assert.equal(new SearchString('abc').contains(new SearchString('z')), false);
  assert.equal(new SearchString('Strobe').contains(new SearchString('rob')), true);
});

test('tokenize on space, ideographic space and tab; no phrases', () => {
  assert.deepEqual(tokenize('  eric　prydz\topus '), ['eric', 'prydz', 'opus']);
  assert.deepEqual(tokenize('"eric prydz"'), ['"eric', 'prydz"']);
  assert.deepEqual(tokenize(''), []);
});

test('empty query returns the list unchanged, in order', () => {
  assert.deepEqual(ids(lib.search('')), [1, 2, 3, 4, 5]);
});

test('case-insensitive substring, AND across tokens, OR across fields', () => {
  assert.deepEqual(ids(lib.search('MAU')), [1]);
  assert.deepEqual(ids(lib.search('progressive')), [1, 3]);
  assert.deepEqual(ids(lib.search('progressive prydz')), [3]);   // genre + artist
  assert.deepEqual(ids(lib.search('progressive darude')), []);
});

test('full-width title matches half-width query', () => {
  assert.deepEqual(ids(lib.search('opus')), [3]);
});

test('accents: unaccented query finds accented data, not the reverse (Rekordbox behaviour)', () => {
  const lib2 = new TrackLibrary([{ id: 'a', title: 'Cafe' }, { id: 'b', title: 'Café' }]);
  assert.deepEqual(ids(lib2.search('cafe')), ['a', 'b']);
  assert.deepEqual(ids(lib2.search('café')), ['b']);
  const folded = new TrackLibrary([{ id: 'a', title: 'Cafe' }, { id: 'b', title: 'Café' }], { foldAccents: true });
  assert.deepEqual(ids(folded.search('café')), ['a', 'b']);
});

test('extra folds apply to comments', () => {
  assert.deepEqual(ids(lib.search('oresund')), [4]);   // Ø -> O
  assert.deepEqual(ids(lib.search('ØRESUND')), [4]);
});

test('year and BPM only join "All" for numeric tokens; raw substring of formatted value', () => {
  assert.equal(formatBpm(128), '128.00');
  assert.equal(formatBpm(133.5), '133.50');
  assert.equal(formatBpm(0), '');
  assert.deepEqual(ids(lib.search('1999')), [4]);
  assert.deepEqual(ids(lib.search('133.5')), [2]);
  assert.deepEqual(ids(lib.search('12')), [1, 3]);       // 128.00, 126.00 (and 2015 has no "12")
  assert.deepEqual(ids(lib.search('0')), [1, 2, 3, 4]);  // year/BPM 0 never match
});

test('single-field search', () => {
  assert.deepEqual(ids(lib.search('trance', { field: 'genre' })), [2, 4]);
  assert.deepEqual(ids(lib.search('trance', { field: 'title' })), []);
  assert.deepEqual(ids(lib.search('136', { field: 'bpm' })), [4]);
  assert.deepEqual(ids(lib.search('99', { field: 'year' })), [2, 4]); // 1993, 1999
  assert.deepEqual(ids(lib.search('2009', { field: 'artist' })), []);
});

test('track filter: BPM ±%, key, rating, color, My Tag all/any', () => {
  const run = (filter) => ids(tracks.filter(compileTrackFilter(filter)));
  assert.deepEqual(run({ bpm: { enabled: true, base: 128, rangePercent: 2 } }), [1, 3]); // 125.44..130.56
  assert.deepEqual(run({ bpm: { enabled: true, base: 128, rangePercent: 0 } }), [1]);
  assert.deepEqual(run({ bpm: { enabled: false, base: 128, rangePercent: 0 } }), [1, 2, 3, 4, 5]);
  assert.deepEqual(run({ key: { enabled: true, keys: ['8A', '1A'] } }), [1, 3]);
  assert.deepEqual(run({ rating: { enabled: true, ratings: [5] } }), [1, 3]);
  assert.deepEqual(run({ color: { enabled: true, colors: ['Red'] } }), [4]);
  assert.deepEqual(run({ myTag: { enabled: true, tags: ['Peak', 'Long'], mode: 'all' } }), [1]);
  assert.deepEqual(run({ myTag: { enabled: true, tags: ['Peak', 'Classic'], mode: 'any' } }), [1, 2, 3]);
});

test('keyword search and filters combine with AND', () => {
  const filter = { rating: { enabled: true, ratings: [5] } };
  assert.deepEqual(ids(lib.search('progressive', { filter })), [1, 3]);
  assert.deepEqual(ids(lib.search('trance', { filter })), []);
});

test('controller: 500 ms debounce, immediate on Enter/Esc/field, dedupe', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = [];
    const c = new SearchController({ onSearch: (q) => calls.push(q) });
    c.textChanged('s');
    c.textChanged('st');
    mock.timers.tick(499);
    assert.equal(calls.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(calls.map((q) => q.tokens), [['st']]);

    c.textChanged('st ');            // same tokens -> no re-run
    mock.timers.tick(500);
    assert.equal(calls.length, 1);

    c.textChanged('str');
    c.submit();                      // Enter runs immediately
    assert.deepEqual(calls.at(-1).tokens, ['str']);
    mock.timers.tick(500);
    assert.equal(calls.length, 2);   // pending timer was cancelled

    c.setField('artist');            // field change runs immediately
    assert.equal(calls.at(-1).field, 'artist');

    c.clear();                       // Esc clears and runs immediately
    assert.deepEqual(calls.at(-1).tokens, []);

    c.textChanged('x');
    c.textChanged('');               // clearing the box runs immediately -> but tokens unchanged
    assert.equal(calls.length, 4);
  } finally {
    mock.timers.reset();
  }
});
