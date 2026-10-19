import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRUM_PATTERNS, renderPattern, voice } from '../src/shared/drumkit.js';

test('8 built-in DRUM SWAP patterns with valid 16-step grids', () => {
  assert.equal(DRUM_PATTERNS.length, 8);
  for (const p of DRUM_PATTERNS) {
    for (const [name, grid] of Object.entries(p.tracks)) {
      const bars = grid.split('|');
      assert.equal(bars.length, p.bars, `${p.name} ${name} bars`);
      for (const b of bars) assert.match(b, /^[xor.]{16}$/, `${p.name} ${name}`);
      assert.ok(voice(name).length > 0, name);
    }
  }
});

test('patterns render at the deck tempo: exact loop length, normalised, deterministic', () => {
  for (const bpm of [92, 124, 140]) {
    const p = DRUM_PATTERNS[0];
    const r = renderPattern(p, bpm, 44100);
    assert.equal(r.left.length, Math.round((60 / bpm) * 4 * p.bars * 44100));
    let peak = 0;
    for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]), Math.abs(r.right[i]));
    assert.ok(Math.abs(peak - 0.85) < 1e-6, `peak ${peak}`);
  }
  const a = renderPattern(DRUM_PATTERNS[4], 128);
  const b = renderPattern(DRUM_PATTERNS[4], 128);
  assert.deepEqual(a.left.slice(0, 2000), b.left.slice(0, 2000));
});

test('four-on-the-floor kicks land on the beats', () => {
  const bpm = 120;
  const r = renderPattern(DRUM_PATTERNS[0], bpm, 44100);
  const beat = (60 / bpm) * 44100;
  const energy = (from, len) => { let e = 0; for (let i = from; i < from + len; i++) e += r.left[i] ** 2; return e; };
  for (let k = 0; k < 4; k++) {
    const on = energy(Math.round(k * beat), 800);
    const off = energy(Math.round(k * beat + beat * 0.6), 800);
    assert.ok(on > off * 3, `beat ${k}: on ${on.toFixed(2)} off ${off.toFixed(2)}`);
  }
});
