// Captures its stereo input as interleaved 16-bit PCM and posts ~250 ms chunks to the main thread.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.round(sampleRate / 4);
    this.buf = new Int16Array(this.frames * 2);
    this.n = 0;
    this.recording = true;
    this.peak = 0;
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true }); } };
  }

  flush() {
    if (this.n === 0) return;
    const chunk = this.buf.slice(0, this.n * 2);
    this.port.postMessage({ pcm: chunk, peak: this.peak }, [chunk.buffer]);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    if (!this.recording) return false;
    const input = inputs[0];
    const l = input[0];
    if (!l) return true;
    const r = input[1] ?? l;
    for (let i = 0; i < l.length; i++) {
      const a = Math.max(-1, Math.min(1, l[i]));
      const b = Math.max(-1, Math.min(1, r[i]));
      const p = Math.max(Math.abs(a), Math.abs(b));
      if (p > this.peak) this.peak = p;
      this.buf[this.n * 2] = a < 0 ? a * 0x8000 : a * 0x7fff;
      this.buf[this.n * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
      if (++this.n === this.frames) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
