import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, bestYoutubeMatch, youtubeQuery, findOnYoutube } from '../src/shared/yt-match.js';
import { spotifyLink, embedTracks } from '../src/main/spotify.js';

test('Spotify links: playlist, album, localized, URI', () => {
  assert.deepEqual(spotifyLink('https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(spotifyLink('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'), { kind: 'album', id: '4m2880jivSbbyEGAKfITCa' });
  assert.deepEqual(spotifyLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal(spotifyLink('https://open.spotify.com/track/0dEIca2nhcxDUV8C5QkPYb'), null);
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
