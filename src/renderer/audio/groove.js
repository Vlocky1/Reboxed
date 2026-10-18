// Groove Circuit DRUM SWAP / DRUM CAPTURE for one deck.
// Two banks (A/B) x 4 slots of drum loops. A playing slot replaces the track's drum part
// (drum stem muted), loops in time with the deck's bars and follows its tempo.
// DRUM CAPTURE stores 1/2/4 bars of the current track's drum stem into the next free slot.

export const CAPTURE_LENGTHS = [1, 2, 4]; // bars

export class DrumSwap extends EventTarget {
  /**
   * @param {import('./deck.js').Deck} deck
   * @param {AudioNode} input where swap loops enter the channel (before trim/EQ)
   */
  constructor(deck, input) {
    super();
    this.deck = deck;
    this.ctx = deck.engine.ctx;
    this.out = this.ctx.createGain();
    this.out.connect(input);
    this.bank = 0;                // 0 = A, 1 = B
    this.multi = false;           // single mode: one slot at a time
    this.captureBars = 1;
    this.slots = [0, 1].map(() => Array.from({ length: 4 }, () => null)); // {buffer, bpm, bars, name}
    this.playing = new Map();     // `${bank}:${slot}` -> {src, gain}
    this.level = 1;
  }

  emit() { this.dispatchEvent(new Event('change')); }
  key(slot, bank = this.bank) { return `${bank}:${slot}`; }
  isPlaying(slot) { return this.playing.has(this.key(slot)); }
  slot(slot) { return this.slots[this.bank][slot]; }

  setLevel(v) { this.level = v; this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setBank(b) { this.bank = b; this.emit(); }
  setMulti(on) { this.multi = on; if (!on) this.keepOnly(null); this.emit(); }
  cycleCaptureLength() { this.captureBars = CAPTURE_LENGTHS[(CAPTURE_LENGTHS.indexOf(this.captureBars) + 1) % CAPTURE_LENGTHS.length]; this.emit(); return this.captureBars; }

  /** Toggle a slot. Empty slot: nothing (capture first). */
  toggle(slot) {
    if (this.isPlaying(slot)) { this.stop(slot); return; }
    const s = this.slot(slot);
    if (!s) return;
    if (!this.multi) this.keepOnly(null);
    this.start(slot, s);
  }

  start(slot, s) {
    const d = this.deck;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    const g = this.ctx.createGain();
    src.connect(g); g.connect(this.out);
    src.playbackRate.value = this.rateFor(s);
    // Start in phase with the deck's bars.
    let offset = 0;
    if (d.bg && d.loaded) {
      const beats = s.bars * 4;
      const pos = d.position();
      const fromBar = d.bg.indexAt(pos) - d.bg.indexAt(d.bg.floorBar(pos, s.bars));
      offset = ((fromBar % beats) / beats) * s.buffer.duration;
    }
    src.start(this.ctx.currentTime, Math.max(0, offset));
    this.playing.set(this.key(slot), { src, g, s });
    d.setDrumGain(0);
    this.emit();
  }

  stop(slot, bank = this.bank) {
    const p = this.playing.get(this.key(slot, bank));
    if (!p) return;
    p.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    p.src.stop(this.ctx.currentTime + 0.05);
    this.playing.delete(this.key(slot, bank));
    if (!this.playing.size) this.deck.setDrumGain(1);
    this.emit();
  }

  keepOnly(keepKey) {
    for (const k of [...this.playing.keys()]) {
      if (k === keepKey) continue;
      const [b, sl] = k.split(':').map(Number);
      this.stop(sl, b);
    }
  }

  stopAll() { this.keepOnly(null); }

  rateFor(s) {
    const bpm = this.deck.currentBpm;
    return s.bpm > 0 && bpm > 0 ? bpm / s.bpm : 1;
  }

  /** Follow the deck: tempo changes, pause stops swaps (the track's drums come back on play). */
  tick() {
    if (!this.playing.size) return;
    if (!this.deck.playing) { this.stopAll(); return; }
    for (const p of this.playing.values()) {
      const r = this.rateFor(p.s);
      if (Math.abs(p.src.playbackRate.value - r) > 0.0005) p.src.playbackRate.value = r;
    }
  }

  /**
   * DRUM CAPTURE: copy `captureBars` bars of the drum stem from the current bar into the next
   * free slot of the current bank (or slot 0 when full).
   * @param {Int16Array} drumsPcm interleaved stereo drum stem
   * @param {number} rate stem sample rate
   */
  capture(drumsPcm, rate) {
    const d = this.deck;
    if (!d.bg) return -1;
    const start = d.bg.floorBar(d.position());
    const end = d.bg.timeOf(d.bg.indexAt(start) + this.captureBars * 4);
    const a = Math.round(start * rate); const b = Math.min(drumsPcm.length / 2, Math.round(end * rate));
    if (b - a < rate * 0.2) return -1;
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: b - a, sampleRate: rate });
    for (let ch = 0; ch < 2; ch++) {
      const data = new Float32Array(b - a);
      for (let i = 0; i < b - a; i++) data[i] = drumsPcm[2 * (a + i) + ch] / 32768;
      buffer.copyToChannel(data, ch);
    }
    const slots = this.slots[this.bank];
    let slot = slots.findIndex((s) => !s);
    if (slot < 0) slot = 0;
    slots[slot] = { buffer, bpm: d.originalBpm, bars: this.captureBars, name: `${d.track?.title ?? 'Drums'} ${this.captureBars}bar` };
    this.emit();
    return slot;
  }
}
