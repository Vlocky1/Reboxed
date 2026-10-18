// AudioWorklet deck player: owns the decoded PCM and the play head.
// - direct mode: resampling read at `rate` (vinyl: tempo changes pitch)
// - stretch mode (master tempo and/or key shift): two overlapping Hann grains read the source
//   at `pitch` speed while the play head advances at `rate` (granular time-stretch)
// - sample-accurate loops, reverse, slip (shadow position that keeps running)

const GRAIN = 2048;
const STEM_BLOCK = 4096; // granularity of the "stems ready" map (stem frames)
const REPORT_EVERY = 512; // frames between position reports (~86/s at 44.1 kHz)

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.length = 0;
    this.srcRate = sampleRate;
    this.pos = 0;          // source frames (fractional)
    this.slipPos = 0;
    this.playing = false;
    this.rate = 1;         // tempo (play-head speed)
    this.bend = 1;         // temporary pitch bend / nudge factor
    this.keyLock = false;
    this.keyShift = 0;     // semitones
    this.reverse = false;
    this.slip = false;
    this.slipActive = false;
    this.loop = null;      // {start, end} in source frames
    this.grains = [{ start: 0, n: 0 }, { start: 0, n: GRAIN / 2 }];
    this.window = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) this.window[i] = Math.sin((Math.PI * i) / GRAIN) ** 2;
    this.sinceReport = 0;
    this.gain = 1;         // de-click ramp
    // Stems: 4 interleaved stereo Int16 arrays [drums, bass, other, vocals] at stemRate.
    this.stems = null;
    this.stemRate = 44100;
    this.stemGains = [1, 1, 1, 1];
    this.stemTarget = [1, 1, 1, 1];
    this.blend = 0;        // 0 = original mix, 1 = sum of stems
    // Groove Circuit on the drum stem: gain (drum swap / release), roll, trans gate, brake.
    this.drum = { gain: 1, target: 1, roll: null, trans: null, brake: null };
    // Vinyl scratch: while the jog is touched the play head follows the jog speed.
    this.scratching = false;
    this.scratchRate = 0;
    this.scratchTarget = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get drumActive() { const d = this.drum; return d.target < 1 || d.gain < 1 || d.roll || d.trans || d.brake; }

  /** Drum stem sample at stem frame sx (with roll / trans / brake / gain applied). */
  drumSample(ch, sx) {
    const d = this.drum;
    let pos = sx;
    if (d.roll && sx >= d.roll.start) pos = d.roll.start + ((sx - d.roll.start) % d.roll.len);
    if (d.brake) pos = d.brake.pos;
    const i = Math.floor(pos);
    const len = this.stems[0].length / 2;
    if (i < 0 || i + 1 >= len) return 0;
    const f = pos - i;
    const a = this.stems[0][2 * i + ch]; const b = this.stems[0][2 * (i + 1) + ch];
    let g = d.gain * this.stemGains[0];
    if (d.trans) g *= d.trans.open ? 1 : 0;
    if (d.brake) g *= d.brake.speed;
    return g * (a + (b - a) * f);
  }

  /** Mix or stems at source position x (source frames), channel ch. */
  sample(ch, x) {
    const mix = this.read(Math.min(ch, this.channels.length - 1), x); // mono files: reuse channel 0
    if (!this.stems || this.blend <= 0) return mix;
    const sx = (x * this.stemRate) / this.srcRate;
    const i = Math.floor(sx);
    const f = sx - i;
    const len = this.stems[0].length / 2;
    if (i < 0 || i + 1 >= len) return mix * (1 - this.blend);
    // Progressive separation: where stems aren't computed yet, keep playing the original mix.
    if (this.stemReady && !this.stemReady[Math.floor(i / STEM_BLOCK)]) return mix;
    let s = 0;
    const drumFx = this.drumActive;
    for (let k = drumFx ? 1 : 0; k < 4; k++) {
      const g = this.stemGains[k];
      if (g < 1e-4) continue;
      const d = this.stems[k];
      const a = d[2 * i + ch]; const b = d[2 * (i + 1) + ch];
      s += g * (a + (b - a) * f);
    }
    if (drumFx) s += this.drumSample(ch, sx);
    return mix * (1 - this.blend) + (s / 32768) * this.blend;
  }

  /** Per-sample ramps for stem gains and the mix<->stems blend. */
  rampStems() {
    if (!this.stems) return;
    let anyMuted = false;
    for (let k = 0; k < 4; k++) {
      const t = this.stemTarget[k];
      const g = this.stemGains[k];
      if (g !== t) this.stemGains[k] = Math.abs(t - g) < 1 / 512 ? t : g + Math.sign(t - g) / 512;
      if (t < 1) anyMuted = true;
    }
    const d = this.drum;
    if (d.gain !== d.target) d.gain = Math.abs(d.target - d.gain) < 1 / 256 ? d.target : d.gain + Math.sign(d.target - d.gain) / 256;
    if (d.trans) { d.trans.n++; d.trans.open = d.trans.n % d.trans.len < d.trans.len / 2; }
    if (d.brake) { d.brake.speed = Math.max(0, d.brake.speed - d.brake.step); d.brake.pos += d.brake.speed * (this.stemRate / sampleRate); }
    const bt = anyMuted || this.drumActive ? 1 : 0;
    if (this.blend !== bt) this.blend = Math.abs(bt - this.blend) < 1 / 1024 ? bt : this.blend + Math.sign(bt - this.blend) / 1024;
  }

  toFrames(sec) { return sec * this.srcRate; }

  onMessage(m) {
    if (m.seq !== undefined) this.seq = m.seq;
    switch (m.type) {
      case 'load':
        this.channels = m.channels;
        this.length = m.channels[0].length;
        this.srcRate = m.sampleRate;
        this.pos = 0; this.slipPos = 0; this.playing = false; this.loop = null; this.slipActive = false;
        this.stems = null; this.blend = 0;
        break;
      case 'unload': this.channels = null; this.length = 0; this.playing = false; this.stems = null; break;
      case 'stems': // complete stems (from the cache)
        this.stems = m.stems;
        this.stemRate = m.rate;
        this.stemReady = null; // null = everything ready
        break;
      case 'stemsInit': { // progressive separation: empty buffers + a map of ready blocks
        this.stems = [0, 1, 2, 3].map(() => new Int16Array(m.frames * 2));
        this.stemRate = m.rate;
        const blocks = Math.ceil(m.frames / STEM_BLOCK);
        this.stemReady = new Uint8Array(blocks);
        this.stemFill = new Uint32Array(blocks);
        this.stemFrames = m.frames;
        break;
      }
      case 'stemsPatch': {
        if (!this.stems) break;
        const { start, pcm } = m;
        const len = pcm[0].length / 2;
        for (let s = 0; s < 4; s++) this.stems[s].set(pcm[s], start * 2);
        if (this.stemReady) {
          for (let b = Math.floor(start / STEM_BLOCK); b <= Math.floor((start + len - 1) / STEM_BLOCK); b++) {
            const a = Math.max(start, b * STEM_BLOCK); const z = Math.min(start + len, (b + 1) * STEM_BLOCK);
            this.stemFill[b] += z - a;
            if (this.stemFill[b] >= Math.min(STEM_BLOCK, this.stemFrames - b * STEM_BLOCK)) this.stemReady[b] = 1;
          }
        }
        break;
      }
      case 'stemGains':
        this.stemTarget = m.gains.slice();
        break;
      case 'drum': {
        // {gain?, roll?: {start (s), len (s)} | null, trans?: {len (s)} | null, brake?: {len (s)} | null}
        const d = this.drum;
        if (m.gain !== undefined) d.target = m.gain;
        if (m.roll !== undefined) d.roll = m.roll && { start: m.roll.start * this.stemRate, len: Math.max(64, m.roll.len * this.stemRate) };
        if (m.trans !== undefined) d.trans = m.trans && { len: Math.max(64, Math.round(m.trans.len * sampleRate)), n: 0, open: true };
        if (m.brake !== undefined) {
          d.brake = m.brake && { pos: (this.pos * this.stemRate) / this.srcRate, speed: 1, step: 1 / Math.max(64, m.brake.len * sampleRate) };
        }
        break;
      }
      case 'scratch':
        this.scratching = m.on;
        if (m.on) { this.scratchRate = this.playing ? this.rate : 0; this.scratchTarget = 0; this.resetGrains(); }
        break;
      case 'scratchRate': this.scratchTarget = m.rate; break;
      case 'play': this.playing = true; this.slipPos = this.pos; this.gain = 0; break;
      case 'pause': this.playing = false; break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.length - 1, this.toFrames(m.pos)));
        if (!this.slipActive) this.slipPos = this.pos;
        this.gain = 0;
        this.resetGrains();
        break;
      case 'rate': this.rate = m.rate; break;
      case 'bend': this.bend = m.bend; break;
      case 'keyLock': this.keyLock = m.on; this.resetGrains(); break;
      case 'keyShift': this.keyShift = m.semitones; this.resetGrains(); break;
      case 'slip':
        this.slip = m.on;
        if (!m.on && this.slipActive) this.endSlip();
        break;
      case 'reverse':
        if (m.on && this.slip) this.beginSlip();
        if (!m.on && this.slipActive && !this.loop) this.endSlip();
        this.reverse = m.on;
        break;
      case 'loop':
        if (m.loop) {
          if (this.slip && !this.slipActive) this.beginSlip();
          this.loop = { start: this.toFrames(m.loop.start), end: this.toFrames(m.loop.end) };
          if (m.jump) { this.pos = this.loop.start; this.gain = 0; }
        } else {
          this.loop = null;
          if (this.slipActive && !this.reverse) this.endSlip();
        }
        break;
      default: break;
    }
    this.report(true);
  }

  beginSlip() { this.slipActive = true; this.slipPos = this.pos; }
  endSlip() { this.slipActive = false; this.pos = this.slipPos; this.gain = 0; this.resetGrains(); }
  resetGrains() { this.grains[0] = { start: this.pos, n: 0 }; this.grains[1] = { start: this.pos, n: GRAIN / 2 }; }

  read(ch, x) {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= this.length) return 0;
    const f = x - i;
    const d = this.channels[ch];
    return d[i] + (d[i + 1] - d[i]) * f;
  }

  report(force = false) {
    if (!force && this.sinceReport < REPORT_EVERY) return;
    this.sinceReport = 0;
    this.port.postMessage({
      type: 'pos', pos: this.pos / this.srcRate, slipPos: this.slipPos / this.srcRate,
      slipActive: this.slipActive, playing: this.playing, scratching: this.scratching, t: currentTime, seq: this.seq,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (!this.channels || (!this.playing && !this.scratching)) {
      for (const c of out) c.fill(0);
      this.sinceReport += frames;
      this.report();
      return true;
    }
    const nch = this.channels.length;
    const ratio = this.srcRate / sampleRate;
    const dir = this.reverse ? -1 : 1;
    let speed = this.rate * this.bend * ratio * dir;
    const pitch = 2 ** (this.keyShift / 12);
    const stretch = (this.keyLock || this.keyShift !== 0) && !this.reverse && !this.scratching;
    if (this.scratching) {
      // Smooth the jog speed (a few ms) so discrete jog ticks don't crackle.
      this.scratchRate += (this.scratchTarget - this.scratchRate) * 0.08;
      speed = this.scratchRate * ratio;
    }
    // Grain read speed: with master tempo the pitch ignores the tempo; without it, tempo bends pitch.
    const grainSpeed = (this.keyLock ? 1 : this.rate * this.bend) * pitch * ratio;

    for (let i = 0; i < frames; i++) {
      if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / 128);
      this.rampStems();
      let l = 0;
      let r = 0;
      if (stretch) {
        for (const g of this.grains) {
          const w = this.window[g.n];
          const x = g.start + g.n * grainSpeed;
          const a = this.sample(0, x);
          l += a * w;
          r += (nch > 1 || this.stems ? this.sample(1, x) : a) * w;
          g.n++;
          if (g.n >= GRAIN) { g.n = 0; g.start = this.pos; }
        }
      } else {
        l = this.sample(0, this.pos);
        r = nch > 1 || this.stems ? this.sample(1, this.pos) : l;
      }
      out[0][i] = l * this.gain;
      if (out[1]) out[1][i] = r * this.gain;

      this.pos += speed;
      if (this.slipActive && this.playing) this.slipPos += this.rate * this.bend * ratio;
      if (this.loop && !this.scratching && dir > 0 && this.pos >= this.loop.end) this.pos -= this.loop.end - this.loop.start;
      if (this.loop && !this.scratching && dir < 0 && this.pos < this.loop.start) this.pos += this.loop.end - this.loop.start;
      if (this.scratching) {
        this.pos = Math.max(0, Math.min(this.length - 2, this.pos));
      } else if (this.pos >= this.length - 1 || this.pos < 0) {
        this.pos = Math.max(0, Math.min(this.length - 1, this.pos));
        this.playing = false;
        this.port.postMessage({ type: 'ended', seq: this.seq });
        for (let j = i + 1; j < frames; j++) { out[0][j] = 0; if (out[1]) out[1][j] = 0; }
        break;
      }
    }
    this.sinceReport += frames;
    this.report();
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
