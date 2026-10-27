// Built-in sounds of the pad sampler: drum hits (drumkit.js voices), pitched synth instruments for
// live EDM remixes (bass, leads, chords…) and DJ effects (risers, impacts). Pure functions returning
// mono Float32Arrays, tested under Node and turned into AudioBuffers by pad-sampler.js.
import { voice } from './drumkit.js';

export const DRUM_SOUNDS = ['kick', 'snare', 'clap', 'hat', 'ohat', 'rim', 'tom', 'ride', 'shaker'];

/** Pitched instruments: label, default octave, colour on the pads. */
export const INSTRUMENTS = {
  sub: { label: 'Sub bass', octave: 1, color: [127, 20, 0] },
  reese: { label: 'Reese bass', octave: 1, color: [110, 0, 60] },
  acid: { label: 'Acid bass', octave: 2, color: [127, 90, 0] },
  pluck: { label: 'Pluck', octave: 4, color: [0, 110, 127] },
  lead: { label: 'Supersaw lead', octave: 4, color: [60, 0, 127] },
  stab: { label: 'Chord stab', octave: 3, color: [0, 127, 40] },
  keys: { label: 'Keys', octave: 3, color: [127, 60, 20] },
  pad: { label: 'Pad', octave: 3, color: [20, 60, 127] },
};

export const FX_SOUNDS = { riser: 'Riser', downlifter: 'Downlifter', impact: 'Impact', snareroll: 'Snare roll', siren: 'Siren', laser: 'Laser' };

export const midiHz = (n) => 440 * 2 ** ((n - 69) / 12);

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296) * 2 - 1; };
}

/** Band-limited-ish saw (PolyBLEP). */
function saw(phase, dt) {
  let v = 2 * phase - 1;
  if (phase < dt) { const t = phase / dt; v -= t + t - t * t - 1; } else if (phase > 1 - dt) { const t = (phase - 1) / dt; v -= t * t + t + t + 1; }
  return v;
}

/** One-pole low-pass state machine. */
const lp = () => { let y = 0; return (x, a) => (y += a * (x - y)); };
const cutoffA = (hz, rate) => 1 - Math.exp((-2 * Math.PI * Math.min(hz, rate * 0.45)) / rate);

/**
 * A note of a built-in instrument: attack/decay/sustain then a release tail (the caller fades it
 * out on note off when the pad is held).
 * @param {keyof INSTRUMENTS} kind
 * @param {number} note MIDI note
 * @param {number} rate sample rate
 * @returns {Float32Array}
 */
export function synthNote(kind, note, rate = 44100) {
  const dur = { sub: 1.6, reese: 2.4, acid: 0.6, pluck: 0.9, lead: 2.4, stab: 0.7, keys: 1.8, pad: 4 }[kind] ?? 1.5;
  const len = Math.round(dur * rate);
  const out = new Float32Array(len);
  const f = midiHz(note);
  const rnd = rng(note * 131 + kind.length);
  const chord = kind === 'stab' || kind === 'pad' ? [0, 3, 7, 10] : [0]; // minor 7th, played on any root
  const voices = kind === 'lead' ? [-0.18, -0.08, 0, 0.08, 0.18] : kind === 'reese' ? [-0.12, 0.12] : kind === 'pad' ? [-0.07, 0.07] : [0];
  const phases = chord.flatMap(() => voices.map(() => Math.abs(rnd())));
  const filt = lp(); const filt2 = lp();
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    let v = 0; let k = 0;
    for (const semi of chord) {
      const fc = f * 2 ** (semi / 12);
      for (const det of voices) {
        const fr = fc * 2 ** (det / 12);
        const dt = fr / rate;
        phases[k] = (phases[k] + dt) % 1;
        v += kind === 'sub' ? Math.sin(2 * Math.PI * phases[k]) : kind === 'keys' ? Math.sin(2 * Math.PI * phases[k] + 1.6 * Math.exp(-t * 5) * Math.sin(4 * Math.PI * phases[k])) : saw(phases[k], dt);
        k++;
      }
    }
    v /= Math.sqrt(k);
    let env; let cut;
    switch (kind) {
      case 'sub': env = Math.min(1, t / 0.005) * Math.exp(-t * 0.9); v = Math.tanh(v * 1.4); cut = 0; break;
      case 'reese': env = Math.min(1, t / 0.01) * Math.exp(-t * 0.5); cut = 500 + 300 * Math.sin(2 * Math.PI * 0.6 * t); break;
      case 'acid': env = Math.min(1, t / 0.003) * Math.exp(-t * 4); cut = 300 + 3200 * Math.exp(-t * 12); v = Math.tanh(v * 2); break;
      case 'pluck': env = Math.min(1, t / 0.002) * Math.exp(-t * 6); cut = 600 + 7000 * Math.exp(-t * 18); break;
      case 'lead': env = Math.min(1, t / 0.01) * (0.75 + 0.25 * Math.exp(-t * 3)); cut = 5200; break;
      case 'stab': env = Math.min(1, t / 0.003) * Math.exp(-t * 7); cut = 900 + 5000 * Math.exp(-t * 14); break;
      case 'keys': env = Math.min(1, t / 0.003) * Math.exp(-t * 1.6); cut = 0; break;
      case 'pad': env = Math.min(1, t / 0.6) * (t > 3 ? Math.max(0, 1 - (t - 3)) : 1); cut = 1400 + 600 * Math.sin(2 * Math.PI * 0.25 * t); break;
      default: env = Math.exp(-t * 3); cut = 0;
    }
    if (cut) { const a = cutoffA(cut, rate); v = filt2(filt(v, a), a); }
    out[i] = v * env * 0.6;
  }
  fadeTail(out, rate);
  return out;
}

/**
 * A DJ effect sound, tempo-aware (risers and rolls last `beats` beats at `bpm`).
 * @param {keyof FX_SOUNDS} kind
 */
export function fxSound(kind, bpm = 124, rate = 44100, beats = 8) {
  const beat = 60 / (bpm > 0 ? bpm : 124);
  const dur = { riser: beats * beat, downlifter: 4 * beat, impact: 2.5, snareroll: beats * beat, siren: 4 * beat, laser: 0.5 }[kind] ?? 1;
  const len = Math.round(dur * rate);
  const out = new Float32Array(len);
  const rnd = rng(kind.length * 977);
  const filt = lp();
  let phase = 0;
  const snare = kind === 'snareroll' ? voice('snare', rate) : null;
  for (let i = 0; i < len; i++) {
    const t = i / rate; const p = t / dur;
    let v = 0;
    switch (kind) {
      case 'riser': {
        phase += (2 * Math.PI * (200 + 1800 * p * p)) / rate;
        v = filt(rnd(), cutoffA(400 + 9000 * p * p, rate)) * 1.6 * p + Math.sin(phase) * 0.25 * p;
        break;
      }
      case 'downlifter':
        phase += (2 * Math.PI * (1600 * (1 - p) ** 2 + 60)) / rate;
        v = (filt(rnd(), cutoffA(9000 * (1 - p) + 200, rate)) * 1.3 + Math.sin(phase) * 0.3) * (1 - p);
        break;
      case 'impact': {
        const f = 38 + 90 * Math.exp(-t * 18);
        phase += (2 * Math.PI * f) / rate;
        v = Math.tanh(Math.sin(phase) * 2) * Math.exp(-t * 1.6) + filt(rnd(), cutoffA(3000, rate)) * Math.exp(-t * 4) * 0.8;
        break;
      }
      case 'siren':
        phase += (2 * Math.PI * (700 + 350 * Math.sin(2 * Math.PI * (2 / beat / 2) * t))) / rate;
        v = Math.sign(Math.sin(phase)) * 0.25;
        break;
      case 'laser':
        phase += (2 * Math.PI * (3000 * Math.exp(-t * 9) + 120)) / rate;
        v = Math.sin(phase) * Math.exp(-t * 5) * 0.7;
        break;
      default: break;
    }
    out[i] = v;
  }
  if (snare) {
    // 8ths, then 16ths, then 32nds for the last quarter, getting louder.
    let at = 0;
    while (at < dur) {
      const p = at / dur;
      const step = beat / (p < 0.5 ? 2 : p < 0.75 ? 4 : 8);
      const s0 = Math.round(at * rate);
      for (let j = 0; j < snare.length && s0 + j < len; j++) out[s0 + j] += snare[j] * (0.35 + 0.65 * p);
      at += step;
    }
  }
  fadeTail(out, rate);
  return normalize(out, 0.85);
}

/** The drum hit voices of drumkit.js, normalised for the pads. */
export const drumSound = (name, rate = 44100) => normalize(voice(name, rate), 0.9);

function fadeTail(a, rate) {
  const n = Math.min(a.length, Math.round(rate * 0.02));
  for (let i = 0; i < n; i++) a[a.length - 1 - i] *= i / n;
}

function normalize(a, peak) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) for (let i = 0; i < a.length; i++) a[i] *= peak / m;
  return a;
}
