import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, floatToPcm16 } from '../src/shared/wav.js';

test('pcm16 interleaves and clips', () => {
  const pcm = floatToPcm16([new Float32Array([0, 1, -1, 2]), new Float32Array([0.5, -0.5, 0, -2])]);
  assert.deepEqual([...pcm], [0, 16383, 32767, -16384, -32768, 0, 32767, -32768]);
});

test('wav header fields', () => {
  const bytes = encodeWav([new Float32Array(10), new Float32Array(10)], 44100, 2, 7);
  const v = new DataView(bytes.buffer);
  const tag = (o) => String.fromCharCode(...bytes.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF'); assert.equal(tag(8), 'WAVE'); assert.equal(tag(36), 'data');
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(40, true), 5 * 2 * 2); // 5 frames x 2 ch x 2 bytes
  assert.equal(bytes.length, 44 + 20);
  assert.equal(v.getUint32(4, true), 36 + 20);
});
