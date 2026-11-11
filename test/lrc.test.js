// Lyrics: LRC parsing / writing, the line at a time, title variants and LRCLIB result picking,
// and the LRCLIB lookup itself with a stand-in fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestLyrics, embeddedLyrics, formatStamp, lineAt, lineProgress, mainArtist, parseLrc, plainLines, splitArtistTitle, titleVariants, toLrc, vttToLines } from '../src/shared/lrc.js';
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
  assert.ok(calls.some((c) => c.url.searchParams.get('q') === 'Nova Drift Afterglow'));
  // synced lyrics end the search at once
  const fetch2 = async () => ({ ok: true, json: async () => [{ id: 1, trackName: 'Afterglow', artistName: 'Nova Drift', duration: 370, syncedLyrics: '[00:01.00]hi' }] });
  let n = 0;
  const ly2 = new Lyrics({ fetch: async (...a) => { n++; return fetch2(...a); }, userAgent: 'x' });
  assert.equal((await ly2.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 370 })).synced, '[00:01.00]hi');
  assert.equal(n, 1);
});

test('vttToLines: cues, tags, entities, rolling captions, "[Music]" dropped', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n[Music]\n\n00:00:05.500 --> 00:00:07.000\n<c>Hello</c> &amp; welcome\n\n00:00:06.200 --> 00:00:08.000\nHello &amp; welcome home\n\n01:02.250 --> 01:04.000\n♪ Second line ♪\n';
  assert.deepEqual(vttToLines(vtt), [{ t: 5.5, text: 'Hello & welcome home' }, { t: 62.25, text: 'Second line' }]);
});

test('embeddedLyrics: synced tag (ms) → LRC, LRC text in a plain tag stays LRC, else text; "Artist - Title"', () => {
  const sync = [{ timeStampFormat: 2, syncText: [{ text: 'a', timestamp: 1000 }, { text: 'b', timestamp: 2500 }, { text: 'c', timestamp: 4000 }] }];
  assert.equal(embeddedLyrics(sync).lrc, '[00:01.00]a\n[00:02.50]b\n[00:04.00]c');
  assert.equal(embeddedLyrics([{ text: '[00:01.00]x\n[00:02.00]y\n[00:03.00]z' }]).lrc, '[00:01.00]x\n[00:02.00]y\n[00:03.00]z');
  assert.deepEqual(embeddedLyrics([{ text: 'just words' }]), { lrc: null, plain: 'just words' });
  assert.equal(embeddedLyrics([]), null);
  assert.deepEqual(splitArtistTitle('Nova Drift - Afterglow (Lyrics)'), { artist: 'Nova Drift', title: 'Afterglow (Lyrics)' });
  assert.equal(splitArtistTitle('Afterglow'), null);
});

test('Lyrics.find: the title alone within 3 s, then YouTube uploader subtitles, plain lyrics kept as a last answer', async () => {
  const lrclib = (rows) => async (url) => ({ ok: true, json: async () => rows(new URL(url).searchParams), text: async () => '' });
  // c. title only: another artist spelling, same length within 3 s
  const titleOnly = new Lyrics({ userAgent: 'x', fetch: lrclib((q) => (q.get('track_name') && !q.get('artist_name') ? [{ id: 3, trackName: 'Afterglow', artistName: 'NOVA-DRIFT', duration: 371, syncedLyrics: '[00:01.00]x' }] : [])) });
  assert.equal((await titleOnly.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 372 })).id, 3);
  // d. YouTube: the uploader's subtitles of a matching video (automatic captions ignored)
  const vtt = `WEBVTT\n\n${[1, 2, 3, 4, 5, 6, 7].map((s) => `00:00:0${s}.000 --> 00:00:0${s}.900\nline ${s}`).join('\n\n')}\n`;
  const dl = {
    tools: async () => ({ ytdlp: 'yt-dlp' }),
    search: async (q) => { assert.match(q, /Nova Drift Afterglow lyrics/); return [{ id: 'v1', url: 'https://youtu.be/v1', title: 'Nova Drift - Afterglow (Lyric Video)', channel: 'Nova Drift', duration: 300 }]; },
    json: async () => ({ id: 'v1', title: 'Nova Drift - Afterglow', duration: 300, subtitles: { en: [{ ext: 'vtt', url: 'https://yt/sub.vtt' }] }, automatic_captions: { en: [{ ext: 'vtt', url: 'https://yt/auto.vtt' }] } }),
  };
  const fetched = [];
  const yt = new Lyrics({ userAgent: 'x', youtube: () => dl, fetch: async (url) => { fetched.push(url); return url.includes('lrclib') ? { ok: true, json: async () => [] } : { ok: true, text: async () => vtt }; } });
  const found = await yt.find({ title: 'Afterglow (Extended Mix)', artist: 'Nova Drift', duration: 372 });
  assert.equal(found.source, 'YouTube');
  assert.equal(parseLrc(found.synced).length, 7);
  assert.ok(!fetched.includes('https://yt/auto.vtt'));
  // nothing synced anywhere: the plain lyrics found on LRCLIB
  const plainOnly = new Lyrics({ userAgent: 'x', youtube: () => null, fetch: lrclib(() => [{ id: 8, trackName: 'Afterglow', artistName: 'Nova Drift', duration: 372, plainLyrics: 'words' }]) });
  assert.equal((await plainOnly.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 372 })).plain, 'words');
});
