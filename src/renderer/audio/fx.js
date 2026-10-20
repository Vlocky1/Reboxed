// Beat FX unit: beat-synced effects built from Web Audio nodes, inserted on a channel or master.
// Each insert point is {in, dry, out}: dry path in->dry->out always exists; an effect adds a wet
// path in->effect->out and may mute the dry path (insert-type effects such as FILTER or TRANS).

export const BEAT_FX = [
  { id: 'DELAY', kind: 'send', beats: 1 },
  { id: 'ECHO', kind: 'send', beats: 0.5 },
  { id: 'PING PONG', kind: 'send', beats: 0.5 },
  { id: 'REVERB', kind: 'send', beats: 1 },
  { id: 'FLANGER', kind: 'insert', beats: 16 },
  { id: 'PHASER', kind: 'insert', beats: 8 },
  { id: 'FILTER', kind: 'insert', beats: 4 },
  { id: 'TRANS', kind: 'insert', beats: 0.25 },
  { id: 'ROLL', kind: 'insert', beats: 0.5 },
  { id: 'REV ROLL', kind: 'insert', beats: 0.5 },
  { id: 'VINYL BRAKE', kind: 'insert', beats: 2 },
  { id: 'PITCH', kind: 'insert', beats: 1 },
  { id: 'UP ECHO', kind: 'send', beats: 0.5 },
  { id: 'DOWN ECHO', kind: 'send', beats: 0.5 },
  { id: 'PAN', kind: 'insert', beats: 1 },
  { id: 'ROBOT', kind: 'insert', beats: 1 },
  { id: 'LOW CUT ECHO', kind: 'send', beats: 0.5 },
  { id: 'SPIRAL', kind: 'send', beats: 0.5 },
  { id: 'HELIX', kind: 'insert', beats: 1 },
  { id: 'MOBIUS SAW', kind: 'insert', beats: 8 },
  { id: 'MOBIUS TRI', kind: 'insert', beats: 8 },
];

const fxNode = (ctx) => new AudioWorkletNode(ctx, 'fx-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
// Beat values the BEAT ◀ ▶ buttons step through (no 3/4: never useful in a mix).
export const FX_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
/** Next / previous beat value from `beats` (1 beat when it is not in the list). */
export const stepFxBeats = (beats, dir) => {
  const i = FX_BEATS.indexOf(beats);
  return FX_BEATS[Math.max(0, Math.min(FX_BEATS.length - 1, (i < 0 ? FX_BEATS.indexOf(1) : i) + dir))];
};
// PAD FX bank (16 slots, momentary): [effect, beats, depth].
export const PAD_FX = [
  ['ROLL', 1 / 4, 0.8], ['ROLL', 1 / 8, 0.8], ['ROLL', 1 / 16, 0.8], ['ECHO', 1 / 2, 0.6],
  ['TRANS', 1 / 4, 0.9], ['FILTER', 4, 0.8], ['REVERB', 1, 0.7], ['VINYL BRAKE', 2, 1],
  ['REV ROLL', 1 / 4, 0.8], ['PING PONG', 1 / 2, 0.6], ['FLANGER', 8, 0.7], ['PHASER', 4, 0.7],
  ['PITCH', 1, 0.8], ['DOWN ECHO', 1 / 2, 0.7], ['SPIRAL', 1 / 2, 0.7], ['HELIX', 1, 0.8],
];

function impulse(ctx, seconds = 2.8, decay = 3) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

/** Builds one effect graph. Returns {input, output, setBeat(sec), setDepth(0..1), dryLevel(depth), stop()}. */
// LEVEL/DEPTH response: rises faster than linear so the knob's middle already sounds, and the
// end of its travel is the full effect (as loud as the music or more, long feedback).
const curve = (d) => Math.max(0, Math.min(1, d)) ** 0.7;

function build(ctx, id) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodes = [];
  const lfoNodes = [];
  const lfo = (type = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    o.start();
    lfoNodes.push(o);
    return o;
  };
  const workletNodes = [];
  const wnode = () => { const n = fxNode(ctx); workletNodes.push(n); return n; };
  const fx = {
    input, output, setBeat() {}, setDepth() {}, dryLevel: () => 1,
    stop() { lfoNodes.forEach((o) => o.stop()); workletNodes.forEach((n) => n.port.postMessage({ kill: true })); },
  };

  switch (id) {
    case 'DELAY':
    case 'ECHO': {
      const delay = ctx.createDelay(8);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = id === 'ECHO' ? 'lowpass' : 'allpass';
      tone.frequency.value = 3500;
      input.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(output);
      nodes.push(delay, fb, tone);
      fx.setBeat = (s) => delay.delayTime.setTargetAtTime(Math.min(8, s), ctx.currentTime, 0.02);
      fx.setDepth = (d) => { fb.gain.value = id === 'ECHO' ? 0.35 + 0.5 * d : 0.35 * d; output.gain.value = 1.3 * curve(d); };
      break;
    }
    case 'PING PONG': {
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const dl = ctx.createDelay(8); const dr = ctx.createDelay(8);
      const fl = ctx.createGain(); const fr = ctx.createGain();
      const mono = ctx.createGain();
      input.connect(mono); mono.connect(dl);
      dl.connect(merge, 0, 0); dl.connect(fl); fl.connect(dr);
      dr.connect(merge, 0, 1); dr.connect(fr); fr.connect(dl);
      merge.connect(output);
      nodes.push(split, merge, dl, dr, fl, fr, mono);
      fx.setBeat = (s) => { dl.delayTime.value = Math.min(8, s); dr.delayTime.value = Math.min(8, s); };
      fx.setDepth = (d) => { fl.gain.value = fr.gain.value = 0.3 + 0.5 * d; output.gain.value = 1.3 * curve(d); };
      break;
    }
    case 'REVERB': {
      const conv = ctx.createConvolver();
      conv.buffer = impulse(ctx);
      const pre = ctx.createBiquadFilter();
      pre.type = 'highpass'; pre.frequency.value = 250;
      input.connect(pre); pre.connect(conv); conv.connect(output);
      nodes.push(conv, pre);
      fx.setDepth = (d) => { output.gain.value = 2 * curve(d); };
      fx.dryLevel = (d) => 1 - 0.45 * d; // a full reverb washes over the dry sound
      break;
    }
    case 'FLANGER': {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = 0.004;
      const depth = ctx.createGain(); depth.gain.value = 0.003;
      const fb = ctx.createGain(); fb.gain.value = 0.6;
      const o = lfo('triangle');
      o.connect(depth); depth.connect(delay.delayTime);
      input.connect(output); input.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(output);
      nodes.push(delay, depth, fb);
      fx.setBeat = (s) => { o.frequency.value = 1 / s; };
      fx.setDepth = (d) => { fb.gain.value = 0.35 + 0.6 * d; depth.gain.value = 0.001 + 0.006 * d; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'PHASER': {
      const stages = Array.from({ length: 6 }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.frequency.value = 800; f.Q.value = 0.7; return f; });
      const o = lfo('sine');
      const mod = ctx.createGain(); mod.gain.value = 600;
      o.connect(mod);
      stages.forEach((s) => mod.connect(s.frequency));
      input.connect(stages[0]);
      for (let i = 1; i < stages.length; i++) stages[i - 1].connect(stages[i]);
      const wet = ctx.createGain();
      stages.at(-1).connect(wet); wet.connect(output); input.connect(output);
      nodes.push(...stages, mod, wet);
      fx.setBeat = (s) => { o.frequency.value = 1 / s; };
      fx.setDepth = (d) => { wet.gain.value = 1.3 * curve(d); mod.gain.value = 200 + 1800 * d; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'FILTER': {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 2; f.frequency.value = 1000;
      const o = lfo('sine');
      const mod = ctx.createGain(); mod.gain.value = 800;
      o.connect(mod); mod.connect(f.frequency);
      const wet = ctx.createGain(); const dry = ctx.createGain();
      input.connect(f); f.connect(wet); wet.connect(output); input.connect(dry); dry.connect(output);
      nodes.push(f, mod, wet, dry);
      fx.setBeat = (s) => { o.frequency.value = 1 / s; };
      fx.setDepth = (d) => { wet.gain.value = 2 * curve(d); dry.gain.value = 1 - d; f.Q.value = 2 + 6 * d; mod.gain.value = 400 + 2600 * d; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'TRANS': {
      // Gate: gain alternates between 1 and (1 - depth) on a square LFO.
      const gate = ctx.createGain(); gate.gain.value = 0.5;
      const o = lfo('square');
      const amt = ctx.createGain(); amt.gain.value = 0.5;
      o.connect(amt); amt.connect(gate.gain);
      input.connect(gate); gate.connect(output);
      nodes.push(gate, amt);
      fx.setBeat = (s) => { o.frequency.value = 1 / (2 * s); };
      fx.setDepth = (d) => { gate.gain.value = 1 - d / 2; amt.gain.value = d / 2; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'ROLL':
    case 'REV ROLL':
    case 'VINYL BRAKE': {
      const node = wnode();
      const mode = { ROLL: 'roll', 'REV ROLL': 'revroll', 'VINYL BRAKE': 'brake' }[id];
      input.connect(node); node.connect(output);
      nodes.push(node);
      // The ring buffer records continuously while armed; the roll/brake starts on activation.
      fx.activate = () => node.port.postMessage({ mode });
      fx.deactivate = () => node.port.postMessage({ mode: 'off' });
      fx.setBeat = (s) => node.port.postMessage({ len: s });
      fx.setDepth = (d) => { output.gain.value = 0.5 + d * 0.5; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'PITCH': {
      const node = wnode();
      input.connect(node); node.connect(output);
      node.port.postMessage({ mode: 'pitch' });
      nodes.push(node);
      // LEVEL/DEPTH: centre = no change, left = down to -12, right = up to +12 semitones.
      fx.setDepth = (d) => node.port.postMessage({ semitones: Math.round((d - 0.5) * 24) });
      fx.dryLevel = () => 0;
      break;
    }
    case 'UP ECHO':
    case 'DOWN ECHO': {
      // Echo whose feedback path is pitch-shifted, so every repeat climbs (or falls) further.
      const delay = ctx.createDelay(8);
      const fb = ctx.createGain(); fb.gain.value = 0.6;
      const shifter = wnode();
      shifter.port.postMessage({ mode: 'pitch', semitones: id === 'UP ECHO' ? 2 : -2 });
      input.connect(delay); delay.connect(shifter); shifter.connect(fb); fb.connect(delay); delay.connect(output);
      nodes.push(delay, fb, shifter);
      fx.setBeat = (s) => delay.delayTime.setTargetAtTime(Math.min(8, s), ctx.currentTime, 0.02);
      fx.setDepth = (d) => { fb.gain.value = 0.4 + 0.5 * d; output.gain.value = 1.3 * curve(d); };
      break;
    }
    case 'PAN': {
      const pan = ctx.createStereoPanner();
      const o = lfo('sine');
      const depthG = ctx.createGain(); depthG.gain.value = 0.8;
      o.connect(depthG); depthG.connect(pan.pan);
      input.connect(pan); pan.connect(output);
      nodes.push(pan, depthG);
      fx.setBeat = (s) => { o.frequency.value = 1 / s; };
      fx.setDepth = (d) => { depthG.gain.value = d; };
      fx.dryLevel = () => 0;
      break;
    }
    case 'ROBOT': {
      // Short comb filter with strong feedback: metallic, pitched "robot" voice.
      const comb = ctx.createDelay(0.05); comb.delayTime.value = 0.008;
      const fb = ctx.createGain(); fb.gain.value = 0.8;
      const wet = ctx.createGain();
      input.connect(comb); comb.connect(fb); fb.connect(comb); comb.connect(wet); wet.connect(output);
      const dry = ctx.createGain(); input.connect(dry); dry.connect(output);
      nodes.push(comb, fb, wet, dry);
      fx.setDepth = (d) => { wet.gain.value = curve(d); dry.gain.value = 1 - d * 0.9; fb.gain.value = 0.6 + 0.35 * d; comb.delayTime.value = 0.004 + 0.01 * (1 - d); };
      fx.dryLevel = () => 0;
      break;
    }
    case 'LOW CUT ECHO': {
      // Echo whose repeats lose their low end (high-pass inside the feedback loop).
      const delay = ctx.createDelay(8);
      const fb = ctx.createGain(); fb.gain.value = 0.6;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400; hp.Q.value = 0.7;
      input.connect(delay); delay.connect(hp); hp.connect(fb); fb.connect(delay); hp.connect(output);
      nodes.push(delay, fb, hp);
      fx.setBeat = (s) => delay.delayTime.setTargetAtTime(Math.min(8, s), ctx.currentTime, 0.02);
      fx.setDepth = (d) => { hp.frequency.value = 150 + 1200 * d; fb.gain.value = 0.45 + 0.45 * d; output.gain.value = 0.4 + 0.9 * curve(d); };
      break;
    }
    case 'SPIRAL': {
      // Echo whose delay time keeps shrinking while it repeats: the repeats spiral upwards.
      const delay = ctx.createDelay(8);
      const fb = ctx.createGain(); fb.gain.value = 0.7;
      input.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(output);
      nodes.push(delay, fb);
      let beatSec = 0.5;
      const sweep = () => {
        const t = ctx.currentTime;
        delay.delayTime.cancelScheduledValues(t);
        delay.delayTime.setValueAtTime(Math.min(8, beatSec), t);
        delay.delayTime.linearRampToValueAtTime(Math.max(0.01, beatSec / 8), t + beatSec * 8);
      };
      fx.setBeat = (s) => { beatSec = s; sweep(); };
      fx.activate = sweep;
      fx.setDepth = (d) => { fb.gain.value = 0.5 + 0.45 * d; output.gain.value = 1.3 * curve(d); };
      break;
    }
    case 'HELIX': {
      // Freezes the current beat slice and keeps it circling (capture + endless feedback).
      const node = wnode();
      input.connect(node); node.connect(output);
      nodes.push(node);
      fx.activate = () => node.port.postMessage({ mode: 'roll' });
      fx.deactivate = () => node.port.postMessage({ mode: 'off' });
      fx.setBeat = (s) => node.port.postMessage({ len: s });
      fx.setDepth = (d) => { output.gain.value = 0.6 + 0.4 * d; };
      fx.dryLevel = () => 0.35;
      break;
    }
    case 'MOBIUS SAW':
    case 'MOBIUS TRI': {
      // "Endless" flanger: two delay taps swept by a saw/triangle LFO, half a cycle apart.
      const mk = (phaseDelay) => {
        const d = ctx.createDelay(0.05); d.delayTime.value = 0.005;
        const o = lfo(id === 'MOBIUS SAW' ? 'sawtooth' : 'triangle');
        const depth = ctx.createGain(); depth.gain.value = 0.004;
        o.connect(depth); depth.connect(d.delayTime);
        const g = ctx.createGain(); g.gain.value = 0.5;
        input.connect(d); d.connect(g); g.connect(output);
        nodes.push(d, depth, g);
        return { o, depth, phaseDelay };
      };
      const taps = [mk(0), mk(0.5)];
      input.connect(output);
      fx.setBeat = (s) => taps.forEach((t) => { t.o.frequency.value = 1 / s; });
      fx.setDepth = (d) => taps.forEach((t) => { t.depth.gain.value = 0.001 + 0.007 * d; });
      fx.dryLevel = () => 0;
      break;
    }
    default: input.connect(output);
  }
  return fx;
}

export class BeatFxUnit extends EventTarget {
  /**
   * @param {BaseAudioContext} ctx
   * @param {Record<string, {in: GainNode, dry: GainNode, out: GainNode}>} inserts by target id
   * @param {() => number} bpmOf function(targetId) -> BPM for beat sync
   */
  constructor(ctx, inserts, bpmOf) {
    super();
    this.ctx = ctx;
    this.inserts = inserts;
    this.bpmOf = bpmOf;
    this.effectId = 'ECHO';
    this.beats = 0.5;
    this.depth = 0.5;
    this.target = 'master';
    this.on = false;
    this.armed = null;   // {fx, inGate, outGate, ins, kind}
    this.arm();
  }

  emit() { this.dispatchEvent(new Event('change')); }

  get kind() { return BEAT_FX.find((f) => f.id === this.effectId)?.kind ?? 'send'; }

  /**
   * Build the current effect on the current target and keep it connected but silent:
   * ins.in -> inGate -> effect -> outGate -> ins.out. Capture effects (rolls) keep recording
   * while armed so REV ROLL has history to play the moment it is switched on.
   */
  arm() {
    const ctx = this.ctx;
    const ins = this.inserts[this.target];
    const fx = build(ctx, this.effectId);
    const inGate = ctx.createGain();
    const outGate = ctx.createGain();
    const kind = this.kind;
    inGate.gain.value = kind === 'insert' ? 1 : 0; // send effects only receive input while on
    outGate.gain.value = 0;
    ins.in.connect(inGate); inGate.connect(fx.input); fx.output.connect(outGate); outGate.connect(ins.out);
    this.armed = { fx, inGate, outGate, ins, kind };
  }

  disarm() {
    const a = this.armed;
    if (!a) return;
    this.armed = null;
    a.ins.dry.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
    a.outGate.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    a.inGate.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    // Let echo/reverb tails ring out before tearing the graph down.
    setTimeout(() => {
      try { a.ins.in.disconnect(a.inGate); } catch { /* already */ }
      a.outGate.disconnect();
      a.fx.stop();
    }, a.kind === 'send' && this.on ? 1500 : 50);
  }

  setEffect(id) {
    const wasOn = this.on;
    if (wasOn) this.setOn(false);
    this.disarm();
    this.effectId = id;
    this.beats = BEAT_FX.find((f) => f.id === id)?.beats ?? 1;
    this.arm();
    if (wasOn) this.setOn(true);
    this.emit();
  }

  setTarget(target) {
    const wasOn = this.on;
    if (wasOn) this.setOn(false);
    this.disarm();
    this.target = target;
    this.arm();
    if (wasOn) this.setOn(true);
    this.emit();
  }

  setBeats(beats) { this.beats = beats; this.refresh(); this.emit(); }
  setDepth(depth) { this.depth = depth; this.refresh(); this.emit(); }

  setOn(on) {
    if (on === this.on || !this.armed) return;
    const { fx, inGate, outGate, ins, kind } = this.armed;
    const t = this.ctx.currentTime;
    this.on = on;
    if (on) {
      this.refresh();
      fx.activate?.();
      inGate.gain.setTargetAtTime(1, t, 0.005);
      outGate.gain.setTargetAtTime(1, t, 0.005);
    } else {
      ins.dry.gain.setTargetAtTime(1, t, 0.01);
      if (kind === 'send') {
        // Stop feeding the echo but let its tail ring through the open output gate.
        inGate.gain.setTargetAtTime(0, t, 0.01);
      } else {
        outGate.gain.setTargetAtTime(0, t, 0.01);
        setTimeout(() => fx.deactivate?.(), 30);
      }
    }
    this.emit();
  }

  /** TAP: set the FX tempo by tapping (0 = AUTO, follow the target's BPM). */
  setTapBpm(bpm) { this.tapBpm = bpm; this.refresh(); this.emit(); }

  /**
   * RELEASE FX (momentary): the target's dry signal is cut and an echo tail of what was
   * playing rings out; releasing brings the dry signal back.
   */
  release(on) {
    const ins = this.inserts[this.target];
    const t = this.ctx.currentTime;
    if (on) {
      if (this.releaseFx) return;
      const r = build(this.ctx, 'ECHO');
      const inGate = this.ctx.createGain();
      ins.in.connect(inGate); inGate.connect(r.input); r.output.connect(ins.out);
      const bpm = this.tapBpm || this.bpmOf(this.target) || 120;
      r.setBeat((60 / bpm) * 0.5); r.setDepth(0.85);
      inGate.gain.setValueAtTime(1, t); inGate.gain.setTargetAtTime(0, t + (60 / bpm) * 0.5, 0.01);
      ins.dry.gain.setTargetAtTime(0, t, 0.005);
      this.releaseFx = { r, inGate, ins };
    } else if (this.releaseFx) {
      const { r, inGate, ins: i } = this.releaseFx;
      this.releaseFx = null;
      i.dry.gain.setTargetAtTime(this.on && this.armed ? this.armed.fx.dryLevel(this.depth) : 1, t, 0.01);
      r.output.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => { try { i.in.disconnect(inGate); } catch { /* gone */ } r.output.disconnect(); r.stop(); }, 400);
    }
    this.emit();
  }

  /** Re-apply beat length and depth, e.g. when the target's BPM changes. */
  refresh() {
    if (!this.armed) return;
    const { fx, ins } = this.armed;
    const bpm = this.tapBpm || this.bpmOf(this.target) || 120;
    fx.setBeat((60 / bpm) * this.beats);
    fx.setDepth(this.depth);
    if (this.on) ins.dry.gain.setTargetAtTime(fx.dryLevel(this.depth), this.ctx.currentTime, 0.01);
  }
}
