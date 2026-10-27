// Pad sampler: 64 pads (one kit at a time) into the sampler bus, plus an instrument mode where the
// grid is a keyboard playing a built-in synth or a sample pitched chromatically. Pads start
// quantized to the master's beat or bar, synced loops follow the master tempo, choke groups cut
// each other, held pads release with a short fade.
import { drumSound, fxSound, synthNote } from '../../shared/padsynth.js';
import { normalizeKit, defaultKits, quantizeDelay, padRate, PAD_COUNT } from '../../shared/padkit.js';

export class PadSampler extends EventTarget {
  /**
   * @param {import('./engine.js').AudioEngine} engine
   * @param {(path: string) => Promise<AudioBuffer>} decode
   */
  constructor(engine, decode) {
    super();
    this.engine = engine;
    this.decode = decode;
    const ctx = engine.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.volume = 0.9;
    this.bus.connect(engine.samplerIn ?? engine.masterIn);
    this.kits = defaultKits();
    this.kitIndex = 0;
    /** pad index -> {src, gain, startedAt, rate, onEnd} */
    this.voices = new Map();
    /** instrument note -> voice */
    this.notes = new Map();
    this.buffers = new Map(); // cache key -> AudioBuffer
    this.missing = new Set(); // file paths that failed to load
  }

  get kit() { return this.kits[this.kitIndex]; }

  emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }

  setVolume(v) { this.bus.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01); this.volume = v; }

  /** Kits from settings (or the shipped ones). */
  load(kits, index = 0) {
    this.stopAll();
    this.kits = Array.isArray(kits) && kits.length ? kits.map(normalizeKit) : defaultKits();
    this.kitIndex = Math.max(0, Math.min(this.kits.length - 1, index));
    this.emit({ kits: true });
  }

  selectKit(i) {
    if (i < 0 || i >= this.kits.length || i === this.kitIndex) return;
    this.stopAll();
    this.kitIndex = i;
    this.emit({ kits: true });
    this.preload();
  }

  /** Decode the kit's sounds ahead of the first press. */
  async preload() {
    await Promise.all(this.kit.pads.map((p) => (p ? this.bufferFor(p).catch(() => null) : null)));
  }

  /** Master tempo and position for quantize and sync. */
  masterBeat() {
    const e = this.engine;
    const d = e.masterDeck?.playing ? e.masterDeck : e.decks.find((x) => x.playing && x.bg) ?? e.masterDeck;
    if (!d?.loaded || !(d.currentBpm > 0)) return null;
    if (!d.playing || !d.bg) return { bpm: d.currentBpm, phase: 0, beatInBar: 0, playing: false };
    const idx = d.bg.indexAt(d.position());
    const i = Math.floor(idx);
    return { bpm: d.currentBpm, phase: idx - i, beatInBar: d.bg.barPos(i), playing: true };
  }

  /** The AudioBuffer of a pad's sound (built-in sounds are rendered once and cached). */
  async bufferFor(pad, note = null) {
    const ctx = this.engine.ctx;
    const src = pad.src;
    const mono = (arr) => {
      const b = ctx.createBuffer(1, arr.length, ctx.sampleRate);
      b.copyToChannel(arr, 0);
      return b;
    };
    let key;
    if (src.drum) key = `drum:${src.drum}`;
    else if (src.synth) key = `synth:${src.synth}:${note ?? src.note ?? 57}`;
    else if (src.fx) key = `fx:${src.fx}:${src.beats ?? 8}:${Math.round(this.masterBeat()?.bpm ?? 124)}`;
    else if (src.path) key = `file:${src.path}`;
    else throw new Error('empty pad');
    if (this.buffers.has(key)) return this.buffers.get(key);
    let buf;
    if (src.drum) buf = mono(drumSound(src.drum, ctx.sampleRate));
    else if (src.synth) buf = mono(synthNote(src.synth, note ?? src.note ?? 57, ctx.sampleRate));
    else if (src.fx) buf = mono(fxSound(src.fx, this.masterBeat()?.bpm ?? 124, ctx.sampleRate, src.beats ?? 8));
    else {
      try { buf = await this.decode(src.path); } catch (err) { this.missing.add(src.path); throw err; }
      this.missing.delete(src.path);
    }
    this.buffers.set(key, buf);
    if (this.buffers.size > 400) this.buffers.delete(this.buffers.keys().next().value);
    return buf;
  }

  isPlaying(i) { return this.voices.has(i); }

  /** 0..1 position of a playing pad (loops wrap). */
  progress(i) {
    const v = this.voices.get(i);
    if (!v?.src.buffer) return 0;
    const t = (this.engine.ctx.currentTime - v.startedAt) * v.rate;
    if (t < 0) return 0;
    const d = v.src.buffer.duration;
    return v.src.loop ? (t % d) / d : Math.min(1, t / d);
  }

  /**
   * Pad pressed (velocity 1..127; mouse = 100) or released (velocity 0).
   * @returns {Promise<{started: boolean, delay: number}>}
   */
  async press(i, velocity = 100) {
    const pad = this.kit.pads[i];
    if (!pad) return { started: false, delay: 0 };
    if (velocity === 0) {
      if (pad.mode === 'gate') { const p = this.padStarting?.get(i); if (p) p.released = true; this.release(i); }
      return { started: false, delay: 0 };
    }
    if ((pad.mode === 'loop' || pad.mode === 'toggle') && this.voices.has(i)) { this.release(i, 0.01); return { started: false, delay: 0 }; }
    const token = {};
    (this.padStarting ??= new Map()).set(i, token);
    let buf;
    try { buf = await this.bufferFor(pad); } catch { this.padStarting.delete(i); return { started: false, delay: 0 }; }
    if (this.padStarting.get(i) !== token) return { started: false, delay: 0 };
    this.padStarting.delete(i);
    const beat = this.masterBeat();
    const delay = pad.mode === 'loop' && beat?.playing ? quantizeDelay(this.kit.quantize, beat) : 0;
    this.stopVoice(i);
    if (pad.choke) {
      this.kit.pads.forEach((p, j) => { if (j !== i && p?.choke === pad.choke && this.voices.has(j)) this.release(j, 0.008); });
    }
    const v = this.start(buf, { gain: pad.gain * (0.35 + 0.65 * (velocity / 127)), rate: padRate(pad, beat?.bpm ?? 0), loop: pad.mode === 'loop' || pad.mode === 'toggle', delay });
    v.onEnd = () => { if (this.voices.get(i) === v) { this.voices.delete(i); this.emit({ pad: i, playing: false }); } };
    this.voices.set(i, v);
    this.emit({ pad: i, playing: true, delay });
    // A held pad released while its sound was being prepared: a short hit.
    if (token.released) setTimeout(() => { if (this.voices.get(i) === v) this.release(i); }, 80);
    return { started: true, delay };
  }

  start(buffer, { gain = 1, rate = 1, loop = false, delay = 0 }) {
    const ctx = this.engine.ctx;
    this.engine.resume?.();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.bus);
    const when = ctx.currentTime + delay;
    src.start(when);
    const v = { src, gain: g, startedAt: when, rate, onEnd: null };
    src.onended = () => v.onEnd?.();
    return v;
  }

  /** Fade out and stop a pad. */
  release(i, fade = 0.06) {
    const v = this.voices.get(i);
    if (!v) return;
    this.voices.delete(i);
    this.fade(v, fade);
    this.emit({ pad: i, playing: false });
  }

  stopVoice(i) { const v = this.voices.get(i); if (v) { this.voices.delete(i); this.fade(v, 0.005); } }

  fade(v, time) {
    const t = this.engine.ctx.currentTime;
    v.onEnd = null;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, Math.max(t, v.startedAt), time / 3);
    try { v.src.stop(Math.max(t, v.startedAt) + time + 0.02); } catch { /* not started */ }
  }

  /** Stop the pads of one grid row (side buttons). */
  stopRow(y) { for (let x = 0; x < 8; x++) this.release(y * 8 + x, 0.02); }

  stopAll() {
    for (const i of [...this.voices.keys()]) this.release(i, 0.02);
    for (const n of [...this.notes.keys()]) this.noteOff(n, 0.02);
  }

  // ---- instrument mode -------------------------------------------------------------------------

  /** Sound of the instrument: a built-in synth, or one of the kit's pads pitched. */
  instrumentPad() {
    const s = this.kit.instrument.sound;
    if (Number.isInteger(s?.pad)) return this.kit.pads[s.pad] ?? null;
    return { src: { synth: s?.synth ?? 'sub' }, gain: 1, pitch: 0 };
  }

  async noteOn(note, velocity = 100) {
    const pad = this.instrumentPad();
    if (!pad) return;
    this.noteOff(note, 0.004);
    const token = {};
    (this.starting ??= new Map()).set(note, token);
    let buf; let rate = 1;
    try {
      if (pad.src.synth) buf = await this.bufferFor(pad, note);
      else {
        // A sample: its own pitch is the kit's root note in octave 3.
        buf = await this.bufferFor(pad);
        rate = 2 ** ((note - (48 + this.kit.instrument.root) + (pad.pitch ?? 0)) / 12);
      }
    } catch { this.starting.delete(note); return; }
    if (this.starting.get(note) !== token) return; // a newer press of the same note
    const releasedEarly = !!token.released;
    this.starting.delete(note);
    const v = this.start(buf, { gain: (pad.gain ?? 1) * (0.35 + 0.65 * (velocity / 127)), rate });
    v.onEnd = () => { if (this.notes.get(note) === v) { this.notes.delete(note); this.emit({ note, playing: false }); } };
    this.notes.set(note, v);
    this.emit({ note, playing: true });
    // Released while its sound was being prepared (a quick tap): a short note.
    if (releasedEarly) setTimeout(() => { if (this.notes.get(note) === v) this.noteOff(note); }, 80);
  }

  noteOff(note, fade = null) {
    const pending = this.starting?.get(note);
    if (pending && fade === null) pending.released = true;
    const v = this.notes.get(note);
    if (!v) return;
    if (fade === null && this.kit.instrument.mode === 'oneshot') return; // plays to the end
    this.notes.delete(note);
    const synth = this.instrumentPad()?.src.synth;
    this.fade(v, fade ?? (synth === 'pad' ? 0.5 : synth === 'lead' || synth === 'reese' ? 0.12 : 0.06));
    this.emit({ note, playing: false });
  }

  // ---- editing ---------------------------------------------------------------------------------

  setPad(i, pad) {
    this.stopVoice(i);
    this.kit.pads[i] = pad;
    this.emit({ pad: i, edit: true });
  }

  updatePad(i, patch) {
    const p = this.kit.pads[i];
    if (!p) return;
    Object.assign(p, patch);
    const v = this.voices.get(i);
    if (v && patch.gain !== undefined) v.gain.gain.setTargetAtTime(p.gain, this.engine.ctx.currentTime, 0.01);
    if (v && (patch.pitch !== undefined || patch.sync !== undefined)) v.src.playbackRate.setTargetAtTime(padRate(p, this.masterBeat()?.bpm ?? 0), this.engine.ctx.currentTime, 0.01);
    // Gain / pitch sliders: the editor stays as it is; other fields rebuild it.
    this.emit({ pad: i, edit: true, update: patch.gain !== undefined || patch.pitch !== undefined || patch.name !== undefined });
  }

  /** Move a pad onto another cell (the other pad takes its place). */
  swapPads(a, b) {
    const pads = this.kit.pads;
    this.stopVoice(a); this.stopVoice(b);
    [pads[a], pads[b]] = [pads[b], pads[a]];
    this.emit({ pad: a, edit: true });
  }

  /** Synced loops follow the master's tempo changes. */
  followTempo() {
    const bpm = this.masterBeat()?.bpm ?? 0;
    for (const [i, v] of this.voices) {
      const p = this.kit.pads[i];
      if (p?.sync && p.bpm > 0 && bpm > 0) {
        const r = padRate(p, bpm);
        if (Math.abs(r - v.rate) > 0.0005) { v.rate = r; v.src.playbackRate.setTargetAtTime(r, this.engine.ctx.currentTime, 0.02); }
      }
    }
  }

  newKit(name = 'New kit') {
    const kit = normalizeKit({ name, pads: Array(PAD_COUNT).fill(null) });
    this.kits.push(kit);
    this.selectKit(this.kits.length - 1);
    return kit;
  }

  duplicateKit() {
    const kit = normalizeKit(JSON.parse(JSON.stringify({ ...this.kit, id: '', name: `${this.kit.name} (copy)` })));
    this.kits.push(kit);
    this.selectKit(this.kits.length - 1);
  }

  deleteKit() {
    if (this.kits.length <= 1) return;
    this.stopAll();
    this.kits.splice(this.kitIndex, 1);
    this.kitIndex = Math.min(this.kitIndex, this.kits.length - 1);
    this.emit({ kits: true });
  }

  /** Serializable kits. */
  config() { return { kits: this.kits, index: this.kitIndex }; }
}
