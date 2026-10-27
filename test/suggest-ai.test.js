import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestNext, keyMatch, tempoMatch, energyOf, transitions, aiPrompt, parseAiAnswer } from '../src/shared/suggest-ai.js';
import { AiClient } from '../src/main/ai.js';

const feat = (chroma, energy) => [...chroma, 0.5, energy, 0.3, 0.3, energy, 0.4];
const C = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
const D = [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
const track = (id, o) => ({ id, title: id, artist: 'A', bpm: 124, key: '8A', genre: 'House', features: feat(C, 0.5), ...o });

test('key and tempo matches follow harmonic mixing and the tempo fader', () => {
  assert.equal(keyMatch('8A', '8A').score, 1);
  assert.ok(keyMatch('8A', '9A').score > 0.8 && keyMatch('8A', '7A').score > 0.8);
  assert.ok(keyMatch('8A', '8B').score > 0.8);
  assert.equal(keyMatch('8A', '2B').score, 0);
  assert.equal(tempoMatch(124, 124).score, 1);
  assert.equal(tempoMatch(124, 62).score, 1); // half time
  assert.ok(tempoMatch(124, 128).score > 0.6);
  assert.ok(tempoMatch(124, 150).score < 0.2);
  assert.ok(energyOf(feat(C, 0.9)) > energyOf(feat(C, 0.2)));
});

test('suggestions: compatible, sound-alike tracks first; build up / cool down; habits; played today last', () => {
  const seed = track('seed');
  const tracks = [seed,
    track('twin'),
    track('clash', { key: '2B', bpm: 150, features: feat(D, 0.5) }),
    track('louder', { features: feat(C, 0.85) }),
    track('softer', { features: feat(C, 0.2) }),
    track('habit', { key: '3B', features: feat(D, 0.5) }),
    track('played')];
  const order = (o) => suggestNext(seed, tracks, o).map((r) => r.track.id);
  const keep = order({});
  assert.equal(keep[0], 'twin');
  assert.equal(keep.at(-1), 'clash');
  assert.ok(order({ mood: 'up' }).indexOf('louder') < order({ mood: 'up' }).indexOf('softer'));
  assert.ok(order({ mood: 'down' }).indexOf('softer') < order({ mood: 'down' }).indexOf('louder'));
  const histories = [{ trackIds: ['seed', 'habit', 'x'] }, { trackIds: ['seed', 'habit'] }];
  assert.equal(transitions(histories).get('seed').get('habit'), 2);
  const before = suggestNext(seed, tracks).find((r) => r.track.id === 'habit');
  const h = suggestNext(seed, tracks, { histories }).find((r) => r.track.id === 'habit');
  assert.ok(h.score - before.score > 0.15, 'a transition the DJ plays moves up');
  assert.ok(h.reasons.includes('you played it after this one'));
  const today = suggestNext(seed, tracks, { playedToday: new Set(['played']) });
  assert.ok(today.findIndex((r) => r.track.id === 'played') > keep.indexOf('played'));
  assert.ok(suggestNext(seed, tracks, { exclude: new Set(['twin']) }).every((r) => r.track.id !== 'twin'));
});

test('Gemini prompt carries metadata only; the answer is parsed against the candidates', () => {
  const seed = track('seed', { title: 'Now', path: 'C:\\Music\\secret.mp3' });
  const cands = [track('a', { title: 'First' }), track('b', { title: 'Second' })];
  const p = aiPrompt(seed, cands, [], 'up');
  assert.match(p, /Now/);
  assert.match(p, /1: A \| Second \| 124 BPM \| 8A \| House/);
  assert.doesNotMatch(p, /secret|C:\\/);
  const r = parseAiAnswer('```json\n{"picks":[{"i":1,"why":"same groove"},{"i":9}],"discover":[{"artist":"X","title":"Y","why":"z"}]}\n```', cands);
  assert.deepEqual(r.picks.map((x) => x.track.id), ['b']);
  assert.deepEqual(r.discover, [{ artist: 'X', title: 'Y', why: 'z' }]);
});

test('Gemini client: key stored encrypted, sent in a header, errors explained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-ai-'));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.headers['x-goog-api-key'] === 'bad'.padEnd(30, 'x')) return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"picks":[]}' }] } }] }));
  };
  const crypt = { encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().slice(4) };
  const ai = new AiClient(join(dir, 'ai.json'), fetch, crypt);
  assert.equal((await ai.status()).hasKey, false);
  await assert.rejects(ai.ask('hi'), /No Gemini API key/);
  await assert.rejects(ai.configure({ key: 'not a key!' }), /does not look like/);
  const key = 'AIzaSyTestKey0123456789abcdef';
  const st = await ai.configure({ key });
  assert.deepEqual(st, { hasKey: true, model: 'gemini-flash-latest', keyHint: '…cdef' });
  assert.doesNotMatch(readFileSync(join(dir, 'ai.json'), 'utf8'), /AIzaSy/, 'not stored in clear');
  assert.equal(await new AiClient(join(dir, 'ai.json'), fetch, crypt).ask('hello'), '{"picks":[]}');
  const last = calls.at(-1);
  assert.match(last.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-flash-latest:generateContent$/);
  assert.equal(last.init.headers['x-goog-api-key'], key);
  assert.doesNotMatch(last.url, /AIza/, 'the key is not in the URL');
  await ai.configure({ key: 'bad'.padEnd(30, 'x') });
  await assert.rejects(ai.ask('hello'), /Gemini: API key not valid/);
});
