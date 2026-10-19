import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebasePaths, insidePath } from '../src/shared/portable-paths.js';
import { planRelink } from '../src/shared/relink.js';

const LIB = {
  dbDir: 'J:\\Reboxed',
  tracks: [
    { id: 'a', path: 'J:\\Tracks\\Kick.mp3', artwork: 'J:\\Reboxed\\artwork\\1.jpg' },
    { id: 'b', path: 'C:\\Users\\me\\Music\\Local.mp3', artwork: 'C:\\Users\\me\\AppData\\Roaming\\Reboxed\\artwork\\2.jpg' },
  ],
  settings: { grooveCaptures: { '0:0:0': { file: 'J:/Reboxed/groove/deck1-A1.wav' } } },
};

test('insidePath compares Windows paths case-insensitively, either slash', () => {
  assert.ok(insidePath('J:/Tracks/a.mp3', 'j:\\tracks'));
  assert.ok(insidePath('J:\\Tracks', 'J:\\Tracks\\'));
  assert.ok(!insidePath('J:\\Tracks2\\a.mp3', 'J:\\Tracks'));
});

test('a USB key mounted under another letter: every path on it follows, local paths stay', () => {
  const r = rebasePaths(LIB, 'J:\\Reboxed', 'K:\\Reboxed');
  assert.equal(r.tracks[0].path, 'K:\\Tracks\\Kick.mp3');
  assert.equal(r.tracks[0].artwork, 'K:\\Reboxed\\artwork\\1.jpg');
  assert.equal(r.tracks[1].path, 'C:\\Users\\me\\Music\\Local.mp3');
  assert.equal(r.settings.grooveCaptures['0:0:0'].file, 'K:\\Reboxed\\groove\\deck1-A1.wav');
  assert.equal(LIB.tracks[0].path, 'J:\\Tracks\\Kick.mp3'); // input untouched
});

test('database moved to another folder: only its own files follow', () => {
  const r = rebasePaths(LIB, 'J:\\Reboxed', 'D:\\DJ\\Library');
  assert.equal(r.tracks[0].artwork, 'D:\\DJ\\Library\\artwork\\1.jpg');
  assert.equal(r.tracks[0].path, 'J:\\Tracks\\Kick.mp3');
  assert.deepEqual(rebasePaths(LIB, 'J:\\Reboxed', 'j:\\reboxed'), LIB);
  assert.equal(rebasePaths(LIB, null, 'X:\\'), LIB);
});

test('link the collection to a USB folder: by file name, size breaks ties', () => {
  const tracks = [
    { id: '1', path: 'C:\\Music\\Kick.mp3', fileSize: 100 },
    { id: '2', path: 'C:\\Music\\Retagged.mp3', fileSize: 500 },      // tags edited on the PC: other size
    { id: '3', path: 'C:\\Music\\Twice.mp3', fileSize: 300 },
    { id: '4', path: 'C:\\Music\\LocalOnly.mp3', fileSize: 1 },
    { id: '5', path: 'J:\\Tracks\\Already.mp3', fileSize: 7 },
  ];
  const files = [
    { path: 'J:\\Tracks\\House\\Kick.mp3', size: 100 },
    { path: 'J:\\Tracks\\Retagged.mp3', size: 480 },
    { path: 'J:\\Tracks\\A\\Twice.mp3', size: 999 },
    { path: 'J:\\Tracks\\B\\Twice.mp3', size: 300 },
    { path: 'J:\\Tracks\\Already.mp3', size: 7 },
    { path: 'J:\\Tracks\\New.mp3', size: 42 },
  ];
  const p = planRelink(tracks, files, 'J:\\Tracks');
  assert.deepEqual(p.matches.map((m) => [m.id, m.to, m.sure]), [
    ['1', 'J:\\Tracks\\House\\Kick.mp3', true],
    ['2', 'J:\\Tracks\\Retagged.mp3', true],
    ['3', 'J:\\Tracks\\B\\Twice.mp3', true],
  ]);
  assert.deepEqual(p.already, ['5']);
  assert.deepEqual(p.notFound, ['4']);
  assert.deepEqual(p.newFiles, ['J:\\Tracks\\A\\Twice.mp3', 'J:\\Tracks\\New.mp3']);
});
