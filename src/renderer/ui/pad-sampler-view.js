// PADS panel: the pad sampler on screen. Left, a virtual Launchpad X (the same lights as the
// hardware, playable with the mouse); right, the kit, the mode (SAMPLER / INSTRUMENT / SHOW) and an
// editor: the selected pad (sound, play mode, sync, choke, colour, press effect), the instrument
// (sound, key, scale, layout) or the light show (background, brightness, colours of the whole kit).
import { h, knob, toast, contextMenu } from './dom.js';
import { icon } from './icons.js';
import { PAD_MODES, LIGHT_FX, LIGHT_IDLE, NOTE_NAMES, PAD_COLORS, makePad, normalizeKit, defaultKits, noteName } from '../../shared/padkit.js';
import { DRUM_SOUNDS, INSTRUMENTS, FX_SOUNDS } from '../../shared/padsynth.js';
import { hue } from '../../shared/lightshow.js';

const css = (c) => (c ? `rgb(${Math.round(c[0] * 2.008)},${Math.round(c[1] * 2.008)},${Math.round(c[2] * 2.008)})` : '#111');
const toHex = (c) => `#${c.map((v) => Math.min(255, Math.round(v * 2.008)).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (s) => [1, 3, 5].map((i) => Math.round(parseInt(s.slice(i, i + 2), 16) / 2.008));
const SCALE_LABELS = { major: 'Major', minor: 'Minor', dorian: 'Dorian', phrygian: 'Phrygian', harmonicMinor: 'Harmonic minor', pentaMinor: 'Minor pentatonic', pentaMajor: 'Major pentatonic', chromatic: 'Chromatic' };
const TOP_LABELS = ['▲', '▼', '◀', '▶', 'Session', 'Note', 'Custom', 'Capture'];
const TRACKS = 'application/x-rb-tracks';
const PAD_MOVE = 'application/x-rb-pad';

export class PadSamplerView {
  /**
   * @param {object} app
   * @param {import('../controller/launchpad.js').PadSurface} surface
   */
  constructor(app, surface) {
    this.app = app;
    this.surface = surface;
    this.pads = surface.pads;
    this.editMode = false;
    this.clipboard = null;

    // Virtual Launchpad: top row, 8x8 grid with the right column.
    this.topBtns = TOP_LABELS.map((label, x) => h('button.lp-btn.lp-top', { title: this.topTitle(x), onclick: () => this.surface.top(x) }, h('span', {}, label)));
    this.sideBtns = Array.from({ length: 8 }, (_, y) => h('button.lp-btn.lp-side', { onclick: () => this.surface.side(y) }));
    this.cells = Array.from({ length: 64 }, (_, i) => this.cell(i));
    const rows = [...this.topBtns, h('div.lp-logo', {}, h('img', { src: 'assets/logo.svg', alt: '' }))];
    for (let y = 0; y < 8; y++) rows.push(...this.cells.slice(y * 8, y * 8 + 8).map((c) => c.el), this.sideBtns[y]);
    this.grid = h('div.lp-grid', {}, rows);

    this.kitSel = h('select.pads-kit', { title: 'Kit', onchange: (e) => this.pads.selectKit(Number(e.target.value)) });
    this.modeBtns = ['sampler', 'instrument', 'show'].map((m) => h('button.dbtn.small', { onclick: () => this.surface.setMode(m) }, m.toUpperCase()));
    this.editBtn = h('button.dbtn.small', { title: 'Edit: click a pad to select it instead of playing it (or right-click / Alt-click a pad)', onclick: () => { this.editMode = !this.editMode; this.refresh(); } }, 'EDIT');
    this.quantSel = h('select', { title: 'Loops start on the master’s next beat or bar', onchange: (e) => { this.pads.kit.quantize = e.target.value; this.changed(); } },
      h('option', { value: 'off' }, 'Quantize off'), h('option', { value: 'beat' }, 'Quantize 1 beat'), h('option', { value: 'bar' }, 'Quantize 1 bar'));
    this.volume = knob({ label: 'VOL', min: 0, max: 1.2, value: this.pads.volume ?? 0.9, reset: 0.9, size: 'sm', onInput: (v) => { this.pads.setVolume(v); this.app.library.setSetting('padVolume', v); } });
    this.status = h('span.pads-status');
    this.body = h('div.pads-body');
    this.el = h('section.pads', { hidden: true },
      h('div.pads-left', {}, this.grid),
      h('div.pads-right', {},
        h('div.pads-head', {},
          h('div.fx-title', {}, 'PADS'),
          this.kitSel,
          h('button.dbtn.small.icon-btn', { title: 'Kit menu', onclick: (e) => this.kitMenu(e) }, icon('more')),
          h('div.seg', {}, this.modeBtns),
          this.editBtn, this.quantSel,
          h('button.dbtn.small', { onclick: () => this.pads.stopAll() }, 'STOP ALL'),
          this.volume, this.status),
        this.body));

    this.pads.addEventListener('change', (e) => {
      // A slider of the open editor: save and relabel, but keep the editor (and the drag) alive.
      if (e.detail.update) { this.changed(); this.refreshCells(); return; }
      if (e.detail.kits || e.detail.edit) { this.changed(); this.refresh(); }
    });
    this.surface.addEventListener('change', (e) => { if (e.detail.mode || e.detail.side !== undefined || e.detail.top !== undefined) this.refresh(); });
    this.refresh();
  }

  topTitle(x) {
    return ['Kit before · INSTRUMENT: octave up', 'Next kit · INSTRUMENT: octave down', 'Quantize off / beat / bar · INSTRUMENT: transpose down',
      'Stop all · INSTRUMENT: transpose up', 'SAMPLER mode', 'INSTRUMENT mode (keyboard)', 'SHOW mode (light show over the grid)', 'Capture the master deck’s loop into the first empty pad'][x];
  }

  cell(i) {
    const x = i % 8; const y = Math.floor(i / 8);
    const label = h('span.lp-name');
    const el = h('div.lp-pad', { draggable: true }, label);
    const c = { el, label, bg: '' };
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.editMode || e.altKey) { this.select(i); return; }
      down = true;
      this.surface.press(x, y, e.shiftKey ? 127 : 100);
    });
    const up = () => { if (down) { down = false; this.surface.press(x, y, 0); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.select(i, true); this.padMenu(e, i); });
    el.addEventListener('dragstart', (e) => {
      if (!this.editMode || !this.pads.kit.pads[i]) { e.preventDefault(); return; }
      e.dataTransfer.setData(PAD_MOVE, String(i));
    });
    el.addEventListener('dragover', (e) => {
      const t = e.dataTransfer.types;
      if (t.includes(TRACKS) || t.includes(PAD_MOVE) || t.includes('Files')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const t = e.dataTransfer;
      if (![...t.types].some((k) => k === TRACKS || k === PAD_MOVE || k === 'Files')) return;
      e.preventDefault(); e.stopPropagation();
      if (t.types.includes(PAD_MOVE)) { this.pads.swapPads(Number(t.getData(PAD_MOVE)), i); this.select(i, true); return; }
      if (t.types.includes(TRACKS)) {
        const [id] = JSON.parse(t.getData(TRACKS) || '[]');
        if (id) this.loadTrack(i, id);
        return;
      }
      const path = [...t.files].map((f) => window.rb.pathForFile(f)).find(Boolean);
      if (path) this.loadFile(i, path);
    });
    return c;
  }

  show(on = this.el.hidden) {
    this.el.hidden = !on;
    if (on) this.pads.preload();
    this.refresh();
  }

  /** Kits saved (debounced by the library). */
  changed() {
    this.app.library.settings = { ...this.app.library.settings, padKits: this.pads.config() };
    this.app.library.scheduleSave();
  }

  /** Select a pad for editing (a second click on it unselects, unless `keep`). */
  select(i, keep = false) {
    this.surface.selected = this.surface.selected === i && !keep && !this.editMode ? null : i;
    this.surface.setMode('sampler');
    this.refresh();
  }

  // ---- loading sounds ----------------------------------------------------------------------------

  async loadTrack(i, trackId) {
    const t = this.app.library.get(trackId);
    if (!t) return;
    await this.loadFile(i, t.path, { name: t.title, bpm: t.beatgrid?.bpm ?? t.bpm ?? 0 });
  }

  async loadFile(i, path, o = {}) {
    try {
      const buf = await this.pads.decode(path);
      const short = buf.duration < 12;
      const old = this.pads.kit.pads[i];
      this.pads.setPad(i, makePad({ path }, {
        name: o.name ?? path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), bpm: o.bpm ?? 0,
        mode: o.mode ?? (short ? 'oneshot' : 'loop'), sync: o.sync ?? (!short && (o.bpm ?? 0) > 0),
        color: old?.color ?? hue(i / 64, 1), light: old?.light,
      }));
      this.select(i, true);
    } catch (err) {
      toast(`Cannot load ${path.split(/[\\/]/).pop()}: ${err.message}`, 5000);
    }
  }

  async pickFile(i) {
    const [path] = await window.rb.openFiles('audio');
    if (path) this.loadFile(i, path);
  }

  /** Capture the loop of the master deck (or a playing deck) into pad i or the first empty one. */
  async capture(i = null) {
    const app = this.app;
    const decks = [app.engine.masterDeck, ...app.engine.decks.filter((d) => d.playing), ...app.engine.decks].filter((d) => d?.loaded);
    const d = decks.find((x) => x.loop) ?? decks[0];
    if (!d) { toast('Load a track on a deck first: CAPTURE takes its loop (or a loop of the chosen size from the closest beat)', 5000); return null; }
    const slot = i ?? this.pads.kit.pads.findIndex((p) => !p);
    if (slot < 0) { toast('This kit is full: clear a pad or make a new kit', 4000); return null; }
    const range = app.captureRange(d);
    if (!range) return null;
    try {
      const { chans, sr, parts } = await app.deckAudio(d, range.start, range.end);
      const name = `${d.track.title} ${Math.round((range.beats ?? 0) * 100) / 100}b${parts ? ` ${parts.join('+')}` : ''}`;
      const path = await app.writeSampleFile(name, chans, sr);
      await this.loadFile(slot, path, { name, bpm: d.originalBpm, mode: 'loop', sync: true });
      toast(`Loop captured to pad ${slot + 1}${parts ? ` (${parts.join(' + ')})` : ''}`);
      return slot;
    } catch (err) {
      toast(`Capture failed: ${err.message}`, 5000);
      return null;
    }
  }

  // ---- menus -----------------------------------------------------------------------------------

  padMenu(e, i) {
    const p = this.pads.kit.pads[i];
    const set = (src, o) => { this.pads.setPad(i, makePad(src, { color: p?.color ?? hue(i / 64, 1), light: p?.light, ...o })); this.select(i, true); };
    contextMenu(e.clientX, e.clientY, [
      { label: 'Drum', submenu: DRUM_SOUNDS.map((d) => ({ label: d.toUpperCase(), action: () => set({ drum: d }, { name: d.toUpperCase(), choke: d.endsWith('hat') ? 1 : 0 }) })) },
      { label: 'Synth note', submenu: Object.entries(INSTRUMENTS).map(([id, ins]) => ({ label: ins.label, action: () => set({ synth: id, note: 12 * (ins.octave + 1) + 9 }, { name: `${ins.label.toUpperCase()} A`, color: ins.color, mode: ['lead', 'pad', 'reese', 'sub'].includes(id) ? 'gate' : 'oneshot' }) })) },
      { label: 'DJ effect', submenu: Object.entries(FX_SOUNDS).map(([id, label]) => ({ label, action: () => set({ fx: id, beats: ['riser', 'snareroll'].includes(id) ? 8 : 4 }, { name: label.toUpperCase() }) })) },
      { label: 'Audio file…', action: () => this.pickFile(i) },
      { label: 'Selected track in the browser', disabled: !this.app.browser?.currentTrackId(), action: () => this.loadTrack(i, this.app.browser.currentTrackId()) },
      { label: 'Capture the deck loop here', action: () => this.capture(i) },
      '-',
      { label: 'Copy', disabled: !p, action: () => { this.clipboard = JSON.parse(JSON.stringify(p)); } },
      { label: 'Paste', disabled: !this.clipboard, action: () => { const c = JSON.parse(JSON.stringify(this.clipboard)); this.pads.setPad(i, makePad(c.src, c)); } },
      { label: 'Use as the instrument sound', disabled: !p?.src.path && !p?.src.drum, action: () => { this.pads.kit.instrument.sound = { pad: i }; this.pads.emit({ edit: true }); this.surface.setMode('instrument'); } },
      { label: 'Clear', disabled: !p, action: () => this.pads.setPad(i, null) },
    ]);
  }

  kitMenu(e) {
    const kit = this.pads.kit;
    contextMenu(e.clientX, e.clientY, [
      { label: 'New empty kit', action: () => this.pads.newKit(`Kit ${this.pads.kits.length + 1}`) },
      { label: 'Duplicate this kit', action: () => this.pads.duplicateKit() },
      { label: 'Rename…', action: () => this.rename() },
      { label: 'Export the kit…', action: () => this.exportKit() },
      { label: 'Import a kit…', action: () => this.importKit() },
      { label: 'Add the built-in kits again', action: () => { this.pads.kits.push(...defaultKits().map((k) => ({ ...k, id: `${k.id}-${Date.now().toString(36)}` }))); this.pads.emit({ kits: true }); } },
      '-',
      { label: `Delete "${kit.name}"`, disabled: this.pads.kits.length <= 1, action: () => { if (confirm(`Delete the kit "${kit.name}"?`)) this.pads.deleteKit(); } },
    ]);
  }

  rename() {
    const input = h('input.pads-kit', { value: this.pads.kit.name });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.replaceWith(this.kitSel);
      if (save && v) { this.pads.kit.name = v; this.pads.emit({ kits: true }); }
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    this.kitSel.replaceWith(input);
    input.focus(); input.select();
  }

  async exportKit() {
    const kit = this.pads.kit;
    const file = await window.rb.saveFileDialog(`${kit.name.replace(/[\\/:*?"<>|]/g, '_')}.rbkit.json`, 'json');
    if (!file) return;
    await window.rb.writeFile(file, new TextEncoder().encode(JSON.stringify({ reboxedKit: 1, kit }, null, 1)));
    toast(`Kit saved: ${file}`);
  }

  async importKit() {
    try {
      const text = await window.rb.openKit();
      if (!text) return;
      const data = JSON.parse(text);
      const kit = normalizeKit({ ...(data.kit ?? data), id: '' });
      this.pads.kits.push(kit);
      this.pads.selectKit(this.pads.kits.length - 1);
      this.pads.emit({ kits: true });
      toast(`Kit "${kit.name}" imported`);
    } catch (err) {
      toast(`Not a kit file: ${err.message}`, 5000);
    }
  }

  // ---- editor --------------------------------------------------------------------------------

  row(label, ...controls) { return h('div.pads-row', {}, h('span.pads-lbl', {}, label), ...controls); }

  select2(value, options, onchange, title = '') {
    return h('select', { title, onchange: (e) => onchange(e.target.value) }, Object.entries(options).map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  }

  swatches(value, onpick) {
    const input = h('input', { type: 'color', value: toHex(value ?? [127, 127, 127]), title: 'Any colour', oninput: (e) => onpick(fromHex(e.target.value)) });
    return h('div.pads-swatches', {}, ...Object.values(PAD_COLORS).map((c) => h('button.pads-sw', { style: { background: css(c) }, onclick: () => onpick(c) })), input);
  }

  padEditor(i) {
    const p = this.pads.kit.pads[i];
    const upd = (patch) => this.pads.updatePad(i, patch);
    if (!p) {
      return h('div.pads-empty', {},
        h('p', {}, `Pad ${i + 1} is empty.`),
        h('div.pads-actions', {},
          h('button.dbtn.small', { onclick: (e) => this.padMenu(e, i) }, 'Choose a sound…'),
          h('button.dbtn.small', { onclick: () => this.pickFile(i) }, 'Audio file…'),
          h('button.dbtn.small', { onclick: () => this.capture(i) }, 'Capture the deck loop')),
        h('p.dim', {}, 'Or drop a track from the collection, or an audio file, on the pad.'));
    }
    const src = p.src;
    const what = src.drum ? `Drum: ${src.drum}` : src.synth ? `${INSTRUMENTS[src.synth]?.label ?? src.synth} · ${noteName(src.note ?? 57)}` : src.fx ? `Effect: ${FX_SOUNDS[src.fx] ?? src.fx}` : src.path;
    const name = h('input.pads-name', { value: p.name, placeholder: 'Name', onchange: (e) => upd({ name: e.target.value }) });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const range = (min, max, step, value, onInput, fmt) => {
      const out = h('span.pads-val', {}, fmt(value));
      const r = h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = fmt(Number(e.target.value)); onInput(Number(e.target.value)); } });
      return [r, out];
    };
    const x = i % 8; const y = Math.floor(i / 8);
    return h('div.pads-edit', {},
      this.row('Pad', h('b', {}, `${i + 1}`), name, h('button.dbtn.small', { onclick: (e) => this.padMenu(e, i) }, 'Sound…'),
        h('button.dbtn.small', { title: 'Play', onpointerdown: () => this.surface.press(x, y, 100), onpointerup: () => this.surface.press(x, y, 0) }, '▶')),
      this.row('Sound', h('span.pads-src', { title: what }, what), src.synth ? this.select2(src.note ?? 57, Object.fromEntries(Array.from({ length: 61 }, (_, k) => [24 + k, noteName(24 + k)])), (v) => upd({ src: { ...src, note: Number(v) } }), 'Note') : null,
        src.fx && ['riser', 'snareroll', 'downlifter', 'siren'].includes(src.fx) ? this.select2(src.beats ?? 8, { 2: '2 beats', 4: '4 beats', 8: '8 beats', 16: '16 beats' }, (v) => upd({ src: { ...src, beats: Number(v) } }), 'Length') : null),
      this.row('Play', this.select2(p.mode, PAD_MODES, (v) => upd({ mode: v })),
        h('label', { title: 'Follow the master tempo (needs the sample’s BPM)' }, h('input', { type: 'checkbox', checked: p.sync, onchange: (e) => upd({ sync: e.target.checked }) }), ' Sync'),
        h('input.pads-bpm', { type: 'number', min: 0, max: 300, step: 0.01, value: p.bpm || '', placeholder: 'BPM', title: 'BPM of the sample', onchange: (e) => upd({ bpm: Number(e.target.value) || 0 }) }),
        this.select2(p.choke, Object.fromEntries(Array.from({ length: 9 }, (_, k) => [k, k ? `Choke ${k}` : 'No choke'])), (v) => upd({ choke: Number(v) }), 'Pads of the same choke group cut each other (open / closed hats, bass notes)')),
      this.row('Gain', ...range(0, 2, 0.01, p.gain, (v) => upd({ gain: v }), (v) => `${Math.round(v * 100)}%`)),
      this.row('Pitch', ...range(-24, 24, 1, p.pitch, (v) => upd({ pitch: v }), (v) => `${v > 0 ? '+' : ''}${v} st`)),
      this.row('Colour', this.swatches(p.color, (c) => upd({ color: c }))),
      this.row('Light', this.select2(p.light.fx, LIGHT_FX, (v) => upd({ light: { ...p.light, fx: v } }), 'Effect drawn on the grid when the pad is hit'),
        this.select2(p.light.beats, { 0.25: '1/4 beat', 0.5: '1/2 beat', 1: '1 beat', 2: '2 beats', 4: '4 beats', 8: '8 beats' }, (v) => upd({ light: { ...p.light, beats: Number(v) } }), 'Length of the effect'),
        h('label', {}, h('input', { type: 'checkbox', checked: !p.light.color, onchange: (e) => upd({ light: { ...p.light, color: e.target.checked ? null : p.color } }) }), ' pad colour')),
      p.light.color ? this.row('', this.swatches(p.light.color, (c) => upd({ light: { ...p.light, color: c } }))) : null,
      this.row('', h('button.dbtn.small', { onclick: () => this.pads.setPad(i, null) }, 'Clear the pad'),
        h('span.dim', {}, 'EDIT on: drag a pad onto another to move it.')));
  }

  instrumentEditor() {
    const ins = this.pads.kit.instrument;
    const set = (patch) => { Object.assign(ins, patch); this.pads.stopAll(); this.pads.emit({ edit: true }); };
    const key = this.surface.instrumentKey();
    const sounds = Object.fromEntries(Object.entries(INSTRUMENTS).map(([id, x]) => [`synth:${id}`, x.label]));
    this.pads.kit.pads.forEach((p, i) => { if (p?.src.path || p?.src.drum) sounds[`pad:${i}`] = `Pad ${i + 1}: ${p.name || 'sample'}`; });
    const cur = Number.isInteger(ins.sound?.pad) ? `pad:${ins.sound.pad}` : `synth:${ins.sound?.synth ?? 'sub'}`;
    return h('div.pads-edit', {},
      h('p.dim', {}, 'The grid is a keyboard: lit pads are in the key, the coloured ones are the root note. The same note lights everywhere it appears.'),
      this.row('Sound', this.select2(cur, sounds, (v) => { const [k, id] = v.split(':'); set({ sound: k === 'pad' ? { pad: Number(id) } : { synth: id } }); })),
      this.row('Key', h('label', { title: 'Play in the key of the master deck’s track' }, h('input', { type: 'checkbox', checked: ins.followKey, onchange: (e) => set({ followKey: e.target.checked }) }), ' Follow the master track'),
        this.select2(ins.root, Object.fromEntries(NOTE_NAMES.map((n, i) => [i, n])), (v) => set({ root: Number(v) }), 'Root note'),
        this.select2(ins.scale, SCALE_LABELS, (v) => set({ scale: v }))),
      this.row('Now', h('b', {}, `${NOTE_NAMES[key.root]} ${SCALE_LABELS[key.scale] ?? key.scale}`), h('span.dim', {}, `· octave ${key.octave}${this.surface.transpose ? ` · transpose ${this.surface.transpose > 0 ? '+' : ''}${this.surface.transpose}` : ''}`)),
      this.row('Layout', this.select2(ins.layout, { scale: 'In key (rows a 4th apart)', chromatic: 'Chromatic (rows a 4th apart)' }, (v) => set({ layout: v })),
        this.select2(ins.octave ?? '', { '': 'Octave: auto', 0: 'Octave 0', 1: 'Octave 1', 2: 'Octave 2', 3: 'Octave 3', 4: 'Octave 4', 5: 'Octave 5' }, (v) => set({ octave: v === '' ? null : Number(v) })),
        this.select2(ins.mode, { sustain: 'Held: endless note', gate: 'Held: the sound fades', oneshot: 'Tap: plays to the end' }, (v) => set({ mode: v }),
          'Endless: a note lasts as long as you hold its pad · Fades: it stops on release, or earlier when the sound dies out · Tap: each note plays its whole sound')),
      h('p.dim', {}, 'Launchpad X: ▲ ▼ octave, ◀ ▶ transpose, right column = the 8 synth sounds.'));
  }

  showEditor() {
    const kit = this.pads.kit;
    const L = kit.lights;
    const set = (patch) => { Object.assign(L, patch); this.pads.emit({ edit: true }); };
    const recolor = (fn) => { kit.pads.forEach((p, i) => { if (p) p.color = fn(p, i); }); this.pads.emit({ edit: true }); };
    const allFx = (fx) => { kit.pads.forEach((p) => { if (p) p.light = { ...p.light, fx }; }); this.pads.emit({ edit: true }); };
    const bright = h('input', { type: 'range', min: 10, max: 100, step: 1, value: L.brightness });
    bright.addEventListener('change', () => set({ brightness: Number(bright.value) }));
    bright.addEventListener('input', () => { L.brightness = Number(bright.value); });
    return h('div.pads-edit', {},
      h('p.dim', {}, 'SHOW: the background animation covers the whole grid and every pad plays its sound and its light effect. In SAMPLER mode the animation fills the empty pads.'),
      this.row('Background', this.select2(L.idle, LIGHT_IDLE, (v) => set({ idle: v }))),
      this.row('Brightness', bright),
      this.row('Pad colours', h('button.dbtn.small', { onclick: () => recolor((_, i) => hue((i % 8) / 8 + Math.floor(i / 8) / 32, 1)) }, 'Rainbow'),
        h('button.dbtn.small', { onclick: () => recolor((_, i) => hue(Math.floor(i / 8) / 8, 1)) }, 'By row'),
        h('button.dbtn.small', { onclick: () => recolor(() => hue(Math.random(), 1)) }, 'Random'),
        h('button.dbtn.small', { onclick: () => recolor((p) => (p.src.drum ? PAD_COLORS.red : p.src.synth ? INSTRUMENTS[p.src.synth]?.color ?? PAD_COLORS.blue : p.src.fx ? PAD_COLORS.white : PAD_COLORS.green)) }, 'By sound')),
      this.row('All effects', this.select2('', { '': 'Set every pad’s effect…', ...LIGHT_FX }, (v) => v && allFx(v))),
      h('p.dim', {}, 'Each pad’s own colour and effect: SAMPLER mode, EDIT, click the pad. Launchpad X: Custom = SHOW, right column = background.'));
  }

  refresh() {
    if (this.el.hidden) return;
    const pads = this.pads; const kit = pads.kit; const mode = this.surface.mode;
    if (this.kitSel.isConnected || !this.el.querySelector('input.pads-kit')) {
      this.kitSel.replaceChildren(...pads.kits.map((k, i) => h('option', { value: i, selected: i === pads.kitIndex }, k.name)));
    }
    this.modeBtns.forEach((b, i) => b.classList.toggle('on', ['sampler', 'instrument', 'show'][i] === mode));
    this.editBtn.classList.toggle('on', this.editMode);
    this.quantSel.value = kit.quantize;
    const lps = [...(this.app.midi?.launchpads?.values() ?? [])];
    this.status.textContent = lps.length ? `● ${lps.map((l) => l.device).join(', ')}` : 'No Launchpad X: play with the mouse';
    this.status.classList.toggle('on', lps.length > 0);
    this.refreshCells();
    this.sideBtns.forEach((b, y) => { b.title = mode === 'sampler' ? `Stop row ${y + 1}` : mode === 'instrument' ? INSTRUMENTS[Object.keys(INSTRUMENTS)[y]]?.label ?? '' : Object.values(LIGHT_IDLE)[y] ?? ''; });
    const sel = this.surface.selected;
    this.body.replaceChildren(mode === 'instrument' ? this.instrumentEditor() : mode === 'show' ? this.showEditor()
      : sel !== null ? this.padEditor(sel)
        : h('div.pads-help', {},
          h('p', {}, 'Click a pad to play it (Shift = full velocity). Right-click a pad to choose its sound, or EDIT then click it to set it up.'),
          h('p.dim', {}, 'Drop tracks or audio files on the pads. Capture (or right-click ▸ Capture) takes the deck’s loop. Loops start on the master’s beat and follow its tempo when synced.'),
          h('p.dim', {}, 'With a Launchpad X: Session = pads, Note = instrument, Custom = light show, ▲ ▼ = kits, right column = stop a row.')));
  }

  /** Pad names and tooltips. */
  refreshCells() {
    const kit = this.pads.kit; const mode = this.surface.mode;
    this.cells.forEach((c, i) => {
      const p = kit.pads[i];
      c.label.textContent = mode === 'instrument' ? '' : (p?.name ?? '');
      c.el.title = mode === 'instrument' ? noteName(this.surface.noteAt(i % 8, Math.floor(i / 8))) : p ? `${p.name} · ${PAD_MODES[p.mode]}${p.sync ? ' · sync' : ''}${p.choke ? ` · choke ${p.choke}` : ''}` : 'Empty: right-click to choose a sound, or drop a track';
      c.el.classList.toggle('sel', this.surface.selected === i && mode === 'sampler');
    });
  }

  /** Each animation frame while shown: the grid lights. */
  frame() {
    if (this.el.hidden) return;
    const f = this.surface.frame();
    f.grid.forEach((col, i) => {
      const c = this.cells[i];
      const s = css(col);
      if (c.bg !== s) { c.bg = s; c.el.style.background = s; c.el.classList.toggle('lit', col[0] + col[1] + col[2] > 160); }
    });
    f.side.forEach((col, y) => { this.sideBtns[y].style.background = css(col); });
    f.top.forEach((col, x) => { this.topBtns[x].style.background = css(col); });
  }
}
