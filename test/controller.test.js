import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRekordboxMapping } from '../src/shared/controllers/rbcsv.js';
import { ControllerCore } from '../src/shared/controllers/core.js';

const grv6 = JSON.parse(readFileSync(new URL('../src/shared/controllers/ddj-grv6.json', import.meta.url), 'utf8'));

test('parses rekordbox mapping rows, deck channels and options', () => {
  const csv = [
    '@file,1,DDJ-TEST',
    '#name,function,type,input,deck1,deck2,deck3,deck4,output,deck1,deck2,deck3,deck4,option,comment',
    '# Deck,,,,,,,,,,,,,,',
    'PlayPause,PlayPause,Button,900B,0,1,2,3,900B,0,1,2,3,Fast;Priority=50,Play/Pause',
    'Browse,Browse,Rotary,B640,,,,,,,,,,,Browse',
    'PAD1_HotCue,PAD1.HotCue,Pad,9000,7,9,11,13,9000,7,9,11,13,Fast,HOT CUE1',
    '#,PAD1.BeatJump+Shift,Pad,9020,8,10,12,14,,,,,,Fast,No function',
    'JogRing,JogRing,JogIndicator,,,,,,,BF00,BF01,BF02,BF03,RO;Min=1;Max=72,ring',
  ].join('\n');
  const m = parseRekordboxMapping(csv);
  assert.equal(m.device, 'DDJ-TEST');
  assert.equal(m.entries.length, 4);
  assert.deepEqual(m.entries[3].outputs.map((a) => [a.status, a.data1, a.deck]), [[0xbf, 0, 0], [0xbf, 1, 1], [0xbf, 2, 2], [0xbf, 3, 3]]);
  const [play, browse, pad] = m.entries;
  assert.deepEqual(play.inputs.map((a) => [a.status, a.data1, a.deck]), [[0x90, 0x0b, 0], [0x91, 0x0b, 1], [0x92, 0x0b, 2], [0x93, 0x0b, 3]]);
  assert.equal(play.options.Priority, '50');
  assert.equal(play.options.Fast, true);
  assert.deepEqual(browse.inputs, [{ status: 0xb6, data1: 0x40, deck: null }]);
  assert.deepEqual(pad.inputs.map((a) => a.status), [0x97, 0x99, 0x9b, 0x9d]);
});

test('GRV6 profile covers the main controls', () => {
  const names = new Set(grv6.entries.map((e) => e.name));
  for (const n of ['PlayPause', 'Cue', 'JogScratch', 'JogTouch', 'TempoSlider', 'Sync', 'ChannelFader', 'CrossFader',
    'EQHigh', 'CFXParameterCH1', 'FX1-1On', 'PAD1_HotCue', 'PAD5_BeatLoop', 'DrumSwap1', 'Browse', 'Load', 'ChannelLevel']) {
    assert.ok(names.has(n), n);
  }
});

test('routes buttons per deck, hi-res knobs, encoders and jogs', () => {
  const events = [];
  const sent = [];
  const core = new ControllerCore(grv6, (e) => events.push(e), (b) => sent.push(b));
  core.receive([0x91, 0x0b, 0x7f]);                  // deck 2 play press
  core.receive([0x81, 0x0b, 0x00]);                  // note off
  assert.deepEqual(events.map((e) => [e.name, e.deck, e.press]), [['PlayPause', 1, true], ['PlayPause', 1, false]]);
  events.length = 0;
  core.receive([0xb2, 0x13, 0x40]);                  // deck 3 channel fader MSB
  core.receive([0xb2, 0x33, 0x00]);                  // LSB
  assert.equal(events.at(-1).name, 'ChannelFader');
  assert.equal(events.at(-1).deck, 2);
  assert.equal(events.at(-1).value, 0x40 << 7);
  assert.ok(Math.abs(events.at(-1).value01 - 8192 / 16383) < 1e-9);
  events.length = 0;
  core.receive([0xb6, 0x40, 0x7e]);                  // browse -2
  core.receive([0xb0, 0x22, 0x43]);                  // deck 1 jog scratch +3
  core.receive([0xb0, 0x23, 0x3e]);                  // deck 1 jog pitch bend -2
  assert.deepEqual(events.map((e) => [e.name, e.delta]), [['Browse', -2], ['JogScratch', 3], ['JogPitchBend', -2]]);
  events.length = 0;
  core.receive([0x99, 0x02, 0x7f]);                  // deck 2 pad 3 in hot cue mode
  core.receive([0x9a, 0x62, 0x7f]);                  // deck 2 shift pad 3 in beat loop mode: unmapped (#)
  core.receive([0x97, 0x62, 0x7f]);                  // deck 1 pad 3 beat loop
  assert.deepEqual(events.map((e) => [e.name, e.deck]), [['PAD3_HotCue', 1], ['PAD7_BeatLoop', 0]]);
});

test('LED output: per deck, change-only, force resend', () => {
  const sent = [];
  const core = new ControllerCore(grv6, () => {}, (b) => sent.push(b));
  assert.ok(core.output('PlayPause', 2, true));
  core.output('PlayPause', 2, true);                  // unchanged -> not resent
  core.output('PlayPause', 2, false);
  core.output('ChannelLevel', 0, 64.4);
  core.output('PAD1_HotCue', 3, 0x7f);
  // PlayPause has a normal (0x0B) and a SHIFT (0x47) entry: both LEDs follow the state.
  assert.deepEqual(sent, [[0x92, 0x0b, 0x7f], [0x92, 0x47, 0x7f], [0x92, 0x0b, 0x00], [0x92, 0x47, 0x00], [0xb0, 0x02, 64], [0x9d, 0x00, 0x7f]]);
  assert.equal(core.output('NoSuchThing', 0, true), false);
  core.resetOutputs();
  core.output('PlayPause', 2, false);
  assert.equal(sent.length, 8);
});
