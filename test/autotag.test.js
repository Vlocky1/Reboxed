import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMix, similarity, artistSimilarity, queryFor, pickMatch, changesFor, valueOf, runRecipe, DEFAULT_RECIPE } from '../src/shared/autotag.js';

test('mix names, similarity, artists, "Artist - Title" titles', () => {
  assert.deepEqual(splitMix('Opus - Extended Mix'), { title: 'Opus', mixName: 'Extended Mix' });
  assert.deepEqual(splitMix('Strobe [Club Edit]'), { title: 'Strobe', mixName: 'Club Edit' });
  assert.deepEqual(splitMix('Here Comes The Sun - Remastered 2009'), { title: 'Here Comes The Sun', mixName: 'Remastered 2009' });
  assert.equal(similarity('Trois nuits par semaine', 'trois nuits par  semaine!'), 1);
  assert.ok(similarity('Opus', 'Nopus') < 0.9);
  assert.equal(artistSimilarity('Daft Punk feat. Pharrell Williams', 'Pharrell Williams'), 1);
  assert.ok(artistSimilarity('Beyoncé', 'Beyonce') > 0.99);
  assert.deepEqual(queryFor({ title: 'Indochine - Trois nuits par semaine', artist: '' }), { artist: 'Indochine', title: 'Trois nuits par semaine' });
  assert.deepEqual(queryFor({ title: 'Song', artist: 'X' }), { artist: 'X', title: 'Song' });
  assert.deepEqual(queryFor({ title: "Indochine - J'ai demandé à la lune (Clip officiel) [HD]", artist: '' }), { artist: 'Indochine', title: "J'ai demandé à la lune" });
  assert.equal(queryFor({ title: 'Opus (Extended Mix) | Official Audio', artist: 'Eric Prydz' }).title, 'Opus (Extended Mix)', 'mix kept, decorations gone');
});

test('pickMatch: same artist, title and duration; the right version', () => {
  const cands = [
    { title: 'Strobe', mixName: 'Radio Edit', artist: 'deadmau5', duration: 212 },
    { title: 'Strobe', mixName: 'Club Edit', artist: 'deadmau5', duration: 379 },
    { title: 'Strobe', mixName: '', artist: 'deadmau5', duration: 633 },
  ];
  assert.equal(pickMatch(cands, { title: 'Strobe (Club Edit)', artist: 'Deadmau5', duration: 380 }).candidate.mixName, 'Club Edit');
  assert.equal(pickMatch(cands, { title: 'Strobe', artist: 'deadmau5', duration: 634 }).candidate.duration, 633);
  assert.equal(pickMatch(cands, { title: 'Strobe', artist: 'deadmau5', duration: 500 }), null, 'no duration within ±4 s');
  assert.equal(pickMatch(cands, { title: 'Ghosts n Stuff', artist: 'deadmau5', duration: 379 }), null, 'other title');
  assert.equal(pickMatch(cands, { title: 'Strobe', artist: 'Someone Else', duration: 379 }), null, 'other artist');
  assert.equal(pickMatch(cands, { title: 'Strobe', artist: 'deadmau5', duration: 500 }, { tolerance: 9999 }).candidate.duration, 633, 'duration ignored');
});

test('changes: only ticked fields, only empty ones when asked, title with the mix', () => {
  const c = { title: 'Opus', mixName: 'Extended Mix', artist: 'Eric Prydz', genre: 'Dance', year: 2016, artworkUrl: 'https://x/c.jpg' };
  assert.equal(valueOf(c, 'title'), 'Opus (Extended Mix)');
  assert.equal(valueOf(c, 'title', { titleWithMix: false }), 'Opus');
  const t = { title: 'eric prydz - opus (extended)', artist: '', genre: 'House', year: 0 };
  assert.deepEqual(changesFor(t, c, { fields: ['title', 'artist'] }).map((x) => [x.field, x.to]), [['title', 'Opus (Extended Mix)'], ['artist', 'Eric Prydz']]);
  assert.deepEqual(changesFor(t, c, { fields: ['genre', 'year'], onlyEmpty: true }).map((x) => x.field), ['year'], 'genre kept: not empty');
  assert.deepEqual(changesFor({ ...t, genre: 'Dance' }, c, { fields: ['genre'] }), [], 'same value: no change');
});

test('recipe: Spotify cleans title + artist, then the Genre source is searched with them', async () => {
  const asked = [];
  const lookup = async (q, source, opts) => {
    asked.push([source, q.artist, q.title, opts.genres, opts.complete]);
    if (source === 'spotify') return { candidates: [{ title: 'Trois nuits par semaine', mixName: '', artist: 'Indochine', duration: 312, genre: '' }] };
    // Deezer only finds it with the clean artist / title.
    if (q.artist === 'Indochine' && q.title === 'Trois nuits par semaine') return { candidates: [{ title: 'Trois nuits par semaine', mixName: '', artist: 'Indochine', duration: 312, genre: 'Disco', title2: 'x' }] };
    return { candidates: [] };
  };
  const tracks = [
    { id: 'a', title: 'INDOCHINE - 3 nuits par semaine (clip officiel)', artist: '', duration: 313, genre: '' },
    { id: 'b', title: 'Unknown thing', artist: 'Nobody', duration: 100, genre: '' },
  ];
  // A failing lookup is reported on that step only.
  const failing = async (q, source, opts) => { if (q.title === 'Unknown thing') throw new Error('Spotify error 500'); return lookup(q, source, opts); };
  const res = await runRecipe(tracks, DEFAULT_RECIPE, failing);
  const [a, b] = res;
  assert.deepEqual(a.steps[0].changes.map((x) => [x.field, x.to]), [['title', 'Trois nuits par semaine'], ['artist', 'Indochine']]);
  assert.deepEqual(a.steps[1].changes.map((x) => [x.field, x.to]), [['genre', 'Disco']]);
  assert.deepEqual(asked.filter((x) => x[0] === 'genre')[0], ['genre', 'Indochine', 'Trois nuits par semaine', true, false], 'genre searched with Spotify\'s title');
  assert.equal(asked[0][3], false, 'no genre requests for a title + artist step');
  assert.equal(b.steps[0].match, null);
  assert.match(b.steps[0].error, /500/);
  // Stop button.
  let n = 0;
  const stopped = await runRecipe(tracks, DEFAULT_RECIPE, lookup, { stopped: () => n++ > 0 });
  assert.equal(stopped.length, 1);
});
