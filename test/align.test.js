// Lyrics sync from recognised words: alignment with mistakes, missing and extra words, repeated
// choruses, lines never heard, and lines made from words alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignWords, lineWords, linesFromWords, normWord, syncLines, wordSim } from '../src/shared/align.js';

test('normWord / lineWords / wordSim', () => {
  assert.equal(normWord("Don't"), 'dont');
  assert.equal(normWord('Été!'), 'ete');
  assert.deepEqual(lineWords('Hey (ooh) - you, me/them'), ['hey', 'you', 'me', 'them']);
  assert.equal(wordSim('darkness', 'darknes'), 1 - 1 / 8);
  assert.ok(wordSim('heart', 'start') < 0.7);
});

test('alignWords: a wrong word, a missing word, an extra word', () => {
  const lyrics = ['feeling', 'my', 'way', 'through', 'the', 'darkness'];
  const heard = ['uh', 'feelin', 'my', 'wait', 'through', 'darkness'];
  const m = alignWords(lyrics, heard);
  assert.deepEqual(m, [1, 2, -1, 4, -1, 5]);
});

test('syncLines: lines get the time of their first heard word; repeats keep their order; unheard lines interpolated', () => {
  const texts = ['Feeling my way through the darkness', 'Guided by a beating heart', 'Oh oh oh', 'So wake me up when it\'s all over', 'So wake me up when it\'s all over'];
  // heard: line 1 from 9.1 s, line 2 from 13.3 s, line 3 not heard, both choruses heard (the second one with mistakes)
  const words = (t0, text, step = 0.4) => text.split(' ').map((w, k) => ({ w, t: t0 + k * step }));
  const heard = [
    ...words(9.1, 'feeling my way thru the darkness'),
    ...words(13.3, 'guided by a beating heart'),
    ...words(40, 'so wake me up when its all over'),
    ...words(60, 'so wake me up wen its all ova'),
  ];
  const { lines, matched } = syncLines(texts, heard);
  assert.deepEqual(lines.map((l) => l.t), [9.1, 13.3, lines[2].t, 40, 60]);
  assert.ok(lines[2].t > 13.3 && lines[2].t < 40, 'the unheard line sits between its neighbours');
  assert.ok(matched > 0.8);
  // a first line heard only from its 3rd word: moved back by the words before it
  const { lines: l2 } = syncLines(['one two three four'], [{ w: 'three', t: 10 }, { w: 'four', t: 10.4 }]);
  assert.equal(l2[0].t, 9.36);
});

test('syncLines: nothing heard leaves the lines without times; lines stay in order', () => {
  assert.deepEqual(syncLines(['a b', 'c d'], []).lines, [{ t: null, text: 'a b' }, { t: null, text: 'c d' }]);
  const { lines } = syncLines(['alpha', 'beta'], [{ w: 'beta', t: 5 }, { w: 'alpha', t: 5.1 }]);
  assert.ok(lines[1].t >= lines[0].t + 0.25);
});

test('linesFromWords: new line after a pause, a sentence end or 42 characters', () => {
  const heard = [{ w: 'Hello', t: 1, end: 1.3 }, { w: 'there.', t: 1.4, end: 1.8 }, { w: 'How', t: 2, end: 2.2 }, { w: 'are', t: 2.3, end: 2.5 }, { w: 'you', t: 4, end: 4.3 }];
  assert.deepEqual(linesFromWords(heard), [{ t: 1, text: 'Hello there.' }, { t: 2, text: 'How are' }, { t: 4, text: 'you' }]);
});
