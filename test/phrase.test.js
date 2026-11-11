import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePhrases } from '../src/shared/dsp/phrase.js';
import { createCues } from '../src/shared/autocues.js';
import { Beatgrid } from '../src/shared/beatgrid.js';

const SR = 11025;
const BPM = 128;
const P = 60 / BPM;
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function addKick(out, t, gain) {
  const s = Math.round(t * SR);
  for (let j = 0; j < SR * 0.15 && s + j < out.length; j++) out[s + j] += gain * Math.exp(-j / (SR * 0.03)) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (SR * 0.01))) * (j / SR));
}
function addHat(out, t, gain) {
  const s = Math.round(t * SR);
  for (let j = 0; j < SR * 0.03 && s + j < out.length; j++) out[s + j] += gain * rnd() * Math.exp(-j / (SR * 0.006));
}
function addPad(out, t0, t1, gain) {
  for (let i = Math.round(t0 * SR); i < Math.min(out.length, Math.round(t1 * SR)); i++) {
    const x = i / SR;
    out[i] += gain * (Math.sin(2 * Math.PI * 440 * x) + Math.sin(2 * Math.PI * 554.37 * x) + Math.sin(2 * Math.PI * 659.25 * x)) / 3;
  }
}

/**
 * intro 16 bars (kick+hats) | breakdown 8 (pad only) | chorus 16 (kick+hats+bass+lead loud) | outro 8 (kick);
 * `lead` extra intro bars first (the phrases then start that many bars into the file).
 */
function track(lead = 0) {
  const bars = 48 + lead;
  const out = new Float32Array(Math.ceil((bars * 4 * P + 1) * SR));
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * P;
    const c = b - lead;
    const section = c < 16 ? 'intro' : c < 24 ? 'down' : c < 40 ? 'chorus' : 'outro';
    for (let k = 0; k < 4; k++) {
      const t = t0 + k * P;
      if (section !== 'down') addKick(out, t, section === 'chorus' ? 0.9 : 0.6);
      if (section === 'intro' || section === 'chorus') addHat(out, t + P / 2, section === 'chorus' ? 0.35 : 0.15);
    }
    if (section === 'down') addPad(out, t0, t0 + 4 * P, 0.25);
    if (section === 'chorus') { addPad(out, t0, t0 + 4 * P, 0.3); }
  }
  return out;
}

test('phrases: intro / breakdown / chorus / outro on the right bars', () => {
  const grid = new Beatgrid({ bpm: BPM, firstBeat: 0, beat: 1 });
  const samples = track();
  const r = analyzePhrases(samples, SR, grid, samples.length / SR);
  assert.equal(r.mood, 'high');
  assert.deepEqual(r.phrases.map((p) => [p.label, p.startBar, p.bars]), [
    ['INTRO', 0, 16], ['DOWN', 16, 8], ['CHORUS', 24, 16], ['OUTRO', 40, 8],
  ]);
  assert.ok(Math.abs(r.phrases[2].start - 24 * 4 * P) < 0.01);
});

test('phrases that start a bar into the file are not counted a bar early (1.23.2)', () => {
  const grid = new Beatgrid({ bpm: BPM, firstBeat: 0, beat: 1 });
  for (const lead of [1, 2, 3]) {
    const samples = track(lead);
    const r = analyzePhrases(samples, SR, grid, samples.length / SR);
    assert.deepEqual(r.phrases.slice(1).map((p) => [p.label, p.startBar]), [['DOWN', 16 + lead], ['CHORUS', 24 + lead], ['OUTRO', 40 + lead]], `${lead} bar(s) in`);
    assert.equal(r.barOffset, lead);
  }
});

test('intelligent cues from phrases', () => {
  const grid = new Beatgrid({ bpm: BPM, firstBeat: 0, beat: 1 });
  const phrases = { phrases: [
    { start: 0, end: 30, label: 'INTRO', num: 1, bars: 16 },
    { start: 30, end: 45, label: 'DOWN', num: 1, bars: 8 },
    { start: 45, end: 75, label: 'CHORUS', num: 1, bars: 16 },
    { start: 75, end: 90, label: 'OUTRO', num: 1, bars: 8 },
  ] };
  const cues = createCues(phrases, grid, [{ kind: 'hot', slot: 0, start: 1.5, name: 'mine' }]);
  const hot = cues.filter((c) => c.kind === 'hot').sort((a, b) => a.slot - b.slot);
  assert.deepEqual(hot.map((c) => [c.slot, c.name]), [[0, 'mine'], [1, 'CHORUS'], [2, 'DOWN'], [3, 'OUTRO'], [4, 'INTRO LOOP']]);
  assert.equal(hot[4].end, 32 * P);
  assert.deepEqual(cues.filter((c) => c.kind === 'memory').map((c) => c.name), ['INTRO 1', 'DOWN 1', 'CHORUS 1', 'OUTRO 1']);
  const over = createCues(phrases, grid, [{ kind: 'hot', slot: 0, start: 1.5 }], { overwrite: true, introLoop: false });
  assert.equal(over.find((c) => c.slot === 0).name, 'INTRO');
  assert.equal(createCues(phrases, grid, cues).length, cues.length); // idempotent
});
