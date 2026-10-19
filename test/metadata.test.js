import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformOf, toItem, feedUrl, SEARCH } from '../src/main/downloader.js';
import { Spotify, splitMix, toFields } from '../src/main/spotify.js';
import { addedTime, dateAddedText, localDay } from '../src/shared/date-added.js';

test('download links: YouTube and SoundCloud are recognised, other sites are not', () => {
  assert.equal(platformOf('https://www.youtube.com/watch?v=jNQXAC9IVRw'), 'youtube');
  assert.equal(platformOf('https://youtu.be/jNQXAC9IVRw'), 'youtube');
  assert.equal(platformOf('https://music.youtube.com/playlist?list=x'), 'youtube');
  assert.equal(platformOf('https://soundcloud.com/artist/track'), 'soundcloud');
  assert.equal(platformOf('https://on.soundcloud.com/abc'), 'soundcloud');
  assert.equal(platformOf('https://m.soundcloud.com/artist/sets/x'), 'soundcloud');
  assert.equal(platformOf('https://evilsoundcloud.com/x'), null);
  assert.equal(platformOf('https://example.com/a.mp3'), null);
  assert.equal(platformOf('not a url'), null);
  assert.equal(SEARCH.soundcloud, 'scsearch');
  assert.equal(feedUrl('https://soundcloud.com/label'), 'https://soundcloud.com/label/tracks');
  assert.equal(feedUrl('https://www.youtube.com/@label'), 'https://www.youtube.com/@label/videos');
});

test('SoundCloud entries: prefixed ids, permalink, 30 s previews, big artwork', () => {
  const it = toItem({
    id: '257054814', ie_key: 'Soundcloud', title: 'Trois nuits par semaine', uploader: 'Indochine', uploader_url: 'https://soundcloud.com/indochineofficiel',
    duration: 30.0, webpage_url: 'https://soundcloud.com/indochineofficiel/3-nuits-par-semaine', url: 'https://api.soundcloud.com/tracks/x',
    thumbnails: [{ id: 'small', url: 's.jpg' }, { id: 't500x500', url: 'big.jpg' }, { id: 'original', url: 'o.jpg' }],
  });
  assert.deepEqual([it.id, it.platform, it.url, it.preview, it.thumb, it.channel], ['sc:257054814', 'soundcloud', 'https://soundcloud.com/indochineofficiel/3-nuits-par-semaine', true, 'big.jpg', 'Indochine']);
  // Flat playlist entry without webpage_url: its permalink is in url.
  const flat = toItem({ id: '12345678901', ie_key: 'Soundcloud', title: 'Victoria', url: 'https://soundcloud.com/indochineofficiel/victoria' });
  assert.equal(flat.url, 'https://soundcloud.com/indochineofficiel/victoria');
  assert.equal(flat.preview, false);
  const set = toItem({ id: '1', title: 'EP', url: 'https://soundcloud.com/a/sets/ep' });
  assert.equal(set.playlist, true);
  const yt = toItem({ id: 'jNQXAC9IVRw', ie_key: 'Youtube', title: 'Me at the zoo', duration: 19 });
  assert.deepEqual([yt.id, yt.platform, yt.url], ['jNQXAC9IVRw', 'youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
});

test('Spotify: mix names, fields, genre from the artist', async () => {
  assert.deepEqual(splitMix('Opus - Extended Mix'), { title: 'Opus', mixName: 'Extended Mix' });
  assert.deepEqual(splitMix('Strobe (Club Edit)'), { title: 'Strobe', mixName: 'Club Edit' });
  assert.deepEqual(splitMix('Trois nuits par semaine'), { title: 'Trois nuits par semaine', mixName: '' });
  const track = {
    id: 't1', name: 'Opus - Extended Mix', track_number: 3, disc_number: 1, duration_ms: 545000, external_urls: { spotify: 'https://open.spotify.com/track/t1' },
    artists: [{ id: 'a1', name: 'Eric Prydz' }], album: { name: 'Opus', release_date: '2016-02-05', artists: [{ name: 'Eric Prydz' }], images: [{ url: 'https://i.scdn.co/image/big' }, { url: 'https://i.scdn.co/image/small' }] },
  };
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('accounts.spotify.com')) {
      assert.match(opts.headers.Authorization, /^Basic /);
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    if (url.includes('/search')) return json({ tracks: { items: url.includes('artist%3A') ? [track] : [] } });
    if (url.includes('/artists/a1')) return json({ genres: ['progressive house', 'edm'] });
    return { ok: false, status: 404 };
  };
  const sp = new Spotify({ credentials: () => ({ clientId: 'id', secret: 's' }), fetch: fakeFetch });
  const [c] = await sp.lookup({ title: 'Opus (Original Mix)', artist: 'Eric Prydz' });
  assert.deepEqual([c.title, c.mixName, c.artist, c.album, c.year, c.trackNumber, c.genre, c.genres, c.duration, c.artworkUrl],
    ['Opus', 'Extended Mix', 'Eric Prydz', 'Opus', 2016, 3, 'Progressive House', ['Progressive House', 'Edm'], 545, 'https://i.scdn.co/image/big']);
  assert.ok(calls.some((u) => u.includes(encodeURIComponent('track:"Opus"'))), 'searches the title without its mix name');
  assert.equal(calls.filter((u) => u.includes('accounts.spotify.com')).length, 1, 'token reused');
  const none = new Spotify({ credentials: () => null, fetch: fakeFetch });
  await assert.rejects(none.lookup({ title: 'x' }), /not set up/);
  assert.equal(toFields({ id: 'x', name: 'Y', artists: [], album: {} }).genre, '');
});

test('date added shows the time when it is known', () => {
  const at = new Date(2026, 9, 19, 14, 32).getTime();
  assert.equal(dateAddedText({ dateAdded: '2026-10-19', addedAt: at }), '2026-10-19 14:32');
  assert.equal(dateAddedText({ dateAdded: '2026-10-18' }), '2026-10-18');
  assert.equal(addedTime({ dateAdded: '2026-10-01', addedAt: at }), null, 'edited day: the old time no longer applies');
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('Deezer fields and Spotify results completed with Deezer genres', async () => {
  const { deezerFields, Deezer } = await import('../src/main/deezer.js');
  const { mergeCandidates, MetadataLookup } = await import('../src/main/metadata.js');
  const dz = deezerFields({
    id: 1, title: 'Strobe (Club Edit)', title_short: 'Strobe', title_version: '(Club Edit)', isrc: 'GBXX1', link: 'https://www.deezer.com/track/1',
    track_position: 2, disk_number: 1, duration: 379, release_date: '2010-02-08', contributors: [{ name: 'Deadmau5' }],
    album: { id: 9, title: 'Strobe', cover_xl: 'https://cdn-images.dzcdn.net/x/1000.jpg', cover_medium: 'https://cdn-images.dzcdn.net/x/250.jpg' },
  }, { label: 'Virgin', genres: { data: [{ name: 'Dance' }, { name: 'Electro' }] }, artist: { name: 'Deadmau5' } });
  assert.deepEqual([dz.source, dz.title, dz.mixName, dz.genre, dz.genres, dz.label, dz.year, dz.trackNumber, dz.isrc],
    ['deezer', 'Strobe', 'Club Edit', 'Dance', ['Dance', 'Electro'], 'Virgin', 2010, 2, 'GBXX1']);
  const sp = { source: 'spotify', title: 'Strobe', artist: 'deadmau5', genre: '', genres: [], label: '', isrc: 'GBXX1' };
  const other = { source: 'spotify', title: 'Ghosts n Stuff', artist: 'deadmau5', genre: '', genres: [], label: '', isrc: '' };
  const merged = mergeCandidates([sp, other], [dz]);
  assert.deepEqual([merged[0].genre, merged[0].label, merged[0].completedFrom], ['Dance', 'Virgin', 'deezer']);
  assert.equal(merged[1].genre, '', 'no Deezer match: unchanged');
  assert.equal(merged.length, 3);
  // Without ISRC the same artist + title (accents, case) is enough.
  assert.equal(mergeCandidates([{ ...sp, isrc: '', artist: 'Déadmau5', title: 'STROBE' }], [dz])[0].genre, 'Dance');
  // Spotify not set up: Deezer only; a failing service is reported, not fatal.
  const json = (body) => ({ ok: true, json: async () => body });
  const deezer = new Deezer({ fetch: async (url) => (url.includes('/search') ? json({ data: [{ id: 1 }] }) : url.includes('/track/') ? json({ id: 1, title: 'A', album: { id: 2 }, artist: { name: 'B' } }) : json({ genres: { data: [{ name: 'Pop' }] } })) });
  // The user picks the service: Deezer alone, or Spotify (completed with Deezer genres).
  const meta = new MetadataLookup({ spotify: { lookup: async () => { throw new Error('boom'); } }, deezer, spotifyReady: () => false });
  const r = await meta.lookup({ title: 'A', artist: 'B' }, 'deezer');
  assert.deepEqual([r.sources, r.candidates.map((c) => c.genre), r.errors], [['Deezer'], ['Pop'], []]);
  await assert.rejects(meta.lookup({ title: 'A' }, 'spotify'), /not set up/);
  await assert.rejects(new MetadataLookup({ spotify: { lookup: async () => { throw new Error('boom'); } }, deezer, spotifyReady: () => true }).lookup({ title: 'A' }, 'spotify'), /boom/);
  const spOnly = new MetadataLookup({ spotify: { lookup: async () => [{ source: 'spotify', title: 'A', artist: 'B', genre: '', genres: [], label: '', isrc: '' }] }, deezer, spotifyReady: () => true });
  const s = await spOnly.lookup({ title: 'A', artist: 'B' }, 'spotify');
  assert.deepEqual([s.sources, s.candidates.map((c) => `${c.source}:${c.genre}`)], [['Spotify'], ['spotify:Pop']]);
});
