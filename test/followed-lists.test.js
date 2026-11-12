// Followed playlists: what the list held when followed is seen; what is added later is new, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackKey, followEntry, newTracks, markListSeen } from '../src/shared/followed-lists.js';

const a = { title: 'Afterglow', artist: 'Nova Drift', spotifyId: 'A1' };
const b = { title: 'Coastline', artist: 'Mira Vale', spotifyId: 'B2' };
const c = { title: 'Overdrive', artist: 'Halcyon Grid', spotifyId: 'C3' };

test('keys: platform ids, else the names', () => {
  assert.equal(trackKey(a), 'sp:A1');
  assert.equal(trackKey({ title: 'X', artist: 'Y', deezerId: 42 }), 'dz:42');
  assert.equal(trackKey({ title: 'Été', artist: 'Lune' }), trackKey({ title: 'ete', artist: 'LUNE' }));
});

test('a followed list: only tracks added later are new, until seen', () => {
  const e = followEntry({ platform: 'spotify', url: 'u', name: 'My list', src: 'spotify:x' }, [a, b]);
  assert.deepEqual(newTracks(e, [a, b]), []);
  assert.deepEqual(newTracks(e, [c, a, b, c]).map((t) => t.title), ['Overdrive'], 'a new track, counted once');
  assert.deepEqual(newTracks(e, [a]), [], 'removed tracks are not news');
  const seen = markListSeen(e, [a, b, c]);
  assert.deepEqual(newTracks(seen, [a, b, c]), []);
  assert.equal(seen.name, 'My list');
});
