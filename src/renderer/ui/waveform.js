// Waveform canvases: scrolling detail view (play head centred) and full-track overview.
import { waveformArrays } from '../analysis/analyzer.js';
import { PHRASE_COLORS } from '../../shared/dsp/phrase.js';
import { lerpAt } from '../../shared/dsp/waveform.js';

/** Stem colours, index = [drums, bass, other(inst), vocals]. Used by waveforms and stem buttons. */
export const STEM_COLORS = ['#ffa91f', '#3d8dff', '#3ddc84', '#ff4fa3'];

const STYLES = {
  '3band': { low: '#1d5bff', mid: '#f2971f', high: '#ffffff' },
  blue: { low: '#1f4fd8', mid: '#3a8cff', high: '#c8e4ff' },
};

/** Theme colours used on the canvases (read from the CSS variables, refreshed on theme change). */
const themeColor = { bg: '#0b0c0e', text: '#3a3f45', version: 0 };
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  themeColor.bg = cs.getPropertyValue('--wave-bg').trim() || '#0b0c0e';
  themeColor.text = cs.getPropertyValue('--faint').trim() || '#3a3f45';
  themeColor.version++;
}
if (typeof window !== 'undefined') { window.addEventListener('reboxed-theme', readTheme); queueMicrotask(readTheme); }

function fitCanvas(canvas) {
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  return { w, h: hgt, dpr };
}

/** Max of band values over [a, b) points. */
function bandMax(arr, a, b) {
  let m = 0;
  const end = Math.min(arr.length, Math.max(a + 1, b));
  for (let i = Math.max(0, a); i < end; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/** Draw one column of waveform at x with half-height hh around centre cy. */
function drawColumn(g, style, x, cy, hh, lo, mi, hi, colW) {
  if (style === 'rgb') {
    // Rekordbox-like RGB: lows red, mids green, highs blue, normalised on the strongest band so the
    // colour stays bright and saturated; a lighter core (mids + highs) gives depth.
    const mx = Math.max(lo, mi, hi);
    if (!mx) return;
    const amp = mx / 255;
    const c = (v) => Math.round(255 * (v / mx) ** 0.65);
    const r = c(lo); const gr = c(mi); const bl = c(hi);
    g.fillStyle = `rgb(${r},${gr},${bl})`;
    g.fillRect(x, cy - amp * hh, colW, amp * hh * 2);
    const core = (Math.max(mi, hi) / 255) * hh * 0.55;
    const lift = (v) => Math.round(v + (255 - v) * 0.55);
    g.fillStyle = `rgb(${lift(r)},${lift(gr)},${lift(bl)})`;
    g.fillRect(x, cy - core, colW, core * 2);
    return;
  }
  const c = STYLES[style] ?? STYLES['3band'];
  // Low band is drawn full, mid and high on top (narrower envelopes), as in a 3-band view.
  const l = (lo / 255) * hh; const m = (mi / 255) * hh * 0.62; const t = (hi / 255) * hh * 0.38;
  g.fillStyle = c.low; g.fillRect(x, cy - l, colW, l * 2);
  g.fillStyle = c.mid; g.fillRect(x, cy - m, colW, m * 2);
  g.fillStyle = c.high; g.fillRect(x, cy - t, colW, t * 2);
}

/**
 * Zoomed-in column: the real wave (up / down = its top and bottom, 0..1), coloured by the bands
 * at that instant. The band layers follow the wave's shape.
 */
function drawWave(g, style, x, cy, hh, up, down, lo, mi, hi, colW) {
  const mx = Math.max(lo, mi, hi);
  if (!mx || (up <= 0 && down <= 0)) return;
  const layer = (k) => g.fillRect(x, cy - up * hh * k, colW, (up + down) * hh * k);
  if (style === 'rgb') {
    const c = (v) => Math.round(255 * (v / mx) ** 0.65);
    const r = c(lo); const gr = c(mi); const bl = c(hi);
    g.fillStyle = `rgb(${r},${gr},${bl})`;
    layer(1);
    const lift = (v) => Math.round(v + (255 - v) * 0.55);
    g.fillStyle = `rgb(${lift(r)},${lift(gr)},${lift(bl)})`;
    layer((Math.max(mi, hi) / mx) * 0.55);
    return;
  }
  const c = STYLES[style] ?? STYLES['3band'];
  g.fillStyle = c.low; layer(1); // the whole wave, mids and highs inside it
  g.fillStyle = c.mid; layer((mi / mx) * 0.62);
  g.fillStyle = c.high; layer((hi / mx) * 0.38);
}

/**
 * Detail waveform. Called every animation frame.
 * @param {HTMLCanvasElement} canvas
 * @param {import('../audio/deck.js').Deck} deck
 * @param {{style: string, spanSec: number, color: string}} opts
 */
export function drawDetail(canvas, deck, opts) {
  const { w, h, dpr } = fitCanvas(canvas);
  const g = canvas.getContext('2d');
  g.fillStyle = themeColor.bg;
  g.fillRect(0, 0, w, h);
  const wf = waveformArrays(deck.analysis);
  const cx = Math.round(w / 2);
  if (!deck.loaded) {
    g.fillStyle = themeColor.text; g.font = `${12 * dpr}px system-ui`; g.textAlign = 'center';
    g.fillText(deck.loading ? 'Loading…' : `Deck ${deck.index + 1} — drop a track`, cx, h / 2 + 4 * dpr);
    return;
  }
  const pos = deck.position();
  const span = opts.spanSec;
  const secPerPx = span / w;
  const t0 = pos - cx * secPerPx;
  const cy = h / 2;
  const hh = h / 2 - 2 * dpr;

  // Loop region
  if (deck.loop) {
    const a = (deck.loop.start - t0) / secPerPx; const b = (deck.loop.end - t0) / secPerPx;
    g.fillStyle = 'rgba(255,170,0,0.16)';
    g.fillRect(a, 0, b - a, h);
  }

  // Stem-coloured waveform: shows what each part does and which parts are muted.
  const stemMode = opts.stemMode ?? 'muted';
  const showStems = deck.stemEnv && stemMode !== 'off' && (stemMode === 'always' || deck.stemGains.some((x) => x < 1));
  if (wf) {
    const step = Math.max(1, Math.round(dpr));
    if (showStems) g.globalAlpha = 0.22;
    // Zoomed in (a band point spans more than a column): the real wave from the fine peaks, with
    // the band colours interpolated. Zoomed out: band peaks per column (simplified view).
    const fine = deck.fine;
    const pointsPerCol = secPerPx * step * wf.pps;
    for (let x = 0; x < w; x += step) {
      const ta = t0 + x * secPerPx;
      if (ta < 0 || ta > deck.duration) continue;
      const tb = ta + secPerPx * step;
      if (pointsPerCol < 1.5) {
        const at = ((ta + tb) / 2) * wf.pps;
        const lo = lerpAt(wf.low, at); const mi = lerpAt(wf.mid, at); const hi = lerpAt(wf.high, at);
        if (fine) {
          const fa = Math.floor(ta * fine.pps);
          const fb = Math.min(fine.max.length, Math.max(fa + 1, Math.floor(tb * fine.pps)));
          let top = 0; let bottom = 0;
          for (let i = fa; i < fb; i++) { if (fine.max[i] > top) top = fine.max[i]; if (fine.min[i] < bottom) bottom = fine.min[i]; }
          drawWave(g, opts.style, x, cy, hh, top / 127, -bottom / 127, lo, mi, hi, step);
        } else {
          drawColumn(g, opts.style, x, cy, hh, lo, mi, hi, step);
        }
        continue;
      }
      const pa = Math.floor(ta * wf.pps);
      const pb = Math.floor(tb * wf.pps);
      drawColumn(g, opts.style, x, cy, hh, bandMax(wf.low, pa, pb), bandMax(wf.mid, pa, pb), bandMax(wf.high, pa, pb), step);
    }
    g.globalAlpha = 1;
  }
  if (showStems) {
    const pps = deck.stemEnvPps ?? 150;
    const step = Math.max(1, Math.round(dpr));
    // Draw loud parts first so quieter ones stay visible on top: drums, bass, other, vocals.
    for (const s of [0, 1, 2, 3]) {
      const env = deck.stemEnv[s];
      const gain = deck.stemGains[s];
      g.fillStyle = gain === 0 ? 'rgba(90,90,96,0.55)' : STEM_COLORS[s];
      g.globalAlpha = gain === 0 ? 1 : 0.35 + 0.55 * gain;
      for (let x = 0; x < w; x += step) {
        const ta = t0 + x * secPerPx;
        if (ta < 0 || ta > deck.duration) continue;
        const smooth = secPerPx * step * pps < 1.5; // zoomed in: interpolate instead of steps
        const v = (smooth ? lerpAt(env, (ta + secPerPx * step / 2) * pps) : bandMax(env, Math.floor(ta * pps), Math.floor((ta + secPerPx * step) * pps))) / 255;
        const hgt = Math.min(1, v * 1.6) * hh;
        if (hgt > 0.5) g.fillRect(x, cy - hgt, step, hgt * 2);
      }
    }
    g.globalAlpha = 1;
  }
  if (!wf) {
    g.fillStyle = themeColor.text; g.font = `${11 * dpr}px system-ui`; g.textAlign = 'center';
    g.fillText('Analyzing…', cx, 14 * dpr);
  }

  // Beat grid: bar lines (every 4 beats) in red, beats in white.
  // Phrase band along the top edge.
  for (const p of deck.analysis?.phrases?.phrases ?? []) {
    const a = (p.start - t0) / secPerPx; const b = (p.end - t0) / secPerPx;
    if (b < 0 || a > w) continue;
    g.fillStyle = PHRASE_COLORS[p.label] ?? '#888';
    g.globalAlpha = 0.85;
    g.fillRect(a, 0, b - a - dpr, 4 * dpr);
    g.globalAlpha = 1;
    if (a > -200) {
      g.font = `bold ${9 * dpr}px system-ui`; g.textAlign = 'left';
      g.fillText(`${p.label}${p.num > 1 ? ` ${p.num}` : ''}`, Math.max(a, 0) + 3 * dpr, 14 * dpr);
    }
  }

  // Vocal positions (from the vocal stem) along the bottom edge.
  g.fillStyle = 'rgba(255,63,160,0.85)';
  for (const [a, b] of deck.vocals ?? []) {
    const xa = (a - t0) / secPerPx; const xb = (b - t0) / secPerPx;
    if (xb < 0 || xa > w) continue;
    g.fillRect(xa, h - 3 * dpr, xb - xa, 3 * dpr);
  }

  const bg = deck.bg;
  if (bg) {
    const first = Math.ceil(deck.beatIndexAt(t0));
    const last = Math.floor(deck.beatIndexAt(t0 + span));
    for (let b = first; b <= last; b++) {
      const x = Math.round((deck.beatTime(b) - t0) / secPerPx);
      const bar = bg.isDownbeat(b);
      // Faint full-height line through the waveform, plus bright ticks top and bottom (bars in red).
      g.fillStyle = bar ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
      g.fillRect(x, 0, dpr, h);
      g.fillStyle = bar ? 'rgba(255,70,70,1)' : 'rgba(255,255,255,0.7)';
      g.fillRect(x, 0, bar ? 2 * dpr : dpr, bar ? 9 * dpr : 5 * dpr);
      g.fillRect(x, h - (bar ? 9 : 5) * dpr, bar ? 2 * dpr : dpr, (bar ? 9 : 5) * dpr);
    }
  }

  // Cues
  for (const c of deck.track.cues ?? []) {
    const x = (c.start - t0) / secPerPx;
    if (x < -20 || x > w + 20) continue;
    if (c.kind === 'mixin' || c.kind === 'mixout') {
      const col = c.kind === 'mixin' ? '#3fdc5a' : '#ff3fa0';
      g.fillStyle = col;
      g.fillRect(Math.round(x), 0, dpr, h);
      g.fillRect(Math.round(x) - (c.kind === 'mixout' ? 22 * dpr : 0), h - 12 * dpr, 22 * dpr, 12 * dpr);
      g.fillStyle = '#000'; g.font = `bold ${9 * dpr}px system-ui`; g.textAlign = 'center';
      g.fillText(c.kind === 'mixin' ? 'IN' : 'OUT', Math.round(x) + (c.kind === 'mixout' ? -11 : 11) * dpr, h - 3 * dpr);
      continue;
    }
    const color = c.kind === 'hot' ? (c.color ?? '#3fdc5a') : '#ff3b3b';
    g.fillStyle = color;
    g.fillRect(Math.round(x), 0, dpr, h);
    if (c.kind === 'hot') {
      g.fillRect(Math.round(x), 0, 14 * dpr, 12 * dpr);
      g.fillStyle = '#000'; g.font = `bold ${10 * dpr}px system-ui`; g.textAlign = 'left';
      g.fillText(String.fromCharCode(65 + c.slot), x + 3 * dpr, 10 * dpr);
    } else {
      g.beginPath(); g.moveTo(x - 5 * dpr, h); g.lineTo(x + 5 * dpr, h); g.lineTo(x, h - 7 * dpr); g.fill();
    }
  }
  // Cue point (orange triangle on top)
  {
    const x = (deck.cuePoint - t0) / secPerPx;
    g.fillStyle = '#ff9a1f';
    g.beginPath(); g.moveTo(x - 5 * dpr, 0); g.lineTo(x + 5 * dpr, 0); g.lineTo(x, 7 * dpr); g.fill();
  }
  // Slip ghost play head
  const slip = deck.slipPosition();
  if (slip !== null) {
    g.fillStyle = 'rgba(80,200,255,0.8)';
    g.fillRect(Math.round((slip - t0) / secPerPx), 0, dpr, h);
  }
  // Play head
  g.fillStyle = opts.color ?? '#fff';
  g.fillRect(cx - dpr, 0, 2 * dpr, h);
}

/** Overview: pre-rendered waveform image + live play head and markers. */
export class Overview {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, deck, onSeek) {
    this.canvas = canvas;
    this.deck = deck;
    this.cacheKey = '';
    this.image = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!deck.loaded) return;
      const r = canvas.getBoundingClientRect();
      onSeek(((e.clientX - r.left) / r.width) * deck.duration);
    });
  }

  draw(style) {
    const { canvas, deck } = this;
    const { w, h, dpr } = fitCanvas(canvas);
    const g = canvas.getContext('2d');
    const wf = waveformArrays(deck.analysis);
    const key = `${deck.track?.id}|${w}|${h}|${style}|${!!wf}|${themeColor.version}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.image = document.createElement('canvas');
      this.image.width = w; this.image.height = h;
      const ig = this.image.getContext('2d');
      ig.fillStyle = themeColor.bg; ig.fillRect(0, 0, w, h);
      if (wf && deck.duration) {
        const n = wf.low.length;
        for (let x = 0; x < w; x++) {
          const a = Math.floor((x / w) * n); const b = Math.floor(((x + 1) / w) * n);
          // Overview drawn from the baseline up, like a CDJ overview.
          drawColumn(ig, style, x, h, h - 1, bandMax(wf.low, a, b), bandMax(wf.mid, a, b), bandMax(wf.high, a, b), 1);
        }
      }
    }
    g.drawImage(this.image, 0, 0);
    if (!deck.loaded) return;
    const px = (t) => (t / deck.duration) * w;
    for (const p of deck.analysis?.phrases?.phrases ?? []) {
      g.fillStyle = PHRASE_COLORS[p.label] ?? '#888';
      g.fillRect(px(p.start), 0, Math.max(dpr, px(p.end) - px(p.start) - dpr), 3 * dpr);
    }
    g.fillStyle = 'rgba(255,63,160,0.9)';
    for (const [a, b] of deck.vocals ?? []) g.fillRect(px(a), h - 2 * dpr, Math.max(dpr, px(b) - px(a)), 2 * dpr);
    // Stem coverage while separating: where stems are already usable.
    if (deck.stemRanges?.length && !deck.stemsComplete) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, h - 4 * dpr, w, 4 * dpr);
      g.fillStyle = '#25e6d6';
      for (const [a, b] of deck.stemRanges) g.fillRect(px(a / 44100), h - 4 * dpr, Math.max(dpr, px(b / 44100) - px(a / 44100)), 4 * dpr);
    }
    const pos = deck.position();
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, px(pos), h);
    if (deck.loop) { g.fillStyle = 'rgba(255,170,0,0.35)'; g.fillRect(px(deck.loop.start), 0, Math.max(dpr, px(deck.loop.end) - px(deck.loop.start)), h); }
    for (const c of deck.track.cues ?? []) {
      g.fillStyle = c.kind === 'hot' ? (c.color ?? '#3fdc5a') : c.kind === 'mixin' ? '#3fdc5a' : c.kind === 'mixout' ? '#ff3fa0' : '#ff3b3b';
      g.fillRect(px(c.start), c.kind === 'hot' ? 0 : h - 5 * dpr, dpr * 2, 5 * dpr);
    }
    g.fillStyle = '#fff';
    g.fillRect(px(pos) - dpr / 2, 0, dpr, h);
  }
}
