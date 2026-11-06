import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiKey, locateDownload, matchLostDownloads } from '../src/shared/dl-recover.js';
import { Beatgrid, constantFromBeats } from '../src/shared/beatgrid.js';

test('the garbled name and the real one share the same key', () => {
  assert.equal(asciiKey('C:\\Music\\Beyonc\ufffd - D\ufffdj\ufffd Vu.mp3'), asciiKey('C:\\Music\\Beyoncé - Déjà Vu.mp3'));
  assert.equal(asciiKey('D:\\x\\Artist -  .mp3'), asciiKey('D:\\y\\Artist - 日本語 🎵.mp3'));
  assert.notEqual(asciiKey('a\\Song One.mp3'), asciiKey('a\\Song Two.mp3'));
});

test('finding the downloaded file: reported path, else the announced name with the final extension', async () => {
  const on = (...files) => async (p) => files.includes(p);
  assert.equal(await locateDownload('C:\\m\\a.mp3', 'C:\\m\\a.webm', 'mp3', on('C:\\m\\a.mp3')), 'C:\\m\\a.mp3');
  assert.equal(await locateDownload('C:\\m\\bad\ufffd.mp3', 'C:\\m\\é.webm', 'mp3', on('C:\\m\\é.mp3')), 'C:\\m\\é.mp3', 'wrong report');
  assert.equal(await locateDownload(null, 'C:\\m\\a.b.webm', 'mp3', on('C:\\m\\a.b.mp3')), 'C:\\m\\a.b.mp3', 'the cover step failed; dots in the name stay');
  assert.equal(await locateDownload(null, 'C:\\m\\a.m4a', 'mp3', on('C:\\m\\a.m4a')), 'C:\\m\\a.m4a', 'not converted');
  assert.equal(await locateDownload('C:\\m\\a.mp3', 'C:\\m\\a.webm', 'mp3', on()), null, 'nothing on disk: an error, not a false success');
  assert.equal(await locateDownload(null, null, 'mp3', on()), null);
});

test('lost downloads are matched only when there is no doubt', () => {
  const lost = [
    { id: '1', path: 'C:\\m\\Beyonc\ufffd - D\ufffdj\ufffd Vu.mp3' },
    { id: '2', path: 'C:\\m\\\ufffd\ufffd.mp3' }, // nothing left to compare
    { id: '3', path: 'C:\\m\\Tw\ufffdn.mp3' }, // two files fit
  ];
  const files = ['C:\\m\\Beyoncé - Déjà Vu.mp3', 'C:\\m\\日本.mp3', 'C:\\m\\Twín.mp3', 'C:\\m\\Twén.mp3', 'C:\\m\\Other.mp3'];
  assert.deepEqual(matchLostDownloads(lost, files), [{ id: '1', path: 'C:\\m\\Beyoncé - Déjà Vu.mp3' }]);
});

test('a variable grid becomes the constant grid closest to its beats', () => {
  const period = 60 / 128;
  const jitter = Array.from({ length: 200 }, (_, i) => Math.round((0.31 + i * period + (i % 3 ? 0.002 : -0.003)) * 1000) / 1000);
  const { grid, drift } = constantFromBeats({ bpm: 127.9, firstBeat: jitter[0], beat: 3, beats: jitter });
  assert.ok(Math.abs(grid.bpm - 128) < 0.02, String(grid.bpm));
  assert.equal(grid.beat, 3, 'same bar position');
  assert.equal(grid.beats, undefined);
  assert.ok(drift < 0.03, `only seemed to move: ${drift}`);
  assert.ok(Math.abs(new Beatgrid(grid).timeOf(100) - jitter[100]) < 0.02);
  const ramp = []; let t = 0;
  for (let i = 0; i < 200; i++) { ramp.push(t); t += 60 / (120 + i * 0.1); }
  assert.ok(constantFromBeats({ bpm: 130, firstBeat: 0, beats: ramp }).drift > 0.1, 'a real tempo change shows');
  const flat = { bpm: 124, firstBeat: 1, beat: 1 };
  assert.equal(constantFromBeats(flat).grid, flat);
});

test('the shown BPM of a dynamic grid does not flicker with the millisecond rounding of beats', () => {
  const period = 60 / 128;
  const beats = Array.from({ length: 100 }, (_, i) => Math.round((i * period + (i % 2 ? 0.001 : 0)) * 1000) / 1000);
  const g = new Beatgrid({ bpm: 128, firstBeat: 0, beats });
  const single = beats.slice(10, 40).map((b) => g.bpmAt(b + 0.01));
  const smooth = beats.slice(10, 40).map((b) => g.smoothBpmAt(b + 0.01));
  const spread = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(spread(single) > 0.5 && spread(smooth) < 0.1, `${spread(single)} -> ${spread(smooth)}`);
  assert.equal(new Beatgrid({ bpm: 124, firstBeat: 0 }).smoothBpmAt(50), 124);
});
