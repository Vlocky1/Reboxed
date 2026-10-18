// Stem separation service: model downloads, job queue, progressive results. Stems are kept as WAV
// files next to the music: <track folder>/stems/<track name>/{drums,bass,other,vocals}.wav (+ meta),
// the best quality replacing the previous one. Fallback (read-only music folder, or setting):
// userData/stems/<trackId>/<quality>/. Older caches there (.pcm) stay readable.
//   fast : Spleeter 4stems ONNX (4 x 19.7 MB, Apache-2.0 export of Deezer's MIT weights)
//   hq   : HT-Demucs v4 ONNX (166 MB, MIT)
import { utilityProcess, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
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

export class StemService {
  /** @param {string} dataDir userData */
  constructor(dataDir, send) {
    this.dataDir = dataDir;
    this.send = send;               // (channel, ...args) -> renderer
    this.modelDir = join(dataDir, 'models');
    this.overrides = {};            // quality -> dir/file (dev & smoke tests)
    this.root = join(dataDir, 'stems');
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

  dirFor(id, quality) { return join(this.root, safe(id), quality); }

  /** Stems folder beside the track: <folder>/stems/<file name without extension>. */
  besideDir(trackPath) { return join(dirname(trackPath), 'stems', basename(trackPath, extname(trackPath))); }

  /** Best stems for a track: the folder beside it, then the userData cache (HQ, then FAST). */
  async meta(id, trackPath) {
    const dirs = [...(trackPath ? [this.besideDir(trackPath)] : []), this.dirFor(id, 'hq'), this.dirFor(id, 'fast')];
    for (const dir of dirs) {
      for (const file of ['rbclone-stems.json', 'meta.json']) {
        try { return { format: 'pcm', ...JSON.parse(await readFile(join(dir, file), 'utf8')), dir }; } catch { /* next */ }
      }
    }
    return null;
  }

  /** Where a new result goes: beside the track when that folder is writable, else userData. */
  async outDirFor(job) {
    if (job.trackPath && job.location !== 'appdata') {
      const dir = this.besideDir(job.trackPath);
      try {
        await mkdir(dirname(dir), { recursive: true });
        await access(dirname(dir), 2 /* W_OK */);
        return dir;
      } catch { /* read-only music folder */ }
    }
    return this.dirFor(job.id, job.quality);
  }

  /** Delete a track's stems everywhere (beside the track too). */
  async remove(id, trackPath) {
    await rm(join(this.root, safe(id)), { recursive: true, force: true });
    if (trackPath) await rm(this.besideDir(trackPath), { recursive: true, force: true });
  }

  /** Clear the userData cache; stems kept beside the music are the DJ's files and stay. */
  async removeAll() { await rm(this.root, { recursive: true, force: true }); }

  /**
   * Queue a separation. left/right: 44.1 kHz Float32Arrays. Blocks are streamed to the renderer
   * as 'stems:block' while the job runs. `urgent` jobs (a deck asked for stems) go first.
   */
  separate(id, left, right, { quality = 'fast', ep = 'cpu', startSample = 0, urgent = false, trackPath = null, location = 'beside' } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id, left, right, quality, ep, startSample, trackPath, location, resolve, reject };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
      this.pump();
    });
  }

  ensureChild() {
    if (this.child) return this.child;
    this.child = utilityProcess.fork(join(here, 'stems-worker.js'), [], { serviceName: 'RBClone stems' });
    this.child.on('message', (m) => this.onChild(m));
    this.child.on('exit', (code) => {
      const job = this.current;
      this.child = null;
      if (!job) return;
      this.current = null;
      this.busy = false;
      if (job.ep !== 'cpu') {
        this.send('stems:fallback', job.id, job.ep); // GPU provider crashed natively: retry on CPU
        this.queue.unshift({ ...job, ep: 'cpu' });
      } else {
        job.reject(new Error(`Stem process exited (${code})`));
      }
      this.pump();
    });
    return this.child;
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift();
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
    if (m.type === 'done') job.resolve({ ...m.meta, dir: job.outDir });
    else job.reject(new Error(m.error));
    this.send('stems:job', job.id, job.quality, m.type);
    this.pump();
  }
}
