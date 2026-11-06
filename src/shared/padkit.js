// Pad sampler kits: 64 pads (8x8, like a Launchpad X), each one a sound (built-in drum, synth note,
// DJ effect, or an audio file / deck capture) with its play mode, sync, choke group and lights.
// Plus the instrument (keyboard) layouts. Pure data and functions, tested under Node.
import { DRUM_SOUNDS, INSTRUMENTS } from './padsynth.js';

export const PAD_COUNT = 64;

/** How a pad plays: once to the end, while held, looped (press again to stop), or toggled on/off. */
export const PAD_MODES = { oneshot: 'One shot', gate: 'Hold', loop: 'Loop', toggle: 'Toggle' };

/** Press effects drawn on the grid when a pad is hit. */
export const LIGHT_FX = { none: 'None', flash: 'Flash', ripple: 'Ripple', cross: 'Cross', row: 'Row', column: 'Column', square: 'Square', sparkle: 'Sparkle', fill: 'Full grid' };
/** Background animations, synced to the master tempo. */
export const LIGHT_IDLE = { pads: 'Pad colours', pulse: 'Beat pulse', rainbow: 'Rainbow', wave: 'Wave', spectrum: 'Spectrum (master level)', rain: 'Rain', off: 'Off' };

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentaMinor: [0, 3, 5, 7, 10],
  pentaMajor: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const C = {
  red: [127, 0, 0], orange: [127, 50, 0], yellow: [127, 110, 0], lime: [60, 127, 0], green: [0, 127, 20], teal: [0, 127, 90],
  cyan: [0, 100, 127], blue: [0, 30, 127], purple: [70, 0, 127], pink: [127, 0, 80], white: [110, 110, 110],
};
export const PAD_COLORS = C;

/** An empty pad. */
export const emptyPad = () => null;

/**
 * A pad.
 * @typedef {{name: string, src: {drum?: string, synth?: string, note?: number, fx?: string, beats?: number, path?: string},
 *   mode: keyof PAD_MODES, sync: boolean, bpm: number, gain: number, pitch: number, choke: number,
 *   color: number[], light: {fx: keyof LIGHT_FX, color: number[]|null, beats: number}}} Pad
 */
export function makePad(src, o = {}) {
  return {
    name: o.name ?? '', src, mode: o.mode ?? 'oneshot', sync: o.sync ?? false, bpm: o.bpm ?? 0, gain: o.gain ?? 1,
    pitch: o.pitch ?? 0, choke: o.choke ?? 0, color: o.color ?? C.white, light: { fx: 'flash', color: null, beats: 0.5, ...(o.light ?? {}) },
  };
}

/** Repair a kit read from settings (missing fields, wrong sizes). */
export function normalizeKit(k) {
  const pads = Array.from({ length: PAD_COUNT }, (_, i) => {
    const p = k?.pads?.[i];
    if (!p?.src) return null;
    return makePad(p.src, p);
  });
  return {
    id: k?.id || `kit-${Date.now().toString(36)}`,
    name: k?.name || 'My kit',
    quantize: ['off', 'beat', 'bar'].includes(k?.quantize) ? k.quantize : 'beat',
    pads,
    lights: { idle: k?.lights?.idle in LIGHT_IDLE ? k.lights.idle : 'pads', brightness: k?.lights?.brightness ?? 100, palette: k?.lights?.palette ?? null },
    instrument: {
      sound: k?.instrument?.sound ?? { synth: 'sub' },
      root: k?.instrument?.root ?? 9,
      scale: k?.instrument?.scale in SCALES ? k.instrument.scale : 'minor',
      octave: k?.instrument?.octave ?? null,
      layout: k?.instrument?.layout === 'chromatic' ? 'chromatic' : 'scale',
      followKey: k?.instrument?.followKey ?? true,
      // sustain: a held note lasts until released · gate: held, with the sound's own decay · oneshot: to the end
      mode: ['sustain', 'gate', 'oneshot'].includes(k?.instrument?.mode) ? k.instrument.mode : 'sustain',
    },
  };
}

/** Grid index (0 = top-left, row major) of cell x,y. */
export const idx = (x, y) => y * 8 + x;

/**
 * The kits Reboxed ships: a live drum kit with DJ effects, an EDM remix kit (drums + bass + chords
 * in the instrument), and an empty kit to fill with your own samples.
 */
export function defaultKits() {
  const drums = Array(PAD_COUNT).fill(null);
  const drumColors = { kick: C.red, snare: C.orange, clap: C.yellow, hat: C.cyan, ohat: C.teal, rim: C.lime, tom: C.purple, ride: C.blue, shaker: C.green };
  // Rows 6-7 (bottom): drums, two velocities' worth of each hit; open/closed hats choke each other.
  DRUM_SOUNDS.slice(0, 8).forEach((d, x) => {
    drums[idx(x, 7)] = makePad({ drum: d }, { name: d.toUpperCase(), color: drumColors[d], choke: d === 'hat' || d === 'ohat' ? 1 : 0, light: { fx: d === 'kick' ? 'ripple' : 'flash' } });
    drums[idx(x, 6)] = makePad({ drum: d }, { name: `${d.toUpperCase()} soft`, gain: 0.55, color: drumColors[d].map((v) => Math.round(v * 0.45)), choke: d === 'hat' || d === 'ohat' ? 1 : 0 });
  });
  drums[idx(0, 5)] = makePad({ drum: 'shaker' }, { name: 'SHAKER', color: C.green });
  // Row 0: DJ effects.
  [['riser', 8, C.white, 'column'], ['downlifter', 4, C.blue, 'column'], ['impact', 0, C.red, 'fill'], ['snareroll', 8, C.orange, 'row'], ['siren', 4, C.pink, 'cross'], ['laser', 0, C.purple, 'sparkle']]
    .forEach(([fx, beats, color, light], x) => { drums[idx(x, 0)] = makePad({ fx, beats }, { name: fx.toUpperCase(), color, sync: false, light: { fx: light, beats: Math.max(0.5, beats || 1) } }); });
  // Rows 2-3: bass and lead notes (A minor) to play over a track.
  const minor = [0, 2, 3, 5, 7, 8, 10, 12];
  minor.forEach((s, x) => {
    drums[idx(x, 3)] = makePad({ synth: 'sub', note: 33 + s }, { name: `SUB ${NOTE_NAMES[(9 + s) % 12]}`, mode: 'gate', color: x === 0 || x === 7 ? INSTRUMENTS.sub.color : [60, 10, 0], choke: 2 });
    drums[idx(x, 2)] = makePad({ synth: 'stab', note: 57 + s }, { name: `STAB ${NOTE_NAMES[(9 + s) % 12]}`, color: x === 0 || x === 7 ? INSTRUMENTS.stab.color : [0, 60, 20] });
  });
  const live = normalizeKit({ id: 'kit-live', name: 'Live drums & FX', pads: drums, lights: { idle: 'pads' } });

  const edm = Array(PAD_COUNT).fill(null);
  ['kick', 'clap', 'hat', 'ohat', 'snare', 'rim', 'tom', 'ride'].forEach((d, x) => {
    edm[idx(x, 7)] = makePad({ drum: d }, { name: d.toUpperCase(), color: drumColors[d], choke: d === 'hat' || d === 'ohat' ? 1 : 0, light: { fx: d === 'kick' ? 'square' : 'flash' } });
  });
  minor.forEach((s, x) => {
    edm[idx(x, 6)] = makePad({ synth: 'reese', note: 33 + s }, { name: `REESE ${NOTE_NAMES[(9 + s) % 12]}`, mode: 'gate', color: x % 7 === 0 ? INSTRUMENTS.reese.color : [50, 0, 25], choke: 2 });
    edm[idx(x, 5)] = makePad({ synth: 'acid', note: 45 + s }, { name: `ACID ${NOTE_NAMES[(9 + s) % 12]}`, color: x % 7 === 0 ? INSTRUMENTS.acid.color : [55, 40, 0], choke: 3 });
    edm[idx(x, 4)] = makePad({ synth: 'pluck', note: 69 + s }, { name: `PLUCK ${NOTE_NAMES[(9 + s) % 12]}`, color: x % 7 === 0 ? INSTRUMENTS.pluck.color : [0, 45, 55] });
    edm[idx(x, 3)] = makePad({ synth: 'lead', note: 69 + s }, { name: `LEAD ${NOTE_NAMES[(9 + s) % 12]}`, mode: 'gate', color: x % 7 === 0 ? INSTRUMENTS.lead.color : [30, 0, 55], choke: 4, light: { fx: 'column' } });
    edm[idx(x, 2)] = makePad({ synth: 'stab', note: 57 + s }, { name: `STAB ${NOTE_NAMES[(9 + s) % 12]}`, color: x % 7 === 0 ? INSTRUMENTS.stab.color : [0, 55, 20], light: { fx: 'row' } });
    edm[idx(x, 1)] = makePad({ synth: 'pad', note: 57 + s }, { name: `PAD ${NOTE_NAMES[(9 + s) % 12]}`, mode: 'gate', color: x % 7 === 0 ? INSTRUMENTS.pad.color : [10, 25, 55], choke: 5, light: { fx: 'ripple', beats: 1 } });
  });
  [['riser', 8, C.white, 'column'], ['downlifter', 4, C.blue, 'column'], ['impact', 0, C.red, 'fill'], ['snareroll', 8, C.orange, 'row'], ['laser', 0, C.purple, 'sparkle']]
    .forEach(([fx, beats, color, light], x) => { edm[idx(x, 0)] = makePad({ fx, beats }, { name: fx.toUpperCase(), color, light: { fx: light, beats: Math.max(0.5, beats || 1) } }); });
  const edmKit = normalizeKit({ id: 'kit-edm', name: 'EDM remix (A minor)', pads: edm, lights: { idle: 'pulse' }, instrument: { sound: { synth: 'lead' }, root: 9, scale: 'minor' } });

  const empty = normalizeKit({ id: 'kit-mine', name: 'My samples', pads: [], lights: { idle: 'rainbow' } });
  return [live, edmKit, empty];
}

/**
 * Instrument (keyboard) layout: the MIDI note of grid cell x,y. "scale": only notes of the scale,
 * each row 3 degrees above the one below (a fourth or so); "chromatic": rows a fourth apart.
 */
export function instrumentNote(x, y, { root = 0, scale = 'minor', octave = 3, layout = 'scale' } = {}) {
  const row = 7 - y;
  const base = 12 * (octave + 1) + root;
  if (layout === 'chromatic') return base + x + row * 5;
  const steps = SCALES[scale] ?? SCALES.minor;
  const degree = x + row * 3;
  return base + steps[degree % steps.length] + 12 * Math.floor(degree / steps.length);
}

/** Role of a note in the key: 'root', 'scale' or 'out' (for the pad colours). */
export function noteRole(note, root, scale) {
  const pc = ((note - root) % 12 + 12) % 12;
  if (pc === 0) return 'root';
  return (SCALES[scale] ?? SCALES.minor).includes(pc) ? 'scale' : 'out';
}

export const noteName = (n) => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

/**
 * When a pad starts (seconds from now): right away, or on the next beat / bar of the master.
 * @param {'off'|'beat'|'bar'} q
 * @param {{bpm: number, phase: number, beatInBar: number}|null} master phase 0..1 within the beat, beatInBar 0..3
 */
export function quantizeDelay(q, master) {
  if (q === 'off' || !master || !(master.bpm > 0)) return 0;
  const beat = 60 / master.bpm;
  const toBeat = (1 - master.phase) * beat;
  if (q === 'beat') return toBeat > beat * 0.92 ? 0 : toBeat; // just on the beat: now
  const beatsLeft = (4 - master.beatInBar - 1) % 4;
  const d = toBeat + beatsLeft * beat;
  return d > beat * 4 - beat * 0.08 ? 0 : d;
}

/** Playback rate for a pad: semitone pitch, times the master tempo ratio for synced loops. */
export function padRate(pad, masterBpm) {
  const sync = pad.sync && pad.bpm > 0 && masterBpm > 0 ? masterBpm / pad.bpm : 1;
  return sync * 2 ** ((pad.pitch || 0) / 12);
}
