// 16-slot sampler: one-shot or loop, optional tempo sync to the master deck (time-stretched by
// playback rate, started on the next beat), per-slot gain, its own volume into the master bus.

export const SAMPLER_SLOTS = 16;

export class Sampler extends EventTarget {
  /** @param {import('./engine.js').AudioEngine} engine */
  constructor(engine) {
    super();
    this.engine = engine;
    const ctx = engine.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.8;
    this.bus.connect(engine.samplerIn ?? engine.masterIn);
    this.slots = Array.from({ length: SAMPLER_SLOTS }, () => ({
      name: '', path: '', bpm: 0, mode: 'oneshot', sync: true, gain: 1, buffer: null, source: null, startedAt: 0, rate: 1,
    }));
  }

  emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }

  setVolume(v) { this.bus.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01); }

  /** SAMPLER CUE: the sampler in the headphones too. */
  setCue(on) {
    const ctx = this.engine.ctx;
    if (!this.cueSend) {
      this.cueSend = ctx.createGain();
      this.cueSend.gain.value = 0;
      this.bus.connect(this.cueSend);
      this.cueSend.connect(this.engine.cueBus);
    }
    this.cue = on;
    this.cueSend.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.005);
  }

  /** Serializable configuration (buffers are re-decoded from `path` on startup). */
  config() {
    return this.slots.map(({ name, path, bpm, mode, sync, gain }) => ({ name, path, bpm, mode, sync, gain }));
  }

  /**
   * @param {number} i
   * @param {{name: string, path: string, bpm?: number, buffer: AudioBuffer, mode?: string}} s
   */
  setSlot(i, s) {
    this.stop(i);
    const slot = this.slots[i];
    Object.assign(slot, { name: s.name, path: s.path, bpm: s.bpm ?? 0, buffer: s.buffer });
    if (s.mode) slot.mode = s.mode;
    if (s.sync !== undefined) slot.sync = s.sync;
    if (s.gain !== undefined) slot.gain = s.gain;
    this.emit({ slot: i });
  }

  clear(i) {
    this.stop(i);
    Object.assign(this.slots[i], { name: '', path: '', bpm: 0, buffer: null });
    this.emit({ slot: i });
  }

  update(i, patch) {
    Object.assign(this.slots[i], patch);
    if (this.slots[i].source && patch.gain !== undefined) this.slots[i].gainNode.gain.value = patch.gain;
    this.emit({ slot: i });
  }

  isPlaying(i) { return !!this.slots[i].source; }

  /** 0..1 play position for the UI. */
  progress(i) {
    const s = this.slots[i];
    if (!s.source || !s.buffer) return 0;
    const t = (this.engine.ctx.currentTime - s.startedAt) * s.rate;
    if (t < 0) return 0;
    return s.mode === 'loop' ? (t % s.buffer.duration) / s.buffer.duration : Math.min(1, t / s.buffer.duration);
  }

  /** Pad/slot press: loop slots toggle, one-shots (re)trigger. */
  trigger(i) {
    const s = this.slots[i];
    if (!s.buffer) return;
    if (s.mode === 'loop' && s.source) { this.stop(i); return; }
    this.stop(i);
    const ctx = this.engine.ctx;
    this.engine.resume();
    const master = this.engine.masterDeck;
    const synced = s.sync && s.bpm > 0 && master?.loaded && master.currentBpm > 0;
    const rate = synced ? master.currentBpm / s.bpm : 1;
    let when = ctx.currentTime;
    if (synced && master.playing && master.grid) {
      // Start on the master's next beat.
      const beatSec = 60 / master.currentBpm;
      const untilNext = (1 - master.phase()) * beatSec;
      if (untilNext < beatSec * 0.95) when += untilNext;
    }
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = s.mode === 'loop';
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = s.gain;
    src.connect(g); g.connect(this.bus);
    src.start(when);
    src.onended = () => { if (s.source === src) { s.source = null; this.emit({ slot: i, playing: false }); } };
    Object.assign(s, { source: src, gainNode: g, startedAt: when, rate });
    this.emit({ slot: i, playing: true });
  }

  stop(i) {
    const s = this.slots[i];
    if (!s.source) return;
    const src = s.source;
    s.source = null;
    s.gainNode.gain.setTargetAtTime(0, this.engine.ctx.currentTime, 0.005);
    try { src.stop(this.engine.ctx.currentTime + 0.03); } catch { /* not started */ }
    this.emit({ slot: i, playing: false });
  }

  stopAll() { this.slots.forEach((_, i) => this.stop(i)); }
}
