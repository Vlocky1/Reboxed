import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, nameScore, candidatesFor, planMigration, filesToConfirm } from '../src/shared/migrate.js';

test('words: no track number, accents, punctuation or feat', () => {
  assert.deepEqual(words('07 - Röyksopp feat. Robyn - The Girl and the Robot'), ['royksopp', 'robyn', 'girl', 'robot']);
  assert.deepEqual(words('A1. Strobe (Original Mix)'), ['strobe', 'original', 'mix']);
});

const T = { path: 'C:\\Music\\deadmau5 - Strobe.mp3', title: 'Strobe', artist: 'deadmau5', mixName: 'Original Mix', duration: 637, fileSize: 1000 };

test('name levels: same name, other format, similar name, unrelated', () => {
  assert.equal(nameScore(T, { path: 'J:\\Tracks\\deadmau5 - Strobe.mp3' }).score, 1);
  assert.equal(nameScore(T, { path: 'J:\\Tracks\\deadmau5 - Strobe.aiff' }).score, 0.95);
  assert.ok(nameScore(T, { path: 'J:\\Tracks\\Prog\\03 - deadmau5 - Strobe (Original Mix).flac' }).score > 0.8);
  assert.ok(nameScore(T, { path: 'J:\\Tracks\\Strobe.wav' }).score >= 0.45);
  assert.equal(nameScore(T, { path: 'J:\\Tracks\\deadmau5 - Ghosts n Stuff.mp3' }).score, 0);
});

test('tags and duration confirm, a different edit is rejected', () => {
  const files = [
    { path: 'J:\\Tracks\\Strobe (Extended).aiff', size: 5 },
    { path: 'J:\\Tracks\\01 Strobe.aiff', size: 7 },
  ];
  const tags = new Map([
    ['J:\\Tracks\\Strobe (Extended).aiff', { title: 'Strobe', artist: 'deadmau5', duration: 900 }],
    ['J:\\Tracks\\01 Strobe.aiff', { title: 'Strobe', artist: 'deadmau5', duration: 636.5 }],
  ]);
  const c = candidatesFor(T, files, tags);
  assert.equal(c.length, 1);
  assert.equal(c[0].path, 'J:\\Tracks\\01 Strobe.aiff');
  assert.equal(c[0].confidence, 'sure');
  assert.match(c[0].why, /duration/);
  // Without tags the same file only needs checking.
  assert.equal(candidatesFor(T, files)[0].confidence, 'check');
});

test('plan: only local tracks, each drive file used once, tags asked only where needed', () => {
  const tracks = [
    T,
    { path: 'C:\\Music\\Kick.mp3', title: 'Kick', artist: '', fileSize: 10 },
    { path: 'J:\\Tracks\\Already.mp3', title: 'Already', fileSize: 1 },
    { path: 'C:\\Music\\Nothing.mp3', title: 'Not on the key', artist: 'Nobody' },
  ];
  const files = [
    { path: 'J:\\Tracks\\Kick.mp3', size: 10 },
    { path: 'J:\\Tracks\\deadmau5 - Strobe.flac', size: 3 },
    { path: 'J:\\Tracks\\Already.mp3', size: 1 },
  ];
  const plans = planMigration(tracks, files, 'J:\\Tracks');
  assert.deepEqual(plans.map((p) => [p.track.title, p.candidates[0]?.path ?? null, p.candidates[0]?.confidence ?? null]), [
    ['Strobe', 'J:\\Tracks\\deadmau5 - Strobe.flac', 'likely'],
    ['Kick', 'J:\\Tracks\\Kick.mp3', 'sure'],
    ['Not on the key', null, null],
  ]);
  assert.deepEqual(filesToConfirm(plans), ['J:\\Tracks\\deadmau5 - Strobe.flac']);
});
