// Pad surface: what the 8x8 grid does in each mode (SAMPLER pads, INSTRUMENT keyboard, SHOW lights)
// and what it lights. The on-screen grid and a Launchpad X share it; LaunchpadDriver turns its
// frames into RGB SysEx (only the LEDs that changed) and its buttons into surface calls.
//
// Launchpad X buttons (Programmer mode):
//   ▲ ▼        SAMPLER: previous / next kit · INSTRUMENT: octave up / down
//   ◀ ▶        SAMPLER: quantize (off / beat / bar) · stop all · INSTRUMENT: transpose −1 / +1
//   Session    SAMPLER mode     Note   INSTRUMENT mode     Custom   SHOW mode (lights over the grid)
//   Capture    capture the loop of the master deck into the first empty pad
//   right column: SAMPLER stop the row · INSTRUMENT pick the sound · SHOW pick the background
import { LightShow, scale } from '../../shared/lightshow.js';
import { instrumentNote, noteRole, LIGHT_IDLE, idx } from '../../shared/padkit.js';
import { INSTRUMENTS } from '../../shared/padsynth.js';
import { parseKey } from '../../shared/keys.js';
import { lpxMode, lpxRgb, lpxDecode, lpxBrightness, padNote, sideCc, topCc, LOGO } from '../../shared/launchpad.js';

export const SURFACE_MODES = ['sampler', 'instrument', 'show'];
const INSTRUMENT_IDS = Object.keys(INSTRUMENTS);
const IDLE_IDS = Object.keys(LIGHT_IDLE);
const QUANTIZE = ['off', 'beat', 'bar'];

export class PadSurface extends EventTarget {
  /**
   * @param {object} app
   * @param {import('../audio/pad-sampler.js').PadSampler} pads
   */
  constructor(app, pads) {
    super();
    this.app = app;
    this.pads = pads;
    this.mode = 'sampler';
    this.lights = new LightShow();
    this.heldNotes = new Map(); // cell -> note (instrument mode)
    this.octaveShift = 0;
    this.transpose = 0;
    this.selected = null; // pad being edited on screen
  }

  emit(detail) { this.dispatchEvent(new CustomEvent('change', { detail })); }

  get kit() { return this.pads.kit; }
  now() { return performance.now() / 1000; }

  setMode(m) {
    if (!SURFACE_MODES.includes(m) || m === this.mode) return;
    for (const [cell] of this.heldNotes) this.release(cell);
    this.mode = m;
    this.emit({ mode: m });
  }

  /** Key of the instrument: the kit's, or the master track's when "follow key" is on. */
  instrumentKey() {
    const ins = this.kit.instrument;
    let root = ins.root; let scaleName = ins.scale;
    if (ins.followKey) {
      const d = this.app.engine.masterDeck?.loaded ? this.app.engine.masterDeck : this.app.engine.decks.find((x) => x.playing);
      const k = d?.loaded ? parseKey(d.track?.key) : null;
      if (k) {
        root = (k.tonic + Math.round(d.keyShift ?? 0) + 120) % 12;
        if (scaleName === 'major' || scaleName === 'minor') scaleName = k.mode;
      }
    }
    const octave = (ins.octave ?? INSTRUMENTS[ins.sound?.synth]?.octave ?? 3) + this.octaveShift;
    return { root: (root + this.transpose + 120) % 12, scale: scaleName, octave, layout: ins.layout };
  }

  noteAt(x, y) { return instrumentNote(x, y, this.instrumentKey()); }

  /** Effect length in seconds: beats at the master tempo. */
  fxDur(beats) {
    const bpm = this.pads.masterBeat()?.bpm ?? 0;
    return bpm > 0 ? (beats || 0.5) * 60 / bpm : Math.max(0.3, (beats || 0.5) * 0.5);
  }

  /** A grid pad pressed (velocity > 0) or released (0). */
  press(x, y, velocity) {
    const i = idx(x, y);
    const t = this.now();
    if (this.mode === 'instrument') {
      if (velocity > 0) {
        const note = this.noteAt(x, y);
        this.heldNotes.set(i, note);
        this.pads.noteOn(note, velocity);
        const color = INSTRUMENTS[this.kit.instrument.sound?.synth]?.color ?? [127, 127, 127];
        this.lights.trigger('ripple', x, y, color, t, this.fxDur(0.5));
      } else this.release(i);
      this.emit({ cell: i });
      return;
    }
    const pad = this.kit.pads[i];
    if (velocity > 0) {
      this.pads.press(i, velocity);
      if (pad) this.lights.trigger(pad.light?.fx ?? 'flash', x, y, pad.light?.color ?? pad.color, t, this.fxDur(pad.light?.beats));
      else if (this.mode === 'show') this.lights.trigger('ripple', x, y, scale([127, 127, 127], velocity / 127), t, this.fxDur(1));
    } else this.pads.press(i, 0);
    this.emit({ cell: i });
  }

  release(cell) {
    const note = this.heldNotes.get(cell);
    if (note === undefined) return;
    this.heldNotes.delete(cell);
    if (![...this.heldNotes.values()].includes(note)) this.pads.noteOff(note);
  }

  /** Right-column button y (0 = top). */
  side(y) {
    if (this.mode === 'sampler') this.pads.stopRow(y);
    else if (this.mode === 'instrument') { this.kit.instrument.sound = { synth: INSTRUMENT_IDS[y] }; this.pads.emit({ edit: true }); }
    else if (IDLE_IDS[y]) { this.kit.lights.idle = IDLE_IDS[y]; this.pads.emit({ edit: true }); }
    this.emit({ side: y });
  }

  /** Top-row button x (0..7). */
  top(x) {
    const ins = this.mode === 'instrument';
    const n = this.pads.kits.length;
    switch (x) {
      case 0: if (ins) this.octaveShift = Math.min(3, this.octaveShift + 1); else this.pads.selectKit((this.pads.kitIndex - 1 + n) % n); break;
      case 1: if (ins) this.octaveShift = Math.max(-3, this.octaveShift - 1); else this.pads.selectKit((this.pads.kitIndex + 1) % n); break;
      case 2: if (ins) this.transpose -= 1; else { this.kit.quantize = QUANTIZE[(QUANTIZE.indexOf(this.kit.quantize) + 1) % 3]; this.pads.emit({ edit: true }); } break;
      case 3: if (ins) this.transpose += 1; else this.pads.stopAll(); break;
      case 4: this.setMode('sampler'); break;
      case 5: this.setMode('instrument'); break;
      case 6: this.setMode('show'); break;
      case 7: this.app.capturePad?.(); break;
      default: break;
    }
    this.transpose = Math.max(-11, Math.min(11, this.transpose));
    this.emit({ top: x });
  }

  /** Colours of everything: grid (64, top-left first), right column (8), top row (8), logo. */
  frame(t = this.now()) {
    const beat = this.pads.masterBeat();
    const kit = this.kit;
    let cells; let active;
    if (this.mode === 'instrument') {
      const key = this.instrumentKey();
      const color = INSTRUMENTS[kit.instrument.sound?.synth]?.color ?? [127, 127, 127];
      const held = new Set(this.heldNotes.values());
      cells = []; active = [];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const n = instrumentNote(x, y, key);
          const role = noteRole(n, key.root, key.scale);
          cells.push(role === 'root' ? color : role === 'scale' ? [45, 45, 55] : [6, 6, 8]);
          active.push(held.has(n));
        }
      }
    } else {
      cells = kit.pads.map((p) => (p ? (p.src.path && this.pads.missing.has(p.src.path) ? [40, 0, 0] : p.color) : null));
      active = kit.pads.map((_, i) => this.pads.isPlaying(i));
    }
    const level = this.mode === 'show' || kit.lights.idle === 'spectrum' ? this.app.engine.levels?.().master ?? 0 : 0;
    const grid = this.lights.frame(t, {
      cells, active, idle: this.mode === 'instrument' ? 'pads' : kit.lights.idle, cover: this.mode === 'show',
      brightness: kit.lights.brightness, beat, level: Math.min(1, level * 1.3),
    });
    if (this.selected !== null && this.mode === 'sampler' && Math.floor(t * 3) % 2 === 0) grid[this.selected] = [127, 127, 127];
    const dim = (c) => scale(c, 0.25);
    const side = Array.from({ length: 8 }, (_, y) => {
      if (this.mode === 'sampler') {
        const playing = [0, 1, 2, 3, 4, 5, 6, 7].some((x) => this.pads.isPlaying(y * 8 + x));
        return playing ? [127, 0, 0] : [10, 0, 0];
      }
      if (this.mode === 'instrument') {
        const c = INSTRUMENTS[INSTRUMENT_IDS[y]]?.color ?? [0, 0, 0];
        return kit.instrument.sound?.synth === INSTRUMENT_IDS[y] ? c : dim(c);
      }
      return IDLE_IDS[y] ? (kit.lights.idle === IDLE_IDS[y] ? [127, 127, 127] : [20, 20, 30]) : [0, 0, 0];
    });
    const arrows = [40, 40, 40];
    const top = [arrows, arrows,
      this.mode === 'sampler' ? [[30, 30, 30], [127, 60, 0], [127, 0, 0]][QUANTIZE.indexOf(kit.quantize)] : arrows,
      this.mode === 'sampler' ? [60, 0, 0] : arrows,
      this.mode === 'sampler' ? [0, 127, 30] : [0, 25, 6],
      this.mode === 'instrument' ? [0, 60, 127] : [0, 12, 25],
      this.mode === 'show' ? [90, 0, 127] : [18, 0, 25],
      [50, 0, 0]];
    const logo = beat?.playing ? scale([127, 127, 127], 0.15 + 0.85 * (1 - beat.phase) ** 3) : [20, 20, 20];
    return { grid, side, top, logo };
  }
}

export class LaunchpadDriver {
  /**
   * @param {PadSurface} surface
   * @param {(bytes: number[]) => void} send
   */
  constructor(surface, send, name = 'Launchpad X') {
    this.surface = surface;
    this.send = send;
    this.device = name;
    this.sent = new Map(); // LED index -> "r,g,b"
    this.lastFrame = 0;
    this.monitor = [];
    this.send(lpxMode(true));
    this.send(lpxBrightness(127));
  }

  receive(bytes) {
    const ev = lpxDecode(bytes);
    this.monitor.push({ bytes: [...bytes], names: ev ? [`${ev.kind}${'x' in ev ? ` ${ev.x}` : ''}${'y' in ev ? `,${ev.y}` : ''}`] : [] });
    if (this.monitor.length > 40) this.monitor.shift();
    if (!ev) return;
    if (ev.kind === 'pad') this.surface.press(ev.x, ev.y, ev.velocity);
    else if (ev.kind === 'side' && ev.press) this.surface.side(ev.y);
    else if (ev.kind === 'top' && ev.press) this.surface.top(ev.x);
  }

  /** Send the LEDs that changed (at most ~30 times a second). Returns how many were sent. */
  frame(now = performance.now(), force = false) {
    if (!force && now - this.lastFrame < 33) return 0;
    this.lastFrame = now;
    const f = this.surface.frame(now / 1000);
    const leds = [];
    const put = (index, c) => {
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (!force && this.sent.get(index) === k) return;
      this.sent.set(index, k);
      leds.push([index, c[0], c[1], c[2]]);
    };
    f.grid.forEach((c, i) => put(padNote(i % 8, Math.floor(i / 8)), c));
    f.side.forEach((c, y) => put(sideCc(y), c));
    f.top.forEach((c, x) => put(topCc(x), c));
    put(LOGO, f.logo);
    for (const msg of lpxRgb(leds)) this.send(msg);
    return leds.length;
  }

  /** Back to the Launchpad's own Live mode (app closing or port gone). */
  close() {
    for (const msg of lpxRgb(Array.from(this.sent.keys(), (i) => [i, 0, 0, 0]))) { try { this.send(msg); } catch { /* port closed */ } }
    try { this.send(lpxMode(false)); } catch { /* port closed */ }
  }
}
