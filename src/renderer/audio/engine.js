// Audio graph: decks -> channel strips (trim, 3-band isolator, colour filter, fader, FX insert)
// -> crossfader -> master (FX insert, level, limiter, meters) -> output; cue bus -> headphones.
import { Deck } from './deck.js';
import { BeatFxUnit } from './fx.js';

const XOVER_LOW = 250;
const XOVER_HIGH = 2500;
const AUTO_GAIN_TARGET_DB = -14;

function lr4(ctx, type, freq) {
  // Linkwitz-Riley 4th order = two cascaded Butterworth 2nd-order sections.
  const a = ctx.createBiquadFilter(); a.type = type; a.frequency.value = freq; a.Q.value = Math.SQRT1_2;
  const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; b.Q.value = Math.SQRT1_2;
  a.connect(b);
  return { in: a, out: b };
}

/** dB knob value (-inf..+6) -> linear gain; values <= -40 are a full kill. */
export const dbToGain = (db) => (db <= -40 ? 0 : 10 ** (db / 20));

/** Fader curve: 0..1 position -> gain. */
export function faderGain(v, curve = 'linear') {
  if (v <= 0) return 0;
  if (curve === 'exp') return v ** 3;
  if (curve === 'log') return Math.sqrt(v);
  return v;
}

/** Crossfader position -1..1 -> [gainA, gainB] for a curve: 'smooth' | 'constant' | 'cut'. */
export function crossfaderGains(x, curve = 'smooth') {
  const t = (x + 1) / 2;
  if (curve === 'cut') {
    const lag = 0.04;
    return [t < 1 - lag ? 1 : 0, t > lag ? 1 : 0];
  }
  if (curve === 'constant') return [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)];
  return [Math.min(1, 2 * (1 - t)), Math.min(1, 2 * t)];
}

class ChannelStrip {
  /** @param {AudioNode} input deck node: output 0 = channel, output 1 = parts for FX PART SELECT */
  constructor(ctx, input) {
    this.ctx = ctx;
    this.trim = ctx.createGain();
    this.autoGain = ctx.createGain();
    input.connect(this.trim, 0);
    this.trim.connect(this.autoGain);

    const low = lr4(ctx, 'lowpass', XOVER_LOW);
    const midHp = lr4(ctx, 'highpass', XOVER_LOW);
    const midLp = lr4(ctx, 'lowpass', XOVER_HIGH);
    const high = lr4(ctx, 'highpass', XOVER_HIGH);
    this.gLow = ctx.createGain(); this.gMid = ctx.createGain(); this.gHigh = ctx.createGain();
    const sum = ctx.createGain();
    this.autoGain.connect(low.in); low.out.connect(this.gLow);
    this.autoGain.connect(midHp.in); midHp.out.connect(midLp.in); midLp.out.connect(this.gMid);
    this.autoGain.connect(high.in); high.out.connect(this.gHigh);
    [this.gLow, this.gMid, this.gHigh].forEach((g) => g.connect(sum));

    // Colour filter: left = low-pass, right = high-pass, centre = bypass.
    this.lpf = ctx.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.frequency.value = 22000; this.lpf.Q.value = 1;
    this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 10; this.hpf.Q.value = 1;
    sum.connect(this.lpf); this.lpf.connect(this.hpf);

    this.fader = ctx.createGain();
    this.hpf.connect(this.fader);
    // FX insert point (post fader). insert.in is what the Beat FX processes: the whole channel, or
    // with FX PART SELECT only the selected parts (twin chain) while the rest bypasses the FX.
    this.insert = { in: ctx.createGain(), dry: ctx.createGain(), out: ctx.createGain() };
    this.mainToFx = ctx.createGain();
    this.restBypass = ctx.createGain(); this.restBypass.gain.value = 0;
    this.fader.connect(this.mainToFx); this.mainToFx.connect(this.insert.in);
    this.fader.connect(this.restBypass); this.restBypass.connect(this.insert.out);
    this.insert.in.connect(this.insert.dry);
    this.insert.dry.connect(this.insert.out);

    this.xfade = ctx.createGain();
    this.insert.out.connect(this.xfade);
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0;
    this.hpf.connect(this.cueSend); // pre-fader listen
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.insert.out.connect(this.meter);

    this.state = { trim: 0, eq: { low: 0, mid: 0, high: 0 }, filter: 0, fader: 1, assign: 'thru', cue: false };
    this.twin = this.buildTwin(input);
    this.partMode = false;
    this.setFader(0.8);
  }

  /** Same trim / EQ / colour filter / fader for the FX PART SELECT signal (deck output 1). */
  buildTwin(input) {
    const ctx = this.ctx;
    const t = { trim: ctx.createGain(), autoGain: ctx.createGain(), gLow: ctx.createGain(), gMid: ctx.createGain(), gHigh: ctx.createGain() };
    input.connect(t.trim, 1);
    t.trim.connect(t.autoGain);
    const low = lr4(ctx, 'lowpass', XOVER_LOW);
    const midHp = lr4(ctx, 'highpass', XOVER_LOW);
    const midLp = lr4(ctx, 'lowpass', XOVER_HIGH);
    const high = lr4(ctx, 'highpass', XOVER_HIGH);
    const sum = ctx.createGain();
    t.autoGain.connect(low.in); low.out.connect(t.gLow);
    t.autoGain.connect(midHp.in); midHp.out.connect(midLp.in); midLp.out.connect(t.gMid);
    t.autoGain.connect(high.in); high.out.connect(t.gHigh);
    [t.gLow, t.gMid, t.gHigh].forEach((g) => g.connect(sum));
    t.lpf = ctx.createBiquadFilter(); t.lpf.type = 'lowpass'; t.lpf.frequency.value = 22000; t.lpf.Q.value = 1;
    t.hpf = ctx.createBiquadFilter(); t.hpf.type = 'highpass'; t.hpf.frequency.value = 10; t.hpf.Q.value = 1;
    sum.connect(t.lpf); t.lpf.connect(t.hpf);
    t.fader = ctx.createGain();
    t.hpf.connect(t.fader);
    t.hpf.connect(this.cueSend);
    t.fader.connect(this.insert.in);
    return t;
  }

  /**
   * FX PART SELECT on: the Beat FX and the Color FX get only the selected parts (twin chain), the
   * rest of the channel bypasses both.
   */
  setPartMode(on) {
    if (this.partMode === on) return;
    this.partMode = on;
    const now = this.ctx.currentTime;
    this.mainToFx.gain.setTargetAtTime(on ? 0 : 1, now, 0.005);
    this.restBypass.gain.setTargetAtTime(on ? 1 : 0, now, 0.005);
    if (this.cfx) { this.cfx.dispose(); this.cfx = null; } // rebuilt on the chain that now gets the effects
    this.setFilter(this.state.filter);
  }

  /** The chain the COLOR knob works on: the selected parts with FX PART SELECT, else the channel. */
  get colorChain() { return this.partMode && this.twin ? this.twin : this; }

  setAutoGainDb(db) {
    for (const c of [this, this.twin]) c.autoGain.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.05);
  }

  setTrim(db) {
    this.state.trim = db;
    for (const c of [this, this.twin]) c.trim.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.01);
  }
  setEq(band, db) {
    this.state.eq[band] = db;
    const key = { low: 'gLow', mid: 'gMid', high: 'gHigh' }[band];
    for (const c of [this, this.twin]) c[key].gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }
  /** COLOR knob (-1..1, 0 = off). What it does depends on the selected Color FX. */
  setFilter(v) {
    this.state.filter = v;
    const type = this.colorFx ?? 'FILTER';
    const t = this.ctx.currentTime;
    const dead = 0.04;
    const amt = Math.abs(v) > dead ? (Math.abs(v) - dead) / (1 - dead) : 0;
    // FILTER is also the tone shaping used by the other colour effects' wet paths.
    const filterOn = type === 'FILTER';
    const q = filterOn && amt > 0 ? 1 + amt * 4 : 0.7;
    for (const c of [this, this.twin]) {
      if (!c) continue;
      const on = filterOn && c === this.colorChain; // with FX PART SELECT only the selected parts are filtered
      if (on && v < -dead) c.lpf.frequency.setTargetAtTime(20000 * 2 ** (-amt * 10), t, 0.01);
      else c.lpf.frequency.setTargetAtTime(22000, t, 0.01);
      if (on && v > dead) c.hpf.frequency.setTargetAtTime(20 * 2 ** (amt * 9.5), t, 0.01);
      else c.hpf.frequency.setTargetAtTime(10, t, 0.01);
      c.lpf.Q.value = on ? q : 0.7; c.hpf.Q.value = on ? q : 0.7;
    }
    if (filterOn) { this.cfx?.set(0, 0); return; }
    this.ensureCfx(type).set(amt, Math.sign(v));
  }

  setColorFx(type) {
    if (this.cfx && this.cfx.type !== type) { this.cfx.dispose(); this.cfx = null; }
    this.colorFx = type;
    this.setFilter(this.state.filter);
  }

  /** Lazily build the colour-effect graph: a wet path from post-filter back into the fader (of colorChain). */
  ensureCfx(type) {
    if (this.cfx?.type === type) return this.cfx;
    const ctx = this.ctx;
    const chain = this.colorChain;
    const wet = ctx.createGain(); wet.gain.value = 0;
    const tone = ctx.createBiquadFilter();
    const nodes = [wet, tone];
    let set;
    switch (type) {
      case 'SPACE': {
        const conv = ctx.createConvolver();
        const len = Math.round(ctx.sampleRate * 3);
        const ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5; }
        conv.buffer = ir;
        chain.hpf.connect(conv); conv.connect(tone); tone.connect(wet); wet.connect(chain.fader);
        nodes.push(conv);
        set = (a, side) => { tone.type = side < 0 ? 'lowpass' : 'highpass'; tone.frequency.value = side < 0 ? 6000 - a * 5000 : 200 + a * 2500; wet.gain.setTargetAtTime(a * 1.4, ctx.currentTime, 0.02); };
        break;
      }
      case 'DUB ECHO': {
        const delay = ctx.createDelay(2); delay.delayTime.value = 0.375;
        const fb = ctx.createGain(); fb.gain.value = 0.62;
        chain.hpf.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(wet); wet.connect(chain.fader);
        tone.type = 'bandpass'; tone.Q.value = 0.8;
        nodes.push(delay, fb);
        set = (a, side) => { tone.frequency.value = side < 0 ? 900 - a * 600 : 900 + a * 2500; wet.gain.setTargetAtTime(a * 1.2, ctx.currentTime, 0.02); };
        break;
      }
      case 'NOISE': {
        const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.start();
        src.connect(tone); tone.connect(wet); wet.connect(chain.fader);
        tone.Q.value = 1.2;
        nodes.push(src);
        set = (a, side) => { tone.type = side < 0 ? 'lowpass' : 'highpass'; tone.frequency.value = side < 0 ? 200 + a * 4000 : 8000 - a * 6000; wet.gain.setTargetAtTime(a * 0.25, ctx.currentTime, 0.02); };
        break;
      }
      case 'CRUSH': {
        const shaper = ctx.createWaveShaper();
        const steps = (a) => { const n = 4096; const curve = new Float32Array(n); const lv = 2 ** Math.round(10 - a * 8); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.round(x * lv) / lv; } return curve; };
        chain.hpf.connect(shaper); shaper.connect(tone); tone.connect(wet); wet.connect(chain.fader);
        tone.type = 'allpass';
        nodes.push(shaper);
        let lastStep = -1;
        set = (a, side) => {
          const s = Math.round(a * 8);
          if (s !== lastStep) { shaper.curve = steps(a); lastStep = s; }
          tone.type = side < 0 ? 'lowpass' : 'highpass'; tone.frequency.value = side < 0 ? 18000 - a * 14000 : 30 + a * 1500;
          wet.gain.setTargetAtTime(a, ctx.currentTime, 0.02);
        };
        break;
      }
      default:
        set = () => {};
    }
    this.cfx = {
      type, set,
      dispose: () => {
        for (const n of nodes) { try { n.disconnect(); } catch { /* already */ } if (n.stop) try { n.stop(); } catch { /* not started */ } }
        try { chain.hpf.disconnect(); } catch { /* none */ }
        chain.hpf.connect(chain.fader); chain.hpf.connect(this.cueSend);
      },
    };
    return this.cfx;
  }
  setFader(v, curve) {
    this.state.fader = v;
    for (const c of [this, this.twin]) c?.fader.gain.setTargetAtTime(faderGain(v, curve), this.ctx.currentTime, 0.005);
  }
  setCue(on) { this.state.cue = on; this.cueSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.005); }
}

function peakLevel(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
  return m;
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.decks = [];
    this.channels = [];
    this.masterDeckIndex = null;
    this.crossfader = 0;
    this.crossfaderCurve = 'smooth';
    this.faderCurve = 'linear';
    this.autoGainOn = true;
    this.meterBuf = new Float32Array(512);
  }

  async init(deckCount = 2) {
    await this.ctx.audioWorklet.addModule(new URL('./deck-processor.js', import.meta.url));
    await this.ctx.audioWorklet.addModule(new URL('./fx-processor.js', import.meta.url));
    await this.ctx.audioWorklet.addModule(new URL('./recorder-processor.js', import.meta.url));
    const ctx = this.ctx;
    this.masterIn = ctx.createGain();
    this.masterInsert = { in: ctx.createGain(), dry: ctx.createGain(), out: ctx.createGain() };
    this.masterIn.connect(this.masterInsert.in);
    this.masterInsert.in.connect(this.masterInsert.dry);
    this.masterInsert.dry.connect(this.masterInsert.out);
    this.masterGain = ctx.createGain(); this.masterGain.gain.value = 0.8;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
    this.masterInsert.out.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.masterMeter = ctx.createAnalyser(); this.masterMeter.fftSize = 512;
    this.limiter.connect(this.masterMeter);

    // Headphones: cue bus mixed with master, sent to an <audio> element on another device.
    this.cueBus = ctx.createGain();
    this.cueMaster = ctx.createGain(); this.cueMaster.gain.value = 0;
    this.limiter.connect(this.cueMaster);
    this.phonesGain = ctx.createGain();
    this.cueBus.connect(this.phonesGain); this.cueMaster.connect(this.phonesGain);
    this.phonesDest = ctx.createMediaStreamDestination();
    this.phonesGain.connect(this.phonesDest);
    this.phonesEl = new Audio();
    this.phonesEl.srcObject = this.phonesDest.stream;

    for (let i = 0; i < deckCount; i++) {
      const node = new AudioWorkletNode(ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
      const strip = new ChannelStrip(ctx, node);
      strip.xfade.connect(this.masterIn);
      strip.cueSend.connect(this.cueBus);
      this.channels.push(strip);
      this.decks.push(new Deck({ index: i, node, engine: this }));
      this.setAssign(i, i % 2 === 0 ? 'A' : 'B'); // 1,3 -> A ; 2,4 -> B
    }
    // Sampler bus insert (so Beat FX can target the sampler like on the hardware).
    this.samplerIn = ctx.createGain();
    this.samplerInsert = { in: ctx.createGain(), dry: ctx.createGain(), out: ctx.createGain() };
    this.samplerIn.connect(this.samplerInsert.in);
    this.samplerInsert.in.connect(this.samplerInsert.dry);
    this.samplerInsert.dry.connect(this.samplerInsert.out);
    this.samplerInsert.out.connect(this.masterIn);
    const inserts = { master: this.masterInsert, sampler: this.samplerInsert };
    this.channels.forEach((c, i) => { inserts[`ch${i + 1}`] = c.insert; });
    this.fx = new BeatFxUnit(ctx, inserts, (target) => {
      if (target === 'master' || target === 'sampler') return this.masterDeck?.currentBpm || this.decks.find((d) => d.playing)?.currentBpm;
      return this.decks[Number(target.slice(2)) - 1]?.currentBpm;
    });
    this.setCrossfader(0);
  }

  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }

  // ---- master deck / sync --------------------------------------------------------------------

  get masterDeck() { return this.masterDeckIndex === null ? null : this.decks[this.masterDeckIndex]; }

  setMasterDeck(index) {
    this.masterDeckIndex = index;
    this.followMaster();
    this.dispatchEvent(new Event('master'));
  }

  /** Auto-assign master to the first deck that starts playing when none is master yet. */
  onDeckStarted(deck) {
    if (this.masterDeckIndex === null || !this.masterDeck?.playing) {
      if (!deck.sync || this.masterDeckIndex === null) this.setMasterDeck(deck.index);
    }
  }

  followMaster() {
    for (const d of this.decks) if (d.sync && d !== this.masterDeck) d.applySync(false);
    this.fx?.refresh();
  }

  tick() {
    for (const d of this.decks) { d.syncTick(); d.keySyncTick(); }
  }

  // ---- mixer ---------------------------------------------------------------------------------

  setAssign(i, assign) { this.channels[i].state.assign = assign; this.setCrossfader(this.crossfader); }

  setCrossfader(x) {
    this.crossfader = x;
    const [a, b] = crossfaderGains(x, this.crossfaderCurve);
    for (const ch of this.channels) {
      const g = ch.state.assign === 'A' ? a : ch.state.assign === 'B' ? b : 1;
      ch.xfade.gain.setTargetAtTime(g, this.ctx.currentTime, 0.003);
    }
  }

  setColorFx(type) { this.colorFx = type; this.channels.forEach((c) => c.setColorFx(type)); }

  setCrossfaderCurve(curve) { this.crossfaderCurve = curve; this.setCrossfader(this.crossfader); }
  setFaderCurve(curve) { this.faderCurve = curve; this.channels.forEach((c) => c.setFader(c.state.fader, curve)); }
  setFader(i, v) { this.channels[i].setFader(v, this.faderCurve); }
  setMasterLevel(v) { this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  setPhonesLevel(v) { this.phonesGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  /** 0 = cue only, 1 = master only. */
  setPhonesMix(v) { this.cueMaster.gain.value = v; this.cueBus.gain.value = 1 - v; }

  setAutoGain(i, loudness) {
    const ch = this.channels[i];
    const db = this.autoGainOn && Number.isFinite(loudness) ? Math.max(-12, Math.min(12, AUTO_GAIN_TARGET_DB - loudness)) : 0;
    ch.autoGainDb = db;
    ch.setAutoGainDb(db);
  }

  levels() {
    return {
      channels: this.channels.map((c) => peakLevel(c.meter, this.meterBuf)),
      master: peakLevel(this.masterMeter, this.meterBuf),
    };
  }

  // ---- controller audio interface (4 channels: master 1/2, headphones 3/4) -------------------

  /**
   * 'stereo': master on the output device, headphones on a second device (or off).
   * 'quad'  : one 4-channel device such as a DJ controller's sound card (DDJ-GRV6):
   *           master -> outputs 1/2, headphones (cue mix) -> outputs 3/4.
   */
  setOutputLayout(layout) {
    const ctx = this.ctx;
    const dest = ctx.destination;
    if (layout === 'quad') {
      if (dest.maxChannelCount < 4) throw new Error(`The output device has ${dest.maxChannelCount} channels (4 needed)`);
      if (this.quad) return;
      dest.channelCount = 4;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(4);
      const masterSplit = ctx.createChannelSplitter(2);
      const phonesSplit = ctx.createChannelSplitter(2);
      this.limiter.disconnect(dest);
      this.limiter.connect(masterSplit);
      masterSplit.connect(merger, 0, 0); masterSplit.connect(merger, 1, 1);
      this.phonesGain.connect(phonesSplit);
      phonesSplit.connect(merger, 0, 2); phonesSplit.connect(merger, 1, 3);
      merger.connect(dest);
      this.phonesEl.pause();
      this.quad = { merger, masterSplit, phonesSplit };
    } else if (this.quad) {
      const { merger, masterSplit, phonesSplit } = this.quad;
      this.limiter.disconnect(masterSplit);
      this.phonesGain.disconnect(phonesSplit);
      merger.disconnect();
      dest.channelCount = 2;
      dest.channelInterpretation = 'speakers';
      this.limiter.connect(dest);
      this.quad = null;
    }
  }

  // ---- preview (headphones only) ---------------------------------------------------------------

  /** Play a file in the headphones only (library PREVIEW). Returns the audio element. */
  preview(url, startFraction = 0.3) {
    if (!this.previewEl) {
      this.previewEl = new Audio();
      this.previewEl.crossOrigin = 'anonymous';
      const src = this.ctx.createMediaElementSource(this.previewEl);
      this.previewGain = this.ctx.createGain();
      src.connect(this.previewGain);
      this.previewGain.connect(this.cueBus);
    }
    const el = this.previewEl;
    this.resume();
    if (el.dataset.url === url && !el.paused) { el.pause(); return el; }
    el.dataset.url = url;
    el.src = url;
    el.onloadedmetadata = () => { el.currentTime = (el.duration || 0) * startFraction; el.play(); };
    return el;
  }

  previewSkip(sec = 10) { if (this.previewEl && !this.previewEl.paused) this.previewEl.currentTime += sec; }
  stopPreview() { this.previewEl?.pause(); }

  // ---- devices -------------------------------------------------------------------------------

  async outputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audiooutput');
  }

  async setMasterDevice(id) { if (this.ctx.setSinkId) await this.ctx.setSinkId(id || ''); }

  async setPhonesDevice(id) {
    if (!id) { this.phonesEl.pause(); return; }
    await this.phonesEl.setSinkId(id);
    await this.phonesEl.play();
  }

  /**
   * A copy of the master on a second device, e.g. the computer's own speakers while the master
   * goes to a controller's sound card. id: '' = off, 'default' = the system's default output.
   */
  async setMasterCopyDevice(id) {
    if (!id) { this.copyEl?.pause(); return; }
    if (!this.copyEl) {
      this.copyDest = this.ctx.createMediaStreamDestination();
      this.limiter.connect(this.copyDest);
      this.copyEl = new Audio();
      this.copyEl.srcObject = this.copyDest.stream;
    }
    await this.copyEl.setSinkId(id === 'default' ? '' : id);
    await this.copyEl.play();
  }

  // ---- recording -----------------------------------------------------------------------------

  /**
   * Record the master output as 16-bit WAV, streamed to disk by the main process.
   * @param {string} name file name without extension
   * @returns {Promise<string>} destination path
   */
  async startRecording(name) {
    const { id, path } = await window.rb.recStart(name);
    const node = new AudioWorkletNode(this.ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = this.ctx.createGain(); sink.gain.value = 0; // keeps the node pulled by the graph
    this.limiter.connect(node); node.connect(sink); sink.connect(this.ctx.destination);
    this.recorder = { id, path, node, sink, writes: [], peak: 0, done: null };
    node.port.onmessage = (e) => {
      if (e.data.pcm) {
        this.recorder.peak = Math.max(this.recorder.peak * 0.9, e.data.peak);
        this.recorder.writes.push(window.rb.recWrite(id, e.data.pcm));
      }
      if (e.data.done) this.recorder.done?.();
    };
    this.recordStarted = performance.now();
    return path;
  }

  /** @returns {Promise<{path: string, bytes: number}>} */
  async stopRecording() {
    const r = this.recorder;
    if (!r) return null;
    await new Promise((resolve) => { r.done = resolve; r.node.port.postMessage('stop'); });
    this.limiter.disconnect(r.node);
    r.node.disconnect(); r.sink.disconnect();
    this.recorder = null;
    await Promise.all(r.writes);
    return window.rb.recStop(r.id, this.ctx.sampleRate, 2);
  }

  get recording() { return !!this.recorder; }
}
