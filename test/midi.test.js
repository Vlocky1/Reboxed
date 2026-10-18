import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, messageKey } from '../src/shared/midi.js';

test('keys normalise note on/off and channels', () => {
  assert.equal(messageKey(0x90, 36), 'note:1:36');
  assert.equal(messageKey(0x81, 36), 'note:2:36');
  assert.equal(messageKey(0xb3, 7), 'cc:4:7');
  assert.equal(messageKey(0xe0, 0), 'pb:1');
  assert.equal(messageKey(0xf8, 0), null); // clock
});

test('buttons: note on / note off / velocity 0', () => {
  assert.deepEqual(decodeMessage([0x90, 36, 127]), { key: 'note:1:36', press: true, value01: 1 });
  assert.equal(decodeMessage([0x90, 36, 0]).press, false);
  assert.equal(decodeMessage([0x80, 36, 64]).press, false);
});

test('CC: absolute value and relative encoder delta', () => {
  const knob = decodeMessage([0xb0, 10, 64]);
  assert.ok(Math.abs(knob.value01 - 64 / 127) < 1e-9);
  assert.equal(decodeMessage([0xb0, 20, 3]).delta, 3);
  assert.equal(decodeMessage([0xb0, 20, 125]).delta, -3);
  assert.equal(decodeMessage([0xb0, 20, 64]).delta, 0);
});

test('14-bit pitch bend', () => {
  assert.equal(decodeMessage([0xe0, 0, 0]).value01, 0);
  assert.equal(decodeMessage([0xe0, 0x7f, 0x7f]).value01, 1);
  assert.ok(Math.abs(decodeMessage([0xe0, 0, 0x40]).value01 - 0.5) < 0.001);
});
