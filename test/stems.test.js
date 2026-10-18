import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separateSpleeter, separateDemucs, stemEnvelope, orderFrom, mixStats, STEM_RATE, ENV_PPS, SEGMENT } from '../src/main/stems-core.js';

// Minimal stand-ins for onnxruntime: Tensor wrapper and sessions with a fixed transfer function.
const ort = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };
const identity = { run: async ({ x }) => ({ y: { data: x.data } }) };
const spleeterSessions = { vocals: identity, drums: identity, bass: identity, other: identity };
const quarterDemucs = {
  run: async ({ mix }) => {
    const n = mix.dims[2];
    const out = new Float32Array(4 * 2 * n);
    for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[(s * 2 + c) * n + i] = mix.data[c * n + i] / 4;
    return { stems: { data: out } };
  },
};

function signal(seconds, seed = 3) {
  const n = Math.round(seconds * STEM_RATE);
  const l = new Float32Array(n); const r = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    const t = i / STEM_RATE;
    s = (s * 16807) % 2147483647;
    l[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t) + 0.05 * ((s / 2147483647) * 2 - 1);
    r[i] = 0.3 * Math.sin(2 * Math.PI * 165 * t + 1) + 0.04 * Math.sin(2 * Math.PI * 3000 * t);
  }
  return { l, r, n };
}

/** Collect blocks, check they tile [0, n) exactly once, return the summed stems. */
function collector(n) {
  const covered = new Uint8Array(n);
  const sumL = new Float32Array(n); const sumR = new Float32Array(n);
  const starts = [];
  return {
    starts, covered,
    onBlock(start, len, stems) {
      starts.push(start);
      for (let i = 0; i < len; i++) {
        covered[start + i]++;
        for (let s = 0; s < 4; s++) { sumL[start + i] += stems[s][0][i]; sumR[start + i] += stems[s][1][i]; }
      }
    },
    err(l, r) {
      let e = 0; let p = 0;
      for (let i = 0; i < n; i++) { e += (sumL[i] - l[i]) ** 2 + (sumR[i] - r[i]) ** 2; p += l[i] ** 2 + r[i] ** 2; }
      return 10 * Math.log10(e / p + 1e-30);
    },
  };
}

test('processing order starts at the play head chunk', () => {
  assert.deepEqual(orderFrom(5, 2), [2, 3, 4, 1, 0]);
  assert.deepEqual(orderFrom(3, 9), [2, 1, 0]);
  assert.deepEqual(orderFrom(1, 0), [0]);
});

test('FAST (Spleeter) STFT/mask/iSTFT reconstructs the mix, blocks tile once from the play head', async () => {
  const { l, r, n } = signal(30);
  const c = collector(n);
  const start = 18 * STEM_RATE;
  await separateSpleeter(spleeterSessions, ort, l, r, { startSample: start, onBlock: (...a) => c.onBlock(...a) });
  assert.ok(c.covered.every((v) => v === 1), 'every sample emitted exactly once');
  assert.ok(c.starts[0] <= start && start < c.starts[0] + 504 * 1024, `first block holds the play head (starts at ${c.starts[0]})`);
  const err = c.err(l, r);
  assert.ok(err < -100, `sum(stems) - mix = ${err.toFixed(1)} dB`);
});

test('HQ (Demucs) overlap-add + normalisation: blocks final once, sum = mix', async () => {
  const { l, r, n } = signal(20);
  const { mean } = mixStats(l, r);
  const c = collector(n);
  const start = SEGMENT * 1.2;
  await separateDemucs(quarterDemucs, ort, l, r, { startSample: start, onBlock: (...a) => c.onBlock(...a) });
  assert.ok(c.covered.every((v) => v === 1), 'every sample emitted exactly once');
  // sources = (x - mean)/4 + mean each, so their sum is x + 3*mean
  for (let i = 0; i < n; i++) { l[i] += 3 * mean; r[i] += 3 * mean; }
  // The first samples carry the fade-in window (weight -> 0), so skip a few ms.
  const err = c.err(l, r);
  assert.ok(err < -60, `sum(stems) - mix = ${err.toFixed(1)} dB`);
});

test('stem envelopes are time-aligned peaks', () => {
  const per = STEM_RATE / ENV_PPS;
  const l = new Float32Array(per * 3); const r = new Float32Array(per * 3);
  l[per + 5] = 0.5; r[2 * per] = -1;
  const env = stemEnvelope([l, r], per * 10);
  assert.equal(env.start, 10);
  assert.deepEqual([...env.data], [0, 128, 255]);
});

test('mergeRange keeps stem coverage sorted and merged', async () => {
  const { mergeRange } = await import('../src/renderer/audio/deck.js');
  let r = [];
  r = mergeRange(r, [100, 200]);
  r = mergeRange(r, [0, 50]);
  r = mergeRange(r, [300, 400]);
  assert.deepEqual(r, [[0, 50], [100, 200], [300, 400]]);
  r = mergeRange(r, [50, 100]);
  assert.deepEqual(r, [[0, 200], [300, 400]]);
  r = mergeRange(r, [150, 350]);
  assert.deepEqual(r, [[0, 400]]);
});
