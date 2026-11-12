// Speech recognition for lyrics sync: whisper.cpp (MIT) with OpenAI's Whisper weights (MIT), run on
// this computer only — nothing is sent online. Installed on request, like the download tools: the
// Windows build from the official whisper.cpp releases, the model from the whisper.cpp model page.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

export const WHISPER_MODELS = {
  base: { file: 'ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', mb: 142, dtw: 'base' },
  small: { file: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', mb: 466, dtw: 'small' },
};
const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20';
const ASSET = 'whisper-bin-x64.zip';
const EXE = 'whisper-cli.exe';

/**
 * whisper-cli's full JSON (-ojf) → words with times (s) and the detected language. Words are built from
 * the tokens (a token starting with a space starts a word); special tokens ([_BEG_], <|en|>…) are skipped.
 * The DTW time of a token is used when present (more precise), else the token's own offset.
 */
export function parseWhisperJson(data) {
  const out = { language: data?.result?.language ?? data?.params?.language ?? '', words: [] };
  for (const seg of data?.transcription ?? []) {
    let cur = null;
    for (const tok of seg.tokens ?? []) {
      const text = String(tok.text ?? '');
      if (!text.trim() || /^\s*(\[_|<\|)/.test(text)) continue;
      const from = Number(tok.offsets?.from), to = Number(tok.offsets?.to);
      const dtw = Number(tok.t_dtw);
      // the DTW time (10 ms units) is the right one when present: the token offsets spread a segment's
      // words evenly and put them seconds off on music (measured: 9.34 s by DTW vs 1.11 s, sung at 8.8 s)
      // DTW times come about a quarter of a second after the sung onset (measured: median +0.34 s)
      const byDtw = Number.isFinite(dtw) && dtw >= 0;
      const start = byDtw ? Math.max(0, dtw * 10 - DTW_LEAD_MS) : from;
      if (!cur || /^\s/.test(text)) {
        cur = { w: text.trim(), t: start / 1000, byDtw };
        out.words.push(cur);
      } else cur.w += text;
      if (!byDtw && Number.isFinite(to)) cur.end = to / 1000;
    }
  }
  out.words = out.words.filter((w) => Number.isFinite(w.t) && /[\p{L}\p{N}]/u.test(w.w));
  // with DTW times only the starts are known: a word ends when the next one starts, or after its length
  out.words.forEach((w, i) => {
    const next = out.words[i + 1];
    const guess = w.t + Math.min(0.8, 0.12 + 0.06 * w.w.length);
    if (w.byDtw || w.end === undefined) w.end = next ? Math.min(next.t, guess) : guess;
    delete w.byDtw;
  });
  return out;
}

const DTW_LEAD_MS = 250;

/** 16 kHz mono Float32 samples → 16-bit WAV bytes (what whisper-cli reads). */
export function wav16k(samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

export class Whisper {
  /** @param {{dir: string, fetch: typeof fetch, send: (channel: string, ...args: any[]) => void, version: string}} o */
  constructor({ dir, fetch: f, send, version }) {
    Object.assign(this, { dir, fetch: f, send, version });
    this.installing = null;
    this.child = null;
  }

  exe() { return join(this.dir, EXE); }
  modelPath(model = 'base') { return join(this.dir, WHISPER_MODELS[model]?.file ?? WHISPER_MODELS.base.file); }

  async status() {
    const has = (p) => stat(p).then((s) => s.size > 0, () => false);
    return {
      installed: await has(this.exe()),
      models: Object.fromEntries(await Promise.all(Object.keys(WHISPER_MODELS).map(async (m) => [m, await has(this.modelPath(m))]))),
      sizes: Object.fromEntries(Object.entries(WHISPER_MODELS).map(([m, v]) => [m, v.mb])),
      installing: !!this.installing,
      running: !!this.child,
    };
  }

  async fetchTo(label, url, file) {
    const res = await this.fetch(url, { headers: { 'User-Agent': `Reboxed/${this.version}` } });
    if (!res.ok || !res.body) throw new Error(`${label}: download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = createWriteStream(file);
    const reader = res.body.getReader();
    let received = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 200) { last = Date.now(); this.send('whisper:progress', { stage: 'download', label, received, total }); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (total && (await stat(file)).size !== total) throw new Error(`${label}: incomplete download`);
  }

  /** The newest whisper.cpp release that carries the Windows x64 build. */
  async latestZipUrl() {
    const res = await this.fetch(RELEASES, { headers: { 'User-Agent': `Reboxed/${this.version}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`whisper.cpp releases: ${res.status}`);
    for (const r of await res.json()) {
      const a = (r.assets ?? []).find((x) => x.name === ASSET);
      if (a) return a.browser_download_url;
    }
    throw new Error('no Windows build in the recent whisper.cpp releases');
  }

  /** Install whisper-cli (and its DLLs) and a model; each part only if missing. */
  async install(model = 'base') {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      await mkdir(this.dir, { recursive: true });
      const st = await this.status();
      if (!st.installed) {
        const tmp = join(this.dir, '.download');
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true });
        try {
          const zip = join(tmp, ASSET);
          await this.fetchTo('whisper.cpp', await this.latestZipUrl(), zip);
          this.send('whisper:progress', { stage: 'extract' });
          const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
          const x = join(tmp, 'x');
          await mkdir(x, { recursive: true });
          const code = await new Promise((resolve, reject) => { const c = spawn(tar, ['-xf', zip, '-C', x], { windowsHide: true }); c.on('error', reject); c.on('close', resolve); });
          if (code !== 0) throw new Error('whisper.cpp: could not extract the archive');
          const files = await walk(x);
          const keep = files.filter((f) => /(^|[\\/])whisper-cli\.exe$/i.test(f) || /\.dll$/i.test(f) && !/(SDL2|llama|parakeet)\.dll$/i.test(f));
          if (!keep.some((f) => /whisper-cli\.exe$/i.test(f))) throw new Error('whisper.cpp: whisper-cli.exe not in the archive');
          for (const f of keep) await copyFile(join(x, f), join(this.dir, f.split(/[\\/]/).pop()));
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
      if (!st.models[model]) {
        const m = WHISPER_MODELS[model] ?? WHISPER_MODELS.base;
        const part = `${this.modelPath(model)}.part`;
        await this.fetchTo(`model ${model}`, m.url, part);
        await rename(part, this.modelPath(model));
      }
      this.send('whisper:progress', { stage: 'installed' });
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  /**
   * Recognise the sung words of 16 kHz mono samples.
   * @param {Float32Array} samples
   * @param {{model?: string, language?: string, prompt?: string}} [o] prompt: lyrics text to guide it
   * @returns {Promise<{language: string, words: {w: string, t: number, end: number}[]}>}
   */
  async transcribe(samples, { model = 'base', language = 'auto', prompt = '' } = {}) {
    if (this.child) throw new Error('the speech recogniser is already working');
    const st = await this.status();
    if (!st.installed || !st.models[model]) throw new Error('the speech recogniser is not installed');
    const base = join(tmpdir(), `reboxed-whisper-${Date.now()}`);
    await writeFile(`${base}.wav`, wav16k(samples));
    const threads = Math.max(2, Math.min(8, cpus().length - 1));
    const args = ['-m', this.modelPath(model), '-f', `${base}.wav`, '-l', /^[a-z]{2}$|^auto$/.test(language) ? language : 'auto',
      // -nfa: word times by DTW need flash attention off (it is on by default and silently disables DTW)
      '-ojf', '-of', base, '-t', String(threads), '-pp', '-nfa', '-dtw', WHISPER_MODELS[model]?.dtw ?? 'base'];
    if (prompt) args.push('--prompt', prompt.replace(/\s+/g, ' ').slice(0, 600));
    try {
      const { code, err } = await new Promise((resolve, reject) => {
        const c = spawn(this.exe(), args, { windowsHide: true, cwd: this.dir });
        this.child = c;
        let err = '';
        c.stderr.setEncoding('utf8');
        c.stderr.on('data', (d) => {
          err = (err + d).slice(-4000);
          const m = /progress\s*=\s*(\d+)%/.exec(d);
          if (m) this.send('whisper:progress', { stage: 'listen', pct: Number(m[1]) });
        });
        c.stdout.resume();
        c.on('error', reject);
        c.on('close', (code) => resolve({ code, err }));
      });
      if (code !== 0) throw new Error(`speech recognition failed (${code}): ${err.trim().split(/\r?\n/).pop()}`);
      return parseWhisperJson(JSON.parse(await readFile(`${base}.json`, 'utf8')));
    } finally {
      this.child = null;
      await rm(`${base}.wav`, { force: true });
      await rm(`${base}.json`, { force: true });
    }
  }

  cancel() { this.child?.kill(); }
}

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out;
}
