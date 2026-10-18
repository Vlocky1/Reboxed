// Stem separation cores. Both deliver results progressively through onBlock(start, length, stems)
// (stems[stem][channel] Float32Array for that sample range), starting at a chosen position (the
// play head), so a deck can use stems near the play head long before the whole track is done.
//
//  FAST : Spleeter 4stems (Deezer, MIT weights; ONNX export Apache-2.0) — 4 small U-Nets on
//         STFT magnitudes + soft ratio masks. ~10-20x real time on a CPU.
//  HQ   : HT-Demucs v4 (MIT) — time-domain hybrid transformer, 7.8 s segments, overlap-add.
//         ~1.4x track length on a CPU. Input normalised like demucs' reference separate().
import { fft } from '../shared/dsp/fft.js';

export const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];
export const STEM_RATE = 44100;
export const ENV_PPS = 150; // stem envelope points per second (waveform display)

// ---------------------------------------------------------------------------------------------
// HQ: HT-Demucs
// ---------------------------------------------------------------------------------------------
export const SEGMENT = Math.floor(7.8 * STEM_RATE); // 343,980 samples
const OVERLAP = Math.floor(SEGMENT / 4);
const STRIDE = SEGMENT - OVERLAP;

function fadeWindow() {
  const w = new Float32Array(SEGMENT).fill(1);
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / (OVERLAP - 1);
    w[i] = v;
    w[SEGMENT - 1 - i] = v;
  }
  return w;
}

/** Chunk processing order: the chunk holding `startSample` first, then forward, then backward. */
export function orderFrom(count, first) {
  const k0 = Math.max(0, Math.min(count - 1, first));
  const out = [];
  for (let k = k0; k < count; k++) out.push(k);
  for (let k = k0 - 1; k >= 0; k--) out.push(k);
  return out;
}

/** Mean and standard deviation of the mono mix (demucs normalises its input with these). */
export function mixStats(left, right) {
  const n = left.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (left[i] + right[i]) / 2;
  const mean = sum / (n || 1);
  let sq = 0;
  for (let i = 0; i < n; i++) { const d = (left[i] + right[i]) / 2 - mean; sq += d * d; }
  return { mean, std: Math.sqrt(sq / (n || 1)) || 1 };
}

/**
 * @param {{run: Function}} session onnxruntime InferenceSession (input "mix", output "stems")
 * @param {typeof import('onnxruntime-node')} ort
 * @param {Float32Array} left 44.1 kHz
 * @param {Float32Array} right
 * @param {{startSample?: number, onBlock?: Function, onProgress?: Function}} [opts]
 */
export async function separateDemucs(session, ort, left, right, { startSample = 0, onBlock, onProgress } = {}) {
  const total = left.length;
  const chunks = Math.max(1, Math.ceil(total / STRIDE));
  const win = fadeWindow();
  const { mean, std } = mixStats(left, right);
  const out = STEM_NAMES.map(() => [new Float32Array(total), new Float32Array(total)]);
  const weight = new Float32Array(total);
  const done = new Uint8Array(chunks);
  const input = new Float32Array(2 * SEGMENT);

  // Region ownership: [kS, kS+OV) is covered by chunks k-1 and k; [kS+OV, (k+1)S) by chunk k only.
  const emit = (a, b) => {
    a = Math.max(0, a); b = Math.min(total, b);
    if (b <= a || !onBlock) return;
    const stems = out.map((st) => st.map((ch) => {
      const seg = ch.slice(a, b);
      for (let i = 0; i < seg.length; i++) seg[i] = (seg[i] / Math.max(weight[a + i], 1e-8)) * std + mean;
      return seg;
    }));
    onBlock(a, b - a, stems);
  };
  const order = orderFrom(chunks, Math.floor(startSample / STRIDE));
  for (let n = 0; n < order.length; n++) {
    const k = order[n];
    const start = k * STRIDE;
    const end = Math.min(start + SEGMENT, total);
    const len = end - start;
    input.fill(0);
    for (let i = 0; i < len; i++) {
      input[i] = (left[start + i] - mean) / std;
      input[SEGMENT + i] = (right[start + i] - mean) / std;
    }
    const result = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, SEGMENT]) });
    const stems = result.stems.data; // (1, 4, 2, SEGMENT)
    for (let s = 0; s < 4; s++) {
      for (let ch = 0; ch < 2; ch++) {
        const base = (s * 2 + ch) * SEGMENT;
        const dst = out[s][ch];
        for (let i = 0; i < len; i++) dst[start + i] += stems[base + i] * win[i];
      }
    }
    for (let i = 0; i < len; i++) weight[start + i] += win[i];
    done[k] = 1;
    // Newly final ranges: this chunk's own region, and the overlaps shared with finished neighbours.
    const ownStart = k === 0 ? 0 : start + OVERLAP;
    if (k === 0 || done[k - 1]) emit(start, ownStart === 0 ? 0 : start + OVERLAP);
    emit(ownStart, k + 1 < chunks ? (k + 1) * STRIDE : total);
    if (k + 1 < chunks && done[k + 1]) emit((k + 1) * STRIDE, (k + 1) * STRIDE + OVERLAP);
    onProgress?.(n + 1, chunks);
  }
  for (const stem of out) for (const ch of stem) for (let i = 0; i < total; i++) ch[i] = (ch[i] / Math.max(weight[i], 1e-8)) * std + mean;
  return out;
}

// Kept for callers of the previous API.
export const separateStems = (session, ort, left, right, onProgress) => separateDemucs(session, ort, left, right, { onProgress });

// ---------------------------------------------------------------------------------------------
// FAST: Spleeter 4stems
// ---------------------------------------------------------------------------------------------
export const SPLEETER_STEMS = ['vocals', 'drums', 'bass', 'other']; // model file names
const N_FFT = 4096;
const HOP = 1024;
const T = 512;          // frames per network split (fixed by the graph)
const F = 1024;         // modelled bins (to ~11 kHz)
const BINS = N_FFT / 2 + 1;
const PAD = N_FFT - HOP; // front pad (keeps the WOLA inverse well conditioned at the start)
const SPLIT_STRIDE = T - 8; // splits overlap by 8 frames; each owns the 504 frames in its middle

const HANN = (() => { const w = new Float64Array(N_FFT); for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); return w; })(); // periodic

/** Sum of squared windows of all frames covering padded sample p (WOLA normaliser). */
function wsumAt(p, nFrames) {
  let s = 0;
  const i1 = Math.min(nFrames - 1, Math.floor(p / HOP));
  for (let i = Math.max(0, Math.ceil((p - N_FFT + 1) / HOP)); i <= i1; i++) { const w = HANN[p - i * HOP]; s += w * w; }
  return s;
}

/** Frames owned by split k (disjoint, covering [0, nFrames)). */
function splitOwn(k, nSplits, nFrames) {
  const a = k === 0 ? 0 : k * SPLIT_STRIDE + 4;
  const b = k === nSplits - 1 ? nFrames : (k + 1) * SPLIT_STRIDE + 4;
  return [a, Math.min(b, nFrames)];
}

/**
 * @param {Record<string, {run: Function}>} sessions {vocals, drums, bass, other}; input "x", output "y"
 * @param {typeof import('onnxruntime-node')} ort
 * @param {Float32Array} left 44.1 kHz
 * @param {Float32Array} right
 * @param {{startSample?: number, onBlock?: Function, onProgress?: Function}} [opts]
 * @returns {Promise<Float32Array[][]|null>} full stems in STEM_NAMES order when `keep`, else null
 */
export async function separateSpleeter(sessions, ort, left, right, { startSample = 0, onBlock, onProgress, keep = false, profile = null } = {}) {
  const tic = () => performance.now();
  const prof = (k, t) => { if (profile) profile[k] = (profile[k] ?? 0) + performance.now() - t; };
  const n = left.length;
  const nFrames = Math.ceil((PAD + n) / HOP);
  const nSplits = Math.max(1, Math.ceil(Math.max(1, nFrames - 8) / SPLIT_STRIDE));
  const at = (x, p) => { const i = p - PAD; return i >= 0 && i < n ? x[i] : 0; };
  const full = keep ? STEM_NAMES.map(() => [new Float32Array(n), new Float32Array(n)]) : null;
  const re = new Float64Array(N_FFT); const im = new Float64Array(N_FFT);
  const order = orderFrom(nSplits, Math.floor((Math.floor((startSample + PAD) / HOP) - 4) / SPLIT_STRIDE));

  for (let step = 0; step < order.length; step++) {
    const k = order[step];
    const fa = k * SPLIT_STRIDE;
    const fb = Math.min(fa + T, nFrames);
    const nf = fb - fa;
    let t0 = tic();
    // STFT of both channels at once: z = (L + iR) * w, then split the spectra.
    const sL = { re: new Float32Array(nf * BINS), im: new Float32Array(nf * BINS) };
    const sR = { re: new Float32Array(nf * BINS), im: new Float32Array(nf * BINS) };
    const x = new Float32Array(2 * T * F);
    for (let j = 0; j < nf; j++) {
      const p0 = (fa + j) * HOP;
      for (let t = 0; t < N_FFT; t++) { re[t] = at(left, p0 + t) * HANN[t]; im[t] = at(right, p0 + t) * HANN[t]; }
      fft(re, im);
      for (let b = 0; b < BINS; b++) {
        const nb = (N_FFT - b) % N_FFT;
        const lr = (re[b] + re[nb]) / 2; const li = (im[b] - im[nb]) / 2;
        const rr = (im[b] + im[nb]) / 2; const ri = (re[nb] - re[b]) / 2;
        const o = j * BINS + b;
        sL.re[o] = lr; sL.im[o] = li; sR.re[o] = rr; sR.im[o] = ri;
        if (b < F) {
          x[j * F + b] = Math.hypot(lr, li);
          x[T * F + j * F + b] = Math.hypot(rr, ri);
        }
      }
    }
    prof('stft', t0); t0 = tic();
    // Four networks (all needed: the masks are ratios across stems).
    const tensor = new ort.Tensor('float32', x, [2, 1, T, F]);
    // Sequential on purpose: four sessions in parallel each spin up a full thread pool and
    // oversubscribe the CPU (measured ~5x slower than running them one after another).
    const est = [];
    for (const s of SPLEETER_STEMS) est.push((await sessions[s].run({ x: tensor })).y.data);
    prof('nets', t0); t0 = tic();
    // Soft ratio masks, "average" extension above the modelled band.
    const masks = est.map(() => [new Float32Array(nf * BINS), new Float32Array(nf * BINS)]);
    for (let c = 0; c < 2; c++) {
      for (let j = 0; j < nf; j++) {
        const base = c * T * F + j * F;
        const sums = [0, 0, 0, 0];
        for (let b = 0; b < F; b++) {
          const e0 = est[0][base + b]; const e1 = est[1][base + b]; const e2 = est[2][base + b]; const e3 = est[3][base + b];
          const sq = [e0 * e0, e1 * e1, e2 * e2, e3 * e3];
          const inv = 1 / (sq[0] + sq[1] + sq[2] + sq[3] + 1e-10);
          for (let s = 0; s < 4; s++) {
            const m = (sq[s] + 2.5e-11) * inv;
            masks[s][c][j * BINS + b] = m;
            sums[s] += m;
          }
        }
        for (let s = 0; s < 4; s++) masks[s][c].fill(sums[s] / F, j * BINS + F, (j + 1) * BINS);
      }
    }
    prof('masks', t0); t0 = tic();
    // Inverse STFT (WOLA) of the owned frame range, both channels packed in one complex IFFT.
    const [oa, ob] = splitOwn(k, nSplits, nFrames);
    const pA = oa * HOP; const pB = ob * HOP;
    const sA = Math.max(0, pA - PAD); const sB = Math.min(n, pB - PAD);
    if (sB <= sA) { onProgress?.(step + 1, nSplits); continue; }
    const stems = STEM_NAMES.map(() => [new Float32Array(sB - sA), new Float32Array(sB - sA)]);
    // Masks sum to 1, so the last stem (other) is the mix minus the three others: skip its iSTFT.
    for (let s = 0; s < 3; s++) {
      const target = STEM_NAMES.indexOf(SPLEETER_STEMS[s]);
      const [mL, mR] = masks[s];
      const accL = stems[target][0]; const accR = stems[target][1];
      for (let i = Math.max(fa, oa - 3); i < ob; i++) {
        const j = i - fa;
        // Z = conj(X_L·m + i·X_R·m) over the full spectrum, so ifft(Z*) = conj(fft(conj(...)))/N.
        for (let b = 0; b < BINS; b++) {
          const o = j * BINS + b;
          const a = sL.re[o] * mL[o]; const bb = sL.im[o] * mL[o];
          const c = sR.re[o] * mR[o]; const d = sR.im[o] * mR[o];
          re[b] = a - d; im[b] = -(bb + c);                 // conj(Z[b])
          if (b > 0 && b < BINS - 1) { re[N_FFT - b] = a + d; im[N_FFT - b] = -(c - bb); } // conj(Z[N-b])
        }
        fft(re, im);
        const p0 = i * HOP;
        for (let t = 0; t < N_FFT; t++) {
          const p = p0 + t;
          if (p < pA || p >= pB) continue;
          const si = p - PAD;
          if (si < sA || si >= sB) continue;
          // conj(...)/N: real part -> left, -imag part -> right.
          accL[si - sA] += (re[t] / N_FFT) * HANN[t];
          accR[si - sA] += (-im[t] / N_FFT) * HANN[t];
        }
      }
    }
    const otherIdx = STEM_NAMES.indexOf('other');
    for (let si = sA; si < sB; si++) {
      const ws = wsumAt(si + PAD, nFrames);
      const inv = ws > 1e-8 ? 1 / ws : 0;
      let restL = left[si]; let restR = right[si];
      for (let s = 0; s < 4; s++) {
        if (s === otherIdx) continue;
        stems[s][0][si - sA] *= inv; stems[s][1][si - sA] *= inv;
        restL -= stems[s][0][si - sA]; restR -= stems[s][1][si - sA];
      }
      stems[otherIdx][0][si - sA] = restL; stems[otherIdx][1][si - sA] = restR;
    }
    prof('istft', t0);
    if (full) for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) full[s][c].set(stems[s][c], sA);
    onBlock?.(sA, sB - sA, stems);
    onProgress?.(step + 1, nSplits);
  }
  return full;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by both engines
// ---------------------------------------------------------------------------------------------

/** Interleave a stereo float stem as 16-bit PCM. */
export function stemToPcm16(stem) {
  const [l, r] = stem;
  const pcm = new Int16Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    const a = Math.max(-1, Math.min(1, l[i])); const b = Math.max(-1, Math.min(1, r[i]));
    pcm[2 * i] = a < 0 ? a * 0x8000 : a * 0x7fff;
    pcm[2 * i + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
  }
  return pcm;
}

/**
 * Peak envelope of a stem block for the waveform: one byte per 1/ENV_PPS s (full scale = 255).
 * Points are aligned to absolute time, so partial points at block edges are max-merged.
 * @returns {{start: number, data: Uint8Array}} start = index of the first point
 */
export function stemEnvelope(stem, startSample) {
  const per = STEM_RATE / ENV_PPS;
  const p0 = Math.floor(startSample / per);
  const p1 = Math.ceil((startSample + stem[0].length) / per);
  const data = new Uint8Array(Math.max(0, p1 - p0));
  const [l, r] = stem;
  for (let i = 0; i < l.length; i++) {
    const v = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    const k = Math.floor((startSample + i) / per) - p0;
    const q = Math.min(255, Math.round(v * 255));
    if (q > data[k]) data[k] = q;
  }
  return { start: p0, data };
}

/**
 * Vocal regions from the vocal stem: block RMS above a share of the loud level, merged across
 * short gaps. Returns [[start, end], ...] in seconds.
 */
export function vocalRegions(vocals, { blockSec = 0.25, minSec = 1, gapSec = 1.5 } = {}) {
  const [l, r] = vocals;
  const block = Math.round(blockSec * STEM_RATE);
  const rms = [];
  for (let i = 0; i + block <= l.length; i += block) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += (l[j] * l[j] + r[j] * r[j]) / 2;
    rms.push(Math.sqrt(s / block));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  if (loud < 1e-3) return [];
  const thr = Math.max(0.01, loud * 0.18);
  const regions = [];
  let cur = null;
  rms.forEach((v, k) => {
    const t = k * blockSec;
    if (v >= thr) {
      if (cur && t - cur[1] <= gapSec) cur[1] = t + blockSec;
      else { if (cur) regions.push(cur); cur = [t, t + blockSec]; }
    }
  });
  if (cur) regions.push(cur);
  return regions.filter(([a, b]) => b - a >= minSec).map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
}
