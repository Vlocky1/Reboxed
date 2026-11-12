// whisper-cli's full JSON → timed words; the WAV it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperJson, wav16k } from '../src/main/whisper.js';

const tok = (text, from, to, t_dtw = -1) => ({ text, offsets: { from, to }, t_dtw });

test('parseWhisperJson: words from tokens, DTW times when present, special tokens skipped', () => {
  const data = {
    result: { language: 'en' },
    transcription: [
      { offsets: { from: 9000, to: 12000 }, text: ' Feeling my way', tokens: [
        tok('[_BEG_]', 9000, 9000), tok(' Feel', 9100, 9300, 912), tok('ing', 9300, 9500, 930), tok(' my', 9500, 9700), tok(' way', 9700, 10000, 975), tok('[_TT_150]', 12000, 12000),
      ] },
      { offsets: { from: 13000, to: 15000 }, text: ' ♪ guided', tokens: [tok(' ♪', 13000, 13100), tok(' guided', 13300, 13900)] },
    ],
  };
  const r = parseWhisperJson(data);
  assert.equal(r.language, 'en');
  // DTW start 0.25 s earlier (it lags the sung onset); no DTW: the token offset
  assert.deepEqual(r.words.map((w) => [w.w, Math.round(w.t * 100) / 100]), [['Feeling', 8.87], ['my', 9.5], ['way', 9.5], ['guided', 13.3]]);
  assert.equal(Math.round(r.words[0].end * 100) / 100, 9.41, 'DTW word: ends after its length, or when the next one starts');
  assert.equal(r.words[3].end, 13.9, 'no DTW: ends with its last token');
  assert.deepEqual(parseWhisperJson({}).words, []);
});

test('wav16k: 16-bit mono 16 kHz WAV', () => {
  const b = wav16k(new Float32Array([0, 1, -1, 0.5]));
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.length, 44 + 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => b.readInt16LE(44 + 2 * i)), [0, 32767, -32767, 16384]);
});
