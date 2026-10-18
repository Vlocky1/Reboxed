// Track analysis: decode, resample/band-split with OfflineAudioContext (native, fast), then
// BPM / beatgrid / key / waveform / loudness in a worker.
import { base64ToU8 } from '../../shared/dsp/waveform.js';

const MONO_RATE = 11025;
const BAND_RATE = 22050;

export const BPM_RANGES = [
  [48, 95], [58, 115], [68, 135], [70, 180], [78, 155], [88, 175], [98, 195], [108, 215], [118, 235], [128, 255],
];

export function mediaUrl(path) {
  return `media://local/${encodeURIComponent(path)}`;
}

export class Analyzer {
  /** @param {BaseAudioContext} decodeCtx context used for decodeAudioData */
  constructor(decodeCtx) {
    this.decodeCtx = decodeCtx;
    this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.seq = 0;
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
  }

  async decode(path) {
    const res = await fetch(mediaUrl(path));
    if (!res.ok) throw new Error(`Cannot read ${path} (${res.status})`);
    return this.decodeCtx.decodeAudioData(await res.arrayBuffer());
  }

  /**
   * @param {AudioBuffer} buffer
   * @param {{bpmRange?: [number, number]}} [opts]
   */
  async analyzeBuffer(buffer, { bpmRange = [78, 155], mode = 'normal', fixedGrid = null } = {}) {
    const mono = await render(buffer, MONO_RATE, 1, (ctx, src) => src.connect(ctx.destination));
    const bands = await render(buffer, BAND_RATE, 3, (ctx, src) => {
      const merger = ctx.createChannelMerger(3);
      const mk = (type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; return b; };
      const low = mk('lowpass', 200);
      const midH = mk('highpass', 200); const midL = mk('lowpass', 2000);
      const high = mk('highpass', 2000);
      src.connect(low); low.connect(merger, 0, 0);
      src.connect(midH); midH.connect(midL); midL.connect(merger, 0, 1);
      src.connect(high); high.connect(merger, 0, 2);
      merger.connect(ctx.destination);
    });
    const monoData = mono.getChannelData(0);
    const bandData = [0, 1, 2].map((c) => bands.getChannelData(c));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id, mono: monoData, monoRate: MONO_RATE, bands: bandData, bandRate: BAND_RATE,
        bpmRange: { minBpm: bpmRange[0], maxBpm: bpmRange[1] }, mode, fixedGrid,
      }); // copied, not transferred: AudioBuffer channel storage is not reliably detachable
    });
  }

  async analyzePath(path, opts) {
    const buffer = await this.decode(path);
    const result = await this.analyzeBuffer(buffer, opts);
    return { ...result, duration: buffer.duration };
  }
}

async function render(buffer, rate, channels, wire) {
  const length = Math.max(1, Math.ceil(buffer.duration * rate));
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate: rate });
  if (channels > 1) {
    ctx.destination.channelCount = channels;
    ctx.destination.channelInterpretation = 'discrete';
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  wire(ctx, src);
  src.start();
  return ctx.startRendering();
}

/** Decode stored base64 waveform into typed arrays (cached on the object). */
export function waveformArrays(analysis) {
  if (!analysis?.waveform) return null;
  if (!analysis._wf) {
    const w = analysis.waveform;
    analysis._wf = { pps: w.pps, low: base64ToU8(w.low), mid: base64ToU8(w.mid), high: base64ToU8(w.high) };
  }
  return analysis._wf;
}
