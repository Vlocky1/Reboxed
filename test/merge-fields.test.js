// Duplicates merged field by field: the kept file gets exactly the information ticked, from
// whichever track; the default ticks lose nothing; plays add up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_FIELDS, defaultPicks, pickedPatch, fieldText, hasValue } from '../src/shared/merge-fields.js';

const keep = { id: 'k', title: 'Coastline', artist: 'Mira Vale', genre: '', bpm: 124, beatgrid: { bpm: 124, firstBeat: 0.1 }, cues: [], rating: 2, playCount: 3, artwork: 'a.jpg' };
const other = { id: 'o', title: 'Coastline (Official Video)', artist: 'Mira Vale', genre: 'Progressive House', bpm: 123.98, beatgrid: { bpm: 123.98, firstBeat: 0.12, beats: [0.12, 0.6] }, gridLocked: true,
  cues: [{ num: 0, start: 1 }, { num: 1, start: 30 }, { num: -1, start: 60, type: 'memory' }], rating: 5, playCount: 4, myTags: ['peak'] };
const field = (key) => MERGE_FIELDS.find((f) => f.key === key);

test('default ticks: the kept value when there is one, else the one that exists', () => {
  const p = defaultPicks(keep, [other]);
  assert.equal(p.title, 'k');
  assert.equal(p.genre, 'o', 'empty on the kept track: taken from the other');
  assert.equal(p.cues, 'o');
  assert.equal(p.rating, 'k');
  assert.equal(p.myTags, 'o');
  assert.equal(p.artwork, 'k');
});

test('the patch: exactly what is ticked, grid fields together, plays added', () => {
  const p = { ...defaultPicks(keep, [other]), rating: 'o', grid: 'o' };
  const patch = pickedPatch(keep, [keep, other], p);
  assert.equal(patch.genre, 'Progressive House');
  assert.equal(patch.rating, 5);
  assert.deepEqual(patch.beatgrid, other.beatgrid);
  assert.equal(patch.bpm, 123.98);
  assert.equal(patch.gridLocked, true, 'BPM & beatgrid moves as one piece');
  assert.equal(patch.cues.length, 3);
  assert.equal(patch.playCount, 7);
  assert.ok(!('title' in patch), 'kept values are not rewritten');
});

test('values shown next to the ticks', () => {
  assert.equal(fieldText(other, field('cues')), '3 cues (2 hot)');
  assert.equal(fieldText(other, field('grid')), '123.98 BPM · variable · locked');
  assert.equal(fieldText(other, field('rating')), '★★★★★');
  assert.equal(fieldText(keep, field('genre')), '—');
  assert.equal(hasValue(keep, field('cues')), false);
});
