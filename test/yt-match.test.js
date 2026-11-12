import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, bestYoutubeMatch, youtubeQuery, findOnYoutube } from '../src/shared/yt-match.js';
import { spotifyLink, embedTracks, embedTrack } from '../src/main/spotify.js';
import { deezerLink, deezerTrack, isDeezerShortLink, Deezer } from '../src/main/deezer.js';

test('Spotify links: track, playlist, album, localized, URI', () => {
  assert.deepEqual(spotifyLink('https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(spotifyLink('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'), { kind: 'album', id: '4m2880jivSbbyEGAKfITCa' });
  assert.deepEqual(spotifyLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(spotifyLink('https://open.spotify.com/track/0dEIca2nhcxDUV8C5QkPYb'), { kind: 'track', id: '0dEIca2nhcxDUV8C5QkPYb' });
  assert.equal(spotifyLink('https://open.spotify.com/artist/0dEIca2nhcxDUV8C5QkPYb'), null);
});

test('Spotify embed page of a track', () => {
  const data = { props: { pageProps: { state: { data: { entity: { name: 'Get Lucky', artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }], duration: 369626, uri: 'spotify:track:abc' } } } } } };
  const t = embedTrack(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
  assert.deepEqual([t.title, t.artist, t.duration, t.spotifyId], ['Get Lucky', 'Daft Punk, Pharrell Williams', 369.626, 'abc']);
});

test('Deezer links, tracks, search and lists (public API, stand-in fetch)', async () => {
  assert.deepEqual(deezerLink('https://www.deezer.com/fr/playlist/3155776842'), { kind: 'playlist', id: '3155776842' });
  assert.deepEqual(deezerLink('https://www.deezer.com/album/6575789?utm=x'), { kind: 'album', id: '6575789' });
  assert.deepEqual(deezerLink('https://www.deezer.com/en-gb/track/3135556'), { kind: 'track', id: '3135556' });
  assert.equal(deezerLink('https://www.deezer.com/artist/27'), null);
  assert.ok(isDeezerShortLink('https://link.deezer.com/s/30abc') && isDeezerShortLink('https://deezer.page.link/xyz'));
  assert.deepEqual(deezerTrack({ id: 1, title: 'X (Extended Mix)', title_short: 'X', title_version: '(Extended Mix)', artist: { name: 'A' }, duration: 300 }).title, 'X (Extended Mix)');
  const pages = {
    '/playlist/9': { title: 'My list' },
    '/playlist/9/tracks?limit=100&index=0': { data: [{ id: 1, title: 'One', artist: { name: 'A' }, duration: 200 }], next: 'https://api.deezer.com/playlist/9/tracks?limit=100&index=100' },
    '/playlist/9/tracks?limit=100&index=100': { data: [{ id: 2, title: 'Two', artist: { name: 'B' }, duration: 210 }] },
    '/search?limit=25&q=one': { data: [{ id: 1, title: 'One', artist: { name: 'A' }, duration: 200, type: 'track' }] },
  };
  const dz = new Deezer({ fetch: async (url) => ({ ok: true, json: async () => pages[url.replace('https://api.deezer.com', '')] ?? { error: { message: `no ${url}` } } }) });
  const r = await dz.readLink('https://www.deezer.com/playlist/9');
  assert.deepEqual([r.kind, r.name, r.tracks.map((t) => t.title)], ['playlist', 'My list', ['One', 'Two']], 'every page of the playlist');
  assert.equal((await dz.searchTracks('one'))[0].artist, 'A');
  await assert.rejects(dz.readLink('https://example.com/x'), /Not a Deezer/);
});

test('Spotify embed page: name and tracks', () => {
  const data = { props: { pageProps: { state: { data: { entity: { name: 'Mix', trackList: [
    { title: 'One More Time', subtitle: 'Daft Punk', duration: 320000, uri: 'spotify:track:abc' }, { title: '', subtitle: 'x' }] } } } } } };
  const r = embedTracks(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`);
  assert.deepEqual(r, { name: 'Mix', tracks: [{ title: 'One More Time', artist: 'Daft Punk', duration: 320, spotifyId: 'abc' }] });
  assert.throws(() => embedTracks('<html></html>'), /not understood/);
});

const track = { title: 'expectations (feat. Chappell Roan)', artist: 'Olivia Rodrigo, Chappell Roan', duration: 224 };

test('query: first artist, title without the featured artist, "audio"', () => {
  assert.equal(youtubeQuery(track), 'Olivia Rodrigo expectations audio');
  assert.equal(youtubeQuery({ title: 'Shadows', artist: 'AKKI (DE)' }, { audio: false }), 'AKKI Shadows');
});

test('the studio track wins; other versions and other lengths are left out', () => {
  const results = [
    { id: 'live', title: 'Olivia Rodrigo - expectations (Live at Glastonbury)', channel: 'BBC', duration: 230 },
    { id: 'sped', title: 'expectations - sped up', channel: 'Speedy', duration: 180 },
    { id: 'lyr', title: 'Olivia Rodrigo, Chappell Roan - Expectations (Lyrics)', channel: 'Vibe Music', duration: 225 },
    { id: 'topic', title: 'expectations (feat. Chappell Roan)', channel: 'Olivia Rodrigo - Topic', duration: 224 },
    { id: 'other', title: 'Expectations', channel: 'Someone Else', duration: 140 },
  ];
  assert.equal(bestYoutubeMatch(track, results).item.id, 'topic', 'the label upload beats a lyrics re-upload');
  assert.ok(matchScore(track, results[0]) < 0.6, 'live');
  assert.equal(matchScore(track, results[4]), -1, 'another length');
  assert.equal(bestYoutubeMatch(track, [results[0], results[1]]), null);
});

test('club music: when only the Extended Mix is on YouTube, it is taken (second search)', async () => {
  const t = { title: 'Obsidian', artist: 'Kevin de Vries, Juan Elvadin', duration: 203 };
  const asked = [];
  const search = async (q) => { asked.push(q); return [
    { id: 'ext', title: 'Kevin de Vries & Juan Elvadin – Obsidian (Original Mix)', channel: 'Drumcode', duration: 325 },
    { id: 'set', title: 'Kevin de Vries @ Awakenings - Obsidian', channel: 'Awakenings', duration: 3600 },
  ]; };
  const best = await findOnYoutube(t, search);
  assert.equal(best.item.id, 'ext');
  assert.equal(best.longer, true);
  assert.deepEqual(asked, ['Kevin de Vries Obsidian audio', 'Kevin de Vries Obsidian']);
});
