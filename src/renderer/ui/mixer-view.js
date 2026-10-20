import { h, knob, fader } from './dom.js';
import { BEAT_FX, stepFxBeats } from '../audio/fx.js';

/** On-screen order of the decks (indices): 2 decks 1 2, 4 decks 3 1 2 4 (like a 4-deck controller's mixer). */
export const deckOrder = (n) => (n === 4 ? [2, 0, 1, 3] : [0, 1].slice(0, n));
import { icon } from './icons.js';

const dbFmt = (v) => (v <= -40 ? 'KILL' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`);
const fmtBeats = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);

/** Meter bar (0..1 peak, logarithmic display) with peak-hold. */
function meter() {
  const fill = h('div.meter-fill');
  const el = h('div.meter', {}, fill);
  let hold = 0;
  el.set = (peak) => {
    const db = 20 * Math.log10(peak + 1e-9);
    const t = Math.max(0, Math.min(1, (db + 48) / 51));
    hold = Math.max(t, hold - 0.015);
    fill.style.height = `${hold * 100}%`;
    el.classList.toggle('clip', peak >= 0.99);
  };
  return el;
}

/**
 * EQ knob position (0..1) -> dB, DJM style: centre = 0 dB (flat), right = +6 dB, left = kill (-40 dB).
 * The cut side is steeper near the bottom so the first half-turn stays musical.
 */
export function eqDb(p) {
  if (p >= 0.5) return (p - 0.5) * 12;
  const x = 1 - p / 0.5; // 0 at centre, 1 fully left
  return -40 * x ** 1.6;
}

export const COLOR_FX = ['FILTER', 'SPACE', 'DUB ECHO', 'NOISE', 'CRUSH'];

export class MixerView {
  /**
   * @param {import('../audio/engine.js').AudioEngine} engine
   * @param {{colorFx?: string, onColorFx?: (type: string) => void}} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.meters = [];
    /** MIDI-mappable continuous controls: id -> {label, apply(v01)} */
    this.controls = new Map();
    const reg = (id, label, min, max, setUi, onInput) => {
      this.controls.set(id, { label, apply: (v01) => { const v = min + v01 * (max - min); setUi(v); onInput(v); } });
    };
    const mk = (id, label, o) => {
      const k = knob(o);
      reg(id, label, o.min, o.max, (v) => k.setValue(v), o.onInput);
      return k;
    };

    this.strips = engine.channels.map((ch, i) => {
      const n = i + 1;
      const cueBtn = h('button.dbtn.cuech', { title: 'Headphone cue' }, icon('headphones'));
      cueBtn.onclick = () => { ch.setCue(!ch.state.cue); cueBtn.classList.toggle('on', ch.state.cue); };
      this.controls.set(`ch${n}.cue`, { label: `CH${n} Cue`, button: true, apply: () => cueBtn.click() });
      const assign = h('div.assign', {}, ['A', 'thru', 'B'].map((a) => {
        const b = h('button.dbtn.small', { title: `Crossfader assign ${a}` }, a === 'thru' ? 'THRU' : a);
        b.onclick = () => { engine.setAssign(i, a); assign.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
        if (ch.state.assign === a) b.classList.add('on');
        return b;
      }));
      const m = meter();
      this.meters.push(m);
      // Vertical range: top = 0, so the input value is inverted (up = louder).
      const chFader = fader({ min: 0, max: 1, value: 0.2, vertical: true, cls: 'chfader', onInput: (v) => engine.setFader(i, 1 - v) });
      reg(`ch${n}.fader`, `CH${n} Fader`, 0, 1, (v) => { chFader.value = String(1 - v); }, (v) => engine.setFader(i, v));
      // EQ knobs, or PART ISOLATOR knobs (HI vocal, MID inst + bass, LOW drums) when ISO is on.
      const deck = engine.decks[i];
      const eqPos = [0.5, 0.5, 0.5];
      const bandKnob = (band, key, eqLabel) => mk(`ch${n}.${key}`, `CH${n} EQ ${eqLabel}`, {
        label: eqLabel.toUpperCase(), min: 0, max: 1, value: 0.5, reset: 0.5, size: 'sm',
        format: (p) => (deck?.partIso ? (p < 0.03 ? 'CUT' : `${Math.round(Math.min(1, p * 2) * 100)}%`) : dbFmt(eqDb(p))),
        onInput: (p) => { if (deck?.partIso) deck.setIsoKnob(band, p); else { eqPos[band] = p; ch.setEq(['high', 'mid', 'low'][band], eqDb(p)); } },
      });
      const eqKnobs = [bandKnob(0, 'hi', 'Hi'), bandKnob(1, 'mid', 'Mid'), bandKnob(2, 'low', 'Low')];
      const isoBtn = h('button.dbtn.small.iso', { title: 'PART ISOLATOR: the EQ knobs control the parts (HI vocal, MID inst + bass, LOW drums)' }, 'ISO');
      isoBtn.onclick = () => { deck.setPartIso(!deck.partIso); if (deck.partIso) opts.onPartIso?.(i); };
      this.controls.set(`ch${n}.iso`, { label: `CH${n} Part Isolator`, button: true, apply: () => isoBtn.click() });
      const syncIso = () => {
        const on = !!deck?.partIso;
        isoBtn.classList.toggle('on', on);
        ['VOCAL', 'INST', 'DRUMS'].forEach((label, b) => {
          eqKnobs[b].setLabel(on ? label : ['HI', 'MID', 'LOW'][b]);
          eqKnobs[b].setValue(on ? deck.isoKnobs?.[b] ?? 0.5 : eqPos[b]);
        });
      };
      deck?.addEventListener('change', (e) => { if (e.detail === 'iso') syncIso(); });
      return h(`div.strip.ch${n}`, {},
        h('div.strip-num', {}, String(n)),
        mk(`ch${n}.trim`, `CH${n} Trim`, { label: 'TRIM', min: -12, max: 12, value: 0, reset: 0, size: 'sm', format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, onInput: (v) => ch.setTrim(v) }),
        ...eqKnobs, isoBtn,
        mk(`ch${n}.color`, `CH${n} Color FX`, { label: 'COLOR', min: -1, max: 1, value: 0, reset: 0, size: 'sm', onInput: (v) => ch.setFilter(v), format: (v) => (Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? 'L' : 'R') }),
        cueBtn,
        h('div.fader-row', {}, m, chFader),
        assign);
    });

    this.masterMeter = meter();
    const cfxSel = h('select.cfx-select', { title: 'Color FX (applies to every COLOR knob)', onchange: (e) => { engine.setColorFx(e.target.value); opts.onColorFx?.(e.target.value); } },
      COLOR_FX.map((t) => h('option', { value: t, selected: t === (opts.colorFx ?? 'FILTER') }, t)));
    engine.setColorFx(opts.colorFx ?? 'FILTER');
    this.master = h('div.strip.master', {},
      h('div.strip-num', {}, 'M'),
      mk('master.level', 'Master Level', { label: 'MASTER', min: 0, max: 1.2, value: 0.8, reset: 0.8, format: (v) => `${Math.round(v * 100)}`, onInput: (v) => engine.setMasterLevel(v) }),
      mk('phones.level', 'Headphones Level', { label: 'PHONES', min: 0, max: 1.5, value: 1, reset: 1, size: 'sm', onInput: (v) => engine.setPhonesLevel(v) }),
      mk('phones.mix', 'Headphones Mix', { label: 'CUE/MST', min: 0, max: 1, value: 0, reset: 0.5, size: 'sm', onInput: (v) => engine.setPhonesMix(v) }),
      h('div.knob-label', {}, 'COLOR FX'), cfxSel,
      h('div.fader-row', {}, this.masterMeter));

    const xf = fader({ min: -1, max: 1, step: 0.001, value: 0, cls: 'xfader', reset: 0, onInput: (v) => engine.setCrossfader(v) });
    reg('crossfader', 'Crossfader', -1, 1, (v) => { xf.value = String(v); }, (v) => engine.setCrossfader(v));
    this.stripsEl = h('div.strips');
    this.el = h('section.mixer', {}, this.stripsEl, h('div.xf-row', {}, h('span', {}, 'A'), xf, h('span', {}, 'B')));
    this.setDeckCount(2);
  }

  /** 2 channels: 1 M 2 — 4 channels: 3 1 M 2 4 (a 4-deck controller's channel order) */
  setDeckCount(n) {
    this.deckCount = n;
    const s = deckOrder(n).map((i) => this.strips[i]);
    this.stripsEl.replaceChildren(...s.slice(0, n / 2), this.master, ...s.slice(n / 2));
  }

  frame() {
    const lv = this.engine.levels();
    for (let i = 0; i < this.deckCount; i++) this.meters[i].set(lv.channels[i]);
    this.masterMeter.set(lv.master);
  }
}

export class FxView {
  /** @param {import('../audio/fx.js').BeatFxUnit} unit */
  constructor(unit, deckCount) {
    this.unit = unit;
    const select = h('select.fx-select', { onchange: (e) => unit.setEffect(e.target.value) },
      BEAT_FX.map((f) => h('option', { value: f.id }, f.id)));
    this.select = select;
    this.beatVal = h('span.val');
    const step = (dir) => unit.setBeats(stepFxBeats(unit.beats, dir));
    this.target = h('select.fx-target', { onchange: (e) => unit.setTarget(e.target.value) },
      [...Array.from({ length: deckCount }, (_, i) => h('option', { value: `ch${i + 1}` }, `CH${i + 1}`)),
        h('option', { value: 'master', selected: true }, 'MASTER'), h('option', { value: 'sampler' }, 'SAMPLER')]);
    this.onBtn = h('button.dbtn.fx-on', { onclick: () => unit.setOn(!unit.on) }, 'ON');
    this.depth = knob({ label: 'LEVEL/DEPTH', min: 0, max: 1, value: unit.depth, reset: 0.5, size: 'sm', onInput: (v) => unit.setDepth(v) });
    // Channel assign as a segmented control (1 2 3 4 M S), like the hardware/rekordbox FX unit.
    this.assignBtns = [...Array.from({ length: deckCount }, (_, i) => [`ch${i + 1}`, String(i + 1)]), ['master', 'M'], ['sampler', 'S']]
      .map(([t, label]) => h('button.seg-btn', { title: t === 'master' ? 'Master' : t === 'sampler' ? 'Sampler' : `Channel ${label}`, onclick: () => unit.setTarget(t), dataset: { t } }, label));
    this.bpmVal = h('span.fx-bpm');
    this.el = h('div.fx-unit', {},
      h('span.fx-title', {}, 'BEAT FX'),
      h('div.fx-block', {}, select),
      h('div.fx-block.fx-beatbox', {},
        h('button.arrow', { onclick: () => step(-1), title: 'Beat −' }, '◀'),
        h('div.fx-beat', {}, this.beatVal, this.bpmVal),
        h('button.arrow', { onclick: () => step(1), title: 'Beat +' }, '▶')),
      this.depth,
      h('div.fx-block.seg-group', {}, this.assignBtns),
      this.onBtn);
    unit.addEventListener('change', () => this.refresh());
    this.refresh();
  }

  refresh() {
    this.select.value = this.unit.effectId;
    this.beatVal.textContent = fmtBeats(this.unit.beats);
    this.bpmVal.textContent = this.unit.tapBpm ? `TAP ${this.unit.tapBpm.toFixed(1)}` : 'AUTO';
    this.onBtn.classList.toggle('on', this.unit.on);
    this.target.value = this.unit.target;
    this.assignBtns.forEach((b) => b.classList.toggle('on', b.dataset.t === this.unit.target));
  }
}
