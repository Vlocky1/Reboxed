// What makes Reboxed lighter must not change what it computes or how it sounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fft, RealFft, hann } from '../src/shared/dsp/fft.js';
import { onsetEnvelope } from '../src/shared/dsp/onset.js';
import { detectBeats } from '../src/shared/dsp/bpm.js';
import { chromagram, detectKey } from '../src/shared/dsp/key.js';
import { audioFeatures } from '../src/shared/dsp/features.js';
import { toCompactPcm, COMPACT_SCALE, lowMemoryWanted } from '../src/shared/pcm.js';

const SR = 11025;
function music(seconds) {
  const s = new Float32Array(SR * seconds); let x = 1;
  for (let i = 0; i < s.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const t = i / SR; const b = (t * 124 / 60) % 1;
    s[i] = 0.7 * Math.exp(-b * 18) * Math.sin(2 * Math.PI * 60 * t) + 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.08 * Math.sin(2 * Math.PI * 329.6 * t) + 0.1 * (x / 2147483648 - 0.5);
  }
  return s;
}

test('the real-signal FFT gives the same magnitudes as the full FFT', () => {
  for (const n of [512, 2048, 4096, 8192]) {
    const win = hann(n); const s = music(1);
    const x = Float64Array.from({ length: n }, (_, i) => s[i % s.length] * win[i]);
    const re = x.slice(); const im = new Float64Array(n);
    fft(re, im);
    const mag = new Float64Array(n / 2);
    new RealFft(n).magnitudes(x, mag);
    for (let k = 0; k < n / 2; k++) assert.ok(Math.abs(mag[k] - Math.hypot(re[k], im[k])) < 1e-9, `n=${n} bin ${k}`);
  }
});

test('results computed once and shared are the ones computed separately', () => {
  const s = music(90);
  const onset = onsetEnvelope(s, SR);
  const chroma = chromagram(s, SR);
  assert.deepEqual(detectBeats(s, SR, { onset }), detectBeats(s, SR));
  assert.deepEqual(detectKey(s, SR, chroma), detectKey(s, SR));
  assert.deepEqual(audioFeatures(s, SR, 124, { chroma, onset }), audioFeatures(s, SR, 124));
  const short = s.subarray(0, SR * 20); // shorter than the minute the fingerprint looks at
  assert.deepEqual(audioFeatures(short, SR, 124, { onset: onsetEnvelope(short, SR), chroma: chromagram(short, SR) }), audioFeatures(short, SR, 124));
});

/** The real deck worklet, outside the browser (see stretch.test.js). */
function render(channels, scale, msgs, seconds) {
  let Cls = null;
  const scope = { sampleRate: 44100, currentTime: 0, AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } }, registerProcessor: (_n, c) => { Cls = c; } };
  new Function(...Object.keys(scope), readFileSync(new URL('../src/renderer/audio/deck-processor.js', import.meta.url), 'utf8'))(...Object.values(scope));
  const p = new Cls();
  p.onMessage({ type: 'load', channels, sampleRate: 44100, scale });
  for (const m of msgs) p.onMessage(m);
  p.onMessage({ type: 'play' });
  const out = new Float32Array(Math.round(seconds * 44100));
  for (let i = 0; i < out.length; i += 128) {
    const o = [[new Float32Array(128), new Float32Array(128)]];
    p.process([], o);
    out.set(o[0][0].subarray(0, Math.min(128, out.length - i)), i);
  }
  return out;
}
const db = (a, b) => { let e = 0; let r = 0; for (let i = 0; i < a.length; i++) { e += (a[i] - b[i]) ** 2; r += a[i] ** 2; } return 10 * Math.log10(e / r); };

test('low memory mode: half the memory, the same sound, no clipping on hot tracks', () => {
  const src = new Float32Array(44100 * 4);
  for (let i = 0; i < src.length; i++) src[i] = 1.3 * Math.sin((2 * Math.PI * 440 * i) / 44100) * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 44100));
  const packed = toCompactPcm(src);
  assert.equal(packed.byteLength, src.byteLength / 2);
  let worst = 0;
  for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(src[i] - packed[i] * COMPACT_SCALE));
  assert.ok(worst < COMPACT_SCALE, `overs above full scale survive: error ${worst}`);
  for (const [name, msgs, limit] of [['plain', [], -80], ['pitched', [{ type: 'rate', rate: 1.06 }], -80], ['master tempo', [{ type: 'rate', rate: 1.06 }, { type: 'keyLock', on: true }], -70]]) {
    const a = render([src.slice(), src.slice()], 1, msgs, 2);
    const b = render([packed.slice(), packed.slice()], COMPACT_SCALE, msgs, 2);
    const d = db(a, b);
    assert.ok(d < limit, `${name}: difference ${d.toFixed(1)} dB`);
  }
});

test('low memory mode: automatic at 8 GB of RAM or less', () => {
  assert.equal(lowMemoryWanted('auto', 7.9), true);
  assert.equal(lowMemoryWanted('auto', 4), true);
  assert.equal(lowMemoryWanted('auto', 16), false);
  assert.equal(lowMemoryWanted('auto', 0), false, 'unknown size');
  assert.equal(lowMemoryWanted('on', 32), true);
  assert.equal(lowMemoryWanted('off', 4), false);
});
