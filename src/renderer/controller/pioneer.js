// Pioneer DJ controller driver (rekordbox mapping functions -> RBClone actions, plus LEDs).
// Built for the DDJ-GRV6 profile; most function names are shared by other Pioneer controllers,
// so a rekordbox .midi.csv for another model works for the functions it has in common.
import { ControllerCore } from '../../shared/controllers/core.js';
import { BEAT_FX, FX_BEATS } from '../audio/fx.js';
import { COLOR_FX } from '../ui/mixer-view.js';
import { constantGridAt, tapBpm } from '../../shared/beatgrid.js';
import { mediaUrl } from '../analysis/analyzer.js';
import { toast } from '../ui/dom.js';

const FX_SELECT = {
  DELAY: 'DELAY', ECHO: 'ECHO', LOWCUTECHO: 'LOW CUT ECHO', SPIRAL: 'SPIRAL', HELIX: 'HELIX', REVERB: 'REVERB',
  FLANGER: 'FLANGER', PHASER: 'PHASER', FILTER: 'FILTER', TRANS: 'TRANS', PITCH: 'PITCH', ROLL: 'ROLL',
  MOBIUSSAW: 'MOBIUS SAW', MOBIUSTRI: 'MOBIUS TRI',
};
// rekordbox pad tables (pad\*.pad.csv): 16 values, 8 pads per page.
const BEAT_JUMP = [-1, 1, -2, 2, -4, 4, -8, 8, -16, 16, -32, 32, -64, 64, -128, 128];
const BEAT_LOOP = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const KEY_TABLE = [4, 5, 6, 7, 0, 1, 2, 3, -4, -3, -2, -1, -8, -7, -6, -5];
const DRUM_ROLL = { DrumRoll1_8: 1 / 8, DrumRoll1_4: 1 / 4, DrumRoll1_2: 1 / 2, DrumRoll1: 1 };
const DRUM_TRANS = { DrumTrans1_8: 1 / 8, DrumTrans1_4: 1 / 4, DrumTrans1_2: 1 / 2, DrumTrans1: 1 };
// [stem index] for PART ISOLATOR knobs (3-part layout: VOCAL / INST (+ bass) / DRUMS).
const PART_KNOBS = { PartIsolatorVocal: [3], PartIsolatorInst: [2, 1], PartIsolatorDrums: [0] };
const ACTIVE_PART = { ActivePartVocal: 3, ActivePartInst: 2, ActivePartBass: 1, ActivePartDrums: 0 };
// Pad channels per deck (FX PART SELECT rows have no deck column in the mapping).
const PAD_STATUS = [0x97, 0x99, 0x9b, 0x9d];
const MODES = { HotCue: 'HOT CUE', Keyboard: 'KEYBOARD', Stems: 'STEMS', PadFx1: 'PAD FX', BeatJump: 'BEAT JUMP', BeatLoop: 'BEAT LOOP', Sampler: 'SAMPLER', KeyShift: 'KEY SHIFT' };
// PAD FX bank (16 slots, momentary): [effect, beats, depth].
export const PAD_FX = [
  ['ROLL', 1 / 4, 0.8], ['ROLL', 1 / 8, 0.8], ['ROLL', 1 / 16, 0.8], ['ECHO', 1 / 2, 0.6],
  ['TRANS', 1 / 4, 0.9], ['FILTER', 4, 0.8], ['REVERB', 1, 0.7], ['VINYL BRAKE', 2, 1],
  ['REV ROLL', 1 / 4, 0.8], ['PING PONG', 1 / 2, 0.6], ['FLANGER', 8, 0.7], ['PHASER', 4, 0.7],
  ['PITCH', 1, 0.8], ['DOWN ECHO', 1 / 2, 0.7], ['SPIRAL', 1 / 2, 0.7], ['HELIX', 1, 0.8],
];

export class PioneerController {
  /**
   * @param {object} app RBClone App
   * @param {{device: string, entries: object[]}} profile
   * @param {(bytes: number[]) => void} send MIDI output
   */
  constructor(app, profile, send) {
    this.app = app;
    this.device = profile.device;
    this.core = new ControllerCore(profile, (ev) => this.handle(ev), send);
    this.decks = [0, 1, 2, 3].map(() => ({
      shift: false, mode: 'HOT CUE', page: 0, partIso: false, taps: [], loadAt: 0, tempoCaught: false,
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
    const { name, press } = ev;
    const i = ev.deck;
    const d = i !== null ? this.deck(i) : null;
    const s = i !== null ? this.decks[i] : null;
    const app = this.app;
    const browser = app.browser;
    const fx = this.engine.fx;

    // Pads: PADn_<Mode>[+Shift]
    const pad = /^PAD(\d+)_(HotCue|BeatJump|Sampler|Keyboard|PadFx1|BeatLoop|KeyShift)(\+Shift)?$/.exec(name);
    if (pad && d) { this.padEvent(i, Number(pad[1]), pad[2], !!pad[3], press); return; }
    const param = /^Parameter1(Left|Right)_(HotCue|BeatJump|Keyboard|KeyShift)$/.exec(name);
    if (param && d) {
      if (!press) return;
      const dir = param[1] === 'Left' ? -1 : 1;
      if (param[2] === 'HotCue') d.callMemoryCue(dir);
      else { s.page = Math.max(0, Math.min(1, s.page + dir)); }
      return;
    }
    if (FX_SELECT[name.replace('FX1-1Select.', '')] && name.startsWith('FX1-1Select.')) { if (press) fx.setEffect(FX_SELECT[name.slice(12)]); return; }
    if (name.startsWith('FX1Assign.')) { if (press) fx.setTarget(name === 'FX1Assign.MASTER' ? 'master' : name === 'FX1Assign.SAMPLER' ? 'sampler' : `ch${name.slice(-1)}`); return; }
    if (/^CFXParameterCH\d$/.test(name)) { this.ctl(`ch${name.slice(-1)}.color`)?.apply(ev.value01); return; }
    if (DRUM_ROLL[name] !== undefined && d) { this.requireStems(d) && d.drumRoll(press ? DRUM_ROLL[name] : null); s.roll = press ? name : null; return; }
    if (DRUM_TRANS[name] !== undefined && d) { this.requireStems(d) && d.drumTrans(press ? DRUM_TRANS[name] : null); s.trans = press ? name : null; return; }
    if (PART_KNOBS[name] && d) { const lvl = Math.min(1, ev.value01 * 2); PART_KNOBS[name].forEach((k) => d.setStemLevel(k, lvl)); return; }
    if (ACTIVE_PART[name] !== undefined && d) { if (press && this.requireStems(d)) d.setStemOn(ACTIVE_PART[name], d.stemGains[ACTIVE_PART[name]] === 0); return; }
    if (/^FXPartSelect(Vocal|Inst|Bass|Drums)On$/.test(name)) {
      // Beat FX on chosen parts only. Stem index: Vocal 3, Inst 2, Bass 1, Drums 0.
      if (!press) return;
      const stem = { Vocal: 3, Inst: 2, Bass: 1, Drums: 0 }[/Select(\w+?)On/.exec(name)[1]];
      const deckIdx = ev.raw ? PAD_STATUS.indexOf(ev.raw[0]) : -1;
      const dk = this.deck(deckIdx);
      if (!dk) return;
      this.requireStems(dk);
      dk.setFxPart(stem, !dk.fxParts[stem]);
      return;
    }
    if (MODES[name] && d) { if (press) this.setMode(i, MODES[name]); return; }
    const swap = /^DrumSwap([1-4])$/.exec(name);
    // Built-in loops play right away; the track's own drums are replaced as soon as stems exist.
    if (swap && d) { if (press) { this.requireStems(d); app.groove[i].toggle(Number(swap[1]) - 1); } return; }

    switch (name) {
      // ---- browser
      case 'Browse': browser.browseMove(ev.delta); break;
      case 'Zoom': app.zoom = Math.max(2, Math.min(32, app.zoom * (ev.delta > 0 ? 1 / 1.15 : 1.15) ** Math.abs(ev.delta))); break;
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
      case 'SamplerPanel': if (press) app.toggleSampler(); break;

      // ---- transport
      case 'PlayPause': if (press) d.playPause(); break;
      case 'Cue': if (press) d.cueDown(); else d.cueUp(); break;
      case 'JumpToTrackStart': if (press) d.jumpToStart(); break;
      case 'JogTouch': if (press) { if (d.vinyl) d.scratchStart(); } else d.scratchEnd(); break;
      case 'JogScratch': if (d.scratching) d.scratchMove(ev.delta); else d.jogBend(ev.delta); break;
      case 'JogPitchBend': case 'WheelPitchBend': d.jogBend(ev.delta); break;
      case 'WheelSearch': d.jogSearch(ev.delta); break;
      case 'TempoSlider': this.tempo(i, ev.value01); break;
      case 'MasterTempo': if (press) d.toggleKeyLock(); break;
      case 'TempoRange': if (press) { const r = [6, 10, 16, 100]; d.setTempoRange(r[(r.indexOf(d.tempoRange) + 1) % r.length]); s.tempoCaught = false; } break;
      case 'Sync': if (press) d.toggleSync(); break;
      case 'Master': if (press) this.engine.setMasterDeck(i); break;
      case 'KeySync': if (press) app.deckViews[i].keySync(); break;
      case 'KeyReset': if (press) d.setKeyShift(0); break;
      case 'Shift': s.shift = press; break;
      case 'LoopIn': if (press) d.loopIn(); break;
      case '4BeatLoopLongPress': if (press) d.beatLoop(4); break;
      case 'LoopOut': if (press) d.loopOut(); break;
      case 'ReloopExit': case 'ActiveLoop': if (press) d.reloopExit(); break;
      case 'LoopHalf': if (press) d.resizeLoop(0.5); break;
      case 'LoopDouble': if (press) d.resizeLoop(2); break;
      case 'Memory': if (press) d.addMemoryCue(); break;
      case 'Delete': if (press) d.deleteMemoryCueNear(); break;
      case 'Quantize': if (press) d.toggleQuantize(); break;
      case 'TapBpm': if (press) this.tapGrid(i); break;
      case 'Slip': if (press) d.toggleSlip(); break;
      case 'Vinyl': if (press) { d.vinyl = !d.vinyl; toast(`Deck ${i + 1}: ${d.vinyl ? 'VINYL (scratch)' : 'CDJ (pitch bend)'} jog mode`); } break;
      case 'Deck': case 'DeckState': if (press && d && i >= 2 && app.deckCount < 4) { app.library.setSetting('deckCount', 4); app.applyLayout(); } break;
      // DECK 3 / DECK 4 layer selected on the hardware: show 4 decks.
      case 'DualDeckState13': case 'DualDeckState24': if (press && app.deckCount < 4) { app.library.setSetting('deckCount', 4); app.applyLayout(); } break;

      // ---- Groove Circuit
      case 'DrumSwapGain': app.groove[i].setLevel(ev.value01 * 1.5); break;
      case 'DrumSwapBankA': if (press) app.groove[i].setBank(0); break;
      case 'DrumSwapBankB': if (press) app.groove[i].setBank(1); break;
      case 'DrumSwapSingle': if (press) app.groove[i].setMulti(false); break;
      case 'DrumSwapMulti': if (press) app.groove[i].setMulti(true); break;
      case 'DrumSwapCapture': if (press && this.requireStems(d)) app.drumCapture(i); break;
      case 'DrumSwapCaptureLength': if (press) toast(`Drum capture: ${app.groove[i].cycleCaptureLength()} bar(s)`); break;
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
      case 'PartIsolator': if (press) s.partIso = !s.partIso; break;
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
      default: break;
    }
  }

  /**
   * Groove Circuit / parts work on stems. When a deck has none yet, start separating them (FAST,
   * from the play head, like rekordbox's real-time separation): usable after a couple of seconds.
   */
  requireStems(d) { return this.app.ensureStems(d); }

  setMode(i, mode) {
    this.decks[i].mode = mode;
    this.decks[i].page = 0;
    const view = this.app.deckViews[i];
    const map = { 'HOT CUE': 'HOT CUE', KEYBOARD: 'KEYBOARD', 'BEAT JUMP': 'BEAT JUMP', 'BEAT LOOP': 'BEAT LOOP', SAMPLER: 'SAMPLER', 'KEY SHIFT': 'KEY SHIFT', STEMS: 'STEMS' };
    if (map[mode]) { view.padMode = map[mode]; view.modeSel.value = map[mode]; view.renderPads(); }
  }

  padEvent(i, n, kind, shift, press) {
    const d = this.deck(i);
    const s = this.decks[i];
    const slot = n - 1;
    switch (kind) {
      case 'HotCue': if (press) { if (shift) d.deleteHotCue(slot); else d.hotCuePress(slot); } break;
      case 'BeatJump': if (press) d.beatJump(BEAT_JUMP[s.page * 8 + slot]); break;
      case 'BeatLoop': if (press) d.beatLoop(BEAT_LOOP[slot]); break; // PAD5..PAD12 -> 1/4..32
      case 'Sampler': if (press) { if (shift) this.app.sampler.stop(slot); else this.app.sampler.trigger(slot); } break;
      case 'KeyShift': if (press) { const v = KEY_TABLE[s.page * 8 + slot]; d.setKeyShift(d.keyShift === v ? 0 : v); } break;
      case 'Keyboard': if (press) {
        // SHIFT + pad: choose which hot cue the keyboard plays from (A by default).
        if (shift) { s.kbCue = slot; toast(`Deck ${i + 1} keyboard plays hot cue ${String.fromCharCode(65 + slot)}`, 1500); break; }
        d.setKeyShift(KEY_TABLE[s.page * 8 + slot]);
        const a = d.hotCue(s.kbCue ?? 0) ?? d.hotCue(0);
        d.jumpTo(a ? a.start : d.cuePoint);
        if (!d.playing) d.play();
      } break;
      case 'PadFx1': this.padFx(i, slot, press); break; // PAD9..16 arrive as PADn (shift layer)
      default: break;
    }
  }

  padFx(i, slot, press) {
    const unit = this.app.padFx[i];
    if (!press) { if (unit.held === slot) { unit.setOn(false); unit.held = null; } return; }
    const [effect, beats, depth] = PAD_FX[slot] ?? PAD_FX[0];
    unit.setEffect(effect);
    unit.setBeats(beats);
    unit.setDepth(depth);
    unit.setOn(true);
    unit.held = slot;
  }

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
      if (Math.abs(pct - d.tempoPct) > d.tempoRange * 0.03 && !crossed) return;
      s.tempoCaught = true;
    }
    if (d.sync) d.toggleSync(); // moving the slider takes the deck out of sync, like rekordbox
    d.setTempoPct(pct);
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

  fxBeat(dir) {
    const fx = this.engine.fx;
    const k = FX_BEATS.indexOf(fx.beats);
    fx.setBeats(FX_BEATS[Math.max(0, Math.min(FX_BEATS.length - 1, (k < 0 ? 5 : k) + dir))]);
  }

  toggleCfx() {
    const cur = this.engine.colorFx ?? 'FILTER';
    if (cur !== 'FILTER') { this.lastCfx = cur; this.setCfx('FILTER'); } else this.setCfx(this.lastCfx ?? 'SPACE');
  }

  cycleCfx() {
    const cur = this.engine.colorFx ?? 'FILTER';
    this.setCfx(COLOR_FX[(COLOR_FX.indexOf(cur) + 1) % COLOR_FX.length]);
  }

  setCfx(type) {
    this.engine.setColorFx(type);
    this.app.library.setSetting('colorFx', type);
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
      o('KeySync', i, d.keyShift !== 0);
      o('LoopIn', i, !!d.loop || d.pendingLoopIn !== undefined);
      o('LoopOut', i, !!d.loop);
      o('Quantize', i, d.quantize);
      o('Slip', i, d.slip);
      o('Vinyl', i, d.vinyl);
      o('HeadphoneCue', i, ch.state.cue);
      o('PartIsolator', i, s.partIso);
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
      o('DrumSwapCapture', i, !!g?.slots[g.bank].some((x) => x?.captured));
      o('DrumSwapCaptureLength', i, (g?.captureBars ?? 1) > 1);
      for (const n of Object.keys(DRUM_ROLL)) o(n, i, s.roll === n);
      for (const n of Object.keys(DRUM_TRANS)) o(n, i, s.trans === n);
      this.padLeds(i, force);
    });
    const fx = this.engine.fx;
    o('FX1-1On', null, fx.on);
    o('FX1ReleaseFXOn', null, !!fx.releaseFx);
    o('FX1BeatMultiplier', null, Math.max(0, FX_BEATS.indexOf(fx.beats)));
    o('CFXOn', null, (this.engine.colorFx ?? 'FILTER') !== 'FILTER');
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
      o(`PAD${n + 4}_BeatLoop`, d.loop?.beats === BEAT_LOOP[slot + 4]);
      o(`PAD${n}_Sampler`, this.app.sampler.isPlaying(slot) || !!this.app.sampler.slots[slot].buffer);
      o(`PAD${n}_KeyShift`, d.keyShift === KEY_TABLE[s.page * 8 + slot]);
      o(`PAD${n}_Keyboard`, d.keyShift === KEY_TABLE[s.page * 8 + slot]);
      o(`PAD${n}_PadFx1`, this.app.padFx[i]?.held === slot);
    }
    o('ActivePartVocal', d.stemsReady && d.stemGains[3] > 0);
    o('ActivePartInst', d.stemsReady && d.stemGains[2] > 0);
    o('ActivePartBass', d.stemsReady && d.stemGains[1] > 0);
    o('ActivePartDrums', d.stemsReady && d.stemGains[0] > 0);
    // FX PART SELECT LEDs (raw: these rows carry no deck), Vocal / Inst / Bass / Drums.
    [3, 2, 1, 0].forEach((stem, k) => this.core.sendRaw(PAD_STATUS[i], 0x14 + k, !!d.fxParts?.[stem], force));
  }
}
