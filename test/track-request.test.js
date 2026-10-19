import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, rankCandidates, normName } from '../src/shared/track-request.js';

test('requests: "Artist - Title", "Title by Artist", several artists', () => {
  assert.deepEqual(parseRequest('Fred again.. & Baby Keem - leavemealone').artists, ['fredagain', 'babykeem']);
  assert.equal(parseRequest('Overdrive by Charlotte de Witte').title, 'Overdrive');
  assert.deepEqual(parseRequest('Overdrive by Charlotte de Witte').artists, ['charlottedewitte']);
  assert.equal(normName('Fred again . .'), normName('Fred again..'));
  assert.equal(normName('Röyksopp'), 'royksopp');
});

// Real search results for "Fred again.. - leavemealone" (titles / channels as YouTube returns them).
const FRED = [
  { id: 'lyr', title: 'Fred again.., Baby Keem - leavemealone | Lyrics', channel: 'Dark City Sounds', duration: 223, views: 1002413 },
  { id: 'vibe', title: 'Fred again, Baby Keem - Leave Me Alone (Lyrics)', channel: 'The Vibe Guide', verified: true, duration: 224, views: 1832532 },
  { id: 'sped', title: 'leavemealone (sped up)', channel: 'Fred again . .', duration: 180, views: 900000 },
  { id: 'off', title: 'Fred again.. & Baby Keem - leavemealone', channel: 'Fred again . .', verified: true, duration: 223, views: 36200163 },
  { id: 'topic', title: 'leavemealone', channel: 'Fred again.. - Topic', duration: 223, views: 5000000 },
];

test('official sources first: the Topic channel (official audio), then the artist channel', () => {
  const r = rankCandidates(FRED, 'Fred again.. - leavemealone');
  assert.deepEqual(r.map((x) => x.id).slice(0, 2), ['topic', 'off']);
  assert.equal(r[0].official, 'topic');
  assert.equal(r[1].official, 'artist');
  // A sped-up version from the artist's own channel stays below the lyrics channels' real song only if not asked.
  assert.ok(r.findIndex((x) => x.id === 'sped') > r.findIndex((x) => x.id === 'off'));
});

test('versions are allowed when asked for', () => {
  const items = [
    { id: 'orig', title: 'Artist - Song', channel: 'Artist', duration: 200 },
    { id: 'remix', title: 'Artist - Song (Someone Remix)', channel: 'Artist', duration: 300 },
  ];
  assert.equal(rankCandidates(items, 'Artist - Song')[0].id, 'orig');
  assert.equal(rankCandidates(items, 'Artist - Song Someone Remix')[0].id, 'remix');
});

test('hour-long uploads and shorts go down', () => {
  const items = [
    { id: 'hour', title: 'Artist - Song (1 hour)', channel: 'Loops', duration: 3600 },
    { id: 'short', title: 'Artist - Song', channel: 'Clips', duration: 20 },
    { id: 'ok', title: 'Artist - Song', channel: 'Uploader', duration: 210 },
  ];
  assert.equal(rankCandidates(items, 'Artist - Song')[0].id, 'ok');
});
