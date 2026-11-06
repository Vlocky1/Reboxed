// Track analysis: decode, resample/band-split with OfflineAudioContext (native, fast), then
// BPM / beatgrid / key / waveform / loudness in a worker.
import { base64ToU8 } from '../../shared/dsp/waveform.js';

const MONO_RATE = 11025;
const BAND_RATE = 22050;
const ANALYSIS_RATE = 44100; // 22050 saves little memory and moves the beatgrid by a few ms

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
  async analyzeBuffer(buffer, opts = {}) {
    return this.analyzeSignals(await this.signals(buffer), opts);
  }

  /** The two signals the analysis works on, as plain arrays it can take over (no copy to the worker). */
  async signals(buffer) {
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
    // Copied once here, then handed over: AudioBuffer channel storage is not reliably detachable.
    return { mono: mono.getChannelData(0).slice(), bands: [0, 1, 2].map((c) => bands.getChannelData(c).slice()) };
  }

  /** Run the analysis on signals(); the arrays go to the worker and are no longer usable here. */
  analyzeSignals({ mono, bands }, { bpmRange = [78, 155], mode = 'normal', fixedGrid = null } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id, mono, monoRate: MONO_RATE, bands, bandRate: BAND_RATE,
        bpmRange: { minBpm: bpmRange[0], maxBpm: bpmRange[1] }, mode, fixedGrid,
      }, [mono.buffer, ...bands.map((b) => b.buffer)]);
    });
  }

  /**
   * Analyse a file without loading it on a deck. It is decoded at the analysis's own quality, not the
   * sound card's (resampling to 48 kHz was over half of the decoding time), and the decoded audio is
   * released before the analysis starts: on a small computer memory counts as much as speed.
   */
  async analyzePath(path, opts) {
    const res = await fetch(mediaUrl(path));
    if (!res.ok) throw new Error(`Cannot read ${path} (${res.status})`);
    let buffer = await new OfflineAudioContext(2, 1, ANALYSIS_RATE).decodeAudioData(await res.arrayBuffer());
    const { duration } = buffer;
    const signals = await this.signals(buffer);
    buffer = null;
    return { ...await this.analyzeSignals(signals, opts), duration };
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
