import { h, fmtTime, fader, contextMenu, promptText } from './dom.js';
import { Overview } from './waveform.js';
import { TEMPO_RANGES, BEAT_LOOP_SIZES, BEAT_JUMP_SIZES } from '../audio/deck.js';
import { PAD_FX } from '../audio/fx.js';
import { JogWheel } from './jog.js';
import { displayKey, transposeKey } from '../../shared/keys.js';
import { TRACK_COLORS } from '../../shared/rekordbox-xml.js';
import { icon } from './icons.js';
import { mediaUrl } from '../analysis/analyzer.js';

const STEM_BUTTONS = [['VOCAL', 3], ['INST', 2], ['BASS', 1], ['DRUMS', 0]];
/**
 * Pad pages, in rekordbox's order. The dropdown above the pads picks one; a controller's pad mode
 * buttons (HOT CUE, PAD FX, STEMS...) open the matching page. SEQ CALL needs the sequencer, which
 * Reboxed does not have yet: listed, not selectable.
 */
export const PAD_MODES = ['HOT CUE', 'PAD FX', 'SLICER', 'BEAT JUMP', 'BEAT LOOP', 'SAMPLER', 'KEYBOARD', 'KEY SHIFT', 'SEQ CALL', 'STEMS', 'MEMORY CUE', 'GROOVE'];
const UNAVAILABLE = new Set(['SEQ CALL']);
// STEMS pads: 1-4 ACTIVE PART (mute), 5-8 FX PART SELECT; index into [drums, bass, other, vocals].
const STEM_PADS = [['VOC', 3], ['INST', 2], ['BASS', 1], ['DRUM', 0]];
const STEM_PAD_COLORS = { 3: '#ff4fa3', 2: '#3ddc84', 1: '#3d8dff', 0: '#ffa91f' };
const PAD_LOOPS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const PAD_JUMPS = [-32, -16, -4, -1, 1, 4, 16, 32];
const PAD_KEYS = [-4, -3, -2, -1, 1, 2, 3, 4];
const PAD_KEYBOARD = [-3, -2, -1, 0, 1, 2, 3, 4];
const fmtBeats = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);
const fmtSigned = (b) => (Math.abs(b) >= 1 ? String(b) : `${b < 0 ? '-' : ''}1/${Math.round(1 / Math.abs(b))}`);
const HOT_COLORS = TRACK_COLORS.map((c) => c.css);
// Pages whose 8 pads show one of two banks (hot cues A–H / I–P, sampler and PAD FX 1–8 / 9–16).
const BANKS = { 'HOT CUE': ['A–H', 'I–P'], SAMPLER: ['1–8', '9–16'], 'PAD FX': ['1–8', '9–16'] };

export class DeckView {
  /**
   * @param {import('../audio/deck.js').Deck} deck
   * @param {{library: import('../library.js').Library, loadTrack: (deckIndex: number, trackId: string) => void, engine: any}} app
   */
  constructor(deck, app) {
    this.deck = deck;
    this.app = app;
    const d = deck;
    const btn = (label, cls, onclick, title) => h(`button.dbtn${cls ? `.${cls}` : ''}`, { onclick, title }, label);

    this.title = h('div.deck-title');
    this.artist = h('div.deck-artist');
    this.bpm = h('div.deck-bpm');
    this.bpmSub = h('div.deck-bpm-sub');
    this.keyEl = h('div.deck-key');
    this.tempoEl = h('div.deck-tempo');
    this.timeEl = h('div.deck-time');
    this.remainEl = h('div.deck-remain');
    this.masterBtn = btn('MASTER', 'master', () => app.engine.setMasterDeck(d.index), 'Make this deck the tempo master');
    this.overviewCanvas = h('canvas.overview');
    this.overview = new Overview(this.overviewCanvas, d, (t) => d.seek(t));

    this.cueBtn = h('button.transport.cue', { title: 'CUE' }, 'CUE');
    this.cueBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); d.cueDown(); });
    this.cueBtn.addEventListener('pointerup', () => d.cueUp());
    this.cueBtn.addEventListener('pointerleave', () => d.cueUp());
    this.playBtn = h('button.transport.play', { onclick: () => d.playPause(), title: 'PLAY/PAUSE' }, '▶❚❚');

    // BEAT SYNC and KEY SYNC side by side, like rekordbox.
    this.syncBtn = btn('BEAT SYNC', 'sync', () => d.toggleSync(), 'Beat sync: tempo (and beats) follow the master deck');
    this.keySyncBtn = btn('KEY SYNC', 'keysync', () => d.toggleKeySync(), 'Key sync: shift the key to match the master deck (or its relative key)');
    this.qBtn = btn('Q', 'q', () => d.toggleQuantize(), 'Quantize');
    this.mtBtn = btn('MT', 'mt', () => d.toggleKeyLock(), 'Master Tempo (key lock)');
    this.slipBtn = btn('SLIP', 'slip', () => d.toggleSlip(), 'Slip mode');
    this.revBtn = btn('REV', 'rev', () => d.setReverse(!d.reverse), 'Reverse');

    // 8 performance pads; what they do depends on the pad page.
    this.bank = 0;
    this.padMode = 'HOT CUE';
    this.kbCue = 0; // KEYBOARD plays from this hot cue
    this.pads = Array.from({ length: 8 }, (_, i) => {
      const pad = h('button.pad', {}, h('span.pad-letter'), h('span.pad-time'));
      pad.addEventListener('pointerdown', (e) => { if (e.button === 0) { pad.setPointerCapture(e.pointerId); this.padDown(i, e); } });
      pad.addEventListener('pointerup', () => this.padUp(i));
      pad.addEventListener('lostpointercapture', () => this.padUp(i));
      pad.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.padMode === 'HOT CUE') this.padMenu(e, this.bank * 8 + i); });
      return pad;
    });
    this.bankBtn = btn('A–H', 'bank', () => { this.bank = 1 - this.bank; this.refresh(); }, 'Pad bank');
    // Pad page dropdown.
    this.modeLabel = h('span.padmode-label');
    this.modeBtn = h('button.dbtn.padmode', { title: 'Pad mode (a pad mode button on the controller opens its page)', onclick: () => this.modeMenu() }, this.modeLabel, h('span.padmode-caret', {}, '▾'));
    this.pageBar = h('div.row.page');
    // Stems: VOCAL / INST / BASS / DRUMS (indices into [drums, bass, other, vocals]).
    this.stemBtns = STEM_BUTTONS.map(([label, idx]) => {
      const b = h(`button.dbtn.small.stem.stem-${label.toLowerCase()}`, { title: `${label}: click = mute/unmute, Shift+click = solo` }, label);
      b.onclick = (e) => { if (e.shiftKey) d.soloStem(idx); else d.setStemOn(idx, d.stemGains[idx] === 0); };
      return b;
    });
    this.stemSepBtn = h('button.dbtn.small.stem-sep', {
      title: 'Separate this track into stems (cached)',
      onclick: () => d.track && app.separateStems(d.track.id, { deck: d, ...(d.stemsComplete && d.stemQuality === 'fast' ? { quality: 'hq' } : {}) }),
    }, 'STEMS');
    this.stemRow = h('div.row.stems', {}, this.stemSepBtn, ...this.stemBtns);
    this.censorBtn = h('button.dbtn.censor', { title: 'Censor (hold): plays reverse, returns via slip' }, 'CENSOR');
    this.censorBtn.addEventListener('pointerdown', () => d.censorDown());
    this.censorBtn.addEventListener('pointerup', () => d.censorUp());
    this.censorBtn.addEventListener('pointerleave', () => d.censorUp());

    this.loopSize = h('span.val');
    this.loopBtn = btn('', 'loop-size', () => d.beatLoop(d.beatLoopSize), 'Auto beat loop (starts on the closest beat with Quantize)');
    this.loopBtn.append(this.loopSize);
    this.inBtn = btn('IN', '', () => d.loopIn(), 'Loop in');
    this.outBtn = btn('OUT', '', () => d.loopOut(), 'Loop out');
    this.exitBtn = btn('RELOOP', 'reloop', () => d.reloopExit(), 'Reloop / Exit');
    this.jumpSize = h('span.val');
    /** Next loop size up / down from any length (a manual loop of 3 beats goes to 2 or 4). */
    const loopStep = (cur, dir) => (dir > 0 ? BEAT_LOOP_SIZES.find((s) => s > cur + 1e-6) ?? BEAT_LOOP_SIZES.at(-1)
      : [...BEAT_LOOP_SIZES].reverse().find((s) => s < cur - 1e-6) ?? BEAT_LOOP_SIZES[0]);

    this.keyShiftVal = h('span.val');
    this.tempoFader = fader({ min: -1, max: 1, step: 0.0005, value: 0, vertical: true, cls: 'tempo', reset: 0,
      // Vertical range: top = min. Like a CDJ, pulling the fader down (towards you) speeds up.
      onInput: (v) => d.userTempo(v * d.tempoRange) });
    this.rangeBtn = btn('', 'range', () => d.setTempoRange(TEMPO_RANGES[(TEMPO_RANGES.indexOf(d.tempoRange) + 1) % TEMPO_RANGES.length]), 'Tempo range');

    // Layout after rekordbox's PERFORMANCE deck: header (number, artwork, title, key, BPM,
    // MASTER / BEAT SYNC / KEY SYNC), time + overview, then [jog, CUE/PLAY] [pads] [tempo slider].
    this.art = h('div.deck-art');
    this.playBtn.innerHTML = '';
    this.playBtn.append(icon('playpause'));
    this.keyBox = h('button.deck-keybox', { title: 'Key: click to shift it (semitones) or sync it', onclick: () => this.keyPanel() }, h('div.deck-label', {}, 'KEY'), this.keyEl);
    this.el = h(`section.deck.deck${d.index + 1}`, { dataset: { deck: d.index } },
      h('div.deck-head', {},
        h('div.deck-num', {}, String(d.index + 1)),
        this.art,
        h('div.deck-info', {}, this.title, this.artist),
        this.keyBox,
        h('div.deck-bpmbox', {}, h('div.deck-label', {}, 'BPM'), this.bpm, this.bpmSub),
        h('div.deck-headbtns', {}, this.masterBtn, this.syncBtn, this.keySyncBtn)),
      h('div.deck-ovrow', {}, this.timeEl, h('div.canvas-box.ov-box', {}, this.overviewCanvas), this.remainEl),
      h('div.deck-body', {},
        h('div.deck-transport', {}, (this.jog = new JogWheel(d)).el, h('div.transport-row', {}, this.cueBtn, this.playBtn)),
        h('div.deck-center', {},
          h('div.row.modes', {}, this.qBtn, this.mtBtn, this.slipBtn, this.revBtn, this.censorBtn, h('span.spacer'), this.modeBtn),
          h('div.pads', {}, this.pads),
          this.pageBar,
          this.stemRow,
          h('div.row.loops', {},
            h('div.seg', {},
              btn('½', '', () => d.resizeLoop(0.5), 'Loop halve'),
              // Size arrows change the playing loop too, not only the next one.
              btn('◀', 'small', () => { d.setBeatLoopSize(loopStep(d.currentLoopBeats(), -1)); this.refresh(); }, 'Smaller loop (the current one too)'),
              this.loopBtn,
              btn('▶', 'small', () => { d.setBeatLoopSize(loopStep(d.currentLoopBeats(), 1)); this.refresh(); }, 'Bigger loop (the current one too)'),
              btn('×2', '', () => d.resizeLoop(2), 'Loop double')),
            h('div.seg', {}, this.inBtn, this.outBtn, this.exitBtn),
            h('span.spacer'),
            h('div.seg', {},
              btn('◀', 'small', () => d.beatJump(-d.beatJumpSize), 'Beat jump back'),
              h('button.dbtn.jump-label', { title: 'Beat jump size (click to change)', onclick: () => { d.beatJumpSize = BEAT_JUMP_SIZES[(BEAT_JUMP_SIZES.indexOf(d.beatJumpSize) + 1) % BEAT_JUMP_SIZES.length]; this.refresh(); } }, 'JUMP ', this.jumpSize),
              btn('▶', 'small', () => d.beatJump(d.beatJumpSize), 'Beat jump forward')))),
        h('div.deck-tempo-col', {}, this.rangeBtn, this.tempoEl, this.tempoFader, btn('RESET', 'small', () => { d.setTempoPct(0); }, 'Tempo reset'))));

    // Drop tracks onto the deck
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-rb-tracks')) { e.preventDefault(); this.el.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop');
      const ids = JSON.parse(e.dataTransfer.getData('application/x-rb-tracks') || '[]');
      if (ids[0]) app.loadTrack(d.index, ids[0]);
    });

    d.addEventListener('change', () => this.refresh());
    app.engine.addEventListener('master', () => this.refresh());
    this.buildPageBar();
    this.refresh();
  }

  // ---- pad pages -------------------------------------------------------------------------------

  /**
   * Open a pad page. bank: which half of 16 (hot cues I–P, sampler / PAD FX 9–16).
   * fromController: the page follows a controller button, so the controller needs no update.
   */
  setPadMode(mode, { bank = 0, fromController = false } = {}) {
    if (!PAD_MODES.includes(mode) || UNAVAILABLE.has(mode)) return;
    const changed = mode !== this.padMode || bank !== this.bank;
    this.padMode = mode;
    this.bank = BANKS[mode] ? bank : 0;
    if (changed) this.buildPageBar();
    this.refresh();
    if (!fromController) this.app.onPadModeChange?.(this.deck.index, mode);
  }

  modeMenu() {
    const r = this.modeBtn.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, PAD_MODES.map((m) => ({
      label: UNAVAILABLE.has(m) ? `${m} (not available yet)` : m,
      checked: m === this.padMode,
      disabled: UNAVAILABLE.has(m),
      action: () => this.setPadMode(m),
    })));
  }

  /** The row under the pads: what the current page needs (bank, sizes, memory, key...). */
  buildPageBar() {
    const d = this.deck;
    const btn = (label, cls, onclick, title) => h(`button.dbtn${cls ? `.${cls}` : ''}`, { onclick, title }, label);
    const hint = (text) => h('span.page-hint', {}, text);
    const parts = [];
    switch (this.padMode) {
      case 'HOT CUE': parts.push(this.bankBtn, hint('Empty pad: set · Shift+click: delete · right-click: name, colour')); break;
      case 'PAD FX': parts.push(this.bankBtn, hint('Hold a pad: effect on this deck, at its beat')); break;
      case 'SLICER': parts.push(hint('Hold a pad: loops that 8th of the current 2 bars, playback returns (slip)')); break;
      case 'BEAT JUMP': parts.push(hint('Pad = jump by that many beats (loops move along)')); break;
      case 'BEAT LOOP': parts.push(hint('Pad = loop of that many beats, on the closest beat · again: exit')); break;
      case 'SAMPLER': parts.push(this.bankBtn, hint('Empty pad: captures this deck\'s loop (audible stems only) · loaded: play')); break;
      case 'KEYBOARD':
        this.kbBtn = btn('', 'small', () => { this.kbCue = (this.kbCue + 1) % 8; this.refresh(); }, 'Hot cue the keyboard plays from (click to change)');
        parts.push(h('span.seg-label', {}, 'FROM'), this.kbBtn, hint('Pad = play the hot cue transposed'));
        break;
      case 'KEY SHIFT':
        parts.push(h('div.seg.keyshift', {}, h('span.seg-label', {}, 'KEY'),
          btn('−', 'small', () => d.setKeyShift(d.keyShift - 1), 'Key shift down (semitone)'),
          this.keyShiftVal,
          btn('+', 'small', () => d.setKeyShift(d.keyShift + 1), 'Key shift up (semitone)'),
          btn('RESET', 'small', () => d.setKeyShift(0), 'Key reset')), hint('Pad = shift by that many semitones'));
        break;
      case 'STEMS': parts.push(hint('Pads 1–4: mute / unmute a part · 5–8: Beat FX on that part only')); break;
      case 'MEMORY CUE':
        parts.push(h('div.seg', {},
          btn('MEMORY', '', () => d.addMemoryCue(), 'Add a memory cue at the play head (or the loop)'),
          btn('◀', 'small', () => d.callMemoryCue(-1), 'Previous memory cue'),
          btn('▶', 'small', () => d.callMemoryCue(1), 'Next memory cue'),
          btn('DEL', 'small', () => d.deleteMemoryCueNear(), 'Delete the nearest memory cue')), hint('Pad = go to memory cue · Shift+click: delete'));
        break;
      case 'GROOVE': parts.push(hint('Drum swap 1–4 · bank · capture · roll · release FX')); break;
      default: break;
    }
    this.pageBar.replaceChildren(...parts);
  }

  // ---- key -------------------------------------------------------------------------------------

  /** KEY button: a small panel to shift the key by semitones, reset it, or turn KEY SYNC on. */
  keyPanel() {
    const d = this.deck;
    if (this.keyPop) { this.closeKeyPanel(); return; }
    const btn = (label, cls, onclick, title) => h(`button.dbtn${cls ? `.${cls}` : ''}`, { onclick, title }, label);
    this.keyPopVal = h('span.key-pop-val');
    this.keyPopKeys = h('div.key-pop-keys');
    this.keyPopSync = btn('KEY SYNC', 'keysync', () => d.toggleKeySync(), 'Match the master deck\'s key');
    const pop = h('div.key-pop', {},
      h('div.key-pop-title', {}, 'KEY SHIFT'),
      this.keyPopKeys,
      h('div.key-pop-row', {},
        btn('▼', '', () => d.setKeyShift(d.keyShift - 1), 'One semitone down'),
        this.keyPopVal,
        btn('▲', '', () => d.setKeyShift(d.keyShift + 1), 'One semitone up')),
      h('div.key-pop-row', {}, btn('RESET', 'small', () => d.setKeyShift(0), 'Original key'), this.keyPopSync));
    document.body.append(pop);
    const r = this.keyBox.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${r.bottom + 4}px`;
    this.keyPop = pop;
    this.keyPopOff = (e) => { if (!pop.contains(e.target) && !this.keyBox.contains(e.target)) this.closeKeyPanel(); };
    this.keyPopEsc = (e) => { if (e.key === 'Escape') this.closeKeyPanel(); };
    document.addEventListener('pointerdown', this.keyPopOff, true);
    document.addEventListener('keydown', this.keyPopEsc);
    this.refresh();
  }

  closeKeyPanel() {
    this.keyPop?.remove();
    this.keyPop = null;
    document.removeEventListener('pointerdown', this.keyPopOff, true);
    document.removeEventListener('keydown', this.keyPopEsc);
  }

  padMenu(e, slot) {
    const d = this.deck;
    const cue = d.hotCue(slot);
    if (!cue) return;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Rename…', action: async () => {
        const name = await promptText('Hot cue name', cue.name ?? '');
        if (name !== null) d.setCues(d.track.cues.map((c) => (c === cue ? { ...c, name } : c)));
      } },
      { label: 'Color', submenu: HOT_COLORS.map((css, i) => ({ label: TRACK_COLORS[i].name, checked: cue.color === css,
        action: () => d.setCues(d.track.cues.map((c) => (c === cue ? { ...c, color: css } : c))) })) },
      '-',
      { label: 'Delete', action: () => d.deleteHotCue(slot) },
    ]);
  }

  refresh() {
    const d = this.deck;
    const t = d.track;
    const notation = this.app.library.settings.keyNotation;
    this.title.textContent = t ? t.title || '(untitled)' : 'No track';
    this.artist.textContent = t ? t.artist || '' : '';
    const key = d.key;
    const shifted = d.keyShift ? transposeKey(key, d.keyShift) : key;
    this.keyEl.textContent = key ? displayKey(shifted, notation) : '—';
    this.keyEl.classList.toggle('shifted', !!d.keyShift);
    this.bpm.textContent = d.originalBpm ? d.currentBpm.toFixed(2) : '---.--';
    this.bpmSub.textContent = `${d.tempoPct >= 0 ? '+' : ''}${d.tempoPct.toFixed(2)}%`;
    this.bpmSub.title = d.originalBpm ? `Track BPM ${d.originalBpm.toFixed(2)}` : '';
    this.tempoEl.textContent = `${d.tempoPct >= 0 ? '+' : ''}${d.tempoPct.toFixed(1)}%`;
    // Artwork (embedded cover), or a placeholder tinted from the title.
    const artKey = t ? `${t.id}|${t.artwork ?? ''}` : '';
    if (this.artKey !== artKey) {
      this.artKey = artKey;
      this.art.style.backgroundImage = t?.artwork ? `url("${mediaUrl(t.artwork)}")` : '';
      const hue = t ? [...(t.title ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7) : 0;
      this.art.style.setProperty('--art-hue', hue);
      this.art.classList.toggle('empty', !t?.artwork);
      this.art.textContent = t && !t.artwork ? (t.title ?? '?').trim().charAt(0).toUpperCase() : '';
    }
    this.rangeBtn.textContent = d.tempoRange === 100 ? 'WIDE' : `±${d.tempoRange}`;
    this.tempoFader.value = String(d.tempoPct / d.tempoRange);
    this.masterBtn.classList.toggle('on', this.app.engine.masterDeck === d);
    this.syncBtn.classList.toggle('on', d.sync);
    this.keySyncBtn.classList.toggle('on', d.keySync);
    this.qBtn.classList.toggle('on', d.quantize);
    this.mtBtn.classList.toggle('on', d.keyLock);
    this.slipBtn.classList.toggle('on', d.slip);
    this.revBtn.classList.toggle('on', d.reverse);
    this.playBtn.classList.toggle('on', d.playing);
    this.loopSize.textContent = fmtBeats(d.beatLoopSize);
    this.loopBtn.classList.toggle('on', !!d.loop);
    this.exitBtn.textContent = d.loop ? 'EXIT' : 'RELOOP';
    this.inBtn.classList.toggle('on', d.pendingLoopIn !== undefined);
    this.jumpSize.textContent = String(d.beatJumpSize);
    const semis = `${d.keyShift > 0 ? '+' : ''}${d.keyShift}`;
    this.keyShiftVal.textContent = semis;
    if (this.kbBtn) this.kbBtn.textContent = String.fromCharCode(65 + this.kbCue);
    if (this.keyPop) {
      this.keyPopVal.textContent = semis;
      this.keyPopKeys.textContent = key ? `${displayKey(key, notation)} → ${displayKey(shifted, notation)}` : 'No key';
      this.keyPopSync.classList.toggle('on', d.keySync);
    }
    this.renderPads();
    this.renderStems();
  }

  renderStems() {
    const d = this.deck;
    const job = d.track ? this.app.stemJobs?.get(d.track.id) : null;
    const b = this.stemSepBtn;
    // STEMS button = state display: start, progress (with fill), FAST (click: upgrade to HQ), HQ.
    b.hidden = false;
    b.classList.toggle('busy', !!job);
    b.classList.toggle('done', !job && d.stemsComplete);
    if (job) {
      const pct = job.total > 1 ? Math.round((job.done / job.total) * 100) : 0;
      b.textContent = job.state === 'queued' ? `${job.quality.toUpperCase()} …` : `${job.quality.toUpperCase()} ${pct}%`;
      b.style.setProperty('--p', `${pct}%`);
      b.disabled = true;
      b.title = job.state === 'queued' ? 'Waiting for the stem engine' : `Separating stems (${job.quality.toUpperCase()}) — usable where the bar below the overview is filled`;
    } else if (d.stemsComplete) {
      b.textContent = (d.stemQuality ?? 'hq').toUpperCase();
      b.disabled = d.stemQuality === 'hq';
      b.title = d.stemQuality === 'hq' ? 'Stems: high quality (HT-Demucs)' : 'Stems: fast (Spleeter). Click to upgrade to high quality (HT-Demucs)';
      b.style.removeProperty('--p');
    } else {
      b.textContent = 'STEMS';
      b.disabled = !d.loaded;
      b.title = 'Separate this track into stems (starts at the play head, cached)';
      b.style.removeProperty('--p');
    }
    this.stemBtns.forEach((b, k) => {
      const idx = STEM_BUTTONS[k][1];
      b.disabled = !d.stemsReady;
      b.classList.toggle('on', d.stemsReady && d.stemGains[idx] > 0);
      b.classList.toggle('muted', d.stemsReady && d.stemGains[idx] === 0);
    });
  }

  // ---- pads ----------------------------------------------------------------------------------

  padDown(i, e) {
    const d = this.deck;
    const slot = this.bank * 8 + i;
    switch (this.padMode) {
      case 'HOT CUE': if (e.shiftKey) d.deleteHotCue(slot); else d.hotCuePress(slot); break;
      case 'PAD FX': this.app.padFxPress?.(d.index, slot, true); this.heldFx = slot; break;
      case 'BEAT LOOP': d.beatLoop(PAD_LOOPS[i]); break;
      case 'BEAT JUMP': d.beatJump(PAD_JUMPS[i]); break;
      case 'SLICER': d.slicerDown(i); this.heldSlice = true; break;
      case 'SAMPLER': this.app.samplerPress?.(slot, d); break;
      case 'KEY SHIFT': d.setKeyShift(d.keyShift === PAD_KEYS[i] ? 0 : PAD_KEYS[i]); break;
      case 'KEYBOARD': {
        // Play the chosen hot cue (A by default, else the cue point) transposed by the pad's semitone.
        d.setKeyShift(PAD_KEYBOARD[i]);
        const a = d.hotCue(this.kbCue) ?? d.hotCue(0);
        d.jumpTo(a ? a.start : d.cuePoint);
        if (!d.playing) d.play();
        break;
      }
      case 'STEMS': {
        const [, stem] = STEM_PADS[i % 4];
        if (!this.app.ensureStems(d)) break;
        if (i < 4) d.setStemOn(stem, d.stemGains[stem] === 0);
        else d.setFxPart(stem, !d.fxParts[stem]);
        break;
      }
      case 'MEMORY CUE': if (e.shiftKey) d.deleteMemoryCue(i); else d.callMemorySlot(i); break;
      case 'GROOVE': this.groovePad(i, e, true); break;
      default: break;
    }
    this.renderPads();
  }

  padUp(i) {
    if (this.padMode === 'SLICER' && this.heldSlice) { this.heldSlice = false; this.deck.slicerUp(); this.renderPads(); }
    if (this.padMode === 'PAD FX' && this.heldFx === this.bank * 8 + i) { this.heldFx = null; this.app.padFxPress?.(this.deck.index, this.bank * 8 + i, false); }
    if (this.padMode === 'GROOVE' && this.heldGroove === i) { this.heldGroove = null; this.groovePad(i, null, false); this.renderPads(); }
  }

  /** GROOVE pads: 1-4 DRUM SWAP, 5 bank A/B, 6 DRUM CAPTURE (Shift = length), 7 DRUM ROLL 1/4 (hold), 8 RELEASE FX (hold, Shift = type). */
  groovePad(i, e, down) {
    const d = this.deck;
    const g = this.app.groove?.[d.index];
    if (!g) return;
    if (!down) {
      if (i === 6) d.drumRoll(null);
      if (i === 7) d.drumRelease(false);
      return;
    }
    if (i < 4) { this.app.ensureStems(d); g.toggle(i); return; }
    if (i === 4) { g.setBank(1 - g.bank); return; }
    if (i === 5) { if (e?.shiftKey) g.cycleCaptureLength(); else if (this.app.ensureStems(d)) this.app.drumCapture(d.index); return; }
    if (i === 6) { if (this.app.ensureStems(d)) { d.drumRoll(1 / 4); this.heldGroove = i; } return; }
    if (i === 7) {
      if (e?.shiftKey) { d.cycleReleaseFx(); return; }
      if (this.app.ensureStems(d)) { d.drumRelease(true); this.heldGroove = i; }
    }
  }

  renderPads() {
    const d = this.deck;
    const mode = this.padMode;
    this.modeLabel.textContent = mode;
    if (BANKS[mode]) {
      this.bankBtn.textContent = BANKS[mode][this.bank];
      const used = (b) => Array.from({ length: 8 }, (_, i) => b * 8 + i).some((s) => (mode === 'HOT CUE' ? d.hotCue(s) : mode === 'SAMPLER' ? this.app.sampler?.slots[s]?.buffer : false));
      this.bankBtn.classList.toggle('on', used(1 - this.bank)); // lit when the hidden bank holds something
    }
    const memories = mode === 'MEMORY CUE' ? d.memoryCues() : null;
    this.pads.forEach((pad, i) => {
      const slot = this.bank * 8 + i;
      let letter = ''; let sub = ''; let color = 'transparent'; let set = false; let loopPad = false; let active = false;
      switch (mode) {
        case 'HOT CUE': {
          const cue = d.hotCue(slot);
          letter = String.fromCharCode(65 + slot);
          sub = cue ? (cue.name || fmtTime(cue.start)) : '';
          color = cue?.color ?? 'transparent'; set = !!cue; loopPad = cue?.end !== undefined;
          break;
        }
        case 'PAD FX': {
          const [fx, beats] = PAD_FX[slot] ?? PAD_FX[0];
          letter = fx; sub = `${fmtBeats(beats)} beat`; color = '#a24dff'; set = true;
          active = this.app.padFx?.[d.index]?.held === slot;
          break;
        }
        case 'BEAT LOOP': letter = fmtSigned(PAD_LOOPS[i]); sub = 'beat'; color = '#ff9a1f'; set = true; active = d.loop?.beats === PAD_LOOPS[i] && d.loop.slice === undefined; break;
        case 'BEAT JUMP': letter = `${PAD_JUMPS[i] > 0 ? '+' : ''}${PAD_JUMPS[i]}`; sub = 'jump'; color = '#3d7dff'; set = true; break;
        case 'SLICER': letter = String(i + 1); sub = 'slice'; color = '#25e6d6'; set = true; active = d.loop?.slice === i; break;
        case 'SAMPLER': {
          const s = this.app.sampler?.slots[slot];
          letter = String(slot + 1); sub = s?.name || 'capture'; color = s?.buffer ? '#a24dff' : 'transparent'; set = !!s?.buffer;
          active = !!this.app.sampler?.isPlaying(slot);
          break;
        }
        case 'KEY SHIFT': letter = `${PAD_KEYS[i] > 0 ? '+' : ''}${PAD_KEYS[i]}`; sub = 'semi'; color = '#ff3fa0'; set = true; active = d.keyShift === PAD_KEYS[i]; break;
        case 'KEYBOARD': letter = `${PAD_KEYBOARD[i] > 0 ? '+' : ''}${PAD_KEYBOARD[i]}`; sub = 'key'; color = '#ffe23a'; set = true; active = d.keyShift === PAD_KEYBOARD[i]; break;
        case 'STEMS': {
          const [label, stem] = STEM_PADS[i % 4];
          letter = label; sub = i < 4 ? 'part' : 'fx part'; color = STEM_PAD_COLORS[stem]; set = true;
          active = i < 4 ? d.stemsReady && d.stemGains[stem] > 0 : !!d.fxParts?.[stem];
          break;
        }
        case 'MEMORY CUE': {
          const cue = memories[i];
          letter = String(i + 1); sub = cue ? (cue.name || fmtTime(cue.start)) : '';
          color = cue ? '#ff4040' : 'transparent'; set = !!cue; loopPad = cue?.end !== undefined;
          active = !!cue && Math.abs(d.cuePoint - cue.start) < 0.01;
          break;
        }
        case 'GROOVE': {
          const g = this.app.groove?.[d.index];
          if (!g) break;
          set = true;
          if (i < 4) {
            const s = g.slot(i);
            letter = `${'AB'[g.bank]}${i + 1}`; sub = s?.name ?? ''; color = s?.captured ? '#25e6d6' : '#ffa91f'; active = g.isPlaying(i);
          } else if (i === 4) { letter = 'A/B'; sub = `bank ${'AB'[g.bank]}`; color = '#3d7dff'; }
          else if (i === 5) { letter = 'CAP'; sub = `${g.captureBars} bar`; color = '#25e6d6'; active = g.slots[g.bank].some((x) => x?.captured); }
          else if (i === 6) { letter = 'ROLL'; sub = '1/4'; color = '#ff9a1f'; active = this.heldGroove === 6; }
          else { letter = 'REL'; sub = d.releaseFx; color = '#ff4040'; active = this.heldGroove === 7; }
          break;
        }
        default: break;
      }
      pad.querySelector('.pad-letter').textContent = letter;
      pad.querySelector('.pad-time').textContent = sub;
      pad.classList.toggle('set', set);
      pad.classList.toggle('looppad', loopPad);
      pad.classList.toggle('active', active);
      pad.classList.toggle('fx', mode === 'PAD FX');
      pad.style.setProperty('--pad', color);
      pad.title = mode === 'HOT CUE' ? 'Hot cue (Shift+click delete, right-click for options)'
        : mode === 'GROOVE' ? ['DRUM SWAP 1', 'DRUM SWAP 2', 'DRUM SWAP 3', 'DRUM SWAP 4', 'Bank A/B', 'DRUM CAPTURE (Shift+click: 1/2/4 bars)', 'DRUM ROLL 1/4 (hold)', 'DRUM RELEASE FX (hold, Shift+click: type)'][i]
          : mode === 'STEMS' ? `${i < 4 ? 'ACTIVE PART' : 'FX PART SELECT'} ${STEM_PADS[i % 4][0]}`
            : mode === 'PAD FX' ? `${(PAD_FX[slot] ?? PAD_FX[0])[0]} (hold)`
              : mode === 'MEMORY CUE' ? 'Memory cue (Shift+click delete)' : mode;
    });
  }

  /** Per-frame updates (times, overview). */
  frame(style) {
    const d = this.deck;
    const pos = d.position();
    this.timeEl.textContent = fmtTime(pos, true);
    this.remainEl.textContent = `-${fmtTime(Math.max(0, d.duration - pos), true)}`;
    this.overview.draw(style);
    this.jog.draw();
    if (d.playing !== this.playBtn.classList.contains('on')) this.refresh();
    // Blink CUE while paused at a point other than cue (CDJ convention)
    this.cueBtn.classList.toggle('blink', d.loaded && !d.playing && Math.abs(pos - d.cuePoint) > 0.01);
  }
}
