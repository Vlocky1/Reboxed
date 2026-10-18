import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBeats } from '../src/shared/dsp/bpm.js';
import { detectKey } from '../src/shared/dsp/key.js';
import { reduceBands, loudnessDb, u8ToBase64, base64ToU8 } from '../src/shared/dsp/waveform.js';
import { toCamelot, toMusical, parseKey, compatibleKeys, transposeKey, normalizeKeyText } from '../src/shared/keys.js';

const SR = 11025;

/** Kick-like drum pattern (kick every beat, hat on off-beats) with a little noise. */
function drumLoop(bpm, seconds, firstBeat) {
  const out = new Float32Array(Math.round(seconds * SR));
  const period = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let t = firstBeat; t < seconds; t += period) {
    const s = Math.round(t * SR);
    for (let j = 0; j < SR * 0.15 && s + j < out.length; j++) {
      const env = Math.exp(-j / (SR * 0.03));
      out[s + j] += 0.8 * env * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (SR * 0.01))) * (j / SR));
    }
    const h = Math.round((t + period / 2) * SR);
    for (let j = 0; j < SR * 0.03 && h + j < out.length; j++) out[h + j] += 0.2 * rnd() * Math.exp(-j / (SR * 0.005));
  }
  return out;
}

for (const [bpm, first] of [[128, 0.3], [174, 0.1], [93.5, 0.52], [140, 0]]) {
  test(`detects ${bpm} BPM and the beat phase`, () => {
    const r = detectBeats(drumLoop(bpm, 40, first), SR, bpm > 156 ? { minBpm: 88, maxBpm: 180 } : undefined);
    assert.ok(Math.abs(r.bpm - bpm) < 0.05, `bpm ${r.bpm}`);
    const period = 60 / bpm;
    const err = Math.abs(((r.firstBeat - first + period / 2) % period + period) % period - period / 2);
    assert.ok(err < 0.01, `phase error ${err.toFixed(3)} (got ${r.firstBeat})`);
  });
}

test('folds tempo into the configured range', () => {
  const r = detectBeats(drumLoop(174, 30, 0.1), SR, { minBpm: 70, maxBpm: 140 });
  assert.ok(Math.abs(r.bpm - 87) < 0.05, `bpm ${r.bpm}`);
});

/** Chord progression with harmonics. Notes as MIDI numbers. */
function progression(chords, secondsEach = 2) {
  const out = new Float32Array(Math.round(chords.length * secondsEach * SR));
  chords.forEach((notes, c) => {
    const start = Math.round(c * secondsEach * SR);
    for (const midi of notes) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < secondsEach * SR; i++) {
        const t = i / SR;
        out[start + i] += 0.2 * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t));
      }
    }
  });
  return out;
}

test('detects A minor (i-iv-V-i with G#)', () => {
  const k = detectKey(progression([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64], [45, 57, 64]]), SR);
  assert.deepEqual([k.tonic, k.mode], [9, 'minor']);
  assert.equal(toCamelot(k), '8A');
});

test('detects C major (I-IV-V-I)', () => {
  const k = detectKey(progression([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67], [48, 60, 64]]), SR);
  assert.deepEqual([k.tonic, k.mode], [0, 'major']);
  assert.equal(toCamelot(k), '8B');
});

test('Camelot / musical conversions and parsing', () => {
  const all = [];
  for (let t = 0; t < 12; t++) for (const mode of ['major', 'minor']) all.push({ tonic: t, mode });
  const codes = new Set(all.map(toCamelot));
  assert.equal(codes.size, 24);
  for (const k of all) assert.deepEqual(parseKey(toCamelot(k)), k);
  for (const k of all) assert.deepEqual(parseKey(toMusical(k)), k);
  assert.equal(toCamelot({ tonic: 0, mode: 'minor' }), '5A');
  assert.equal(toCamelot({ tonic: 1, mode: 'major' }), '3B');
  assert.equal(normalizeKeyText('F#m'), '11A');
  assert.equal(normalizeKeyText('A♭ minor'), '1A');
  assert.equal(normalizeKeyText('Gbmaj'), '2B');
  assert.equal(normalizeKeyText('08A'), '8A');
  assert.equal(normalizeKeyText('nonsense'), '');
  assert.deepEqual(compatibleKeys('12A'), ['12A', '11A', '1A', '12B']);
  assert.equal(transposeKey('8A', 1), '3A');   // Am -> Bbm
  assert.equal(transposeKey('8A', 7), '9A');   // Am -> Em
});

test('waveform reduction and loudness', () => {
  const sr = 1500;
  const low = new Float32Array(sr * 2).map((_, i) => (i < sr ? 0.5 : 1) * Math.sin(i));
  const wf = reduceBands([low, low, low], sr, 150);
  assert.equal(wf.low.length, 300);
  assert.ok(wf.low[10] < wf.low[200]);
  assert.deepEqual(base64ToU8(u8ToBase64(wf.mid)), wf.mid);
  const quiet = loudnessDb(new Float32Array(sr * 4).map((_, i) => 0.1 * Math.sin(i / 3)), sr);
  const loud = loudnessDb(new Float32Array(sr * 4).map((_, i) => 0.5 * Math.sin(i / 3)), sr);
  assert.ok(Math.abs(loud - quiet - 13.98) < 0.3, `${loud} vs ${quiet}`);
});
