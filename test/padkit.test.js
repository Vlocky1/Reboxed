import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lpxMode, lpxRgb, lpxDecode, padNote, padCell, sideCc, isLpxPort } from '../src/shared/launchpad.js';
import { defaultKits, normalizeKit, instrumentNote, noteRole, quantizeDelay, padRate, PAD_COUNT, idx } from '../src/shared/padkit.js';
import { synthNote, fxSound, drumSound, INSTRUMENTS, FX_SOUNDS, DRUM_SOUNDS } from '../src/shared/padsynth.js';
import { LightShow, effectAt } from '../src/shared/lightshow.js';

test('Launchpad X: Programmer mode and RGB SysEx as in the Programmer’s Reference', () => {
  assert.deepEqual(lpxMode(true), [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7]);
  assert.deepEqual(lpxMode(false).slice(-2), [0x00, 0xf7]);
  const [msg] = lpxRgb([[11, 127, 0, 64]]);
  assert.deepEqual(msg, [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x03, 3, 11, 127, 0, 64, 0xf7]);
  const many = lpxRgb(Array.from({ length: 100 }, (_, i) => [i, 1, 2, 3]));
  assert.equal(many.length, 2); // 81 entries per message at most
  assert.equal(many[0].length, 7 + 81 * 5 + 1);
});

test('Launchpad X: pad notes, side and top buttons', () => {
  assert.equal(padNote(0, 7), 11); // bottom-left
  assert.equal(padNote(7, 0), 88); // top-right
  assert.deepEqual(padCell(11), { x: 0, y: 7 });
  assert.equal(padCell(19), null);
  assert.equal(sideCc(0), 89);
  assert.deepEqual(lpxDecode([0x90, 81, 100]), { kind: 'pad', x: 0, y: 0, velocity: 100 });
  assert.deepEqual(lpxDecode([0x90, 81, 0]), { kind: 'pad', x: 0, y: 0, velocity: 0 });
  assert.deepEqual(lpxDecode([0xb0, 89, 127]), { kind: 'side', y: 0, press: true });
  assert.deepEqual(lpxDecode([0xb0, 95, 127]), { kind: 'top', x: 4, press: true });
  assert.equal(isLpxPort('MIDIIN2 (LPX MIDI)'), true);
  assert.equal(isLpxPort('LPX MIDI'), true);
  assert.equal(isLpxPort('LPX DAW'), false);
  assert.equal(isLpxPort('DDJ-FLX4'), false);
});

test('built-in kits: 64 pads, sounds that exist, survive a settings round trip', () => {
  const kits = defaultKits();
  assert.ok(kits.length >= 3);
  for (const k of kits) {
    assert.equal(k.pads.length, PAD_COUNT);
    for (const p of k.pads) {
      if (!p) continue;
      if (p.src.drum) assert.ok(DRUM_SOUNDS.includes(p.src.drum));
      if (p.src.synth) assert.ok(INSTRUMENTS[p.src.synth], p.src.synth);
      if (p.src.fx) assert.ok(FX_SOUNDS[p.src.fx], p.src.fx);
      assert.equal(p.color.length, 3);
    }
    const back = normalizeKit(JSON.parse(JSON.stringify(k)));
    assert.deepEqual(back, k);
  }
  assert.equal(normalizeKit({}).pads.length, 64);
  assert.equal(normalizeKit({ pads: [{ src: { drum: 'kick' } }] }).pads[0].mode, 'oneshot');
});

test('instrument layout: in-key rows a 4th apart, chromatic rows +5', () => {
  const o = { root: 9, scale: 'minor', octave: 2, layout: 'scale' };
  const a2 = 12 * 3 + 9;
  assert.equal(instrumentNote(0, 7, o), a2); // bottom-left = root
  assert.equal(instrumentNote(1, 7, o), a2 + 2);
  assert.equal(instrumentNote(0, 6, o), a2 + 5); // 3 degrees up: D
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.notEqual(noteRole(instrumentNote(x, y, o), 9, 'minor'), 'out');
  const c = { ...o, layout: 'chromatic' };
  assert.equal(instrumentNote(0, 6, c) - instrumentNote(0, 7, c), 5);
  assert.equal(noteRole(a2 + 1, 9, 'minor'), 'out');
  assert.equal(noteRole(a2 + 12, 9, 'minor'), 'root');
});

test('quantize: next beat / next bar of the master; synced loops follow its tempo', () => {
  const m = { bpm: 120, phase: 0.5, beatInBar: 1 };
  assert.equal(quantizeDelay('off', m), 0);
  assert.ok(Math.abs(quantizeDelay('beat', m) - 0.25) < 1e-9);
  assert.ok(Math.abs(quantizeDelay('bar', m) - (0.25 + 2 * 0.5)) < 1e-9);
  assert.equal(quantizeDelay('bar', null), 0);
  assert.ok(Math.abs(padRate({ sync: true, bpm: 120, pitch: 0 }, 126) - 1.05) < 1e-9);
  assert.ok(Math.abs(padRate({ sync: false, bpm: 120, pitch: 12 }, 126) - 2) < 1e-9);
});

test('built-in sounds render, are finite and not silent', () => {
  for (const id of Object.keys(INSTRUMENTS)) {
    const a = synthNote(id, 45, 22050);
    assert.ok(a.length > 1000, id);
    let peak = 0;
    for (const v of a) { assert.ok(Number.isFinite(v), id); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(peak > 0.05 && peak < 2, `${id} peak ${peak}`);
  }
  for (const id of Object.keys(FX_SOUNDS)) {
    const a = fxSound(id, 128, 22050, 4);
    assert.ok(a.length > 100 && a.some((v) => Math.abs(v) > 0.1), id);
  }
  assert.ok(drumSound('kick', 22050).some((v) => Math.abs(v) > 0.5));
});

test('light show: pad colours, playing pads, press effects that fade', () => {
  const ls = new LightShow();
  const cells = Array(64).fill(null);
  cells[idx(3, 3)] = [100, 0, 0];
  const active = Array(64).fill(false);
  let f = ls.frame(0, { cells, active, idle: 'pads', cover: false });
  assert.deepEqual(f[idx(3, 3)], [35, 0, 0]); // dimmed until played
  active[idx(3, 3)] = true;
  f = ls.frame(0, { cells, active, idle: 'pads', cover: false });
  assert.deepEqual(f[idx(3, 3)], [100, 0, 0]);
  ls.trigger('ripple', 0, 0, [0, 0, 127], 10, 1);
  f = ls.frame(10.3, { cells, active, idle: 'off', cover: false });
  assert.ok(f.some((c) => c[2] > 20), 'ripple visible');
  ls.frame(11.5, { cells, active, idle: 'off', cover: false });
  assert.equal(ls.effects.length, 0, 'finished effects are dropped');
  assert.equal(effectAt('row', 2, 5, 7, 5, 0), 1);
  assert.equal(effectAt('row', 2, 5, 7, 4, 0), 0);
  const show = ls.frame(0, { cells, active: Array(64).fill(false), idle: 'rainbow', cover: true });
  assert.ok(show.every((c) => c.every((v) => v >= 0 && v <= 127)));
});

test('endless notes: every synth loops a steady part without a click; kits default to it', async () => {
  const { synthSustain } = await import('../src/shared/padsynth.js');
  const rate = 22050;
  for (const id of Object.keys(INSTRUMENTS)) {
    const { samples: a, loopStart, loopEnd } = synthSustain(id, 45, rate);
    const ls = Math.round(loopStart * rate); const le = Math.round(loopEnd * rate);
    assert.ok(ls > 0 && le === a.length && le - ls > rate, `${id}: loop of more than a second`);
    // The jump from the loop end back to its start is no bigger than the sound's own steps.
    let step = 0;
    for (let i = ls + 1; i < le; i++) step = Math.max(step, Math.abs(a[i] - a[i - 1]));
    assert.ok(Math.abs(a[ls] - a[le - 1]) <= step * 1.5 + 1e-6, `${id}: seamless loop`);
    // No decay: the second half of the loop is not quieter than the first (detuned voices beat,
    // so the level may swing, not fade).
    const rms = (s, e) => Math.sqrt(a.subarray(s, e).reduce((x, v) => x + v * v, 0) / (e - s));
    const mid = (ls + le) >> 1;
    const r = rms(ls, mid) / rms(mid, le);
    assert.ok(r > 0.5 && r < 1.3, `${id}: no decay (${r.toFixed(2)})`);
  }
  assert.equal(normalizeKit({}).instrument.mode, 'sustain');
  assert.equal(normalizeKit({ instrument: { mode: 'gate' } }).instrument.mode, 'gate');
});
