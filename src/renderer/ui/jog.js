// Jog wheel (CDJ style): the platter turns at 33 1/3 RPM with an indicator line, the outer ring
// shows the position in the track (blinking red in the last 30 s), and the centre shows the
// current BPM, the tempo change and the tempo ranges (±6 / ±10 / ±16 / WIDE, click to choose).
// Dragging the platter scratches like vinyl; the mouse wheel nudges (pitch bend).
import { h } from './dom.js';
import { TEMPO_RANGES } from '../audio/deck.js';

const TICKS_PER_TURN = 720; // the deck's jog resolution (1.8 s of audio per turn)
const RANGE_LABEL = (r) => (r === 100 ? 'WIDE' : `±${r}`);

export class JogWheel {
  /** @param {import('../audio/deck.js').Deck} deck */
  constructor(deck) {
    this.deck = deck;
    this.canvas = h('canvas.jog-canvas');
    this.bpm = h('div.jog-bpm');
    this.pct = h('div.jog-pct');
    this.ranges = TEMPO_RANGES.map((r) => h('button.jog-range', { type: 'button', title: `Tempo range ${RANGE_LABEL(r)}`, onclick: (e) => { e.stopPropagation(); deck.setTempoRange(r); } }, r === 100 ? 'W' : String(r)));
    this.el = h('div.jog', { title: 'Jog: drag to scratch, wheel to nudge' },
      this.canvas,
      h('div.jog-center', {}, this.bpm, this.pct, h('div.jog-ranges', {}, this.ranges)));
    this.touched = false;
    this.install();
  }

  install() {
    const d = this.deck;
    let last = null;
    const angle = (e) => { const r = this.canvas.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!d.loaded) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      last = angle(e);
      this.touched = true;
      this.search = e.shiftKey;
      if (!this.search) d.scratchStart();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (last === null) return;
      const a = angle(e);
      let delta = a - last;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      last = a;
      const ticks = (delta / (2 * Math.PI)) * TICKS_PER_TURN;
      if (this.search) d.jogSearch(ticks / 20);
      else d.scratchMove(ticks);
    });
    const up = () => { if (last === null) return; last = null; this.touched = false; if (!this.search) d.scratchEnd(); };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.el.addEventListener('wheel', (e) => { if (!d.loaded) return; e.preventDefault(); d.jogBend(e.deltaY > 0 ? -6 : 6); }, { passive: false });
  }

  /** Called every animation frame. */
  draw() {
    const d = this.deck;
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const size = Math.round(c.clientWidth * dpr);
    if (!size) return;
    if (c.width !== size || c.height !== size) { c.width = size; c.height = size; }
    const g = c.getContext('2d');
    const r = size / 2;
    const css = getComputedStyle(this.el);
    const deckColor = css.getPropertyValue('--deck').trim() || '#3d8dff';
    g.clearRect(0, 0, size, size);

    // Platter.
    const plate = g.createRadialGradient(r, r * 0.8, r * 0.1, r, r, r);
    plate.addColorStop(0, this.touched ? '#2c2c34' : '#202026');
    plate.addColorStop(0.75, '#141418');
    plate.addColorStop(1, '#0b0b0e');
    g.fillStyle = plate;
    g.beginPath(); g.arc(r, r, r - dpr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = dpr;
    for (const k of [0.62, 0.78]) { g.beginPath(); g.arc(r, r, r * k, 0, Math.PI * 2); g.stroke(); }

    // Position ring: elapsed part of the track.
    const ringW = Math.max(3 * dpr, r * 0.08);
    const ringR = r - ringW / 2 - dpr;
    g.lineWidth = ringW; g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath(); g.arc(r, r, ringR, 0, Math.PI * 2); g.stroke();
    if (d.loaded && d.duration) {
      const pos = d.position();
      const frac = Math.max(0, Math.min(1, pos / d.duration));
      const ending = d.duration - pos < 30;
      const blinkOff = ending && Math.floor(performance.now() / 400) % 2;
      g.strokeStyle = ending ? (blinkOff ? 'rgba(250,35,59,.35)' : '#fa233b') : deckColor;
      g.beginPath(); g.arc(r, r, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); g.stroke();

      // Rotating indicator: 33 1/3 RPM, follows scratching and nudges (it is the playback position).
      const turn = (pos / 1.8) * Math.PI * 2 - Math.PI / 2;
      const inner = r * 0.36; const outer = ringR - ringW / 2 - 2 * dpr;
      g.lineCap = 'round';
      g.strokeStyle = d.playing || this.touched ? '#ffffff' : 'rgba(255,255,255,.75)';
      g.lineWidth = Math.max(2 * dpr, r * 0.035);
      g.shadowColor = deckColor; g.shadowBlur = d.playing ? 10 * dpr : 0;
      g.beginPath(); g.moveTo(r + Math.cos(turn) * inner, r + Math.sin(turn) * inner); g.lineTo(r + Math.cos(turn) * outer, r + Math.sin(turn) * outer); g.stroke();
      g.shadowBlur = 0;
    }
    // Cue point mark on the ring.
    if (d.loaded && d.duration && Number.isFinite(d.cuePoint)) {
      const a = -Math.PI / 2 + (d.cuePoint / d.duration) * Math.PI * 2;
      g.fillStyle = '#ff9a1f';
      g.beginPath(); g.arc(r + Math.cos(a) * ringR, r + Math.sin(a) * ringR, ringW * 0.45, 0, Math.PI * 2); g.fill();
    }

    // Centre text.
    const bpm = d.originalBpm ? d.currentBpm.toFixed(1) : '--.-';
    if (this.bpm.textContent !== bpm) this.bpm.textContent = bpm;
    const pct = `${d.tempoPct >= 0 ? '+' : ''}${d.tempoPct.toFixed(2)}%`;
    if (this.pct.textContent !== pct) this.pct.textContent = pct;
    this.ranges.forEach((b, i) => b.classList.toggle('on', TEMPO_RANGES[i] === d.tempoRange));
  }
}
