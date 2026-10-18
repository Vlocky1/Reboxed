import { detectBeats } from '../../shared/dsp/bpm.js';
import { trackBeatsDynamic, isSteadyTempo, detectDownbeat } from '../../shared/dsp/beats-dynamic.js';
import { detectKey } from '../../shared/dsp/key.js';
import { analyzePhrases } from '../../shared/dsp/phrase.js';
import { audioFeatures } from '../../shared/dsp/features.js';
import { reduceBands, loudnessDb, u8ToBase64 } from '../../shared/dsp/waveform.js';
import { Beatgrid } from '../../shared/beatgrid.js';
import { toCamelot } from '../../shared/keys.js';

/** Grid only (used when a track keeps a user/xml grid but needs phrases recomputed). */
function gridFor(mono, rate, bpmRange, mode) {
  const beats = detectBeats(mono, rate, bpmRange);
  if (!beats.bpm) return { grid: null, confidence: 0 };
  let grid = { bpm: beats.bpm, firstBeat: beats.firstBeat, beat: 1 };
  if (mode === 'dynamic') {
    const times = trackBeatsDynamic(mono, rate, beats.bpm);
    if (times.length > 16 && !isSteadyTempo(times)) {
      const avg = (60 * (times.length - 1)) / (times.at(-1) - times[0]);
      grid = { bpm: Math.round(avg * 100) / 100, firstBeat: times[0], beat: 1, beats: times };
    }
  }
  return { grid, confidence: beats.confidence };
}

self.onmessage = (e) => {
  const { id, mono, monoRate, bands, bandRate, bpmRange, mode = 'normal', fixedGrid = null } = e.data;
  try {
    const duration = mono.length / monoRate;
    let { grid, confidence } = fixedGrid ? { grid: fixedGrid, confidence: 1 } : gridFor(mono, monoRate, bpmRange, mode);
    let bg = grid ? new Beatgrid(grid) : null;
    if (bg && !fixedGrid) {
      const count = Math.min(512, Math.max(0, Math.floor(bg.indexAt(duration))));
      grid = { ...grid, beat: detectDownbeat(mono, monoRate, (i) => bg.timeOf(i), count) };
      bg = new Beatgrid(grid);
    }
    const key = detectKey(mono, monoRate);
    const wf = bands ? reduceBands(bands, bandRate) : null;
    self.postMessage({
      id,
      ok: true,
      result: {
        beatgrid: grid,
        bpmConfidence: confidence,
        key: key ? toCamelot(key) : '',
        keyConfidence: key?.confidence ?? 0,
        loudness: loudnessDb(mono, monoRate),
        phrases: bg ? analyzePhrases(mono, monoRate, bg, duration) : null,
        features: audioFeatures(mono, monoRate, grid?.bpm ?? 0),
        ...(wf ? { waveform: { pps: wf.pps, low: u8ToBase64(wf.low), mid: u8ToBase64(wf.mid), high: u8ToBase64(wf.high) } } : {}),
      },
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.stack ?? err) });
  }
};
