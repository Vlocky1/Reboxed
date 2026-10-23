import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmi, gpuSupport, PARTS, DOWNLOAD_SIZE } from '../src/main/nvidia-engine.js';
import { pickEngine, STEM_ENGINES } from '../src/shared/stem-engines.js';

test('nvidia-smi output', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3070 Ti, 591.59, 8.6\r\n'), [{ name: 'NVIDIA GeForce RTX 3070 Ti', driver: '591.59', compute: 8.6 }]);
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce GTX 1080, 512.15\n'), [{ name: 'NVIDIA GeForce GTX 1080', driver: '512.15', compute: null }]);
  assert.deepEqual(parseNvidiaSmi(''), []);
});

test('which cards and drivers can run the CUDA 13 engine', () => {
  assert.equal(gpuSupport({ name: 'RTX 3070 Ti', driver: '591.59', compute: 8.6 }).ok, true);
  assert.match(gpuSupport({ name: 'RTX 2060', driver: '552.22', compute: 7.5 }).reason, /driver 552\.22 is too old/);
  assert.match(gpuSupport({ name: 'GTX 1080', driver: '581.15', compute: 6.1 }).reason, /too old for CUDA 13/);
  assert.equal(gpuSupport(null).ok, false);
});

test('downloads are pinned and checked', () => {
  for (const p of PARTS) {
    assert.match(p.url, /^https:\/\/(github\.com\/microsoft\/onnxruntime\/releases|files\.pythonhosted\.org)\//);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(DOWNLOAD_SIZE > 1.2e9 && DOWNLOAD_SIZE < 1.4e9);
});

test('Auto picks CUDA once measured faster', () => {
  assert.ok(STEM_ENGINES.includes('cuda'));
  assert.equal(pickEngine('auto', { cpu: 2.6, webgpu: 4.5, dml: 'crash', cuda: 32 }), 'cuda');
  assert.equal(pickEngine('auto', { cpu: 2.6, webgpu: 4.5 }), 'webgpu', 'not installed: not measured');
  assert.equal(pickEngine('auto', { cpu: 2.6, cuda: 'crash' }), 'cpu');
});
