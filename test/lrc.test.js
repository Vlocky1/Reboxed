// Lyrics: LRC parsing / writing, the line at a time, title variants and LRCLIB result picking,
// and the LRCLIB lookup itself with a stand-in fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestLyrics, formatStamp, lineAt, lineProgress, mainArtist, parseLrc, plainLines, titleVariants, toLrc } from '../src/shared/lrc.js';
import { Lyrics } from '../src/main/lyrics.js';

test('parseLrc: stamps, several stamps per line, word stamps, tags, offset', () => {
  const lines = parseLrc('[ar:Someone]\n[00:12.50]Hello\n[00:05.00][01:00.00]Chorus\n[00:20.1]<00:20.10>Word <00:21.00>by word\nno stamp\n');
  assert.deepEqual(lines, [{ t: 5, text: 'Chorus' }, { t: 12.5, text: 'Hello' }, { t: 20.1, text: 'Word by word' }, { t: 60, text: 'Chorus' }]);
  // a positive [offset:] shows the lyrics sooner
  assert.equal(parseLrc('[offset:+500]\n[00:10.00]x')[0].t, 9.5);
  assert.equal(parseLrc('[00:01,50]comma')[0].t, 1.5);
});

test('toLrc / formatStamp round trip', () => {
  const lines = [{ t: 0, text: 'a' }, { t: 65.43, text: 'b' }, { t: 3599.99, text: '' }];
  assert.equal(formatStamp(65.43), '01:05.43');
  assert.deepEqual(parseLrc(toLrc(lines)), lines);
});

test('lineAt / lineProgress follow the play head and the offset', () => {
  const lines = parseLrc('[00:10.00]one\n[00:20.00]two\n[00:30.00]three');
  assert.equal(lineAt(lines, 5), -1);
  assert.equal(lineAt(lines, 10), 0);
  assert.equal(lineAt(lines, 25), 1);
  assert.equal(lineAt(lines, 99), 2);
  assert.equal(lineAt(lines, 12, 3), -1, 'offset +3 s: the first line comes at 13 s');
  assert.equal(lineAt(lines, 13, 3), 0);
  assert.equal(lineProgress(lines, 0, 14), 0.5, 'half way to an 8 s cap');
  assert.equal(lineProgress(lines, -1, 14), 0);
  assert.deepEqual(plainLines('a\n\nb'), [{ t: null, text: 'a' }, { t: null, text: '' }, { t: null, text: 'b' }]);
});

test('titleVariants / mainArtist: what lyrics sites call the track', () => {
  assert.deepEqual(titleVariants('Afterglow (Extended Mix)'), ['Afterglow (Extended Mix)', 'Afterglow']);
  assert.deepEqual(titleVariants('Low Orbit feat. Kaia Moreno'), ['Low Orbit feat. Kaia Moreno', 'Low Orbit']);
  assert.deepEqual(titleVariants('Coastline'), ['Coastline']);
  assert.equal(mainArtist('Mira Vale & Teo'), 'Mira Vale');
  assert.equal(mainArtist('Nova Drift feat. Kaia'), 'Nova Drift');
  assert.equal(mainArtist('Nova Drift x Kaia'), 'Nova Drift');
});

test('bestLyrics: right title and artist, synced first, closest length', () => {
  const r = (id, trackName, artistName, duration, synced = true) => ({ id, trackName, artistName, duration, syncedLyrics: synced ? '[00:01.00]x' : null, plainLyrics: 'x' });
  const results = [r(1, 'Afterglow', 'Nova Drift', 249), r(2, 'Afterglow', 'Nova Drift', 372), r(3, 'Afterglow', 'Nova Drift', 371, false), r(4, 'Glasshouse', 'Nova Drift', 372), r(5, 'Afterglow', 'Somebody Else', 372)];
  assert.equal(bestLyrics(results, { title: 'Afterglow (Extended Mix)', artist: 'Nova Drift', duration: 370 }).id, 2);
  assert.equal(bestLyrics(results, { title: 'Afterglow', artist: 'Nova Drift', duration: 250 }).id, 1);
  assert.equal(bestLyrics(results, { title: 'Nothing Here', artist: 'Nova Drift', duration: 250 }), null);
  assert.equal(bestLyrics([r(6, 'Été', 'Lune Rouge', 200)], { title: 'Ete', artist: 'Lune rouge' }).id, 6, 'accents and case do not matter');
});

test('Lyrics.find: precise search first, falls back to the free search, identifies itself', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url: new URL(url), ua: opts.headers['User-Agent'] });
    const q = new URL(url).searchParams;
    const body = q.get('q') ? [{ id: 9, trackName: 'Afterglow', artistName: 'Nova Drift', duration: 300, plainLyrics: 'la la' }] : [];
    return { ok: true, json: async () => body };
  };
  const ly = new Lyrics({ fetch, userAgent: 'Reboxed/test' });
  const found = await ly.find({ title: 'Afterglow (Extended Mix)', artist: 'Nova Drift', duration: 372 });
  assert.equal(found.id, 9);
  assert.equal(found.synced, null);
  assert.equal(found.plain, 'la la');
  assert.ok(calls.every((c) => c.url.host === 'lrclib.net' && c.ua === 'Reboxed/test'));
  assert.equal(calls[0].url.searchParams.get('track_name'), 'Afterglow (Extended Mix)');
  assert.equal(calls.at(-1).url.searchParams.get('q'), 'Nova Drift Afterglow');
  // synced lyrics end the search at once
  const fetch2 = async () => ({ ok: true, json: async () => [{ id: 1, trackName: 'Afterglow', artistName: 'Nova Drift', duration: 370, syncedLyrics: '[00:01.00]hi' }] });
  let n = 0;
  const ly2 = new Lyrics({ fetch: async (...a) => { n++; return fetch2(...a); }, userAgent: 'x' });
  assert.equal((await ly2.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 370 })).synced, '[00:01.00]hi');
  assert.equal(n, 1);
});
