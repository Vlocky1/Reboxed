import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padValue, padPages } from '../src/shared/pad-tables.js';

const row = (mode, page) => Array.from({ length: 8 }, (_, i) => padValue(mode, page, i));

test('pad tables follow rekordbox (BeatJump / KeyShift / BeatLoop .pad.csv)', () => {
  assert.deepEqual(row('BEAT JUMP', 0), [-1 / 4, 1 / 4, -1 / 2, 1 / 2, -1, 1, -2, 2]);
  assert.deepEqual(row('BEAT JUMP', 1), [-4, 4, -8, 8, -16, 16, -32, 32]);
  assert.deepEqual(row('KEY SHIFT', 0), [4, 5, 6, 7, 0, 1, 2, 3]);
  assert.deepEqual(row('KEYBOARD', 1), [-4, -3, -2, -1, -8, -7, -6, -5]);
  assert.deepEqual(row('BEAT LOOP', 0), [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32]);
  assert.deepEqual(row('BEAT LOOP', 1), [4, 8, 16, 32, 64, 128, 256, 512]);
  assert.equal(padValue('HOT CUE', 0, 0), undefined);
  assert.equal(padPages('BEAT JUMP'), 2);
  assert.equal(padPages('HOT CUE'), 1);
});
