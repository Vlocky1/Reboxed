// In-app updates from the GitHub releases of Reboxed: check the latest release, download its
// installer, run it silently (per-user NSIS install: no admin rights) and restart Reboxed.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const REPO = 'Vlocky1/Reboxed';

/** "v1.10.0" -> [1, 10, 0]; compares numerically (1.10 > 1.9). */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The installer asset of a release (Reboxed-Setup-<version>.exe). */
export const installerAsset = (release) => (release.assets ?? []).find((a) => /^Reboxed-Setup-[\d.]+\.exe$/i.test(a.name)) ?? null;

export class Updater {
  /** @param {{version: string, fetch: typeof fetch, tempDir: string, send: Function, quit: Function}} o */
  constructor({ version, fetch: f, tempDir, send, quit }) {
    Object.assign(this, { version, fetch: f, tempDir, send, quit });
    this.downloading = null;
  }

  /** @returns {Promise<{current, latest, newer, notes, page, asset}>} */
  async check() {
    const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Reboxed/${this.version}` } });
    if (res.status === 404) return { current: this.version, latest: null, newer: false };
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    const latest = String(r.tag_name ?? '').replace(/^v/i, '');
    const asset = installerAsset(r);
    return {
      current: this.version,
      latest,
      newer: !!latest && compareVersions(latest, this.version) > 0 && !!asset,
      notes: String(r.body ?? '').slice(0, 4000),
      page: r.html_url,
      published: r.published_at,
      asset: asset && { name: asset.name, size: asset.size, url: asset.browser_download_url },
    };
  }

  /** Download the installer (progress: 'update:progress' received, total). Returns its path. */
  async download(asset) {
    if (!asset?.url || !new RegExp(`^https://github\\.com/${REPO.replace('/', '\\/')}/releases/download/`).test(asset.url)) throw new Error('not a Reboxed release file');
    if (!/^Reboxed-Setup-[\d.]+\.exe$/i.test(asset.name)) throw new Error('unexpected file name');
    const dir = join(this.tempDir, 'Reboxed-update');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = join(dir, asset.name);
    const res = await this.fetch(asset.url, { headers: { 'User-Agent': `Reboxed/${this.version}` } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    let received = 0;
    const out = createWriteStream(file);
    const reader = res.body.getReader();
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 150) { last = Date.now(); this.send('update:progress', received, total); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    this.send('update:progress', received, total);
    if (total && (await stat(file)).size !== total) throw new Error('incomplete download');
    return file;
  }

  /** Run the installer silently; it restarts Reboxed when done (--force-run). */
  install(file) {
    if (!/[\\/]Reboxed-update[\\/]Reboxed-Setup-[\d.]+\.exe$/i.test(file)) throw new Error('unexpected installer path');
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => this.quit(), 300);
  }
}
