import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectForTransfer, needsCopy, transferCandidates, pickFound } from '../src/shared/transfer.js';
import { exportRekordboxXml, importRekordboxXml } from '../src/shared/rekordbox-xml.js';
import { wavePreview, base64ToU8, PREVIEW_COLS } from '../src/shared/dsp/waveform.js';
import { relabelPhrase, splitPhrase, mergePhrase, phraseAt, moveBoundary, shiftPhrases } from '../src/shared/dsp/phrase.js';

const lib = (() => {
  const tracks = new Map([['a', { id: 'a', path: 'C:\\Music\\a.mp3' }], ['b', { id: 'b', path: 'C:\\Music\\b.mp3' }], ['c', { id: 'c', path: 'E:\\DJ\\c.mp3' }]]);
  const playlists = [
    { id: 'f', type: 'folder', name: 'Sets', children: [{ id: 'p1', type: 'playlist', name: 'Warm-up', trackIds: ['a'] }] },
    { id: 'p2', type: 'playlist', name: 'Peak', trackIds: ['b', 'c'] },
    { id: 's', type: 'smart', name: 'Smart', rules: {} },
  ];
  return { get: (id) => tracks.get(id), all: () => [...tracks.values()], playlists, rowsFor: (id) => (id === 's' ? [{ track: tracks.get('c') }] : []) };
})();

test('export: whole collection, or chosen playlists with their tracks only (folders kept)', () => {
  const all = collectForTransfer(lib);
  assert.equal(all.tracks.length, 3);
  assert.deepEqual(all.playlists.map((n) => n.name), ['Sets', 'Peak', 'Smart']);
  assert.deepEqual(all.playlists[2], { type: 'playlist', name: 'Smart', trackIds: ['c'] }, 'intelligent playlist frozen');
  const some = collectForTransfer(lib, new Set(['p1']));
  assert.deepEqual(some.tracks.map((t) => t.id), ['a']);
  assert.equal(some.playlists[0].children[0].name, 'Warm-up');
});

test('music already on the drive is not copied; the other computer finds it under another letter', () => {
  assert.equal(needsCopy('E:\\DJ\\c.mp3', 'E:\\Reboxed Transfer'), false);
  assert.equal(needsCopy('C:\\Music\\a.mp3', 'E:\\Reboxed Transfer'), true);
  const c = transferCandidates('E:\\Reboxed Transfer\\Music\\a.mp3', 'F:\\Reboxed Transfer\\reboxed-transfer.xml');
  assert.deepEqual(c, ['E:\\Reboxed Transfer\\Music\\a.mp3', 'F:\\Reboxed Transfer\\Music\\a.mp3']);
  const paths = ['E:\\x\\1.mp3', 'E:\\x\\2.mp3'];
  const cands = paths.map((p) => transferCandidates(p, 'F:\\x\\t.xml'));
  const found = pickFound(paths, cands, [false, true, false, false, false, false]);
  assert.deepEqual([...found], [['e:\\x\\1.mp3', 'F:\\x\\1.mp3']]);
});

test('transfer XML keeps My Tags and the stems sent along', () => {
  const xml = exportRekordboxXml({ tracks: [
    { id: 'a', path: 'E:\\a.mp3', title: 'A', myTags: ['warm-up', 'vocal'], cues: [], rbStems: 'hq', rbStemsDir: 'Stems\\a' },
    { id: 'b', path: 'E:\\b.mp3', title: 'B', cues: [] }], playlists: [] });
  const [a, b] = importRekordboxXml(xml).tracks;
  assert.deepEqual(a.myTags, ['warm-up', 'vocal']);
  assert.deepEqual([a.rbStems, a.rbStemsDir, b.rbStems], ['hq', 'Stems\\a', undefined]);
});

test('phrases: move a start to a beat, shift them all', () => {
  const ph = [
    { start: 0, end: 16, startBar: 0, bars: 8, label: 'INTRO', num: 1 },
    { start: 16, end: 48, startBar: 8, bars: 16, label: 'CHORUS', num: 1 },
  ];
  const m = moveBoundary(ph, 1, 20);
  assert.deepEqual(m.map((p) => [p.start, p.end, p.bars, p.startBar]), [[0, 20, 10, 0], [20, 48, 14, 10]]);
  assert.equal(moveBoundary(ph, 1, 47.9), ph, 'leaves the phrase too short');
  assert.equal(moveBoundary(ph, 0, 3), ph, 'the first phrase has no previous one');
  assert.deepEqual(shiftPhrases(ph, 0.5).map((p) => [p.start, p.end]), [[0.5, 16.5], [16.5, 48.5]]);
  assert.deepEqual(shiftPhrases(ph, -2).map((p) => [p.start, p.end]), [[0, 14], [14, 46]]);
});

test('waveform preview: PREVIEW_COLS columns of 3 band peaks', () => {
  const n = 1000;
  const wf = { low: new Uint8Array(n).fill(10), mid: new Uint8Array(n).fill(20), high: new Uint8Array(n).fill(30) };
  wf.low[999] = 250;
  const p = base64ToU8(wavePreview(wf));
  assert.equal(p.length, PREVIEW_COLS * 3);
  assert.deepEqual([...p.slice(0, 3)], [10, 20, 30]);
  assert.equal(p[(PREVIEW_COLS - 1) * 3], 250, 'peaks kept');
});

test('phrases corrected by hand: type, cut at a bar, join', () => {
  const ph = [
    { start: 0, end: 16, startBar: 0, bars: 8, label: 'INTRO', num: 1 },
    { start: 16, end: 48, startBar: 8, bars: 16, label: 'CHORUS', num: 1 },
    { start: 48, end: 64, startBar: 24, bars: 8, label: 'OUTRO', num: 1 },
  ];
  assert.equal(phraseAt(ph, 20), 1);
  const r = relabelPhrase(ph, 0, 'CHORUS');
  assert.deepEqual(r.map((p) => `${p.label}${p.num}`), ['CHORUS1', 'CHORUS2', 'OUTRO1']);
  const s = splitPhrase(ph, 1, 31.2); // 2 s per bar: bar 8 of the phrase
  assert.deepEqual(s.map((p) => [p.start, p.end, p.bars, p.num]), [[0, 16, 8, 1], [16, 32, 8, 1], [32, 48, 8, 2], [48, 64, 8, 1]]);
  assert.equal(s[2].startBar, 16);
  assert.equal(splitPhrase(ph, 1, 16.1), ph, 'no empty part');
  const m = mergePhrase(s, 1);
  assert.deepEqual(m.map((p) => [p.start, p.end, p.bars]), [[0, 16, 8], [16, 48, 16], [48, 64, 8]]);
});
