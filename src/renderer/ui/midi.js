// MIDI controller support via Web MIDI: learnable mappings from note/CC/pitch-bend messages to
// app actions. Mappings persist in settings.midiMappings as {key, target, label}.
import { h, toast } from './dom.js';
import { BEAT_FX } from '../audio/fx.js';
import { decodeMessage } from '../../shared/midi.js';
import { parseRekordboxMapping } from '../../shared/controllers/rbcsv.js';
import { PioneerController } from '../controller/pioneer.js';

/** All mappable targets: id -> {label, kind: 'button'|'abs'|'rel', run(msg)} */
export function buildTargets(app) {
  const t = new Map();
  const add = (id, label, kind, run) => t.set(id, { label, kind, run });
  const pressOnly = (fn) => (m) => { if (m.press) fn(); };
  app.engine.decks.forEach((d, i) => {
    const n = i + 1;
    add(`deck${n}.play`, `Deck ${n} Play/Pause`, 'button', pressOnly(() => d.playPause()));
    add(`deck${n}.cue`, `Deck ${n} Cue`, 'button', (m) => (m.press ? d.cueDown() : d.cueUp()));
    add(`deck${n}.sync`, `Deck ${n} Sync`, 'button', pressOnly(() => d.toggleSync()));
    add(`deck${n}.master`, `Deck ${n} Master`, 'button', pressOnly(() => app.engine.setMasterDeck(i)));
    add(`deck${n}.keylock`, `Deck ${n} Master Tempo`, 'button', pressOnly(() => d.toggleKeyLock()));
    add(`deck${n}.slip`, `Deck ${n} Slip`, 'button', pressOnly(() => d.toggleSlip()));
    add(`deck${n}.quantize`, `Deck ${n} Quantize`, 'button', pressOnly(() => d.toggleQuantize()));
    add(`deck${n}.reverse`, `Deck ${n} Reverse (hold)`, 'button', (m) => d.setReverse(!!m.press));
    for (let s = 0; s < 8; s++) {
      add(`deck${n}.hotcue${s + 1}`, `Deck ${n} Hot Cue ${String.fromCharCode(65 + s)}`, 'button', pressOnly(() => d.hotCuePress(s)));
    }
    add(`deck${n}.loop`, `Deck ${n} Auto Beat Loop`, 'button', pressOnly(() => d.beatLoop(d.beatLoopSize)));
    add(`deck${n}.reloop`, `Deck ${n} Reloop/Exit`, 'button', pressOnly(() => d.reloopExit()));
    add(`deck${n}.loopHalf`, `Deck ${n} Loop 1/2`, 'button', pressOnly(() => d.resizeLoop(0.5)));
    add(`deck${n}.loopDouble`, `Deck ${n} Loop x2`, 'button', pressOnly(() => d.resizeLoop(2)));
    add(`deck${n}.jumpBack`, `Deck ${n} Beat Jump Back`, 'button', pressOnly(() => d.beatJump(-d.beatJumpSize)));
    add(`deck${n}.jumpFwd`, `Deck ${n} Beat Jump Forward`, 'button', pressOnly(() => d.beatJump(d.beatJumpSize)));
    add(`deck${n}.load`, `Deck ${n} Load Selected Track`, 'button', pressOnly(() => { const id = app.browser.currentTrackId(); if (id) app.loadTrack(i, id); }));
    // Tempo slider: top = slower like a CDJ (value 0 -> -range).
    add(`deck${n}.tempo`, `Deck ${n} Tempo Slider`, 'abs', (m) => d.userTempo((m.value01 * 2 - 1) * d.tempoRange));
    add(`deck${n}.jog`, `Deck ${n} Jog (relative)`, 'rel', (m) => {
      if (d.playing) { d.setBend(1 + Math.max(-0.1, Math.min(0.1, m.delta * 0.01))); clearTimeout(d.jogTimer); d.jogTimer = setTimeout(() => d.setBend(1), 60); }
      else d.seek(d.position() + m.delta * 0.01);
    });
  });
  for (const [id, c] of app.mixer.controls) {
    add(id, c.label, c.button ? 'button' : 'abs', c.button ? pressOnly(() => c.apply()) : (m) => c.apply(m.value01));
  }
  const fx = app.engine.fx;
  add('fx.on', 'Beat FX On/Off', 'button', pressOnly(() => fx.setOn(!fx.on)));
  add('fx.depth', 'Beat FX Level/Depth', 'abs', (m) => fx.setDepth(m.value01));
  add('fx.next', 'Beat FX Next Effect', 'button', pressOnly(() => {
    const i = BEAT_FX.findIndex((f) => f.id === fx.effectId);
    fx.setEffect(BEAT_FX[(i + 1) % BEAT_FX.length].id);
  }));
  add('browse.scroll', 'Browser Scroll (relative)', 'rel', (m) => app.browser.moveSelection(m.delta));
  return t;
}

export class MidiController {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.learnTarget = null;
    this.onLearn = null;
    this.targets = new Map();
  }

  get mappings() { return this.app.library.settings.midiMappings ?? []; }

  async init() {
    this.targets = buildTargets(this.app);
    /** @type {Map<string, PioneerController>} input id -> driver for a recognised controller */
    this.controllers = new Map();
    if (!navigator.requestMIDIAccess) return;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      console.warn('MIDI unavailable', err);
      return;
    }
    const bind = () => {
      for (const input of this.access.inputs.values()) {
        input.onmidimessage = (e) => this.onMessage(e.data, input);
        if (input.state === 'connected') this.attach(input);
      }
      for (const [id] of this.controllers) {
        const port = this.access.inputs.get(id);
        if (!port || port.state !== 'connected') { this.controllers.delete(id); this.app.onControllerChange?.(); }
      }
    };
    bind();
    this.access.onstatechange = (e) => {
      bind();
      if (e.port.type === 'input') toast(`MIDI ${e.port.state === 'connected' ? 'connected' : 'disconnected'}: ${e.port.name}`);
    };
  }

  inputs() { return this.access ? [...this.access.inputs.values()].map((i) => i.name) : []; }

  /** Plugin and mapping for a device: an enabled plugin, else the mapping of the user's rekordbox install. */
  async profileFor(name) {
    const plugin = this.app.plugins?.forPort(name);
    if (plugin) {
      try { return { plugin, profile: await this.app.plugins.mapping(plugin) }; } catch (err) {
        toast(`Plugin ${plugin.name}: ${err.message}`, 6000);
      }
    }
    const found = await window.rb.rbMapping(name).catch(() => null);
    return found ? { plugin: null, profile: parseRekordboxMapping(found.text) } : null;
  }

  async attach(input) {
    if (this.controllers.has(input.id) || this.pending?.has(input.id)) return;
    (this.pending ??= new Set()).add(input.id);
    try {
      const { plugin, profile } = (await this.profileFor(input.name)) ?? {};
      if (!profile?.entries?.length) return;
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const output = [...this.access.outputs.values()].find((o) => norm(o.name) === norm(input.name))
        ?? [...this.access.outputs.values()].find((o) => norm(o.name).startsWith(norm(profile.device)));
      this.attachDriver(input.id, profile, (bytes) => { try { output?.send(bytes); } catch { /* port closed */ } }, input.name, plugin ?? {});
    } finally {
      this.pending.delete(input.id);
    }
  }

  /** Detach and re-attach every port (after plugins were enabled, installed or removed). */
  async reattach() {
    if (!this.access) return;
    this.controllers.clear();
    this.app.onControllerChange?.();
    for (const input of this.access.inputs.values()) if (input.state === 'connected') await this.attach(input);
  }

  /** Also used by the smoke test with a virtual port. */
  attachDriver(id, profile, send, name = profile.device, plugin = {}) {
    const driver = new PioneerController(this.app, profile, send, plugin);
    this.controllers.set(id, driver);
    driver.updateLeds(true);
    toast(`${name}: controller mapping loaded (${profile.entries.length} functions)`, 4000);
    this.app.onControllerChange?.(driver);
    return driver;
  }

  onMessage(data, input) {
    const driver = input ? this.controllers.get(input.id) : null;
    if (driver && !this.learnTarget) driver.receive(data);
    const msg = decodeMessage(data);
    if (!msg) return;
    if (this.learnTarget) {
      if (msg.press === false) return; // learn on press, ignore the release
      const target = this.learnTarget;
      const mappings = this.mappings.filter((m) => m.key !== msg.key && m.target !== target);
      mappings.push({ key: msg.key, target });
      this.app.library.setSetting('midiMappings', mappings);
      this.learnTarget = null;
      this.onLearn?.(target, msg.key);
      return;
    }
    for (const m of this.mappings) {
      if (m.key !== msg.key) continue;
      try { this.targets.get(m.target)?.run(msg); } catch (err) { console.error('MIDI action failed', m.target, err); }
    }
  }

  /** Settings section: devices, mappings table, learn. */
  renderSettings() {
    const table = h('table.shortcuts');
    const status = h('span.dim');
    const targetSel = h('select', {}, [...this.targets].map(([id, t]) => h('option', { value: id }, t.label)));
    const learnBtn = h('button.dbtn.small', {}, 'LEARN');
    const render = () => {
      table.replaceChildren(h('tr', {}, h('th', {}, 'Function'), h('th', {}, 'MIDI message'), h('th', {}, '')),
        ...this.mappings.map((m) => h('tr', {}, h('td', {}, this.targets.get(m.target)?.label ?? m.target), h('td', {}, m.key),
          h('td', {}, h('button.icon', { title: 'Delete', onclick: () => {
            this.app.library.setSetting('midiMappings', this.mappings.filter((x) => x !== m)); render();
          } }, '✕')))));
    };
    learnBtn.onclick = () => {
      if (!this.access) { status.textContent = 'Web MIDI not available'; return; }
      this.learnTarget = targetSel.value;
      learnBtn.classList.add('on');
      status.textContent = 'Move or press a control on your MIDI device…';
    };
    this.onLearn = (target, key) => { learnBtn.classList.remove('on'); status.textContent = `${this.targets.get(target).label} ← ${key}`; render(); };
    render();
    const devices = this.inputs();
    const drivers = [...(this.controllers?.values() ?? [])];
    // Live MIDI monitor: last messages and the functions they triggered.
    const monitor = h('pre.midi-monitor', {}, '—');
    const tick = setInterval(() => {
      if (!monitor.isConnected) { clearInterval(tick); return; }
      const lines = drivers.flatMap((dr) => dr.monitor.slice(-12).map((m) => `${m.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}  ${m.names.join(', ') || '(not mapped)'}`));
      monitor.textContent = lines.length ? lines.join('\n') : 'Move a control on the controller…';
    }, 200);
    const invert = h('input', { type: 'checkbox', checked: this.app.library.settings.controllerTempoInvert, onchange: (e) => this.app.library.setSetting('controllerTempoInvert', e.target.checked) });
    return h('div', {},
      h('p.dim', {}, devices.length ? `Inputs: ${devices.join(', ')}` : 'No MIDI input detected (plug a controller, it is picked up automatically).'),
      drivers.length
        ? h('div', {}, h('p', {}, `Controller mapping active: ${drivers.map((d) => d.device).join(', ')}`),
          h('label', {}, invert, ' Invert tempo slider direction'), monitor)
        : h('p.dim', {}, 'Supported automatically: controllers with a plugin (Preferences > Plugins) and any controller whose mapping is in your rekordbox install.'),
      h('h4', {}, 'MIDI learn (extra mappings)'),
      h('div.frow', {}, targetSel, learnBtn, status),
      table);
  }
}
