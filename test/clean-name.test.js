import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, cleanArtist, cleanTrackName, parseKeywords, DEFAULT_KEYWORDS } from '../src/shared/clean-name.js';

test('titles lose video decorations, keep versions', () => {
  const cases = [
    ['Trois nuits par semaine (Clip officiel)', 'Trois nuits par semaine'],
    ['Song (Official Video) [HD]', 'Song'],
    ['Song (Official Music Video)', 'Song'],
    ['Song (Paroles / Lyrics)', 'Song'],
    ['Song [Lyric Video]', 'Song'],
    ['Song (Visualizer)', 'Song'],
    ['Song | Official Audio', 'Song'],
    ['Song - Lyrics', 'Song'],
    ['Song Official Video', 'Song'],
    ['Song (Audio) #shorts #music', 'Song'],
    ['Song 【MV】', 'Song'],
    ['Opus (Extended Mix)', 'Opus (Extended Mix)'],
    ['Strobe (Club Edit) [Official Audio]', 'Strobe (Club Edit)'],
    ['Song (feat. Someone) (Official Video)', 'Song (feat. Someone)'],
    ['Song (Live at Bercy) | Official Video', 'Song (Live at Bercy)'],
    ['Song (Official Remix)', 'Song (Official Remix)'],
    ['Video Killed The Radio Star', 'Video Killed The Radio Star'],
    ['Audio Video Disco', 'Audio Video Disco'],
    ['Paroles, paroles', 'Paroles, paroles'],
  ];
  for (const [input, want] of cases) assert.equal(cleanTitle(input), want, input);
});

test('artists lose channel suffixes', () => {
  assert.equal(cleanArtist('Indochine - Topic'), 'Indochine');
  assert.equal(cleanArtist('IndochineVEVO'), 'Indochine');
  assert.equal(cleanArtist('Indochine Official'), 'Indochine');
  assert.equal(cleanArtist('The Officials'), 'The Officials');
});

test('track names: "Artist - Title" split when the artist is only the channel', () => {
  assert.deepEqual(cleanTrackName({ title: 'Indochine - Trois nuits par semaine (Clip officiel)', artist: 'IndochineVEVO' }), { artist: 'Indochine', title: 'Trois nuits par semaine' });
  assert.deepEqual(cleanTrackName({ title: 'INDOCHINE - 3 nuits par semaine [Paroles]', artist: '' }), { artist: 'INDOCHINE', title: '3 nuits par semaine' });
  assert.deepEqual(cleanTrackName({ title: 'Indochine - Trois nuits par semaine', artist: 'Indochine' }), { artist: 'Indochine', title: 'Trois nuits par semaine' });
  // A real artist with a dash in the title: kept.
  assert.deepEqual(cleanTrackName({ title: 'Opus - Extended Mix', artist: 'Eric Prydz' }), { artist: 'Eric Prydz', title: 'Opus - Extended Mix' });
  assert.deepEqual(cleanTrackName({ title: 'Part 1 - Part 2', artist: 'Some Band' }), { artist: 'Some Band', title: 'Part 1 - Part 2' });
  assert.deepEqual(cleanTrackName({ title: 'Song (Lyrics)', artist: 'Artist - Topic' }), { artist: 'Artist', title: 'Song' });
});

test('custom keyword list', () => {
  assert.equal(cleanTitle('Song (Teaser)', ['teaser']), 'Song');
  assert.equal(cleanTitle('Song (Teaser)'), 'Song (Teaser)');
  assert.deepEqual(parseKeywords(' teaser, promo ;\n'), ['teaser', 'promo']);
  assert.equal(parseKeywords(''), DEFAULT_KEYWORDS);
});
