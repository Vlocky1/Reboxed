import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finePeaks, lerpAt, FINE_BLOCK } from '../src/shared/dsp/waveform.js';

test('fine peaks keep the real wave shape (asymmetric min / max per block)', () => {
  const rate = 44100;
  const n = rate; // 1 s
  const l = new Float32Array(n);
  // Half-wave rectified 100 Hz: the bottom stays at 0, the top follows the sine.
  for (let i = 0; i < n; i++) l[i] = Math.max(0, Math.sin((2 * Math.PI * 100 * i) / rate)) * 0.5;
  const f = finePeaks([l], rate);
  assert.equal(f.pps, rate / FINE_BLOCK);
  assert.equal(f.max.length, Math.ceil(n / FINE_BLOCK));
  assert.ok(Math.max(...f.max) >= 126, 'full height at the reference peak');
  assert.equal(Math.min(...f.min), 0, 'no negative half');
  // One period = 441 samples ≈ 27.6 blocks: the top rises and falls inside it (a wave, not a block).
  const period = f.max.slice(0, 28);
  assert.ok(new Set(period).size > 10, `${new Set(period).size} distinct heights in one period`);
});

test('stereo is mixed to mono and silence stays flat', () => {
  const l = new Float32Array(1600).fill(0.5);
  const r = new Float32Array(1600).fill(-0.5);
  const f = finePeaks([l, r], 48000);
  assert.ok(f.max.every((v) => v === 0) && f.min.every((v) => v === 0));
});

test('lerpAt interpolates between points centred on their span', () => {
  const a = Uint8Array.from([0, 100, 200]);
  assert.equal(lerpAt(a, 0.5), 0);
  assert.equal(lerpAt(a, 1.0), 50);
  assert.equal(lerpAt(a, 2.5), 200);
  assert.equal(lerpAt(a, 10), 200);
  assert.equal(lerpAt(a, -3), 0);
});
