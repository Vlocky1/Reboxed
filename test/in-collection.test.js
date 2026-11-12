// Download results compared with the collection: the same track under any reading of its name
// (video title, label channel, "Title - Artist", old downloads never cleaned), but another
// version, remix or song is not the same; same names with another length is only "maybe".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollectionIndex, nameReadings } from '../src/shared/in-collection.js';

const lib = new CollectionIndex([
  { id: 'a', title: 'Afterglow (Extended Mix)', artist: 'Nova Drift', duration: 372 },
  { id: 'b', title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams', duration: 248 },
  { id: 'c', title: 'Coastline', artist: 'Mira Vale & Teo', duration: 180 },
  { id: 'd', title: 'Été Indien', artist: 'Lune Rouge', duration: 0 },
  { id: 'e', title: 'Overdrive - Original Mix', artist: 'Halcyon Grid', duration: 300 },
  // an old download whose name was never cleaned
  { id: 'f', title: 'Kraken Bay & Velo - Heartquake (OFFICIAL MUSIC VIDEO)', artist: '', duration: 144 },
  { id: 'g', title: 'Disturbia (Edit)', artist: 'Kobalt, Ria Stone', duration: 279 },
  { id: 'h', title: 'Dynamite', artist: 'Remzo', duration: 230 },
  { id: 'i', title: 'MAD', artist: 'Arlo Grey, Lumen', duration: 205 },
]);
const id = (q) => lib.find(q)?.id ?? null;
const vid = (q) => lib.find(q, { upload: true })?.id ?? null;

test('the same track, written another way, is found and sure', () => {
  assert.equal(id({ title: 'Afterglow - Extended Mix', artist: 'Nova Drift', duration: 371 }), 'a');
  assert.equal(id({ title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk', duration: 249 }), 'b', 'featured artists do not matter');
  assert.equal(id({ title: 'Overdrive', artist: 'Halcyon Grid', duration: 301 }), 'e', '"Original Mix" is the plain track');
  assert.equal(lib.find({ title: 'Coastline', artist: 'Mira Vale', duration: 181 })?.sure, true);
});

test('video titles: label channels, reversed order, prefixes, full-width signs, no dash', () => {
  assert.equal(vid({ title: 'Mira Vale & Teo - Coastline (Official Video)', artist: 'MiraValeVEVO', duration: 182 }), 'c');
  assert.equal(vid({ title: 'Mira Vale & Teo - Coastline (Official Video) - Big Label Records', artist: 'Big Label Records', duration: 179 }), 'c', 'posted by a label');
  assert.equal(vid({ title: 'Coastline - Mira Vale & Teo', artist: 'Some Channel', duration: 180 }), 'c', 'Title - Artist');
  assert.equal(vid({ title: 'House ｜ Mira Vale & Teo - Coastline ＊FREE DOWNLOAD＊', artist: 'Promo Channel', duration: 180 }), 'c');
  assert.equal(vid({ title: 'Kraken Bay & Velo - Heartquake', artist: 'Kraken Bay', duration: 145 }), 'f', 'the collection side is read as a video title too');
  assert.equal(vid({ title: 'Ria Stone - Disturbia (Kobalt Trance Edit) (FREE DOWNLOAD)', artist: 'Kobalt', duration: 280 }), 'g', '"Edit" and "Kobalt Trance Edit" are the same version');
  assert.equal(vid({ title: 'Arlo Grey Lumen MAD Official Video', artist: 'Arlo Grey', duration: 206 }), 'i', 'no dash: the words and the length');
  assert.equal(vid({ title: 'Ete indien', artist: 'lune rouge', duration: 200 }), 'd', 'accents, case');
});

test('same names, another length: maybe, not sure', () => {
  const r = lib.find({ title: 'Get Lucky', artist: 'Daft Punk', duration: 369 });
  assert.equal(r?.id, 'b');
  assert.equal(r.sure, false);
  assert.equal(lib.find({ title: 'Afterglow', artist: 'Nova Drift', duration: 210 })?.sure ?? false, false, 'unnamed version, other length');
});

test('another version, remix or song is not the collection track', () => {
  assert.equal(id({ title: 'Afterglow (Radio Edit)', artist: 'Nova Drift', duration: 210 }), null, 'Radio Edit vs Extended Mix');
  assert.equal(id({ title: 'Coastline', artist: 'Somebody Else', duration: 180 }), null, 'same title, other artist');
  assert.equal(id({ title: 'Coastlines Forever', artist: 'Mira Vale', duration: 180 }), null);
  assert.equal(id({ title: 'Get Lucky (Daft Punk Remix)', artist: 'Daft Punk', duration: 248 }), null, 'a remix is another track');
  assert.equal(vid({ title: 'Remzo -Dynamite (UpTempo HardStyle Remix)', artist: 'Label', duration: 231 }), null, 'a remix, even by the words alone');
  assert.equal(id({ title: 'Intro', artist: '', duration: 180 }), null);
});

test('name readings of a video title', () => {
  const r = nameReadings({ title: 'Genre ｜ Artist One & Two - The Song (Official Video) - Label', artist: 'Label' });
  assert.ok(r.some((x) => x.title === 'The Song' && x.artist === 'Artist One & Two'), JSON.stringify(r));
  assert.ok(r.some((x) => x.title === 'Artist One & Two' && x.artist === 'The Song'), 'reversed order is a reading too');
});
