// One deck: transport, cue logic (CDJ style), hot/memory cues, loops, beat jump, tempo,
// master tempo, key shift, slip, reverse and beat sync. Audio runs in deck-processor.js.

import { toBeatgrid } from '../../shared/beatgrid.js';
import { finePeaks } from '../../shared/dsp/waveform.js';
import { transposeKey } from '../../shared/keys.js';

/** Insert [a, b) into a sorted list of disjoint ranges, merging neighbours. */
export function mergeRange(ranges, [a, b]) {
  const out = [];
  let cur = [a, b];
  for (const r of ranges) {
    if (r[1] < cur[0]) out.push(r);
    else if (r[0] > cur[1]) { out.push(cur); cur = r; }
    else cur = [Math.min(cur[0], r[0]), Math.max(cur[1], r[1])];
  }
  out.push(cur);
  return out.sort((x, y) => x[0] - y[0]);
}

const STATE_COMMANDS = new Set(['play', 'pause', 'seek', 'load', 'unload', 'loop', 'reverse', 'slip', 'scratch']);

/**
 * DRUM RELEASE FX types, in the order SHIFT + RELEASE FX cycles through them: the drums leave with a
 * backspin, a vinyl brake, a roll dissolving into echoes, echoes, a closing filter, or a roll.
 */
export const RELEASE_FX = ['BACKSPIN', 'BRAKE', 'ROLL ECHO', 'ECHO', 'FILTER', 'ROLL'];

export const TEMPO_RANGES = [6, 10, 16, 100]; // 100 = WIDE
export const BEAT_LOOP_SIZES = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
export const BEAT_JUMP_SIZES = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128];
export const HOT_CUE_COUNT = 16; // A–P in two banks of 8
export const HOT_CUE_COLORS = ['#3fdc5a', '#3fdc5a', '#ffe23a', '#ff9a1f', '#ff4040', '#ff3fa0', '#a24dff', '#3d7dff',
  '#25e6d6', '#3fdc5a', '#ffe23a', '#ff9a1f', '#ff4040', '#ff3fa0', '#a24dff', '#3d7dff'];
const PLAYED_AFTER_SEC = 30;

export class Deck extends EventTarget {
  /**
   * @param {object} opts
   * @param {number} opts.index 0-based
   * @param {AudioWorkletNode} opts.node
   * @param {import('./engine.js').AudioEngine} opts.engine
   */
  constructor({ index, node, engine }) {
    super();
    this.index = index;
    this.node = node;
    this.engine = engine;
    this.track = null;
    this.analysis = null;  // {beatgrid, waveform, ...}
    this.duration = 0;
    this.loading = false;
    this.playing = false;
    this.cuePoint = 0;
    this.cueHeld = false;
    this.loop = null;      // {start, end, beats?}
    this.tempoRange = 10;
    this.tempoPct = 0;
    this.bend = 1;
    this.keyLock = false;
    this.keyShift = 0;
    this.quantize = true;
    this.slip = false;
    this.reverse = false;
    this.sync = false;
    this.keySync = false;
    this.beatJumpSize = 4;
    this.releaseFx = RELEASE_FX[0]; // DRUM RELEASE FX type
    this.fxParts = [false, false, false, false]; // FX PART SELECT [drums, bass, other, vocals]
    this.vinyl = true;       // jog top touch = scratch (VINYL mode), else pitch bend
    this.beatLoopSize = 4;
    this.lastReport = { pos: 0, t: 0, playing: false, slipPos: 0, slipActive: false };
    this.playedSec = 0;
    this.countedPlay = false;
    node.port.onmessage = (e) => this.onWorklet(e.data);
  }

  // ---- state helpers -------------------------------------------------------------------------

  emit(what) { this.dispatchEvent(new CustomEvent('change', { detail: what })); }
  /**
   * Commands that change position or play state carry a new sequence number; reports older
   * than the last such command are stale. Frequent parameter updates (tempo, bend, jog speed,
   * stem gains) keep the current number so they don't starve position reports.
   */
  post(msg, transfer) {
    if (STATE_COMMANDS.has(msg.type)) this.seq = (this.seq ?? 0) + 1;
    this.node.port.postMessage({ ...msg, seq: this.seq ?? 0 }, transfer ?? []);
  }

  get rate() { return 1 + this.tempoPct / 100; }
  get grid() { return this.analysis?.beatgrid ?? null; }
  /** Beatgrid instance (constant or dynamic), cached per stored grid object. */
  get bg() {
    const g = this.grid;
    if (!g?.bpm) return null;
    if (this._bgSrc !== g) { this._bgSrc = g; this._bg = toBeatgrid(g); }
    return this._bg;
  }
  /** Track tempo at the play head (varies along dynamic grids). */
  get originalBpm() { return this.bg ? this.bg.bpmAt(this.position()) : this.track?.bpm ?? 0; }
  get currentBpm() { return this.originalBpm * this.rate; }
  get period() { return this.bg ? this.bg.periodAt(this.position()) : this.track?.bpm ? 60 / this.track.bpm : 0; }
  get loaded() { return !!this.track && this.duration > 0; }

  onWorklet(m) {
    // A report produced before the worklet saw our latest command (play, seek...) would undo it.
    if (m.seq !== undefined && m.seq < (this.seq ?? 0)) return;
    if (m.type === 'pos') {
      const wasPlaying = this.lastReport.playing;
      if (this.lastReport.playing && m.playing) this.playedSec += m.t - this.lastReport.t;
      this.lastReport = m;
      if (!this.countedPlay && this.playedSec >= PLAYED_AFTER_SEC && this.track) {
        this.countedPlay = true;
        this.engine.onTrackPlayed?.(this);
      }
      if (wasPlaying !== m.playing) { this.playing = m.playing; this.emit('play'); }
    } else if (m.type === 'ended') {
      this.playing = false;
      this.emit('play');
    }
  }

  /** Interpolated play-head position in seconds. */
  position() {
    const r = this.lastReport;
    if (!r.playing || r.scratching) return r.pos;
    const dir = this.reverse ? -1 : 1;
    let p = r.pos + (this.engine.ctx.currentTime - r.t) * this.rate * this.bend * dir;
    if (this.loop && dir > 0 && p >= this.loop.end) p = this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
    return Math.max(0, Math.min(this.duration, p));
  }

  slipPosition() {
    const r = this.lastReport;
    if (!r.slipActive) return null;
    return r.slipPos + (r.playing ? (this.engine.ctx.currentTime - r.t) * this.rate * this.bend : 0);
  }

  // ---- beatgrid ------------------------------------------------------------------------------

  beatIndexAt(t) { return this.bg ? this.bg.indexAt(t) : 0; }
  beatTime(i) { return this.bg ? this.bg.timeOf(i) : 0; }
  snap(t, unit = 1) {
    if (!this.bg || !this.quantize) return t;
    return Math.max(0, this.bg.snap(t, unit));
  }
  floorBeat(t, unit = 1) { return this.bg ? this.bg.floor(t, unit) : t; }
  /** Beat phase in [0,1). */
  phase(t = this.position()) { return this.bg ? this.bg.phase(t) : 0; }

  // ---- loading -------------------------------------------------------------------------------

  /**
   * @param {object} track library track
   * @param {AudioBuffer} buffer decoded audio
   * @param {object} analysis stored analysis {beatgrid, waveform, key, loudness}
   */
  setLoaded(track, buffer, analysis) {
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
    this.fine = finePeaks(channels, buffer.sampleRate); // zoomed-in waveform (real wave shape)
    this.post({ type: 'load', channels, sampleRate: buffer.sampleRate }, channels.map((c) => c.buffer));
    this.track = track;
    this.analysis = analysis;
    this.duration = buffer.duration;
    this.loop = null;
    this.playing = false;
    this.playedSec = 0;
    this.countedPlay = false;
    this.stemsReady = false;
    this.stemsComplete = false;
    this.stemRanges = [];
    this.stemEnv = null;
    this.stemQuality = null;
    this.stemGains = [1, 1, 1, 1];
    this.vocals = [];
    if (this.fxParts.some(Boolean)) this.applyFxParts();
    this.lastReport = { pos: 0, t: this.engine.ctx.currentTime, playing: false, slipPos: 0, slipActive: false };
    if (this.sync) this.applySync(true);
    const firstMemory = (track.cues ?? []).filter((c) => c.kind === 'memory').sort((a, b) => a.start - b.start)[0];
    this.cuePoint = firstMemory?.start ?? (this.bg ? Math.max(0, this.bg.timeOf(Math.ceil(this.bg.indexAt(0) - 1e-6))) : 0);
    this.seek(this.cuePoint);
    this.engine.setAutoGain(this.index, analysis?.loudness);
    this.emit('load');
  }

  unload() {
    this.post({ type: 'unload' });
    this.track = null; this.analysis = null; this.duration = 0; this.loop = null; this.playing = false;
    this.stemsReady = false; this.stemsComplete = false; this.stemRanges = []; this.stemEnv = null; this.vocals = []; this.fine = null;
    if (this.fxParts.some(Boolean)) this.applyFxParts();
    this.emit('load');
  }

  /** Track metadata changed elsewhere (cues edited, beatgrid re-analysed). */
  updateTrack(track, analysis) {
    if (!this.track || track.id !== this.track.id) return;
    this.track = track;
    if (analysis) this.analysis = analysis;
    this.emit('cues');
  }

  // ---- transport -----------------------------------------------------------------------------

  play() {
    if (!this.loaded) return;
    this.engine.resume();
    if (this.sync) this.applySync(true);
    this.post({ type: 'play' });
    this.playing = true;
    this.lastReport = { ...this.lastReport, playing: true, t: this.engine.ctx.currentTime };
    this.engine.onDeckStarted?.(this);
    this.emit('play');
  }

  pause() {
    this.post({ type: 'pause' });
    this.playing = false;
    this.lastReport = { ...this.lastReport, pos: this.position(), playing: false };
    this.emit('play');
  }

  playPause() { if (this.playing) this.pause(); else this.play(); }

  seek(t) {
    const pos = Math.max(0, Math.min(this.duration, t));
    this.post({ type: 'seek', pos });
    this.lastReport = { ...this.lastReport, pos, t: this.engine.ctx.currentTime };
  }

  /** Seek keeping the current beat phase when quantize is on and the deck is playing. */
  jumpTo(target) {
    if (this.quantize && this.grid && this.playing) {
      const pos = this.position();
      const offset = pos - this.floorBeat(pos);
      this.seek(this.floorBeat(this.snap(target)) + offset);
    } else {
      this.seek(this.quantize ? this.snap(target) : target);
    }
  }

  /** CUE button pressed (CDJ behaviour). */
  cueDown() {
    if (!this.loaded) return;
    if (this.playing) { this.pause(); this.seek(this.cuePoint); this.emit('cue'); return; }
    const pos = this.position();
    if (Math.abs(pos - this.cuePoint) > 0.01) {
      this.cuePoint = this.snap(pos);
      this.seek(this.cuePoint);
      this.emit('cue');
    } else {
      this.cueHeld = true;
      this.play(); // preview while held
    }
  }

  cueUp() {
    if (!this.cueHeld) return;
    this.cueHeld = false;
    this.pause();
    this.seek(this.cuePoint);
  }

  // ---- hot cues & memory cues ----------------------------------------------------------------

  hotCue(slot) { return (this.track?.cues ?? []).find((c) => c.kind === 'hot' && c.slot === slot) ?? null; }

  hotCuePress(slot) {
    if (!this.loaded) return;
    const cue = this.hotCue(slot);
    if (!cue) {
      const start = this.loop ? this.loop.start : this.snap(this.position());
      const created = { kind: 'hot', slot, start, end: this.loop ? this.loop.end : undefined, name: '', color: HOT_CUE_COLORS[slot % HOT_CUE_COLORS.length] };
      this.setCues([...(this.track.cues ?? []), created]);
      return;
    }
    if (cue.end !== undefined) {
      this.setLoop({ start: cue.start, end: cue.end }, true);
    } else {
      // A point hot cue leaves the loop that plays (rekordbox), then jumps.
      if (this.loop) this.exitLoop();
      this.jumpTo(cue.start);
    }
    if (!this.playing) this.play();
  }

  deleteHotCue(slot) {
    if (!this.track) return;
    this.setCues((this.track.cues ?? []).filter((c) => !(c.kind === 'hot' && c.slot === slot)));
  }

  memoryCues() { return (this.track?.cues ?? []).filter((c) => c.kind === 'memory').sort((a, b) => a.start - b.start); }

  addMemoryCue() {
    if (!this.loaded) return;
    const start = this.loop ? this.loop.start : this.snap(this.position());
    if (this.memoryCues().some((c) => Math.abs(c.start - start) < 0.005)) return;
    this.setCues([...(this.track.cues ?? []), { kind: 'memory', start, end: this.loop?.end, name: '' }]);
  }

  deleteMemoryCueNear(t = this.position()) {
    const target = this.memoryCues().reduce((best, c) => (Math.abs(c.start - t) < Math.abs((best?.start ?? Infinity) - t) ? c : best), null);
    if (target) this.setCues(this.track.cues.filter((c) => c !== target));
  }

  /** MEMORY CUE pads: go to the n-th memory cue (in track order) and make it the cue point. */
  callMemorySlot(n) {
    const target = this.memoryCues()[n];
    if (!target) return;
    this.cuePoint = target.start;
    if (target.end !== undefined) this.setLoop({ start: target.start, end: target.end }, true);
    else if (this.playing) this.jumpTo(target.start);
    else this.seek(target.start);
    this.emit('cue');
  }

  deleteMemoryCue(n) {
    const target = this.memoryCues()[n];
    if (target) this.setCues(this.track.cues.filter((c) => c !== target));
  }

  /** Jump to the previous/next memory cue (CALL). */
  callMemoryCue(direction) {
    const pos = this.position();
    const cues = this.memoryCues();
    const target = direction > 0 ? cues.find((c) => c.start > pos + 0.05) : [...cues].reverse().find((c) => c.start < pos - 0.05);
    if (!target) return;
    this.cuePoint = target.start;
    if (target.end !== undefined) this.setLoop({ start: target.start, end: target.end }, true);
    else this.seek(target.start);
    this.emit('cue');
  }

  // ---- jog: vinyl scratch, pitch bend, search -------------------------------------------------

  /** Seconds of audio per jog tick: 720 ticks per turn at 33 1/3 RPM (1.8 s per turn). */
  static JOG_SEC_PER_TICK = 1.8 / 720;

  scratchStart() {
    if (!this.loaded) return;
    this.scratching = true;
    this.scratchTicks = 0;
    this.scratchLast = performance.now();
    if (this.slip && this.playing) this.post({ type: 'slip', on: true });
    this.post({ type: 'scratch', on: true });
    clearInterval(this.scratchTimer);
    // Convert accumulated jog ticks into a playback rate every 10 ms.
    this.scratchTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.max(1, now - this.scratchLast) / 1000;
      this.scratchLast = now;
      const rate = (this.scratchTicks * Deck.JOG_SEC_PER_TICK) / dt;
      this.scratchTicks = 0;
      this.post({ type: 'scratchRate', rate: Math.max(-8, Math.min(8, rate)) });
    }, 10);
  }

  scratchMove(ticks) { if (this.scratching) this.scratchTicks += ticks; }

  scratchEnd() {
    if (!this.scratching) return;
    this.scratching = false;
    clearInterval(this.scratchTimer);
    this.post({ type: 'scratch', on: false });
    this.lastReport = { ...this.lastReport, t: this.engine.ctx.currentTime, scratching: false };
  }

  /** Jog side (rim) while playing: temporary pitch bend; while paused: fine search. */
  jogBend(ticks) {
    if (!this.loaded) return;
    if (!this.playing) { this.seek(this.position() + ticks * Deck.JOG_SEC_PER_TICK); return; }
    this.manualBend = true;
    this.setBend(1 + Math.max(-0.5, Math.min(0.5, ticks * 0.02)));
    clearTimeout(this.bendTimer);
    this.bendTimer = setTimeout(() => { this.manualBend = false; this.setBend(1); }, 60);
  }

  /**
   * SHIFT + jog: fast search. The jog ticks add up to a distance the play head glides through
   * (a fraction of what is left every 16 ms), so the waveform scrolls fast but continuously
   * instead of jumping from tick to tick.
   */
  jogSearch(ticks) {
    if (!this.loaded) return;
    this.searchLeft = (this.searchLeft ?? 0) + ticks * Deck.SEARCH_SEC_PER_TICK;
    if (this.searchTimer) return;
    this.searchTimer = setInterval(() => {
      const left = this.searchLeft;
      const step = Math.abs(left) < 0.004 ? left : left * 0.35;
      this.searchLeft = left - step;
      this.seek(this.position() + step);
      if (Math.abs(this.searchLeft) < 1e-4 || !this.loaded) { clearInterval(this.searchTimer); this.searchTimer = null; this.searchLeft = 0; }
    }, 16);
  }

  /** Track seconds per jog tick in SHIFT + jog search (a turn ≈ 30 s of track, 16x the normal jog). */
  static SEARCH_SEC_PER_TICK = 0.04;

  jumpToStart() { if (this.loaded) { this.seek(0); this.emit('cue'); } }

  // ---- stems ---------------------------------------------------------------------------------

  /** Complete stems (cache). @param {Int16Array[]} pcm [drums, bass, other, vocals] stereo at `rate` */
  setStems(pcm, rate, vocals = [], { quality, env } = {}) {
    this.post({ type: 'stems', stems: pcm, rate }, pcm.map((a) => a.buffer));
    this.stemsReady = true;
    this.stemsComplete = true;
    if (this.fxParts.some(Boolean)) this.applyFxParts();
    this.stemQuality = quality ?? this.stemQuality;
    this.stemRanges = [[0, pcm[0].length / 2]];
    this.stemFrames = pcm[0].length / 2;
    this.stemGains = [1, 1, 1, 1];
    this.vocals = vocals;
    if (env) this.stemEnv = env;
    this.applyIso(); // PART ISOLATOR set before the stems were there
    this.emit('stems');
  }

  /** Start receiving stems progressively (separation running). */
  initStems(frames, rate, quality) {
    this.post({ type: 'stemsInit', frames, rate });
    this.stemsReady = false;
    this.stemsComplete = false;
    this.stemQuality = quality;
    this.stemFrames = frames;
    this.stemRanges = [];
    this.stemEnv = [0, 1, 2, 3].map(() => new Uint8Array(Math.ceil((frames / rate) * 150) + 1));
    this.stemEnvPps = 150;
    this.stemGains = [1, 1, 1, 1];
    this.emit('stems');
  }

  /** One finished block: [start, start+length) frames, with its envelope points. */
  patchStems(start, pcm, env, quality) {
    const length = pcm[0].length / 2;
    this.post({ type: 'stemsPatch', start, pcm }, pcm.map((a) => a.buffer));
    this.stemQuality = quality ?? this.stemQuality;
    this.stemRanges = mergeRange(this.stemRanges ?? [], [start, start + length]);
    if (this.stemEnv && env) {
      env.forEach((ev, s) => {
        const dst = this.stemEnv[s];
        for (let i = 0; i < ev.data.length && ev.start + i < dst.length; i++) if (ev.data[i] > dst[ev.start + i]) dst[ev.start + i] = ev.data[i];
      });
    }
    const wasReady = this.stemsReady;
    this.stemsReady = true;
    if (!wasReady && this.fxParts.some(Boolean)) this.applyFxParts();
    if (!wasReady) { this.applyIso(); this.emit('stems'); }
  }

  /** Fraction (0..1) of the track whose stems are available. */
  stemCoverage() {
    if (!this.stemFrames) return 0;
    return (this.stemRanges ?? []).reduce((a, [x, y]) => a + (y - x), 0) / this.stemFrames;
  }

  /** Are stems available at time t (seconds)? */
  stemsAt(t) {
    const f = t * 44100;
    return (this.stemRanges ?? []).some(([a, b]) => f >= a && f < b);
  }

  /** index in [drums, bass, other, vocals]; on = audible. */
  setStemOn(index, on) {
    if (!this.stemsReady) return;
    this.stemGains = this.stemGains.map((g, i) => (i === index ? (on ? 1 : 0) : g));
    this.post({ type: 'stemGains', gains: this.stemGains });
    this.emit('stems');
  }

  /** Continuous part level 0..1 (PART ISOLATOR knobs). */
  setStemLevel(index, level) {
    if (!this.stemsReady) return;
    this.stemGains = this.stemGains.map((g, i) => (i === index ? Math.max(0, Math.min(1, level)) : g));
    this.post({ type: 'stemGains', gains: this.stemGains });
    this.emit('stems');
  }

  // ---- Groove Circuit: processing of the drum part --------------------------------------------

  /** Drum part gain (0 = drums replaced, e.g. by DRUM SWAP). */
  setDrumGain(g) { this.post({ type: 'drum', gain: g }); }

  /**
   * DRUM ROLL: repeat `beats` of the drum part (null = off). The first roll captures the drum from
   * the current beat; with `keep` (another roll button still held) the same drum keeps rolling and
   * only the length changes.
   */
  drumRoll(beats, keep = false) {
    if (!beats) { this.rollStart = null; this.post({ type: 'drum', roll: null }); return; }
    if (!keep || this.rollStart == null) this.rollStart = this.bg ? this.floorBeat(this.position(), Math.min(1, beats)) : this.position();
    // Roll length is measured in track time (stem frames), so it is simply beats x beat length.
    this.post({ type: 'drum', roll: { start: this.rollStart, len: beats * (this.period || 0.5) } });
  }

  /** DRUM TRANS: gate the drum part every `beats` (null = off). */
  drumTrans(beats) {
    this.post({ type: 'drum', trans: beats ? { len: (beats * (this.period || 0.5)) / (this.rate || 1) } : null });
  }

  /**
   * DRUM RELEASE FX (held): the drum part leaves with an effect; off = drums back.
   * type: one of RELEASE_FX (BRAKE, BACKSPIN, ROLL, FILTER, ECHO).
   */
  drumRelease(on, type = this.releaseFx) {
    const beatTrack = this.period || 0.5;
    this.post({ type: 'drum', release: on ? { type, beat: beatTrack / (this.rate || 1), beatTrack } : null });
  }

  /** Next DRUM RELEASE FX type (SHIFT + DRUM RELEASE FX / RELEASE FX SELECT). */
  cycleReleaseFx() {
    this.releaseFx = RELEASE_FX[(RELEASE_FX.indexOf(this.releaseFx) + 1) % RELEASE_FX.length];
    this.emit('groove');
    return this.releaseFx;
  }

  /**
   * FX PART SELECT: which parts [drums, bass, other, vocals] go through the channel's Beat FX.
   * None selected = the whole channel (normal Beat FX).
   */
  setFxPart(index, on) {
    this.fxParts = this.fxParts.map((v, i) => (i === index ? on : v));
    this.applyFxParts();
  }

  applyFxParts() {
    const active = this.stemsReady && this.fxParts.some(Boolean);
    this.post({ type: 'fxParts', mask: active ? this.fxParts : [false, false, false, false] });
    this.engine.channels[this.index]?.setPartMode(active);
    this.emit('stems');
  }

  // ---- PART ISOLATOR: the EQ knobs control parts (HI vocal, MID inst + bass, LOW drums) ----------

  /** Parts under the HI / MID / LOW isolator knobs (indices into [drums, bass, other, vocals]). */
  static ISO_PARTS = [[3], [2, 1], [0]];

  /** PART ISOLATOR on / off. Off brings every part back to full level. */
  setPartIso(on) {
    this.partIso = on;
    this.isoKnobs ??= [0.5, 0.5, 0.5];
    if (on) this.applyIso();
    else if (this.stemsReady) { this.stemGains = [1, 1, 1, 1]; this.post({ type: 'stemGains', gains: this.stemGains }); }
    this.emit('iso');
  }

  /** A part isolator knob moved (band 0 = HI / vocal, 1 = MID / inst + bass, 2 = LOW / drums). */
  setIsoKnob(band, v01) {
    this.isoKnobs ??= [0.5, 0.5, 0.5];
    this.isoKnobs[band] = Math.max(0, Math.min(1, v01));
    if (!this.partIso) { this.setPartIso(true); return; }
    this.applyIso();
    this.emit('iso');
  }

  /** Part levels from the isolator knobs: left = cut, centre and right = full. */
  applyIso() {
    if (!this.partIso || !this.stemsReady) return;
    const gains = [1, 1, 1, 1];
    Deck.ISO_PARTS.forEach((parts, band) => parts.forEach((s) => { gains[s] = Math.min(1, (this.isoKnobs?.[band] ?? 0.5) * 2); }));
    this.stemGains = gains;
    this.post({ type: 'stemGains', gains });
    this.emit('stems');
  }

  /** Solo (ISO): only this stem plays; again = all back on. */
  soloStem(index) {
    if (!this.stemsReady) return;
    const solo = this.stemGains.every((g, i) => (i === index ? g === 1 : g === 0));
    this.stemGains = this.stemGains.map((_, i) => (solo || i === index ? 1 : 0));
    this.post({ type: 'stemGains', gains: this.stemGains });
    this.emit('stems');
  }

  // ---- mix points (Mix Point Link) -----------------------------------------------------------

  mixPoint(kind) { return (this.track?.cues ?? []).find((c) => c.kind === kind) ?? null; }

  /** Set the MIX IN / MIX OUT point (one each per track) at the quantized play head. */
  setMixPoint(kind) {
    if (!this.loaded) return;
    const start = this.snap(this.position());
    this.setCues([...(this.track.cues ?? []).filter((c) => c.kind !== kind), { kind, start, name: kind === 'mixin' ? 'MIX IN' : 'MIX OUT' }]);
  }

  setCues(cues) {
    this.track = { ...this.track, cues };
    this.engine.onCuesChanged?.(this.track.id, cues);
    this.emit('cues');
  }

  // ---- loops & beat jump ---------------------------------------------------------------------

  setLoop(loop, jump = false) {
    this.loop = loop;
    this.post({ type: 'loop', loop, jump });
    if (jump && loop) this.lastReport = { ...this.lastReport, pos: loop.start, t: this.engine.ctx.currentTime };
    this.emit('loop');
  }

  beatLoop(beats = this.beatLoopSize) {
    if (!this.loaded) return;
    if (this.loop?.beats === beats) { this.exitLoop(); return; }
    this.beatLoopSize = beats;
    const pos = this.position();
    const bg = this.bg;
    // Quantize: the loop starts on the closest beat line (or 1/n beat for short loops), which may
    // be just ahead of the play head, rather than always on the one already passed.
    const start = this.quantize && bg ? Math.max(0, bg.snap(pos, Math.min(1, beats))) : pos;
    const end = bg ? bg.timeOf(bg.indexAt(start) + beats) : start + beats * (this.period || 0.5); // 120 BPM fallback
    this.setLoop({ start, end, beats });
  }

  /**
   * A loop of `beats` from `start` (already quantized), e.g. where LOOP IN was first pressed before
   * a long press made it an auto beat loop. The play head may already be past its end: the loop
   * wraps it back, so the loop plays in time with the beat it was started on.
   */
  beatLoopFrom(start, beats = this.beatLoopSize) {
    if (!this.loaded) return;
    this.pendingLoopIn = undefined;
    this.beatLoopSize = beats;
    const bg = this.bg;
    const end = bg ? bg.timeOf(bg.indexAt(start) + beats) : start + beats * (this.period || 0.5);
    this.setLoop({ start, end, beats });
  }

  loopIn() { if (this.loaded) { this.pendingLoopIn = this.snap(this.position()); this.emit('loop'); } }

  loopOut() {
    if (!this.loaded) return;
    const start = this.pendingLoopIn ?? this.loop?.start;
    if (start === undefined) return;
    const end = this.snap(this.position());
    if (end - start < 0.01) return;
    this.pendingLoopIn = undefined;
    const beats = this.period ? Math.round(((end - start) / this.period) * 1000) / 1000 : undefined;
    this.setLoop({ start, end, beats });
  }

  exitLoop() {
    if (this.loop) { this.lastLoop = this.loop; this.setLoop(null); }
  }

  reloopExit() {
    if (this.loop) this.exitLoop();
    else if (this.lastLoop) this.setLoop(this.lastLoop, true);
  }

  resizeLoop(factor) {
    if (!this.loop) { this.beatLoopSize = Math.min(512, Math.max(1 / 64, this.beatLoopSize * factor)); this.emit('loop'); return; }
    const len = (this.loop.end - this.loop.start) * factor;
    if (len < 0.005 || len > this.duration) return;
    const beats = this.loop.beats ? this.loop.beats * factor : undefined;
    if (beats) this.beatLoopSize = beats;
    this.setLoop({ start: this.loop.start, end: this.loop.start + len, beats });
  }

  /**
   * Choose the beat loop size. A loop that is playing takes the new size at once (from its start,
   * like a CDJ); otherwise it is the size of the next AUTO BEAT LOOP.
   */
  setBeatLoopSize(beats) {
    beats = Math.min(512, Math.max(1 / 64, beats));
    if (this.loop && this.period) {
      const len = beats * this.period;
      if (len >= 0.005 && this.loop.start + len <= this.duration + 1e-6) {
        this.beatLoopSize = beats;
        this.setLoop({ start: this.loop.start, end: this.loop.start + len, beats });
        return;
      }
    }
    this.beatLoopSize = beats;
    this.emit('loop');
  }

  /** Current loop length in beats (manual IN/OUT loops too), else the chosen size. */
  currentLoopBeats() {
    if (this.loop?.beats) return this.loop.beats;
    if (this.loop && this.period) return (this.loop.end - this.loop.start) / this.period;
    return this.beatLoopSize;
  }

  /**
   * Jump by `beats` beat lines of the grid (exact on dynamic grids too): the play head lands at the
   * same place inside the beat, `beats` lines further; a loop moves along by the same beats.
   */
  beatJump(beats) {
    if (!this.loaded) return;
    const bg = this.bg;
    const pos = this.position();
    const along = (t) => (bg ? bg.timeOf(bg.indexAt(t) + beats) : t + beats * (this.period || 0.5));
    if (this.loop) this.setLoop({ ...this.loop, start: along(this.loop.start), end: along(this.loop.end) });
    this.seek(along(pos));
  }

  // ---- slicer & censor (hold actions that return via slip) -------------------------------------

  /** Temporarily force slip on for a hold action; remembers whether to turn it off again. */
  holdSlip() { if (!this.slip) { this.toggleSlip(); this.tempSlip = true; } }
  releaseSlip() { if (this.tempSlip) { this.tempSlip = false; this.toggleSlip(); } }

  /** Slicer: the current 8-beat domain is cut into 8 slices; holding pad i loops slice i. */
  slicerDown(i) {
    if (!this.loaded || !this.grid || !this.playing) return;
    const pos = this.slipPosition() ?? this.position();
    // Domain = the 2 bars (8 beats) containing the play head, aligned to the bar grid.
    const bg = this.bg;
    const first = bg.indexAt(bg.floorBar(pos, 2));
    this.holdSlip();
    this.slicing = (this.slicing ?? 0) + 1;
    this.setLoop({ start: bg.timeOf(first + i), end: bg.timeOf(first + i + 1), beats: 1, slice: i }, true);
  }

  slicerUp() {
    if (!this.slicing) return;
    this.slicing -= 1;
    if (this.slicing > 0) return; // another slice pad still held
    this.exitLoop();
    this.releaseSlip();
  }

  /** Current slicer domain (start time) for the UI, or null. */
  slicerDomain() {
    if (!this.bg) return null;
    return this.bg.floorBar(this.slipPosition() ?? this.position(), 2);
  }

  censorDown() { if (!this.loaded) return; this.holdSlip(); this.setReverse(true); }
  censorUp() { if (!this.reverse) return; this.setReverse(false); this.releaseSlip(); }

  // ---- tempo, key, modes ---------------------------------------------------------------------

  setTempoPct(pct, fromSync = false) {
    this.tempoPct = Math.max(-this.tempoRange, Math.min(this.tempoRange, pct));
    this.post({ type: 'rate', rate: this.rate });
    if (!fromSync && this.engine.masterDeck === this) this.engine.followMaster();
    this.emit('tempo');
  }

  /**
   * The DJ moved this deck's tempo fader. A synced deck that is not the master would be pulled
   * back to the master's tempo at once, so (like rekordbox) the shared tempo moves instead: the
   * master takes the matching BPM and every synced deck follows.
   */
  userTempo(pct) {
    const master = this.engine.masterDeck;
    if (!this.sync || !master || master === this || !master.loaded || !master.originalBpm || !this.originalBpm) { this.setTempoPct(pct); return; }
    let target = this.originalBpm * (1 + Math.max(-this.tempoRange, Math.min(this.tempoRange, pct)) / 100);
    const ratio = target / master.originalBpm;
    if (this.engine.syncDoubleHalf !== false) { if (ratio > 1.5) target /= 2; else if (ratio < 0.67) target *= 2; }
    const masterPct = (target / master.originalBpm - 1) * 100;
    if (Math.abs(masterPct) > master.tempoRange) master.tempoRange = TEMPO_RANGES.find((r) => r >= Math.abs(masterPct)) ?? 100;
    master.setTempoPct(masterPct);
  }

  setTempoRange(range) {
    this.tempoRange = range;
    this.setTempoPct(this.tempoPct);
  }

  setBend(factor) { this.bend = factor; this.post({ type: 'bend', bend: factor }); }

  toggleKeyLock() { this.keyLock = !this.keyLock; this.post({ type: 'keyLock', on: this.keyLock }); this.emit('mode'); }

  /** fromSync: set by KEY SYNC; a manual change turns KEY SYNC off, like rekordbox. */
  setKeyShift(semitones, fromSync = false) {
    if (!fromSync && this.keySync) this.keySync = false;
    this.keyShift = Math.max(-12, Math.min(12, semitones));
    this.post({ type: 'keyShift', semitones: this.keyShift });
    this.emit('mode');
  }

  /** Track key (Camelot) before key shift. */
  get key() { return this.analysis?.key || this.track?.key || ''; }

  /** Deck whose key KEY SYNC follows: the master, else another playing / loaded deck. */
  keyReference() {
    const others = this.engine.decks.filter((x) => x !== this && x.loaded && x.key);
    const master = this.engine.masterDeck;
    return others.includes(master) ? master : others.find((x) => x.playing) ?? others[0] ?? null;
  }

  /** Smallest shift (−6..+6) that puts this deck in the reference's key or its relative, or null. */
  keySyncShift() {
    const ref = this.keyReference();
    if (!ref || !this.key) return null;
    const theirs = transposeKey(ref.key, ref.keyShift);
    let best = null;
    for (let s = -6; s <= 6; s++) {
      const mine = transposeKey(this.key, s);
      const match = mine === theirs || mine.slice(0, -1) === theirs.slice(0, -1);
      if (match && (best === null || Math.abs(s) < Math.abs(best))) best = s;
    }
    return best;
  }

  toggleKeySync() {
    this.keySync = !this.keySync;
    this.keySyncSig = null;
    if (this.keySync) this.keySyncTick();
    this.emit('mode');
  }

  /** Every frame while KEY SYNC is on: follow the reference when its key or this track changes. */
  keySyncTick() {
    if (!this.keySync) return;
    const ref = this.keyReference();
    const sig = `${this.key}|${ref?.index}|${ref?.key}|${ref?.keyShift}`;
    if (sig === this.keySyncSig) return;
    this.keySyncSig = sig;
    const s = this.keySyncShift();
    if (s !== null && s !== this.keyShift) this.setKeyShift(s, true);
  }

  toggleQuantize() { this.quantize = !this.quantize; this.emit('mode'); }
  toggleSlip() { this.slip = !this.slip; this.post({ type: 'slip', on: this.slip }); this.emit('mode'); }

  setReverse(on) {
    if (this.reverse === on) return;
    this.lastReport = { ...this.lastReport, pos: this.position(), t: this.engine.ctx.currentTime };
    this.reverse = on;
    this.post({ type: 'reverse', on });
    this.emit('mode');
  }

  toggleSync() {
    this.sync = !this.sync;
    if (this.sync) this.applySync(true);
    else this.setBend(1);
    this.emit('mode');
  }

  /** Match the master deck's BPM (allowing double/half) and, if `align`, its beat phase. */
  /** Tempo fader % that matches the master's current BPM (allowing double/half), or null. */
  syncTargetPct() {
    const master = this.engine.masterDeck;
    if (!master || master === this || !master.loaded || !this.originalBpm || !master.currentBpm) return null;
    let target = master.currentBpm;
    const ratio = target / this.originalBpm;
    if (this.engine.syncDoubleHalf !== false) { if (ratio > 1.5) target /= 2; else if (ratio < 0.67) target *= 2; }
    return (target / this.originalBpm - 1) * 100;
  }

  applySync(align) {
    const master = this.engine.masterDeck;
    const pct = this.syncTargetPct();
    if (pct === null) return;
    if (this.engine.syncMode === 'bpm') align = false; // BPM SYNC: tempo only, phase left to the DJ
    if (Math.abs(pct) > this.tempoRange) this.tempoRange = TEMPO_RANGES.find((r) => r >= Math.abs(pct)) ?? 100;
    this.setTempoPct(pct, true);
    if (align && this.grid && master.grid) {
      let d = master.phase() - this.phase();
      if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      if (Math.abs(d) > 0.002) this.seek(this.position() + d * this.period);
    }
  }

  /** Called every animation frame: gentle phase correction while synced and playing. */
  syncTick() {
    if (!this.sync || !this.playing || this.manualBend) return;
    // Follow tempo changes (dynamic grids, master tempo moves) in both sync modes.
    const want = this.syncTargetPct();
    if (want !== null && Math.abs(want - this.tempoPct) > 0.02 && Math.abs(want) <= this.tempoRange) this.setTempoPct(want, true);
    if (this.engine.syncMode === 'bpm') return;
    const master = this.engine.masterDeck;
    if (!master || master === this || !master.playing || !this.grid || !master.grid) { if (this.bend !== 1) this.setBend(1); return; }
    let d = master.phase() - this.phase();
    if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
    const errSec = d * this.period;
    if (Math.abs(errSec) > 0.25) { this.applySync(true); return; }
    const bend = Math.abs(errSec) < 0.002 ? 1 : 1 + Math.max(-0.03, Math.min(0.03, errSec * 2));
    if (Math.abs(bend - this.bend) > 0.0005) this.setBend(bend);
  }

  /** Pitch bend from keyboard/jog (hold). */
  nudge(direction) {
    this.manualBend = direction !== 0;
    this.setBend(direction === 0 ? 1 : 1 + direction * 0.04);
  }
}
