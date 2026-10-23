import { Library } from './library.js';
import { AudioEngine } from './audio/engine.js';
import { Analyzer, mediaUrl, waveformArrays } from './analysis/analyzer.js';
import { wavePreview } from '../shared/dsp/waveform.js';
import { PHRASE_LABELS, phraseAt, relabelPhrase, splitPhrase, mergePhrase } from '../shared/dsp/phrase.js';
import { DeckView } from './ui/deck-view.js';
import { MixerView, FxView, deckOrder } from './ui/mixer-view.js';
import { Browser } from './ui/browser.js';
import { drawDetail } from './ui/waveform.js';
import { installKeyboard } from './ui/keyboard.js';
import { openSettings } from './ui/settings.js';
import { MidiController } from './ui/midi.js';
import { PluginRegistry } from './controller/plugins.js';
import { applyTheme } from './themes.js';
import { editSample } from './ui/sample-editor.js';
import { openDrumSwapEditor } from './ui/drum-swap-editor.js';
import { checkForUpdates, openUpdateDialog } from './ui/updates.js';
import { openLicenseGate } from './ui/license.js';
import { Sampler } from './audio/sampler.js';
import { SamplerView } from './ui/sampler-view.js';
import { Automix } from './automix.js';
import { DrumSwap } from './audio/groove.js';
import { BeatFxUnit, PAD_FX } from './audio/fx.js';
import { encodeWav } from '../shared/wav.js';
import { toBeatgrid, shiftGrid, doubleGrid, halveGrid, setDownbeatAt, constantGridAt, tapBpm } from '../shared/beatgrid.js';
import { createCues } from '../shared/autocues.js';
import { transposeKey } from '../shared/keys.js';
import { RELEASE_FX } from './audio/deck.js';
import { STEM_ENGINES, ENGINE_NAMES, pickEngine } from '../shared/stem-engines.js';
import { h, toast, fmtTime, contextMenu, modal } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { exportRekordboxXml, importRekordboxXml } from '../shared/rekordbox-xml.js';
import { openRekordboxImport } from './ui/rekordbox-import.js';
import { DownloadCenter } from './ui/downloads.js';
import { openRelink } from './ui/relink.js';
import { openSetup } from './ui/setup.js';

const fmtLoopBeats = (b) => (b >= 1 ? String(Math.round(b * 100) / 100) : `1/${Math.round(1 / b)}`);

/** One cached stem as interleaved 16-bit stereo: WAV beside the track (skip the 44-byte header) or legacy raw PCM. */
async function readStem(meta, name) {
  const ext = { wav: 'wav', mp3: 'mp3' }[meta.format] ?? 'pcm';
  const res = await fetch(mediaUrl(`${meta.dir}/${name}.${ext}`));
  if (!res.ok) throw new Error(`stem ${name}: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (ext === 'wav') return new Int16Array(buf, 44, (buf.byteLength - 44) >> 1);
  if (ext === 'pcm') return new Int16Array(buf);
  // MP3: decoded at the stems' rate, encoder delay removed, same length as the separation.
  const b = await new OfflineAudioContext(2, 1, meta.rate).decodeAudioData(buf);
  const skip = meta.mp3Delay ?? 0;
  const l = b.getChannelData(0); const r = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
  const n = meta.frames ?? b.length - skip;
  const out = new Int16Array(n * 2);
  for (let i = 0, j = skip; i < n && j < b.length; i++, j++) {
    out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[j] * 32768)));
    out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[j] * 32768)));
  }
  return out;
}

/** Stem file format from the settings: {format: 'mp3', kbps} or {format: 'wav'}. */
function stemsFormat(s) {
  const f = s.stemsFormat ?? 'mp3';
  return f === 'wav' ? { format: 'wav' } : { format: 'mp3', kbps: f === 'mp3-320' ? 320 : 256 };
}

const DECK_COLORS = ['#ffffff', '#ffffff', '#ffffff', '#ffffff']; // play head: white like rekordbox

class App {
  async init() {
    this.library = await Library.load();
    this.engine = new AudioEngine();
    await this.engine.init(4); // 4 decks always exist; the layout shows 2 or 4
    this.analyzer = new Analyzer(this.engine.ctx);
    this.queue = [];
    this.analyzing = false;
    this.modeOverride = new Map(); // trackId -> 'normal' | 'dynamic' for one re-analysis
    this.applySettingsToEngine();

    this.engine.onCuesChanged = (id, cues) => this.library.update(id, { cues });
    this.engine.onTrackPlayed = (deck) => this.library.addToHistory(deck.track.id);
    this.sampler = new Sampler(this.engine);
    this.automix = new Automix(this);
    // Groove Circuit DRUM SWAP per deck (loops enter the channel before trim/EQ) and PAD FX units.
    this.groove = this.engine.decks.map((d, i) => new DrumSwap(d, this.engine.channels[i].trim));
    this.installGroovePersistence();
    this.groove.forEach((g, i) => g.addEventListener('change', () => { if (this.deckViews?.[i]?.padMode === 'GROOVE') this.deckViews[i].renderPads(); }));
    this.padFx = this.engine.decks.map((d, i) => {
      const unit = new BeatFxUnit(this.engine.ctx, this.engine.fx.inserts, this.engine.fx.bpmOf);
      unit.setTarget(`ch${i + 1}`);
      unit.held = null;
      return unit;
    });
    this.automix.settings = { ...this.automix.settings, ...(this.library.settings.automix ?? {}) };

    this.deckViews = this.engine.decks.map((d) => new DeckView(d, this));
    this.sampler.addEventListener('change', () => {
      this.deckViews.forEach((v) => { if (v.padMode === 'SAMPLER') v.renderPads(); });
      this.library.settings = { ...this.library.settings, sampler: this.sampler.config() };
      this.library.scheduleSave();
    });
    this.engine.decks.forEach((d) => d.addEventListener('change', (e) => {
      if (e.detail !== 'load') return;
      if (this.browser?.seedDependent) this.browser.refreshRows(); else this.browser?.renderBody();
    }));
    this.engine.addEventListener('master', () => { if (this.browser?.seedDependent) this.browser.refreshRows(); });
    this.deckViews.forEach((v, i) => {
      v.el.querySelector('.deck-headbtns').append(
        h('button.dbtn.small.icon-btn', { title: 'Beatgrid', onclick: (e) => this.gridMenu(e, i) }, icon('grid')),
        h('button.dbtn.small.icon-btn', { title: 'Deck menu', onclick: (e) => this.deckMenu(e, i) }, icon('more')));
    });
    this.mixer = new MixerView(this.engine, {
      // Color FX starts off (plain FILTER on the COLOR knobs), like the controller; the last type
      // chosen is remembered for CFX ON.
      colorFx: 'FILTER',
      onColorFx: (type) => { if (type !== 'FILTER') this.library.setSetting('colorFx', type); },
      onPartIso: (i) => this.ensureStems(this.engine.decks[i]),
    });
    this.fxView = new FxView(this.engine.fx, this.engine.decks.length);
    this.browser = new Browser(this);
    this.waveCanvases = this.engine.decks.map((d, i) => {
      const c = h('canvas.detail', { title: 'Drag to scrub, wheel to zoom' });
      this.attachScrub(c, d);
      return c;
    });
    // Enlarged waveforms with a coloured deck marker on the left, like rekordbox.
    // The canvas sits absolutely inside a box so its size always equals the visible area
    // (a flex canvas can be sized from its own pixel width and get clipped, off-centring the play head).
    this.waveRows = this.waveCanvases.map((c, i) => h(`div.wave-row.deck${i + 1}`, {}, h('div.wave-badge', {}, String(i + 1)), h('div.canvas-box', {}, c)));
    this.zoom = 8;

    // ---- global section (top bar) ----
    const s = this.library.settings;
    const gtoggle = (iconName, label, title, onclick) => h('button.gbtn', { title, onclick }, icon(iconName), h('span', {}, label));
    this.recBtn = gtoggle('rec', 'REC', 'Record the master output (WAV)', () => this.toggleRecording());
    this.recBtn.classList.add('rec');
    this.recTime = h('span.rec-time');
    this.downloads = new DownloadCenter(this);
    this.dlBtn = gtoggle('download', 'DOWNLOAD', 'Download tracks: search YouTube or SoundCloud, links, new releases', () => this.downloads.open(this.downloads.newCount ? 'feeds' : 'search'));
    this.dlBadge = h('span.dl-badge', { hidden: true });
    // Shown when GitHub has a newer version.
    this.updatePill = h('button.update-pill', { hidden: true, title: 'A new version of Reboxed is available', onclick: () => openUpdateDialog(this) });
    this.trialPill = h('button.trial-pill', { hidden: true, title: 'Free trial: activate a licence in Preferences > About', onclick: () => this.openSettings('about') });
    this.dlBtn.append(this.dlBadge);
    this.samplerView = new SamplerView(this.sampler, this);
    this.samplerView.el.hidden = !s.showSampler;
    this.samplerBtn = gtoggle('sampler', 'SAMPLER', 'Show/hide the sampler', () => this.toggleSampler());
    this.samplerBtn.classList.toggle('on', !this.samplerView.el.hidden);
    this.fxBtn = gtoggle('fx', 'FX', 'Show/hide the Beat FX panel', () => this.togglePanel('fx'));
    this.mixerBtn = gtoggle('mixer', 'MIXER', 'Show/hide the mixer', () => this.togglePanel('mixer'));
    this.automixBtn = gtoggle('automix', 'AUTOMIX', 'Automix the current list', (e) => this.automixMenu(e));
    this.automixStatus = h('span.automix-status');
    this.automix.addEventListener('change', () => this.refreshAutomix());
    this.mplBtn = gtoggle('link', 'MIX POINT LINK', 'Mix Point Link: when a deck reaches its MIX OUT, start the other deck from its MIX IN (synced)', () => {
      this.library.setSetting('mixPointLink', !this.library.settings.mixPointLink);
      this.mplBtn.classList.toggle('on', this.library.settings.mixPointLink);
    });
    this.mplBtn.classList.toggle('on', !!s.mixPointLink);
    this.modeSel = h('select.mode-select', { title: 'Mode', onchange: (e) => document.body.classList.toggle('browse-full', e.target.value === 'library') },
      h('option', { value: 'performance' }, 'PERFORMANCE'), h('option', { value: 'library' }, 'LIBRARY'));
    this.layoutBtns = [
      h('button.lbtn', { title: '2 decks', onclick: () => { this.library.setSetting('deckCount', 2); this.applyLayout(); } }, icon('layout2')),
      h('button.lbtn', { title: '4 decks', onclick: () => { this.library.setSetting('deckCount', 4); this.applyLayout(); } }, icon('layout4')),
      h('button.lbtn', { title: 'Full browser (Space)', onclick: () => this.toggleLayout() }, icon('browser')),
    ];
    this.midiStatus = h('span.gstat.midi', { title: 'MIDI controller' }, icon('midi'), h('span', {}, '—'));
    this.stemStatus = h('span.stem-status', { hidden: true, title: 'Stem separation' }, h('span.ss-dot'), h('span.ss-label', {}, 'STEMS'), h('span.ss-text'));
    this.clock = h('span.gstat.clock');
    this.fxPanel = h('section.fxpanel', {}, this.fxView.el);
    this.lastPos = [];
    const root = h('div.app', {},
      // Top bar, grouped by use: [logo · mode · layout]   [panels shown | mixing helpers]
      // [tools: download, record]   [status: stems, MIDI, clock · appearance · preferences].
      h('header.gbar', {},
        h('div.gbar-left', {},
          h('div.wordmark', {}, h('img', { src: 'assets/logo.svg', alt: '' }), h('span', {}, 're', h('b', {}, 'box'), 'ed')),
          this.modeSel,
          h('div.lbtns', {}, this.layoutBtns)),
        h('div.gbar-center', {},
          h('div.ggroup', { title: 'Panels' }, this.fxBtn, this.mixerBtn, this.samplerBtn),
          h('div.ggroup', { title: 'Mixing helpers' }, this.mplBtn, this.automixBtn, this.automixStatus),
          h('div.ggroup', { title: 'Tools' }, this.dlBtn, this.recBtn, this.recTime)),
        h('div.gbar-right', {}, this.trialPill, this.updatePill, this.stemStatus, this.midiStatus, this.clock,
          h('button.lbtn', { onclick: () => this.openSettings('appearance'), title: 'Appearance: themes, colours, size' }, icon('palette')),
          h('button.lbtn', { onclick: () => this.openSettings(), title: 'Preferences' }, icon('gear')))),
      this.fxPanel,
      (this.wavesEl = h('section.waves')),
      (this.decksEl = h('section.decks')),
      this.samplerView.el,
      this.browser.el);
    document.body.replaceChildren(root);
    applyTheme(this.library.settings);
    this.applyPanels();
    this.applyLayout();
    this.restoreSampler();

    installKeyboard(this);
    this.installFileDrop();
    this.installStems();
    this.plugins = new PluginRegistry(this.library);
    this.midi = new MidiController(this);
    this.plugins.refresh().then(() => this.midi.init());
    this.library.addEventListener('change', (e) => this.onLibraryChange(e.detail));
    requestAnimationFrame((t) => this.frame(t));
    // Licence: trial pill, or the activation dialog once the trial is over; keys are re-checked online.
    window.rb.license.status().then(async (st) => {
      this.applyLicense(st);
      if (st.needsCheck) this.applyLicense(await window.rb.license.validate().catch(() => st));
      // First launch with an empty library: the setup assistant (each step can be skipped).
      const params = new URLSearchParams(location.search);
      if (this.license?.mode !== 'expired' && !params.has('smoke') && !params.has('shots') && !this.library.settings.setupDone) {
        if (this.library.tracks.size) this.library.setSetting('setupDone', true); // libraries from before 1.18
        else openSetup(this);
      }
    });
    // New releases from followed channels, quietly, a few seconds after start.
    if (!new URLSearchParams(location.search).has('smoke') && !new URLSearchParams(location.search).has('shots') && this.library.settings.checkUpdates !== false) {
      setTimeout(() => checkForUpdates(this, { silent: true }).then((info) => { if (info?.newer) toast(`Reboxed ${info.latest} is available: click the update button in the top bar`, 7000); }), 5000);
    }
    if (!new URLSearchParams(location.search).has('smoke') && this.downloads.cfg.checkOnStart && this.downloads.cfg.subs.length) {
      setTimeout(() => this.downloads.checkFeeds().catch(() => {}), 8000);
    }
    window.addEventListener('beforeunload', () => { this.library.saveNow(); });
  }

  // ---- settings --------------------------------------------------------------------------------

  applySettingsToEngine() {
    const s = this.library.settings;
    this.engine.setCrossfaderCurve(s.crossfaderCurve);
    this.engine.setFaderCurve(s.faderCurve);
    this.engine.autoGainOn = s.autoGain;
    this.engine.syncMode = s.syncMode;
    this.engine.syncDoubleHalf = s.syncDoubleHalf;
    this.engine.decks.forEach((d) => { if (!d.loaded) d.tempoRange = s.defaultTempoRange; });
    if (s.masterDevice) {
      this.engine.setMasterDevice(s.masterDevice)
        .then(() => { if (s.outputLayout === 'quad') this.engine.setOutputLayout('quad'); })
        .catch(() => toast('Master output device unavailable'));
    }
    if (s.phonesDevice) this.engine.setPhonesDevice(s.phonesDevice).catch(() => toast('Headphone device unavailable'));
    if ((s.masterCopyDevice ?? '') !== (this.masterCopyApplied ?? '')) {
      this.masterCopyApplied = s.masterCopyDevice ?? '';
      this.engine.setMasterCopyDevice(this.masterCopyApplied).catch(() => toast('Second master output unavailable'));
    }
  }

  /** @param {string} [tab] general | decks | audio | library | stems | downloads | midi | keyboard */
  openSettings(tab) {
    if (typeof tab === 'string') { try { localStorage.setItem('reboxed.settingsTab', tab); } catch { /* private storage */ } }
    return openSettings(this.library, this.engine, (key, value) => this.applySetting(key, value), this.midi, this);
  }

  /** Change one setting and apply it (Preferences, setup assistant). */
  applySetting(key, value) {
    this.library.setSetting(key, value);
    if (key === 'masterDevice') this.engine.setMasterDevice(value).catch((e) => toast(String(e)));
    else if (key === 'outputLayout') { try { this.engine.setOutputLayout(value); } catch (e) { toast(e.message, 6000); } }
    else if (key === 'phonesDevice') this.engine.setPhonesDevice(value).catch((e) => toast(String(e)));
    else if (key === 'deckCount') this.applyLayout();
    else if (['theme', 'themeAccent', 'uiScale', 'topbarLabels'].includes(key)) applyTheme(this.library.settings);
    else this.applySettingsToEngine();
    this.deckViews.forEach((v) => v.refresh());
  }

  onLibraryChange({ kind, id }) {
    if (kind === 'track' && id) {
      const t = this.library.get(id);
      for (const d of this.engine.decks) if (d.track?.id === id) d.updateTrack(t, this.deckAnalysis(t, d.analysis));
    }
  }

  toggleLayout() {
    const full = document.body.classList.toggle('browse-full');
    if (this.modeSel) this.modeSel.value = full ? 'library' : 'performance';
  }

  /** FX / MIXER panels shown or hidden from the global section (saved). */
  togglePanel(name) {
    const key = name === 'fx' ? 'hideFx' : 'hideMixer';
    this.library.settings = { ...this.library.settings, [key]: !this.library.settings[key] };
    this.library.scheduleSave();
    this.applyPanels();
  }

  applyPanels() {
    const s = this.library.settings;
    this.fxPanel.hidden = !!s.hideFx;
    this.fxBtn.classList.toggle('on', !s.hideFx);
    document.body.classList.toggle('no-mixer', !!s.hideMixer);
    this.mixerBtn.classList.toggle('on', !s.hideMixer);
  }

  get deckCount() { return this.library.settings.deckCount === 4 ? 4 : 2; }
  visibleDecks() { return this.engine.decks.slice(0, this.deckCount); }

  /** 2-deck: [1] mixer [2]   4-deck: [3][1] mixer [2][4], like the channels of a 4-deck controller. */
  applyLayout() {
    const n = this.deckCount;
    this.engine.decks.slice(n).forEach((d) => { if (d.playing) d.pause(); });
    const order = deckOrder(n);
    const views = order.map((i) => this.deckViews[i].el);
    this.decksEl.classList.toggle('four', n === 4);
    this.wavesEl.classList.toggle('four', n === 4);
    this.decksEl.replaceChildren(...views.slice(0, n / 2), this.mixer.el, ...views.slice(n / 2));
    this.wavesEl.replaceChildren(...order.map((i) => this.waveRows[i]));
    this.layoutBtns?.forEach((b, k) => b.classList.toggle('on', k === (n === 4 ? 1 : 0)));
    this.mixer.setDeckCount(n);
    this.browser?.renderTree();
  }

  // ---- loading & analysis ----------------------------------------------------------------------

  /** Stored analysis merged with the track's own grid/key (from xml import or edits). */
  deckAnalysis(track, stored) {
    if (!stored && !track.beatgrid) return stored;
    return { ...(stored ?? {}), beatgrid: track.beatgrid ?? stored?.beatgrid ?? null, key: track.key || stored?.key || '' };
  }

  loadToFreeDeck(trackId) {
    const decks = this.visibleDecks();
    const target = decks.find((d) => !d.loaded) ?? decks.find((d) => !d.playing) ?? null;
    if (!target) { toast('All decks are playing'); return; }
    this.loadTrack(target.index, trackId);
  }

  async loadTrack(deckIndex, trackId) {
    const deck = this.engine.decks[deckIndex];
    const track = this.library.get(trackId);
    if (!deck || !track) return;
    // Load lock (Preferences ▸ Decks & Mixer): by default a playing deck cannot be replaced by mistake.
    if (deck.playing && !this.library.settings.loadOnPlaying) { toast(`Deck ${deckIndex + 1} is playing — pause it first (or allow it in Preferences ▸ Decks & Mixer)`, 3500); return; }
    deck.loading = true;
    try {
      const buffer = await this.analyzer.decode(track.path);
      let stored = await window.rb.getAnalysis(trackId);
      if (!stored) stored = await this.storeAnalysis(trackId, await this.analyzer.analyzeBuffer(buffer, this.analysisOptions(track)), buffer.duration);
      const fresh = this.library.get(trackId);
      deck.setLoaded(fresh, buffer, this.deckAnalysis(fresh, stored));
      if (fresh.missing) this.library.update(trackId, { missing: false });
      if (stored?.vocals) deck.vocals = stored.vocals;
      // Cached stems load in the background; the deck plays the original mix meanwhile.
      // With "Separate stems on load" (like Serato's "Analyze Stems on song load") new tracks start right away.
      window.rb.stems.meta(trackId, fresh.path).then((meta) => {
        if (meta) return this.loadStemsInto(deck, meta);
        if (this.library.settings.stemsOnLoad) return this.separateStems(trackId, { deck });
        return null;
      }).catch((err) => console.warn('stems', err));
    } catch (err) {
      console.error(err);
      toast(`Cannot load "${track.title}": ${err.message}`, 5000);
      this.library.update(trackId, { missing: true });
    } finally {
      deck.loading = false;
      this.browser.renderBody();
    }
  }

  /** Options for the analysis worker; a track's own grid (xml import, edits, lock) is kept. */
  analysisOptions(track) {
    const s = this.library.settings;
    const mode = this.modeOverride.get(track?.id) ?? s.analysisMode;
    this.modeOverride.delete(track?.id);
    return { bpmRange: s.bpmRange, mode, fixedGrid: track?.beatgrid ?? null };
  }

  async storeAnalysis(trackId, result, duration) {
    // Phrases corrected by hand survive a new analysis.
    const before = await window.rb.getAnalysis(trackId).catch(() => null);
    if (before?.phrases?.edited) result = { ...result, phrases: before.phrases };
    await window.rb.putAnalysis(trackId, result);
    const t = this.library.get(trackId);
    if (t) {
      const wf = waveformArrays(result);
      const patch = { analyzed: true, key: (t.source === 'rekordbox' && t.key) || result.key || t.key, duration: duration || t.duration, features: result.features,
        ...(wf ? { wavePreview: wavePreview(wf) } : {}) };
      if (!t.beatgrid && result.beatgrid) { patch.beatgrid = result.beatgrid; patch.bpm = result.beatgrid.bpm; }
      // Intelligent cue creation (Preferences > Analysis), never overwriting the DJ's cues.
      if (this.library.settings.autoCues && result.phrases?.phrases?.length && !t.cues?.length) {
        patch.cues = createCues(result.phrases, toBeatgrid(patch.beatgrid ?? t.beatgrid), t.cues ?? []);
      }
      const fresh = this.library.update(trackId, patch);
      // Decks holding this track pick up the new grid/phrases immediately.
      for (const d of this.engine.decks) if (d.track?.id === trackId) d.updateTrack(fresh, this.deckAnalysis(fresh, { ...d.analysis, ...result }));
    }
    return result;
  }

  /**
   * Browser Preview column for a track analysed before 1.18: the small waveform is made from its
   * stored analysis, a few at a time (rows on screen ask for it).
   */
  fillPreview(trackId) {
    this.previewQueue ??= new Set();
    if (this.previewQueue.has(trackId) || this.previewTried?.has(trackId)) return;
    this.previewQueue.add(trackId);
    if (this.previewRunning) return;
    this.previewRunning = true;
    this.previewTried ??= new Set();
    (async () => {
      while (this.previewQueue.size) {
        const id = this.previewQueue.values().next().value;
        this.previewQueue.delete(id);
        this.previewTried.add(id);
        try {
          const wf = waveformArrays(await window.rb.getAnalysis(id));
          if (wf) this.library.update(id, { wavePreview: wavePreview(wf) });
        } catch { /* no stored analysis: the cell stays empty */ }
      }
      this.previewRunning = false;
    })();
  }

  /** Deck/browser action: add phrase-based cues to a track (keeps existing hot cue slots). */
  async createCuesFor(trackId) {
    const t = this.library.get(trackId);
    const stored = await window.rb.getAnalysis(trackId);
    if (!t || !stored?.phrases?.phrases?.length) { toast('No phrase analysis for this track yet (analyze it first)'); return; }
    const cues = createCues(stored.phrases, toBeatgrid(t.beatgrid ?? stored.beatgrid), t.cues ?? []);
    const added = cues.length - (t.cues?.length ?? 0);
    this.library.update(trackId, { cues });
    toast(added ? `${added} cue(s) created from phrases` : 'Cues already present');
  }

  analyzeTracks(ids) {
    const queued = new Set(this.queue);
    for (const id of ids) if (!queued.has(id)) this.queue.push(id);
    this.analyzeTotal = (this.analyzeTotal ?? 0) + ids.length;
    this.runQueue();
  }

  async runQueue() {
    if (this.analyzing) return;
    this.analyzing = true;
    let done = 0;
    while (this.queue.length) {
      const id = this.queue.shift();
      const t = this.library.get(id);
      done++;
      this.browser.setStatus(`Analyzing ${done}/${done + this.queue.length}: ${t?.title ?? ''}`);
      if (!t) continue;
      try {
        const r = await this.analyzer.analyzePath(t.path, this.analysisOptions(t));
        const { duration, ...result } = r;
        await this.storeAnalysis(id, result, duration);
      } catch (err) {
        console.warn('analysis failed', t.path, err);
        this.library.update(id, { missing: /Cannot read/.test(err.message) });
      }
    }
    this.analyzing = false;
    this.analyzeTotal = 0;
    this.browser.setStatus(done ? `Analysis finished (${done} track${done > 1 ? 's' : ''})` : '');
  }

  // ---- import / export -------------------------------------------------------------------------

  /** @returns {Promise<string[]>} ids of the tracks added */
  async importPaths(paths) {
    if (!paths.length) return [];
    const off = window.rb.onScanProgress((d, n) => this.browser.setStatus(`Reading tags ${d}/${n}`));
    try {
      const results = await window.rb.scanPaths(paths);
      const added = this.library.addScanned(results);
      this.browser.setStatus(`${added.length} track(s) added`);
      toast(`${added.length} track(s) added to the collection`);
      if (added.length && this.library.settings.autoAnalyze) this.analyzeTracks(added);
      return added;
    } finally { off(); }
  }

  async importFolder() { this.importPaths(await window.rb.openFolder()); }
  async importFiles() { this.importPaths(await window.rb.openFiles('audio')); }

  /** File > Import from rekordbox: the import tool (preview, playlists, merge rules, moved files). */
  importXml(file = null) { return openRekordboxImport(this, file); }

  async exportXml() {
    const path = await window.rb.saveFileDialog('collection.xml', 'xml');
    if (!path) return;
    // Intelligent playlists are exported as their current contents (rekordbox.xml has no smart nodes).
    const resolve = (nodes) => nodes.map((n) => (n.type === 'folder' ? { ...n, children: resolve(n.children) }
      : n.type === 'smart' ? { type: 'playlist', name: n.name, trackIds: this.library.rowsFor(n.id).map((r) => r.track.id) } : n));
    await window.rb.writeFile(path, exportRekordboxXml({ tracks: this.library.all(), playlists: resolve(this.library.playlists) }));
    toast('Collection exported');
  }

  async exportM3u(node) {
    const path = await window.rb.saveFileDialog(`${node.name}.m3u8`, 'm3u8');
    if (!path) return;
    const lines = ['#EXTM3U', ...node.trackIds.map((id) => this.library.get(id)).filter(Boolean)
      .flatMap((t) => [`#EXTINF:${Math.round(t.duration ?? 0)},${t.artist ? `${t.artist} - ` : ''}${t.title}`, t.path])];
    await window.rb.writeFile(path, `${lines.join('\n')}\n`);
    toast('Playlist exported');
  }

  async findMissing() {
    const tracks = this.library.all();
    let missing = 0;
    for (const t of tracks) {
      const exists = await window.rb.exists(t.path);
      if (!exists) missing++;
      if (!!t.missing !== !exists) this.library.update(t.id, { missing: !exists }, { silent: true });
    }
    this.browser.refreshRows();
    toast(missing ? `${missing} missing file(s) (shown in red)` : 'All files found');
  }

  installFileDrop() {
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => window.rb.pathForFile(f)).filter(Boolean);
      const xml = paths.find((p) => p.toLowerCase().endsWith('.xml'));
      if (xml) {
        this.importXml(xml);
      } else {
        this.importPaths(paths);
      }
    });
  }

  // ---- sampler ---------------------------------------------------------------------------------

  toggleSampler() {
    this.samplerView.el.hidden = !this.samplerView.el.hidden;
    this.samplerBtn.classList.toggle('on', !this.samplerView.el.hidden);
    this.library.settings = { ...this.library.settings, showSampler: !this.samplerView.el.hidden };
    this.library.scheduleSave();
  }

  async restoreSampler() {
    const cfg = this.library.settings.sampler ?? [];
    await Promise.all(cfg.map(async (s, i) => {
      if (!s?.path) return;
      try {
        const buffer = await this.analyzer.decode(s.path);
        this.sampler.setSlot(i, { ...s, buffer });
      } catch { /* file moved: leave the slot empty */ }
    }));
  }

  async loadSamplerSlot(i, trackId) {
    const t = this.library.get(trackId);
    if (!t) return;
    try {
      const buffer = await this.analyzer.decode(t.path);
      this.sampler.setSlot(i, { name: t.title, path: t.path, bpm: t.beatgrid?.bpm ?? t.bpm ?? 0, buffer, mode: buffer.duration < 20 ? 'oneshot' : 'loop' });
    } catch (err) {
      toast(`Cannot load sample: ${err.message}`);
    }
  }

  /** A sample as a WAV file in the library's samples folder. */
  async writeSampleFile(name, chans, sr) {
    const { userData } = await window.rb.paths();
    const path = `${userData}\\samples\\${String(name).replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.wav`;
    await window.rb.writeFile(path, encodeWav(chans, sr));
    return path;
  }

  /**
   * What a capture takes from a deck: its active loop, else a loop of the chosen size starting on
   * the closest beat (what AUTO BEAT LOOP would set). Null when nothing is loaded.
   */
  captureRange(d) {
    if (!d?.loaded) return null;
    if (d.loop) return { start: d.loop.start, end: d.loop.end, beats: d.loop.beats };
    const bg = d.bg;
    const beats = d.beatLoopSize;
    const pos = d.position();
    const start = bg ? Math.max(0, bg.snap(pos, Math.min(1, beats))) : pos;
    const end = Math.min(d.duration, bg ? bg.timeOf(bg.indexAt(start) + beats) : start + beats * (d.period || 0.5));
    return end - start > 0.01 ? { start, end, beats } : null;
  }

  /**
   * Audio of [start, end) on a deck as it is heard: with stems, only the audible parts (at their
   * level); otherwise the track. Returns {chans, sr, parts} (parts: stem labels or null).
   */
  async deckAudio(d, start, end) {
    const gains = d.stemsReady ? d.stemGains : null;
    const partial = gains && gains.some((g) => g < 0.999);
    if (partial && d.stemMeta) {
      const meta = d.stemMeta;
      const sr = meta.rate;
      const a = Math.max(0, Math.round(start * sr)); const n = Math.max(1, Math.round((end - start) * sr));
      const chans = [new Float32Array(n), new Float32Array(n)];
      for (let k = 0; k < 4; k++) {
        if (gains[k] < 1e-3) continue;
        const pcm = await readStem(meta, meta.stems[k]);
        const g = gains[k] / 32768;
        for (let i = 0; i < n && 2 * (a + i) + 1 < pcm.length; i++) { chans[0][i] += pcm[2 * (a + i)] * g; chans[1][i] += pcm[2 * (a + i) + 1] * g; }
      }
      const parts = ['DRUMS', 'BASS', 'INST', 'VOCAL'].filter((_, k) => gains[k] >= 1e-3);
      return { chans, sr, parts };
    }
    if (partial) toast('Stems are still being separated: the full mix was captured', 4000);
    const full = await this.analyzer.decode(d.track.path);
    const sr = full.sampleRate;
    const a = Math.round(start * sr); const b = Math.round(end * sr);
    const chans = Array.from({ length: Math.min(2, full.numberOfChannels) }, (_, c) => full.getChannelData(c).slice(a, b));
    return { chans, sr, parts: null };
  }

  /**
   * Save a deck's loop (see captureRange) as a WAV sample, in `slot` or the first free slot.
   * With stems, only the audible stems are captured.
   * @param {number} deckIndex
   * @param {number|null} [slot]
   */
  async captureLoop(deckIndex, slot = null) {
    const d = this.engine.decks[deckIndex];
    const range = this.captureRange(d);
    if (!range) { toast('Load a track first'); return null; }
    if (slot === null) slot = this.sampler.slots.findIndex((s) => !s.buffer);
    if (slot < 0) { toast('Sampler is full'); return null; }
    this.capturing ??= new Set();
    if (this.capturing.has(slot)) return null; // a capture into this slot is already running
    this.capturing.add(slot);
    try {
      const { chans, sr, parts } = await this.deckAudio(d, range.start, range.end);
      const beats = range.beats ? `${Math.round(range.beats * 100) / 100}b` : 'loop';
      const name = `${d.track.title} ${beats}${parts ? ` ${parts.join('+')}` : ''}`;
      const path = await this.writeSampleFile(name, chans, sr);
      const buffer = new AudioBuffer({ numberOfChannels: chans.length, length: chans[0].length, sampleRate: sr });
      chans.forEach((c, i) => buffer.copyToChannel(c, i));
      this.sampler.setSlot(slot, { name, path, bpm: d.originalBpm, buffer, mode: 'loop' });
      toast(`${d.loop ? 'Loop' : `${fmtLoopBeats(range.beats)} beats`} captured to sampler slot ${slot + 1}${parts ? ` (${parts.join(' + ')})` : ''}`);
      return slot;
    } catch (err) {
      toast(`Capture failed: ${err.message}`, 5000);
      return null;
    } finally {
      this.capturing.delete(slot);
    }
  }

  /**
   * Sampler slot pressed: a loaded slot plays; an empty one captures from `deck`, else the deck
   * with a loop (master first), else the master / a playing deck at the chosen loop size.
   */
  async samplerPress(i, deck = null) {
    if (this.sampler.slots[i].buffer) { this.sampler.trigger(i); return; }
    const decks = [deck, this.engine.masterDeck, ...this.visibleDecks().filter((d) => d.playing), ...this.visibleDecks()].filter((d) => d?.loaded);
    const src = deck?.loaded ? deck : decks.find((d) => d.loop) ?? decks[0];
    if (!src) { toast('Load a track on a deck, then click an empty sampler slot to capture its loop (or drop a track on the slot)', 5000); return; }
    await this.captureLoop(src.index, i);
  }

  /** A deck's pad page was changed on screen: connected controllers follow (pads, LEDs). */
  onPadModeChange(i, mode) {
    for (const driver of this.midi?.controllers?.values() ?? []) driver.followMode?.(i, mode);
  }

  /** PAD FX (held): slot of PAD_FX on deck i's channel while pressed. */
  padFxPress(i, slot, press) {
    const unit = this.padFx[i];
    if (!press) { if (unit.held === slot) { unit.setOn(false); unit.held = null; this.deckViews[i]?.renderPads(); } return; }
    const [effect, beats, depth] = PAD_FX[slot] ?? PAD_FX[0];
    unit.setEffect(effect);
    unit.setBeats(beats);
    unit.setDepth(depth);
    unit.setOn(true);
    unit.held = slot;
    this.deckViews[i]?.renderPads();
  }

  /** Export a sampler slot as a WAV file chosen by the user. */
  async saveSample(i) {
    const s = this.sampler.slots[i];
    if (!s.buffer) return;
    const file = await window.rb.saveFileDialog(`${s.name || `sample ${i + 1}`}.wav`.replace(/[\\/:*?"<>|]/g, '_'), 'wav');
    if (!file) return;
    const chans = Array.from({ length: s.buffer.numberOfChannels }, (_, c) => s.buffer.getChannelData(c));
    await window.rb.writeFile(file, encodeWav(chans, s.buffer.sampleRate));
    toast(`Sample saved: ${file}`);
  }

  async editSample(i) { return editSample(this, i); }

  ejectSample(i) { this.sampler.clear(i); }

  // ---- deck menu: instant doubles, eject, capture -------------------------------------------

  deckMenu(e, i) {
    const d = this.engine.decks[i];
    const others = this.visibleDecks().filter((x) => x !== d && x.loaded);
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      ...others.map((o) => ({ label: `Instant Double from Deck ${o.index + 1}`, disabled: d.playing, action: () => this.instantDouble(o.index, i) })),
      ...(others.length ? ['-'] : []),
      { label: d.loop ? 'Capture loop to sampler' : `Capture ${fmtLoopBeats(d.beatLoopSize)} beats to sampler`, disabled: !d.loaded, action: () => this.captureLoop(i) },
      { label: 'Create cues from phrases', disabled: !d.loaded, action: () => this.createCuesFor(d.track.id) },
      { label: 'DRUM SWAP slots…', action: () => this.openDrumSwapEditor(i) },
      '-',
      { label: 'Set MIX IN at play head', disabled: !d.loaded, action: () => d.setMixPoint('mixin') },
      { label: 'Set MIX OUT at play head', disabled: !d.loaded, action: () => d.setMixPoint('mixout') },
      { label: 'Clear mix points', disabled: !d.mixPoint('mixin') && !d.mixPoint('mixout'), action: () => d.setCues(d.track.cues.filter((c) => c.kind !== 'mixin' && c.kind !== 'mixout')) },
      '-',
      { label: 'Eject', disabled: !d.loaded || d.playing, action: () => d.unload() },
    ]);
  }

  /** Load the same track on `to` at the same position, tempo and play state as `from`. */
  async instantDouble(fromIdx, toIdx) {
    const from = this.engine.decks[fromIdx];
    const to = this.engine.decks[toIdx];
    if (!from.track || (to.playing && !this.library.settings.loadOnPlaying)) return;
    await this.loadTrack(toIdx, from.track.id);
    to.setTempoRange(from.tempoRange);
    to.setTempoPct(from.tempoPct);
    if (to.keyLock !== from.keyLock) to.toggleKeyLock();
    to.seek(from.position());
    if (from.playing) to.play();
  }

  // ---- stems -----------------------------------------------------------------------------------

  installStems() {
    /** trackId -> {quality, state: 'queued'|'running', done, total, started} */
    this.stemJobs = new Map();
    const decksFor = (id) => this.engine.decks.filter((d) => d.track?.id === id);
    window.rb.stems.on('stems:job', (id, quality, phase) => {
      const job = this.stemJobs.get(id);
      if (job && phase === 'start') { job.state = 'running'; job.started = performance.now(); }
      this.onStemsChange();
    });
    // Progressive results: each finished block goes straight into the decks holding the track.
    window.rb.stems.on('stems:block', (id, quality, start, length, pcm, env, done, total) => {
      const job = this.stemJobs.get(id);
      if (job) Object.assign(job, { state: 'running', done, total });
      for (const d of decksFor(id)) {
        // An HQ pass over existing stems overwrites them block by block (no re-init, no gap).
        if (!d.stemFrames || (!d.stemsReady && !d.stemsComplete)) {
          if (!d.stemInitFor || d.stemInitFor !== `${id}|${quality}`) { d.initStems(total, 44100, quality); d.stemInitFor = `${id}|${quality}`; }
        }
        d.patchStems(start, pcm.map((a) => a.slice()), env, quality);
      }
      this.onStemsChange();
    });
    window.rb.stems.on('stems:fallback', (id, ep, quality) => {
      toast(`Stem separation on the GPU (${ENGINE_NAMES[ep] ?? ep}) failed — retrying on the CPU`, 6000);
      // Auto never picks this engine again for this model on this computer.
      const bench = { ...(this.library.settings.stemsBench ?? {}) };
      if (quality) { bench[quality] = { ...(bench[quality] ?? {}), [ep]: 'crash' }; this.library.setSetting('stemsBench', bench); }
    });
  }

  /** Refresh every stems indicator (decks, global bar, browser column). */
  onStemsChange() {
    this.engine.decks.forEach((d) => d.emit('stems'));
    this.refreshStemStatus();
    if (this.browser.lib.settings.columns.includes('stems')) this.browser.renderBody();
  }

  async loadStemsInto(deck, meta) {
    const trackId = deck.track?.id;
    const pcm = await Promise.all(meta.stems.map((name) => readStem(meta, name)));
    if (deck.track?.id !== trackId) return; // another track was loaded meanwhile
    deck.stemMeta = meta;
    const env = meta.env?.data?.map((b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; });
    deck.stemEnvPps = meta.env?.pps ?? 150;
    deck.setStems(pcm, meta.rate, meta.vocals ?? [], { quality: meta.quality ?? 'hq', env });
  }

  /** Engine for a stem model: the one chosen in Preferences ▸ Stems, or with Auto the fastest measured here. */
  stemEngine(quality) {
    const s = this.library.settings;
    return pickEngine(s.stemsProvider ?? 'auto', s.stemsBench?.[quality]);
  }

  /**
   * Time every engine on the installed models (Preferences ▸ Stems ▸ Test). Results are kept and
   * used by Auto. onResult(quality, ep, result) after each measurement.
   */
  async benchStemEngines(onResult, { seconds } = {}) {
    const status = await window.rb.stems.status();
    const bench = { ...(this.library.settings.stemsBench ?? {}) };
    for (const q of ['fast', 'hq']) {
      if (!status.models[q]) continue;
      bench[q] = {};
      for (const ep of STEM_ENGINES) {
        const r = await window.rb.stems.bench(q, ep, seconds);
        bench[q][ep] = r.crashed ? 'crash' : r.speed ?? 'error';
        onResult?.(q, ep, bench[q][ep]);
      }
    }
    bench.date = new Date().toISOString();
    this.library.setSetting('stemsBench', bench);
    return bench;
  }

  /** Make sure a stem model is installed; FAST (79 MB) downloads on demand. */
  async ensureStemModel(quality) {
    const status = await window.rb.stems.status();
    if (status.models[quality]) return true;
    if (quality === 'hq') { toast('The HQ stem model is not installed (Preferences > Stems)', 6000); return false; }
    const t = toast('Downloading the FAST stem model (79 MB)…', 600000);
    const off = window.rb.stems.on('stems:download', (_q, got, total) => { t.textContent = `Downloading the FAST stem model… ${Math.round((got / total) * 100)}%`; });
    try { await window.rb.stems.download('fast'); return true; } catch (err) { toast(`Download failed: ${err.message}`, 6000); return false; } finally { off(); t.remove(); }
  }

  /**
   * Separate a track into 4 stems (cached). Results stream into the decks from the play head.
   * quality: 'fast' | 'hq'; settings 'auto' = FAST now, HQ upgrade in the background.
   */
  async separateStems(trackId, { quality, urgent = true, deck: from = null } = {}) {
    const t = this.library.get(trackId);
    const mode = this.library.settings.stemsQuality ?? 'auto';
    const q = quality ?? (mode === 'hq' ? 'hq' : 'fast');
    const existing = this.stemJobs.get(trackId);
    if (!t || (existing && existing.quality === q)) return null;
    if (!(await this.ensureStemModel(q))) return null;
    this.stemJobs.set(trackId, { quality: q, state: 'queued', done: 0, total: 1 });
    this.onStemsChange();
    try {
      const decoded = await this.analyzer.decode(t.path);
      const len = Math.ceil(decoded.duration * 44100);
      const off = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: 44100 });
      const src = off.createBufferSource();
      src.buffer = decoded; src.connect(off.destination); src.start();
      const r44 = await off.startRendering();
      // Start where the music is: the play head of a deck holding this track.
      const holders = this.engine.decks.filter((d) => d.track?.id === trackId);
      const deck = from?.track?.id === trackId ? from : holders.find((d) => d.playing) ?? holders[0];
      const startSample = deck ? Math.floor(deck.position() * 44100) : 0;
      const meta = await window.rb.stems.separate(trackId, r44.getChannelData(0), r44.getChannelData(1),
        { quality: q, ep: this.stemEngine(q), startSample, urgent, trackPath: t.path, ...stemsFormat(this.library.settings) });
      const stored = (await window.rb.getAnalysis(trackId)) ?? {};
      await window.rb.putAnalysis(trackId, { ...stored, vocals: meta.vocals });
      this.library.update(trackId, { stems: q === 'hq' || t.stems === 'hq' ? 'hq' : 'fast' });
      for (const d of this.engine.decks) {
        if (d.track?.id !== trackId) continue;
        d.stemInitFor = null;
        // A deck that got the track mid-way missed early blocks: take the complete result from the cache.
        if (d.stemCoverage() < 0.999) { await this.loadStemsInto(d, meta); continue; }
        d.stemMeta = meta;
        d.stemsComplete = true;
        d.stemQuality = q;
        d.vocals = meta.vocals ?? d.vocals;
      }
      this.browser.setStatus(`Stems ready (${q.toUpperCase()}): ${t.title}`);
      // AUTO: FAST first for immediate use, then upgrade to HQ quietly if the model is there.
      if (q === 'fast' && mode === 'auto' && (await window.rb.stems.status()).models.hq) {
        this.stemJobs.delete(trackId);
        this.separateStems(trackId, { quality: 'hq', urgent: false });
      }
      return meta;
    } catch (err) {
      toast(`Stem separation failed: ${err.message}`, 6000);
      return null;
    } finally {
      if (this.stemJobs.get(trackId)?.quality === q) this.stemJobs.delete(trackId);
      this.onStemsChange();
    }
  }

  /** DOWNLOAD button badge: running downloads (with progress), else new releases to look at. */
  /** Licence status: beta / trial pill (days left), thank-you note when the beta ends, activation dialog when it is over. */
  applyLicense(st) {
    this.license = st;
    this.trialPill.hidden = st.mode !== 'trial' && st.mode !== 'beta';
    if (!this.trialPill.hidden) this.trialPill.textContent = `${st.mode === 'beta' ? 'Beta' : 'Trial'} · ${st.daysLeft} day${st.daysLeft > 1 ? 's' : ''}`;
    this.trialPill.title = st.mode === 'beta' ? 'Open beta: free until its end date (Preferences > About)' : 'Free trial: activate a licence in Preferences > About';
    if (st.mode === 'expired') openLicenseGate(this, st);
  }

  refreshUpdatePill() {
    const info = this.updateInfo;
    this.updatePill.hidden = !info?.newer;
    if (info?.newer) this.updatePill.textContent = `⬆ Update ${info.latest}`;
  }

  refreshDownloadStatus() {
    if (!this.dlBadge) return;
    const dl = this.downloads;
    const active = [...dl.jobs.values()].filter((j) => ['queued', 'starting', 'downloading', 'converting'].includes(j.state));
    if (active.length) {
      const pct = Math.round(active.reduce((a, j) => a + (j.pct ?? 0), 0) / active.length);
      this.dlBadge.textContent = `${active.length} · ${pct}%`;
      this.dlBadge.className = 'dl-badge busy';
    } else if (dl.newCount) {
      this.dlBadge.textContent = `${dl.newCount} new`;
      this.dlBadge.className = 'dl-badge new';
    }
    this.dlBadge.hidden = !active.length && !dl.newCount;
  }

  /** Global-bar indicator: running job progress and queue length. */
  refreshStemStatus() {
    if (!this.stemStatus) return;
    const jobs = [...this.stemJobs.entries()];
    const running = jobs.find(([, j]) => j.state === 'running');
    this.stemStatus.hidden = jobs.length === 0;
    if (!jobs.length) return;
    const [id, j] = running ?? jobs[0];
    const pct = j.total > 1 ? Math.round((j.done / j.total) * 100) : 0;
    const eta = j.started && j.done > 0 ? ((performance.now() - j.started) / j.done) * (j.total - j.done) / 1000 : null;
    this.stemStatus.querySelector('.ss-text').textContent =
      `${j.quality.toUpperCase()} ${running ? `${pct}%` : 'queued'} · ${this.library.get(id)?.title ?? ''}${eta && eta > 1 ? ` · ${Math.ceil(eta)} s` : ''}${jobs.length > 1 ? ` · +${jobs.length - 1}` : ''}`;
    this.stemStatus.style.setProperty('--p', `${pct}%`);
  }

  /**
   * Groove Circuit / parts work on stems. When a deck has none yet, start separating them (FAST,
   * from the play head, like rekordbox's real-time separation): usable after a couple of seconds.
   * @returns {boolean} stems ready now
   */
  ensureStems(d) {
    if (d?.stemsReady) return true;
    if (d?.track && !this.stemJobs?.has(d.track.id)) {
      this.separateStems(d.track.id, { deck: d });
      toast(`Deck ${d.index + 1}: separating stems…`, 2500);
    }
    return false;
  }

  /** DRUM CAPTURE loops survive restarts: WAV files in userData/groove, indexed in the settings. */
  installGroovePersistence() {
    this.groove.forEach((g, i) => g.addEventListener('capture', async (e) => {
      const { bank, slot } = e.detail;
      const s = g.slots[bank][slot];
      try {
        const { userData } = await window.rb.paths();
        const file = `${userData}/groove/deck${i + 1}-${'AB'[bank]}${slot + 1}.wav`;
        await window.rb.writeFile(file, encodeWav([s.buffer.getChannelData(0), s.buffer.getChannelData(1)], s.buffer.sampleRate));
        const saved = { ...(this.library.settings.grooveCaptures ?? {}) };
        saved[`${i}:${bank}:${slot}`] = { file, bpm: s.bpm, bars: s.bars, name: s.name, gain: s.gain };
        this.library.setSetting('grooveCaptures', saved);
        // The capture replaces what the editor had put in this slot (built-in loop, file, empty).
        const slots = { ...(this.library.settings.grooveSlots ?? {}) };
        delete slots[`${i}:${bank}:${slot}`];
        this.library.setSetting('grooveSlots', slots);
      } catch (err) { console.warn('drum capture not saved', err); }
    }));
    const loadFile = (i, bank, slot, m) => fetch(mediaUrl(m.file))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => buf && this.engine.ctx.decodeAudioData(buf))
      .then((buffer) => { if (buffer) this.groove[i]?.store(bank, slot, { buffer, bpm: m.bpm, bars: m.bars, name: m.name, gain: m.gain, file: m.file }); })
      .catch(() => { /* file moved or deleted: the built-in loop stays */ });
    for (const [k, m] of Object.entries(this.library.settings.grooveCaptures ?? {})) {
      const [i, bank, slot] = k.split(':').map(Number);
      loadFile(i, bank, slot, m);
    }
    // Slots changed in the DRUM SWAP editor: another built-in loop, an audio file, or empty.
    for (const [k, m] of Object.entries(this.library.settings.grooveSlots ?? {})) {
      const [i, bank, slot] = k.split(':').map(Number);
      const g = this.groove[i];
      if (!g) continue;
      if (m.empty) g.eject(bank, slot);
      else if (m.builtin !== undefined) { g.setBuiltin(bank, slot, m.builtin); if (m.gain !== undefined) g.setSlotGain(bank, slot, m.gain); }
      else if (m.file) loadFile(i, bank, slot, m);
    }
  }

  /** DRUM CAPTURE: store bars of the deck's drum stem into a DRUM SWAP slot (default: the next free one). */
  async drumCapture(i, slot) {
    const d = this.engine.decks[i];
    if (!d.stemMeta) { toast('Separate stems first (they are needed to capture the drums)'); this.ensureStems(d); return -1; }
    const got = this.groove[i].capture(await readStem(d.stemMeta, 'drums'), d.stemMeta.rate, slot);
    toast(got >= 0 ? `Drums captured to ${'AB'[this.groove[i].bank]}${got + 1} (${this.groove[i].captureBars * 4} beats)` : 'Nothing to capture here');
    return got;
  }

  /** DRUM SWAP slot editor of deck i. */
  openDrumSwapEditor(i) { return openDrumSwapEditor(this, i); }

  /** Remember what a DRUM SWAP slot holds (built-in loop, file, capture, empty) across restarts. */
  saveGrooveSlot(i, bank, slot) {
    const key = `${i}:${bank}:${slot}`;
    const s = this.groove[i].slots[bank][slot];
    const slots = { ...(this.library.settings.grooveSlots ?? {}) };
    const captures = { ...(this.library.settings.grooveCaptures ?? {}) };
    if (s === null) { slots[key] = { empty: true }; delete captures[key]; }
    else if (s.builtin !== undefined) { slots[key] = { builtin: s.builtin, gain: s.gain }; delete captures[key]; }
    else if (s.file) { slots[key] = { file: s.file, bpm: s.bpm, bars: s.bars, name: s.name, gain: s.gain }; delete captures[key]; }
    else { delete slots[key]; if (captures[key]) captures[key] = { ...captures[key], gain: s.gain }; } // a capture (its WAV is saved on capture)
    this.library.setSetting('grooveSlots', slots);
    this.library.setSetting('grooveCaptures', captures);
  }

  /** A controller was (dis)connected: select its sound card if its plugin declares one ("audio"). */
  async onControllerChange(driver) {
    const audio = driver?.plugin?.audio;
    if (!audio?.device) return;
    const s = this.library.settings;
    if (s.controllerAudioAuto === false) return;
    const name = driver.plugin.name ?? driver.device;
    const devices = await this.engine.outputDevices().catch(() => []);
    const dev = devices.find((x) => x.label.toLowerCase().includes(audio.device.toLowerCase()));
    if (!dev) { toast(`${name}: its sound card was not found — choose the output in Preferences > Audio output`, 6000); return; }
    const layout = audio.layout === 'quad' ? 'quad' : 'stereo';
    try {
      await this.engine.setMasterDevice(dev.deviceId);
      this.engine.setOutputLayout(layout);
      this.library.setSetting('masterDevice', dev.deviceId);
      this.library.setSetting('outputLayout', layout);
      toast(`${layout === 'quad' ? `${name} audio: master on outputs 1/2, headphones on 3/4` : `${name} audio: master output`}${s.masterCopyDevice ? '' : ' · to hear it on the computer too: Preferences > Audio'}`, 6000);
    } catch (err) {
      toast(`${name} audio: ${err.message}`, 6000);
    }
  }

  // ---- Mix Point Link --------------------------------------------------------------------------

  /** When a playing deck crosses its MIX OUT, start a paused deck from its MIX IN, synced. */
  mixPointTick() {
    const decks = this.visibleDecks();
    decks.forEach((d, i) => {
      const pos = d.position();
      const prev = this.lastPos[i] ?? pos;
      this.lastPos[i] = pos;
      if (!this.library.settings.mixPointLink || this.automix.active || !d.playing) return;
      const out = d.mixPoint('mixout');
      if (!out || !(prev < out.start && pos >= out.start)) return;
      // Prefer the partner deck (1<->2, 3<->4), then any other ready deck.
      const ready = (o) => o && o !== d && o.loaded && !o.playing && o.mixPoint('mixin');
      const partner = decks[i ^ 1];
      const target = ready(partner) ? partner : decks.find(ready);
      if (!target) return;
      this.engine.setMasterDeck(d.index);
      target.seek(target.mixPoint('mixin').start);
      if (!target.sync) target.toggleSync();
      target.play();
      toast(`Mix Point Link: Deck ${target.index + 1} started from MIX IN`);
    });
  }

  // ---- automix ---------------------------------------------------------------------------------

  automixMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const a = this.automix;
    const save = (patch) => {
      a.settings = { ...a.settings, ...patch };
      this.library.setSetting('automix', a.settings);
    };
    contextMenu(r.left, r.bottom + 2, [
      a.active
        ? { label: 'Stop Automix', action: () => a.stop() }
        : { label: 'Start Automix with the current list', action: () => {
          const rows = this.browser.rows;
          if (!rows.length) { toast('The current list is empty'); return; }
          const from = Math.max(0, this.browser.anchor ?? 0);
          a.start(rows.map((x) => x.track.id), from);
        } },
      '-',
      { label: 'Crossfade length', submenu: [4, 8, 16, 32].map((b) => ({ label: `${b} beats`, checked: a.settings.mixBeats === b, action: () => save({ mixBeats: b }) })) },
      { label: 'Repeat', checked: a.settings.repeat, action: () => save({ repeat: !a.settings.repeat }) },
      { label: 'Shuffle', checked: a.settings.shuffle, action: () => save({ shuffle: !a.settings.shuffle }) },
    ]);
  }

  refreshAutomix() {
    const a = this.automix;
    this.automixBtn.classList.toggle('on', a.active);
    this.automixStatus.textContent = a.active ? `${a.mixing ? 'mixing → ' : ''}${a.index + 1}/${a.queue.length}` : '';
  }

  // ---- beatgrid editing ------------------------------------------------------------------------

  gridMenu(e, deckIndex) {
    const d = this.engine.decks[deckIndex];
    if (!d.loaded || !d.grid) { toast('Load an analyzed track first'); return; }
    const g = d.grid;
    const locked = !!d.track.gridLocked;
    const set = (grid) => {
      if (locked) { toast('Beatgrid is locked'); return; }
      this.setTrackGrid(d, grid);
    };
    const reanalyze = async (mode) => {
      const t = this.library.update(d.track.id, { beatgrid: locked ? d.track.beatgrid : null });
      this.modeOverride.set(t.id, mode);
      await window.rb.putAnalysis(t.id, null);
      this.analyzeTracks([t.id]);
      toast(`Re-analyzing (${mode === 'dynamic' ? 'dynamic' : 'normal'} grid)…`);
    };
    const beat = d.period;
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: `${toBeatgrid(g).dynamic ? 'Dynamic' : 'Constant'} grid · ${g.bpm.toFixed(2)} BPM${locked ? ' · locked' : ''}`, disabled: true },
      '-',
      { label: 'Set downbeat (bar start) at play head', disabled: locked, action: () => set(setDownbeatAt(g, d.position())) },
      { label: 'Shift grid ← 10 ms', disabled: locked, action: () => set(shiftGrid(g, -0.01)) },
      { label: 'Shift grid → 10 ms', disabled: locked, action: () => set(shiftGrid(g, 0.01)) },
      { label: 'Shift grid ← 1 beat', disabled: locked, action: () => set(shiftGrid(g, -beat)) },
      { label: 'Shift grid → 1 beat', disabled: locked, action: () => set(shiftGrid(g, beat)) },
      { label: 'BPM × 2', disabled: locked, action: () => set(doubleGrid(g)) },
      { label: 'BPM ÷ 2', disabled: locked, action: () => set(halveGrid(g)) },
      { label: 'BPM − 0.01', disabled: locked || !!g.beats, action: () => set({ ...g, bpm: Math.round((g.bpm - 0.01) * 100) / 100 }) },
      { label: 'BPM + 0.01', disabled: locked || !!g.beats, action: () => set({ ...g, bpm: Math.round((g.bpm + 0.01) * 100) / 100 }) },
      { label: 'Tap tempo…', disabled: locked, action: () => this.tapTempo(d) },
      { label: 'Convert to constant grid', disabled: locked || !g.beats, action: () => set(constantGridAt(g.bpm, d.bg.snap(d.position()), d.bg.barPos(Math.round(d.bg.indexAt(d.position()))) + 1)) },
      '-',
      { label: locked ? 'Unlock beatgrid' : 'Lock beatgrid', action: () => { this.library.update(d.track.id, { gridLocked: !locked }); toast(locked ? 'Beatgrid unlocked' : 'Beatgrid locked'); } },
      { label: 'Re-analyze (normal grid)', action: () => reanalyze('normal') },
      { label: 'Re-analyze (dynamic grid)', action: () => reanalyze('dynamic') },
    ]);
  }

  setTrackGrid(deck, grid) {
    const t = this.library.update(deck.track.id, { beatgrid: grid, bpm: Math.round(grid.bpm * 100) / 100 });
    deck.updateTrack(t, this.deckAnalysis(t, deck.analysis));
    deck.emit('tempo');
  }

  async tapTempo(deck) {
    const taps = [];
    const readout = h('div.tap-readout', {}, '---.-- BPM');
    const tapBtn = h('button.tap-btn', {}, 'TAP');
    const tap = () => {
      const now = performance.now();
      if (taps.length && now - taps.at(-1) > 2000) taps.length = 0; // pause = restart
      taps.push(now);
      const bpm = tapBpm(taps);
      readout.textContent = bpm ? `${bpm.toFixed(2)} BPM (${taps.length} taps)` : 'keep tapping…';
    };
    tapBtn.addEventListener('pointerdown', tap);
    const body = h('div.tap', {}, h('p.dim', {}, 'Tap on the beat (button or T key). The beat nearest the play head stays where it is.'), tapBtn, readout);
    body.tabIndex = 0;
    body.addEventListener('keydown', (e) => { if (e.code === 'KeyT') tap(); });
    setTimeout(() => body.focus());
    const ok = await modal('Tap tempo', body, [{ label: 'Apply', primary: true, value: true }, { label: 'Cancel', value: null }]);
    const bpm = tapBpm(taps);
    if (!ok || !bpm) return;
    const anchor = deck.bg ? deck.bg.snap(deck.position()) : deck.position();
    const barBeat = deck.bg ? deck.bg.barPos(Math.round(deck.bg.indexAt(anchor))) + 1 : 1;
    this.setTrackGrid(deck, constantGridAt(bpm, anchor, barBeat));
  }

  attachScrub(canvas, deck) {
    canvas.addEventListener('pointerdown', (e) => {
      if (!deck.loaded || e.button !== 0) return; // right button: the phrase menu
      canvas.setPointerCapture(e.pointerId);
      const wasPlaying = deck.playing;
      if (wasPlaying) deck.pause();
      const start = deck.position();
      const x0 = e.clientX;
      const move = (ev) => deck.seek(start - ((ev.clientX - x0) / canvas.clientWidth) * this.zoom);
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        if (wasPlaying) deck.play();
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(1, Math.min(32, this.zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
    // Right-click: edit the phrase under the mouse (its type, cut it, join it with the next).
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const phrases = deck.analysis?.phrases?.phrases;
      if (!deck.loaded || !phrases?.length) { toast('No phrases on this track yet (analyse it first)'); return; }
      const r = canvas.getBoundingClientRect();
      const t = deck.position() + ((e.clientX - r.left) / r.width - 0.5) * this.zoom * (deck.rate || 1);
      const i = phraseAt(phrases, t);
      if (i < 0) return;
      const p = phrases[i];
      const save = (next) => this.setPhrases(deck, next);
      contextMenu(e.clientX, e.clientY, [
        { label: `${p.label}${p.num > 1 ? ` ${p.num}` : ''} · ${p.bars} bars`, disabled: true },
        { label: 'Change to', submenu: PHRASE_LABELS.map((l) => ({ label: l, checked: l === p.label, action: () => save(relabelPhrase(phrases, i, l)) })) },
        { label: 'Cut the phrase here (at the nearest bar)', disabled: !(p.bars > 1), action: () => save(splitPhrase(phrases, i, t)) },
        { label: 'Join with the next phrase', disabled: i >= phrases.length - 1, action: () => save(mergePhrase(phrases, i)) },
        '-',
        { label: 'Back to the analysed phrases', disabled: !deck.analysis.phrases.edited, action: () => this.resetPhrases(deck) },
      ]);
    });
  }

  /** Save phrases corrected by hand (kept in the track's analysis; analysis again keeps them). */
  async setPhrases(deck, phrases) {
    const id = deck.track.id;
    const stored = (await window.rb.getAnalysis(id)) ?? {};
    const original = stored.phrases?.original ?? stored.phrases?.phrases ?? deck.analysis?.phrases?.phrases ?? [];
    const next = { ...(stored.phrases ?? deck.analysis?.phrases ?? {}), phrases, edited: true, original };
    await window.rb.putAnalysis(id, { ...stored, phrases: next });
    deck.analysis = { ...deck.analysis, phrases: next };
    deck.emit('analysis');
  }

  async resetPhrases(deck) {
    const id = deck.track.id;
    const stored = (await window.rb.getAnalysis(id)) ?? {};
    const original = stored.phrases?.original;
    if (!original) return;
    const next = { ...stored.phrases, phrases: original };
    delete next.edited; delete next.original;
    await window.rb.putAnalysis(id, { ...stored, phrases: next });
    deck.analysis = { ...deck.analysis, phrases: next };
    deck.emit('analysis');
  }

  // ---- recording -------------------------------------------------------------------------------

  async toggleRecording() {
    if (!this.engine.recording) {
      this.engine.resume();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      await this.engine.startRecording(`Reboxed-mix-${stamp}`);
      this.recBtn.classList.add('on');
      return null;
    }
    const r = await this.engine.stopRecording();
    this.recBtn.classList.remove('on');
    this.recTime.textContent = '';
    if (!r) return null;
    // Like Rekordbox, recordings land in the collection (and a "Recordings" playlist).
    const [id] = this.library.addScanned([await window.rb.readTags(r.path)]);
    if (id) {
      let node = this.library.playlistList().find((p) => p.label === 'Recordings');
      if (!node) node = this.library.createNode('playlist', 'Recordings');
      this.library.addToPlaylist(node.id, [id]);
    }
    toast(`Recording saved: ${r.path}`, 6000);
    return r;
  }

  // ---- render loop -----------------------------------------------------------------------------

  frame() {
    this.frames = (this.frames ?? 0) + 1;
    // Optional timing of each part of a frame (smoke test / diagnostics): this.perf = {}.
    const perf = this.perf;
    let mark = perf ? performance.now() : 0;
    const lap = (name) => { if (!perf) return; const t = performance.now(); perf[name] = (perf[name] ?? 0) + t - mark; mark = t; };
    if (perf) perf.frames = (perf.frames ?? 0) + 1;
    this.engine.tick();
    this.automix.tick();
    this.mixPointTick();
    this.groove.forEach((g) => g.tick());
    if (!this.lastClock || performance.now() - this.lastClock > 1000) {
      this.lastClock = performance.now();
      const now = new Date();
      this.clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const names = [...(this.midi?.controllers?.values() ?? [])].map((c) => c.device);
      this.midiStatus.lastChild.textContent = names.length ? names.join(', ') : 'No controller';
      this.midiStatus.classList.toggle('on', names.length > 0);
    }
    lap('ticks');
    // Controller LEDs at 30 Hz: plenty for lights, and they cost as much as a waveform otherwise.
    const ledNow = performance.now();
    if (this.midi?.controllers && !(ledNow - (this.lastLeds ?? 0) < 33)) { this.lastLeds = ledNow; for (const c of this.midi.controllers.values()) c.updateLeds(); }
    lap('leds');
    if (!this.samplerView.el.hidden) this.samplerView.frame();
    const style = this.library.settings.waveformColor;
    if (!document.body.classList.contains('browse-full')) {
      const stemMode = this.library.settings.stemWaveform;
      // The zoom is real (listening) time, like rekordbox: a faster deck shows more of its track,
      // so decks at the same BPM show beat grids of the same size, lined up when synced.
      this.visibleDecks().forEach((d, i) => drawDetail(this.waveCanvases[i], d, { style, spanSec: this.zoom * (d.rate || 1), color: DECK_COLORS[i], stemMode }));
      lap('waveforms');
      this.deckViews.slice(0, this.deckCount).forEach((v) => v.frame(style));
      lap('decks');
      this.mixer.frame();
      lap('mixer');
    }
    if (this.engine.recording) this.recTime.textContent = fmtTime((performance.now() - this.engine.recordStarted) / 1000);
    requestAnimationFrame(() => this.frame());
  }
}

// ---- smoke test (npm run smoke): exercises analysis, decks and the mixer without UI input ----

function syntheticTrack(ctx, bpm = 124, seconds = 20) {
  const buf = ctx.createBuffer(2, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
  const sr = ctx.sampleRate;
  const period = 60 / bpm;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let t = 0.25; t < seconds; t += period) {
      const s = Math.round(t * sr);
      for (let j = 0; j < sr * 0.15 && s + j < d.length; j++) d[s + j] += 0.8 * Math.exp(-j / (sr * 0.03)) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (sr * 0.01))) * (j / sr));
    }
    for (let i = 0; i < d.length; i++) d[i] += 0.1 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.06 * Math.sin((2 * Math.PI * 261.63 * i) / sr) + 0.06 * Math.sin((2 * Math.PI * 329.63 * i) / sr);
  }
  return buf;
}

/** Frames per second over 2 s, and the average ms of each part of a frame: [ok, info] for step(). */
async function measureFrames(app) {
  app.perf = {};
  const [t0, f0] = [performance.now(), app.frames];
  await new Promise((r) => setTimeout(r, 2000));
  const fps = (app.frames - f0) / ((performance.now() - t0) / 1000);
  const { frames = 1, ...parts } = app.perf;
  app.perf = null;
  const ms = Object.entries(parts).map(([k, v]) => `${k} ${(v / frames).toFixed(2)}`).join(', ');
  return [fps > 40, `${fps.toFixed(1)} fps · ms per frame: ${ms}`];
}

async function smoke(app) {
  const report = { ok: false, steps: [] };
  const step = (name, ok, info = '') => { report.steps.push({ name, ok, info }); if (!ok) throw new Error(`${name}: ${info}`); };
  try {
    const ctx = app.engine.ctx;
    await ctx.resume();
    step('audio context', ctx.state === 'running', ctx.state);

    // Real file path: write WAVs, import (tags via main), analyze through media://, load on a deck.
    const dir = await window.rb.smokeDir();
    const files = [[128, 'Kick 128'], [140, 'Kick 140'], [100, 'Kick 100']];
    for (const [bpm, name] of files) {
      const b = syntheticTrack(ctx, bpm, 24);
      await window.rb.writeFile(`${dir}\\${name}.wav`, encodeWav([0, 1].map((c) => b.getChannelData(c).map((x) => x * 0.7)), b.sampleRate));
    }
    await app.importPaths([dir]);
    step('import', app.library.tracks.size === 3, `${app.library.tracks.size} tracks`);
    while (app.analyzing || app.queue.length) await new Promise((r) => setTimeout(r, 100));
    const bpms = app.library.all().map((t) => `${t.title}=${t.bpm}`).sort();
    step('library analysis', app.library.all().every((t) => t.analyzed && files.some(([b, n]) => n === t.title && Math.abs(t.bpm - b) < 0.1)), bpms.join(' '));
    const pl = app.library.createNode('playlist', 'Smoke set');
    app.library.addToPlaylist(pl.id, app.library.all().map((t) => t.id));
    app.browser.select(pl.id);
    app.browser.controller.textChanged('140'); app.browser.controller.submit();
    step('search', app.browser.rows.length === 1 && app.browser.rows[0].track.title === 'Kick 140', `${app.browser.rows.length} rows`);
    app.browser.controller.clear();
    const id128 = app.library.all().find((t) => t.title === 'Kick 128').id;
    await app.loadTrack(0, id128);
    step('load from file', app.engine.decks[0].track?.id === id128 && app.engine.decks[0].duration > 23, String(app.engine.decks[0].duration));
    app.engine.decks[0].unload();
    const buf = syntheticTrack(ctx);
    const analysis = await app.analyzer.analyzeBuffer(buf);
    step('analysis bpm', Math.abs(analysis.beatgrid.bpm - 124) < 0.05, String(analysis.beatgrid.bpm));
    // A-C-E drone: A minor (8A) or its relative C major (8B) are both musically correct.
    step('analysis key', ['8A', '8B'].includes(analysis.key), analysis.key);
    step('analysis waveform', analysis.waveform.low.length > 100, `${analysis.waveform.low.length} b64 chars`);
    const [d1, d2] = app.engine.decks;
    const track = { id: 'smoke', title: 'Smoke', artist: 'Test', cues: [], bpm: 124 };
    d1.setLoaded(track, buf, analysis);
    d2.setLoaded({ ...track, id: 'smoke2' }, syntheticTrack(ctx, 120), await app.analyzer.analyzeBuffer(syntheticTrack(ctx, 120)));
    d1.play();
    await new Promise((r) => setTimeout(r, 600));
    const p = d1.position();
    step('deck plays', p > 0.3 && d1.playing, p.toFixed(3));
    d2.toggleSync();
    step('sync tempo', Math.abs(d2.currentBpm - 124) < 0.01, d2.currentBpm.toFixed(2));
    d2.play();
    await new Promise((r) => setTimeout(r, 1500));
    let ph = d1.phase() - d2.phase(); if (ph > 0.5) ph -= 1; if (ph < -0.5) ph += 1;
    step('sync phase', Math.abs(ph * d2.period) < 0.02, `${(ph * d2.period * 1000).toFixed(1)} ms`);
    // The tempo fader really changes the speed: +8 % on the master = the play head runs 1.08x.
    {
      d1.userTempo(8);
      await new Promise((r) => setTimeout(r, 200));
      const [p0, t0] = [d1.position(), ctx.currentTime];
      await new Promise((r) => setTimeout(r, 1200));
      const speed = (d1.position() - p0) / (ctx.currentTime - t0);
      step('tempo fader changes the speed', Math.abs(speed - 1.08) < 0.01 && Math.abs(d1.currentBpm - 124 * 1.08) < 0.05, `speed x${speed.toFixed(4)}, ${d1.currentBpm.toFixed(2)} BPM`);
      // On a synced deck the fader moves the shared tempo (master and synced decks follow).
      d2.userTempo((130 / 120 - 1) * 100);
      step('synced deck fader moves the shared tempo', d2.sync && Math.abs(d1.currentBpm - 130) < 0.05 && Math.abs(d2.currentBpm - 130) < 0.05,
        `master ${d1.currentBpm.toFixed(2)} BPM, deck 2 ${d2.currentBpm.toFixed(2)} BPM, sync ${d2.sync}`);
      d1.setTempoPct(0);
    }
    // Quantize: AUTO BEAT LOOP starts on the closest beat line, ahead of the play head too.
    {
      const bg = d1.bg;
      const k = Math.ceil(bg.indexAt(d1.position())) + 2;
      d1.pause();
      d1.seek(bg.timeOf(k + 0.8)); d1.beatLoop(4);
      const ahead = d1.loop.start - bg.timeOf(k + 1);
      d1.exitLoop();
      d1.seek(bg.timeOf(k + 0.2)); d1.beatLoop(4);
      const behind = d1.loop.start - bg.timeOf(k);
      const len = (d1.loop.end - d1.loop.start) / d1.period;
      d1.exitLoop();
      d1.play();
      step('quantized loop on the closest beat', Math.abs(ahead) < 1e-6 && Math.abs(behind) < 1e-6 && Math.abs(len - 4) < 1e-6,
        `0.8 beat past → starts ${ahead.toExponential(1)} s from the next beat, 0.2 past → ${behind.toExponential(1)} s from the last one, ${len.toFixed(3)} beats`);
    }
    // KEY SYNC: deck 2 (made 10A here) shifts to deck 1's key (or its relative); a manual shift turns it off.
    {
      const realKey = d2.analysis.key;
      d2.analysis = { ...d2.analysis, key: '10A' };
      d2.toggleKeySync();
      const synced = transposeKey('10A', d2.keyShift);
      const ok = d2.keySync && synced.slice(0, -1) === d1.key.slice(0, -1) && Math.abs(d2.keyShift) <= 6;
      d2.setKeyShift(d2.keyShift + 1);
      step('key sync', ok && !d2.keySync, `deck 1 ${d1.key}, deck 2 10A shifted ${d2.keyShift - 1} → ${synced}; manual shift turns KEY SYNC off: ${!d2.keySync}`);
      d2.setKeyShift(0);
      d2.analysis = { ...d2.analysis, key: realKey };
    }
    step('frame rate (2 decks playing)', ...(await measureFrames(app)));
    d1.beatLoop(1);
    await new Promise((r) => setTimeout(r, 1200));
    const lp = d1.position();
    step('beat loop holds', d1.loop && lp >= d1.loop.start - 0.02 && lp <= d1.loop.end + 0.02, `${lp.toFixed(3)} in [${d1.loop.start.toFixed(3)}, ${d1.loop.end.toFixed(3)}]`);
    // The size arrows resize the loop that is playing (and the next one), from the loop start.
    {
      const view = app.deckViews[0].el;
      const startBefore = d1.loop.start;
      view.querySelector('.row.loops button[title^="Bigger"]').click();
      view.querySelector('.row.loops button[title^="Bigger"]').click();
      const big = { ...d1.loop };
      view.querySelector('.row.loops button[title^="Smaller"]').click();
      const len = (d1.loop.end - d1.loop.start) / d1.period;
      step('loop size arrows resize the current loop', big.beats === 4 && d1.loop.beats === 2 && Math.abs(len - 2) < 0.01 && d1.loop.start === startBefore && d1.beatLoopSize === 2
        && view.querySelector('.loop-size .val').textContent.trim() !== '', `1 → ${big.beats} → ${d1.loop.beats} beats (${len.toFixed(2)}), next size ${d1.beatLoopSize}`);
    }
    d1.exitLoop();
    d1.toggleKeyLock(); d1.setTempoPct(6);
    await new Promise((r) => setTimeout(r, 300));
    step('master tempo running', d1.playing, '');
    d1.hotCuePress(0);
    step('hot cue set', !!d1.hotCue(0), '');
    const lv = app.engine.levels();
    step('master level', lv.master > 0.01, lv.master.toFixed(3));
    app.engine.fx.setEffect('ECHO'); app.engine.fx.setOn(true);
    await new Promise((r) => setTimeout(r, 300));
    app.engine.fx.setOn(false);
    step('beat fx', true, '');
    // Leave something on screen for the --shot screenshot: deck 1 playing, loop on deck 2.
    d2.pause();
    d2.beatLoop(4);
    await new Promise((r) => setTimeout(r, 400));
    d1.pause();
    // ---- phase 2 ----
    const lib = app.library;
    const smartNode = lib.createNode('smart', 'Fast', null, { match: 'all', conditions: [{ field: 'bpm', op: 'gte', value: 130 }] });
    app.browser.select(smartNode.id);
    step('intelligent playlist', app.browser.rows.length === 1 && app.browser.rows[0].track.title === 'Kick 140', `${app.browser.rows.length} rows`);
    lib.addToTagList(lib.all().map((t) => t.id).slice(0, 2));
    app.browser.select('tag-list');
    step('tag list', app.browser.rows.length === 2, `${app.browser.rows.length} rows`);
    app.browser.relatedSelected = lib.all().find((t) => t.title === 'Kick 128');
    lib.settings = { ...lib.settings, relatedSeed: 'selected', related: { ...lib.settings.related, key: { on: false, mode: 'same' }, bpm: { on: true, pct: 12, doubleHalf: false } } };
    app.browser.select('related');
    step('related tracks', app.browser.rows.map((r) => r.track.title).join(',') === 'Kick 140', app.browser.rows.map((r) => r.track.title).join(','));
    lib.setSetting('deckCount', 4); app.applyLayout();
    {
      const deckOrderShown = [...app.decksEl.querySelectorAll('.deck')].map((el) => Number(el.dataset.deck) + 1).join('');
      const waveOrder = [...app.wavesEl.querySelectorAll('.wave-badge')].map((el) => el.textContent).join('');
      step('4-deck layout (order 3-1-2-4)', app.decksEl.querySelectorAll('.deck').length === 4 && app.mixer.stripsEl.querySelectorAll('.strip').length === 5 && deckOrderShown === '3124' && waveOrder === '3124',
        `decks ${deckOrderShown}, waveforms ${waveOrder}`);
    }
    step('frame rate (4 decks)', ...(await measureFrames(app)));
    // Hot cue bank I–P
    const dv = app.deckViews[0];
    dv.bankBtn.click();
    dv.padDown(0, {});
    step('hot cue bank I-P', !!d1.hotCue(8) && dv.pads[0].querySelector('.pad-letter').textContent === 'I', '');
    dv.bankBtn.click(); // back to A–H
    d1.play();
    for (const cfx of ['SPACE', 'DUB ECHO', 'NOISE', 'CRUSH', 'FILTER']) {
      app.engine.setColorFx(cfx);
      app.engine.channels[0].setFilter(0.6);
      await new Promise((r) => setTimeout(r, 150));
    }
    app.engine.channels[0].setFilter(0);
    step('color fx', app.engine.levels().master > 0.01, app.engine.levels().master.toFixed(3));
    for (const id of ['ROLL', 'REV ROLL', 'VINYL BRAKE', 'PITCH', 'UP ECHO', 'DOWN ECHO', 'PAN', 'ROBOT']) {
      app.engine.fx.setEffect(id); app.engine.fx.setOn(true);
      await new Promise((r) => setTimeout(r, 250));
      const lvl = app.engine.levels().master;
      app.engine.fx.setOn(false);
      step(`beat fx ${id}`, id === 'VINYL BRAKE' || lvl > 0.005, lvl.toFixed(3));
    }
    // MIDI learn + dispatch without hardware: feed raw messages to the controller.
    app.midi.learnTarget = 'deck1.play';
    app.midi.onMessage([0x90, 36, 127]);
    step('midi learn', lib.settings.midiMappings.some((m) => m.key === 'note:1:36' && m.target === 'deck1.play'), '');
    const wasPlaying = d1.playing;
    app.midi.onMessage([0x90, 36, 127]);
    step('midi dispatch', d1.playing !== wasPlaying, `playing ${wasPlaying} -> ${d1.playing}`);
    if (!d1.playing) d1.play();
    app.browser.select('collection');

    // ---- phase 3 ----
    dv.padMode = 'BEAT LOOP'; dv.padDown(4, {});
    step('pad mode beat loop', d1.loop?.beats === 4, String(d1.loop?.beats));
    d1.exitLoop();
    dv.padMode = 'SLICER'; dv.padDown(2, {});
    const sliceOk = d1.loop?.slice === 2 && d1.slip;
    await new Promise((r) => setTimeout(r, 300));
    dv.padUp(2);
    step('slicer', sliceOk && !d1.loop && !d1.slip, `slice=${sliceOk} after: loop=${!!d1.loop} slip=${d1.slip}`);
    d1.censorDown(); await new Promise((r) => setTimeout(r, 200)); d1.censorUp();
    step('censor', !d1.reverse && !d1.slip, '');
    // rekordbox KEY SHIFT pads: +4 +5 +6 +7 / 0 +1 +2 +3 (page 2: -4 -3 -2 -1 / -8 -7 -6 -5).
    dv.setPadMode('KEY SHIFT'); dv.padDown(5, {});
    const k1 = d1.keyShift;
    dv.setPadPage(1); dv.padDown(4, {});
    const k2 = d1.keyShift;
    const label = dv.pads[4].querySelector('.pad-letter').textContent;
    dv.setPadPage(0);
    step('pad key shift (rekordbox table, 2 pages)', k1 === 1 && k2 === -8 && label === '-8', `pad 6 → ${k1}, page 2 pad 5 → ${k2} (label ${label})`);
    // BEAT JUMP pads: -1/4 +1/4 -1/2 +1/2 -1 +1 -2 +2, exactly on the grid.
    dv.setPadMode('BEAT JUMP');
    d1.pause(); d1.seek(d1.beatTime(8) + 0.1);
    const j0 = d1.position(); const b0 = d1.beatIndexAt(j0);
    dv.padDown(7, {}); // +2
    const jumped = d1.beatIndexAt(d1.position()) - b0;
    const b1 = d1.beatIndexAt(d1.position());
    dv.padDown(1, {}); // +1/4
    const quarter = d1.beatIndexAt(d1.position()) - b1;
    const labels = dv.pads.map((p) => p.querySelector('.pad-letter').textContent).join(' ');
    step('pad beat jump (rekordbox table, on the grid)', Math.abs(jumped - 2) < 1e-6 && Math.abs(quarter - 0.25) < 1e-6 && labels === '-1/4 +1/4 -1/2 +1/2 -1 +1 -2 +2',
      `pad 8 → ${jumped.toFixed(4)} beats, pad 2 → ${quarter.toFixed(4)} · pads ${labels}`);
    d1.play();
    dv.setPadMode('HOT CUE');
    d1.setKeyShift(0);
    dv.padMode = 'HOT CUE'; dv.renderPads();

    const id100 = lib.all().find((t) => t.title === 'Kick 100').id;
    const d3 = app.engine.decks[2]; const d4 = app.engine.decks[3];
    await app.loadTrack(2, id128);
    d3.play(); d3.beatLoop(4);
    const slot = await app.captureLoop(2);
    const cap = app.sampler.slots[slot];
    step('capture loop to sampler', slot === 0 && Math.abs(cap.buffer.duration - 4 * 60 / 128) < 0.01, `${cap?.buffer?.duration.toFixed(3)} s`);
    app.sampler.trigger(0);
    await app.loadSamplerSlot(1, id100);
    app.sampler.trigger(1);
    await new Promise((r) => setTimeout(r, 200));
    step('sampler plays', app.sampler.isPlaying(0) && app.sampler.isPlaying(1), '');
    dv.padMode = 'SAMPLER'; dv.renderPads();
    step('sampler pads', dv.pads[0].classList.contains('active'), dv.pads[0].className);
    app.sampler.stopAll(); dv.padMode = 'HOT CUE'; dv.renderPads();
    d3.exitLoop();
    await app.instantDouble(2, 3);
    step('instant double', d4.track?.id === id128 && d4.playing && Math.abs(d4.position() - d3.position()) < 0.1, `${d3.position().toFixed(2)} vs ${d4.position().toFixed(2)}`);
    // Load lock: a playing deck refuses a new track unless "Load a track onto a playing deck" is on.
    {
      const id100b = lib.all().find((t) => t.title === 'Kick 100').id;
      await app.loadTrack(3, id100b);
      const refused = d4.track?.id === id128;
      lib.setSetting('loadOnPlaying', true);
      await app.loadTrack(3, id100b);
      const allowed = d4.track?.id === id100b;
      lib.setSetting('loadOnPlaying', false);
      step('load lock setting', refused && allowed, `playing deck: refused by default ${refused}, loaded when allowed ${allowed}`);
    }
    d3.pause(); d4.pause();

    await app.toggleRecording();
    await new Promise((r) => setTimeout(r, 1200));
    const rec = await app.toggleRecording();
    const recPl = lib.playlistList().find((p) => p.label === 'Recordings');
    step('wav recording', rec?.bytes > 44100 * 4 * 0.8 && recPl && lib.findNode(recPl.id).node.trackIds.length === 1, `${rec?.bytes} bytes`);

    d1.pause(); d2.pause();
    if (d2.sync) d2.toggleSync();
    app.automix.settings = { mixBeats: 4, repeat: false, shuffle: false };
    await app.automix.start([id100, id128]);
    const first = app.engine.decks[0];
    step('automix start', app.automix.active && first.track?.id === id100 && first.playing, '');
    first.seek(first.duration - 5);
    const t0 = performance.now();
    while (app.automix.index === 0 && performance.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 100));
    const second = app.engine.decks[1];
    step('automix transition', app.automix.index === 1 && second.track?.id === id128 && second.playing && !first.playing && app.engine.crossfader > 0.9,
      `index=${app.automix.index} xf=${app.engine.crossfader.toFixed(2)}`);
    app.automix.stop(); second.pause();
    app.engine.setCrossfader(0);
    d1.play();

    // ---- phase 4 ----
    // Dynamic grid on a tempo ramp (120 -> 132 BPM over 40 s).
    {
      const sr = ctx.sampleRate; const secs = 40;
      const ramp = ctx.createBuffer(2, secs * sr, sr);
      const L = ramp.getChannelData(0);
      let phase = 0;
      for (let i = 0; i < L.length; i++) {
        const t = i / sr;
        phase += (120 + 12 * t / secs) / 60 / sr;
        const beatT = (phase % 1) / ((120 + 12 * t / secs) / 60);
        if (beatT < 0.15) L[i] = 0.8 * Math.exp(-beatT / 0.03) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beatT / 0.01)) * beatT);
      }
      ramp.copyToChannel(L, 1);
      const dyn = await app.analyzer.analyzeBuffer(ramp, { mode: 'dynamic', bpmRange: [88, 175] });
      const bgd = toBeatgrid(dyn.beatgrid);
      step('dynamic beatgrid', bgd?.dynamic && Math.abs(bgd.bpmAt(3) - 121) < 2 && Math.abs(bgd.bpmAt(37) - 131) < 2, `${bgd?.dynamic} ${bgd?.bpmAt(3).toFixed(1)} -> ${bgd?.bpmAt(37).toFixed(1)}`);
      const norm = await app.analyzer.analyzeBuffer(ramp, { mode: 'normal', bpmRange: [88, 175] });
      step('normal mode keeps a constant grid', !norm.beatgrid.beats, '');
    }
    // Phrases + intelligent cues on a structured track imported from a file.
    {
      const sr = ctx.sampleRate; const P = 60 / 128; const bars = 48;
      const buf = ctx.createBuffer(2, Math.ceil(bars * 4 * P * sr) + sr, sr);
      const L = buf.getChannelData(0);
      let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      const kick = (t, gain) => { const s = Math.round(t * sr); for (let j = 0; j < sr * 0.15 && s + j < L.length; j++) L[s + j] += gain * Math.exp(-j / (sr * 0.03)) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (sr * 0.01))) * (j / sr)); };
      const hat = (t, gain) => { const s = Math.round(t * sr); for (let j = 0; j < sr * 0.03 && s + j < L.length; j++) L[s + j] += gain * rnd() * Math.exp(-j / (sr * 0.006)); };
      const pad = (t0, t1, gain) => { for (let i = Math.round(t0 * sr); i < Math.min(L.length, Math.round(t1 * sr)); i++) { const x = i / sr; L[i] += gain * (Math.sin(2 * Math.PI * 440 * x) + Math.sin(2 * Math.PI * 554.37 * x) + Math.sin(2 * Math.PI * 659.25 * x)) / 3; } };
      for (let b = 0; b < bars; b++) {
        const t0 = b * 4 * P; const sec = b < 16 ? 'intro' : b < 24 ? 'down' : b < 40 ? 'chorus' : 'outro';
        for (let k = 0; k < 4; k++) { if (sec !== 'down') kick(t0 + k * P, sec === 'chorus' ? 0.9 : 0.6); if (sec === 'intro' || sec === 'chorus') hat(t0 + k * P + P / 2, sec === 'chorus' ? 0.35 : 0.15); }
        if (sec === 'down' || sec === 'chorus') pad(t0, t0 + 4 * P, sec === 'down' ? 0.25 : 0.3);
      }
      buf.copyToChannel(L, 1);
      await window.rb.writeFile(`${dir}\\Structure.wav`, encodeWav([L.map((x) => x * 0.6), L.map((x) => x * 0.6)], sr));
      await app.importPaths([`${dir}\\Structure.wav`]);
      while (app.analyzing || app.queue.length) await new Promise((r) => setTimeout(r, 100));
      const st = lib.all().find((t) => t.title === 'Structure');
      const stored = await window.rb.getAnalysis(st.id);
      const labels = (stored.phrases?.phrases ?? []).map((p) => `${p.label}@${p.startBar}`).join(' ');
      step('phrase analysis', labels === 'INTRO@0 DOWN@16 CHORUS@24 OUTRO@40', `${stored.phrases?.mood}: ${labels}`);
      // The breakdown starts at bar 16 (30 s): that beat must be a bar start.
      const sg = toBeatgrid(stored.beatgrid);
      const idx16 = Math.round(sg.indexAt(16 * 4 * P));
      step('downbeat', sg.isDownbeat(idx16) && Math.abs(sg.timeOf(idx16) - 16 * 4 * P) < 0.02, `first=${stored.beatgrid.firstBeat} beat=${stored.beatgrid.beat}`);
      await app.createCuesFor(st.id);
      const cues = lib.get(st.id).cues;
      const hotB = cues.find((c) => c.kind === 'hot' && c.slot === 1);
      step('intelligent cues', hotB?.name === 'CHORUS' && Math.abs(hotB.start - 24 * 4 * P) < 0.05 && cues.filter((c) => c.kind === 'memory').length === 4, `${cues.length} cues, B=${hotB?.name}@${hotB?.start}`);
      // Grid editing on the loaded track.
      await app.loadTrack(2, st.id);
      const before = d3.grid;
      app.setTrackGrid(d3, setDownbeatAt(before, before.firstBeat + 60 / 128));
      step('grid edit (downbeat)', d3.bg.isDownbeat(Math.round(d3.bg.indexAt(before.firstBeat + 60 / 128))), `beat=${d3.grid.beat}`);
      app.setTrackGrid(d3, before);
      // Suggestions (sound-alike) need features from analysis.
      app.browser.relatedSelected = lib.get(st.id);
      lib.settings = { ...lib.settings, relatedSeed: 'selected' };
      app.browser.select('suggest');
      step('track suggestion', app.browser.rows.length >= 3 && app.browser.rows.every((r) => r.track.id !== st.id), `${app.browser.rows.length} rows: ${app.browser.rows.map((r) => r.track.title).join(', ')}`);
      app.browser.select('collection');
    }
    // Mix Point Link: deck 3 reaches MIX OUT -> deck 4 starts from MIX IN.
    {
      await app.loadTrack(3, id128);
      d4.seek(4); d4.setMixPoint('mixin');
      d3.seek(10); d3.play();
      await new Promise((r) => setTimeout(r, 100));
      d3.seek(d3.position()); d3.setMixPoint('mixout');
      const out = d3.mixPoint('mixout').start;
      d3.seek(Math.max(0, out - 0.6));
      lib.setSetting('mixPointLink', true);
      await new Promise((r) => setTimeout(r, 1500));
      step('mix point link', d4.playing && d4.position() > 4 && d4.position() < 6,
        `deck4 playing=${d4.playing} pos=${d4.position().toFixed(2)} in=${JSON.stringify(d4.mixPoint('mixin'))} | deck3 playing=${d3.playing} pos=${d3.position().toFixed(2)} out=${out.toFixed(2)} link=${lib.settings.mixPointLink} automix=${app.automix.active}`);
      lib.setSetting('mixPointLink', false);
      d3.pause(); d4.pause();
    }
    // Play head centred: every waveform canvas fills its box exactly (the marker is drawn at width / 2).
    {
      const boxes = [...app.waveRows.slice(0, app.deckCount), ...app.deckViews.slice(0, app.deckCount).map((v) => v.el.querySelector('.ov-box'))]
        .map((row) => { const box = row.classList.contains('canvas-box') ? row : row.querySelector('.canvas-box'); const c = box.querySelector('canvas').getBoundingClientRect(); const b = box.getBoundingClientRect(); return [c.left - b.left, c.right - b.right, b.width]; });
      step('play head centred', boxes.every(([l, r, w]) => Math.abs(l) < 1 && Math.abs(r) < 1 && w > 50), JSON.stringify(boxes.map((x) => x.map((v) => Math.round(v)))));
    }
    // Zoomed in, the detail waveform is the real wave: its top edge changes from column to column
    // (band points alone would give flat steps ~10 px wide at this zoom).
    {
      const zoomBefore = app.zoom;
      const edges = async (zoom) => {
        app.zoom = zoom;
        await new Promise((r) => setTimeout(r, 300));
        const c = app.waveCanvases[2]; const W = c.width; const H = c.height;
        const img = c.getContext('2d').getImageData(0, 0, W, H).data;
        const tops = [];
        for (let x = Math.floor(W * 0.02); x < W * 0.98; x++) {
          if (Math.abs(x - W / 2) < 4 * devicePixelRatio) continue; // play head
          let y = Math.round(14 * devicePixelRatio);
          for (; y < H / 2; y++) { const i = (y * W + x) * 4; if (img[i] + img[i + 1] + img[i + 2] > 200) break; }
          tops.push(y);
        }
        // Only where there is sound (the test tracks are silent between their hits).
        const loud = H / 2 - 3 * devicePixelRatio;
        let changes = 0; let pairs = 0;
        for (let i = 1; i < tops.length; i++) {
          if (tops[i] > loud || tops[i - 1] > loud) continue;
          pairs++;
          if (tops[i] !== tops[i - 1]) changes++;
        }
        edges.info = `${W}x${H} pairs ${pairs} topmin ${Math.min(...tops)} pos ${d3.position().toFixed(2)}`;
        return pairs > 20 ? changes / pairs : 0;
      };
      d3.seek(8);
      const zoomed = await edges(1);
      await window.rb.smokeShot('wave-zoom');
      const wide = await edges(32);
      app.zoom = zoomBefore;
      step('zoomed waveform is a real wave', d3.fine?.max.length > 0 && zoomed > 0.3, `top edge changes on ${(zoomed * 100).toFixed(0)}% of columns at 1 s, ${(wide * 100).toFixed(0)}% at 32 s; ${edges.info}`);
    }
    // Stems (only when models are provided: REBOXED_SPLEETER_DIR / REBOXED_STEM_MODEL for this test).
    const stemModels = (await window.rb.stems.status()).models;
    if (stemModels.fast || stemModels.hq) {
      const q = stemModels.fast ? 'fast' : 'hq';
      lib.setSetting('stemsQuality', q);
      await app.loadTrack(2, id128);
      for (let i = 0; i < 50 && !d3.loaded; i++) await new Promise((r) => setTimeout(r, 100));
      d3.seek(12);
      const t0 = performance.now();
      const job = app.separateStems(id128, { deck: d3 });
      // Progressive: the first block lands at the play head well before the whole track is done.
      let firstAt = null;
      for (let i = 0; i < 600 && firstAt === null; i++) {
        if (d3.stemCoverage() > 0) firstAt = performance.now() - t0;
        else await new Promise((r) => setTimeout(r, 20));
      }
      const atHead = d3.stemsAt(12);
      const firstRanges = JSON.stringify(d3.stemRanges.map(([a, b]) => [+(a / 44100).toFixed(1), +(b / 44100).toFixed(1)])) + ` pos=${d3.position().toFixed(2)} dur=${d3.duration?.toFixed(1)}`;
      const partial = d3.stemCoverage();
      const meta = await job;
      step('stem separation (progressive)', firstAt !== null && atHead && meta?.stems?.length === 4 && meta.frames > 44100 * 23,
        `${q}: first block after ${firstAt?.toFixed(0)} ms (coverage ${(partial * 100).toFixed(0)}%), playhead covered=${atHead}, total ${(performance.now() - t0).toFixed(0)} ms on ${meta?.ep} ${firstRanges}`);
      for (let i = 0; i < 50 && !d3.stemsComplete; i++) await new Promise((r) => setTimeout(r, 100));
      step('stems loaded on deck', d3.stemsReady && d3.stemsComplete && d3.stemCoverage() > 0.999 && d3.stemQuality === q && !!d3.stemEnv,
        `quality=${d3.stemQuality} coverage=${d3.stemCoverage().toFixed(3)} env=${!!d3.stemEnv} column=${lib.get(id128)?.stems}`);
      step('stem status hidden when idle', app.stemStatus.hidden && app.deckViews[2].stemSepBtn.textContent === q.toUpperCase(), app.deckViews[2].stemSepBtn.textContent);
      app.engine.setCrossfader(-1);
      d3.play();
      await new Promise((r) => setTimeout(r, 600));
      const full = app.engine.levels().channels[2];
      d3.soloStem(3); // vocals only: the synthetic track has no voice, so near silence
      await new Promise((r) => setTimeout(r, 600));
      const vocalsOnly = app.engine.levels().channels[2];
      d3.soloStem(3); // back to all stems
      d3.setStemOn(0, false); // drums off: the kick disappears but the drone stays
      await new Promise((r) => setTimeout(r, 600));
      const noDrums = app.engine.levels().channels[2];
      d3.setStemOn(0, true);
      step('stem solo / mute', vocalsOnly < full * 0.2 && noDrums > vocalsOnly, `full ${full.toFixed(3)}, vocals solo ${vocalsOnly.toFixed(3)}, no drums ${noDrums.toFixed(3)}`);
      d3.pause();
      app.engine.setCrossfader(0);
      if (q === 'fast' && stemModels.hq) {
        const t1 = performance.now();
        const hqJob = app.separateStems(id128, { quality: 'hq', deck: d3 });
        // Screenshot while HQ runs: progress pill + button, coloured stem waveform with drums muted.
        d3.seek(6); d3.setStemOn(0, false);
        for (let i = 0; i < 300 && !((app.stemJobs.get(id128)?.done ?? 0) > 0); i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 400));
        await window.rb.smokeShot('stems');
        d3.setStemOn(0, true);
        const hq = await hqJob;
        for (let i = 0; i < 50 && d3.stemQuality !== 'hq'; i++) await new Promise((r) => setTimeout(r, 100));
        step('stems upgrade to HQ', hq?.quality === 'hq' && d3.stemQuality === 'hq' && d3.stemsComplete && lib.get(id128)?.stems === 'hq',
          `${(performance.now() - t1).toFixed(0)} ms, deck quality=${d3.stemQuality}, column=${lib.get(id128)?.stems}`);
      }
      // Stems are kept as MP3 files in the library stems folder: <library>/stems/<track>/.
      const kept = await window.rb.stems.meta(id128, lib.get(id128).path);
      const mp3Ok = await window.rb.exists(`${kept?.dir}/vocals.mp3`);
      step('stems kept in the library stems folder (MP3)', kept?.format === 'mp3' && /stems.Kick 128$/.test(kept.dir) && mp3Ok, `${kept?.dir} quality=${kept?.quality} mp3=${mp3Ok}`);
      // MP3 stems line up with the track: first kick at the same sample (encoder delay removed).
      {
        const drums = await readStem(kept, 'drums');
        const orig = await app.analyzer.decode(lib.get(id128).path);
        const onset = (get, n) => { let max = 0; for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(get(i))); for (let i = 0; i < n; i++) if (Math.abs(get(i)) > max * 0.5) return i; return -1; };
        const n = Math.min(44100 * 2, drums.length / 2);
        const a = onset((i) => drums[2 * i] / 32768, n);
        const ch = orig.getChannelData(0);
        const b = onset((i) => ch[Math.round(i * orig.sampleRate / 44100)], n);
        step('MP3 stems aligned with the track', drums.length / 2 === kept.frames && Math.abs(a - b) < 64, `frames ${drums.length / 2}/${kept.frames}, drums onset ${a}, track onset ${b}`);
        // Sampler capture takes what is heard: drums only -> exactly the drum stem; all parts -> the track.
        d3.stemMeta ??= kept;
        [1, 2, 3].forEach((k) => d3.setStemOn(k, false));
        const only = await app.deckAudio(d3, 8, 10);
        [1, 2, 3].forEach((k) => d3.setStemOn(k, true));
        const all = await app.deckAudio(d3, 8, 10);
        let diff = 0;
        for (let i = 0; i < only.chans[0].length; i++) diff = Math.max(diff, Math.abs(only.chans[0][i] - drums[2 * (8 * 44100 + i)] / 32768));
        step('capture: only the audible stems', only.parts?.join() === 'DRUMS' && diff < 1e-4 && all.parts === null && Math.abs(only.chans[0].length - 2 * 44100) < 2,
          `parts ${only.parts?.join('+')}, max diff vs drum stem ${diff.toExponential(1)}, all parts -> ${all.parts ?? 'track'}`);
      }
      // GPU engines: each one timed on FAST (a crash is recorded, not fatal), then a real track
      // separated on the GPU, stems compared with the CPU's.
      {
        const speeds = {};
        for (const ep of STEM_ENGINES) { const r = await window.rb.stems.bench('fast', ep, 4); speeds[ep] = r.crashed ? 'crash' : r.speed ?? r.error; }
        const gpuOk = typeof speeds.webgpu === 'number' && speeds.webgpu > 0.2;
        const cpuMeta = await window.rb.stems.meta(id128, lib.get(id128).path);
        const cpuDrums = await readStem(cpuMeta, 'drums');
        const buf = await app.analyzer.decode(lib.get(id128).path);
        const off = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(buf.duration * 44100), sampleRate: 44100 });
        const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
        const r44 = await off.startRendering();
        const t0 = performance.now();
        const gpuMeta = await window.rb.stems.separate('smoke-gpu', r44.getChannelData(0), r44.getChannelData(1), { quality: 'fast', ep: 'webgpu', format: 'wav' });
        const gpuSec = (performance.now() - t0) / 1000;
        const gpuDrums = await readStem(gpuMeta, 'drums');
        let e = 0; let p = 0;
        // Compare with the FAST CPU result only if the kept stems are FAST (HQ differs by design).
        const comparable = cpuMeta.quality === 'fast';
        for (let i = 0; comparable && i < Math.min(cpuDrums.length, gpuDrums.length); i++) { e += (gpuDrums[i] - cpuDrums[i]) ** 2; p += cpuDrums[i] ** 2; }
        const snr = comparable ? 10 * Math.log10(p / Math.max(1, e)) : null;
        step('stems on the GPU (WebGPU)', gpuOk && gpuMeta?.ep === 'webgpu' && gpuMeta.frames === cpuMeta.frames && (snr === null || snr > 8),
          `speeds FAST: ${Object.entries(speeds).map(([k, v]) => `${k} ${typeof v === 'number' ? `${v.toFixed(1)}x` : v}`).join(', ')} · track on WebGPU in ${gpuSec.toFixed(1)} s, ${gpuMeta?.frames} frames${snr === null ? '' : `, drums vs CPU ${snr.toFixed(1)} dB`}`);
        lib.setSetting('stemsBench', { fast: speeds });
        step('stems engine Auto', app.stemEngine('fast') === pickEngine('auto', speeds) && app.stemEngine('hq') === 'cpu', `fast → ${app.stemEngine('fast')}, hq (not tested) → ${app.stemEngine('hq')}`);
        lib.setSetting('stemsBench', null);
      }
      lib.setSetting('stemsQuality', 'auto');
    } else {
      report.steps.push({ name: 'stems (skipped: no model)', ok: true, info: '' });
    }

    // ---- DDJ-GRV6 (virtual port: exact messages from its rekordbox mapping) ----
    {
      await app.plugins.refresh();
      const grvPlugin = app.plugins.forPort('DDJ-GRV6');
      step('plugins: built-in controllers listed', ['pioneer-ddj-grv6', 'pioneer-ddj-flx4', 'pioneer-ddj-flx2', 'pioneer-ddj-flx6', 'pioneer-ddj-flx10'].every((id) => app.plugins.all.some((p) => p.id === id && !app.plugins.problem(p))) && grvPlugin?.id === 'pioneer-ddj-grv6' && app.plugins.forPort('DDJ-FLX4 MIDI 1')?.id === 'pioneer-ddj-flx4',
        app.plugins.all.map((p) => p.id).join(', '));
      const profile = await app.plugins.mapping(grvPlugin);
      const sent = [];
      const grv = app.midi.attachDriver('virtual-grv6', profile, (b) => sent.push(b), 'DDJ-GRV6 (virtual)', grvPlugin);
      const tx = (...msgs) => msgs.forEach((m) => grv.receive(m));
      const press = (st, d1v) => tx([st, d1v, 0x7f], [st & 0x0f | 0x80, d1v, 0]);
      const hires = (st, cc, v14) => tx([st, cc, v14 >> 7], [st, cc + 0x20, v14 & 0x7f]);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      d1.pause(); d2.pause(); d3.pause(); d4.pause();
      // Load via browser encoder + LOAD (deck 2), then play/pause deck 2 from the controller.
      app.browser.select('collection');
      app.browser.setFocus('list');
      app.browser.anchor = 0;
      tx([0xb6, 0x40, 0x01]);
      const want = app.browser.currentTrackId();
      press(0x96, 0x47);
      // Deck 2 may already hold this track (automix): wait for the new load to finish, not just the id.
      for (let k = 0; k < 50 && (d2.loading || d2.track?.id !== want); k++) await wait(100);
      step('grv6 browse + load', d2.track?.id === want, app.library.get(want)?.title);
      const pre = `before: playing=${d2.playing} seq=${d2.seq} rep=${JSON.stringify(d2.lastReport)}`;
      press(0x91, 0x0b);
      await wait(200);
      step('grv6 play', d2.playing, `${pre} | after: seq=${d2.seq} rep=${JSON.stringify(d2.lastReport)} loaded=${d2.loaded} dur=${d2.duration} stems=${d2.stemsReady}`);
      press(0x91, 0x0b);
      // Mixer: 14-bit channel fader, EQ low kill, crossfader.
      hires(0xb1, 0x13, 0);
      hires(0xb0, 0x0f, 0);
      hires(0xb6, 0x1f, 0);
      step('grv6 mixer', app.engine.channels[1].state.fader < 0.01 && app.engine.channels[0].state.eq.low <= -39 && app.engine.crossfader < -0.99,
        `fader2=${app.engine.channels[1].state.fader.toFixed(3)} low1=${app.engine.channels[0].state.eq.low.toFixed(1)} xf=${app.engine.crossfader.toFixed(2)}`);
      hires(0xb1, 0x13, 16383); hires(0xb0, 0x0f, 8192); hires(0xb6, 0x1f, 8192);
      // EQ centre detent = flat (0 dB), like the on-screen knob.
      const eqMid = app.engine.channels[0].state.eq.low;
      hires(0xb0, 0x0f, 16383);
      const eqTop = app.engine.channels[0].state.eq.low;
      hires(0xb0, 0x0f, 8192);
      step('grv6 EQ centre = 0 dB', Math.abs(eqMid) < 0.1 && Math.abs(eqTop - 6) < 0.1, `centre ${eqMid.toFixed(2)} dB, right ${eqTop.toFixed(2)} dB`);
      // Pads: hot cue B (deck 1, pad 2), beat loop pad 5 (= 4 beats).
      d1.play();
      d1.deleteHotCue(1);
      press(0x97, 0x01);
      press(0x97, 0x64);
      step('grv6 pads', !!d1.hotCue(1) && d1.loop?.beats === 4, `hotcueB=${!!d1.hotCue(1)} loop=${d1.loop?.beats}`);
      d1.exitLoop();
      // Pad mode buttons open the matching pad page on screen; a page picked on screen moves the controller.
      {
        const v = app.deckViews[0];
        const pages = [];
        press(0x90, 107); pages.push(v.padMode); // PAD FX
        press(0x90, 30); pages.push(v.padMode); // STEMS
        press(0x90, 34); pages.push(v.padMode); // SAMPLER
        press(0x90, 27); pages.push(v.padMode); // HOT CUE
        v.setPadMode('BEAT JUMP');
        const ctrlMode = grv.decks[0].mode;
        v.setPadMode('HOT CUE');
        const ks0 = d1.keySync;
        press(0x90, 101); // KEY SYNC
        const ks1 = d1.keySync;
        press(0x90, 101);
        step('grv6 pad mode buttons -> pad pages', pages.join() === 'PAD FX,STEMS,SAMPLER,HOT CUE' && ctrlMode === 'BEAT JUMP' && !ks0 && ks1 && !d1.keySync,
          `pages ${pages.join(' → ')} · screen BEAT JUMP → controller ${ctrlMode} · KEY SYNC ${ks0}→${ks1}→${d1.keySync}`);
      }
      // Real-GRV6 feedback (1.13.1): SHIFT + jog, LOOP IN held, CALL < > on a loop, MEMORY, hot cue in a loop.
      {
        d1.exitLoop(); d1.seek(2); d1.play(); // back from the end of the 24 s test track
        await wait(100);
        // SHIFT held + platter touched + turned: no scratch, the play head moves forward fast. With
        // SHIFT the GRV6 sends the platter on CC 0x29 (JogSearch, commented out in rekordbox's mapping).
        tx([0x90, 0x3f, 0x7f]);              // SHIFT
        tx([0x90, 0x67, 0x7f]);              // JogTouch (with SHIFT)
        const p0 = d1.position();
        for (let k = 0; k < 20; k++) tx([0xb0, 0x29, 0x45]); // JogSearch +5 x 20
        await wait(300);
        const searched = d1.position() - p0;
        const noScratch = !d1.scratching;
        tx([0x80, 0x67, 0]); tx([0x80, 0x3f, 0]);
        step('grv6 SHIFT + jog = fast search, no scratch', noScratch && searched > 2, `moved ${searched.toFixed(2)} s, scratching ${!noScratch}`);
        // LOOP IN held: the loop starts on the beat where it was pressed, not where the long press registers.
        d1.exitLoop(); d1.setBeatLoopSize(1);
        tx([0x90, 0x10, 0x7f]);              // LOOP IN pressed
        const pressedAt = d1.pendingLoopIn;
        await wait(600);                     // the controller sends the long press later
        tx([0x90, 0x14, 0x7f]); tx([0x80, 0x14, 0]); tx([0x80, 0x10, 0]);
        const longLoop = d1.loop ? { ...d1.loop } : null;
        step('grv6 LOOP IN held: loop from the press', longLoop && Math.abs(longLoop.start - pressedAt) < 1e-6 && longLoop.beats === 1 && d1.pendingLoopIn === undefined,
          `pressed at ${pressedAt?.toFixed(3)} s, loop ${longLoop?.start.toFixed(3)}–${longLoop?.end.toFixed(3)} (${longLoop?.beats} beat)`);
        // CALL < > like the hardware: it sends LOOP 1/2X / 2X (0x12 / 0x13) only while Reboxed's
        // GetLoopActive LED (0x9F 0x04) says a loop plays, else MEMORY CALL (0x51 / 0x53).
        const loopLed = () => { const m = [...sent].reverse().find(([st, n]) => st === 0x9f && n === 0x04); return !!m && m[2] > 0; };
        const call = (dir) => press(0x90, loopLed() ? (dir < 0 ? 0x12 : 0x13) : (dir < 0 ? 0x51 : 0x53));
        d1.beatLoop(4);
        await wait(120);                     // LEDs are refreshed at 30 Hz
        const ledOn = loopLed();
        call(-1); const half = d1.currentLoopBeats();
        await wait(120);
        call(1); await wait(60); call(1); const dbl = d1.currentLoopBeats();
        // Even if the LED were late (memory call message during a loop), the loop is resized.
        press(0x90, 0x51); const lateLed = d1.currentLoopBeats();
        step('grv6 CALL < > halve / double the loop', ledOn && Math.abs(half - 2) < 1e-6 && Math.abs(dbl - 8) < 1e-6 && Math.abs(lateLed - 4) < 1e-6,
          `loop LED ${ledOn} · 4 → ${half} → ${dbl} beats · memory-call message during the loop → ${lateLed}`);
        // MEMORY adds a memory cue; a point hot cue leaves the loop.
        const memBefore = d1.memoryCues().length;
        press(0x90, 0x3d);
        const memAfter = d1.memoryCues().length;
        d1.setCues((d1.track.cues ?? []).filter((c) => !(c.kind === 'hot' && c.slot === 2)));
        d1.exitLoop(); d1.seek(2); d1.hotCuePress(2);   // hot cue C at 2 s
        d1.seek(8); d1.beatLoop(2);
        d1.hotCuePress(2);
        const leftLoop = !d1.loop;
        step('grv6 MEMORY; hot cue leaves the loop', memAfter === memBefore + 1 && leftLoop, `memory cues ${memBefore} → ${memAfter} · loop after hot cue: ${!leftLoop}`);
        // BEAT JUMP pads as rekordbox: -1/4 +1/4 -1/2 +1/2 -1 +1 -2 +2.
        app.deckViews[0].setPadMode('BEAT JUMP');
        const jumpLabels = app.deckViews[0].pads.map((p) => p.querySelector('.pad-letter').textContent).join(' ');
        app.deckViews[0].setPadMode('HOT CUE');
        step('beat jump pads start with 1/4 and 1/2', jumpLabels === '-1/4 +1/4 -1/2 +1/2 -1 +1 -2 +2', jumpLabels);
        d1.setBeatLoopSize(4);
      }
      // Tempo slider with soft takeover: far away -> ignored, centre -> caught, then moves.
      d1.setTempoPct(0);
      hires(0xb0, 0x00, 16383);
      const ignored = Math.abs(d1.tempoPct) < 0.01;
      hires(0xb0, 0x00, 8192);
      hires(0xb0, 0x00, 12288);
      step('grv6 tempo (soft takeover)', ignored && Math.abs(d1.tempoPct - d1.tempoRange * 0.5) < 0.1, `pct=${d1.tempoPct.toFixed(2)}`);
      d1.setTempoPct(0);
      // Jog scratch: touch, spin forward, release.
      d1.pause();
      d1.seek(5); // automix left deck 1 at the very end of its track
      await wait(50);
      const before = d1.position();
      tx([0x90, 0x36, 0x7f]);
      const touched = d1.scratching;
      for (let k = 0; k < 20; k++) { tx([0xb0, 0x22, 0x40 + 20]); await wait(10); }
      await wait(150);
      const mid = JSON.stringify(d1.lastReport);
      tx([0x90, 0x36, 0x00]);
      const moved = d1.position() - before;
      step('grv6 jog scratch', moved > 0.3, `moved ${moved.toFixed(2)} s touched=${touched} vinyl=${d1.vinyl} loaded=${d1.loaded} report=${mid}`);
      // Beat FX: select ECHO, assign CH2, on.
      press(0x94, 0x21); press(0x94, 0x11); press(0x94, 0x47);
      step('grv6 beat fx', app.engine.fx.effectId === 'ECHO' && app.engine.fx.target === 'ch2' && app.engine.fx.on, `${app.engine.fx.effectId} ${app.engine.fx.target} ${app.engine.fx.on}`);
      press(0x94, 0x47);
      // Groove Circuit + PART ISOLATOR on a deck that has stems.
      if (d3.stemsReady) {
        d3.play();
        hires(0xb2, 0x08, 0);   // PART ISOLATOR VOCAL knob fully left
        const labels = [...app.mixer.stripsEl.querySelectorAll('.strip.ch3 .knob .knob-label')].map((l) => l.textContent).join(',');
        step('grv6 part isolator (HI vocal, MID inst+bass, LOW drums)', d3.stemGains[3] === 0 && d3.partIso && labels.includes('VOCAL,INST,DRUMS'),
          `${JSON.stringify(d3.stemGains)} · ch3 knobs ${labels}`);
        hires(0xb2, 0x08, 16383);
        d3.setPartIso(false);
        const g3 = app.groove[2];
        // Built-in loops: bank A slot 2 (Techno) plays at once, at the deck's tempo.
        press(0x92, 0x01);      // DRUM SWAP 2
        await wait(150);
        const builtin = g3.isPlaying(1) && g3.slot(1).builtin === 1;
        const loopRate = [...g3.playing.values()][0]?.src.playbackRate.value;
        press(0x92, 0x01);
        step('grv6 drum swap built-in loop', builtin && Math.abs(loopRate - 1) < 0.01, `${g3.slot(1).name} rate=${loopRate}`);
        // DRUM CAPTURE (rekordbox): CAPTURE arms it, the slot pressed next receives the drums.
        press(0x92, 0x08);      // DRUM CAPTURE on
        const armed = g3.captureArmed;
        press(0x92, 0x00);      // DRUM SWAP 1 receives the capture (does not play)
        for (let k = 0; k < 30 && !g3.slot(0).captured; k++) await wait(100);
        const capturedNotPlaying = !!g3.slot(0).captured && !g3.isPlaying(0) && !g3.captureArmed;
        press(0x92, 0x00);      // DRUM SWAP 1 plays it
        await wait(200);
        step('grv6 drum capture + swap', armed && capturedNotPlaying && g3.isPlaying(0), `armed ${armed}, captured into A1 ${capturedNotPlaying} (${g3.slot(0).name}), then plays ${g3.isPlaying(0)}`);
        press(0x92, 0x00);
        // DRUM SWAP editor: 8 slots; built-in loop, eject and gain are kept in the settings.
        {
          const editing = app.openDrumSwapEditor(2);
          await wait(300);
          const cards = document.querySelectorAll('.dse-card').length;
          const sel = document.querySelectorAll('.dse-source')[5]; // B2
          sel.value = 'builtin:0'; sel.dispatchEvent(new Event('change'));
          [...document.querySelectorAll('.dse-card')][7].querySelector('button[title="Empty this slot"]').click(); // B4
          const gainIn = document.querySelectorAll('.dse-gain')[5];
          gainIn.value = '1.5'; gainIn.dispatchEvent(new Event('input')); gainIn.dispatchEvent(new Event('change'));
          await window.rb.smokeShot('drum-swap');
          document.querySelector('.dialog:has(.dse) .dialog-buttons button').click();
          await editing;
          const kept = app.library.settings.grooveSlots ?? {};
          step('drum swap editor', cards === 8 && g3.slots[1][1].builtin === 0 && g3.slots[1][1].gain === 1.5 && g3.slots[1][3] === null
            && kept['2:1:1']?.builtin === 0 && kept['2:1:1']?.gain === 1.5 && kept['2:1:3']?.empty,
          `${cards} slots · B2 ${g3.slots[1][1].name} ${g3.slots[1][1].gain} · B4 ${g3.slots[1][3]} · saved ${JSON.stringify(kept)}`);
          g3.reset(1, 1); g3.reset(1, 3); app.saveGrooveSlot(2, 1, 1); app.saveGrooveSlot(2, 1, 3);
        }
        // DRUM ROLL: 1/8 held, then 1/4 too, then 1/8 released: the same captured drum keeps rolling.
        tx([0x92, 0x04, 0x7f]); await wait(300);
        const roll0 = d3.rollStart;
        tx([0x92, 0x05, 0x7f]); await wait(300);
        const roll1 = d3.rollStart;
        tx([0x82, 0x04, 0]); await wait(100);
        const roll2 = d3.rollStart;
        tx([0x82, 0x05, 0]);
        step('grv6 drum roll keeps the captured drum', roll0 != null && roll1 === roll0 && roll2 === roll0 && d3.rollStart == null,
          `captured at ${roll0?.toFixed(3)} s · with 1/4 too ${roll1?.toFixed(3)} · after releasing 1/8 ${roll2?.toFixed(3)} · released ${d3.rollStart}`);
        // DRUM RELEASE FX: SHIFT cycles the type; held BRAKE takes the kick out of the mix.
        app.engine.setCrossfader(-1);
        // Mean level over a window (an instant reading depends on where the kick falls).
        const meanOver = async (ms) => { let a = 0; let n = 0; for (let t = 0; t < ms; t += 20) { a += app.engine.levels().channels[2]; n++; await wait(20); } return a / n; };
        // Every type takes the drums out while held. Only the drum part plays during this test (the
        // other parts muted), so the level is the drums' own: from the same place of the track, at
        // least 60 % of it is gone while the release FX is held.
        const from = 4;
        [1, 2, 3].forEach((k) => d3.setStemOn(k, false));
        d3.seek(from); await wait(300);
        const withDrums = await meanOver(800);
        const kills = [];
        let allKill = true;
        for (const type of RELEASE_FX) {
          d3.releaseFx = type;
          d3.seek(from); await wait(100);
          tx([0x92, 0x24, 0x7f]); await wait(1200);
          const released = await meanOver(800);
          tx([0x82, 0x24, 0]);
          const kill = 1 - released / Math.max(1e-6, withDrums);
          kills.push(`${type} ${(kill * 100).toFixed(0)}%`);
          if (!(kill > 0.6)) allKill = false;
        }
        [1, 2, 3].forEach((k) => d3.setStemOn(k, true));
        kills.unshift(`drums alone ${withDrums.toFixed(3)} ·`);
        d3.releaseFx = RELEASE_FX[0];
        press(0x92, 0x26);      // SHIFT + DRUM RELEASE FX: next type
        const next = d3.releaseFx;
        step('grv6 drum release fx (every type kills the drums)', allKill && next === RELEASE_FX[1], `${kills.join(' · ')} · SHIFT → ${next}`);
        d3.releaseFx = RELEASE_FX[0];
        // FX PART SELECT (STEMS pad mode, bottom row): drums only through the Beat FX. With the FX off
        // the channel must sound the same (parts + rest = whole).
        press(0x92, 0x1e);      // STEMS pad mode
        await wait(200);
        const whole = await meanOver(1500);
        press(0x9b, 0x17);      // FX PART SELECT DRUMS (deck 3)
        await wait(200);
        const split = await meanOver(1500);
        const partLed = sent.some(([st, d1v, v]) => st === 0x9b && d1v === 0x17 && v === 0x7f);
        step('grv6 fx part select', d3.fxParts[0] && app.engine.channels[2].partMode && partLed && app.deckViews[2].padMode === 'STEMS'
          && split > whole * 0.8 && split < whole * 1.25, `mean level whole ${whole.toFixed(3)} / drums via FX ${split.toFixed(3)}, led=${partLed}`);
        // What the Beat FX receives (its input bus): the whole channel, or only the selected part.
        const fxTap = app.engine.ctx.createAnalyser(); fxTap.fftSize = 2048;
        app.engine.channels[2].insert.in.connect(fxTap);
        const tapBuf = new Float32Array(2048);
        const fxIn = async (ms) => {
          let a = 0; let n = 0;
          for (let t = 0; t < ms; t += 20) { fxTap.getFloatTimeDomainData(tapBuf); let e = 0; for (const v of tapBuf) e += v * v; a += Math.sqrt(e / tapBuf.length); n++; await wait(20); }
          return a / n;
        };
        const inDrums = await fxIn(1200);       // DRUMS selected (from above)
        press(0x9b, 0x17); press(0x9b, 0x14);   // DRUMS off, VOCAL on
        await wait(200);
        const inVocal = await fxIn(1200);
        press(0x9b, 0x14);                      // none: the whole channel goes to the FX again
        await wait(200);
        const inWhole = await fxIn(1200);
        app.engine.channels[2].insert.in.disconnect(fxTap);
        step('grv6 fx part select: FX gets only the part', inVocal < inDrums * 0.5 && inDrums < inWhole * 0.8 && !d3.fxParts.some(Boolean) && !app.engine.channels[2].partMode,
          `FX input rms: drums ${inDrums.toFixed(4)}, vocal ${inVocal.toFixed(4)}, whole ${inWhole.toFixed(4)}`);
        // On-screen GROOVE pads.
        app.deckViews[2].setPadMode('GROOVE');
        const pads = app.deckViews[2].pads.map((x) => x.textContent);
        await wait(200);
        await window.rb.smokeShot('groove');
        step('ui groove pads', pads[0].startsWith('A1') && pads[5] === 'CAP4 beats' && pads[7] === `REL${RELEASE_FX[0]}`, JSON.stringify(pads));
        app.deckViews[2].setPadMode('HOT CUE');
        app.engine.setCrossfader(0);
        d3.pause();
      } else {
        report.steps.push({ name: 'grv6 groove circuit (skipped: no stems)', ok: true, info: '' });
      }
      // LEDs: deck 1 hot cue B lit, VU meters and jog ring sent.
      sent.length = 0;
      grv.updateLeds(true);
      const has = (a, b) => sent.some((m) => m[0] === a && m[1] === b);
      step('grv6 leds', sent.some((m) => m[0] === 0x97 && m[1] === 0x01 && m[2] === 0x7f) && has(0xb0, 0x02) && has(0xbf, 0x00) && has(0x90, 0x0b),
        `${sent.length} messages`);
      // 4-channel output: works only on a 4-channel device; on stereo it must refuse cleanly.
      let quadInfo;
      try { app.engine.setOutputLayout('quad'); quadInfo = 'quad active'; app.engine.setOutputLayout('stereo'); } catch (err) { quadInfo = err.message; }
      step('grv6 audio layout', /quad active|channels/.test(quadInfo), quadInfo);
      app.midi.controllers.delete('virtual-grv6');
    }

    // ---- DDJ-FLX10 (virtual port): where its mapping differs from the GRV6 ----
    {
      const flxPlugin = app.plugins.forPort('DDJ-FLX10');
      const flx = app.midi.attachDriver('virtual-flx10', await app.plugins.mapping(flxPlugin), () => {}, 'DDJ-FLX10 (virtual)', flxPlugin);
      const tx = (...msgs) => msgs.forEach((m) => flx.receive(m));
      const press = (st, d1v) => tx([st, d1v, 0x7f], [st & 0x0f | 0x80, d1v, 0]);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      d1.pause();
      d1.exitLoop?.();
      d1.seek(2);
      // SHIFT rows carry no deck column on the FLX10 (one per MIDI channel); SHIFT + jog = search.
      tx([0x90, 0x3f, 0x7f]);
      const from = d1.position();
      for (let k = 0; k < 20; k++) tx([0xb0, 0x22, 0x50]);
      await wait(50);
      const searched = d1.position() - from;
      tx([0x80, 0x3f, 0]);
      step('flx10 SHIFT + jog = search', flx.decks[0].shift === false && searched > 1 && !d1.scratching, `moved ${searched.toFixed(2)} s`);
      // MEMORY CUE CALL < has its own button: it calls the memory cue and leaves a playing loop's size alone.
      if (!d1.memoryCues().length) { d1.seek(1); d1.addMemoryCue(); }
      d1.seek(8);
      d1.beatLoop(4);
      const loopBefore = d1.currentLoopBeats();
      press(0x90, 0x51);
      await wait(50);
      const loopAfter = d1.loop ? d1.currentLoopBeats() : null;
      step('flx10 MEMORY CUE CALL does not resize the loop', loopAfter === null || Math.abs(loopAfter - loopBefore) < 1e-6, `loop ${loopBefore} → ${loopAfter ?? 'left'} beats, play head ${d1.position().toFixed(2)} s`);
      d1.exitLoop?.();
      // BEAT GRID SLIDE held + jog moves the grid; released, the jog is a jog again.
      const gridBefore = d1.grid;
      press(0x90, 0x0a); // SLIDE alone: nothing moves
      tx([0x90, 0x0a, 0x7f], [0xb0, 0x22, 0x44]);
      const slid = JSON.stringify(d1.grid) !== JSON.stringify(gridBefore);
      tx([0x80, 0x0a, 0]);
      const afterSlide = JSON.stringify(d1.grid);
      tx([0xb0, 0x23, 0x44]);
      step('flx10 BEAT GRID SLIDE + jog', slid && JSON.stringify(d1.grid) === afterSlide, `grid ${gridBefore?.firstBeat?.toFixed?.(4)} → ${d1.grid?.firstBeat?.toFixed?.(4)}`);
      if (gridBefore && !d1.track.gridLocked) app.setTrackGrid(d1, gridBefore);
      // SAMPLER CUE / VOLUME (global rows on channel 7).
      press(0x96, 0x69);
      const cueOn = app.sampler.cue === true;
      press(0x96, 0x69);
      tx([0xb6, 0x03, 0x40], [0xb6, 0x23, 0x00]);
      step('flx10 SAMPLER CUE / VOLUME', cueOn && app.sampler.cue === false && Math.abs(app.samplerView.volume.getValue() - 0.6) < 0.02, `volume knob ${app.samplerView.volume.getValue().toFixed(3)}`);
      app.samplerView.setVolume(0.8);
      // FX PART SELECT is global on the FLX10: it applies to the Beat FX's channel.
      if (d3.stemsReady) {
        app.engine.fx.setTarget('ch3');
        press(0x96, 0x1b);
        const on = d3.fxParts[3];
        press(0x96, 0x1b);
        step('flx10 FX PART SELECT (global, Beat FX channel)', on && !d3.fxParts[3], `vocal part on deck 3: ${on}`);
      }
      step('flx10: every message handled', flx.unknown.size === 0, [...flx.unknown].join(', '));
      app.midi.controllers.delete('virtual-flx10');
    }

    // ---- rekordbox import tool: a rekordbox.xml with edited info, cues, a playlist and a missing file ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const k140 = lib.all().find((t) => t.title === 'Kick 140');
      const struct = lib.all().find((t) => t.title === 'Structure');
      const lost = { id: 'lost', path: `${dir}/gone/Lost.mp3`, title: 'Lost', artist: 'Nobody', cues: [{ kind: 'hot', slot: 0, start: 3 }] };
      const xml = exportRekordboxXml({
        tracks: [{ ...k140, title: 'Kick 140 (rb)', comments: 'from rekordbox', rating: 5, genre: 'Techno',
          cues: [{ kind: 'hot', slot: 3, start: 2, name: 'Drop', color: '#28e214' }, { kind: 'memory', start: 1, name: 'Mem', color: '#ff0000' }] }, struct, lost],
        playlists: [{ type: 'folder', name: 'Sets', children: [{ type: 'playlist', name: 'Imported set', trackIds: [k140.id, struct.id, 'lost'] }] }],
      });
      const file = `${dir}/rekordbox.xml`;
      await window.rb.writeFile(file, xml);
      const done = app.importXml(file);
      let stats = null;
      for (let k = 0; k < 50 && !(stats = document.querySelector('.rbi-stats')); k++) await wait(100);
      for (let k = 0; k < 50 && !document.querySelector('.rbi-warn, .rbi-ok'); k++) await wait(100);
      const warn = document.querySelector('.rbi-warn')?.textContent ?? '';
      await wait(200);
      await window.rb.smokeShot('rbimport');
      [...document.querySelectorAll('.rbi-dialog .dialog-buttons button')].find((b) => b.classList.contains('primary'))?.click();
      for (let k = 0; k < 50 && !document.querySelector('.rbi-report'); k++) await wait(100);
      document.querySelector('.rbi-dialog .dialog-buttons button.primary')?.click();
      const r = await done;
      const t = lib.get(k140.id);
      const folder = lib.playlists.find((n) => n.importSource === 'rekordbox');
      const set = folder?.children[0]?.children[0];
      step('rekordbox import tool', !!stats && /1 music file not found/.test(warn) && r?.added === 1 && r?.updated === 2
        && t.title === 'Kick 140 (rb)' && t.comments === 'from rekordbox' && t.rating === 5 && t.genre === 'Techno'
        && t.cues.some((c) => c.kind === 'hot' && c.slot === 3 && c.name === 'Drop') && t.cues.some((c) => c.kind === 'memory' && c.name === 'Mem')
        && set?.name === 'Imported set' && set.trackIds.length === 3 && lib.all().find((x) => x.title === 'Lost')?.missing === true,
        `report=${JSON.stringify(r)} warn="${warn.slice(0, 60)}" set=${set?.name}:${set?.trackIds.length} title=${t.title} cues=${t.cues.length}`);
      // Re-import: same "rekordbox" folder, no duplicates.
      const again = lib.importRekordbox(importRekordboxXml(xml), {});
      step('rekordbox re-import (no duplicates)', again.added === 0 && lib.playlists.filter((n) => n.importSource === 'rekordbox').length === 1
        && lib.all().filter((x) => x.title === 'Lost').length === 1, JSON.stringify(again));
    }

    // ---- download centre (yt-dlp); the real network test only with REBOXED_DL_TEST=1 ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const tools = await app.downloads.tools();
      app.downloads.save({ folder: `${dir}/downloads`, format: 'm4a' });
      app.downloads.open('search');
      await wait(300);
      const panel = !!document.querySelector('.dlc .dlc-tabs');
      if (tools.ytdlp && (await window.rb.smokeDlTest())) {
        const found = await window.rb.dl.search('me at the zoo jawed', 5);
        const zoo = found.find((x) => x.id === 'jNQXAC9IVRw');
        app.downloads.searchResults = found; app.downloads.query = 'me at the zoo jawed'; app.downloads.renderTab(false);
        await app.downloads.enqueue([zoo]);
        let pctSeen = 0;
        for (let k = 0; k < 600 && !app.downloads.isDone(zoo.id); k++) { pctSeen = Math.max(pctSeen, app.downloads.jobs.get(zoo.id)?.pct ?? 0); await wait(100); }
        await wait(500);
        await window.rb.smokeShot('downloads');
        const file = app.downloads.cfg.done[zoo.id];
        const t = lib.get(lib.idForPath(file ?? ''));
        const pl = lib.playlists.find((n) => n.src === 'downloads');
        step('download centre: search + download', !!zoo && !!t && t.title === 'Me at the zoo' && t.artist === 'jawed' && pl?.trackIds.includes(t.id) && pctSeen > 0,
          `file=${file} title=${t?.title} artist=${t?.artist} playlist=${pl?.trackIds.length} progress seen=${pctSeen}`);
      } else {
        await window.rb.smokeShot('downloads');
        step('download centre', panel, `panel=${panel} yt-dlp=${tools.ytdlp ?? 'missing'} ffmpeg=${!!tools.ffmpeg} deno=${!!tools.deno}`);
      }
      document.querySelector('.dlc-x')?.click();
    }
    // RGB waveform look (brighter colours + beat grid lines).
    {
      const before = lib.settings.waveformColor;
      lib.setSetting('waveformColor', 'rgb');
      await new Promise((r) => setTimeout(r, 400));
      await window.rb.smokeShot('rgb');
      lib.setSetting('waveformColor', before);
    }

    // ---- Preferences in tabs; download quality lives there ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const closed = app.openSettings('downloads');
      await wait(400);
      const tabs = [...document.querySelectorAll('.settings-tabs button')].map((b) => b.textContent);
      const active = document.querySelector('.settings-tabs button.on')?.textContent;
      const quality = [...document.querySelectorAll('.settings-pane select option')].some((o) => /MP3 320/.test(o.textContent));
      await window.rb.smokeShot('settings');
      document.querySelector('.settings-tabs button[data-tab="library"]').click();
      await wait(400);
      const libPath = document.querySelector('.settings-pane code.path')?.textContent;
      const info = await window.rb.storage.info();
      document.querySelector('.settings-tabs button[data-tab="plugins"]').click();
      await wait(500);
      const cards = [...document.querySelectorAll('.plugin-card b')].map((b) => b.textContent);
      const live = [...document.querySelectorAll('.plugin-tag.live')].length;
      await window.rb.smokeShot('plugins');
      // Scrolling a long tab (and focusing its last control) moves the pane only, never the category bar.
      document.querySelector('.settings-tabs button[data-tab="keyboard"]').click();
      await wait(400);
      const pane = document.querySelector('.settings-pane');
      const barTop = document.querySelector('.settings-tabs').getBoundingClientRect().top;
      pane.scrollTop = pane.scrollHeight;
      [...pane.querySelectorAll('button')].at(-1)?.focus();
      await wait(100);
      const barMoved = Math.abs(document.querySelector('.settings-tabs').getBoundingClientRect().top - barTop);
      const outer = document.querySelector('.dialog:has(.settings) > .dialog-body').scrollTop + document.querySelector('.settings').scrollTop;
      step('preferences: only the tab scrolls', pane.scrollTop > 100 && barMoved < 0.5 && outer === 0, `pane scrolled ${pane.scrollTop}px, category bar moved ${barMoved}px, outer scroll ${outer}`);
      // Stems: engine choice (Auto / CPU / GPU) and the engine test table.
      lib.setSetting('stemsBench', { fast: { cpu: 7.0, webgpu: 6.7, dml: 9.8 }, hq: { cpu: 0.44, webgpu: 0.15, dml: 'crash' } });
      document.querySelector('.settings-tabs button[data-tab="stems"]').click();
      await wait(400);
      const engineRows = [...document.querySelectorAll('.engine-row')].map((r) => r.textContent);
      const usedCells = [...document.querySelectorAll('.engine-cell.used')].map((c) => c.textContent);
      await window.rb.smokeShot('stems-engines');
      lib.setSetting('stemsBench', null);
      step('preferences: stem engines (Auto / CPU / GPU)', engineRows.length === 2 && usedCells.length === 2 && usedCells[0].startsWith('GPU · DirectML') && usedCells[1].startsWith('CPU'),
        `${engineRows.join(' | ')} · used: ${usedCells.join(', ')}`);
      // About: version, Check for updates (real GitHub check), links.
      document.querySelector('.settings-tabs button[data-tab="about"]').click();
      await wait(400);
      const aboutVersion = document.querySelector('.about-version')?.textContent;
      document.querySelector('.about-check').click();
      for (let i = 0; i < 100 && /Checking/.test(document.querySelector('.about-status').textContent); i++) await wait(100);
      const aboutStatus = document.querySelector('.about-status').textContent;
      const links = document.querySelectorAll('.about-links .dbtn').length;
      await window.rb.smokeShot('about');
      step('preferences: About tab with Check for updates', aboutVersion === `Version ${await window.rb.version()}` && /latest version|Up to date|is available|Could not reach/.test(aboutStatus) && links === 5,
        `${aboutVersion} · ${aboutStatus} · ${links} links`);
      // Licence: a fresh trial (pill + About), a wrong key is refused by the licence server.
      const licText = document.querySelector('.license-status')?.textContent ?? '';
      document.querySelector('.license-key').value = 'REBOXED-SMOKE-NOT-A-KEY';
      document.querySelector('.license-form .dbtn.primary').click();
      for (let i = 0; i < 100 && !document.querySelector('.license-error')?.textContent; i++) await wait(100);
      const licErr = document.querySelector('.license-error')?.textContent ?? '';
      // The dialog shown once the trial is over (with a pretend status), then removed.
      openLicenseGate(app, { mode: 'expired', reason: 'trial', product: { price: '5 €', buyUrl: null, donateUrl: 'https://example.org/coffee' } });
      await wait(200);
      await window.rb.smokeShot('license-gate');
      const gate = document.querySelector('.license-gate');
      const gateOk = !!gate && /trial is over/.test(gate.textContent) && !!gate.querySelector('.license-key') && /coffee/i.test(gate.textContent);
      gate?.remove();
      step('licence: activation dialog after the trial (with Buy me a coffee)', gateOk, gate?.querySelector('h2')?.textContent ?? 'none');
      // End of the beta for a tester: thank-you title and the discount.
      openLicenseGate(app, { mode: 'expired', reason: 'betaOver', betaTester: true, product: { price: '5 €', buyUrl: null, betaDiscount: '-50 % with the code BETA50' } });
      await wait(100);
      const over = document.querySelector('.license-gate');
      const overOk = !!over && /Thank you for the beta/.test(over.textContent) && /BETA50/.test(over.querySelector('.license-discount')?.textContent ?? '');
      over?.remove();
      step('licence: end of the beta shows the tester discount', overOk, over?.querySelector('.license-discount')?.textContent ?? 'none');
      // Joining the beta: the free beta key dialog, with the beta checkout link.
      openLicenseGate(app, { mode: 'expired', reason: 'betaKey', product: { price: '5 €', betaEndsAt: '2026-12-30', betaUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/beta' } });
      await wait(100);
      const join = document.querySelector('.license-gate');
      const joinOk = !!join && /Join the open beta/.test(join.textContent) && /Get my free beta key/.test(join.textContent) && /30 December 2026/.test(join.textContent);
      join?.remove();
      step('licence: join the open beta with a free beta key', joinOk, join?.querySelector('h2')?.textContent ?? 'none');
      // During the open beta a fresh install is in beta; afterwards, in its 14-day trial.
      const lic = await window.rb.license.status();
      const fresh = lic.mode === 'beta' ? /Open beta: free until/.test(licText) && /^Beta · \d+ days?$/.test(app.trialPill.textContent)
        : lic.mode === 'trial' && /14 days left/.test(licText) && app.trialPill.textContent === 'Trial · 14 days';
      step('licence: open beta or trial, wrong key refused', fresh && !app.trialPill.hidden && !!licErr,
        `${lic.mode} · ${licText} · pill "${app.trialPill.textContent}" · ${licErr}`);
      document.querySelector('.settings-close').click();
      await closed;
      step('preferences tabs', tabs.length === 11 && tabs.at(-1) === 'About' && active === 'Downloads' && quality && libPath === info.databaseDir && info.databaseDir === dir,
        `${tabs.join(' | ')} — active ${active}, library ${libPath}, stems ${info.stemsRoot}`);
      step('plugins manager', cards.length >= 5 && cards.includes('Pioneer DDJ-GRV6') && live === [...app.midi.controllers.values()].filter((d) => d.plugin?.id).length, `${cards.join(', ')} — connected ${live}`);
    }

    // ---- Appearance: themes change the colour variables, accent, icons-only top bar ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const before = bg();
      const closed = app.openSettings('appearance');
      await wait(300);
      const cards = document.querySelectorAll('.theme-card').length;
      document.querySelector('.theme-card[data-theme="midnight"]').click();
      await wait(200);
      const midnight = bg();
      const panelBg = getComputedStyle(document.querySelector('.gbtn')).backgroundColor;
      await window.rb.smokeShot('theme-midnight');
      document.querySelector('.accent-dot[data-accent="#ff4f8b"]').click();
      await wait(100);
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      document.querySelector('.settings-close').click();
      await closed;
      app.library.setSetting('topbarLabels', 'icons');
      (await import('./themes.js')).applyTheme(app.library.settings);
      await wait(100);
      const labelHidden = getComputedStyle(document.querySelector('.gbtn > span:not(.ico)')).display === 'none' && getComputedStyle(document.querySelector('.gbtn > .ico')).display !== 'none';
      await window.rb.smokeShot('theme-icons');
      const groups = [...document.querySelectorAll('.gbar .ggroup')].map((g) => g.title);
      for (const [k, v] of [['theme', 'dark'], ['themeAccent', null], ['topbarLabels', 'full']]) app.library.setSetting(k, v);
      (await import('./themes.js')).applyTheme(app.library.settings);
      step('appearance: themes, accent, top bar', cards >= 8 && before === '#0e0e0f' && midnight === '#0b1020' && accent === '#ff4f8b' && labelHidden
        && groups.join() === 'Panels,Mixing helpers,Tools' && bg() === '#0e0e0f', `${cards} themes · bg ${before} → ${midnight} · accent ${accent} · gbtn ${panelBg} · groups ${groups}`);
    }

    // ---- Keyboard: rebind a key in Preferences, then use it; AZERTY preset; pinned close button ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const closed = app.openSettings('keyboard');
      await wait(400);
      const pinned = !!document.querySelector('.settings-close') && getComputedStyle(document.querySelector('.dialog:has(.settings) .dialog-buttons')).display === 'none';
      const rows = document.querySelectorAll('.keymap .key-bind').length;
      document.querySelector('.key-bind[data-key="deck1.play"]').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true }));
      await wait(100);
      const bound = lib.settings.keymap?.['deck1.play'];
      const stolen = lib.settings.keymap?.['deck2.memSet']; // Shift+KeyP stays: only KeyP was taken
      await window.rb.smokeShot('keyboard');
      [...document.querySelectorAll('.settings-content .dbtn')].find((b) => /AZERTY/.test(b.textContent)).click();
      await wait(100);
      const azertyPlay = lib.settings.keymap?.['deck1.play'];
      document.querySelector('.key-bind[data-key="deck1.play"]').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true }));
      await wait(100);
      document.querySelector('.settings-close').click();
      await closed;
      const k1 = app.engine.decks[0];
      if (!k1.loaded) await app.loadTrack(0, lib.all()[0].id);
      const before = k1.playing;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', key: 'p', bubbles: true }));
      await wait(150);
      const toggled = k1.playing !== before;
      if (k1.playing) k1.pause();
      lib.setSetting('keymap', null);
      step('keyboard: rebind, AZERTY preset, pinned close', pinned && rows > 50 && bound === 'KeyP' && stolen === 'Shift+KeyP' && azertyPlay === 'KeyW' && toggled,
        `pinned ${pinned} · ${rows} keys · play → ${bound} · AZERTY play ${azertyPlay} · P toggles ${toggled}`);
    }

    // ---- Sampler: an empty slot takes the playing loop; save / edit / eject on loaded slots ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const k1 = app.engine.decks[0];
      if (!k1.loaded) await app.loadTrack(0, lib.all()[0].id);
      app.sampler.stopAll();
      for (let i = 0; i < 16; i++) app.sampler.clear(i);
      if (app.samplerView.el.hidden) app.toggleSampler();
      k1.seek(4); k1.beatLoop(2);
      app.samplerView.tiles[5].tile.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      for (let i = 0; i < 50 && !app.sampler.slots[5].buffer; i++) await wait(100);
      const got = app.sampler.slots[5];
      const len = got.buffer?.duration ?? 0;
      const actions = app.samplerView.tiles[5].tile.querySelectorAll('.smp-act').length;
      await window.rb.smokeShot('sampler-capture');
      const editing = app.editSample(5);
      await wait(300);
      const editor = !!document.querySelector('.sample-editor canvas');
      document.querySelector('.dialog:has(.sample-editor) .dialog-buttons button').click();
      await editing;
      app.samplerView.tiles[5].tile.querySelector('.smp-act[title="Eject"]').click();
      const ejected = !app.sampler.slots[5].buffer;
      k1.exitLoop();
      app.toggleSampler();
      step('sampler: click an empty slot captures the loop; edit, eject', Math.abs(len - k1.period * 2) < 0.02 && actions === 3 && editor && ejected,
        `slot 6: ${len.toFixed(3)} s (2 beats = ${(k1.period * 2).toFixed(3)} s) · ${actions} buttons · editor ${editor} · ejected ${ejected}`);
      // No loop set: the click still captures, a loop of the chosen size (4 beats) from the closest beat.
      k1.seek(6); k1.setBeatLoopSize(4); k1.play();
      await wait(300);
      app.samplerPress(6);
      for (let i = 0; i < 50 && !app.sampler.slots[6].buffer; i++) await wait(100);
      const noLoop = app.sampler.slots[6].buffer?.duration ?? 0;
      k1.pause();
      app.sampler.clear(6);
      step('sampler: capture without a loop takes the chosen loop size', Math.abs(noLoop - k1.period * 4) < 0.02 && !k1.loop,
        `${noLoop.toFixed(3)} s (4 beats = ${(k1.period * 4).toFixed(3)} s), deck loop untouched: ${!k1.loop}`);
    }

    // ---- Pad pages (dropdown like rekordbox), page bar, KEY panel, BEAT SYNC / KEY SYNC ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const v = app.deckViews[0];
      const k1 = app.engine.decks[0];
      v.modeBtn.click();
      const items = [...document.querySelectorAll('.menu.root > li')].map((li) => li.textContent.replace('✓', '').trim());
      const seq = [...document.querySelectorAll('.menu.root > li')].find((li) => li.textContent.includes('SEQ CALL'));
      [...document.querySelectorAll('.menu.root > li')].find((li) => li.textContent.trim().endsWith('MEMORY CUE')).click();
      const memPage = v.padMode === 'MEMORY CUE' && !!v.pageBar.querySelector('button[title^="Add a memory cue"]');
      k1.addMemoryCue();
      v.setPadMode('PAD FX');
      v.padDown(0, {});
      const fxOn = app.padFx[0].held === 0 && v.pads[0].classList.contains('active');
      v.padUp(0);
      const fxOff = app.padFx[0].held === null;
      v.setPadMode('HOT CUE');
      k1.setKeyShift(0);
      v.keyBox.click();
      document.querySelector('.key-pop button[title="One semitone up"]').click();
      const shifted = k1.keyShift === 1 && document.querySelector('.key-pop-val')?.textContent === '+1';
      const shiftInfo = `${k1.keyShift} / ${document.querySelector('.key-pop-val')?.textContent}`;
      await wait(400); // let the hidden smoke window repaint before the screenshot
      await window.rb.smokeShot('pad-pages');
      v.keyBox.click();
      k1.setKeyShift(0);
      const head = [...v.el.querySelectorAll('.deck-headbtns .dbtn')].map((b) => b.textContent).filter(Boolean).join(','); // + icon buttons (menu, eject)
      step('pad pages, page bar, KEY panel', items.length === 12 && seq?.classList.contains('disabled') && memPage && fxOn && fxOff && shifted && !document.querySelector('.key-pop') && head === 'MASTER,BEAT SYNC,KEY SYNC',
        `${items.length} pages (SEQ CALL disabled ${seq?.classList.contains('disabled')}) · MEMORY CUE page ${memPage} · PAD FX hold ${fxOn}/${fxOff} · KEY +1 ${shifted} (${shiftInfo}) · header ${head}`);
      await wait(50);
    }

    // ---- Updates: real check against GitHub (network test only) ----
    if (await window.rb.smokeDlTest()) {
      const { checkForUpdates } = await import('./ui/updates.js');
      const info = await checkForUpdates(app, { silent: true });
      step('updates: GitHub release check', !!info?.latest && typeof info.newer === 'boolean' && app.updatePill.hidden === !info.newer, `current ${info?.current} · latest ${info?.latest} · newer ${info?.newer}`);
    }

    // ---- Export to a USB drive for CDJ / XDJ (a folder stands for the drive) ----
    {
      const root = `${dir}\\cdj-usb`;
      const t128 = lib.all().find((t) => t.title === 'Kick 128');
      lib.update(t128.id, { cues: [...(t128.cues ?? []).filter((c) => c.kind !== 'hot'), { kind: 'hot', slot: 0, start: 1, color: '#ff8c00', name: 'Drop' }, { kind: 'memory', start: 2 }] });
      const tracks = lib.all().map((t) => ({ ...t, features: undefined }));
      const r = await window.rb.cdj.export({ root, tracks, playlists: [{ type: 'folder', name: 'Sets', children: [{ type: 'playlist', name: 'Smoke set', trackIds: tracks.map((t) => t.id) }] }], settings: (await import('../shared/cdj/mysettings.js')).defaultSettings() });
      const files = await Promise.all(['PIONEER\\rekordbox\\export.pdb', 'PIONEER\\MYSETTING.DAT', 'PIONEER\\DEVSETTING.DAT'].map((f) => window.rb.exists(`${root}\\${f}`)));
      step('cdj export', r.tracks > 0 && r.tracks + r.missing.length === tracks.length && r.playlists >= 1 && files.every(Boolean), `${JSON.stringify({ ...r, missing: r.missing.length })} files=${files}`);
    }

    // ---- Download centre: Search with a platform choice, Link with platform detection ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const dlc = app.downloads;
      dlc.save({ platform: 'youtube' });
      dlc.open('search');
      await wait(200);
      const tabs = [...document.querySelectorAll('.dlc-tabs button')].map((x) => x.textContent.replace(/ \(.*/, ''));
      document.querySelector('.dlc-platform [data-platform="soundcloud"]').click();
      await wait(150);
      const scPlaceholder = document.querySelector('.dlc-bar input.text')?.placeholder ?? '';
      const remembered = dlc.cfg.platform;
      await window.rb.smokeShot('dl-search');
      dlc.showTab('link');
      await wait(100);
      const input = document.querySelector('.dlc-bar input.text');
      const badgeFor = (url) => { input.value = url; input.dispatchEvent(new Event('input')); return [document.querySelector('.dlc-badge').textContent, document.querySelector('.dlc-bar .dlc-primary').disabled]; };
      const yt = badgeFor('https://youtu.be/jNQXAC9IVRw');
      const other = badgeFor('https://example.com/song.mp3');
      const sc = badgeFor('https://soundcloud.com/indochineofficiel/3-nuits-par-semaine');
      await window.rb.smokeShot('dl-link');
      step('download centre: search platforms + link detection',
        tabs.join('|') === 'Search|Link|Spotify playlist|New releases|Queue' && /SoundCloud/.test(scPlaceholder) && remembered === 'soundcloud'
          && yt[0] === 'YouTube link' && !yt[1] && other[1] && /Not a YouTube/.test(other[0]) && sc[0] === 'SoundCloud link' && !sc[1],
        `tabs ${tabs.join('|')} · ${scPlaceholder} · yt ${yt} · other ${other} · sc ${sc}`);
      const tools = await dlc.tools();
      if (tools.ytdlp && (await window.rb.smokeDlTest())) {
        const found = await window.rb.dl.search('indochine trois nuits par semaine', 5, 'soundcloud');
        const link = await window.rb.dl.resolve('https://soundcloud.com/indochineofficiel/3-nuits-par-semaine');
        step('download centre: real SoundCloud search + link', found.length > 0 && found.every((x) => x.platform === 'soundcloud' && x.id.startsWith('sc:') && /soundcloud\.com/.test(x.url))
          && link.length === 1 && link[0].platform === 'soundcloud', `${found.map((x) => `${x.title} (${x.channel}${x.preview ? ', preview' : ''})`).join(' · ')} · link ${link[0]?.title}`);
      }
      dlc.save({ platform: 'youtube' });
      document.querySelector('.dlc-x')?.click();
    }

    // ---- Link the collection to a USB-like music folder, stems move along ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const usb = `${dir}\\usb\\Tracks`;
      const copy = async (title, name) => {
        const t = lib.all().find((x) => x.title === title);
        const buf = await (await fetch(mediaUrl(t.path))).arrayBuffer();
        await window.rb.writeFile(`${usb}\\${name}`, new Uint8Array(buf));
        return t;
      };
      const k128 = await copy('Kick 128', 'Kick 128.wav');
      await copy('Kick 100', 'Kick 100.wav');
      await copy('Kick 100', 'Only On The Key.wav');
      // A homonym under another name and folder (track number, mix name): found and confirmed by duration.
      const structure = await copy('Structure', 'Hip\\01 - Structure (Original Mix).wav');
      const kick140 = lib.all().find((x) => /^Kick 140/.test(x.title)); // not on the drive: copied there
      const before = await window.rb.stems.meta(k128.id, k128.path);
      const done = openRelink(app, usb);
      for (let k = 0; k < 100 && !document.querySelector('.mig-row'); k++) await wait(100);
      const rows = document.querySelectorAll('.mig-row').length;
      await window.rb.smokeShot('relink');
      document.querySelector('.rbi-dialog .dialog-buttons button.primary')?.click();
      for (let k = 0; k < 150 && !document.querySelector('.rbi-report'); k++) await wait(100);
      document.querySelector('.rbi-dialog .dialog-buttons button.primary')?.click();
      const rep = await done;
      const moved = lib.get(k128.id);
      const after = await window.rb.stems.meta(k128.id, moved.path);
      const info = await window.rb.storage.info();
      const added = lib.all().some((x) => x.path.endsWith('Only On The Key.wav'));
      const homonym = lib.get(structure.id).path.toLowerCase() === `${usb}\\Hip\\01 - Structure (Original Mix).wav`.toLowerCase();
      const copied = lib.get(kick140.id).path.toLowerCase().startsWith(`${usb}\\From computer\\`.toLowerCase());
      const missing = lib.all().filter((x) => x.missing).length;
      step('move the collection to a USB folder', rep?.linked >= 3 && rows > 0 && moved.path.toLowerCase() === `${usb}\\Kick 128.wav`.toLowerCase()
        && (!before || after?.dir.toLowerCase() === `${usb}\\stems\\Kick 128`.toLowerCase()) && info.stemsRoot === `${usb}\\stems` && added
        && homonym && copied && rep.remaining <= missing,
        `report=${JSON.stringify(rep)} homonym=${homonym} copied=${copied} (missing files ${missing}), stems ${before?.dir} -> ${after?.dir}`);
    }

    // ---- Browser: resizable columns (fit to content) and the detailed track information ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = app.browser;
      b.select('collection');
      const t = lib.all().find((x) => x.title === 'Kick 140 (rb)') ?? lib.all()[0];
      lib.update(t.id, { title: 'A very long track title that does not fit the default column width at all (Extended Club Mix)' });
      b.refreshRows();
      await wait(200);
      const grips = document.querySelectorAll('.thead .col-grip').length;
      const before = b.colWidth('title');
      b.autoFit('title');
      await wait(100);
      const after = b.colWidth('title');
      const cell = [...document.querySelectorAll('.td.c-title')].find((x) => x.textContent.includes('very long track'));
      const shown = cell ? cell.scrollWidth <= cell.clientWidth + 1 : false;
      await window.rb.smokeShot('columns');
      b.lib.setSetting('columnWidths', {}); b.applyWidths();
      step('browser columns: resize to fit', grips === b.columns.length && after > before && shown && lib.settings.columnWidths.title === undefined,
        `grips=${grips} title ${before}px -> ${after}px, full title visible=${shown}`);
      // Columns move by drag and drop of their header: BPM dropped on the left half of TITLE.
      {
        const orderBefore = lib.settings.columns.slice();
        const target = document.querySelector('.thead .th.c-title');
        const dt = new DataTransfer();
        dt.setData('application/x-rb-column', 'bpm');
        const r = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 5, bubbles: true, cancelable: true }));
        await wait(100);
        const moved = lib.settings.columns;
        const headOrder = [...document.querySelectorAll('.thead .th')].map((x) => x.className.match(/c-(\w+)/)?.[1]);
        const ok = moved.indexOf('bpm') === moved.indexOf('title') - 1 && headOrder.indexOf('bpm') === headOrder.indexOf('title') - 1;
        lib.setSetting('columns', orderBefore);
        step('browser columns: drag a header to move the column', ok, `${orderBefore.join(',')} → ${moved.join(',')}`);
      }

      const closed = b.editTrack(t.id);
      await wait(300);
      const sections = [...document.querySelectorAll('.trackinfo h4')].map((x) => x.textContent);
      const fields = document.querySelectorAll('.trackinfo input, .trackinfo select, .trackinfo textarea').length;
      const title = document.querySelector('.trackinfo .ti-field input');
      title.value = 'Kick 140 (edited)';
      document.querySelectorAll('.trackinfo .ti-star')[3].click();
      const keySel = [...document.querySelectorAll('.trackinfo select')].find((x) => [...x.options].some((o) => o.value === '5A'));
      keySel.value = '5A';
      const tagInput = [...document.querySelectorAll('.trackinfo input')].find((x) => /warm-up/.test(x.placeholder));
      tagInput.value = 'peak, vocal';
      await window.rb.smokeShot('trackinfo');
      document.querySelector('.dialog:has(.trackinfo) .dialog-buttons button.primary').click();
      await closed;
      const e = lib.get(t.id);
      step('track information: detailed and editable', sections.length === 4 && fields >= 20 && e.title === 'Kick 140 (edited)' && e.rating === 4 && e.key === '5A' && e.myTags.join() === 'peak,vocal',
        `${sections.join(' | ')} · ${fields} fields · saved: ${e.title}, ${e.rating}★, ${e.key}, [${e.myTags}]`);

      // Search online (offline: canned answer like the merged Spotify + Deezer one): Genre ticked by
      // default, only ticked fields change.
      const { lookupApi } = await import('./ui/track-lookup.js');
      const realLookup = lookupApi.lookup;
      lookupApi.lookup = async () => ({ sources: ['Spotify', 'Deezer'], errors: [], candidates: [
        { source: 'spotify', completedFrom: 'deezer', title: 'Kick 140', mixName: 'Extended Mix', artist: 'Smoke Artist', album: 'Smoke EP', albumArtist: 'Smoke Artist',
          genre: 'Melodic Techno', genres: ['Melodic Techno', 'Hard Techno'], year: 2024, trackNumber: 2, discNumber: 1, label: '', duration: e.duration, artworkUrl: '', thumbUrl: '', url: '' },
        { source: 'deezer', title: 'Kick 140', mixName: '', artist: 'Smoke Artist', album: 'Smoke EP', albumArtist: 'Smoke Artist',
          genre: 'Dance', genres: ['Dance'], year: 2024, trackNumber: 2, discNumber: 1, label: 'Smoke Records', duration: 300, artworkUrl: '', thumbUrl: '', url: '' }] });
      const closed2 = b.editTrack(t.id);
      await wait(300);
      document.querySelector('.trackinfo .ti-sp-open').click();
      await wait(200);
      const ticked = [...document.querySelectorAll('.ti-sp-row')].filter((r) => r.querySelector('input').checked).map((r) => r.querySelector('.ti-sp-k').textContent);
      const options = [...document.querySelectorAll('.ti-sp-status select option')].map((o) => o.textContent.slice(0, 9));
      let askedSource = null;
      const canned = lookupApi.lookup;
      lookupApi.lookup = async (q, src) => { askedSource = src; return canned(q, src); };
      document.querySelector('.ti-sp-source [data-source="spotify"]').click();
      await wait(150);
      const spotifyAsked = askedSource;
      document.querySelector('.ti-sp-source [data-source="deezer"]').click();
      await wait(150);
      const deezerAsked = askedSource;
      await window.rb.smokeShot('lookup');
      document.querySelector('.ti-spotify .dlc-primary').click();
      await wait(100);
      document.querySelector('.dialog:has(.trackinfo) .dialog-buttons button.primary').click();
      await closed2;
      lookupApi.lookup = realLookup;
      const s2 = lib.get(t.id);
      step('track information: Search online fills the ticked fields', ticked.join() === 'Genre' && s2.genre === 'Melodic Techno' && s2.title === 'Kick 140 (edited)' && s2.album !== 'Smoke EP'
        && options.join() === '[Spotify],[Deezer] ' && spotifyAsked === 'spotify' && deezerAsked === 'deezer',
        `ticked [${ticked}] · genre ${s2.genre} · title ${s2.title} · album ${s2.album} · options ${options} · source ${spotifyAsked}/${deezerAsked}`);
      if (await window.rb.smokeDlTest()) {
        const r = await window.rb.metadata.lookup({ title: 'Trois nuits par semaine', artist: 'Indochine' }, 'deezer');
        const dz = r.candidates.find((c) => c.source === 'deezer');
        step('track information: real Deezer lookup has genres', r.sources.includes('Deezer') && !!dz?.genre && dz.year > 0, `${dz?.artist} — ${dz?.title} · ${dz?.album} ${dz?.year} · ${dz?.genres} · ${dz?.label} · errors ${r.errors}`);
      }

      // Auto-tag (offline: canned Spotify / Deezer): recipe -> review -> apply -> undo.
      {
        const { autotagApi, openAutoTag, undoAutoTag } = await import('./ui/autotag.js');
        const real = { ...autotagApi };
        const asked = [];
        autotagApi.pause = 0;
        autotagApi.lookup = async (q, source) => {
          asked.push(`${source}:${q.artist}|${q.title}`);
          if (source === 'spotify') return { candidates: [{ title: 'Kick 128', mixName: 'Original Mix', artist: 'Smoke DJ', duration: lib.all().find((x) => x.title === 'Kick 128')?.duration ?? 24 }] };
          return { candidates: q.artist === 'Smoke DJ' ? [{ title: 'Kick 128', mixName: 'Original Mix', artist: 'Smoke DJ', genre: 'Techno', duration: 24 }] : [] };
        };
        const k128 = lib.all().find((x) => x.title === 'Kick 128');
        const before = { title: k128.title, artist: k128.artist ?? '', genre: k128.genre ?? '' };
        lib.update(k128.id, { genre: '' });
        const done = openAutoTag(app, [k128.id]);
        await wait(200);
        const stepsShown = document.querySelectorAll('.at-step').length;
        document.querySelector('.autotag-dialog .dialog-buttons .primary').click();
        for (let i = 0; i < 50 && !document.querySelector('.at-change'); i++) await wait(50);
        const changes = [...document.querySelectorAll('.at-change')].map((x) => `${x.querySelector('.at-k').textContent}=${x.querySelector('.at-to')?.textContent}`);
        await window.rb.smokeShot('autotag');
        document.querySelector('.autotag-dialog .dialog-buttons .primary').click();
        for (let i = 0; i < 50 && !/done/.test(document.querySelector('.autotag-dialog h2')?.textContent ?? ''); i++) await wait(50);
        const after = lib.get(k128.id);
        const applied = { title: after.title, artist: after.artist, genre: after.genre };
        document.querySelector('.autotag-dialog .dialog-buttons .primary').click();
        await done;
        undoAutoTag(app);
        const undone = lib.get(k128.id);
        Object.assign(autotagApi, real);
        step('auto-tag: Spotify title + artist, then the genre with them; review, apply, undo',
          stepsShown === 2 && changes.join() === 'Title=Kick 128 (Original Mix),Artist=Smoke DJ,Genre=Techno' && asked.join() === `spotify:${before.artist}|Kick 128,genre:Smoke DJ|Kick 128 (Original Mix)`
            && applied.title === 'Kick 128 (Original Mix)' && applied.artist === 'Smoke DJ' && applied.genre === 'Techno'
            && undone.title === 'Kick 128' && (undone.artist ?? '') === before.artist && (undone.genre ?? '') === '',
          `${stepsShown} steps · ${changes} · asked ${asked} · applied ${JSON.stringify(applied)} · undo → ${undone.title}/${undone.artist}/${undone.genre}`);
        lib.update(k128.id, { genre: before.genre });
        if (await window.rb.smokeDlTest()) {
          const { runRecipe } = await import('../shared/autotag.js');
          const [r] = await runRecipe([{ id: 'x', title: 'INDOCHINE - Trois nuits par semaine (clip officiel)', artist: '', duration: 312 }],
            { tolerance: 4, steps: [{ source: 'deezer', fields: ['title', 'artist', 'genre', 'year'], titleWithMix: true }] }, window.rb.metadata.lookup);
          step('auto-tag: real Deezer recipe', r.steps[0].changes.map((c) => `${c.field}=${c.to}`).join() === 'title=Trois nuits par semaine,artist=Indochine,genre=Disco,year=1985',
            r.steps[0].changes.map((c) => `${c.field}=${c.to}`).join() || r.steps[0].error);
        }
      }

      // Name cleaner: a download named like a video is cleaned when it joins the collection, and
      // "Clean names" fixes tracks already there.
      {
        const src = lib.all().find((x) => x.title === 'Kick 100');
        const wav = await (await fetch(mediaUrl(src.path))).arrayBuffer();
        const dirty = `${dir}\\downloads\\Indochine - Trois nuits par semaine (Clip officiel) [Paroles].wav`;
        await window.rb.writeFile(dirty, new Uint8Array(wav));
        await app.downloads.finished({ id: 'smoke-clean', title: 'Indochine - Trois nuits par semaine (Clip officiel) [Paroles]' }, dirty);
        const added = lib.get(lib.idForPath(dirty));
        const other = lib.all().find((x) => x.title === 'Kick 140 (edited)');
        lib.update(other.id, { title: 'Kick 140 (Official Visualizer) | Lyrics', artist: 'Smoke DJ - Topic' });
        const { openCleanNames } = await import('./ui/clean-names.js');
        const closedClean = openCleanNames(app, [other.id, added.id]);
        await wait(150);
        const proposals = document.querySelectorAll('.at-clean').length;
        await window.rb.smokeShot('clean-names');
        document.querySelector('.autotag-dialog .dialog-buttons .primary').click();
        await closedClean;
        const fixed = lib.get(other.id);
        step('name cleaner: downloads cleaned on arrival, Clean names on the collection',
          added?.title === 'Trois nuits par semaine' && added?.artist === 'Indochine' && proposals === 1 && fixed.title === 'Kick 140' && fixed.artist === 'Smoke DJ',
          `download → ${added?.artist} / ${added?.title} · ${proposals} proposal(s) · collection → ${fixed.artist} / ${fixed.title}`);
        lib.update(other.id, { title: 'Kick 140 (edited)', artist: '' });
      }

      // Date Added shows the time for tracks added now.
      b.select('collection');
      await wait(200);
      const dates = [...document.querySelectorAll('.td.c-dateAdded')].map((x) => x.textContent);
      step('date added with time', dates.some((x) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(x)), dates.slice(0, 4).join(' | '));
    }

    // ---- Playlist tree: drag a playlist into a folder, then back to the top level ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const folder = lib.createNode('folder', 'Club sets');
      const pl = lib.createNode('playlist', 'Peak time');
      await wait(100);
      const row = (id) => document.querySelector(`.tree-item[data-id="${id}"]`);
      const drag = (from, to, where) => {
        const dt = new DataTransfer();
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const r = to.getBoundingClientRect();
        const y = r.top + r.height * (where === 'before' ? 0.1 : where === 'after' ? 0.9 : 0.5);
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        const mark = to.className;
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
        return mark;
      };
      const mark = drag(row(pl.id), row(folder.id), 'inside');
      await wait(100);
      const inside = lib.findNode(pl.id)?.parent?.id === folder.id;
      await window.rb.smokeShot('tree');
      drag(row(folder.id), row(pl.id), 'inside');   // a folder into its own child: refused
      const refused = lib.findNode(folder.id)?.parent === null;
      drag(row(pl.id), document.querySelector('.tree-section[title^="Drop"]'), 'inside');
      await wait(100);
      const top = lib.findNode(pl.id)?.parent === null && lib.playlists.at(-1).id === pl.id;
      step('playlist tree: drag into a folder and back', inside && /drop-into/.test(mark) && refused && top, `inside=${inside} (${mark}) refused=${refused} top=${top}`);
      lib.deleteNode(folder.id); lib.deleteNode(pl.id);
    }

    // ---- Histories can be cleaned: entries, one day, or all; full screen setting ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = app.browser;
      const ids = lib.all().slice(0, 3).map((t) => t.id);
      lib.histories.push({ id: 'history-2026-01-01', date: '2026-01-01', trackIds: [...ids] });
      lib.emit('history', {});
      b.select('history-2026-01-01');
      await wait(100);
      b.selected = new Set([b.rows[0].key]);
      await b.removeSelected();
      const afterRemove = lib.histories.find((x) => x.id === 'history-2026-01-01')?.trackIds.length;
      const okDialog = async (fn) => { const p = fn(); await wait(150); document.querySelector('.dialog-buttons button.primary')?.click(); await p; };
      await okDialog(() => b.deleteHistory(lib.histories.find((x) => x.id === 'history-2026-01-01')));
      const deleted = !lib.histories.some((x) => x.id === 'history-2026-01-01') && b.source === 'collection';
      lib.histories.push({ id: 'history-2026-01-02', date: '2026-01-02', trackIds: [ids[0]] }, { id: 'history-2026-01-03', date: '2026-01-03', trackIds: [ids[1]] });
      lib.emit('history', {});
      await wait(100);
      const before = lib.histories.length;
      await okDialog(() => b.clearHistories());
      await wait(100);
      const trashBtn = !!document.querySelector('.tree-section button[title="Delete all histories"]');
      step('histories: remove entries, delete a day, delete all', afterRemove === 2 && deleted && before >= 2 && lib.histories.length === 0 && !trashBtn && lib.all().length >= ids.length,
        `entries 3 -> ${afterRemove}, day deleted=${deleted}, all ${before} -> ${lib.histories.length}`);
      const fs = await window.rb.fullscreen();
      await window.rb.setFullscreen({ startMode: 'fullscreen' });
      const full = await window.rb.fullscreen();
      await window.rb.setFullscreen({ startMode: 'maximized' });
      step('window at start: maximised by default (setting)', fs.startMode === 'maximized' && fs.now === false && full.startMode === 'fullscreen',
        `default ${fs.startMode}, smoke window full screen=${fs.now}, after change ${full.startMode}`);
    }

    // ---- 1.18: Stems list, Preview column, played tracks, phrases by hand, transfer, setup, second output ----
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = app.browser;
      const kicks = lib.all().filter((t) => /^Kick (100|128|140)/.test(t.title) && t.analyzed);
      b.select('stems'); await wait(50);
      const stemRows = b.rows.length; const withStems = lib.all().filter((t) => t.stems).length;
      if (!lib.settings.columns.includes('preview')) lib.setSetting('columns', [...lib.settings.columns, 'preview']);
      b.select('collection'); await wait(150);
      const showRow = async (id) => { b.scroller.scrollTop = Math.max(0, b.rows.findIndex((r) => r.track.id === id) * 24 - 24); b.renderBody(); await wait(50); };
      await showRow(kicks[0].id);
      const previews = b.body.querySelectorAll('img.wave-preview').length;
      step('Stems list and waveform Preview column', stemRows === withStems && kicks.length > 0 && kicks.every((t) => t.wavePreview?.length > 100) && previews > 0,
        `stems ${stemRows}/${withStems} · previews ${kicks.filter((t) => t.wavePreview).length}/${kicks.length} tracks, ${previews} on screen`);

      lib.addToHistory(kicks[0].id); await wait(100);
      await showRow(kicks[0].id);
      const row =[...b.body.querySelectorAll('.tr')].find((r) => b.rows[Number(r.dataset.i)]?.track.id === kicks[0].id);
      step('a track played today is marked in the browser', lib.playedToday().has(kicks[0].id) && !!row?.classList.contains('played') && !!row.querySelector('.played-mark'),
        `played ${lib.playedToday().size} · row ${row?.className}`);

      const ph = [{ start: 0, end: 8, startBar: 0, bars: 4, label: 'INTRO', num: 1 }, { start: 8, end: 16, startBar: 4, bars: 4, label: 'CHORUS', num: 1 }];
      const before = d1.analysis?.phrases?.phrases ?? [];
      await app.setPhrases(d1, ph);
      await app.setPhrases(d1, relabelPhrase(d1.analysis.phrases.phrases, 0, 'DOWN'));
      const stored = await window.rb.getAnalysis(d1.track.id);
      const edited = stored?.phrases?.edited && stored.phrases.phrases[0].label === 'DOWN' && d1.analysis.phrases.phrases[0].label === 'DOWN';
      await app.resetPhrases(d1);
      step('phrases changed by hand are saved, and can be reset', !!edited && !d1.analysis.phrases.edited && d1.analysis.phrases.phrases.length === before.length,
        `edited ${edited} · after reset ${d1.analysis.phrases.phrases.length} phrase(s) (${before.length} before)`);

      // Send two tracks to "a USB drive", then import them as the other computer would.
      const { openTransferExport, openTransferImport } = await import('./ui/transfer.js');
      lib.update(kicks[0].id, { myTags: ['peak', 'smoke'] });
      const send = lib.createNode('playlist', 'To the other PC');
      lib.addToPlaylist(send.id, kicks.slice(0, 2).map((t) => t.id));
      const clickPrimary = async () => { for (let i = 0; i < 40 && !document.querySelector('.transfer'); i++) await wait(25); document.querySelector('.dialog:has(.transfer) .dialog-buttons button.primary').click(); };
      const exp = openTransferExport(app, [send.id], { dir: `${dir}\\usb` });
      await clickPrimary();
      const sent = await exp;
      const imp = openTransferImport(app, { xmlPath: sent?.xmlPath, dest: `${dir}\\other-pc` });
      await clickPrimary();
      const rep = await imp;
      const folder = lib.findNode(rep?.folderId)?.node;
      const got = folder?.children?.[0]?.trackIds.map((id) => lib.get(id)) ?? [];
      // Same computer here: the tracks are already in the collection, so they are updated (moved to
      // the copies) instead of added; on another computer they are added.
      step('send to another Reboxed and import there: music copied, playlist, tags and cues kept',
        sent?.tracks === 2 && rep?.added + rep?.updated === 2 && got.length === 2 && got.every((t) => t.path.startsWith(`${dir}\\other-pc\\`)) && got.some((t) => t.myTags?.join() === 'peak,smoke')
          && got.every((t) => t.beatgrid),
        `sent ${sent?.tracks} · import ${JSON.stringify(rep)} · ${got.map((t) => `${t.title} ${t.path.split('\\').slice(-2).join('\\')} [${t.myTags}]`).join(' | ')}`);
      kicks.slice(0, 2).forEach((t) => lib.relink(t.id, t.path)); // back to the original files
      lib.deleteNode(folder.id); lib.deleteNode(send.id);

      lib.setSetting('setupDone', false);
      const setup = openSetup(app); await wait(200);
      const first = document.querySelector('.setup-dialog h2')?.textContent;
      document.querySelector('.setup-dialog .dialog-buttons button.primary').click(); await wait(300);
      const second = document.querySelector('.setup-dialog h2')?.textContent;
      const hasQuality = !!document.querySelector('.setup-dialog select');
      document.querySelector('.setup-dialog').closest('.overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await setup;
      step('setup assistant: steps, skippable', first === 'Welcome to Reboxed' && second === 'Folders and quality' && hasQuality && lib.settings.setupDone && !document.querySelector('.setup-dialog'),
        `${first} → ${second} · quality select ${hasQuality} · done ${lib.settings.setupDone}`);

      let copyErr = '';
      try { await app.engine.setMasterCopyDevice('default'); await app.engine.setMasterCopyDevice(''); } catch (err) { copyErr = err.message; }
      step('master also on the computer (second output)', !copyErr && !!app.engine.copyEl, copyErr || 'default device, then off');

      // Jog wheels stay round when the height is short (zoomed interface, small screen).
      const jogShape = () => [...document.querySelectorAll('.jog-canvas')].filter((c) => c.offsetParent).map((c) => [c.clientWidth, c.clientHeight]);
      // A short screen (or Windows scaling at 125-150 %) leaves the platter column less height than
      // width: forced here with a short column, in 2 and 4 decks.
      const decksBefore = lib.settings.deckCount;
      const short = []; const normal = [];
      for (const n of [2, 4]) {
        lib.setSetting('deckCount', n); app.applyLayout(); await wait(200);
        const cols = [...document.querySelectorAll('.deck-transport')].filter((c) => c.offsetParent);
        cols.forEach((c) => { c.style.height = n === 2 ? '160px' : '120px'; c.parentElement.style.alignItems = 'start'; });
        await wait(300);
        short.push(...jogShape());
        cols.forEach((c) => { c.style.height = ''; c.parentElement.style.alignItems = ''; });
        await wait(300);
        normal.push(...jogShape());
      }
      lib.setSetting('deckCount', decksBefore); app.applyLayout();
      step('jog wheels stay round (short screen and normal)', [...short, ...normal].length > 0 && [...short, ...normal].every(([w, hh]) => Math.abs(w - hh) <= 1),
        `short: ${short.map((x) => x.join('×')).join(' ')} · normal: ${normal.map((x) => x.join('×')).join(' ')}`);

      // Spotify playlist → YouTube (offline: a canned search), shown in the download window.
      const dc = app.downloads;
      dc.sp = { url: 'https://open.spotify.com/playlist/x', name: 'Smoke list', src: 'spotify:x', via: 'embed', tracks: [
        { title: 'Obsidian', artist: 'Kevin de Vries, Juan Elvadin', duration: 203, status: 'waiting', match: null },
        { title: 'Nowhere', artist: 'Nobody', duration: 100, status: 'waiting', match: null }] };
      await dc.findSpotifyOnYoutube({ download: false, search: async (q) => (/Obsidian/.test(q) ? [{ id: 'yt1', url: 'https://www.youtube.com/watch?v=yt1', title: 'Obsidian', channel: 'Kevin de Vries - Topic', duration: 203 }] : []) });
      dc.open('spotify'); await wait(150);
      const spRows = [...document.querySelectorAll('.dlc-sprow')].map((r) => r.querySelector('.dlc-match').textContent);
      document.querySelector('.dlc-x').click();
      step('Spotify playlist: each track found on YouTube (or not), listed in the download window',
        dc.sp.tracks[0].match?.id === 'yt1' && dc.sp.tracks[1].status === 'none' && spRows.length === 2 && /Obsidian/.test(spRows[0]) && /Not found/.test(spRows[1]),
        spRows.join(' | '));
      dc.sp = null;
      if (await window.rb.smokeDlTest()) {
        const r = await window.rb.spotify.playlist('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa');
        step('Spotify album read without an account', r.tracks.length > 5 && !!r.tracks[0].artist, `${r.name} · ${r.tracks.length} tracks via ${r.via}`);
      }

      const settingsOpen = app.openSettings('general');
      for (let i = 0; i < 60 && !document.querySelector('.settings-content .form-grid'); i++) await wait(50);
      const grid = document.querySelector('.settings-content .form-grid');
      const cells = [...grid.children];
      const uneven = cells.filter((c, i) => i % 2 === 0 && cells[i + 1] && Math.abs(c.getBoundingClientRect().height - cells[i + 1].getBoundingClientRect().height) > 0.5).length;
      document.querySelector('.settings-close').click(); await settingsOpen;
      step('preferences rows: label and value cells as tall (straight lines)', uneven === 0, `${uneven} uneven row(s) of ${cells.length / 2}`);
    }

    if (!d1.hotCue(0)) d1.hotCuePress(0); // automix replaced deck 1's track
    const padA = app.deckViews[0].pads[0];
    step('ui hot cue pad', padA.classList.contains('set'), `${padA.className} cues=${d1.track.cues.length} loop=${!!d1.loop}`);
    step('ui frames', app.frames > 10, `${app.frames} frames`);
    await new Promise((r) => setTimeout(r, 1000));
    step('ui hot cue pad (1 s later)', padA.classList.contains('set'), `${padA.className} cues=${JSON.stringify(d1.track.cues)} playing=${d1.playing} bank=${app.deckViews[0].bank} mode=${app.deckViews[0].padMode}`);
    report.ok = true;
    // Back to the default 2-deck layout for the --shot screenshot.
    lib.setSetting('deckCount', 2); app.applyLayout();
    app.browser.select('collection');
    await new Promise((r) => setTimeout(r, 600));
  } catch (err) {
    report.error = String(err?.stack ?? err);
  }
  window.rb.smokeReady(report);
}

const app = new App();
window.rbApp = app;
app.init().then(() => {
  if (new URLSearchParams(location.search).has('smoke')) smoke(app);
  if (new URLSearchParams(location.search).has('shots')) import('./demo-shots.js').then((m) => m.runShots(app));
}).catch((err) => {
  console.error(err);
  document.body.textContent = `Startup failed: ${err.message}`;
  if (new URLSearchParams(location.search).has('smoke')) window.rb.smokeReady({ ok: false, error: String(err?.stack ?? err) });
});
