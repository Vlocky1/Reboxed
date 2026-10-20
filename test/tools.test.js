import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolInstaller, TOOLS } from '../src/main/tools.js';

/** A zip made by Windows' tar (the same tool that unpacks it). */
function zip(files) {
  const src = mkdtempSync(join(tmpdir(), 'rbx-zsrc-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(src, path, '..'), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  const out = join(mkdtempSync(join(tmpdir(), 'rbx-zip-')), 'a.zip');
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', out, '-C', src, ...Object.keys(files).map((p) => p.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
  return readFileSync(out);
}

test('tools: official URLs only', () => {
  assert.match(TOOLS['yt-dlp'].url, /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\//);
  assert.match(TOOLS.deno.url, /^https:\/\/github\.com\/denoland\/deno\/releases\//);
  assert.match(TOOLS.ffmpeg.url, /^https:\/\/github\.com\/yt-dlp\/FFmpeg-Builds\/releases\//);
});

test('tools: install downloads, unpacks and keeps only the programs', { skip: process.platform !== 'win32' }, async () => {
  const bodies = {
    [TOOLS['yt-dlp'].url]: Buffer.from('ytdlp-exe'),
    [TOOLS.deno.url]: zip({ 'deno.exe': 'deno-exe' }),
    [TOOLS.ffmpeg.url]: zip({ 'ffmpeg-master/bin/ffmpeg.exe': 'ff', 'ffmpeg-master/bin/ffprobe.exe': 'fp', 'ffmpeg-master/bin/avcodec-61.dll': 'dll', 'ffmpeg-master/doc/readme.txt': 'doc' }),
  };
  const dir = join(mkdtempSync(join(tmpdir(), 'rbx-tools-')), 'tools');
  const progress = [];
  const t = new ToolInstaller({
    dir, version: 'test', send: (ch, name, rec, total, phase) => progress.push(`${name}:${phase}`),
    fetch: async (url) => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(bodies[url].length) }), body: new Blob([bodies[url]]).stream() }),
  });
  await t.install(['yt-dlp', 'deno', 'ffmpeg']);
  assert.deepEqual(readdirSync(dir).sort(), ['avcodec-61.dll', 'deno.exe', 'ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']);
  assert.equal(readFileSync(join(dir, 'ffmpeg.exe'), 'utf8'), 'ff');
  assert.ok(!existsSync(join(dir, '.download')), 'temporary files removed');
  assert.ok(progress.includes('ffmpeg:extract') && progress.includes('deno:done'));
});

test('tools: a failed download leaves nothing behind', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rbx-tools-')), 'tools');
  const t = new ToolInstaller({ dir, version: 'test', send: () => {}, fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(t.install(['deno']), /deno: download failed \(404\)/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(t.busy, null, 'a new install can start');
});
