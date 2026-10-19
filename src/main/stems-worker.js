// Electron utilityProcess: runs the stem models with onnxruntime-node, isolated from the main
// process (a native crash in a GPU provider only kills this process). Results stream back block
// by block (from the play head), then the full stems are written to the cache.
import { createRequire } from 'node:module';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  separateSpleeter, separateDemucs, stemToPcm16, stemEnvelope, vocalRegions, STEM_NAMES, STEM_RATE, ENV_PPS, SPLEETER_STEMS,
} from './stems-core.js';
import { wavHeader } from '../shared/wav.js';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const sessions = new Map();

// Idle sessions must not busy-wait: with several sessions loaded, spinning thread pools steal
// the CPU from the one that is working (measured: 4 Spleeter nets went from 1.4x to 7x real time).
const SESSION_OPTS = (ep) => ({
  executionProviders: [ep], graphOptimizationLevel: 'all',
  extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
});

async function session(path, ep) {
  const key = `${path}|${ep}`;
  if (!sessions.has(key)) sessions.set(key, ort.InferenceSession.create(path, SESSION_OPTS(ep)));
  return sessions.get(key);
}

process.parentPort.on('message', async (e) => {
  const m = e.data;
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
    // Standard 16-bit WAV files (usable in any DAW / DJ software), 44-byte header then the PCM.
    for (let s = 0; s < STEM_NAMES.length; s++) {
      await writeFile(join(tmp, `${STEM_NAMES[s]}.wav`), Buffer.concat([Buffer.from(wavHeader(pcm[s].byteLength, STEM_RATE, 2)), Buffer.from(pcm[s].buffer)]));
    }
    const vocalsIdx = STEM_NAMES.indexOf('vocals');
    const vocalsF = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { vocalsF[0][i] = pcm[vocalsIdx][2 * i] / 32768; vocalsF[1][i] = pcm[vocalsIdx][2 * i + 1] / 32768; }
    const meta = {
      rate: STEM_RATE, frames: n, stems: STEM_NAMES, quality, ep: m.ep, format: 'wav', track: m.trackPath ?? null,
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
