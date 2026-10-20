// Master tempo / key shift quality: runs the real deck worklet (deck-processor.js) outside the
// browser on pure tones and measures how steady the output level stays. Grains that do not line
// up cancel each other in the overlaps: the level wobbles ~20 times a second ("robot" voice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SR = 44100;

/** The worklet class, with the AudioWorkletGlobalScope stubs it needs. */
function loadProcessor() {
  let Cls = null;
  const scope = {
    sampleRate: SR, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
    registerProcessor: (_name, c) => { Cls = c; },
  };
  const src = readFileSync(new URL('../src/renderer/audio/deck-processor.js', import.meta.url), 'utf8');
  new Function(...Object.keys(scope), src)(...Object.values(scope));
  return Cls;
}

/** Play `seconds` of `channels` with the given messages; returns the left output. */
function render(channels, msgs, seconds) {
  const P = loadProcessor();
  const p = new P();
  p.onMessage({ type: 'load', channels, sampleRate: SR });
  for (const m of msgs) p.onMessage(m);
  p.onMessage({ type: 'play' });
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += 128) {
    const o = [[new Float32Array(128), new Float32Array(128)]];
    p.process([], o);
    out.set(o[0][0].subarray(0, Math.min(128, out.length - i)), i);
  }
  return out;
}

/** Spread of the level (RMS in 10 ms windows): std / mean, after the first 0.3 s. */
function wobble(x) {
  const w = Math.round(0.01 * SR);
  const levels = [];
  for (let i = Math.round(0.3 * SR); i + w < x.length; i += w) {
    let e = 0;
    for (let k = 0; k < w; k++) e += x[i + k] ** 2;
    levels.push(Math.sqrt(e / w));
  }
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length);
  return sd / mean;
}

const tone = (freqs, seconds = 4) => {
  const c = new Float32Array(seconds * SR);
  for (let i = 0; i < c.length; i++) c[i] = freqs.reduce((a, f) => a + Math.sin((2 * Math.PI * f * i) / SR), 0) / freqs.length * 0.5;
  return [c, c.slice()];
};

// A chord has its own level beats: the stretched sound is compared with the chord it should become
// (same notes, transposed by the key shift), played plainly. The stretch may add at most 3 points.
const CHORD = [220, 277.18, 329.63];
const cases = [
  ['master tempo +8 %, tone', [440], 0, [{ type: 'rate', rate: 1.08 }, { type: 'keyLock', on: true }]],
  ['master tempo +8 %, chord', CHORD, 0, [{ type: 'rate', rate: 1.08 }, { type: 'keyLock', on: true }]],
  ['master tempo -6 %, chord', CHORD, 0, [{ type: 'rate', rate: 0.94 }, { type: 'keyLock', on: true }]],
  ['key shift +3, chord', CHORD, 3, [{ type: 'keyShift', semitones: 3 }]],
  ['key shift -5 with master tempo +4 %, chord', CHORD, -5, [{ type: 'rate', rate: 1.04 }, { type: 'keyLock', on: true }, { type: 'keyShift', semitones: -5 }]],
];
for (const [name, freqs, semis, msgs] of cases) {
  test(`${name}: steady level (no robotic wobble)`, (t) => {
    const wob = wobble(render(tone(freqs), msgs, 2.5));
    const ref = wobble(render(tone(freqs.map((f) => f * 2 ** (semis / 12))), [], 2.5));
    t.diagnostic(`level wobble ${(wob * 100).toFixed(1)} % (the expected sound itself: ${(ref * 100).toFixed(1)} %)`);
    assert.ok(wob < ref + 0.03, `level wobble ${(wob * 100).toFixed(1)} % vs ${(ref * 100).toFixed(1)} % for the expected sound`);
  });
}

test('plain playback (no stretch) is untouched', (t) => {
  const out = render(tone([440]), [], 1.5);
  t.diagnostic(`chord itself: level wobble ${(wobble(render(tone(CHORD), [], 2.5)) * 100).toFixed(1)} %`);
  assert.ok(wobble(out) < 0.01);
});
