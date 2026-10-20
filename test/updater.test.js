import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updater, compareVersions, installerAsset } from '../src/main/updater.js';

test('versions compare numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.1'), 1);
  assert.equal(compareVersions('v1.9.1', '1.9.1'), 0);
  assert.equal(compareVersions('1.9.1', '1.10.0'), -1);
  assert.equal(compareVersions('2.0', '1.99.99'), 1);
});

const release = (tag, assets) => ({ tag_name: tag, html_url: `https://github.com/Vlocky1/Reboxed/releases/tag/${tag}`, body: 'Notes', assets });
const setup = (v) => ({ name: `Reboxed-Setup-${v}.exe`, size: 5, browser_download_url: `https://github.com/Vlocky1/Reboxed/releases/download/v${v}/Reboxed-Setup-${v}.exe` });

test('check: newer release with its installer', async () => {
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const u = (rel) => new Updater({ version: '1.10.0', fetch: async () => json(rel), tempDir: tmpdir(), send: () => {}, quit: () => {} });
  const newer = await u(release('v1.11.0', [{ name: 'latest.yml', size: 1, browser_download_url: 'x' }, setup('1.11.0')])).check();
  assert.deepEqual([newer.newer, newer.latest, newer.asset.name], [true, '1.11.0', 'Reboxed-Setup-1.11.0.exe']);
  assert.equal((await u(release('v1.10.0', [setup('1.10.0')])).check()).newer, false, 'same version');
  assert.equal((await u(release('v1.12.0', [])).check()).newer, false, 'no installer in the release');
  assert.equal(installerAsset(release('v1', [{ name: 'Reboxed-Setup-1.0.exe.blockmap' }])), null);
  const missing = new Updater({ version: '1.0.0', fetch: async () => json({}, 404), tempDir: tmpdir(), send: () => {}, quit: () => {} });
  assert.equal((await missing.check()).newer, false);
});

test('download: only Reboxed release files, with progress, complete', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const progress = [];
  const dir = mkdtempSync(join(tmpdir(), 'rbx-upd-'));
  const u = new Updater({
    version: '1.10.0', tempDir: dir, quit: () => {}, send: (ch, got, total) => progress.push([ch, got, total]),
    fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '5' }), body: new Blob([bytes]).stream() }),
  });
  const file = await u.download({ name: 'Reboxed-Setup-1.11.0.exe', size: 5, url: setup('1.11.0').browser_download_url });
  assert.deepEqual([...readFileSync(file)], [1, 2, 3, 4, 5]);
  assert.deepEqual(progress.at(-1), ['update:progress', 5, 5]);
  await assert.rejects(u.download({ name: 'Reboxed-Setup-1.11.0.exe', url: 'https://evil.example/Reboxed-Setup-1.11.0.exe' }), /not a Reboxed release/);
  await assert.rejects(u.download({ name: 'other.exe', url: setup('1.11.0').browser_download_url }), /unexpected file name/);
  assert.throws(() => u.install('C:\\Windows\\notepad.exe'), /unexpected installer path/);
});
