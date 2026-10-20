import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngine } from '../src/shared/stem-engines.js';
import { sessionOptions, benchMix } from '../src/main/stems-core.js';

test('Auto picks the fastest engine measured, only when it clearly beats the CPU', () => {
  assert.equal(pickEngine('auto', null), 'cpu', 'no measurement: CPU');
  assert.equal(pickEngine('auto', { cpu: 7, webgpu: 6.7, dml: 9.8 }), 'dml');
  assert.equal(pickEngine('auto', { cpu: 7, webgpu: 7.5, dml: 'crash' }), 'cpu', 'GPU only 7 % faster: CPU');
  assert.equal(pickEngine('auto', { cpu: 0.44, webgpu: 0.15, dml: 'crash' }), 'cpu', 'integrated GPU slower: CPU');
  assert.equal(pickEngine('auto', { cpu: 0.44, webgpu: 3.2, dml: 2 }), 'webgpu');
  assert.equal(pickEngine('webgpu', { cpu: 9 }), 'webgpu', 'a chosen engine is used as is');
});

test('GPU sessions turn off memory patterns and run sequentially (DirectML needs it)', () => {
  assert.deepEqual([sessionOptions('dml').enableMemPattern, sessionOptions('dml').executionMode], [false, 'sequential']);
  assert.deepEqual([sessionOptions('webgpu').enableMemPattern, sessionOptions('webgpu').executionMode], [false, 'sequential']);
  assert.equal(sessionOptions('cpu').enableMemPattern, undefined);
  assert.deepEqual(sessionOptions('cpu').executionProviders, ['cpu']);
});

test('the engine test mix is deterministic and in range', () => {
  const a = benchMix(1); const b = benchMix(1);
  assert.equal(a.left.length, 44100);
  assert.deepEqual(a.left.slice(0, 100), b.left.slice(0, 100));
  assert.ok(Math.max(...a.left.map(Math.abs)) < 1.5);
});
