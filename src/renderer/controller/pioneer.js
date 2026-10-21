// Pioneer DJ controller driver (rekordbox mapping functions -> Reboxed actions, plus LEDs).
// Built for the DDJ-GRV6 profile; most function names are shared by other Pioneer controllers,
// so a rekordbox .midi.csv for another model works for the functions it has in common.
import { ControllerCore } from '../../shared/controllers/core.js';
import { BEAT_FX, stepFxBeats } from '../audio/fx.js';
import { COLOR_FX } from '../ui/mixer-view.js';
import { constantGridAt, shiftGrid, tapBpm } from '../../shared/beatgrid.js';
import { mediaUrl } from '../analysis/analyzer.js';
import { toast } from '../ui/dom.js';
import { padValue } from '../../shared/pad-tables.js';

const fmtBeat = (b) => (b >= 1 ? String(Math.round(b * 100) / 100) : `1/${Math.round(1 / b)}`);

const FX_SELECT = {
  DELAY: 'DELAY', ECHO: 'ECHO', LOWCUTECHO: 'LOW CUT ECHO', SPIRAL: 'SPIRAL', HELIX: 'HELIX', REVERB: 'REVERB',
  FLANGER: 'FLANGER', PHASER: 'PHASER', FILTER: 'FILTER', TRANS: 'TRANS', PITCH: 'PITCH', ROLL: 'ROLL',
  MOBIUSSAW: 'MOBIUS SAW', MOBIUSTRI: 'MOBIUS TRI',
  // DDJ-FLX10 effects Reboxed does not have: the closest one.
  MTDELAY: 'DELAY', SLIPROLL: 'ROLL',
};
// Functions with no equivalent in Reboxed: said once (with what they are), then ignored.
const UNSUPPORTED = [
  [/^SmartFader$/, 'SMART FADER'],
  [/^SyncRate$/, 'SYNC RATE'],
  [/^MixPoint(Select(Prev|Next)|Link(Exit|Deck|Silent))$/, 'MIX POINT LINK (select / exit / deck / silent)'],
  [/^FX1-[23](On)?$|^Fx\d-\d_BeatTarget$/, 'Beat FX multi mode (Reboxed has one Beat FX)'],
  [/^FX1-1Select\.(ENIGMAJET|STRETCH)$/, 'this Beat FX (ENIGMA JET / STRETCH)'],
];
// Beat value list the controller's FX beat display is indexed by (rekordbox's, with 3/4).
const RB_FX_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16, 32];
const DRUM_ROLL = { DrumRoll1_8: 1 / 8, DrumRoll1_4: 1 / 4, DrumRoll1_2: 1 / 2, DrumRoll1: 1 };
const DRUM_TRANS = { DrumTrans1_8: 1 / 8, DrumTrans1_4: 1 / 4, DrumTrans1_2: 1 / 2, DrumTrans1: 1 };
// PART ISOLATOR knobs -> isolator band (Deck.ISO_PARTS: 0 HI vocal, 1 MID inst + bass, 2 LOW drums).
const PART_KNOBS = { PartIsolatorVocal: 0, PartIsolatorInst: 1, PartIsolatorDrums: 2 };
const ACTIVE_PART = { ActivePartVocal: 3, ActivePartInst: 2, ActivePartBass: 1, ActivePartDrums: 0 };
// Part -> stem index (Deck stems: 0 drums, 1 bass, 2 inst, 3 vocal).
const PART_STEM = { Vocal: 3, Inst: 2, Bass: 1, Drums: 0 };
// Controllers with generic pad functions (PadMode1..8, PADn_PadModeN): what each mode is. Plugin
// option "padModes"; this default is the DDJ-FLX10 layout (from its rekordbox mapping comments).
export const DEFAULT_PAD_MODES = { 1: 'HOT CUE', 2: 'PAD FX', 3: 'BEAT JUMP', 4: 'SAMPLER', 5: 'KEYBOARD', 6: 'PAD FX2', 7: 'BEAT LOOP', 8: 'KEY SHIFT' };
const MODE_KIND = { 'HOT CUE': 'HotCue', 'PAD FX': 'PadFx1', 'PAD FX2': 'PadFx2', 'BEAT JUMP': 'BeatJump', 'BEAT LOOP': 'BeatLoopPads', SAMPLER: 'Sampler', KEYBOARD: 'Keyboard', 'KEY SHIFT': 'KeyShift', STEMS: 'Stems', SLICER: 'Slicer', 'MEMORY CUE': 'MemoryCue' };
// Same function under another name on some models.
const ALIAS = {
  'FX1-1BeatDown': 'FX1BeatDown', 'FX1-1BeatUp': 'FX1BeatUp', '4BeatLoop': '4BeatLoopToggle',
  ActivePartButtonDrums: 'ActivePartDrums', ActivePartButtonVocal: 'ActivePartVocal', ActivePartButtonInst: 'ActivePartInst',
  SampleScratch: 'Sampler', // DDJ-FLX6 SAMPLE SCRATCH mode: the sampler pads
};
/** One Beat FX unit in Reboxed: FX2 controls drive it too; Parameter2 = Parameter1 pages. */
export function normalizeFunction(name) {
  if (ALIAS[name]) return ALIAS[name];
  if (/^FX2/.test(name)) return normalizeFunction(name.replace(/^FX2/, 'FX1'));
  if (/^Parameter2(Left|Right)_/.test(name)) return name.replace('Parameter2', 'Parameter1');
  if (/^PAD(\d+)_SampleScratch(\+Shift)?$/.test(name)) return name.replace('SampleScratch', 'Sampler');
  return name;
}
// Controller-side preferences and timing parameters: nothing to do in Reboxed.
const IGNORED = /Setting$|^(JogIndicatorInterval|JogRatency|MidiOutInterval|FailSafeState|DemoModeSetting|AutoStandbySetting|InputSelect\.|PeerUsbPortName\.|ShiftFuncDisp|MicFX|DDJFXOn|DrumsPartInstDoubles|VocalPartInstDoubles|InstPartInstDoubles|JogCutterMode|JogJogCutterScratch|SamplerRoutingSwitch|MFX)/;
// Pad mode buttons (rekordbox function names) -> the pad page they open in Reboxed.
const MODES = { HotCue: 'HOT CUE', Keyboard: 'KEYBOARD', Stems: 'STEMS', PadFx1: 'PAD FX', PadFx2: 'PAD FX2', BeatJump: 'BEAT JUMP', BeatLoop: 'BEAT LOOP', Sampler: 'SAMPLER', KeyShift: 'KEY SHIFT', Slicer: 'SLICER', SequenceCall: 'SEQ CALL', MemoryCue: 'MEMORY CUE' };

export class PioneerController {
  /**
   * @param {object} app Reboxed App
   * @param {{device: string, entries: object[]}} profile
   * @param {(bytes: number[]) => void} send MIDI output
   * @param {object} [plugin] controller plugin manifest (padModes, fxPartPadStatus, ...)
   */
  constructor(app, profile, send, plugin = {}) {
    this.app = app;
    this.plugin = plugin;
    this.padModes = plugin.padModes ?? DEFAULT_PAD_MODES;
    // Pad channel of each deck, for FX PART SELECT rows without a deck column (DDJ-GRV6 only).
    this.padStatus = plugin.fxPartPadStatus ?? [];
    // CALL ◀ ▶ double as LOOP 1/2X / 2X when the mapping puts LoopHalf on the same button (GRV6,
    // FLX4, FLX6); the DDJ-FLX10 has separate MEMORY CUE CALL buttons.
    const label = (n) => profile.entries.find((e) => e.name === n)?.label;
    this.callResizesLoop = !!label('LoopHalf') && label('LoopHalf') === label('Parameter1Left_HotCue');
    this.warned = new Set();
    this.unknown = new Set(); // mapped functions the driver has no handling for
    this.device = profile.device;
    this.core = new ControllerCore(profile, (ev) => this.handle(ev), send);
    this.decks = [0, 1, 2, 3].map(() => ({
      shift: false, mode: 'HOT CUE', taps: [], loadAt: 0, tempoCaught: false,
    }));
    this.fxTaps = [];
    this.lastLed = 0;
    this.monitor = [];
  }

  get engine() { return this.app.engine; }
  deck(i) { return this.engine.decks[i]; }
  ctl(id) { return this.app.mixer.controls.get(id); }

  receive(bytes) {
    const events = this.core.receive(bytes);
    this.monitor.push({ t: performance.now(), bytes, names: events.map((e) => `${e.name}${e.deck !== null ? `[${e.deck + 1}]` : ''}`) });
    if (this.monitor.length > 40) this.monitor.shift();
    return events;
  }

  // ---- input --------------------------------------------------------------------------------

  handle(ev) {
    try { this.dispatch(ev); } catch (err) { console.error('controller', ev.name, err); }
  }

  dispatch(ev) {
    const { press } = ev;
    const name = normalizeFunction(ev.name);
    if (IGNORED.test(name)) return;
    const missing = UNSUPPORTED.find(([re]) => re.test(name));
    if (missing) { if (press && !this.warned.has(missing[1])) { this.warned.add(missing[1]); toast(`${missing[1]}: not available in Reboxed`, 2500); } return; }
    // SHIFT rows without deck columns (DDJ-FLX10): one row per MIDI channel.
    const i = ev.deck ?? (name === 'Shift' && ev.raw && (ev.raw[0] & 0x0f) < 4 ? ev.raw[0] & 0x0f : null);
    const d = i !== null ? this.deck(i) : null;
    const s = i !== null ? this.decks[i] : null;
    const app = this.app;
    const browser = app.browser;
    const fx = this.engine.fx;

    // Pads: PADn_<Mode>[+Shift]
    const pad = /^PAD(\d+)_(HotCue|BeatJump|Sampler|Keyboard|PadFx1|PadFx2|BeatLoop|KeyShift|Slicer|MemoryCue)(\+Shift)?$/.exec(name);
    if (pad && d) { this.padEvent(i, Number(pad[1]), pad[2], !!pad[3], press); return; }
    // Generic pads: PADn_PadModeM, their meaning comes from the plugin's padModes.
    const gpad = /^PAD(\d+)_PadMode(\d)(\+Shift)?$/.exec(name);
    if (gpad && d) { const kind = MODE_KIND[this.padModes[gpad[2]]]; if (kind) this.padEvent(i, Number(gpad[1]), kind, !!gpad[3], press); return; }
    const gmode = /^PadMode(\d)$/.exec(name);
    if (gmode && d) { if (press && this.padModes[gmode[1]]) this.setMode(i, this.padModes[gmode[1]]); return; }
    const gpage = /^Page(Left|Right)_PadMode\d$/.exec(name);
    if (gpage && s) { if (press) this.turnPage(i, gpage[1] === 'Left' ? -1 : 1); return; }
    const cfxN = /^CFX(\d)On$/.exec(name);
    if (cfxN) { if (press) this.setCfx(COLOR_FX[Number(cfxN[1]) - 1] ?? 'FILTER'); return; }
    const xfAssign = /^CrossfaderAssign\.(A|Thru|B)$/.exec(name);
    if (xfAssign && i !== null) { if (press) { this.engine.setAssign(i, xfAssign[1] === 'Thru' ? 'thru' : xfAssign[1]); this.app.mixer?.refresh?.(); } return; }
    const sort = /^Sort(BPM|SONG|KEY|ARTIST)$/.exec(name);
    if (sort) { if (press) { const col = { BPM: 'bpm', SONG: 'title', KEY: 'key', ARTIST: 'artist' }[sort[1]]; browser.sort = { col, dir: browser.sort?.col === col ? -browser.sort.dir : 1 }; browser.refreshRows(); } return; }
    const param = /^Parameter1(Left|Right)_(HotCue|BeatJump|Keyboard|KeyShift)$/.exec(name);
    if (param && d) {
      if (!press) return;
      const dir = param[1] === 'Left' ? -1 : 1;
      // CALL ◀ ▶ arrive here when the controller thinks no loop plays (it picks the message from the
      // GetLoopActive indicator): same handling as LoopHalf / LoopDouble either way.
      if (param[2] === 'HotCue') { if (this.callResizesLoop) this.callOrResize(i, dir); else this.callMemory(i, dir); } else this.turnPage(i, dir);
      return;
    }
    if (FX_SELECT[name.replace('FX1-1Select.', '')] && name.startsWith('FX1-1Select.')) { if (press) fx.setEffect(FX_SELECT[name.slice(12)]); return; }
    if (name.startsWith('FX1Assign.')) { if (press) fx.setTarget(name === 'FX1Assign.MASTER' ? 'master' : name === 'FX1Assign.SAMPLER' ? 'sampler' : `ch${name.slice(-1)}`); return; }
    if (/^CFXParameterCH\d$/.test(name)) { this.ctl(`ch${name.slice(-1)}.color`)?.apply(ev.value01); return; }
    // DRUM ROLL 1/8 1/4 1/2 1: the drum captured by the first button keeps rolling while any of the
    // four is held; the last one pressed sets the length.
    if (DRUM_ROLL[name] !== undefined && d) {
      s.rolls ??= [];
      s.rolls = s.rolls.filter((n) => n !== name);
      if (press) s.rolls.push(name);
      const held = s.rolls.at(-1);
      if (held) { if (this.requireStems(d)) d.drumRoll(DRUM_ROLL[held], s.rolls.length > 1 || !press); } else d.drumRoll(null);
      s.roll = held ?? null;
      return;
    }
    if (DRUM_TRANS[name] !== undefined && d) { this.requireStems(d) && d.drumTrans(press ? DRUM_TRANS[name] : null); s.trans = press ? name : null; return; }
    // PART ISOLATOR knobs (the EQ knobs while the controller's PART ISOLATOR is on): HI vocal, MID inst + bass, LOW drums.
    if (PART_KNOBS[name] !== undefined && d) { this.requireStems(d); d.setIsoKnob(PART_KNOBS[name], ev.value01); return; }
    if (ACTIVE_PART[name] !== undefined && d) { if (press && this.requireStems(d)) d.setStemOn(ACTIVE_PART[name], d.stemGains[ACTIVE_PART[name]] === 0); return; }
    if (/^FXPartSelect(Vocal|Inst|Bass|Drums)On$/.test(name)) {
      // Beat FX on chosen parts only (GRV6: per deck, on the deck's pad channel).
      if (!press) return;
      const stem = PART_STEM[/Select(\w+?)On/.exec(name)[1]];
      const deckIdx = ev.raw ? this.padStatus.indexOf(ev.raw[0]) : -1;
      const dk = this.deck(deckIdx);
      if (!dk) return;
      this.requireStems(dk);
      dk.setFxPart(stem, !dk.fxParts[stem]);
      return;
    }
    // DDJ-FLX10 FX PART SELECT: global buttons, for the deck(s) the Beat FX is assigned to.
    const gpart = /^FXPartSelect(Vocal|Inst|Bass|Drums)$/.exec(name);
    if (gpart) { if (press) this.fxPartForFx(PART_STEM[gpart[1]]); return; }
    if (MODES[name] && d) { if (press) this.setMode(i, MODES[name]); return; }
    const swap = /^DrumSwap([1-4])$/.exec(name);
    // Built-in loops play right away; the track's own drums are replaced as soon as stems exist.
    // With DRUM CAPTURE armed, the slot pressed receives the track's drums instead (rekordbox).
    if (swap && d) {
      if (!press) return;
      const g = app.groove[i];
      if (g.captureArmed) { g.armCapture(false); app.drumCapture(i, Number(swap[1]) - 1); return; }
      this.requireStems(d);
      g.toggle(Number(swap[1]) - 1);
      return;
    }

    switch (name) {
      // ---- browser
      case 'Browse': browser.browseMove(ev.delta); break;
      case 'Zoom': app.zoom = Math.max(1, Math.min(32, app.zoom * (ev.delta > 0 ? 1 / 1.15 : 1.15) ** Math.abs(ev.delta))); break;
      case 'Forward': if (press) browser.browsePress(); break;
      case 'Back': if (press) browser.browseBack(); break;
      case 'Area': if (press) browser.setFocus(browser.focusArea === 'tree' ? 'list' : 'tree'); break;
      case 'AreaLeft': case 'AreaLeftEdge': if (press) browser.setFocus('tree'); break;
      case 'AreaRight': case 'AreaRightEdge': if (press) browser.setFocus('list'); break;
      case 'SwitchActiveWindow': if (press) app.toggleLayout(); break;
      case 'AddToTagList': if (press) { const id = browser.currentTrackId(); if (id) { app.library.addToTagList([id]); toast('Added to Tag List'); } } break;
      case 'RelatedTracks': if (press) browser.select('related'); break;
      case 'Discover': if (press) browser.select('suggest'); break;
      case 'BrowseJumpUp': if (press) browser.pageJump(-1); break;
      case 'BrowseJumpDown': if (press) browser.pageJump(1); break;
      case 'BrowseJumpTop': if (press) browser.pageJump(-1, true); break;
      case 'BrowseJumpBottom': if (press) browser.pageJump(1, true); break;
      case 'PlayPausePreview': if (press) { const t = app.library.get(browser.currentTrackId()); if (t) this.engine.preview(mediaUrl(t.path)); } break;
      case 'SkipPreview': if (press) this.engine.previewSkip(10); break;
      case 'Load': if (press && d) this.load(i); break;
      case 'SamplerPanel': case 'PanelForward': if (press) app.toggleSampler(); break;
      case 'ForwardAndLoad': if (press) browser.browsePress(); break;
      case 'MixPointLink': if (press) app.library.setSetting('mixPointLink', !app.library.settings.mixPointLink); break;
      // Mixer sections of the all-in-one controllers.
      case 'HeadphonesMix': this.ctl('phones.mix')?.apply(ev.value01); break;
      case 'HeadphonesVolume': this.ctl('phones.level')?.apply(ev.value01); break;
      case 'MasterLevel': this.ctl('master.level')?.apply(ev.value01); break;
      case 'SmartCFX': if (press) this.toggleCfx(); break;
      case 'SmartCFXSelect': if (press) this.cycleCfx(1); break;
      case 'SmartCFXSelectBack': if (press) this.cycleCfx(-1); break;
      case 'SamplerVolume': app.samplerView.setVolume(ev.value01 * 1.2); break;
      case 'SamplerCue': if (press) app.sampler.setCue(!app.sampler.cue); break;
      case 'FX1-1Select': case 'FX1-1SelectBack': if (press) {
        const ids = BEAT_FX.map((x) => x.id);
        fx.setEffect(ids[(ids.indexOf(fx.effectId) + (name.endsWith('Back') ? ids.length - 1 : 1)) % ids.length]);
        toast(`Beat FX: ${fx.effectId}`, 1200);
      } break;

      // ---- transport
      case 'PlayPause': if (press) d.playPause(); break;
      case 'Cue': if (press) d.cueDown(); else d.cueUp(); break;
      case 'JumpToTrackStart': if (press) d.jumpToStart(); break;
      // SHIFT + jog = fast search only: touching the platter with SHIFT never starts a scratch.
      case 'JogTouch': if (press && !s.shift) { if (d.vinyl) d.scratchStart(); } else d.scratchEnd(); break;
      case 'JogScratch': if (s.grid) this.gridJog(i, ev.delta); else if (s.shift) d.jogSearch(ev.delta); else if (d.scratching) d.scratchMove(ev.delta); else d.jogBend(ev.delta); break;
      case 'JogPitchBend': case 'WheelPitchBend': if (s.grid) this.gridJog(i, ev.delta); else if (s.shift) d.jogSearch(ev.delta); else d.jogBend(ev.delta); break;
      // BEAT GRID ADJUST / SLIDE held (DDJ-FLX10): the jog changes the BPM / moves the grid.
      case 'GridAdjust': case 'GridSlide': s.grid = press ? (name === 'GridAdjust' ? 'adjust' : 'slide') : null; break;
      case 'WheelSearch': case 'JogSearch': d.jogSearch(ev.delta); break;
      case 'TempoReset': if (press) d.setTempoPct(0); break;
      case 'Reverse': if (press) d.setReverse(!d.reverse); break;
      case 'SlipReverse': if (press) d.censorDown(); else d.censorUp(); break;
      case 'Jump4Prev': if (press) d.beatJump(-4); break;
      case 'Jump4Fwd': if (press) d.beatJump(4); break;
      case 'Jump16Prev': if (press) d.beatJump(-16); break;
      case 'Jump16Fwd': if (press) d.beatJump(16); break;
      case 'SearchRev': if (press) d.seek(Math.max(0, d.position() - 4)); break;
      case 'SearchFwd': if (press) d.seek(d.position() + 4); break;
      case 'VinylState': d.vinyl = !!press; break;
      case '4BeatLoopToggle': if (press) { if (d.loop) d.exitLoop(); else d.beatLoop(4); } break;
      case 'PadModeSelect': if (press) { const cycle = ['HOT CUE', 'PAD FX', 'BEAT JUMP', 'SAMPLER']; this.setMode(i, cycle[(cycle.indexOf(s.mode) + 1) % cycle.length]); } break;
      case 'TempoSlider': this.tempo(i, ev.value01); break;
      case 'MasterTempo': if (press) d.toggleKeyLock(); break;
      case 'TempoRange': if (press) { const r = [6, 10, 16, 100]; d.setTempoRange(r[(r.indexOf(d.tempoRange) + 1) % r.length]); s.tempoCaught = false; } break;
      case 'Sync': if (press) d.toggleSync(); break;
      case 'Master': if (press) this.engine.setMasterDeck(i); break;
      case 'KeySync': if (press) d.toggleKeySync(); break;
      case 'KeyReset': if (press) d.setKeyShift(0); break;
      case 'Shift': s.shift = press; if (press && d.scratching) d.scratchEnd(); break;
      // LOOP IN held: an auto beat loop of the chosen size, from where the button was first pressed
      // (the long press is only recognised about a second later).
      case 'LoopIn': if (press) { d.loopIn(); s.loopInAt = d.pendingLoopIn; } break;
      case '4BeatLoopLongPress': if (press) { d.beatLoopFrom(s.loopInAt ?? d.position(), d.beatLoopSize); s.loopInAt = null; toast(`Deck ${i + 1}: loop ${fmtBeat(d.beatLoopSize)} beats`, 1200); } break;
      case 'LoopOut': if (press) d.loopOut(); break;
      case 'ReloopExit': case 'ActiveLoop': if (press) d.reloopExit(); break;
      // CALL ◀ ▶: halve / double the loop that plays; without a loop, call the memory cues (rekordbox).
      case 'LoopHalf': case 'LoopDouble': if (press) this.callOrResize(i, name === 'LoopHalf' ? -1 : 1); break;
      case 'Memory': if (press) { const n = d.memoryCues().length; d.addMemoryCue(); toast(d.memoryCues().length > n ? `Deck ${i + 1}: memory cue ${d.memoryCues().length} set` : `Deck ${i + 1}: a memory cue is already there`, 1500); } break;
      case 'Delete': if (press) { const n = d.memoryCues().length; d.deleteMemoryCueNear(); if (d.memoryCues().length < n) toast(`Deck ${i + 1}: memory cue deleted`, 1500); } break;
      case 'Quantize': if (press) d.toggleQuantize(); break;
      case 'TapBpm': if (press) this.tapGrid(i); break;
      case 'Slip': if (press) d.toggleSlip(); break;
      case 'Vinyl': if (press) { d.vinyl = !d.vinyl; toast(`Deck ${i + 1}: ${d.vinyl ? 'VINYL (scratch)' : 'PITCH BEND'} jog mode`); } break;
      case 'Deck': case 'DeckState': if (press && d && i >= 2 && app.deckCount < 4) { app.library.setSetting('deckCount', 4); app.applyLayout(); } break;
      // DECK 3 / DECK 4 layer selected on the hardware: show 4 decks.
      case 'DualDeckState13': case 'DualDeckState24': case 'Deck3': case 'Deck4': if (press && app.deckCount < 4) { app.library.setSetting('deckCount', 4); app.applyLayout(); } break;

      // ---- Groove Circuit
      case 'DrumSwapGain': app.groove[i].setLevel(ev.value01 * 1.5); break;
      case 'DrumSwapBankA': if (press) app.groove[i].setBank(0); break;
      case 'DrumSwapBankB': if (press) app.groove[i].setBank(1); break;
      case 'DrumSwapSingle': if (press) app.groove[i].setMulti(false); break;
      case 'DrumSwapMulti': if (press) app.groove[i].setMulti(true); break;
      case 'DrumSwapCapture': if (press) { const g = app.groove[i]; g.armCapture(!g.captureArmed); if (g.captureArmed) { this.requireStems(d); toast(`Deck ${i + 1}: press a DRUM SWAP slot to capture ${g.captureBars * 4} beats of drums`, 2500); } } break;
      case 'DrumSwapCaptureLength': if (press) toast(`Drum capture: ${app.groove[i].cycleCaptureLength() * 4} beats`); break;
      case 'DrumReleaseFx': if (!press || this.requireStems(d)) d.drumRelease(press); s.release = press; break;
      case 'DrumReleaseFxSelect': case 'DrumRelease+Shift': if (press) toast(`Deck ${i + 1} Drum Release FX: ${d.cycleReleaseFx()}`, 1500); break;

      // ---- mixer
      case 'CrossFader': this.ctl('crossfader')?.apply(ev.value01); break;
      case 'ChannelFader': this.ctl(`ch${i + 1}.fader`)?.apply(ev.value01); break;
      case 'Gain': this.ctl(`ch${i + 1}.trim`)?.apply(ev.value01); break;
      // EQ knobs share the on-screen curve: centre detent = 0 dB, left = kill, right = +6 dB.
      case 'EQHigh': this.ctl(`ch${i + 1}.hi`)?.apply(ev.value01); break;
      case 'EQMid': this.ctl(`ch${i + 1}.mid`)?.apply(ev.value01); break;
      case 'EQLow': this.ctl(`ch${i + 1}.low`)?.apply(ev.value01); break;
      case 'HeadphoneCue': if (press) this.ctl(`ch${i + 1}.cue`)?.apply(); break;
      case 'PartIsolator': if (press) { d.setPartIso(!d.partIso); if (d.partIso) this.requireStems(d); } break;
      case 'MasterCue': if (press) { this.masterCue = !this.masterCue; this.engine.setPhonesMix(this.masterCue ? 1 : 0); } break;
      case 'CFXOn': if (press) this.toggleCfx(); break;
      case 'CFXSelect': if (press) this.cycleCfx(); break;
      case 'ChannelFaderStartPlay': if (press && !d.playing) d.play(); break;
      case 'ChannelFaderStartCue': if (press && d.playing) { d.pause(); d.seek(d.cuePoint); } break;
      case 'CrossFaderStartPlay.A': case 'CrossFaderStartPlay.B': if (press) this.faderStart(name.slice(-1), true); break;
      case 'CrossFaderStartCue.A': case 'CrossFaderStartCue.B': if (press) this.faderStart(name.slice(-1), false); break;

      // ---- Beat FX
      case 'FX1BeatDown': case 'FX1BeatUp': if (press) this.fxBeat(name === 'FX1BeatUp' ? 1 : -1); break;
      case 'FX1AutoBeat': if (press) { fx.setTapBpm(0); toast('FX: AUTO BPM'); } break;
      case 'FX1TapBeat': if (press) { this.fxTaps.push(performance.now()); const bpm = tapBpm(this.fxTaps.slice(-8)); if (bpm) fx.setTapBpm(bpm); } break;
      case 'FX1-1': fx.setDepth(ev.value01); break;
      case 'FX1-1On': if (press) fx.setOn(!fx.on); break;
      case 'FX1ReleaseFXOn': fx.release(press); break;
      default: this.unknown.add(name); break; // listed by the plugin tests
    }
  }

  /**
   * Groove Circuit / parts work on stems. When a deck has none yet, start separating them (FAST,
   * from the play head, like rekordbox's real-time separation): usable after a couple of seconds.
   */
  requireStems(d) { return this.app.ensureStems(d); }

  /**
   * CALL ◀ ▶ (LOOP 1/2X / 2X): with a loop, halve / double it; without one, go to the previous / next
   * memory cue. A message says what happened (the controller has no loop display).
   */
  callOrResize(i, dir) {
    const d = this.deck(i);
    if (d.loop) {
      d.resizeLoop(dir < 0 ? 0.5 : 2);
      toast(`Deck ${i + 1}: loop ${fmtBeat(d.currentLoopBeats())} beats`, 1200);
    } else if (d.memoryCues().length) {
      d.callMemoryCue(dir);
    } else {
      d.resizeLoop(dir < 0 ? 0.5 : 2); // no loop and no memory cue: the next loop's size
      toast(`Deck ${i + 1}: next loop ${fmtBeat(d.beatLoopSize)} beats`, 1200);
    }
  }

  /** MEMORY CUE CALL ◀ ▶ on their own buttons (DDJ-FLX10): only the memory cues. */
  callMemory(i, dir) {
    const d = this.deck(i);
    if (d.memoryCues().length) d.callMemoryCue(dir);
    else toast(`Deck ${i + 1}: no memory cue`, 1200);
  }

  /** Decks the Beat FX applies to: its channel, or every deck for MASTER / SAMPLER. */
  fxDecks() {
    const m = /^ch(\d)$/.exec(this.engine.fx.target ?? '');
    return m ? [this.deck(Number(m[1]) - 1)].filter(Boolean) : this.engine.decks.filter((d) => d.loaded);
  }

  /** Global FX PART SELECT button: the part on / off on the Beat FX's deck(s), all the same way. */
  fxPartForFx(stem) {
    const decks = this.fxDecks();
    if (!decks.length) { toast('FX PART SELECT: load a track on the Beat FX channel'); return; }
    const on = !decks.some((d) => d.fxParts?.[stem]);
    for (const d of decks) { if (on) this.requireStems(d); d.setFxPart(stem, on); }
  }

  /** Jog while BEAT GRID ADJUST (BPM, 0.01 per step) or SLIDE (0.5 ms per step) is held. */
  gridJog(i, delta) {
    const d = this.deck(i);
    const g = d.grid;
    if (!d.loaded || !g) return;
    if (d.track.gridLocked) { if (!this.warned.has('gridLocked')) { this.warned.add('gridLocked'); toast('Beatgrid is locked'); } return; }
    if (this.decks[i].grid === 'slide') this.app.setTrackGrid(d, shiftGrid(g, delta * 0.0005));
    else if (!g.beats) this.app.setTrackGrid(d, { ...g, bpm: Math.round((g.bpm + delta * 0.01) * 100) / 100 });
    else if (!this.warned.has('gridDynamic')) { this.warned.add('gridDynamic'); toast('Dynamic grid: convert it to a constant grid to adjust the BPM'); }
  }

  /** Pad table page of deck i (0/1), shared with the on-screen pads. */
  page(i) { return this.app.deckViews[i]?.padPage ?? 0; }

  turnPage(i, dir) { this.app.deckViews[i]?.setPadPage(this.page(i) + dir); }

  /** Sampler slot of pad `n` (0-7) on deck i: its side's bank (decks 1 / 3: 1-8, decks 2 / 4: 9-16). */
  samplerSlot(i, n) { return (this.app.deckViews[i]?.samplerBank ?? i % 2) * 8 + n; }

  /** A pad mode button on the controller: the deck's pad page on screen follows. */
  setMode(i, mode) {
    this.decks[i].mode = mode;
    this.app.deckViews[i]?.setPadMode(mode === 'PAD FX2' ? 'PAD FX' : mode, { bank: mode === 'PAD FX2' ? 1 : 0, fromController: true });
  }

  /** The page was changed on screen: pads and their LEDs follow when this controller has that mode. */
  followMode(i, mode) {
    const s = this.decks[i];
    if (!s || s.mode === mode) return;
    if (Object.values(MODES).includes(mode) || Object.values(this.padModes).includes(mode)) s.mode = mode;
  }

  padEvent(i, n, kind, shift, press) {
    const d = this.deck(i);
    const s = this.decks[i];
    const raw = n - 1;
    // PAD9..16 are hot cues 9-16 and PAD FX slots 9-16; in the other modes the DDJ-FLX10 sends them
    // for its 8 pads on its second page ("Sample Slot 1", "BEAT JUMP REV1"): same values as 1-8.
    const slot = kind === 'HotCue' || kind === 'PadFx1' || kind === 'PadFx2' || kind === 'BeatLoop' ? raw : raw % 8;
    switch (kind) {
      case 'HotCue': if (press) { if (shift) d.deleteHotCue(slot); else d.hotCuePress(slot); } break;
      case 'BeatJump': if (press) d.beatJump(padValue('BEAT JUMP', this.page(i), slot)); break;
      case 'BeatLoop': if (press) d.beatLoop(padValue('BEAT LOOP', this.page(i), slot - 4)); break; // PAD5..PAD12 = pads 1-8 (rekordbox values 5-12)
      // An empty slot captures this deck's loop (audible stems only), like a click on the slot.
      case 'Sampler': { const k = this.samplerSlot(i, slot); if (press) { if (shift) this.app.sampler.stop(k); else this.app.samplerPress(k, d); } break; }
      case 'KeyShift': if (press) { const v = padValue('KEY SHIFT', this.page(i), slot); d.setKeyShift(d.keyShift === v ? 0 : v); } break;
      case 'Keyboard': if (press) {
        // SHIFT + pad: choose which hot cue the keyboard plays from (A by default).
        if (shift) { s.kbCue = slot; toast(`Deck ${i + 1} keyboard plays hot cue ${String.fromCharCode(65 + slot)}`, 1500); break; }
        d.setKeyShift(padValue('KEYBOARD', this.page(i), slot));
        const a = d.hotCue(s.kbCue ?? 0) ?? d.hotCue(0);
        d.jumpTo(a ? a.start : d.cuePoint);
        if (!d.playing) d.play();
      } break;
      case 'PadFx1': this.padFx(i, slot, press); break; // PAD9..16 arrive as PADn (shift layer)
      case 'PadFx2': this.padFx(i, (slot + 8) % 16, press); break; // second PAD FX bank
      case 'BeatLoopPads': if (press) d.beatLoop(padValue('BEAT LOOP', this.page(i), slot)); break; // pads 1-8: 1/4 .. 32 beats (page 2: 4 .. 512)
      case 'Stems': if (press && slot < 4 && this.requireStems(d)) { const stem = [3, 2, 1, 0][slot]; d.setStemOn(stem, d.stemGains[stem] === 0); } break;
      case 'Slicer': if (press) d.slicerDown(slot); else d.slicerUp(); break;
      case 'MemoryCue': if (press) { if (shift) d.deleteMemoryCue(slot); else d.callMemorySlot(slot); } break;
      default: break;
    }
  }

  padFx(i, slot, press) { this.app.padFxPress(i, slot, press); }

  load(i) {
    const now = performance.now();
    const s = this.decks[i];
    const app = this.app;
    // Double press = INSTANT DOUBLES from the partner deck (1<->2, 3<->4), like rekordbox.
    if (now - s.loadAt < 400) {
      const src = app.engine.decks[i ^ 1];
      if (src?.loaded) app.instantDouble(src.index, i);
      s.loadAt = 0;
      return;
    }
    s.loadAt = now;
    const id = app.browser.currentTrackId();
    if (id) app.loadTrack(i, id).then(() => { this.decks[i].tempoCaught = false; });
  }

  /** Tempo slider with soft takeover: ignored until it reaches the deck's current tempo. */
  tempo(i, v01) {
    const d = this.deck(i);
    const s = this.decks[i];
    const sign = this.app.library.settings.controllerTempoInvert ? -1 : 1;
    const pct = sign * (v01 * 2 - 1) * d.tempoRange;
    if (!s.tempoCaught) {
      const prev = s.lastTempo;
      s.lastTempo = pct;
      const crossed = prev !== undefined && (prev - d.tempoPct) * (pct - d.tempoPct) <= 0;
      if (Math.abs(pct - d.tempoPct) > d.tempoRange * 0.03 && !crossed) {
        // Say why the fader does nothing yet (once per pick-up).
        if (!s.takeoverHint) { s.takeoverHint = true; toast(`Deck ${i + 1}: bring the tempo fader to ${d.tempoPct >= 0 ? '+' : ''}${d.tempoPct.toFixed(1)}% to take over`, 3000); }
        return;
      }
      s.tempoCaught = true;
      s.takeoverHint = false;
    }
    d.userTempo(pct); // on a synced deck this moves the shared tempo
    s.lastTempo = pct;
  }

  tapGrid(i) {
    const d = this.deck(i);
    const s = this.decks[i];
    const now = performance.now();
    if (s.taps.length && now - s.taps.at(-1) > 2000) s.taps = [];
    s.taps.push(now);
    const bpm = tapBpm(s.taps);
    if (s.taps.length >= 4 && bpm && d.loaded && !d.track.gridLocked) {
      const anchor = d.bg ? d.bg.snap(d.position()) : d.position();
      const beat = d.bg ? d.bg.barPos(Math.round(d.bg.indexAt(anchor))) + 1 : 1;
      this.app.setTrackGrid(d, constantGridAt(bpm, anchor, beat));
    }
  }

  fxBeat(dir) { const fx = this.engine.fx; fx.setBeats(stepFxBeats(fx.beats, dir)); }

  /** Type CFX ON turns on: the last one chosen (SPACE by default). */
  get cfxType() { const t = this.app.library.settings.colorFx; return t && t !== 'FILTER' ? t : 'SPACE'; }

  /** CFX ON: off = the COLOR knobs are a plain filter; on = they apply the chosen Color FX. */
  toggleCfx() {
    const on = (this.engine.colorFx ?? 'FILTER') !== 'FILTER';
    this.setCfx(on ? 'FILTER' : this.cfxType);
  }

  /** SHIFT + CFX ON: next Color FX type; applied at once when CFX is on, else kept for CFX ON. */
  cycleCfx(dir = 1) {
    const types = COLOR_FX.filter((t) => t !== 'FILTER');
    const next = types[(types.indexOf(this.cfxType) + dir + types.length) % types.length];
    if ((this.engine.colorFx ?? 'FILTER') !== 'FILTER') this.setCfx(next);
    else { this.app.library.setSetting('colorFx', next); toast(`Color FX type: ${next} (CFX ON to use it)`, 1500); }
  }

  setCfx(type) {
    this.engine.setColorFx(type);
    if (type !== 'FILTER') this.app.library.setSetting('colorFx', type);
    const sel = document.querySelector('.cfx-select');
    if (sel) sel.value = type;
    toast(`Color FX: ${type}`, 1500);
  }

  faderStart(side, play) {
    this.engine.channels.forEach((ch, i) => {
      if (ch.state.assign !== side) return;
      const d = this.deck(i);
      if (play && !d.playing) d.play();
      if (!play && d.playing) { d.pause(); d.seek(d.cuePoint); }
    });
  }

  // ---- output (LEDs, meters, jog rings) ------------------------------------------------------

  /** Called every animation frame; sends at most ~30 updates per second. */
  updateLeds(force = false) {
    const now = performance.now();
    if (!force && now - this.lastLed < 33) return;
    this.lastLed = now;
    const o = (name, deck, v) => this.core.output(name, deck, v, force);
    const levels = this.engine.levels();
    const app = this.app;
    this.engine.decks.forEach((d, i) => {
      const s = this.decks[i];
      const ch = this.engine.channels[i];
      const pos = d.position();
      o('PlayPause', i, d.playing);
      o('Cue', i, d.loaded && !d.playing && Math.abs(pos - d.cuePoint) < 0.05);
      o('MasterTempo', i, d.keyLock);
      o('Sync', i, d.sync);
      o('Master', i, this.engine.masterDeck === d);
      o('KeySync', i, d.keySync);
      // Loop state: the controller sends CALL ◀ ▶ as LOOP 1/2X / 2X only while this says a loop plays.
      o('GetLoopActive', i, !!d.loop);
      o('LoopIn', i, !!d.loop || d.pendingLoopIn !== undefined);
      o('LoopOut', i, !!d.loop);
      o('Quantize', i, d.quantize);
      o('Slip', i, d.slip);
      o('Vinyl', i, d.vinyl);
      o('HeadphoneCue', i, ch.state.cue);
      o('PartIsolator', i, !!d.partIso);
      const db = 20 * Math.log10(levels.channels[i] + 1e-9);
      o('ChannelLevel', i, Math.max(0, Math.min(127, ((db + 48) / 48) * 127)));
      o('LoadedIndicator', i, d.loaded);
      o('GetLoopActive', i, !!d.loop);
      o('SlipStateForFlashing', i, d.slip && !!d.slipPosition());
      o('JogPlayPauseIndicatorShort', i, d.loaded ? 1 + Math.floor(((pos / 1.8) % 1) * 72) : 0);
      for (const [fn, mode] of Object.entries(MODES)) o(fn, i, s.mode === mode);
      // DRUM SWAP / ROLL / TRANS
      const g = app.groove?.[i];
      for (let k = 0; k < 4; k++) o(`DrumSwap${k + 1}`, i, !!g?.isPlaying(k));
      o('DrumSwapBankA', i, g?.bank === 0); o('DrumSwapBankB', i, g?.bank === 1);
      o('DrumSwapSingle', i, g && !g.multi); o('DrumSwapMulti', i, !!g?.multi);
      o('DrumSwapCapture', i, !!g?.captureArmed);
      o('DrumSwapCaptureLength', i, (g?.captureBars ?? 1) > 1);
      for (const n of Object.keys(DRUM_ROLL)) o(n, i, s.roll === n);
      for (const n of Object.keys(DRUM_TRANS)) o(n, i, s.trans === n);
      this.padLeds(i, force);
    });
    const fx = this.engine.fx;
    o('FX1-1On', null, fx.on);
    o('FX1ReleaseFXOn', null, !!fx.releaseFx);
    o('FX1BeatMultiplier', null, Math.max(0, RB_FX_BEATS.indexOf(fx.beats)));
    o('CFXOn', null, (this.engine.colorFx ?? 'FILTER') !== 'FILTER');
    o('SamplerCue', null, !!app.sampler.cue);
    // DDJ-FLX10 global FX PART SELECT LEDs.
    const fxDecks = this.fxDecks();
    for (const [part, stem] of Object.entries(PART_STEM)) o(`FXPartSelect${part}`, null, fxDecks.some((d) => d.fxParts?.[stem]));
  }

  padLeds(i, force = false) {
    const d = this.deck(i);
    const s = this.decks[i];
    const o = (name, v) => this.core.output(name, i, v, force);
    for (let n = 1; n <= 8; n++) {
      const slot = n - 1;
      o(`PAD${n}_HotCue`, !!d.hotCue(slot));
      o(`PAD${n}_HotCue+Shift`, !!d.hotCue(slot));
      o(`PAD${n}_BeatJump`, d.loaded);
      o(`PAD${n + 4}_BeatLoop`, d.loop?.beats === padValue('BEAT LOOP', this.page(i), slot));
      o(`PAD${n}_Sampler`, this.app.sampler.isPlaying(this.samplerSlot(i, slot)) || !!this.app.sampler.slots[this.samplerSlot(i, slot)].buffer);
      o(`PAD${n}_KeyShift`, d.keyShift === padValue('KEY SHIFT', this.page(i), slot));
      o(`PAD${n}_Keyboard`, d.keyShift === padValue('KEYBOARD', this.page(i), slot));
      o(`PAD${n}_PadFx1`, this.app.padFx[i]?.held === slot);
    }
    o('ActivePartVocal', d.stemsReady && d.stemGains[3] > 0);
    o('ActivePartInst', d.stemsReady && d.stemGains[2] > 0);
    o('ActivePartBass', d.stemsReady && d.stemGains[1] > 0);
    o('ActivePartDrums', d.stemsReady && d.stemGains[0] > 0);
    // FX PART SELECT LEDs (raw: these rows carry no deck), Vocal / Inst / Bass / Drums.
    [3, 2, 1, 0].forEach((stem, k) => { if (this.padStatus[i] !== undefined) this.core.sendRaw(this.padStatus[i], 0x14 + k, !!d.fxParts?.[stem], force); });
    // Generic pad LEDs (PADn_PadModeM): show the state of the current mode.
    const m = Object.entries(this.padModes).find(([, v]) => v === s.mode)?.[0];
    if (m) {
      for (let n = 1; n <= 8; n++) {
        const slot = n - 1;
        const on = s.mode === 'HOT CUE' ? !!d.hotCue(slot) : s.mode === 'SAMPLER' ? !!this.app.sampler.slots[this.samplerSlot(i, slot)]?.buffer
          : s.mode === 'BEAT LOOP' ? d.loop?.beats === padValue('BEAT LOOP', this.page(i), slot) : s.mode === 'KEY SHIFT' || s.mode === 'KEYBOARD' ? d.keyShift === padValue(s.mode, this.page(i), slot) : d.loaded;
        o(`PAD${n}_PadMode${m}`, on);
      }
    }
    for (const [k, v] of Object.entries(this.padModes)) o(`PadMode${k}`, s.mode === v);
  }
}
