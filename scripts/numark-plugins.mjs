// Builds the Numark controller plugins (src/plugins/numark-*) from their MIDI tables.
// Numark ships no mapping file for other DJ software, so the messages below are the controllers'
// MIDI implementation as documented by the community (Mixxx mappings and device captures, numbers
// only). Re-run after changing a table: node scripts/numark-plugins.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'src', 'plugins');

/** Entry builder: one function, its address on each deck. */
function entry(name, type, addrs, { led = false, label = name } = {}) {
  const inputs = addrs.map(([status, data1, deck]) => ({ status, data1, deck }));
  return { name, label, type, inputs, outputs: led ? inputs.map((a) => ({ ...a })) : [], options: {} };
}

/** Same message on every deck: deck d on channel (offset + d). */
const perDeck = (type, decks, data1, offset = 0) => Array.from({ length: decks }, (_, d) => [type + offset + d, data1, d]);
const NOTE = 0x90; const CC = 0xb0;

/** The Numark deck layout shared by the Mixtrack FX family and the NS4FX. */
function mixtrackDeck(decks, o = {}) {
  const e = [];
  const btn = (name, data1, led = true, label) => e.push(entry(name, 'Button', perDeck(NOTE, decks, data1), { led, label }));
  const pad = (name, data1, led = true, label) => e.push(entry(name, 'Pad', perDeck(NOTE, decks, data1, 4), { led, label }));
  const knob = (name, data1) => e.push(entry(name, 'KnobSlider', perDeck(CC, decks, data1)));
  btn('PlayPause', 0x00, true, 'PLAY');
  btn('Reverse', 0x04, false, 'SHIFT+PLAY');
  btn('Cue', 0x01, true, 'CUE');
  btn('JumpToTrackStart', 0x05, false, 'SHIFT+CUE');
  btn('Sync', 0x02, true, 'SYNC');
  btn('Master', 0x03, false, 'SHIFT+SYNC');
  btn('Shift', 0x20, false, 'SHIFT');
  btn('HeadphoneCue', 0x1b, true, 'PFL');
  btn('Vinyl', 0x07, true, 'SCRATCH');
  e.push(entry('JogTouch', 'JogTouch', perDeck(NOTE, decks, 0x06)));
  e.push(entry('JogScratch', 'Rotary', perDeck(CC, decks, 0x06), { label: 'JOG' }));
  e.push(entry('TempoSlider', 'KnobSliderHiRes', perDeck(CC, decks, 0x09)));
  btn('PitchBendUp', 0x0b, true, 'PITCH BEND +');
  btn('PitchBendDown', 0x0c, true, 'PITCH BEND -');
  btn(o.keyButtons ? 'KeyUp' : 'MasterTempo', 0x2b, false, 'SHIFT+PITCH BEND +');
  btn(o.keyButtons ? 'KeyDown' : 'TempoRange', 0x2c, false, 'SHIFT+PITCH BEND -');
  pad('4BeatLoopToggle', 0x40, true, 'LOOP');
  pad('ReloopExit', 0x41, false, 'SHIFT+LOOP');
  pad('LoopHalf', 0x34, true, 'LOOP 1/2');
  pad('LoopDouble', 0x35, true, 'LOOP x2');
  pad('LoopIn', 0x36, false, 'SHIFT+LOOP 1/2');
  pad('LoopOut', 0x37, false, 'SHIFT+LOOP x2');
  for (const [k, data1] of Object.entries(o.modeNotes)) pad(`PadMode${k}`, data1, true, `PAD MODE ${k}`);
  for (let n = 1; n <= o.pads; n++) {
    pad(`PAD${n}_Current`, 0x13 + n, true, `PAD ${n}`);
    pad(`PAD${n}_Current+Shift`, 0x1b + n, false, `SHIFT+PAD ${n}`);
  }
  knob('Gain', 0x16);
  knob('EQHigh', 0x17);
  knob('EQMid', 0x18);
  knob('EQLow', 0x19);
  for (let d = 0; d < decks; d++) e.push(entry(`CFXParameterCH${d + 1}`, 'KnobSlider', [[CC + d, 0x1a, d]], { label: 'FILTER' }));
  knob('ChannelFader', 0x1c);
  e.push(entry('Load', 'Button', Array.from({ length: decks }, (_, d) => [0x9f, 0x02 + d, d]), { label: 'LOAD' }));
  return e;
}

/** Browser, crossfader and the six-button FX section of the Mixtrack FX family. */
function mixtrackGlobal(levels) {
  const g = (name, type, status, data1, label = name) => entry(name, type, [[status, data1, null]], { label });
  return [
    g('CrossFader', 'KnobSlider', 0xbf, 0x08),
    g('Browse', 'Rotary', 0xbf, 0x00, 'BROWSE'),
    g('Browse', 'Rotary', 0xbf, 0x01, 'SHIFT+BROWSE'),
    g('Forward', 'Button', 0x9f, 0x07, 'BROWSE PUSH'),
    g('Back', 'Button', 0x9f, 0x06, 'SHIFT+BROWSE PUSH'),
    g('MasterLevel', 'KnobSlider', levels.master[0], levels.master[1], 'MASTER'),
    g('HeadphonesVolume', 'KnobSlider', levels.cueGain[0], levels.cueGain[1], 'CUE GAIN'),
    g('HeadphonesMix', 'KnobSlider', levels.cueMix[0], levels.cueMix[1], 'CUE MIX'),
    g('FX1-1Select.FILTER', 'Button', 0x98, 0x00, 'FX HPF'),
    g('FX1-1Select.FILTER', 'Button', 0x98, 0x01, 'FX LPF'),
    g('FX1-1Select.FLANGER', 'Button', 0x98, 0x02, 'FX FLANGER'),
    g('FX1-1Select.ECHO', 'Button', 0x99, 0x03, 'FX ECHO'),
    g('FX1-1Select.REVERB', 'Button', 0x99, 0x04, 'FX REVERB'),
    g('FX1-1Select.PHASER', 'Button', 0x99, 0x05, 'FX PHASER'),
    g('FX1TapBeat', 'Button', 0x98, 0x09, 'TAP'),
    g('FX1TapBeat', 'Button', 0x99, 0x09, 'TAP'),
    g('FXPaddle', 'Value', 0xb8, 0x03, 'FX PADDLE'),
    g('FXPaddle', 'Value', 0xb9, 0x03, 'FX PADDLE'),
    g('FX1-1', 'KnobSlider', 0xb8, 0x04, 'FX DRY/WET'),
    g('FXBeats', 'Rotary', 0xb8, 0x05, 'FX BEATS'),
  ];
}

/** Stem buttons (MixTrack Go, Party Mix III): ACAPELLA mutes the music, INSTRUMENTAL the vocal. */
function stemButtons(decks) {
  return [
    ...['ActivePartInst', 'ActivePartBass', 'ActivePartDrums'].map((n) => entry(n, 'Button', perDeck(NOTE, decks, 0x46), { label: 'ACAPELLA', led: n === 'ActivePartInst' })),
    entry('ActivePartVocal', 'Button', perDeck(NOTE, decks, 0x48), { label: 'INSTRUMENTAL', led: true }),
  ];
}

const PLUGINS = [
  {
    id: 'numark-mixtrack-pro-fx', name: 'Numark Mixtrack Pro FX', match: ['Mixtrack Pro FX'], decks: 2,
    description: '2-deck controller: 8 pads (CUES, AUTO LOOP, FADER CUTS, SAMPLE), jog scratch, 14-bit pitch faders, FX paddles, filter knobs.',
    init: ['F0 7E 00 06 01 F7', 'F0 00 20 7F 03 01 F7'], tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'BEAT LOOP', 3: 'PAD FX', 4: 'SAMPLER', 5: 'BEAT JUMP', 6: 'SLICER' },
    entries: [...mixtrackDeck(2, { pads: 8, modeNotes: { 1: 0x00, 2: 0x0d, 3: 0x07, 4: 0x0b, 5: 0x02, 6: 0x0f } }),
      ...mixtrackGlobal({ master: [0xbe, 0x23], cueMix: [0xbe, 0x27], cueGain: [0xbe, 0x2f] })],
  },
  {
    id: 'numark-mixtrack-platinum-fx', name: 'Numark Mixtrack Platinum FX', match: ['Mixtrack Platinum FX', 'Platinum FX'], decks: 4,
    description: '4-deck controller: 8 pads (CUES, AUTO LOOP, FADER CUTS, SAMPLE), decks 3/4 with the layer buttons, jog scratch, FX paddles, filter knobs.',
    init: ['F0 7E 00 06 01 F7', 'F0 00 20 7F 03 01 F7'], tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'BEAT LOOP', 3: 'PAD FX', 4: 'SAMPLER', 5: 'BEAT JUMP', 6: 'SLICER' },
    entries: [...mixtrackDeck(4, { pads: 8, modeNotes: { 1: 0x00, 2: 0x0d, 3: 0x07, 4: 0x0b, 5: 0x02, 6: 0x0f } }),
      ...mixtrackGlobal({ master: [0xbe, 0x23], cueGain: [0xbf, 0x0c], cueMix: [0xbf, 0x0d] })],
  },
  {
    id: 'numark-ns4fx', name: 'Numark NS4FX', match: ['NS4FX'], decks: 4,
    description: '4-deck controller: 4 performance pads with 8 modes, 4 transport pads, decks 3/4, jog scratch, key up/down with SHIFT + pitch bend.',
    init: ['F0 00 01 3F 7F 3A 60 00 04 04 01 00 00 F7', 'F0 00 20 7F 03 01 F7'], tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'BEAT LOOP', 3: 'PAD FX', 4: 'SAMPLER', 5: 'KEYBOARD', 6: 'PAD FX2', 7: 'SLICER', 8: 'BEAT JUMP' },
    entries: [
      ...mixtrackDeck(4, { pads: 4, keyButtons: true, modeNotes: { 1: 0x00, 2: 0x0d, 3: 0x07, 4: 0x0b, 5: 0x02, 6: 0x06, 7: 0x0e, 8: 0x0f } }),
      // Transport pads under the performance pads.
      entry('Cue', 'Pad', perDeck(NOTE, 4, 0x18, 4), { label: 'CUE PAD', led: true }),
      entry('JumpToTrackStart', 'Pad', perDeck(NOTE, 4, 0x19, 4), { label: 'START PAD' }),
      entry('SearchRev', 'Pad', perDeck(NOTE, 4, 0x1a, 4), { label: 'REWIND PAD' }),
      entry('SearchFwd', 'Pad', perDeck(NOTE, 4, 0x1b, 4), { label: 'FAST FORWARD PAD' }),
      ...mixtrackGlobal({ master: [0xbf, 0x0a], cueGain: [0xbf, 0x0c], cueMix: [0xbf, 0x0d] }),
    ],
  },
  {
    id: 'numark-dj2go2-touch', name: 'Numark DJ2GO2 Touch', match: ['DJ2GO2'], decks: 2,
    description: 'Pocket 2-deck controller: touch jogs, 4 pads per deck (CUES, AUTO LOOP, MANUAL LOOP, SAMPLER), level knobs, browse.',
    init: ['F0 00 01 3F 3C 48 F7'], padsSetMode: true, tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'BEAT LOOP', 4: 'SAMPLER' },
    entries: (() => {
      const e = [];
      const b = (name, data1, label, led = true) => e.push(entry(name, 'Button', perDeck(NOTE, 2, data1), { label, led }));
      b('PlayPause', 0x00, 'PLAY'); b('Cue', 0x01, 'CUE'); b('Sync', 0x02, 'SYNC'); b('HeadphoneCue', 0x1b, 'PFL');
      e.push(entry('JogTouch', 'JogTouch', perDeck(NOTE, 2, 0x06)));
      e.push(entry('JogScratch', 'Rotary', perDeck(CC, 2, 0x06), { label: 'JOG' }));
      e.push(entry('TempoSlider', 'KnobSlider', perDeck(CC, 2, 0x09)));
      e.push(entry('ChannelFader', 'KnobSlider', perDeck(CC, 2, 0x16), { label: 'LEVEL' }));
      for (let n = 1; n <= 4; n++) {
        e.push(entry(`PAD${n}_PadMode1`, 'Pad', perDeck(NOTE, 2, n, 4), { label: `CUES ${n}`, led: true }));
        e.push(entry(`PAD${n}_PadMode1+Shift`, 'Pad', perDeck(NOTE, 2, 0x08 + n, 4), { label: `CUES ${n} (delete)` }));
        e.push(entry(`PAD${n}_PadMode2`, 'Pad', perDeck(NOTE, 2, 0x10 + n, 4), { label: `AUTO LOOP ${n}`, led: true }));
        e.push(entry(`PAD${n}_PadMode4`, 'Pad', perDeck(NOTE, 2, 0x30 + n, 4), { label: `SAMPLER ${n}`, led: true }));
      }
      e.push(entry('LoopIn', 'Pad', perDeck(NOTE, 2, 0x21, 4), { label: 'MANUAL LOOP IN', led: true }));
      e.push(entry('LoopOut', 'Pad', perDeck(NOTE, 2, 0x22, 4), { label: 'MANUAL LOOP OUT', led: true }));
      e.push(entry('ReloopExit', 'Pad', perDeck(NOTE, 2, 0x23, 4), { label: 'MANUAL LOOP ON/OFF', led: true }));
      e.push(entry('ReloopExit', 'Pad', perDeck(NOTE, 2, 0x24, 4), { label: 'MANUAL RELOOP' }));
      e.push(entry('Load', 'Button', [[0x9f, 0x02, 0], [0x9f, 0x03, 1]], { label: 'LOAD' }));
      const g = (name, type, status, data1, label) => e.push(entry(name, type, [[status, data1, null]], { label }));
      g('CrossFader', 'KnobSlider', 0xbf, 0x08, 'CROSSFADER');
      g('MasterLevel', 'KnobSlider', 0xbf, 0x0a, 'MASTER');
      g('HeadphonesVolume', 'KnobSlider', 0xbf, 0x0c, 'CUE LEVEL');
      g('Browse', 'Rotary', 0xbf, 0x00, 'BROWSE');
      g('Forward', 'Button', 0x9f, 0x06, 'BROWSE PUSH');
      return e;
    })(),
  },
  {
    id: 'numark-mixtrack-go', name: 'Numark MixTrack Go', match: ['Mixtrack Go'], decks: 2,
    description: '2-deck controller: 4 pads per deck (one PAD MODE button: CUES, LOOPS, SAMPLER, STEMS), ACAPELLA / INSTRUMENTAL stem buttons, FADE FX, touch jogs.',
    init: ['F0 7E 7F 06 01 F7', 'F0 00 20 7F 03 01 F7'], tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'BEAT LOOP', 3: 'SAMPLER', 4: 'STEMS' },
    padModeCycle: ['HOT CUE', 'BEAT LOOP', 'SAMPLER', 'STEMS'],
    entries: (() => {
      const e = [];
      const b = (name, data1, label, led = true) => e.push(entry(name, 'Button', perDeck(NOTE, 2, data1), { label, led }));
      b('PlayPause', 0x00, 'PLAY'); b('Reverse', 0x04, 'SHIFT+PLAY', false);
      b('Cue', 0x01, 'CUE'); b('JumpToTrackStart', 0x05, 'SHIFT+CUE', false);
      b('Sync', 0x02, 'SYNC'); b('Master', 0x03, 'SHIFT+SYNC', false);
      b('HeadphoneCue', 0x1b, 'PFL');
      e.push(...stemButtons(2));
      e.push(entry('JogTouch', 'JogTouch', perDeck(NOTE, 2, 0x50)));
      e.push(entry('JogScratch', 'Rotary', perDeck(CC, 2, 0x06), { label: 'JOG' }));
      e.push(entry('JogSearch', 'Rotary', perDeck(CC, 2, 0x2b), { label: 'SHIFT+JOG' }));
      e.push(entry('TempoSlider', 'KnobSliderHiRes', perDeck(CC, 2, 0x09)));
      e.push(entry('ChannelFader', 'KnobSlider', perDeck(CC, 2, 0x16), { label: 'LEVEL' }));
      for (let d = 0; d < 2; d++) e.push(entry(`CFXParameterCH${d + 1}`, 'KnobSlider', [[CC + d, 0x1a, d]], { label: 'FILTER' }));
      e.push(entry('Load', 'Button', [[0x9f, 0x02, 0], [0x9f, 0x03, 1]], { label: 'LOAD', led: true }));
      e.push(entry('PadModeSelect', 'Button', perDeck(NOTE, 2, 0x00, 4), { label: 'PAD MODE' }));
      // Mode LEDs (outputs only) next to the PAD MODE button.
      for (let k = 1; k <= 4; k++) e.push({ name: `PadMode${k}`, label: `MODE LED ${k}`, type: 'Indicator', inputs: [], outputs: perDeck(NOTE, 2, k, 4).map(([status, data1, deck]) => ({ status, data1, deck })), options: {} });
      for (let n = 1; n <= 4; n++) {
        e.push(entry(`PAD${n}_Current`, 'Pad', perDeck(NOTE, 2, 0x13 + n, 4), { label: `PAD ${n}`, led: true }));
        e.push(entry(`PAD${n}_Current+Shift`, 'Pad', perDeck(NOTE, 2, 0x1b + n, 4), { label: `SHIFT+PAD ${n}` }));
      }
      const g = (name, type, status, data1, label) => e.push(entry(name, type, [[status, data1, null]], { label }));
      g('CrossFader', 'KnobSlider', 0xbf, 0x08, 'CROSSFADER');
      g('MasterLevel', 'KnobSlider', 0xbf, 0x0a, 'MASTER');
      g('HeadphonesVolume', 'KnobSlider', 0xbf, 0x0c, 'CUE LEVEL');
      g('FX1-1On', 'Button', 0x9f, 0x46, 'FADE FX');
      g('Browse', 'Rotary', 0xbf, 0x00, 'BROWSE');
      g('Browse', 'Rotary', 0xbf, 0x01, 'SHIFT+BROWSE');
      g('Forward', 'Button', 0x9f, 0x07, 'BROWSE PUSH');
      return e;
    })(),
  },
  {
    // No MIDI table published for the Party Mix III yet: the Party Mix II layout (its predecessor),
    // with the MixTrack Go's stem buttons and pads 5-8 where the Numark layout puts them.
    id: 'numark-party-mix-iii', name: 'Numark Party Mix III', match: ['Party Mix', 'PartyMix'], decks: 2,
    description: '2-deck party controller: 8 pads (CUES, SAMPLER, AUTO LOOP, EFFECTS), stem buttons, filter and EQ, touch jogs. From the Party Mix II layout: not yet checked on the hardware.',
    init: ['F0 00 20 7F 03 01 F7'], tempoInvert: true,
    padModes: { 1: 'HOT CUE', 2: 'SAMPLER', 3: 'BEAT LOOP', 4: 'PAD FX' },
    entries: (() => {
      const e = [];
      const b = (name, data1, label, led = true) => e.push(entry(name, 'Button', perDeck(NOTE, 2, data1), { label, led }));
      b('PlayPause', 0x00, 'PLAY'); b('Cue', 0x01, 'CUE'); b('Sync', 0x02, 'SYNC'); b('HeadphoneCue', 0x1b, 'PFL');
      e.push(...stemButtons(2));
      e.push(entry('JogTouch', 'JogTouch', perDeck(NOTE, 2, 0x06)));
      e.push(entry('JogScratch', 'Rotary', perDeck(CC, 2, 0x06), { label: 'JOG' }));
      e.push(entry('TempoSlider', 'KnobSlider', perDeck(CC, 2, 0x09)));
      e.push(entry('Gain', 'KnobSlider', perDeck(CC, 2, 0x17)));
      e.push(entry('EQHigh', 'KnobSlider', perDeck(CC, 2, 0x18), { label: 'TREBLE' }));
      e.push(entry('EQLow', 'KnobSlider', perDeck(CC, 2, 0x19), { label: 'BASS' }));
      for (let d = 0; d < 2; d++) e.push(entry(`CFXParameterCH${d + 1}`, 'KnobSlider', [[CC + d, 0x1a, d]], { label: 'FILTER' }));
      e.push(entry('ChannelFader', 'KnobSlider', perDeck(CC, 2, 0x1c)));
      e.push(entry('Load', 'Button', [[0x9f, 0x02, 0], [0x9f, 0x03, 1]], { label: 'LOAD' }));
      [[1, 0x00], [2, 0x0b], [3, 0x0e], [4, 0x0f]].forEach(([k, data1]) => e.push(entry(`PadMode${k}`, 'Pad', perDeck(NOTE, 2, data1, 4), { label: `PAD MODE ${k}`, led: true })));
      for (let n = 1; n <= 8; n++) {
        e.push(entry(`PAD${n}_Current`, 'Pad', perDeck(NOTE, 2, 0x13 + n, 4), { label: `PAD ${n}`, led: true }));
        if (n <= 4) e.push(entry(`PAD${n}_Current+Shift`, 'Pad', perDeck(NOTE, 2, 0x1b + n, 4), { label: `SHIFT+PAD ${n}` }));
      }
      const g = (name, type, status, data1, label) => e.push(entry(name, type, [[status, data1, null]], { label }));
      g('CrossFader', 'KnobSlider', 0xbf, 0x08, 'CROSSFADER');
      g('MasterLevel', 'KnobSlider', 0xbf, 0x0a, 'MASTER');
      g('HeadphonesVolume', 'KnobSlider', 0xbf, 0x0c, 'CUE GAIN');
      g('HeadphonesMix', 'KnobSlider', 0xbf, 0x0d, 'CUE MIX');
      g('FX1-1On', 'Button', 0x9f, 0x46, 'FADE FX');
      g('Browse', 'Rotary', 0xbf, 0x00, 'BROWSE');
      g('Forward', 'Button', 0x9f, 0x07, 'BROWSE PUSH');
      return e;
    })(),
  },
];

for (const p of PLUGINS) {
  const { entries, id, name, description, match, decks, ...extra } = p;
  const dir = join(OUT, id);
  await mkdir(dir, { recursive: true });
  const plugin = { id, name, version: '1.0.0', author: 'Reboxed', kind: 'controller', description, match, driver: 'pioneer', mapping: 'mapping.json', decks, ...extra };
  await writeFile(join(dir, 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`);
  await writeFile(join(dir, 'mapping.json'), JSON.stringify({ device: name.replace(/^Numark /, ''), entries }));
  console.log(`${id}: ${entries.length} functions`);
}
