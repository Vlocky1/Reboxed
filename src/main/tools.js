// Downloader tools (yt-dlp, deno, ffmpeg) installed on request from their official releases into
// Reboxed's own tools folder, and yt-dlp updates. Nothing is bundled with Reboxed: the installer
// stays small and ffmpeg (GPL) is fetched by the user from its source, not redistributed.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** What to download for each tool. zip: files to keep from the archive (copied flat into the folder). */
export const TOOLS = {
  'yt-dlp': { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', file: 'yt-dlp.exe', size: 17 },
  deno: { url: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip', zip: /(^|[\\/])deno\.exe$/i, size: 41 },
  // yt-dlp's own ffmpeg builds (patched for it); the "shared" build is the smallest: exes + DLLs.
  ffmpeg: { url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip', zip: /[\\/]bin[\\/][^\\/]+\.(exe|dll)$/i, size: 87 },
};

/** Every file under dir (relative paths). */
async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out;
}

const run = (exe, args) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, out }));
});

export class ToolInstaller {
  /** @param {{dir: string, fetch: typeof fetch, send: Function, version: string}} o */
  constructor({ dir, fetch: f, send, version }) {
    Object.assign(this, { dir, fetch: f, send, version });
    this.busy = null;
  }

  /** Download one URL to a file, reporting 'tools:progress' (name, received, total). */
  async fetchTo(name, url, file) {
    const res = await this.fetch(url, { headers: { 'User-Agent': `Reboxed/${this.version}` } });
    if (!res.ok || !res.body) throw new Error(`${name}: download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = createWriteStream(file);
    const reader = res.body.getReader();
    let received = 0; let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 150) { last = Date.now(); this.send('tools:progress', name, received, total, 'download'); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (total && (await stat(file)).size !== total) throw new Error(`${name}: incomplete download`);
    this.send('tools:progress', name, received, total, 'download');
  }

  async installOne(name) {
    const t = TOOLS[name];
    if (!t) throw new Error(`unknown tool ${name}`);
    const tmp = join(this.dir, '.download', name);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    try {
      if (!t.zip) {
        await this.fetchTo(name, t.url, join(tmp, t.file));
        await rm(join(this.dir, t.file), { force: true });
        await rename(join(tmp, t.file), join(this.dir, t.file));
        return;
      }
      const zip = join(tmp, `${name}.zip`);
      await this.fetchTo(name, t.url, zip);
      this.send('tools:progress', name, 0, 0, 'extract');
      // Windows 10+ ships bsdtar, which reads zip archives.
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      const x = join(tmp, 'x');
      await mkdir(x, { recursive: true });
      const r = await run(tar, ['-xf', zip, '-C', x]);
      if (r.code !== 0) throw new Error(`${name}: could not extract the archive (${r.out.trim().slice(0, 200)})`);
      const files = (await walk(x)).filter((f) => t.zip.test(f));
      if (!files.length) throw new Error(`${name}: nothing usable in the archive`);
      for (const f of files) await copyFile(join(x, f), join(this.dir, f.split(/[\\/]/).pop()));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Install the named tools (one after the other). Resolves when all are in place. */
  async install(names) {
    if (this.busy) throw new Error('tools are already being installed');
    await mkdir(this.dir, { recursive: true });
    this.busy = (async () => {
      for (const name of names) {
        this.send('tools:progress', name, 0, 0, 'start');
        await this.installOne(name);
        this.send('tools:progress', name, 1, 1, 'done');
      }
    })();
    try { await this.busy; } finally {
      this.busy = null;
      await rm(join(this.dir, '.download'), { recursive: true, force: true });
    }
  }

  /**
   * Latest yt-dlp: Reboxed's own copy updates itself (-U); without one, the latest release is
   * installed in Reboxed's tools folder (copies of other apps, e.g. Stacher's, are left alone).
   * @returns {Promise<{installed: boolean, output: string}>}
   */
  async updateYtdlp() {
    const own = join(this.dir, TOOLS['yt-dlp'].file);
    const exists = await stat(own).then(() => true, () => false);
    if (!exists) { await this.install(['yt-dlp']); return { installed: true, output: '' }; }
    const r = await run(own, ['-U']);
    if (r.code !== 0) throw new Error(r.out.trim().split(/\r?\n/).pop() || `yt-dlp -U exited with ${r.code}`);
    return { installed: false, output: r.out.trim().split(/\r?\n/).pop() ?? '' };
  }
}
