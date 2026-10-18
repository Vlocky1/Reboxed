import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioFeatures, featureSimilarity, suggest, FEATURE_DIM } from '../src/shared/dsp/features.js';

const SR = 11025;
function tone(freqs, seconds = 20, kickBpm = 0, noise = 0) {
  const out = new Float32Array(seconds * SR);
  let seed = 11;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    for (const f of freqs) out[i] += 0.2 * Math.sin(2 * Math.PI * f * t);
    if (noise) out[i] += noise * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
  }
  if (kickBpm) {
    for (let t = 0; t < seconds; t += 60 / kickBpm) {
      const s = Math.round(t * SR);
      for (let j = 0; j < SR * 0.12 && s + j < out.length; j++) out[s + j] += 0.8 * Math.exp(-j / (SR * 0.03)) * Math.sin(2 * Math.PI * 55 * (j / SR));
    }
  }
  return out;
}

test('feature vector shape and range', () => {
  const f = audioFeatures(tone([220, 277, 330], 20, 128), SR, 128);
  assert.equal(f.length, FEATURE_DIM);
  assert.ok(f.every((v) => v >= 0 && v <= 1), f.join(','));
});

test('similar sounds score higher than different ones', () => {
  const houseA = audioFeatures(tone([220, 261.6, 329.6], 20, 126), SR, 126);
  const houseB = audioFeatures(tone([220, 261.6, 329.6], 20, 128), SR, 128);
  const ambient = audioFeatures(tone([1760, 2217, 2637], 20, 0, 0.05), SR, 0);
  assert.ok(featureSimilarity(houseA, houseB) > featureSimilarity(houseA, ambient));
  assert.ok(Math.abs(featureSimilarity(houseA, houseA) - 1) < 1e-9);
  const ranked = suggest({ id: 's', bpm: 126 }, houseA, [
    { track: { id: 'amb', bpm: 0 }, features: ambient },
    { track: { id: 'hb', bpm: 128 }, features: houseB },
    { track: { id: 's', bpm: 126 }, features: houseA },
    { track: { id: 'none', bpm: 126 }, features: null },
  ]);
  assert.deepEqual(ranked.map((r) => r.track.id), ['hb', 'amb']);
});
