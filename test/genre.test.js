import { test } from 'node:test';
import assert from 'node:assert/strict';
import { djGenre, bpmFits, chooseGenre } from '../src/shared/genre.js';

test('raw tags map to one DJ vocabulary', () => {
  assert.equal(djGenre('Tech-House'), 'Tech House');
  assert.equal(djGenre('drum and bass'), 'Drum & Bass');
  assert.equal(djGenre('Drum n Bass'), 'Drum & Bass');
  assert.equal(djGenre('melodic techno'), 'Melodic House & Techno');
  assert.equal(djGenre('Rap/Hip Hop'), 'Hip-Hop');
  assert.equal(djGenre('dance / electro pop'), 'Dance / Pop', 'the longest name inside the tag wins');
  assert.equal(djGenre('Electro'), 'Electronic', 'Deezer "Electro" is any electronic music');
  assert.equal(djGenre('Techno/House'), 'Electronic', 'a broad Deezer category');
  assert.equal(djGenre('australian'), null);
});

test('BPM fits a genre, also at half or double time', () => {
  assert.equal(bpmFits('Drum & Bass', 174), true);
  assert.equal(bpmFits('Drum & Bass', 87), true);
  assert.equal(bpmFits('Drum & Bass', 124), false);
  assert.equal(bpmFits('Pop', 124), true, 'no range: any tempo');
  assert.equal(bpmFits('Techno', 0), true, 'unknown BPM');
});

test('vote: precise genres beat broad ones, Discogs counts most, the BPM rules out', () => {
  const r = chooseGenre([
    { source: 'deezer', tags: ['Dance', 'Electro'] },
    { source: 'musicbrainz', tags: ['house', 'edm', 'electronic', 'tech house'] },
    { source: 'discogs', tags: ['Tech House', 'House'] },
  ], { bpm: 125 });
  assert.equal(r.genre, 'Tech House');
  assert.ok(!r.ranked.some((x) => x.genre === 'Electronic'), 'Electronic only when nothing precise');

  const dnb = chooseGenre([{ source: 'musicbrainz', tags: ['drum and bass', 'electronic', 'rock', 'alternative rock'] }], { bpm: 174 });
  assert.equal(dnb.genre, 'Drum & Bass', 'two rock tags are not twice the rock');

  const tempo = chooseGenre([{ source: 'musicbrainz', tags: ['dancehall', 'house'] }], { bpm: 124 });
  assert.equal(tempo.genre, 'House', 'dancehall does not fit 124 BPM');

  assert.equal(chooseGenre([{ source: 'deezer', tags: ['Dance', 'Electro'] }]).genre, 'Electronic');
  assert.equal(chooseGenre([{ source: 'deezer', tags: [] }]), null);
});
