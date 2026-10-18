// Capture-based effects on a ring buffer of the live input:
//  - roll:    records `len` seconds from activation, then repeats that slice
//  - revroll: repeats the `len` seconds before activation, backwards
//  - brake:   vinyl brake — playback of the input slows to a stop over `len` seconds
//  - pitch:   two-tap delay-line pitch shifter (`semitones`), latency ~ one window
//  - off:     pass-through

const RING_SEC = 12;
const WINDOW = 2048;

class FxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(RING_SEC * sampleRate);
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;           // write index (absolute, monotonically increasing)
    this.mode = 'off';
    this.len = 0.5;
    this.semitones = 0;
    this.phase = 0;       // pitch-shifter tap phase 0..1
    this.port.onmessage = (e) => this.set(e.data);
  }

  set(m) {
    if (m.kill) { this.dead = true; return; }
    if (m.len !== undefined) this.len = Math.max(0.01, Math.min(RING_SEC / 2, m.len));
    if (m.semitones !== undefined) this.semitones = m.semitones;
    if (m.mode !== undefined && m.mode !== this.mode) {
      this.mode = m.mode;
      this.start = this.w;          // activation point
      this.read = this.w;           // brake read head
      this.speed = 1;
      this.t = 0;                   // samples since activation
    }
  }

  at(ch, abs) {
    const i = Math.floor(abs);
    const f = abs - i;
    const r = this.ring[ch];
    const a = r[((i % this.size) + this.size) % this.size];
    const b = r[(((i + 1) % this.size) + this.size) % this.size];
    return a + (b - a) * f;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const n = out[0].length;
    const lenS = this.len * sampleRate;
    const ratio = 2 ** (this.semitones / 12);
    for (let i = 0; i < n; i++) {
      const l = input[0]?.[i] ?? 0;
      const r = input[1]?.[i] ?? l;
      const wi = this.w % this.size;
      this.ring[0][wi] = l;
      this.ring[1][wi] = r;
      let ol = l; let or = r;
      switch (this.mode) {
        case 'roll': {
          if (this.t >= lenS) {
            const pos = this.start + ((this.t - lenS) % lenS);
            ol = this.at(0, pos); or = this.at(1, pos);
          }
          break;
        }
        case 'revroll': {
          if (this.start >= lenS) {
            // Normal case: play the slice before activation backwards.
            const pos = this.start - 1 - (this.t % lenS);
            ol = this.at(0, pos); or = this.at(1, pos);
          } else if (this.t >= lenS) {
            // Armed too recently to have history: record the slice first, then reverse it.
            const pos = this.start + lenS - 1 - ((this.t - lenS) % lenS);
            ol = this.at(0, pos); or = this.at(1, pos);
          }
          break;
        }
        case 'brake': {
          this.speed = Math.max(0, 1 - this.t / lenS);
          ol = this.at(0, this.read) * this.speed; or = this.at(1, this.read) * this.speed;
          this.read += this.speed;
          break;
        }
        case 'pitch': {
          // Two taps whose delay sweeps across the window; Hann crossfade hides the jumps.
          this.phase = (this.phase + (1 - ratio) / WINDOW + 1) % 1;
          let sl = 0; let sr = 0;
          for (const off of [0, 0.5]) {
            const p = (this.phase + off) % 1;
            const g = Math.sin(Math.PI * p) ** 2;
            const pos = this.w - 1 - p * WINDOW;
            sl += this.at(0, pos) * g; sr += this.at(1, pos) * g;
          }
          ol = sl; or = sr;
          break;
        }
        default: break;
      }
      out[0][i] = ol;
      if (out[1]) out[1][i] = or;
      this.w++;
      this.t++;
    }
    return !this.dead; // false lets the node be garbage-collected once disconnected
  }
}

registerProcessor('fx-processor', FxProcessor);
