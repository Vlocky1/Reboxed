// Stem separation service: model downloads, job queue, progressive results. Stems are kept as MP3
// (or WAV) files, {drums,bass,other,vocals}.mp3 + reboxed-stems.json, one folder per track named after it:
//   <database>/stems/<track>/ (default), <custom folder>/<track>/, or <track folder>/stems/<track>/.
// The best quality replaces the previous one. Fallback when that place is not writable, and the
// cache of older versions: <app folder>/stems/<trackId>/<quality>/ (.pcm stays readable).
//   fast : Spleeter 4stems ONNX (4 x 19.7 MB, Apache-2.0 export of Deezer's MIT weights)
//   hq   : HT-Demucs v4 ONNX (166 MB, MIT)
import { utilityProcess, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HF = 'https://huggingface.co';
export const MODELS = {
  fast: {
    label: 'FAST (Spleeter 4-stem)',
    files: ['vocals', 'drums', 'bass', 'other'].map((s) => ({
      name: `spleeter/${s}.fp16.onnx`,
      url: `${HF}/Best-Practice/spleeter-4stems-onnx/resolve/main/${s}.fp16.onnx`,
      size: { vocals: 19714141, drums: 19714140, bass: 19714139, other: 19714140 }[s],
    })),
  },
  hq: {
    label: 'HQ (HT-Demucs v4)',
    files: [{ name: 'htdemucs_fp16weights.onnx', url: `${HF}/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx`, size: 165612636 }],
  },
};

const safe = (id) => String(id).replace(/[^\w-]/g, '_');
/** Stem folder metadata file (older versions: rbclone-stems.json, meta.json). */
export const STEMS_META = 'reboxed-stems.json';
const META_FILES = [STEMS_META, 'rbclone-stems.json', 'meta.json'];
const trackName = (p) => basename(p, extname(p));

export class StemService {
  /**
   * @param {string} appDir machine-local app folder (models, legacy cache)
   * @param {import('./storage.js').Storage} storage where stems go (database, custom folder or beside)
   */
  constructor(appDir, storage, send) {
    this.appDir = appDir;
    this.storage = storage;
    this.send = send;               // (channel, ...args) -> renderer
    this.modelDir = join(appDir, 'models');
    this.overrides = {};            // quality -> dir/file (dev & smoke tests)
    this.root = join(appDir, 'stems'); // legacy cache by track id
    this.queue = [];
    this.busy = false;
    this.child = null;
    this.download = null;           // {quality, received, total}
  }

  modelPath(quality, file) {
    if (quality === 'hq') return this.overrides.hq ?? join(this.modelDir, file.name);
    return join(this.overrides.fast ?? join(this.modelDir, 'spleeter'), file.name.replace('spleeter/', ''));
  }

  async hasModel(quality) {
    for (const f of MODELS[quality].files) {
      try { if ((await stat(this.modelPath(quality, f))).size !== f.size) return false; } catch { return false; }
    }
    return true;
  }

  async status() {
    return {
      models: { fast: await this.hasModel('fast'), hq: await this.hasModel('hq') },
      downloading: this.download,
      queue: this.queue.length + (this.busy ? 1 : 0),
      current: this.current ? { id: this.current.id, quality: this.current.quality } : null,
    };
  }

  async downloadModel(quality) {
    if (this.download) return false;
    const files = MODELS[quality].files;
    const total = files.reduce((a, f) => a + f.size, 0);
    this.download = { quality, received: 0, total };
    try {
      for (const f of files) {
        const dest = join(this.modelDir, f.name);
        try { if ((await stat(dest)).size === f.size) { this.download.received += f.size; continue; } } catch { /* fetch it */ }
        await mkdir(dirname(dest), { recursive: true });
        const part = `${dest}.part`;
        const res = await net.fetch(f.url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.name}`);
        const out = createWriteStream(part);
        const reader = res.body.getReader();
        let last = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          this.download.received += value.length;
          if (this.download.received - last > 1_000_000) { last = this.download.received; this.send('stems:download', quality, this.download.received, total); }
        }
        await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
        if ((await stat(part)).size !== f.size) { await rm(part, { force: true }); throw new Error(`${f.name}: unexpected size`); }
        await rename(part, dest);
      }
      this.send('stems:download', quality, total, total);
      return true;
    } finally {
      this.download = null;
    }
  }

  /** Legacy cache folder (by track id). */
  dirFor(id, quality) { return join(this.root, safe(id), quality); }

  /** Stems folder beside the track: <folder>/stems/<file name without extension>. */
  besideDir(trackPath) { return join(dirname(trackPath), 'stems', trackName(trackPath)); }

  /** Folder for a track in the configured place (two tracks with the same name get the id appended). */
  placeDirs(id, trackPath) {
    const root = this.storage.stemsRoot;
    if (!root) return [this.besideDir(trackPath)];
    const name = trackName(trackPath);
    return [join(root, name), join(root, `${name} [${safe(id).slice(0, 8)}]`)];
  }

  async readMeta(dir) {
    for (const file of META_FILES) {
      try { return { format: 'pcm', ...JSON.parse(await readFile(join(dir, file), 'utf8')), dir }; } catch { /* next */ }
    }
    return null;
  }

  /** A stems folder belongs to this track when it records no track or the same file name. */
  static matches(meta, trackPath) {
    return !meta.track || !trackPath || basename(meta.track).toLowerCase() === basename(trackPath).toLowerCase();
  }

  /** Best stems for a track: the configured place, beside the track, the database folder, then the legacy cache. */
  async meta(id, trackPath) {
    const dirs = [];
    if (trackPath) {
      dirs.push(...this.placeDirs(id, trackPath), this.besideDir(trackPath));
      const name = trackName(trackPath);
      dirs.push(join(this.storage.databaseDir, 'stems', name), join(this.storage.databaseDir, 'stems', `${name} [${safe(id).slice(0, 8)}]`));
    }
    dirs.push(this.dirFor(id, 'hq'), this.dirFor(id, 'fast'));
    for (const dir of [...new Set(dirs)]) {
      const m = await this.readMeta(dir);
      if (m && StemService.matches(m, trackPath)) return m;
    }
    return null;
  }

  /** Where a new result goes: the configured place when writable, else the app folder cache. */
  async outDirFor(job) {
    if (job.trackPath) {
      for (const dir of this.placeDirs(job.id, job.trackPath)) {
        const m = await this.readMeta(dir);
        if (m && !StemService.matches(m, job.trackPath)) continue; // another track with the same name
        try {
          await mkdir(dirname(dir), { recursive: true });
          await access(dirname(dir), 2 /* W_OK */);
          return dir;
        } catch { break; /* read-only or unplugged */ }
      }
    }
    return this.dirFor(job.id, job.quality);
  }

  /**
   * The track's file moved (relinked to a USB drive...): move its stems to where they belong now.
   * @returns {Promise<string|null>} new stems folder
   */
  async relocate(id, oldPath, newPath) {
    const m = await this.meta(id, oldPath);
    if (!m) return null;
    const target = await this.outDirFor({ id, trackPath: newPath, quality: m.quality ?? 'hq' });
    if (target.toLowerCase() !== m.dir.toLowerCase()) {
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      try { await rename(m.dir, target); } catch {
        await cp(m.dir, target, { recursive: true });
        await rm(m.dir, { recursive: true, force: true });
      }
    }
    const { dir, ...meta } = m;
    if (meta.format !== 'pcm') await writeFile(join(target, STEMS_META), JSON.stringify({ ...meta, track: newPath }));
    return target;
  }

  /** Delete a track's stems everywhere. */
  async remove(id, trackPath) {
    await rm(join(this.root, safe(id)), { recursive: true, force: true });
    for (let k = 0; k < 6; k++) {
      const m = await this.meta(id, trackPath);
      if (!m) break;
      await rm(m.dir, { recursive: true, force: true });
    }
  }

  /** Clear the legacy hidden cache; stems in the database / music folders are the DJ's files and stay. */
  async removeAll() { await rm(this.root, { recursive: true, force: true }); }

  /**
   * Queue a separation. left/right: 44.1 kHz Float32Arrays. Blocks are streamed to the renderer
   * as 'stems:block' while the job runs. `urgent` jobs (a deck asked for stems) go first.
   */
  separate(id, left, right, { quality = 'fast', ep = 'cpu', startSample = 0, urgent = false, trackPath = null, format = 'mp3', kbps = 256 } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id, left, right, quality, ep, startSample, trackPath, format, kbps, resolve, reject };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
      this.pump();
    });
  }

  ensureChild() {
    if (this.child) return this.child;
    this.child = utilityProcess.fork(join(here, 'stems-worker.js'), [], { serviceName: 'Reboxed stems' });
    this.child.on('message', (m) => this.onChild(m));
    this.child.on('exit', (code) => {
      const job = this.current;
      this.child = null;
      if (!job) return;
      this.current = null;
      this.busy = false;
      if (job.bench) {
        job.resolve({ crashed: true, code }); // this engine crashes on this computer: Auto avoids it
      } else if (job.ep !== 'cpu') {
        this.send('stems:fallback', job.id, job.ep, job.quality); // GPU provider crashed natively: retry on CPU
        this.queue.unshift({ ...job, ep: 'cpu' });
      } else {
        job.reject(new Error(`Stem process exited (${code})`));
      }
      this.pump();
    });
    return this.child;
  }

  /**
   * Re-encode the WAV stems of these tracks as MP3 (frees ~80 % of the space).
   * @param {{id: string, path: string}[]} tracks
   */
  async convertToMp3(tracks, kbps = 256) {
    const dirs = new Map();
    for (const t of tracks) {
      const m = await this.meta(t.id, t.path);
      if (m?.format === 'wav') dirs.set(m.dir.toLowerCase(), m.dir);
    }
    const report = { converted: 0, failed: 0, freed: 0, total: dirs.size };
    for (const dir of dirs.values()) {
      try {
        const r = await new Promise((resolve, reject) => {
          const job = { id: `convert:${dir}`, quality: 'convert', ep: 'cpu', convert: { dir, kbps }, resolve, reject };
          this.queue.push(job);
          this.pump();
        });
        report.converted++; report.freed += r.freed;
      } catch { report.failed++; }
      this.send('stems:convert', report.converted + report.failed, report.total);
    }
    return report;
  }

  /**
   * Time an engine ('cpu' | 'webgpu' | 'dml') on a model with a test mix, in the stem process.
   * @returns {Promise<{speed?: number, crashed?: boolean, error?: string}>} speed in x real time
   */
  bench(quality, ep, seconds) {
    return new Promise((resolve) => {
      this.queue.push({ id: `bench:${quality}:${ep}`, bench: true, quality, ep, seconds, resolve, reject: (err) => resolve({ error: err.message }) });
      this.pump();
    });
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift();
    if (job.bench) {
      if (!(await this.hasModel(job.quality))) { job.resolve({ error: 'model not downloaded' }); this.pump(); return; }
      this.busy = true;
      this.current = job;
      this.ensureChild().postMessage({
        type: 'bench', id: job.id, quality: job.quality, ep: job.ep, seconds: job.seconds,
        modelDir: this.overrides.fast ?? join(this.modelDir, 'spleeter'), model: this.overrides.hq ?? join(this.modelDir, MODELS.hq.files[0].name),
      });
      return;
    }
    if (job.convert) {
      this.busy = true;
      this.current = job;
      this.ensureChild().postMessage({ type: 'convert', id: job.id, quality: job.quality, ...job.convert, metaFile: STEMS_META });
      return;
    }
    if (!(await this.hasModel(job.quality))) {
      job.reject(new Error(`${MODELS[job.quality].label} model not downloaded (Preferences > Stems)`));
      this.pump();
      return;
    }
    this.busy = true;
    this.current = job;
    job.outDir = await this.outDirFor(job);
    const fastDir = this.overrides.fast ?? join(this.modelDir, 'spleeter');
    this.ensureChild().postMessage({
      type: 'separate', id: job.id, quality: job.quality, left: job.left, right: job.right, ep: job.ep, startSample: job.startSample,
      modelDir: fastDir, model: this.overrides.hq ?? join(this.modelDir, MODELS.hq.files[0].name), outDir: job.outDir, trackPath: job.trackPath,
      format: job.format, kbps: job.kbps,
    });
    this.send('stems:job', job.id, job.quality, 'start');
  }

  onChild(m) {
    const job = this.current;
    if (!job || m.id !== job.id) return;
    if (m.type === 'block') {
      this.send('stems:block', m.id, m.quality, m.start, m.length, m.pcm, m.env, m.done, m.total);
      return;
    }
    this.current = null;
    this.busy = false;
    if (job.bench) job.resolve(m.type === 'done' ? { speed: m.speed } : { error: m.error });
    else if (m.type === 'done') job.resolve(job.convert ? m : { ...m.meta, dir: job.outDir });
    else job.reject(new Error(m.error));
    if (!job.convert && !job.bench) this.send('stems:job', job.id, job.quality, m.type);
    this.pump();
  }
}
