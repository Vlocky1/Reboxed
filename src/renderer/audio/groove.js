// Groove Circuit DRUM SWAP / DRUM CAPTURE for one deck.
// Two banks (A/B) x 4 slots of drum loops. A playing slot replaces the track's drum part
// (drum stem muted), loops in time with the deck's bars and follows its tempo.
// The banks start with the built-in loops (drumkit.js, rendered at the deck's tempo); each slot can
// hold another built-in loop, an audio file, a capture, or be ejected, and has its own gain.
// DRUM CAPTURE (like rekordbox): CAPTURE arms it, then the DRUM SWAP slot pressed receives
// 1/2/4/8 bars (4-32 beats) of the current track's drum stem.
import { DRUM_PATTERNS, renderPattern } from '../../shared/drumkit.js';

export const CAPTURE_LENGTHS = [1, 2, 4, 8]; // bars (4, 8, 16, 32 beats)

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
    this.captureArmed = false;    // DRUM CAPTURE on: the next DRUM SWAP slot pressed receives the drums
    // Slot: built-in {builtin: index, name, bars, gain?}, audio {buffer, bpm, bars, name, captured: true,
    // file?, gain?}, or null (ejected).
    this.slots = [0, 1].map((b) => Array.from({ length: 4 }, (_, k) => {
      const p = DRUM_PATTERNS[b * 4 + k];
      return { builtin: b * 4 + k, name: p.name, bars: p.bars };
    }));
    this.captureCursor = [0, 0];
    this.rendered = new Map(); // `${pattern}:${bpm}` -> AudioBuffer
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
  armCapture(on) { this.captureArmed = on; this.emit(); }

  /** Toggle a slot. */
  toggle(slot) {
    if (this.isPlaying(slot)) { this.stop(slot); return; }
    const s = this.slot(slot);
    if (!s) return;
    if (!this.multi) this.keepOnly(null);
    this.start(slot, s.builtin !== undefined ? this.builtinLoop(s) : s);
  }

  /** A built-in pattern rendered at the deck's current tempo (cached per 0.1 BPM). */
  builtinLoop(s) {
    const bpm = Math.round((this.deck.currentBpm || this.deck.originalBpm || 120) * 10) / 10;
    const key = `${s.builtin}:${bpm}`;
    if (!this.rendered.has(key)) {
      const r = renderPattern(DRUM_PATTERNS[s.builtin], bpm, this.ctx.sampleRate);
      const buffer = new AudioBuffer({ numberOfChannels: 2, length: r.left.length, sampleRate: r.rate });
      buffer.copyToChannel(r.left, 0); buffer.copyToChannel(r.right, 1);
      if (this.rendered.size > 16) this.rendered.clear();
      this.rendered.set(key, buffer);
    }
    return { buffer: this.rendered.get(key), bpm, bars: s.bars, name: s.name };
  }

  start(slot, s) {
    const d = this.deck;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = s.gain ?? 1;
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
   * DRUM CAPTURE: copy `captureBars` bars of the drum stem from the current bar into `slot` of the
   * current bank (by default the next free one, or the oldest capture when full).
   * @param {Int16Array} drumsPcm interleaved stereo drum stem
   * @param {number} rate stem sample rate
   * @param {number} [slot]
   */
  capture(drumsPcm, rate, slot = this.nextCaptureSlot()) {
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
    this.store(this.bank, slot, { buffer, bpm: d.originalBpm, bars: this.captureBars, name: `${d.track?.title ?? 'Drums'} ${this.captureBars}bar` });
    this.dispatchEvent(new CustomEvent('capture', { detail: { bank: this.bank, slot } }));
    return slot;
  }

  /** Built-in loops are replaced first, then the oldest capture. */
  nextCaptureSlot() {
    const slots = this.slots[this.bank];
    const free = slots.findIndex((s) => !s?.captured);
    if (free >= 0) return free;
    const k = this.captureCursor[this.bank];
    this.captureCursor[this.bank] = (k + 1) % 4;
    return k;
  }

  /** Put a captured loop in a slot (also used to restore saved captures). */
  store(bank, slot, s) {
    if (this.playing.has(this.key(slot, bank))) this.stop(slot, bank);
    this.slots[bank][slot] = { ...s, captured: true };
    this.emit();
  }

  /** Back to the built-in loop of a slot. */
  reset(bank, slot) { this.setBuiltin(bank, slot, bank * 4 + slot); }

  /** A built-in loop (DRUM_PATTERNS index) in a slot. */
  setBuiltin(bank, slot, index) {
    if (this.playing.has(this.key(slot, bank))) this.stop(slot, bank);
    const p = DRUM_PATTERNS[index];
    if (!p) return;
    this.slots[bank][slot] = { builtin: index, name: p.name, bars: p.bars, gain: this.slots[bank][slot]?.gain };
    this.emit();
  }

  /** EJECT: the slot is empty (pressing it does nothing). */
  eject(bank, slot) {
    if (this.playing.has(this.key(slot, bank))) this.stop(slot, bank);
    this.slots[bank][slot] = null;
    this.emit();
  }

  /** Gain of one slot (0..2), also while it plays. */
  setSlotGain(bank, slot, gain) {
    const s = this.slots[bank][slot];
    if (!s) return;
    s.gain = gain;
    const p = this.playing.get(this.key(slot, bank));
    if (p) p.g.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    this.emit();
  }
}
