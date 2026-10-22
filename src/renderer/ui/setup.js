// Setup assistant, on the first launch with an empty library (Preferences > General can open it
// again): folders and quality, stem models, download tools, online track information. Every step
// can be skipped, the whole assistant too; everything stays in Preferences.
import { h, toast } from './dom.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { FORMAT_LABELS, stemsSection, spotifySection, discogsSection } from './settings.js';

/** Step 1: where downloads and the library go, download quality. */
async function foldersStep(app) {
  const lib = app.library;
  const cfg = () => ({ ...DEFAULT_SETTINGS.downloads, ...(lib.settings.downloads ?? {}) });
  const save = (patch) => lib.setSetting('downloads', { ...cfg(), ...patch });
  const folder = h('code.path');
  const show = async () => { const f = await app.downloads.folder(); folder.textContent = f; folder.title = f; };
  show();
  const info = await window.rb.storage.info();
  return h('div.form-grid', {},
    h('label', {}, 'Download quality'), h('select', { onchange: (e) => save({ format: e.target.value, formatChosen: true }) },
      FORMAT_LABELS.map(([v, l]) => h('option', { value: v, selected: cfg().format === v }, l))),
    h('label', {}, 'Downloaded tracks go to'), h('div', {}, folder, ' ',
      h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { save({ folder: d }); show(); } } }, 'Change…')),
    h('label', {}, 'Library (cues, analysis…)'), h('div', {}, h('code.path', {}, info.databaseDir),
      h('small', {}, 'It can live on a USB drive to use the same library on several computers: Preferences > Library.')));
}

const STEPS = [
  ['welcome', 'Welcome to Reboxed', async () => h('div', {},
    h('p', {}, 'A few quick choices so everything is ready: where your music goes and in what quality, the stem separation models, the tools that download tracks, and the online track information.'),
    h('p.dim', {}, 'Every step can be skipped and everything can be changed later in Preferences (the gear, top right).'))],
  ['folders', 'Folders and quality', (app) => foldersStep(app)],
  ['stems', 'Stems (separate vocals, drums, bass…)', (app) => stemsSection(app.library, (k, v) => app.applySetting(k, v), app).then((el) => h('div', {},
    h('p.dim', {}, 'FAST starts at once; HQ sounds cleaner and takes longer. Download at least one model to use the STEMS buttons; "Test the engines" picks the fastest engine of this computer (CPU or GPU).'), el))],
  ['tools', 'Download tracks (yt-dlp, ffmpeg, deno)', async (app) => h('div', {},
    h('p.dim', {}, 'Reboxed downloads tracks from YouTube and SoundCloud with free tools: yt-dlp (downloads), ffmpeg (MP3 / FLAC conversion, covers) and deno (needed by YouTube for some videos). Install them here in one click.'),
    app.downloads.toolsPanel())],
  ['online', 'Track information online', async () => h('div', {},
    h('p.dim', {}, 'Auto-tag and "Search info" fill titles, artists, genres, labels and covers. Deezer and MusicBrainz work without anything; Spotify (clean titles) and Discogs (the most precise genres) need a free key, set up below or later.'),
    await spotifySection(), await discogsSection())],
  ['done', 'All set', async () => h('div', {},
    h('p', {}, 'Add your music with "+ Folder" or "+ Files" at the bottom left, or drop files on the window. Tracks are analysed on import (BPM, key, beatgrid, phrases).'),
    h('p.dim', {}, 'This assistant can be opened again from Preferences > General.'))],
];

/** Open the assistant; resolves when it is closed (finished or skipped). */
export function openSetup(app) {
  return new Promise((resolve) => {
    let i = 0;
    const title = h('h2');
    const dots = h('div.setup-dots');
    const body = h('div.dialog-body.settings-content.setup-body');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.setup-dialog', { role: 'dialog' }, h('div.setup-head', {}, title, dots), body, buttons));
    const finish = () => {
      app.library.setSetting('setupDone', true);
      overlay.remove();
      resolve();
    };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); e.stopPropagation(); });
    const show = async () => {
      const [, label, build] = STEPS[i];
      title.textContent = label;
      dots.replaceChildren(...STEPS.map((_, k) => h(`span.setup-dot${k === i ? '.on' : k < i ? '.done' : ''}`)));
      body.replaceChildren(h('p.dim', {}, 'Loading…'));
      try {
        const content = await build(app);
        // Same row layout as Preferences: every value cell is a block.
        [...(content.matches('.form-grid') ? [content] : []), ...content.querySelectorAll('.form-grid')].forEach((g) => [...g.children].forEach((c, k) => {
          if (k % 2 === 1 && c.tagName !== 'DIV') { const w = document.createElement('div'); c.replaceWith(w); w.append(c); }
        }));
        body.replaceChildren(content);
      } catch (err) { body.replaceChildren(h('p', {}, `This step could not open: ${err.message}`)); }
      const last = i === STEPS.length - 1;
      buttons.replaceChildren(
        i === 0 ? h('button', { onclick: finish }, 'Skip the setup') : h('button', { onclick: () => { i--; show(); } }, 'Back'),
        h('span.spacer'),
        !last && i > 0 ? h('button', { onclick: () => { i++; show(); } }, 'Skip this step') : null,
        h('button.primary', { onclick: () => { if (last) finish(); else { i++; show(); } } }, last ? 'Start mixing' : i === 0 ? "Let's go" : 'Next'));
    };
    document.body.append(overlay);
    show().catch((err) => { toast(err.message); finish(); });
  });
}
