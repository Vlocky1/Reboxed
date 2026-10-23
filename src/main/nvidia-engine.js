// NVIDIA stem engine (CUDA): onnxruntime with its CUDA execution provider, installed on request.
// The npm onnxruntime-node has no CUDA on Windows, so Reboxed ships its own build of the binding
// (vendor/ort-cuda) and downloads the rest from the official sources: onnxruntime GPU (Microsoft,
// GitHub) and the CUDA runtime, cuBLAS, cuFFT and cuDNN (NVIDIA, PyPI), pinned and SHA-256 checked.
// The stem process for the 'cuda' engine runs from that folder (PATH and REBOXED_ORT).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const ENGINE_VERSION = 'ort-1.30.0-cuda13';
/** CUDA 13 needs an R580+ driver and a Turing (RTX 20) or newer GPU (compute capability 7.5). */
export const MIN_DRIVER = 580;
export const MIN_COMPUTE = 7.5;

/** What is downloaded. keep: files kept from the archive (copied flat next to the binding). */
export const PARTS = [
  {
    name: 'onnxruntime GPU', url: 'https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-win-x64-gpu_cuda13-1.30.0.zip',
    size: 294386823, sha256: '8fa4b08359af682cd605892cb59077049700b640128bb93fd2c7776cf9f55bdc',
    keep: /[\\/]lib[\\/](onnxruntime|onnxruntime_providers_shared|onnxruntime_providers_cuda)\.dll$/i,
  },
  {
    name: 'CUDA runtime', url: 'https://files.pythonhosted.org/packages/86/00/d5436004268f049214193659ebc36550b5ef3925c3d13b4cc980e13be6f5/nvidia_cuda_runtime-13.4.92-py3-none-win_amd64.whl',
    size: 2778543, sha256: '08dca5e4aba480c2fd5b55075c0fa71b84ef9dcf0521f2d58baa14a803a7311c', keep: /cudart64_\d+\.dll$/i,
  },
  {
    name: 'cuBLAS', url: 'https://files.pythonhosted.org/packages/a3/df/f1246959833e2c437db8be3e5b477f66b87f8817821ed40de6c7561c9a36/nvidia_cublas-13.8.0.4-py3-none-win_amd64.whl',
    size: 423266897, sha256: '8c5494423bb8a46822cb6b0cb95d7fa4be2d7b96a31155dff083839ec8297910', keep: /cublas(Lt)?64_\d+\.dll$/i,
  },
  {
    name: 'cuFFT', url: 'https://files.pythonhosted.org/packages/7b/cc/be7fe31058127336a66c88414a2ecc6beecf680baf85994a43eaf292b202/nvidia_cufft-12.4.0.43-py3-none-win_amd64.whl',
    size: 160953139, sha256: '4ff7075f2d0b5f69291f70938d37a86ec632cbe5747184c74ba1f50f17accacc', keep: /cufft64_\d+\.dll$/i,
  },
  {
    name: 'cuDNN', url: 'https://files.pythonhosted.org/packages/87/6a/e55ff0ac26a5c6e2b21f41c9d04ad096b4ed6da593fba7e25845c61b0532/nvidia_cudnn_cu13-9.27.0.42-py3-none-win_amd64.whl',
    size: 436469905, sha256: '7d96f634adafd55c72231eb0500ca77ab109ec8ebff7b33000b76e081bc4558e', keep: /cudnn[\w]*64_\d+\.dll$/i,
  },
];
export const DOWNLOAD_SIZE = PARTS.reduce((a, p) => a + p.size, 0);

const run = (exe, args) => new Promise((resolve) => {
  let out = '';
  let child;
  try { child = spawn(exe, args, { windowsHide: true }); } catch { resolve({ code: -1, out: '' }); return; }
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('error', () => resolve({ code: -1, out }));
  child.on('close', (code) => resolve({ code, out }));
});

/** "NVIDIA GeForce RTX 3070 Ti, 591.59, 8.6" lines -> GPUs. */
export function parseNvidiaSmi(out) {
  return String(out ?? '').split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim())).filter((p) => p.length >= 2 && p[0])
    .map(([name, driver, compute]) => ({ name, driver, compute: Number(compute) || null }));
}

/** Can this GPU / driver run the engine? */
export function gpuSupport(gpu) {
  if (!gpu) return { ok: false, reason: 'No NVIDIA graphics card found' };
  const major = Number(String(gpu.driver).split('.')[0]) || 0;
  if (gpu.compute && gpu.compute < MIN_COMPUTE) return { ok: false, reason: `${gpu.name} is too old for CUDA 13 (RTX 20 series or newer needed)` };
  if (major < MIN_DRIVER) return { ok: false, reason: `NVIDIA driver ${gpu.driver} is too old: update it to ${MIN_DRIVER} or newer (nvidia.com/drivers or the NVIDIA app)` };
  return { ok: true, reason: '' };
}

/** Copy a folder, also out of app.asar (fs.cp does not read inside archives). */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const a = join(from, e.name); const b = join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b); else await writeFile(b, await readFile(a));
  }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, base)); else out.push(p);
  }
  return out;
}

export class NvidiaEngine {
  /** @param {{appDir: string, fetch: typeof fetch, send: Function, version: string, dir?: string}} o */
  constructor({ appDir, fetch: f, send, version, dir }) {
    Object.assign(this, { fetch: f, send, version });
    this.dir = dir || join(appDir, 'engines', 'nvidia-cuda');
    this.ortDir = join(this.dir, 'node_modules', 'onnxruntime-node');
    this.binDir = join(this.ortDir, 'bin', 'napi-v6', 'win32', 'x64');
    this.installing = null;
    this.gpus = null;
  }

  /** NVIDIA GPUs (nvidia-smi comes with the driver), cached. */
  async detect() {
    if (this.gpus) return this.gpus;
    if (process.platform !== 'win32') return (this.gpus = []);
    let r = await run('nvidia-smi', ['--query-gpu=name,driver_version,compute_cap', '--format=csv,noheader']);
    if (r.code !== 0) r = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']); // older drivers
    this.gpus = r.code === 0 ? parseNvidiaSmi(r.out) : [];
    return this.gpus;
  }

  async installed() {
    try { return JSON.parse(await readFile(join(this.dir, 'engine.json'), 'utf8')).version === ENGINE_VERSION; } catch { return false; }
  }

  async status() {
    const gpus = await this.detect();
    const gpu = gpus[0] ?? null;
    return { gpu, support: gpuSupport(gpu), installed: await this.installed(), installing: this.installing, downloadSize: DOWNLOAD_SIZE, dir: this.dir };
  }

  /** Environment of the stem process that runs the CUDA engine. */
  workerEnv() {
    return { REBOXED_ORT: this.ortDir, PATH: `${this.binDir};${process.env.PATH ?? ''}` };
  }

  /** Download one part to `file`, checking its SHA-256 on the way. */
  async fetchPart(part, file, onBytes) {
    const res = await this.fetch(part.url, { headers: { 'User-Agent': `Reboxed/${this.version}` } });
    if (!res.ok || !res.body) throw new Error(`${part.name}: download failed (${res.status})`);
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      onBytes(value.length);
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (hash.digest('hex') !== part.sha256) throw new Error(`${part.name}: the download is damaged (checksum), try again`);
  }

  /** Download and set up everything (about 1.3 GB). Progress: 'nvidia:progress' {part, received, total, phase}. */
  async install() {
    if (this.installing) throw new Error('The NVIDIA engine is already being installed');
    const st = await this.status();
    if (!st.support.ok) throw new Error(st.support.reason);
    // Downloads are kept in .download/files until everything is in place: after a failure (network,
    // disk) the next attempt only fetches what is missing.
    const cache = join(this.dir, '.download', 'files');
    const stage = join(this.dir, '.download', 'stage');
    let received = 0;
    this.installing = { part: '', received: 0, total: DOWNLOAD_SIZE, phase: 'download' };
    const report = (patch) => { Object.assign(this.installing, patch); this.send('nvidia:progress', { ...this.installing }); };
    let ok = false;
    try {
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      await mkdir(cache, { recursive: true });
      const bin = join(stage, 'bin');
      await mkdir(bin, { recursive: true });
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      for (const part of PARTS) {
        report({ part: part.name, phase: 'download' });
        const file = join(cache, part.url.split('/').pop());
        if (!(await stat(file).then((s) => s.size === part.size, () => false))) {
          let last = 0;
          try {
            await this.fetchPart(part, `${file}.part`, (n) => { received += n; if (Date.now() - last > 200) { last = Date.now(); report({ received }); } });
          } catch (err) { await rm(`${file}.part`, { force: true }); throw err; }
          await rename(`${file}.part`, file);
        } else received += part.size;
        report({ received, phase: 'extract' });
        const x = join(stage, 'x');
        await rm(x, { recursive: true, force: true });
        await mkdir(x, { recursive: true });
        const r = await run(tar, ['-xf', file, '-C', x]);
        if (r.code !== 0) throw new Error(`${part.name}: could not extract (${r.out.trim().slice(0, 160)})`);
        const files = (await walk(x)).filter((f) => part.keep.test(f));
        if (!files.length) throw new Error(`${part.name}: nothing usable in the archive`);
        for (const f of files) await copyFile(f, join(bin, f.split(/[\\/]/).pop()));
        await rm(x, { recursive: true, force: true });
      }
      // onnxruntime-node's JavaScript (from Reboxed) + the CUDA binding, next to the DLLs.
      report({ part: 'Reboxed', phase: 'setup' });
      // Package folders from their entry points (onnxruntime-common does not export its package.json).
      const root = (file, name) => file.slice(0, file.lastIndexOf(name) + name.length);
      const ortPkg = root(require.resolve('onnxruntime-node'), 'onnxruntime-node');
      const commonPkg = root(createRequire(join(ortPkg, 'package.json')).resolve('onnxruntime-common'), 'onnxruntime-common');
      const ort = join(stage, 'node_modules', 'onnxruntime-node');
      await copyTree(join(ortPkg, 'dist'), join(ort, 'dist'));
      await writeFile(join(ort, 'package.json'), await readFile(join(ortPkg, 'package.json')));
      await copyTree(commonPkg, join(stage, 'node_modules', 'onnxruntime-common'));
      const binDir = join(ort, 'bin', 'napi-v6', 'win32', 'x64');
      await mkdir(dirname(binDir), { recursive: true });
      await rename(bin, binDir);
      await writeFile(join(binDir, 'onnxruntime_binding.node'), await readFile(join(here, '..', '..', 'vendor', 'ort-cuda', 'onnxruntime_binding.node')));
      await writeFile(join(stage, 'engine.json'), JSON.stringify({ version: ENGINE_VERSION, installed: new Date().toISOString(), parts: PARTS.map((p) => p.url) }));
      // Swap in: the previous engine (if any) goes, the new one takes its place.
      for (const e of await readdir(this.dir)) if (e !== '.download') await rm(join(this.dir, e), { recursive: true, force: true });
      for (const e of await readdir(stage)) await rename(join(stage, e), join(this.dir, e));
      ok = true;
      report({ phase: 'done', received: DOWNLOAD_SIZE });
    } finally {
      this.installing = null;
      await rm(ok ? join(this.dir, '.download') : stage, { recursive: true, force: true });
    }
    return this.status();
  }

  async remove() {
    if (this.installing) throw new Error('The NVIDIA engine is being installed');
    await rm(this.dir, { recursive: true, force: true });
    return this.status();
  }

  /** Disk space the installed engine takes (bytes). */
  async diskSize() {
    try { let n = 0; for (const f of await walk(this.dir)) n += (await stat(f)).size; return n; } catch { return 0; }
  }
}
