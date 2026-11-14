// Setup assistant, on the first launch with an empty library (Preferences > General opens it
// again). A step list on the left, one step at a time on the right: your music, your accounts (the
// online services, as in Preferences > Accounts), stems, download tools, then a summary of what is
// ready. Every step can be skipped, the whole assistant too; everything stays in Preferences.
import { h, toast, help } from './dom.js';
import { icon } from './icons.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { FORMAT_LABELS, stemsSection, spotifySection, discogsSection, aiSection } from './settings.js';

/** Your music: where downloads and the library go, download quality. */
async function musicStep(app) {
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
      h('small.hint', {}, 'It can live on a USB drive (Preferences > Library).')));
}

/** What is ready, read again at the end (✓ or what is left to do). */
async function readiness(app) {
  const [sp, acct, dg, ai, stems, tools] = await Promise.all([
    window.rb.spotify.status().catch(() => ({})), window.rb.spotify.account().catch(() => ({})),
    window.rb.discogs.status().catch(() => ({})), window.rb.ai.status().catch(() => ({})),
    window.rb.stems.status().catch(() => ({})),
    // the tools answer by running them: never more than 5 s for the summary
    Promise.race([app.downloads.tools().catch(() => ({})), new Promise((r) => setTimeout(() => r({ slow: true }), 5000))]),
  ]);
  const models = Object.entries(stems.models ?? {}).filter(([, ok]) => ok).map(([q]) => q.toUpperCase());
  return [
    { ok: true, label: 'Your music', text: 'Folders and quality chosen' },
    { ok: !!acct.signedIn, label: 'Spotify', text: acct.signedIn ? `Connected${acct.user ? ` as ${acct.user}` : ''}` : sp.clientId && sp.hasSecret ? 'Keys saved, account not connected' : 'Not linked (optional)' },
    { ok: !!dg.hasToken, label: 'Discogs', text: dg.hasToken ? 'Linked' : 'Not linked (optional)' },
    { ok: !!ai.hasKey, label: 'Gemini', text: ai.hasKey ? 'Linked' : 'Not linked (optional)' },
    { ok: models.length > 0, label: 'Stems', text: models.length ? `${models.join(' + ')} model ready` : 'No model yet: the STEMS buttons need one' },
    { ok: !!(tools.ytdlp && tools.ffmpeg), label: 'Downloads', text: tools.ytdlp && tools.ffmpeg ? 'Tools installed' : tools.slow ? 'Still checking the tools… (see the Downloads step)' : 'Tools not installed yet' },
  ];
}

/**
 * The steps: id, icon, title in the list, its one-line subtitle, the lead sentence on top of the
 * step, and what it shows.
 */
const STEPS = [
  { id: 'welcome', icon: 'collection', name: 'Welcome', sub: 'What gets set up', title: 'Welcome to Reboxed',
    lead: 'A few choices and you are ready to mix. Everything can be skipped and changed later.',
    build: async () => h('div.setup-cards', {},
      ...[['collection', 'Your music', 'Download folder and quality'],
        ['link', 'Your accounts', 'Spotify, Discogs and Gemini, all optional'],
        ['wave', 'Stems', 'Vocals, drums and bass apart'],
        ['download', 'Downloads', 'Three free tools in one click']]
        .map(([ic, name, text]) => h('div.setup-card', {}, h('span.setup-card-icon', {}, icon(ic)), h('b', {}, name), h('span', {}, text))),
    ) },
  { id: 'music', icon: 'collection', name: 'Your music', sub: 'Folder and quality', title: 'Your music',
    lead: 'Where downloaded tracks go, and in what quality.',
    build: (app) => musicStep(app) },
  { id: 'accounts', icon: 'link', name: 'Your accounts', sub: 'Spotify, Discogs, Gemini', title: 'Link your accounts',
    lead: 'Reboxed works without any account. Each one you link adds something; they all stay in Preferences ▸ Accounts.',
    build: async () => h('div', {}, await spotifySection(), await discogsSection(), await aiSection()) },
  { id: 'stems', icon: 'wave', name: 'Stems', sub: 'Separation models', title: 'Stems: vocals, drums and bass apart',
    lead: 'Download at least one model to use the STEMS buttons.',
    build: (app) => stemsSection(app.library, (k, v) => app.applySetting(k, v), app).then((el) => h('div', {},
      help('FAST starts at once, HQ sounds cleaner.', '"Test the engines" finds the fastest engine of this computer (CPU or GPU).'), el)) },
  { id: 'tools', icon: 'download', name: 'Downloads', sub: 'Free tools', title: 'Download tracks',
    lead: 'Downloading from YouTube, SoundCloud, Spotify or Deezer needs three free tools.',
    build: async (app) => h('div', {},
      help('Install them in one click.', 'yt-dlp downloads, ffmpeg converts to MP3 / FLAC and adds covers, deno is needed by YouTube for some videos.'),
      app.downloads.toolsPanel()) },
  { id: 'done', icon: 'check', name: 'Ready', sub: 'Summary', title: 'You are ready',
    lead: 'Add your music with "+ Folder" or "+ Files" (bottom left), or drop files on the window. Tracks are analysed as they arrive.',
    build: async (app, go) => {
      const rows = await readiness(app);
      return h('div', {},
        h('div.setup-summary', {}, ...rows.map((r) => h(`div.setup-sum${r.ok ? '.ok' : ''}`, {},
          h('span.setup-sum-mark', {}, r.ok ? '✓' : '○'), h('b', {}, r.label), h('span', {}, r.text)))),
        h('div.frow', {},
          h('button.dbtn.small', { onclick: () => go('accounts') }, 'Back to the accounts'),
          h('span.dim', {}, 'or later: Preferences ▸ Accounts. This assistant stays in Preferences ▸ General.')));
    } },
];

/** Open the assistant; resolves when it is closed (finished or skipped). */
export function openSetup(app) {
  return new Promise((resolve) => {
    let i = 0;
    const seen = new Set([0]);
    const rail = h('nav.setup-rail');
    const title = h('h2');
    const lead = h('p.setup-lead');
    const body = h('div.setup-body.settings-content');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.setup-dialog', { role: 'dialog' },
      rail, h('div.setup-main', {}, h('header.setup-head', {}, h('span.setup-count'), title, lead), body, buttons)));
    const finish = () => {
      app.library.setSetting('setupDone', true);
      overlay.remove();
      resolve();
    };
    const go = (to) => { i = typeof to === 'number' ? to : Math.max(0, STEPS.findIndex((s) => s.id === to)); seen.add(i); show(); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); e.stopPropagation(); });
    const show = async () => {
      const step = STEPS[i];
      rail.replaceChildren(h('div.setup-brand', {}, h('img', { src: 'assets/logo.svg', alt: '' }), h('span', {}, 'Setup')),
        ...STEPS.map((s, k) => h(`button.setup-step${k === i ? '.on' : ''}${seen.has(k) && k !== i ? '.seen' : ''}`, { type: 'button', onclick: () => go(k) },
          h('span.setup-num', {}, seen.has(k) && k < i ? '✓' : String(k + 1)),
          h('span.setup-step-text', {}, h('b', {}, s.name), h('small', {}, s.sub)))));
      overlay.querySelector('.setup-count').textContent = i === 0 || i === STEPS.length - 1 ? '' : `Step ${i} of ${STEPS.length - 2}`;
      title.textContent = step.title;
      lead.textContent = step.lead;
      body.replaceChildren(h('p.dim', {}, 'Loading…'));
      try {
        const content = await step.build(app, go);
        // Same row layout as Preferences: every value cell is a block.
        [...(content.matches('.form-grid') ? [content] : []), ...content.querySelectorAll('.form-grid')].forEach((g) => [...g.children].forEach((c, k) => {
          if (k % 2 === 1 && c.tagName !== 'DIV') { const w = document.createElement('div'); c.replaceWith(w); w.append(c); }
        }));
        body.replaceChildren(content);
        body.scrollTop = 0;
      } catch (err) { body.replaceChildren(h('p', {}, `This step could not open: ${err.message}`)); }
      const last = i === STEPS.length - 1;
      // only real buttons (an empty slot is left out, never shown as text)
      buttons.replaceChildren(...[
        i === 0 ? h('button', { onclick: finish }, 'Skip the setup') : h('button', { onclick: () => go(i - 1) }, 'Back'),
        h('span.spacer'),
        !last && i > 0 ? h('button', { onclick: () => go(i + 1) }, 'Skip this step') : null,
        h('button.primary', { onclick: () => { if (last) finish(); else go(i + 1); } }, last ? 'Start mixing' : i === 0 ? "Let's go" : 'Next'),
      ].filter(Boolean));
    };
    document.body.append(overlay);
    show().catch((err) => { toast(err.message); finish(); });
  });
}
