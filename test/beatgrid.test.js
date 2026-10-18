import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Beatgrid, shiftGrid, doubleGrid, halveGrid, setDownbeatAt, constantGridAt, tapBpm } from '../src/shared/beatgrid.js';

test('grid editing helpers', () => {
  const g = { bpm: 120, firstBeat: 0.2, beat: 1 };
  assert.equal(shiftGrid(g, 0.01).firstBeat, 0.21);
  assert.equal(doubleGrid(g).bpm, 240);
  const half = halveGrid({ bpm: 120, firstBeat: 0.2, beat: 2 }); // beat 0 is 2nd in bar -> start from beat 1? barPos(0)=1 (odd) -> start at index 1
  assert.equal(half.bpm, 60); assert.ok(Math.abs(half.firstBeat - 0.7) < 1e-9);
  const dyn = { bpm: 120, firstBeat: 0, beat: 1, beats: [0, 0.5, 1, 1.5, 2] };
  assert.deepEqual(doubleGrid(dyn).beats, [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.deepEqual(halveGrid(dyn).beats, [0, 1, 2]);
  assert.deepEqual(shiftGrid(dyn, -0.1).beats, [-0.1, 0.4, 0.9, 1.4, 1.9]);
  const down = setDownbeatAt(g, 1.73);            // nearest beat is index 3 (1.7)
  const bg = new Beatgrid(down);
  assert.ok(Math.abs(bg.timeOf(3) - 1.73) < 1e-9);
  assert.ok(bg.isDownbeat(3));
  const c = constantGridAt(125, 10.0, 1);        // beat at 10 s is a downbeat
  const cg = new Beatgrid(c);
  assert.ok(Math.abs(cg.timeOf(Math.round(cg.indexAt(10))) - 10) < 0.002);
  assert.ok(cg.isDownbeat(Math.round(cg.indexAt(10))));
  assert.equal(tapBpm([0, 500, 1000, 1500]), 120);
  assert.equal(tapBpm([0]), 0);
});
import { detectBeats } from '../src/shared/dsp/bpm.js';
import { trackBeatsDynamic, isSteadyTempo, detectDownbeat } from '../src/shared/dsp/beats-dynamic.js';

const SR = 11025;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function addKick(out, t, gain = 0.8) {
  const s = Math.round(t * SR);
  for (let j = 0; j < SR * 0.15 && s + j < out.length; j++) {
    out[s + j] += gain * Math.exp(-j / (SR * 0.03)) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (SR * 0.01))) * (j / SR));
  }
}
function addTone(out, t0, t1, freq, gain) {
  for (let i = Math.round(t0 * SR); i < Math.min(out.length, Math.round(t1 * SR)); i++) out[i] += gain * Math.sin(2 * Math.PI * freq * (i / SR));
}

test('constant grid maths and bar positions', () => {
  const g = new Beatgrid({ bpm: 120, firstBeat: 0.1, beat: 3 });
  assert.equal(g.timeOf(4), 2.1);
  assert.ok(Math.abs(g.indexAt(1.35) - 2.5) < 1e-9);
  assert.equal(g.barPos(0), 2);
  assert.equal(g.isDownbeat(2), true);
  assert.equal(g.isDownbeat(6), true);
  assert.ok(Math.abs(g.snap(1.33) - 1.1) < 1e-9);
  assert.ok(Math.abs(g.floorBar(3.0) - 1.1) < 1e-9);  // downbeats at beat 2 (1.1 s), 6 (3.1 s)
  assert.deepEqual(g.tempoMarkers(), [{ start: 0.1, bpm: 120, beat: 3 }]);
});

test('dynamic grid interpolation, extrapolation and tempo markers', () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.4, 2.8, 3.2, 3.6];
  const g = new Beatgrid({ bpm: 135, firstBeat: 0, beat: 1, beats });
  assert.ok(g.dynamic);
  assert.ok(Math.abs(g.timeOf(5.5) - 2.6) < 1e-9);
  assert.ok(Math.abs(g.indexAt(2.6) - 5.5) < 1e-9);
  assert.ok(Math.abs(g.timeOf(-1) - -0.5) < 1e-9);
  assert.ok(Math.abs(g.timeOf(9) - 4.0) < 1e-9);
  assert.ok(Math.abs(g.bpmAt(0.7) - 120) < 1e-9);
  assert.ok(Math.abs(g.bpmAt(3.0) - 150) < 1e-9);
  const m = g.tempoMarkers();
  assert.equal(m.length, 2);
  assert.deepEqual([m[0].bpm, m[1].start, m[1].bpm], [120, 2, 150]);
  const back = Beatgrid.fromMarkers(m, 3.7);
  assert.ok(back.dynamic);
  for (let i = 0; i < beats.length; i++) assert.ok(Math.abs(back.timeOf(i) - beats[i]) < 0.002, `beat ${i}`);
});

test('dynamic tracking follows a tempo ramp 120 -> 132 BPM', () => {
  const seconds = 40;
  const out = new Float32Array(seconds * SR);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  const truth = [];
  let phase = 0; const dt = 1 / 1000;
  let next = 0.3;
  for (let t = 0; t < seconds; t += dt) {
    if (t >= next) { truth.push(next); addKick(out, next); phase = 0; }
    const bpm = 120 + 12 * (t / seconds);
    phase += (bpm / 60) * dt;
    if (phase >= 1 && truth.length) { next = t; phase -= 1; next = t + dt; }
  }
  const { bpm } = detectBeats(out, SR, { minBpm: 88, maxBpm: 175 });
  const beats = trackBeatsDynamic(out, SR, bpm);
  assert.equal(isSteadyTempo(beats), false);
  let good = 0;
  for (const tt of truth.slice(2, -2)) {
    const nearest = beats.reduce((m, b) => (Math.abs(b - tt) < Math.abs(m - tt) ? b : m), Infinity);
    if (Math.abs(nearest - tt) < 0.02) good++;
  }
  const ratio = good / (truth.length - 4);
  assert.ok(ratio > 0.9, `${(ratio * 100).toFixed(1)}% of beats within 20 ms`);
});

test('steady tracks are recognised as constant tempo', () => {
  const out = new Float32Array(30 * SR);
  for (let t = 0.2; t < 30; t += 60 / 126) addKick(out, t);
  const beats = trackBeatsDynamic(out, SR, 126);
  assert.equal(isSteadyTempo(beats), true);
});

test('downbeat follows harmonic changes and accents', () => {
  const bpm = 120; const p = 0.5; const first = 0.25;
  const out = new Float32Array(32 * SR);
  const roots = [110, 87.31, 130.81, 98];
  for (let i = 0; i < 60; i++) {
    const t = first + i * p;
    const isBarStart = (i - 2) % 4 === 0;   // bars start at beat 2
    addKick(out, t, isBarStart ? 1 : 0.7);
    if (isBarStart) {
      const root = roots[Math.floor((i - 2) / 4) % 4];
      addTone(out, t, t + 4 * p, root, 0.15);
      addTone(out, t, t + 4 * p, root * 1.5, 0.08);
    }
  }
  const g = new Beatgrid({ bpm, firstBeat: first });
  const beatNum = detectDownbeat(out, SR, (i) => g.timeOf(i), 60);
  assert.equal(beatNum, 3); // beat 0 is the 3rd beat of its bar
});
