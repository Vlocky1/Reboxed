// The Pioneer driver with every built-in controller plugin (GRV6, FLX2, FLX4, FLX6, FLX10): each mapped
// input is handled, and the model differences (SHIFT rows, CALL buttons, FX PART SELECT, PAD9-16) behave
// like the GRV6 where the hardware is the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGINS = fileURLToPath(new URL('../src/plugins/', import.meta.url));

/** Stand-in object: any property is another stand-in, calls are logged; `over` gives real values. */
function fake(log, path, over = {}) {
  return new Proxy(function () {}, {
    get(_t, k) {
      if (k in over) return over[k];
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (typeof k === 'symbol') return undefined;
      if (k === 'length') return 0;
      if (k === 'then') return () => fake(log, `${path}.then()`);
      return fake(log, `${path}.${k}`);
    },
    set(_t, k, v) { over[k] = v; return true; },
    apply(_t, _self, args) { log.push({ path, args }); return fake(log, `${path}()`); },
  });
}
// The driver imports UI modules that touch the DOM when loaded and when showing messages.
globalThis.document ??= fake([], 'document');
globalThis.Node ??= class {};
const { PioneerController } = await import('../src/renderer/controller/pioneer.js');

function rig(id) {
  const plugin = JSON.parse(readFileSync(`${PLUGINS}${id}/plugin.json`, 'utf8'));
  const mapping = JSON.parse(readFileSync(`${PLUGINS}${id}/${plugin.mapping}`, 'utf8'));
  const log = [];
  const decks = [0, 1, 2, 3].map((i) => ({
    index: i, loaded: true, loop: null, playing: false, scratching: false, vinyl: true, keyShift: 0, tempoPct: 0, tempoRange: 10,
    cuePoint: 0, beatLoopSize: 4, stemsReady: true, stemGains: [1, 1, 1, 1], fxParts: [false, false, false, false],
    grid: { bpm: 120, firstBeat: 0 }, track: { id: `t${i}`, gridLocked: false },
    memoryCues: () => [{ start: 1 }], hotCue: () => null, position: () => 10, slipPosition: () => null,
  }));
  const engine = fake(log, 'engine', {
    decks: decks.map((d, i) => fake(log, `deck${i}`, d)),
    channels: [0, 1, 2, 3].map((i) => fake(log, `ch${i}`, { state: { cue: false, assign: 'A' } })),
    fx: fake(log, 'fx', { target: 'ch2', beats: 1, effectId: 'ECHO', on: false }),
    masterDeck: null, colorFx: 'FILTER',
    levels: () => ({ channels: [0, 0, 0, 0] }),
  });
  const app = fake(log, 'app', {
    engine,
    deckCount: 4,
    deckViews: [0, 1, 2, 3].map((i) => fake(log, `view${i}`, { padPage: 0, samplerBank: i % 2 })),
    sampler: fake(log, 'sampler', { slots: Array.from({ length: 16 }, () => ({ buffer: null })), cue: false, isPlaying: () => false }),
    groove: [0, 1, 2, 3].map((i) => fake(log, `groove${i}`, { bank: 0, multi: false, captureArmed: false, captureBars: 1, isPlaying: () => false })),
    library: fake(log, 'library', { settings: {} }),
    padFx: [],
    ensureStems: () => true,
  });
  const sent = [];
  const ctrl = new PioneerController(app, mapping, (b) => sent.push(b), plugin);
  /** Input bytes of a mapped function (first row with that name, or with that label). */
  const addr = (name, deck = 0, label) => {
    const e = mapping.entries.find((x) => x.name === name && (label === undefined || x.label === label) && x.inputs.length);
    assert.ok(e, `${id}: no input row for ${name}`);
    const a = e.inputs.find((x) => x.deck === deck) ?? e.inputs[0];
    return [a.status, a.data1];
  };
  const press = (name, deck, label) => { const [s, d1] = addr(name, deck, label); ctrl.receive([s, d1, 0x7f]); ctrl.receive([s, d1, 0]); };
  const calls = (path) => log.filter((c) => c.path === path);
  return { ctrl, mapping, decks, engine, app, log, sent, addr, press, calls };
}

const pioneerPlugins = readdirSync(PLUGINS).filter((id) => {
  try { return JSON.parse(readFileSync(`${PLUGINS}${id}/plugin.json`, 'utf8')).driver === 'pioneer'; } catch { return false; }
});

test('every built-in Pioneer controller: all mapped inputs are handled, LEDs update', () => {
  assert.deepEqual(pioneerPlugins.sort(), ['pioneer-ddj-flx10', 'pioneer-ddj-flx2', 'pioneer-ddj-flx4', 'pioneer-ddj-flx6', 'pioneer-ddj-grv6']);
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    for (const id of pioneerPlugins) {
      const { ctrl, mapping } = rig(id);
      for (const e of mapping.entries) {
        for (const a of e.inputs) {
          const cc = (a.status & 0xf0) === 0xb0;
          ctrl.receive([a.status, a.data1, cc ? 0x41 : 0x7f]);
          ctrl.receive([a.status, a.data1, cc ? 0x3f : 0]);
        }
      }
      ctrl.updateLeds(true);
      assert.deepEqual([...ctrl.unknown], [], `${id}: functions without handling`);
    }
  } finally { console.error = origError; }
  assert.deepEqual(errors, []);
});

test('SHIFT + jog searches on every model (FLX10 SHIFT rows carry no deck column)', () => {
  for (const id of pioneerPlugins) {
    const r = rig(id);
    const deck = id.includes('flx2') || id.includes('flx4') ? 1 : 2;
    const shift = r.mapping.entries.filter((e) => e.name === 'Shift').flatMap((e) => e.inputs).find((a) => a.deck === deck || (a.deck === null && (a.status & 0x0f) === deck));
    assert.ok(shift, `${id}: SHIFT of deck ${deck + 1}`);
    r.ctrl.receive([shift.status, shift.data1, 0x7f]);
    assert.equal(r.ctrl.decks[deck].shift, true, `${id}: SHIFT held`);
    const [js, jd] = r.addr('JogScratch', deck);
    r.ctrl.receive([js, jd, 0x45]);
    assert.equal(r.calls(`deck${deck}.jogSearch`).length, 1, `${id}: SHIFT + jog = search`);
    assert.equal(r.calls(`deck${deck}.scratchMove`).length + r.calls(`deck${deck}.jogBend`).length, 0, `${id}: no scratch / bend`);
  }
});

test('CALL < >: halve / double a loop where the button doubles as LOOP 1/2X (GRV6, FLX4, FLX6); FLX10 MEMORY CUE CALL only calls', () => {
  for (const [id, resizes] of [['pioneer-ddj-grv6', true], ['pioneer-ddj-flx4', true], ['pioneer-ddj-flx6', true], ['pioneer-ddj-flx10', false]]) {
    const r = rig(id);
    r.decks[0].loop = { beats: 4 };
    r.press('Parameter1Left_HotCue', 0);
    assert.equal(r.calls('deck0.resizeLoop').length, resizes ? 1 : 0, `${id}: resize`);
    assert.equal(r.calls('deck0.callMemoryCue').length, resizes ? 0 : 1, `${id}: memory call`);
    assert.equal(r.ctrl.callResizesLoop, resizes);
  }
});

test('FX PART SELECT: GRV6 per deck with its pad-channel LEDs, FLX10 global for the Beat FX channel, none on FLX2/4/6', () => {
  // GRV6: LEDs on the pad channels, notes 0x14-0x17. On the FLX models those notes are pads (PAD FX
  // slot 5..8 on the FLX2): parts on must not light them.
  const lit = (r) => r.sent.filter(([s, d, v]) => [0x97, 0x99, 0x9b, 0x9d].includes(s) && d >= 0x14 && d <= 0x17 && v === 0x7f);
  for (const id of pioneerPlugins) {
    const r = rig(id);
    for (const d of r.decks) d.fxParts = [true, true, true, true];
    r.ctrl.updateLeds(true);
    assert.equal(lit(r).length, id === 'pioneer-ddj-grv6' ? 16 : 0, `${id}: FX PART LEDs on the pad channels`);
  }
  const flx = rig('pioneer-ddj-flx10'); // Beat FX on CH2 in the rig
  flx.press('FXPartSelectVocal', null, 'FXPartSelectVocal');
  assert.deepEqual(flx.calls('deck1.setFxPart').map((c) => c.args), [[3, true]]);
  flx.decks[1].fxParts[3] = true;
  flx.ctrl.updateLeds(true);
  assert.ok(flx.sent.some(([s, d, v]) => s === 0x96 && d === 0x1b && v === 0x7f), 'FX PART SELECT VOCAL LED on');
});

test('FLX10 PAD9-16 on its second page play the values of pads 1-8; FLX6 SAMPLE SCRATCH opens the sampler pads', () => {
  const r = rig('pioneer-ddj-flx10');
  r.press('PAD1_PadMode3', 0);
  r.press('PAD9_PadMode3', 0);
  const jumps = r.calls('deck0.beatJump').map((c) => c.args[0]);
  assert.equal(jumps.length, 2);
  assert.equal(jumps[0], jumps[1]);
  assert.ok(Number.isFinite(jumps[0]));
  r.press('PAD9_PadMode1', 0);
  assert.deepEqual(r.calls('deck0.hotCuePress').map((c) => c.args[0]), [8], 'hot cue 9');

  const f6 = rig('pioneer-ddj-flx6');
  f6.press('SampleScratch', 0);
  assert.equal(f6.calls('view0.setPadMode').at(-1)?.args[0], 'SAMPLER');
});

test('FLX10 extras: SAMPLER VOLUME / CUE, BEAT GRID SLIDE with the jog, unsupported buttons only warn', () => {
  const r = rig('pioneer-ddj-flx10');
  const [vs, vd] = r.addr('SamplerVolume', null);
  r.ctrl.receive([0xb6, vd, 0x40]);
  assert.equal(vs, 0xb6);
  assert.equal(r.calls('app.samplerView.setVolume').length, 1);
  r.press('SamplerCue', null);
  assert.deepEqual(r.calls('sampler.setCue').map((c) => c.args), [[true]]);
  const [gs, gd] = r.addr('GridSlide', 0);
  r.ctrl.receive([gs, gd, 0x7f]);
  const [js, jd] = r.addr('JogScratch', 0);
  r.ctrl.receive([js, jd, 0x42]);
  r.ctrl.receive([gs, gd, 0]);
  r.ctrl.receive([js, jd, 0x42]);
  assert.equal(r.calls('app.setTrackGrid').length, 1, 'grid moved only while SLIDE is held');
  for (const n of ['SyncRate', 'MixPointSelectNext', 'FX1-1Select.ENIGMAJET']) r.press(n, 0);
  assert.deepEqual([...r.ctrl.unknown], []);
});
