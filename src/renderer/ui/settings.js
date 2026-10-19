import { h, modal, toast } from './dom.js';
import { BPM_RANGES } from '../analysis/analyzer.js';
import { SHORTCUT_HELP } from './keyboard.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { openRelink } from './relink.js';
import { pluginsSection } from './plugins.js';

const FORMAT_LABELS = [['m4a', 'M4A (AAC, original quality, no re-encode)'], ['mp3', 'MP3 320 kbps'], ['flac', 'FLAC'], ['wav', 'WAV']];

/** Stem model status/download, quality, processing device and cache. */
async function stemsSection(library, apply) {
  const status = await window.rb.stems.status();
  const s = library.settings;
  const modelRow = (quality, name, size) => {
    const ready = `Installed — ${name}, ${size}.`;
    const info = h('span.dim', {}, status.models?.[quality] ? ready : 'Not installed.');
    const bar = h('progress', { max: 1, value: 0, hidden: true });
    const dl = h('button.dbtn.small', { hidden: !!status.models?.[quality] }, `Download (${size})`);
    dl.onclick = async () => {
      dl.disabled = true; bar.hidden = false;
      const off = window.rb.stems.on('stems:download', (q, got, total) => {
        if (q !== quality) return;
        bar.value = got / total; info.textContent = `Downloading… ${Math.round((got / total) * 100)}%`;
      });
      try {
        await window.rb.stems.download(quality);
        info.textContent = ready; dl.hidden = true;
      } catch (err) {
        info.textContent = `Download failed: ${err.message}`; dl.disabled = false;
      } finally { off(); bar.hidden = true; }
    };
    return h('div', {}, info, ' ', dl, bar);
  };
  const sel = (key, options) => h('select', { onchange: (e) => apply(key, e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)));
  const clear = h('button.dbtn.small', { onclick: async () => { await window.rb.stems.removeAll(); clear.textContent = 'Cache cleared'; } }, 'Clear the old hidden cache');
  return h('div.form-grid', {},
    h('label', {}, 'FAST model'), modelRow('fast', 'Spleeter 4-stem, Apache-2.0', '79 MB'),
    h('label', {}, 'HQ model'), modelRow('hq', 'HT-Demucs v4, MIT', '166 MB'),
    h('label', {}, 'Quality'), sel('stemsQuality', [
      ['auto', 'Auto — FAST instantly, upgrade to HQ in background'],
      ['fast', 'FAST only (~7× real time, starts at the playhead)'],
      ['hq', 'HQ only (~0.7× real time, best isolation)']]),
    h('label', {}, 'Separate on load'), h('input', { type: 'checkbox', checked: !!s.stemsOnLoad, onchange: (e) => apply('stemsOnLoad', e.target.checked) }),
    h('label', {}, 'Stem waveform'), sel('stemWaveform', [
      ['muted', 'Colour by stem, dim muted stems'], ['always', 'Always colour by stem'], ['off', 'Classic waveform']]),
    h('label', {}, 'Processing'), sel('stemsProvider', [
      ['cpu', 'CPU (recommended)'], ['dml', 'DirectML GPU (experimental, falls back to CPU)']]),
    h('label', {}, 'Stem files'), sel('stemsFormat', [
      ['mp3', 'MP3 256 kbps (about 9 MB per stem for 5 min)'], ['mp3-320', 'MP3 320 kbps (about 12 MB)'], ['wav', 'WAV (lossless, about 53 MB)']]),
    h('label', {}, ''), (() => {
      const info = h('span.dim');
      const btn = h('button.dbtn.small', {}, 'Convert my WAV stems to MP3');
      btn.onclick = async () => {
        btn.disabled = true; info.textContent = ' Looking for WAV stems…';
        const off = window.rb.stems.on('stems:convert', (done, total) => { info.textContent = ` ${done} / ${total}…`; });
        try {
          const kbps = s.stemsFormat === 'mp3-320' ? 320 : 256;
          const r = await window.rb.stems.convertToMp3(library.all().map((t) => ({ id: t.id, path: t.path })), kbps);
          info.textContent = r.total ? ` ${r.converted} track(s) converted, ${(r.freed / 1e9).toFixed(2)} GB freed${r.failed ? `, ${r.failed} failed` : ''}.` : ' No WAV stems found.';
        } catch (err) { info.textContent = ` Failed: ${err.message}`; } finally { off(); btn.disabled = false; }
      };
      return h('div', {}, btn, info);
    })(),
    h('label', {}, 'Where stems are kept'), h('span.dim', {}, 'See the Library tab.'),
    h('label', {}, 'Cache'), clear);
}

/** Database folder (can be a USB drive), stems folder, linking the tracks to a music folder. */
async function librarySection(app) {
  const info = await window.rb.storage.info();
  const pick = async () => (await window.rb.openFolder())[0] ?? null;
  const path = (p) => h('code.path', { title: p }, p);

  const changeDb = async (dir) => {
    if (!dir) return;
    const exists = await window.rb.storage.hasLibrary(dir);
    const choice = await modal('Library folder', h('div', {},
      h('p', {}, 'New library folder: ', path(dir)),
      exists
        ? h('p', {}, 'A Reboxed library is already there (from another computer, or saved before). Use it, or replace it with the current one?')
        : h('p', {}, 'Your library (collection, playlists, cues, analysis, artwork, DRUM CAPTURE loops) will be copied there. The current folder is kept as a backup.'),
      h('p.dim', {}, 'Reboxed restarts to open it.')),
    exists
      ? [{ label: 'Use the library there', value: 'open', primary: true }, { label: 'Replace it with mine', value: 'move' }, { label: 'Cancel', value: null }]
      : [{ label: 'Move my library there', value: 'move', primary: true }, { label: 'Cancel', value: null }]);
    if (!choice) return;
    await app.library.saveNow();
    toast('Moving the library…', 10000);
    await window.rb.storage.setDatabase(dir, choice);
  };

  const stemsMode = h('select', {},
    [['database', `In the library folder (${info.databaseDir}\\stems)`], ['custom', 'In another folder…'], ['beside', 'Beside each track (<music folder>\\stems)']]
      .map(([v, l]) => h('option', { value: v, selected: info.stemsMode === v }, l)));
  const stemsPath = h('span', {}, info.stemsRoot ? path(info.stemsRoot) : h('span.dim', {}, 'next to each track'));
  stemsMode.onchange = async () => {
    const mode = stemsMode.value;
    let dir = null;
    if (mode === 'custom') { dir = await pick(); if (!dir) { stemsMode.value = info.stemsMode; return; } }
    const move = info.stemsRoot && mode !== 'beside' ? await modal('Stems folder', h('p', {}, 'Move the stems already analysed to the new folder?'),
      [{ label: 'Move them', value: true, primary: true }, { label: 'Leave them', value: false }]) : false;
    const r = await window.rb.storage.setStems(mode, dir, !!move);
    Object.assign(info, r.info);
    stemsPath.replaceChildren(info.stemsRoot ? path(info.stemsRoot) : h('span.dim', {}, 'next to each track'));
    toast(r.moved ? `${r.moved} stems folder(s) moved` : 'Stems folder changed');
  };

  return h('div', {},
    h('div.form-grid', {},
      h('label', {}, 'Library folder'),
      h('div', {}, path(info.databaseDir), ' ',
        h('button.dbtn.small', { onclick: async () => changeDb(await pick()) }, 'Change…'),
        info.database ? h('button.dbtn.small', { onclick: () => changeDb(info.appDir) }, 'Back to this computer') : null),
      h('label', {}, ''), h('span.dim', {}, 'Collection, playlists, cues, analysis, artwork. Can be on a USB drive: if its letter changes on another computer, the paths follow.'),
      h('label', {}, 'Stems folder'), h('div', {}, stemsMode, h('div', { style: { marginTop: '4px' } }, stemsPath))),
    h('h4', {}, 'Music on a USB drive'),
    h('p', {}, (() => {
      // Tracks on the computer's own drive (the one holding the app folder).
      const drive = info.appDir.slice(0, 2).toUpperCase();
      const n = app.library.all().filter((t) => t.path.slice(0, 2).toUpperCase() === drive).length;
      return n ? `${n} track(s) of the collection are still on this computer (${drive}).` : '✓ No track of the collection is on this computer.';
    })()),
    h('p.dim', {}, 'Move the collection to a folder you choose on your drive: each track is linked to the same music there — same name, another format, or a similar name confirmed by tags and duration — or copied there. You check every doubtful match first. Cues, tags, analysis and playlists are kept, stems move along, and the local files can go to the Recycle Bin.'),
    h('button.dbtn', { onclick: () => openRelink(app) }, 'Move my collection to a USB drive…'),
    await spotifySection());
}

/** Spotify app credentials for "Search Spotify" in Track information. */
async function spotifySection() {
  const st = await window.rb.spotify.status();
  const id = h('input.text', { value: st.clientId, placeholder: 'Client ID', spellcheck: false });
  const secret = h('input.text', { type: 'password', placeholder: st.hasSecret ? '•••••••• (saved — type to replace)' : 'Client Secret', spellcheck: false });
  const status = h('span.dim', {}, st.clientId && st.hasSecret ? '✓ Set up' : 'Not set up');
  const save = async () => {
    status.textContent = 'Checking…';
    try {
      const r = await window.rb.spotify.setCredentials(id.value.trim(), secret.value.trim());
      secret.value = '';
      status.textContent = r.clientId && r.hasSecret ? '✓ Connected to Spotify' : 'Removed';
    } catch (err) { status.textContent = `✗ ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`; }
  };
  return h('div', {},
    h('h4', {}, 'Track information from Spotify'),
    h('p.dim', {}, 'Track information ▸ "Search Spotify" fills genre, album, year… from Spotify. It needs a free Spotify app: on developer.spotify.com/dashboard create an app (any name; redirect URI: http://127.0.0.1:8888/callback — Reboxed never uses it, Spotify only requires one; tick Web API), then copy its Client ID and Client Secret here. The secret is stored encrypted on this computer.'),
    h('div.form-grid', {},
      h('label', {}, 'Client ID'), id,
      h('label', {}, 'Client Secret'), secret,
      h('label', {}, ''), h('div', {}, h('button.dbtn.small', { onclick: save }, 'Save'), ' ',
        h('button.dbtn.small', { onclick: async () => { id.value = ''; secret.value = ''; await window.rb.spotify.setCredentials('', ''); status.textContent = 'Removed'; } }, 'Remove'), ' ', status)));
}

/** Track downloader preferences (moved here from the download window). */
async function downloadsSection(app, library) {
  const cfg = () => ({ ...DEFAULT_SETTINGS.downloads, ...(library.settings.downloads ?? {}) });
  const save = (patch) => library.setSetting('downloads', { ...cfg(), ...patch });
  const folder = h('code.path');
  const showFolder = async () => { const f = await app.downloads.folder(); folder.textContent = f; folder.title = f; };
  showFolder();
  const tools = h('span.dim', {}, 'Looking for yt-dlp…');
  app.downloads.tools().then((t) => {
    tools.textContent = t.ytdlp ? `yt-dlp ${t.version ?? ''} · ffmpeg ${t.ffmpeg ? '✓' : '✗'} · deno ${t.deno ? '✓' : '✗'} — ${t.ytdlp}` : 'yt-dlp not found (install yt-dlp and ffmpeg, or choose the folder that holds them)';
  });
  const c = cfg();
  return h('div.form-grid', {},
    h('label', {}, 'Audio quality'), h('select', { onchange: (e) => save({ format: e.target.value }) },
      FORMAT_LABELS.map(([v, l]) => h('option', { value: v, selected: c.format === v }, l))),
    h('label', {}, 'Download folder'), h('div', {}, folder, ' ',
      h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { save({ folder: d }); showFolder(); } } }, 'Change…')),
    h('label', {}, 'Add to the "Downloads" playlist'), h('input', { type: 'checkbox', checked: c.playlist, onchange: (e) => save({ playlist: e.target.checked }) }),
    h('label', {}, 'Check new releases at startup'), h('input', { type: 'checkbox', checked: c.checkOnStart, onchange: (e) => save({ checkOnStart: e.target.checked }) }),
    h('label', {}, 'Hide mixes / streams longer than'), h('select', { onchange: (e) => save({ maxMinutes: Number(e.target.value) }) },
      [[0, 'no limit'], [8, '8 min'], [12, '12 min'], [20, '20 min']].map(([v, l]) => h('option', { value: v, selected: c.maxMinutes === v }, l))),
    h('label', {}, 'Tools'), h('div', {}, tools, ' ',
      h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { save({ toolsDir: d }); toast('Tools folder set'); } } }, 'yt-dlp folder…')));
}

/** Preferences, in tabs. Applies changes through `apply(key, value)`. */
export async function openSettings(library, engine, apply, midi, app) {
  const s = library.settings;
  const devices = await engine.outputDevices().catch(() => []);
  const sel = (key, options, cast = (v) => v) => h('select', { onchange: (e) => apply(key, cast(e.target.value)) },
    options.map(([v, label]) => h('option', { value: v, selected: String(s[key]) === String(v) }, label)));
  const check = (key) => h('input', { type: 'checkbox', checked: s[key], onchange: (e) => apply(key, e.target.checked) });
  const deviceOptions = [['', 'System default'], ...devices.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || d.deviceId])];

  const tabs = [
    ['general', 'General', () => h('div', {},
      h('h4', {}, 'Analysis'),
      h('div.form-grid', {},
        h('label', {}, 'Analyze on import'), check('autoAnalyze'),
        h('label', {}, 'BPM range'), h('select', { onchange: (e) => apply('bpmRange', e.target.value.split('-').map(Number)) },
          BPM_RANGES.map(([a, b]) => h('option', { value: `${a}-${b}`, selected: s.bpmRange[0] === a && s.bpmRange[1] === b }, `${a} - ${b}`))),
        h('label', {}, 'Beatgrid mode'), sel('analysisMode', [['normal', 'Normal (constant tempo)'], ['dynamic', 'Dynamic (variable tempo)']]),
        h('label', {}, 'Key notation'), sel('keyNotation', [['camelot', 'Alphanumeric (8A)'], ['musical', 'Classic (Am)']]),
        h('label', {}, 'Create cues from phrases'), check('autoCues')),
      h('h4', {}, 'View'),
      h('div.form-grid', {},
        h('label', {}, 'Waveform color'), sel('waveformColor', [['3band', '3Band'], ['rgb', 'RGB'], ['blue', 'BLUE']]),
        h('label', {}, 'Window at start'), (() => {
          const sel = h('select', { disabled: true, onchange: (e) => window.rb.setFullscreen({ startMode: e.target.value }) },
            [['maximized', 'Full screen windowed (maximised)'], ['fullscreen', 'Full screen'], ['window', 'Normal window']].map(([v, l]) => h('option', { value: v }, l)));
          window.rb.fullscreen().then((f) => { sel.value = f.startMode; sel.disabled = false; });
          return h('div', {}, sel, h('span.dim', {}, '  F11 switches full screen on / off at any time'));
        })()))],
    ['decks', 'Decks & Mixer', () => h('div.form-grid', {},
      h('label', {}, 'Decks'), sel('deckCount', [[2, '2 decks'], [4, '4 decks']], Number),
      h('label', {}, 'Sync mode'), sel('syncMode', [['beat', 'BEAT SYNC (tempo + phase)'], ['bpm', 'BPM SYNC (tempo only)']]),
      h('label', {}, 'Sync double/half BPM'), check('syncDoubleHalf'),
      h('label', {}, 'Default tempo range'), sel('defaultTempoRange', [[6, '±6%'], [10, '±10%'], [16, '±16%'], [100, 'WIDE']], Number),
      h('label', {}, 'Auto gain'), check('autoGain'),
      h('label', {}, 'Channel fader curve'), sel('faderCurve', [['linear', 'Linear'], ['exp', 'Exponential'], ['log', 'Logarithmic']]),
      h('label', {}, 'Crossfader curve'), sel('crossfaderCurve', [['smooth', 'Smooth'], ['constant', 'Constant power'], ['cut', 'Sharp cut']]))],
    ['audio', 'Audio', () => h('div.form-grid', {},
      h('label', {}, 'Master out'), sel('masterDevice', deviceOptions),
      h('label', {}, 'Headphones (cue)'), sel('phonesDevice', [['', 'Off'], ...deviceOptions.slice(1)]),
      h('label', {}, 'Output channels'), sel('outputLayout', [['stereo', 'Stereo (headphones on a 2nd device)'], ['quad', '4 channels: master 1/2, headphones 3/4 (DJ controller)']]),
      h('label', {}, 'Use controller sound card automatically'), check('controllerAudioAuto'))],
    ['library', 'Library', () => librarySection(app)],
    ['stems', 'Stems', () => stemsSection(library, apply)],
    ['downloads', 'Downloads', () => downloadsSection(app, library)],
    ['midi', 'MIDI', () => (midi ? midi.renderSettings() : h('p.dim', {}, 'MIDI not initialised'))],
    ['plugins', 'Plugins', () => pluginsSection(app)],
    ['keyboard', 'Keyboard', () => h('table.shortcuts', {}, h('tr', {}, h('th', {}, 'Function'), h('th', {}, 'Deck 1'), h('th', {}, 'Deck 2')),
      SHORTCUT_HELP.map(([f, a, b]) => h('tr', {}, h('td', {}, f), h('td', {}, a), h('td', {}, b))))],
  ];
  const pane = h('div.settings-pane');
  const bar = h('div.settings-tabs', { role: 'tablist' });
  const show = async (id) => {
    const tab = tabs.find((t) => t[0] === id) ?? tabs[0];
    bar.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab[0]); b.setAttribute('aria-selected', b.dataset.tab === tab[0]); });
    pane.replaceChildren(h('p.dim', {}, 'Loading…'));
    pane.replaceChildren(await tab[2]());
    try { localStorage.setItem('reboxed.settingsTab', tab[0]); } catch { /* private storage */ }
  };
  tabs.forEach(([id, label]) => bar.append(h('button', { role: 'tab', dataset: { tab: id }, onclick: () => show(id) }, label)));
  let first = 'general';
  try { first = localStorage.getItem('reboxed.settingsTab') || first; } catch { /* private storage */ }
  await show(first);
  const body = h('div.settings', {}, bar, pane);
  await modal('Preferences', body, [{ label: 'Close', primary: true, value: true }]);
}
