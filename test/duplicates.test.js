import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaSimilarity, candidatePairs, energyCurves, audioSimilarity, verdict, groupPairs, pickKeeper } from '../src/shared/duplicates.js';

// A track's band peaks at 150 points/s: sections of different energy (intro, drop, break…).
function track(seed, seconds, { gain = 1, noise = 0, from = 0 } = {}) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const sections = Array.from({ length: 40 }, () => [rnd(), rnd(), rnd()]);
  const pps = 150; const n = seconds * pps;
  const bands = [0, 1, 2].map(() => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    const t = from + i / pps;
    const s = sections[Math.floor(t / 8) % sections.length];
    const beat = (t * 2) % 1 < 0.2 ? 1 : 0.6;
    for (let b = 0; b < 3; b++) bands[b][i] = Math.max(0, Math.min(255, Math.round(gain * (40 + 200 * s[b] * beat) + noise * (rnd() - 0.5) * 255)));
  }
  return { pps, low: bands[0], mid: bands[1], high: bands[2] };
}

test('names: same track whatever the mix name, the featured artist or the case', () => {
  assert.ok(metaSimilarity({ title: 'Losing It (Original Mix)', artist: 'FISHER' }, { title: 'losing it', artist: 'Fisher' }) > 0.95);
  assert.ok(metaSimilarity({ title: 'expectations (feat. Chappell Roan)', artist: 'Olivia Rodrigo' }, { title: 'Expectations', artist: 'Olivia Rodrigo, Chappell Roan' }) > 0.9);
  assert.ok(metaSimilarity({ title: 'Losing It', artist: 'Fisher' }, { title: 'Finding It', artist: 'Someone' }) < 0.7);
});

test('candidates: similar names, or the same sound fingerprint at the same tempo', () => {
  const f = Array.from({ length: 18 }, (_, i) => (i % 3) / 3 + 0.1);
  const tracks = [
    { id: 'a', title: 'Losing It', artist: 'Fisher', bpm: 125 },
    { id: 'b', title: 'Losing It (Extended Mix)', artist: 'FISHER', bpm: 125 },
    { id: 'c', title: 'Track 07', artist: '', bpm: 125, features: f },
    { id: 'd', title: 'Unknown', artist: 'x', bpm: 62.5, features: f },
    { id: 'e', title: 'Other Song', artist: 'y', bpm: 140, features: f },
  ];
  const pairs = candidatePairs(tracks).map(([a, b]) => `${a.id}${b.id}`);
  assert.deepEqual(pairs, ['ab', 'cd'], 'half tempo counts; another tempo does not');
});

test('audio: the same recording lines up whatever its level; another edit with an offset; another track does not', () => {
  const A = energyCurves(track(7, 240));
  const louder = energyCurves(track(7, 240, { gain: 0.7, noise: 0.05 }));
  const edit = energyCurves(track(7, 200, { from: 24 })); // radio edit: starts 24 s later
  const other = energyCurves(track(99, 240));
  const same = audioSimilarity(A, louder);
  assert.ok(same.score > 0.9 && same.lag === 0, JSON.stringify(same));
  const e = audioSimilarity(A, edit);
  assert.ok(e.score > 0.9 && Math.abs(e.lag + 24) <= 1, JSON.stringify(e));
  const o = audioSimilarity(A, other);
  assert.ok(o.score < 0.6, JSON.stringify(o));
});

test('verdicts, groups and the version to keep', () => {
  const a = { id: 'a', title: 'X', duration: 240, kind: 'mp3', bitrate: 128 };
  const b = { id: 'b', title: 'X', duration: 241, kind: 'wav', cues: [{}] };
  const c = { id: 'c', title: 'X (Extended)', duration: 330, kind: 'mp3', bitrate: 320 };
  assert.equal(verdict(a, b, 1, { score: 0.97 }).kind, 'same');
  assert.equal(verdict(a, c, 0.9, { score: 0.9 }).kind, 'edit');
  assert.equal(verdict(a, c, 0.9, { score: 0.4 }).duplicate, false, 'same name, other audio: a remix');
  assert.equal(verdict(a, { ...b, title: 'Track 3' }, 0.1, { score: 0.95 }).kind, 'renamed');
  assert.equal(verdict(a, b, 0.95, null).duplicate, true, 'not analysed: name + length');
  const p = (x, y) => ({ a: x, b: y, verdict: verdict(x, y, 1, { score: 0.95 }) });
  const groups = groupPairs([p(a, b), p(b, c)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tracks.map((t) => t.id).sort(), ['a', 'b', 'c']);
  assert.equal(pickKeeper([a, b, c]).id, 'b', 'lossless first');
  assert.equal(pickKeeper([a, c]).id, 'c', 'then the best bitrate');
});
