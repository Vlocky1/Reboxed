// Electron utilityProcess: runs the stem models with onnxruntime-node on the CPU or the GPU
// (WebGPU / DirectML), isolated from the main process (a native crash in a GPU driver only kills
// this process). Results stream back block by block (from the play head), then the full stems are
// written to the cache. It also times the engines on a test mix ('bench').
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  separateSpleeter, separateDemucs, stemToPcm16, stemEnvelope, vocalRegions, STEM_NAMES, STEM_RATE, ENV_PPS, SPLEETER_STEMS,
  sessionOptions, benchMix,
} from './stems-core.js';
import { wavHeader } from '../shared/wav.js';
import { MP3_DELAY, encodeMp3 } from '../shared/mp3.js';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

/** Encode one stem to an MP3 file in a worker thread (here if the thread cannot start). */
async function encodeStem(pcm, kbps, path) {
  try {
    await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./mp3-worker.js', import.meta.url), { workerData: { pcm: pcm.buffer, rate: STEM_RATE, kbps, path } });
      w.once('message', resolve);
      w.once('error', reject);
      w.once('exit', (code) => { if (code) reject(new Error(`MP3 encoder exited (${code})`)); });
    });
  } catch {
    await writeFile(path, encodeMp3(pcm, STEM_RATE, kbps));
  }
}
const ort = require('onnxruntime-node');
const sessions = new Map();

async function session(path, ep) {
  const key = `${path}|${ep}`;
  if (!sessions.has(key)) sessions.set(key, ort.InferenceSession.create(path, sessionOptions(ep)));
  return sessions.get(key);
}

/**
 * Speed of an engine on a model (x real time): FAST separates a short warm-up (shader compilation,
 * driver caches) then `seconds` of the test mix; HQ one 7.8 s segment. Sessions are released after.
 */
async function bench(m) {
  const opened = [];
  const open = async (path) => { const sess = await ort.InferenceSession.create(path, sessionOptions(m.ep)); opened.push(sess); return sess; };
  try {
    if (m.quality === 'fast') {
      const nets = {};
      for (const s of SPLEETER_STEMS) nets[s] = await open(join(m.modelDir, `${s}.fp16.onnx`));
      const warm = benchMix(2);
      await separateSpleeter(nets, ort, warm.left, warm.right, {});
      const mix = benchMix(m.seconds ?? 10);
      const t0 = performance.now();
      await separateSpleeter(nets, ort, mix.left, mix.right, {});
      return (mix.left.length / STEM_RATE) / ((performance.now() - t0) / 1000);
    }
    const sess = await open(m.model);
    const mix = benchMix(7.8);
    const t0 = performance.now();
    await separateDemucs(sess, ort, mix.left, mix.right, {});
    return (mix.left.length / STEM_RATE) / ((performance.now() - t0) / 1000);
  } finally {
    for (const sess of opened) { try { await sess.release(); } catch { /* already gone */ } }
  }
}

/** WAV stems folder -> MP3 (meta updated, WAV files removed once the MP3 files are written). */
async function convert(m) {
  const meta = JSON.parse(await readFile(join(m.dir, m.metaFile), 'utf8'));
  let freed = 0;
  const wavs = meta.stems.map((name) => join(m.dir, `${name}.wav`));
  await Promise.all(wavs.map(async (wav, s) => {
    const buf = await readFile(wav);
    freed += buf.byteLength;
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength - ((buf.byteLength - 44) % 2)));
    await encodeStem(pcm, m.kbps, join(m.dir, `${meta.stems[s]}.mp3`));
  }));
  await writeFile(join(m.dir, m.metaFile), JSON.stringify({ ...meta, format: 'mp3', kbps: m.kbps, mp3Delay: MP3_DELAY }));
  for (const wav of wavs) await rm(wav, { force: true });
  for (const name of meta.stems) freed -= (await stat(join(m.dir, `${name}.mp3`))).size;
  return freed;
}

process.parentPort.on('message', async (e) => {
  const m = e.data;
  if (m.type === 'convert') {
    try { process.parentPort.postMessage({ id: m.id, quality: m.quality, type: 'done', freed: await convert(m) }); } catch (err) {
      process.parentPort.postMessage({ id: m.id, quality: m.quality, type: 'error', error: String(err?.message ?? err) });
    }
    return;
  }
  if (m.type === 'bench') {
    try { process.parentPort.postMessage({ id: m.id, quality: m.quality, type: 'done', speed: await bench(m) }); } catch (err) {
      process.parentPort.postMessage({ id: m.id, quality: m.quality, type: 'error', error: String(err?.message ?? err) });
    }
    return;
  }
  if (m.type !== 'separate') return;
  const { id, quality, left, right } = m;
  const n = left.length;
  const post = (msg, transfer) => process.parentPort.postMessage({ id, quality, ...msg }, transfer);
  try {
    // Full-length PCM kept here for the cache file; blocks are copied into it as they finish.
    const pcm = STEM_NAMES.map(() => new Int16Array(n * 2));
    const env = STEM_NAMES.map(() => new Uint8Array(Math.ceil((n / STEM_RATE) * ENV_PPS) + 1));
    let done = 0;
    const onBlock = (start, length, stems) => {
      const blocks = stems.map((st) => stemToPcm16(st));
      blocks.forEach((b, s) => pcm[s].set(b, start * 2));
      const envs = stems.map((st, s) => {
        const ev = stemEnvelope(st, start);
        for (let i = 0; i < ev.data.length; i++) if (ev.data[i] > env[s][ev.start + i]) env[s][ev.start + i] = ev.data[i];
        return ev;
      });
      done += length;
      post({ type: 'block', start, length, pcm: blocks, env: envs, done, total: n }, blocks.map((b) => b.buffer).concat(envs.map((v) => v.data.buffer)));
    };
    if (quality === 'fast') {
      const nets = {};
      for (const s of SPLEETER_STEMS) nets[s] = await session(join(m.modelDir, `${s}.fp16.onnx`), m.ep);
      await separateSpleeter(nets, ort, left, right, { startSample: m.startSample ?? 0, onBlock });
    } else {
      const sess = await session(m.model, m.ep);
      await separateDemucs(sess, ort, left, right, { startSample: m.startSample ?? 0, onBlock });
    }
    // Cache: write to a temp dir then swap in, so a half-written cache is never used.
    const tmp = `${m.outDir}.part`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    // MP3 (default, ~5x smaller; the 4 stems are encoded in parallel) or standard 16-bit WAV files.
    // Both are usable in any DAW / DJ software.
    const format = m.format === 'wav' ? 'wav' : 'mp3';
    if (format === 'wav') {
      for (let s = 0; s < STEM_NAMES.length; s++) {
        await writeFile(join(tmp, `${STEM_NAMES[s]}.wav`), Buffer.concat([Buffer.from(wavHeader(pcm[s].byteLength, STEM_RATE, 2)), Buffer.from(pcm[s].buffer)]));
      }
    } else {
      await Promise.all(STEM_NAMES.map((name, s) => encodeStem(pcm[s], m.kbps ?? 256, join(tmp, `${name}.mp3`))));
    }
    const vocalsIdx = STEM_NAMES.indexOf('vocals');
    const vocalsF = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { vocalsF[0][i] = pcm[vocalsIdx][2 * i] / 32768; vocalsF[1][i] = pcm[vocalsIdx][2 * i + 1] / 32768; }
    const meta = {
      rate: STEM_RATE, frames: n, stems: STEM_NAMES, quality, ep: m.ep, format, track: m.trackPath ?? null,
      ...(format === 'mp3' ? { kbps: m.kbps ?? 256, mp3Delay: MP3_DELAY } : {}),
      vocals: vocalRegions(vocalsF),
      env: { pps: ENV_PPS, data: env.map((a) => Buffer.from(a).toString('base64')) },
    };
    await writeFile(join(tmp, 'reboxed-stems.json'), JSON.stringify(meta));
    await rm(m.outDir, { recursive: true, force: true });
    await rename(tmp, m.outDir);
    post({ type: 'done', meta });
  } catch (err) {
    post({ type: 'error', error: String(err?.message ?? err) });
  }
});
