// Download results compared with the collection: same track (names cleaned, any order of featured
// artists, other format of the version), but another version or another edit is not the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollectionIndex, comparable, sameTrack } from '../src/shared/in-collection.js';

const lib = new CollectionIndex([
  { id: 'a', title: 'Afterglow (Extended Mix)', artist: 'Nova Drift', duration: 372 },
  { id: 'b', title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams', duration: 248 },
  { id: 'c', title: 'Coastline', artist: 'Mira Vale & Teo', duration: 180 },
  { id: 'd', title: 'Été Indien', artist: 'Lune Rouge', duration: 0 },
  { id: 'e', title: 'Overdrive - Original Mix', artist: 'Halcyon Grid', duration: 300 },
]);

test('the same track, written another way, is found', () => {
  assert.equal(lib.find({ title: 'Afterglow - Extended Mix', artist: 'Nova Drift', duration: 371 })?.id, 'a');
  assert.equal(lib.find({ title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk', duration: 249 })?.id, 'b', 'featured artists do not matter');
  assert.equal(lib.find({ title: 'Ete indien', artist: 'lune rouge', duration: 200 })?.id, 'd', 'accents, case; no length on one side');
  assert.equal(lib.find({ title: 'Overdrive', artist: 'Halcyon Grid', duration: 301 })?.id, 'e', '"Original Mix" is the plain track');
  // a video: "Artist - Title (Official Video)" by a channel
  assert.equal(lib.find({ title: 'Mira Vale & Teo - Coastline (Official Video)', artist: 'MiraValeVEVO', duration: 182 }, { fromUpload: true })?.id, 'c');
});

test('another version, another edit or another song is not the collection track', () => {
  assert.equal(lib.find({ title: 'Afterglow (Radio Edit)', artist: 'Nova Drift', duration: 210 }), null, 'Radio Edit vs Extended Mix');
  assert.equal(lib.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 210 }), null, 'unnamed version, other length');
  assert.equal(lib.find({ title: 'Get Lucky', artist: 'Daft Punk', duration: 369 }), null, 'album version (6:09) vs the radio edit (4:08)');
  assert.equal(lib.find({ title: 'Coastline', artist: 'Somebody Else', duration: 180 }), null, 'same title, other artist');
  assert.equal(lib.find({ title: 'Coastlines Forever', artist: 'Mira Vale', duration: 180 }), null);
  assert.equal(lib.find({ title: 'Get Lucky (Daft Punk Remix)', artist: 'Daft Punk', duration: 248 }), null, 'a remix is another track');
});

test('sameTrack scores: the surer, the higher', () => {
  const x = comparable({ title: 'Coastline', artist: 'Mira Vale', duration: 180 });
  const y = comparable({ title: 'Coastline', artist: 'Mira Vale & Teo', duration: 181 });
  const z = comparable({ title: 'Coastline', artist: '', duration: 180 });
  assert.ok(sameTrack(x, y) > sameTrack(x, z));
});
