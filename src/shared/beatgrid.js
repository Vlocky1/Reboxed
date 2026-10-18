// Beat grid model shared by analysis, decks, waveforms and rekordbox.xml.
// Stored form: {bpm, firstBeat, beat, beats?}
//   bpm        average/constant tempo
//   firstBeat  time (s) of beat index 0
//   beat       position of beat 0 inside its bar, 1..4 (rekordbox.xml "Battito")
//   beats      optional sorted beat times (s) for a dynamic (variable tempo) grid
// Beat indices are fractional: index 3.5 is half way between beats 3 and 4.

export class Beatgrid {
  /** @param {{bpm: number, firstBeat: number, beat?: number, beats?: number[]}} g */
  constructor(g) {
    this.bpm = g.bpm;
    this.firstBeat = g.firstBeat;
    this.beat = g.beat ?? 1;
    this.beats = g.beats?.length >= 2 ? g.beats : null;
    this.period = 60 / g.bpm;
  }

  get dynamic() { return !!this.beats; }

  /** Time of (fractional) beat index i. */
  timeOf(i) {
    const b = this.beats;
    if (!b) return this.firstBeat + i * this.period;
    const n = b.length;
    if (i <= 0) return b[0] + i * (b[1] - b[0]);
    if (i >= n - 1) return b[n - 1] + (i - (n - 1)) * (b[n - 1] - b[n - 2]);
    const k = Math.floor(i);
    return b[k] + (i - k) * (b[k + 1] - b[k]);
  }

  /** Fractional beat index at time t. */
  indexAt(t) {
    const b = this.beats;
    if (!b) return (t - this.firstBeat) / this.period;
    const n = b.length;
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
    let lo = 0; let hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (b[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - b[lo]) / (b[lo + 1] - b[lo]);
  }

  /** Beat length (s) around time t. */
  periodAt(t) {
    if (!this.beats) return this.period;
    const i = Math.floor(this.indexAt(t));
    return this.timeOf(i + 1) - this.timeOf(i);
  }

  bpmAt(t) { return 60 / this.periodAt(t); }

  /** Position in bar 0..3 of integer beat index i (0 = downbeat). */
  barPos(i) { return (((this.beat - 1 + i) % 4) + 4) % 4; }
  isDownbeat(i) { return this.barPos(i) === 0; }

  /** Snap t to the nearest multiple of `unit` beats. */
  snap(t, unit = 1) { return this.timeOf(Math.round(this.indexAt(t) / unit) * unit); }

  /** Start of the `unit`-beat cell containing t. */
  floor(t, unit = 1) { return this.timeOf(Math.floor(this.indexAt(t) / unit + 1e-6) * unit); }

  /** Start of the bar containing t, or of the `bars`-bar block. */
  floorBar(t, bars = 1) {
    const i = Math.floor(this.indexAt(t) + 1e-6);
    const toBar = this.barPos(i);
    const barStart = i - toBar;
    const firstBar = -this.barPos(0); // index of a downbeat at or before 0
    const blocks = Math.floor((barStart - firstBar) / (4 * bars));
    return this.timeOf(firstBar + blocks * 4 * bars);
  }

  /** Beat phase 0..1 at t. */
  phase(t) { const x = this.indexAt(t); return x - Math.floor(x); }

  toJSON() {
    return { bpm: this.bpm, firstBeat: this.firstBeat, beat: this.beat, ...(this.beats ? { beats: this.beats } : {}) };
  }

  /**
   * Tempo change markers for rekordbox.xml (Inizio/Bpm/Battito), one per stretch where the
   * tempo stays within `tolerance` BPM. Constant grids give a single marker.
   */
  tempoMarkers(tolerance = 0.05) {
    if (!this.beats) return [{ start: this.firstBeat, bpm: this.bpm, beat: this.beat }];
    const out = [];
    const b = this.beats;
    let segStart = 0;
    const bpmOf = (k) => 60 / (b[k + 1] - b[k]);
    for (let k = 1; k < b.length - 1; k++) {
      const seg = 60 * (k - segStart) / (b[k] - b[segStart]);
      if (Math.abs(bpmOf(k) - seg) > tolerance) {
        out.push({ start: b[segStart], bpm: seg, beat: this.barPos(segStart) + 1 });
        segStart = k;
      }
    }
    const last = b.length - 1;
    out.push({ start: b[segStart], bpm: last > segStart ? 60 * (last - segStart) / (b[last] - b[segStart]) : bpmOf(last - 1), beat: this.barPos(segStart) + 1 });
    return out.map((m) => ({ ...m, bpm: Math.round(m.bpm * 100) / 100, start: Math.round(m.start * 1000) / 1000 }));
  }

  /** Build from rekordbox.xml TEMPO markers (one = constant grid). */
  static fromMarkers(markers, duration) {
    if (!markers?.length) return null;
    const first = markers[0];
    if (markers.length === 1) return new Beatgrid({ bpm: first.bpm, firstBeat: first.start, beat: first.beat ?? 1 });
    const beats = [];
    for (let m = 0; m < markers.length; m++) {
      const end = m + 1 < markers.length ? markers[m + 1].start
        : duration > markers[m].start ? duration : markers[m].start + 60;
      const p = 60 / markers[m].bpm;
      for (let t = markers[m].start; t < end - p * 0.01; t += p) beats.push(Math.round(t * 1000) / 1000);
    }
    const avg = 60 * (beats.length - 1) / (beats.at(-1) - beats[0]);
    return new Beatgrid({ bpm: Math.round(avg * 100) / 100, firstBeat: beats[0], beat: first.beat ?? 1, beats });
  }
}

// ---- grid editing (pure, return new stored grids) ------------------------------------------

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Move the whole grid by dt seconds. */
export function shiftGrid(g, dt) {
  return { ...g, firstBeat: r3(g.firstBeat + dt), ...(g.beats ? { beats: g.beats.map((t) => r3(t + dt)) } : {}) };
}

/** Double the tempo (insert a beat between every pair). */
export function doubleGrid(g) {
  if (!g.beats) return { ...g, bpm: g.bpm * 2, beat: ((g.beat - 1) * 2) % 4 + 1 };
  const beats = [];
  for (let i = 0; i < g.beats.length; i++) {
    beats.push(g.beats[i]);
    if (i + 1 < g.beats.length) beats.push(r3((g.beats[i] + g.beats[i + 1]) / 2));
  }
  return { ...g, bpm: g.bpm * 2, beats };
}

/** Halve the tempo (keep every other beat, starting on a downbeat when possible). */
export function halveGrid(g) {
  const bg = new Beatgrid(g);
  const start = bg.barPos(0) % 2 === 0 ? 0 : 1;
  if (!g.beats) return { ...g, bpm: g.bpm / 2, firstBeat: r3(bg.timeOf(start)), beat: 1 };
  return { ...g, bpm: g.bpm / 2, firstBeat: g.beats[start], beat: 1, beats: g.beats.filter((_, i) => i >= start && (i - start) % 2 === 0) };
}

/** Make the beat nearest to t a downbeat, moving the grid so a beat lands exactly on t. */
export function setDownbeatAt(g, t) {
  const bg = new Beatgrid(g);
  const i = Math.round(bg.indexAt(t));
  const moved = shiftGrid(g, t - bg.timeOf(i));
  return { ...moved, beat: ((((0 - i) % 4) + 4) % 4) + 1 };
}

/** Constant grid at `bpm` with a beat at time t (tap tempo / manual BPM). */
export function constantGridAt(bpm, t, beat = 1) {
  const p = 60 / bpm;
  const first = t - Math.floor(t / p) * p;
  const shiftBeats = Math.round((t - first) / p);
  return { bpm: Math.round(bpm * 100) / 100, firstBeat: r3(first), beat: ((beat - 1 - shiftBeats) % 4 + 4) % 4 + 1 };
}

/** Tap tempo: BPM from tap timestamps (ms), averaging the last up to 8 intervals. */
export function tapBpm(taps) {
  if (taps.length < 2) return 0;
  const recent = taps.slice(-9);
  const avg = (recent.at(-1) - recent[0]) / (recent.length - 1);
  return avg > 0 ? Math.round((60000 / avg) * 100) / 100 : 0;
}

/** Accepts a stored grid object (or a Beatgrid) and returns a Beatgrid, or null. */
export function toBeatgrid(g) {
  if (!g || !(g.bpm > 0)) return null;
  return g instanceof Beatgrid ? g : new Beatgrid(g);
}
