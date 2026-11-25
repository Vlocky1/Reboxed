import { errText, lang, langChoice, pickLang, saveLangChoice, tx } from '../../shared/i18n.js';
import { h, modal, toast, help } from './dom.js';
import { icon } from './icons.js';
import { BPM_RANGES } from '../analysis/analyzer.js';
import { keyboardSection } from './keyboard.js';
import { aboutSection } from './updates.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { lowMemoryWanted } from '../../shared/pcm.js';
import { openRelink } from './relink.js';
import { pluginsSection } from './plugins.js';
import { appearanceSection } from './appearance.js';
import { cleanerSettings } from './clean-names.js';
import { STEM_ENGINES, ENGINE_NAMES, pickEngine } from '../../shared/stem-engines.js';

export const FORMAT_LABELS = [['mp3', tx('MP3 320 kbps (recommended, plays everywhere)')], ['m4a', tx('M4A (AAC, original quality, no re-encode)')], ['flac', 'FLAC'], ['wav', 'WAV']];

/**
 * Engine choice (Auto / CPU / GPU) and the engine test: speed of each engine on each installed
 * model, measured on this computer; Auto uses the fastest.
 */
function stemEngineRows(app, library, apply, nvidia = null) {
  const s = library.settings;
  const table = h('div.engine-table');
  const fmt = (v) => (typeof v === 'number' ? tx`${v.toFixed(v < 2 ? 2 : 1)}× real time` : v === 'crash' ? tx('crashes on this computer') : v === 'error' ? 'failed' : '—');
  const render = (bench = library.settings.stemsBench) => {
    const rows = [['fast', 'FAST'], ['hq', 'HQ']].filter(([q]) => bench?.[q]).map(([q, label]) => {
      const used = pickEngine(library.settings.stemsProvider ?? 'auto', bench[q]);
      return h('div.engine-row', {}, h('b', {}, label),
        ...STEM_ENGINES.filter((ep) => ep !== 'cuda' || bench[q][ep] !== undefined).map((ep) => h(`span.engine-cell${ep === used ? '.used' : ''}`, { title: ep === used ? tx('Used for this model') : '' }, `${ENGINE_NAMES[ep]}: ${fmt(bench[q][ep])}`)));
    });
    table.replaceChildren(...(rows.length ? rows : [h('span.dim', {}, tx('Not tested yet: Auto uses the CPU. Test to let it pick the GPU when it is faster here.'))]));
  };
  const status = h('span.dim');
  const test = h('button.dbtn.small', { type: 'button' }, tx('Test the engines'));
  test.onclick = async () => {
    test.disabled = true;
    const live = { ...(library.settings.stemsBench ?? {}) };
    try {
      await app.benchStemEngines((q, ep, v) => {
        live[q] = { ...(live[q] ?? {}), [ep]: v };
        status.textContent = tx` ${q.toUpperCase()} on ${ENGINE_NAMES[ep]}: ${fmt(v)}`;
        render(live);
      }, {});
      status.textContent = tx(' Done.');
    } catch (err) { status.textContent = tx` Test failed: ${errText(err)}`; } finally { test.disabled = false; render(); }
  };
  const choice = h('select', { onchange: (e) => { apply('stemsProvider', e.target.value); render(); } },
    [['auto', tx('Auto — the fastest measured here (CPU until tested)')], ['cpu', 'CPU'], ['webgpu', 'GPU · WebGPU (Direct3D 12)'], ['dml', 'GPU · DirectML'],
      ...(nvidia?.installed || s.stemsProvider === 'cuda' ? [['cuda', `GPU · NVIDIA CUDA${nvidia?.installed ? '' : tx(' (not installed: CPU)')}`]] : [])]
      .map(([v, l]) => h('option', { value: v, selected: (s.stemsProvider ?? 'auto') === v }, l)));
  render();
  return [
    h('label', {}, tx('Engine')), h('div', {}, choice, h('small.hint', {}, tx('A GPU engine that crashes falls back to the CPU.'))),
    h('label', {}, tx('Speed on this computer')), h('div', {}, h('div.frow', {}, test, status), table,
      help(tx('Measures each engine on a short test mix, so Auto can pick the fastest.'),
        tx('HQ takes a minute or two. Integrated graphics are often slower than the CPU; a dedicated GPU is usually much faster.'), { tag: 'small' })),
  ];
}

/**
 * NVIDIA engine (CUDA): shown when an NVIDIA card is there. Install (downloads the official
 * onnxruntime GPU and NVIDIA CUDA / cuDNN files, ~1.3 GB), check its speed, use it, or remove it.
 */
function nvidiaRows(app, library, apply, nv, reopen) {
  if (!nv?.gpu) return [];
  const gb = (n) => `${(n / 1073741824).toFixed(1)} GB`;
  const info = h('div.dim');
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const buttons = h('div.frow');
  const cell = h('div', {}, info, bar, buttons);
  const install = async () => {
    buttons.replaceChildren();
    bar.hidden = false;
    const off = window.rb.nvidia.onProgress((p) => {
      bar.value = p.total ? p.received / p.total : 0;
      info.textContent = p.phase === 'download' ? tx`Downloading ${p.part}… ${gb(p.received)} / ${gb(p.total)}`
        : p.phase === 'extract' ? tx`Unpacking ${p.part}…` : p.phase === 'setup' ? tx('Setting up…') : tx('Installed');
    });
    try {
      await window.rb.nvidia.install();
      info.textContent = tx('Installed — checking its speed on your card…');
      bar.hidden = true;
      // A quick run on each installed model: proves it works here and records its speed for Auto.
      const status = await window.rb.stems.status();
      const bench = { ...(library.settings.stemsBench ?? {}) };
      const speeds = [];
      for (const q of ['hq', 'fast']) {
        if (!status.models[q]) continue;
        const r = await window.rb.stems.bench(q, 'cuda', 4);
        bench[q] = { ...(bench[q] ?? {}), cuda: r.crashed ? 'crash' : r.speed ?? 'error' };
        if (typeof r.speed === 'number') speeds.push(tx`${q.toUpperCase()} ${r.speed.toFixed(1)}× real time`);
      }
      library.setSetting('stemsBench', bench);
      if (speeds.length) { apply('stemsProvider', 'cuda'); toast(tx`NVIDIA engine ready: ${speeds.join(', ')}`, 7000); }
      else if (Object.values(bench).some((b) => b?.cuda === 'crash' || b?.cuda === 'error')) toast(tx('The NVIDIA engine is installed but failed on this card: Reboxed keeps the other engines'), 8000);
    } catch (err) {
      info.textContent = tx`Not installed: ${errText(err)} (what was already downloaded is kept for the next try)`;
    } finally { off(); bar.hidden = true; reopen(); }
  };
  if (!nv.support.ok) {
    info.textContent = nv.support.reason;
  } else if (nv.installed) {
    info.textContent = tx`✓ Installed — ${nv.gpu.name} (driver ${nv.gpu.driver}). ${library.settings.stemsProvider === 'cuda' ? tx('In use.') : tx('Choose "GPU · NVIDIA CUDA" above (or Auto after "Test the engines") to use it.')}`;
    buttons.append(
      library.settings.stemsProvider === 'cuda' ? '' : h('button.dbtn.small.primary', { onclick: () => { apply('stemsProvider', 'cuda'); reopen(); } }, tx('Use it')),
      h('button.dbtn.small', { onclick: async () => {
        await window.rb.nvidia.remove();
        if (library.settings.stemsProvider === 'cuda') apply('stemsProvider', 'auto');
        toast(tx('NVIDIA engine removed')); reopen();
      } }, tx('Remove (frees about 1.5 GB)')));
  } else {
    info.textContent = tx`${nv.gpu.name}: much faster stems (HQ about 30× real time on an RTX 3070 Ti).`;
    info.title = tx`Downloads about ${gb(nv.downloadSize)} of official files, each checked: onnxruntime GPU (Microsoft) and the CUDA, cuBLAS, cuFFT and cuDNN libraries (NVIDIA). About 1.5 GB on disk.`;
    buttons.append(h('button.dbtn.small.primary', { onclick: install }, tx`Install the NVIDIA engine (${gb(nv.downloadSize)})`));
    if (nv.installing) { buttons.replaceChildren(); info.textContent = tx('Installing…'); }
  }
  return [h('label', {}, tx('NVIDIA engine (CUDA)')), cell];
}

/** Stem model status/download, quality, processing engine and cache. */
export async function stemsSection(library, apply, app, reopen = () => {}) {
  const status = await window.rb.stems.status();
  const nv = await window.rb.nvidia.status().catch(() => null);
  const s = library.settings;
  const modelRow = (quality, name, size) => {
    const ready = tx`Installed — ${name}, ${size}.`;
    const info = h('span.dim', {}, status.models?.[quality] ? ready : tx('Not installed.'));
    const bar = h('progress', { max: 1, value: 0, hidden: true });
    const dl = h('button.dbtn.small', { hidden: !!status.models?.[quality] }, tx`Download (${size})`);
    dl.onclick = async () => {
      dl.disabled = true; bar.hidden = false;
      const off = window.rb.stems.on('stems:download', (q, got, total) => {
        if (q !== quality) return;
        bar.value = got / total; info.textContent = tx`Downloading… ${Math.round((got / total) * 100)}%`;
      });
      try {
        await window.rb.stems.download(quality);
        info.textContent = ready; dl.hidden = true;
      } catch (err) {
        info.textContent = tx`Download failed: ${errText(err)}`; dl.disabled = false;
      } finally { off(); bar.hidden = true; }
    };
    return h('div', {}, info, ' ', dl, bar);
  };
  const sel = (key, options) => h('select', { onchange: (e) => apply(key, e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)));
  const clear = h('button.dbtn.small', { onclick: async () => { await window.rb.stems.removeAll(); clear.textContent = tx('Cache cleared'); } }, tx('Clear the old hidden cache'));
  return h('div.form-grid', {},
    h('label', {}, tx('FAST model')), modelRow('fast', 'Spleeter 4-stem, Apache-2.0', '79 MB'),
    h('label', {}, tx('HQ model')), modelRow('hq', 'HT-Demucs v4, MIT', '166 MB'),
    h('label', {}, tx('Quality')), sel('stemsQuality', [
      ['auto', tx('Auto — FAST instantly, upgrade to HQ in background')],
      ['fast', tx('FAST only (~7× real time, starts at the playhead)')],
      ['hq', tx('HQ only (~0.7× real time, best isolation)')]]),
    h('label', {}, tx('Separate on load')), h('input', { type: 'checkbox', checked: !!s.stemsOnLoad, onchange: (e) => apply('stemsOnLoad', e.target.checked) }),
    h('label', {}, tx('Stem waveform')), sel('stemWaveform', [
      ['muted', tx('Colour by stem, dim muted stems')], ['always', tx('Always colour by stem')], ['off', tx('Classic waveform')]]),
    ...stemEngineRows(app, library, apply, nv),
    ...nvidiaRows(app, library, apply, nv, reopen),
    h('label', {}, tx('Stem files')), sel('stemsFormat', [
      ['mp3', tx('MP3 256 kbps (about 9 MB per stem for 5 min)')], ['mp3-320', tx('MP3 320 kbps (about 12 MB)')], ['wav', tx('WAV (lossless, about 53 MB)')]]),
    h('label', {}, ''), (() => {
      const info = h('span.dim');
      const btn = h('button.dbtn.small', {}, tx('Convert my WAV stems to MP3'));
      btn.onclick = async () => {
        btn.disabled = true; info.textContent = tx(' Looking for WAV stems…');
        const off = window.rb.stems.on('stems:convert', (done, total) => { info.textContent = ` ${done} / ${total}…`; });
        try {
          const kbps = s.stemsFormat === 'mp3-320' ? 320 : 256;
          const r = await window.rb.stems.convertToMp3(library.all().map((t) => ({ id: t.id, path: t.path })), kbps);
          info.textContent = r.total ? tx` ${r.converted} track(s) converted, ${(r.freed / 1e9).toFixed(2)} GB freed${r.failed ? tx`, ${r.failed} failed` : ''}.` : tx(' No WAV stems found.');
        } catch (err) { info.textContent = tx` Failed: ${errText(err)}`; } finally { off(); btn.disabled = false; }
      };
      return h('div', {}, btn, info);
    })(),
    h('label', {}, tx('Where stems are kept')), h('span.dim', {}, tx('See the Library tab.')),
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
    const choice = await modal(tx('Library folder'), h('div', {},
      h('p', {}, tx('New library folder: '), path(dir)),
      exists
        ? h('p', {}, tx('A Reboxed library is already there (from another computer, or saved before). Use it, or replace it with the current one?'))
        : h('p', {}, tx('Your library (collection, playlists, cues, analysis, artwork, DRUM CAPTURE loops) will be copied there. The current folder is kept as a backup.')),
      h('p.dim', {}, tx('Reboxed restarts to open it.'))),
    exists
      ? [{ label: tx('Use the library there'), value: 'open', primary: true }, { label: tx('Replace it with mine'), value: 'move' }, { label: tx('Cancel'), value: null }]
      : [{ label: tx('Move my library there'), value: 'move', primary: true }, { label: tx('Cancel'), value: null }]);
    if (!choice) return;
    await app.library.saveNow();
    toast(tx('Moving the library…'), 10000);
    await window.rb.storage.setDatabase(dir, choice);
  };

  const stemsMode = h('select', {},
    [['database', tx`In the library folder (${info.databaseDir}\\stems)`], ['custom', tx('In another folder…')], ['beside', tx('Beside each track (<music folder>\\stems)')]]
      .map(([v, l]) => h('option', { value: v, selected: info.stemsMode === v }, l)));
  const stemsPath = h('span', {}, info.stemsRoot ? path(info.stemsRoot) : h('span.dim', {}, tx('next to each track')));
  stemsMode.onchange = async () => {
    const mode = stemsMode.value;
    let dir = null;
    if (mode === 'custom') { dir = await pick(); if (!dir) { stemsMode.value = info.stemsMode; return; } }
    const move = info.stemsRoot && mode !== 'beside' ? await modal(tx('Stems folder'), h('p', {}, tx('Move the stems already analysed to the new folder?')),
      [{ label: tx('Move them'), value: true, primary: true }, { label: tx('Leave them'), value: false }]) : false;
    const r = await window.rb.storage.setStems(mode, dir, !!move);
    Object.assign(info, r.info);
    stemsPath.replaceChildren(info.stemsRoot ? path(info.stemsRoot) : h('span.dim', {}, tx('next to each track')));
    toast(r.moved ? tx`${r.moved} stems folder(s) moved` : tx('Stems folder changed'));
  };

  return h('div', {},
    h('div.form-grid', {},
      h('label', {}, tx('Library folder')),
      h('div', {}, path(info.databaseDir), ' ',
        h('button.dbtn.small', { onclick: async () => changeDb(await pick()) }, tx('Change…')),
        info.database ? h('button.dbtn.small', { onclick: () => changeDb(info.appDir) }, tx('Back to this computer')) : null),
      h('label', {}, ''), h('small.hint', {}, tx('Your collection, playlists, cues and analysis. It can live on a USB drive.')),
      h('label', {}, tx('Stems folder')), h('div', {}, stemsMode, h('div', { style: { marginTop: '4px' } }, stemsPath))),
    h('h4', {}, tx('Music on a USB drive')),
    h('p', {}, (() => {
      // Tracks on the computer's own drive (the one holding the app folder).
      const drive = info.appDir.slice(0, 2).toUpperCase();
      const n = app.library.all().filter((t) => t.path.slice(0, 2).toUpperCase() === drive).length;
      return n ? tx`${n} track(s) of the collection are still on this computer (${drive}).` : tx('✓ No track of the collection is on this computer.');
    })()),
    help(tx('Moves your music to a USB drive and keeps cues, playlists, analysis and stems.'), [
      tx('Each track is linked to the same music on the drive (same name, another format, or a similar name confirmed by tags and length), or copied there.'),
      tx('You check every doubtful match first. The files left on the computer can then go to the Recycle Bin.')]),
    h('button.dbtn', { onclick: () => openRelink(app) }, tx('Move my collection to a USB drive…')));
}

/** Preferences > Accounts: the optional online services, one card each. */
async function accountsSection() {
  return h('div', {}, await spotifySection(), await discogsSection(), await aiSection());
}

/** One online service: name, state, what it adds (one line), how to set it up (behind "?"), its fields. */
function accountCard(name, badge, summary, more, ...body) {
  return h('div.acct-card', {}, h('div.acct-head', {}, h('b', {}, name), badge), help(summary, more), ...body);
}
const acctBadge = (on, text) => h(`span.acct-badge${on ? '.on' : ''}`, {}, text);

/** Track suggestion: the optional Gemini key (stored encrypted, never shown again). */
export async function aiSection() {
  const st = await window.rb.ai.status();
  const key = h('input.text', { type: 'password', placeholder: st.hasKey ? tx`${st.keyHint} (saved — type to replace)` : tx('Gemini API key (optional)'), spellcheck: false });
  const model = h('input.text', { value: st.model, spellcheck: false, title: tx('Model name (default: gemini-flash-latest)') });
  const status = h('span.dim', {}, st.hasKey ? tx('✓ Set up') : tx('Not set up: suggestions stay local'));
  const err = (e) => `✗ ${errText(e)}`;
  const save = async () => {
    try {
      const r = await window.rb.ai.configure({ ...(key.value.trim() ? { key: key.value.trim() } : {}), model: model.value.trim() });
      key.value = '';
      key.placeholder = r.hasKey ? tx`${r.keyHint} (saved — type to replace)` : tx('Gemini API key (optional)');
      status.textContent = r.hasKey ? tx('✓ Saved') : tx('No key: suggestions stay local');
    } catch (e) { status.textContent = err(e); }
  };
  return accountCard('Gemini', acctBadge(st.hasKey, st.hasKey ? tx('SET UP') : tx('OPTIONAL')),
    tx('Adds "✦ Ask Gemini" to Track Suggestion. Suggestions already work without it.'),
    { steps: [tx('Click "Get a key" and sign in with a Google account.'), tx('Create an API key (free).'), tx('Paste it here and Save.')],
      notes: [tx('Only titles, artists, BPM, keys and genres are sent to Google, never your audio. The key is stored encrypted on this computer.')] },
    h('div.frow', {}, h('button.dbtn.small', { onclick: () => window.rb.openExternal('https://aistudio.google.com/apikey') }, tx('Get a key ↗'))),
    h('div.form-grid', {},
      h('label', {}, tx('API key')), key,
      h('label', {}, tx('Model')), model,
      h('label', {}, ''), h('div.frow', {}, h('button.dbtn.small', { onclick: save }, tx('Save')), ' ',
        h('button.dbtn.small', { onclick: async () => { try { await window.rb.ai.configure({ key: '' }); key.placeholder = tx('Gemini API key (optional)'); status.textContent = tx('Removed'); } catch (e) { status.textContent = err(e); } } }, tx('Remove')), ' ', status)));
}

/** Discogs personal token: precise styles (Tech House, Deep House…) for the Genre auto-tag source. */
export async function discogsSection() {
  const st = await window.rb.discogs.status();
  const token = h('input.text', { type: 'password', placeholder: st.hasToken ? tx('•••••••• (saved — type to replace)') : tx('Personal access token'), spellcheck: false });
  const status = h('span.dim', {}, st.hasToken ? tx('✓ Set up') : '');
  const save = async () => {
    status.textContent = tx('Checking…');
    try {
      await window.rb.discogs.setToken(token.value.trim());
      status.textContent = token.value.trim() ? tx('✓ Connected to Discogs') : tx('Removed');
      token.value = '';
    } catch (err) { status.textContent = `✗ ${errText(err)}`; }
  };
  return accountCard('Discogs', acctBadge(st.hasToken, st.hasToken ? tx('SET UP') : tx('OPTIONAL')),
    tx('More precise club genres in Auto-tag (Tech House, Drum & Bass…).'),
    { steps: [tx('Click "Get a token" and sign in on Discogs (free account).'), tx('Click "Generate new token".'), tx('Paste it here and Save.')],
      notes: [tx('Without it, genres come from MusicBrainz and Deezer only. The token is stored encrypted on this computer.')] },
    h('div.frow', {}, h('button.dbtn.small', { onclick: () => window.rb.openExternal('https://www.discogs.com/settings/developers') }, tx('Get a token ↗'))),
    h('div.form-grid', {},
      h('label', {}, tx('Discogs token')), token,
      h('label', {}, ''), h('div.frow', {}, h('button.dbtn.small', { onclick: save }, tx('Save')), ' ',
        h('button.dbtn.small', { onclick: async () => { token.value = ''; await window.rb.discogs.setToken(''); status.textContent = tx('Removed'); } }, tx('Remove')), ' ', status)));
}

/** Spotify app credentials for "Search Spotify" in Track information. */
export async function spotifySection() {
  const st = await window.rb.spotify.status();
  const id = h('input.text', { value: st.clientId, placeholder: 'Client ID', spellcheck: false });
  const secret = h('input.text', { type: 'password', placeholder: st.hasSecret ? tx('•••••••• (saved — type to replace)') : tx("Client Secret (optional with a friend's app)"), spellcheck: false });
  const status = h('span.dim', {}, st.clientId && st.hasSecret ? tx('✓ Set up') : st.clientId ? tx('✓ Client ID saved: now connect your account') : tx('Not set up'));
  const save = async () => {
    status.textContent = tx('Checking…');
    try {
      const r = await window.rb.spotify.setCredentials(id.value.trim(), secret.value.trim());
      secret.value = '';
      Object.assign(st, r);
      status.textContent = r.clientId && r.hasSecret ? tx('✓ Connected to Spotify') : r.clientId ? tx('✓ Client ID saved: now connect your account') : tx('Removed');
      showAccount(); // the Connect button follows the Client ID just saved
    } catch (err) { status.textContent = `✗ ${errText(err)}`; Object.assign(st, await window.rb.spotify.status()); showAccount(); }
  };
  // the Spotify account: whole playlists (Spotify gives a playlist's tracks only to a signed-in user)
  const acct = h('div');
  const showAccount = async () => {
    const a = await window.rb.spotify.account();
    const msg = h('span.dim');
    const connect = async () => {
      msg.textContent = tx('Sign in in your browser…');
      try { const me = await window.rb.spotify.signIn(); msg.textContent = tx`✓ Connected as ${me.name}`; showAccount(); } catch (err) { msg.textContent = `✗ ${errText(err)}`; }
    };
    acct.replaceChildren(a.signedIn
      ? h('div', {}, h('span', {}, tx`✓ Connected${a.user ? tx` as ${a.user}` : ''}`), ' ', h('button.dbtn.small', { onclick: async () => { await window.rb.spotify.signOut(); showAccount(); } }, tx('Disconnect')), ' ', msg)
      : h('div', {}, h('button.dbtn.small', { disabled: !st.clientId, onclick: connect }, tx('Connect my Spotify account…')), ' ', msg));
  };
  showAccount();
  const ready = !!(st.clientId && st.hasSecret);
  return accountCard('Spotify', acctBadge(ready, ready ? tx('SET UP') : tx('OPTIONAL')),
    tx('Reads your Spotify playlists in full and adds Spotify to "Search info". Deezer needs no setup.'),
    { steps: [
      tx('Click "Open the Spotify dashboard", sign in, and create an app (any name).'),
      h('span', {}, tx('Redirect URI: '), h('code', {}, 'http://127.0.0.1:8888/callback'), tx(' · tick "Web API".')),
      tx('Copy the app\'s Client ID and Client Secret here, then Save.'),
      tx('Click "Connect my Spotify account…" and accept in your browser (once).')],
    notes: [tx('Create your own Spotify app: each person needs theirs. Spotify asks its owner for a Premium account.'),
      tx('No Premium? A friend can add your Spotify e-mail to their app (dashboard > User Management, 5 people at most) and give you its Client ID: paste it alone, without the Secret, then connect your own account.'),
      tx('Without the account, Spotify shows only the first 100 tracks of a playlist. Reboxed only reads your playlists. The secret is stored encrypted on this computer.')] },
    st.foreign ? h('p.hint', {}, tx('The Spotify keys found here come from another computer: they were set aside. Enter your own.')) : null,
    h('div.frow', {}, h('button.dbtn.small', { onclick: () => window.rb.openExternal('https://developer.spotify.com/dashboard') }, tx('Open the Spotify dashboard ↗'))),
    h('div.form-grid', {},
      h('label', {}, 'Client ID'), id,
      h('label', {}, 'Client Secret'), secret,
      h('label', {}, ''), h('div.frow', {}, h('button.dbtn.small', { onclick: save }, tx('Save')), ' ',
        h('button.dbtn.small', { onclick: async () => { id.value = ''; secret.value = ''; Object.assign(st, await window.rb.spotify.setCredentials('', '')); status.textContent = tx('Removed'); showAccount(); } }, tx('Remove')), ' ', status),
      h('label', {}, tx('My account')), acct));
}

/** Track downloader preferences (moved here from the download window). */
export async function downloadsSection(app, library) {
  const cfg = () => ({ ...DEFAULT_SETTINGS.downloads, ...(library.settings.downloads ?? {}) });
  const save = (patch) => library.setSetting('downloads', { ...cfg(), ...patch });
  const folder = h('code.path');
  const showFolder = async () => { const f = await app.downloads.folder(); folder.textContent = f; folder.title = f; };
  showFolder();
  const c = cfg();
  return h('div.form-grid', {},
    h('label', {}, tx('Audio quality')), h('select', { onchange: (e) => save({ format: e.target.value, formatChosen: true }) },
      FORMAT_LABELS.map(([v, l]) => h('option', { value: v, selected: c.format === v }, l))),
    h('label', {}, tx('Download folder')), h('div', {}, folder, ' ',
      h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { save({ folder: d }); showFolder(); } } }, tx('Change…'))),
    h('label', {}, tx('Add to the "Downloads" playlist')), h('input', { type: 'checkbox', checked: c.playlist, onchange: (e) => save({ playlist: e.target.checked }) }),
    ...cleanerSettings(c, save),
    h('label', {}, tx('Check new releases at startup')), h('input', { type: 'checkbox', checked: c.checkOnStart, onchange: (e) => save({ checkOnStart: e.target.checked }) }),
    h('label', {}, tx('Hide mixes / streams longer than')), h('select', { onchange: (e) => save({ maxMinutes: Number(e.target.value) }) },
      [[0, tx('no limit')], [8, '8 min'], [12, '12 min'], [20, '20 min']].map(([v, l]) => h('option', { value: v, selected: c.maxMinutes === v }, l))),
    h('label', {}, tx('Tools')), app.downloads.toolsPanel());
}

/** Preferences, in tabs. Applies changes through `apply(key, value)`. */
export async function openSettings(library, engine, apply, midi, app) {
  const s = library.settings;
  const devices = await engine.outputDevices().catch(() => []);
  const sel = (key, options, cast = (v) => v) => h('select', { onchange: (e) => apply(key, cast(e.target.value)) },
    options.map(([v, label]) => h('option', { value: v, selected: String(s[key]) === String(v) }, label)));
  const check = (key) => h('input', { type: 'checkbox', checked: s[key], onchange: (e) => apply(key, e.target.checked) });
  const deviceOptions = [['', tx('System default')], ...devices.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || d.deviceId])];

  const tabs = [
    ['general', tx('General'), () => h('div', {},
      h('h4', {}, tx('Analysis')),
      h('div.form-grid', {},
        h('label', {}, tx('Analyze on import')), check('autoAnalyze'),
        h('label', {}, tx('BPM range')), h('select', { onchange: (e) => apply('bpmRange', e.target.value.split('-').map(Number)) },
          BPM_RANGES.map(([a, b]) => h('option', { value: `${a}-${b}`, selected: s.bpmRange[0] === a && s.bpmRange[1] === b }, `${a} - ${b}`))),
        h('label', {}, tx('Beatgrid mode')), h('div', {}, sel('analysisMode', [['normal', tx('Normal (constant tempo)')], ['dynamic', tx('Dynamic (variable tempo)')]]),
          help(tx('Normal keeps one BPM for the whole track (right for almost all club music).'),
            tx('In Normal, a track analysed as dynamic becomes constant the next time it is loaded. Kept variable: a locked grid, a track re-analysed as dynamic from its deck, an imported grid with real tempo changes.'), { tag: 'small' })),
        h('label', {}, tx('Variable grids')), (() => {
          const count = () => library.all().filter((t) => t.beatgrid?.beats && !t.gridLocked).length;
          const info = h('small', {}, tx`${count()} track(s) have a variable grid.`);
          const btn = h('button.dbtn.small', { disabled: !count(), onclick: async () => {
            const n = count();
            const ok = await modal(tx('Make every grid constant'), h('p', {}, tx`The ${n} track(s) with a variable grid get a constant one, closest to their beats. Locked grids stay. A recording whose tempo really changes will drift from its grid: re-analyse that one as dynamic from its deck.`),
              [{ label: tx('Make them constant'), primary: true, value: true }, { label: tx('Cancel'), value: null }]);
            if (!ok) return;
            toast(tx`${app.makeAllGridsConstant()} grid(s) made constant`);
            info.textContent = tx`${count()} track(s) have a variable grid.`;
            btn.disabled = !count();
          } }, tx('Make them all constant'));
          return h('div', {}, btn, info);
        })(),
        h('label', {}, tx('Key notation')), sel('keyNotation', [['camelot', tx('Alphanumeric (8A)')], ['musical', tx('Classic (Am)')]]),
        h('label', {}, tx('Create cues from phrases')), check('autoCues')),
      h('h4', {}, tx('Small computers')),
      h('div.form-grid', {},
        h('label', {}, tx('Low memory mode')), h('div', {}, sel('lowMemory', [['auto', tx`Automatic (${lowMemoryWanted('auto', app.ramGB ?? 0) ? tx('on') : tx('off')} here: ${Math.round(app.ramGB ?? 0)} GB of RAM)`], ['on', tx('On')], ['off', tx('Off')]]),
          help(tx('Halves the memory each deck uses. No audible difference.'),
            tx('About 58 MB instead of 115 for a 5-minute track, at CD precision (16 bits). Applies to the next track loaded.'), { tag: 'small' }))),
      h('h4', {}, tx('View')),
      h('div.form-grid', {},
        h('label', {}, tx('Interface language')), (() => {
          const now = langChoice();
          const pick = h('select.lang-select', { onchange: async (e) => {
            const choice = e.target.value;
            saveLangChoice(choice);
            if (pickLang({ choice, system: navigator.language, search: location.search }) === lang) return;
            if (app?.engine?.decks.some((d) => d.playing) && !confirm(tx('Reload the window now? What is playing stops.'))) return; // applied at the next start
            await library.saveNow();
            location.reload();
          } }, [['auto', tx('Automatic (Windows language)')], ['en', 'English'], ['fr', 'Français']].map(([v, l]) => h('option', { value: v, selected: v === now }, l)));
          return h('div', {}, pick, h('small.hint', {}, tx('The window reloads: what is playing stops.')));
        })(),
        h('label', {}, tx('Waveform color')), sel('waveformColor', [['3band', tx('3Band')], ['rgb', 'RGB'], ['blue', 'BLUE']]),
        h('label', {}, tx('Window at start')), (() => {
          const sel = h('select', { disabled: true, onchange: (e) => window.rb.setFullscreen({ startMode: e.target.value }) },
            [['maximized', tx('Full screen windowed (maximised)')], ['fullscreen', tx('Full screen')], ['window', tx('Normal window')]].map(([v, l]) => h('option', { value: v }, l)));
          window.rb.fullscreen().then((f) => { sel.value = f.startMode; sel.disabled = false; });
          return h('div', {}, sel, h('small.hint', {}, tx('F11 switches full screen at any time.')));
        })(),
        h('label', {}, tx('Remember my last choices')), (() => {
          const count = () => app.ui?.count ?? 0;
          const info = h('small.hint', {}, '');
          const forget = h('button.dbtn.small', {}, tx('Back to the defaults'));
          const show = () => { info.textContent = s.rememberUi === false ? tx('Off: every launch starts from the defaults.') : tx`${count()} choice(s) kept: pad pages, sort of each list, zoom, Beat FX…`; forget.disabled = !count(); };
          forget.onclick = () => { app.ui?.clear(); toast(tx('Your choices are forgotten: the next launch starts from the defaults')); show(); };
          const box = h('input', { type: 'checkbox', checked: s.rememberUi !== false, onchange: (e) => { apply('rememberUi', e.target.checked); s.rememberUi = e.target.checked; show(); } });
          show();
          return h('div', {}, h('div.frow', {}, box, forget), info);
        })(),
        h('label', {}, tx('Setup assistant')), h('div', {}, h('button.dbtn.small', { onclick: () => import('./setup.js').then((m) => m.openSetup(app)) }, tx('Open the setup assistant')),
          h('small.hint', {}, tx('The first-run choices, step by step.')))))],
    ['appearance', tx('Appearance'), () => appearanceSection(library, apply)],
    ['decks', tx('Decks & Mixer'), () => h('div.form-grid', {},
      h('label', {}, 'Decks'), sel('deckCount', [[2, '2 decks'], [4, '4 decks']], Number),
      h('label', {}, tx('Sync mode')), sel('syncMode', [['beat', tx('BEAT SYNC (tempo + phase)')], ['bpm', tx('BPM SYNC (tempo only)')]]),
      h('label', {}, tx('Sync double/half BPM')), check('syncDoubleHalf'),
      h('label', {}, tx('Load while playing')), h('div', {}, check('loadOnPlaying'), h('small.hint', {}, tx('Off: a playing deck is protected, pause it to load another track.'))),
      h('label', {}, tx('Default tempo range')), sel('defaultTempoRange', [[6, '±6%'], [10, '±10%'], [16, '±16%'], [100, 'WIDE']], Number),
      h('label', {}, tx('Auto gain')), check('autoGain'),
      h('label', {}, tx('Channel fader curve')), sel('faderCurve', [['linear', tx('Linear')], ['exp', tx('Exponential')], ['log', tx('Logarithmic')]]),
      h('label', {}, tx('Crossfader curve')), sel('crossfaderCurve', [['smooth', tx('Smooth')], ['constant', tx('Constant power')], ['cut', tx('Sharp cut')]]),
      h('label', {}, tx('Mix Point Link')), h('div', {}, check('showMixPoint'), help(tx('Adds its button to the top bar, and MIX IN / MIX OUT to the deck menus.'),
        tx('When a deck reaches its MIX OUT, another one starts from its MIX IN, in sync.'), { tag: 'small' })))],
    ['audio', 'Audio', () => h('div.form-grid', {},
      h('label', {}, tx('Master out')), sel('masterDevice', deviceOptions),
      h('label', {}, tx('Headphones (cue)')), sel('phonesDevice', [['', tx('Off')], ...deviceOptions.slice(1)]),
      h('label', {}, tx('Also play the master on')), h('div', {}, sel('masterCopyDevice', [['', tx('Nothing else')], ['default', tx("This computer's speakers (system default)")], ...deviceOptions.slice(1)]),
        help(tx('To also hear the master on the computer when a controller is plugged in.'),
          tx('Two sound cards are never perfectly in time: use it to listen, not to play to a crowd on both.'), { tag: 'small' })),
      h('label', {}, tx('Output channels')), sel('outputLayout', [['stereo', tx('Stereo (headphones on a 2nd device)')], ['quad', tx('4 channels: master 1/2, headphones 3/4 (DJ controller)')]]),
      h('label', {}, tx('Use controller sound card automatically')), check('controllerAudioAuto'))],
    ['library', tx('Library'), () => librarySection(app)],
    ['accounts', tx('Accounts'), () => accountsSection()],
    ['stems', 'Stems', () => stemsSection(library, apply, app, () => show('stems'))],
    ['downloads', tx('Downloads'), () => downloadsSection(app, library)],
    ['midi', 'MIDI', () => (midi ? midi.renderSettings() : h('p.dim', {}, tx('MIDI not initialised')))],
    ['plugins', 'Mods / Plugins', () => pluginsSection(app)],
    ['keyboard', tx('Keyboard'), () => keyboardSection(library)],
    ['about', tx('About'), async () => aboutSection(app, await window.rb.version())],
  ];
  // Sidebar icon and one-line description of every tab.
  const META = {
    general: ['gear', tx('Analysis, key notation, waveform and window.')],
    appearance: ['palette', tx('Theme, accent colour, size of the interface.')],
    decks: ['layout2', tx('Number of decks, sync, tempo range and mixer curves.')],
    audio: ['headphones', tx('Sound cards for the master and the headphones.')],
    library: ['collection', tx('Where your library and stems live, and moving your music to a USB drive.')],
    accounts: ['link', tx('Optional online services: Spotify, Discogs, Gemini.')],
    stems: ['wave', tx('Stem models, quality, engine and files.')],
    downloads: ['download', tx('Quality, folder, name cleaner and tools.')],
    midi: ['midi', tx('Connected controllers, MIDI monitor and learn.')],
    plugins: ['plug', tx('Mods for your controller, and hardware plugins.')],
    keyboard: ['keyboard', tx('Shortcuts, with QWERTY and AZERTY presets.')],
    about: ['info', tx('Version, updates, links and credits.')],
  };
  const pane = h('div.settings-pane');
  const bar = h('div.settings-tabs', { role: 'tablist' });
  const show = async (id) => {
    const tab = tabs.find((t) => t[0] === id) ?? tabs[0];
    bar.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab[0]); b.setAttribute('aria-selected', b.dataset.tab === tab[0]); });
    pane.replaceChildren(h('p.dim', {}, tx('Loading…')));
    const content = await tab[2]();
    // Every value cell of a settings grid is a block (a bare checkbox or select becomes one), so the
    // rows line up and switches keep their size.
    const grids = content.matches?.('.form-grid') ? [content] : [...content.querySelectorAll('.form-grid')];
    grids.forEach((g) => [...g.children].forEach((c, i) => {
      if (i % 2 === 1 && c.tagName !== 'DIV') { const w = document.createElement('div'); c.replaceWith(w); w.append(c); }
    }));
    pane.replaceChildren(h('header.settings-head', {}, h('h3', {}, tab[1]), h('p', {}, META[tab[0]]?.[1] ?? '')), h('div.settings-content', {}, content));
    pane.scrollTop = 0;
    try { localStorage.setItem('reboxed.settingsTab', tab[0]); } catch { /* private storage */ }
  };
  tabs.forEach(([id, label]) => bar.append(h('button', { role: 'tab', dataset: { tab: id }, onclick: () => show(id) }, icon(META[id]?.[0] ?? 'gear'), h('span', {}, label))));
  const version = await window.rb.version();
  bar.append(h('div.settings-version', {}, `Reboxed ${version}`));
  let first = 'general';
  try { first = localStorage.getItem('reboxed.settingsTab') || first; } catch { /* private storage */ }
  await show(first);
  // Fixed-size window with its close button pinned to the top-right corner (Escape closes too).
  await modal(tx`Preferences — Reboxed ${version}`, (close) => h('div.settings', {}, bar, pane,
    h('button.settings-close', { type: 'button', title: tx('Close (Esc)'), onclick: () => close(true) }, '✕')), []);
}
