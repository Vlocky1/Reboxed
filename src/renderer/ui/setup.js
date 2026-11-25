// Setup assistant, on the first launch with an empty library (Preferences > General opens it
// again). A step list on the left, one step at a time on the right: your music, your accounts (the
// online services, as in Preferences > Accounts), stems, download tools, then a summary of what is
// ready. Every step can be skipped, the whole assistant too; everything stays in Preferences.
import { errText, tx } from '../../shared/i18n.js';
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
    h('label', {}, tx('Download quality')), h('select', { onchange: (e) => save({ format: e.target.value, formatChosen: true }) },
      FORMAT_LABELS.map(([v, l]) => h('option', { value: v, selected: cfg().format === v }, l))),
    h('label', {}, tx('Downloaded tracks go to')), h('div', {}, folder, ' ',
      h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { save({ folder: d }); show(); } } }, tx('Change…'))),
    h('label', {}, tx('Library (cues, analysis…)')), h('div', {}, h('code.path', {}, info.databaseDir),
      h('small.hint', {}, tx('It can live on a USB drive (Preferences > Library).'))));
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
    { ok: true, label: tx('Your music'), text: tx('Folders and quality chosen') },
    { ok: !!acct.signedIn, label: 'Spotify', text: acct.signedIn ? tx`Connected${acct.user ? tx` as ${acct.user}` : ''}` : sp.clientId && sp.hasSecret ? tx('Keys saved, account not connected') : tx('Not linked (optional)') },
    { ok: !!dg.hasToken, label: 'Discogs', text: dg.hasToken ? tx('Linked') : tx('Not linked (optional)') },
    { ok: !!ai.hasKey, label: 'Gemini', text: ai.hasKey ? tx('Linked') : tx('Not linked (optional)') },
    { ok: models.length > 0, label: 'Stems', text: models.length ? tx`${models.join(' + ')} model ready` : tx('No model yet: the STEMS buttons need one') },
    { ok: !!(tools.ytdlp && tools.ffmpeg), label: tx('Downloads'), text: tools.ytdlp && tools.ffmpeg ? tx('Tools installed') : tools.slow ? tx('Still checking the tools… (see the Downloads step)') : tx('Tools not installed yet') },
  ];
}

/**
 * The steps: id, icon, title in the list, its one-line subtitle, the lead sentence on top of the
 * step, and what it shows.
 */
const STEPS = [
  { id: 'welcome', icon: 'collection', name: tx('Welcome'), sub: tx('What gets set up'), title: tx('Welcome to Reboxed'),
    lead: tx('A few choices and you are ready to mix. Everything can be skipped and changed later.'),
    build: async () => h('div.setup-cards', {},
      ...[['collection', tx('Your music'), tx('Download folder and quality')],
        ['link', tx('Your accounts'), tx('Spotify, Discogs and Gemini, all optional')],
        ['wave', 'Stems', tx('Vocals, drums and bass apart')],
        ['download', tx('Downloads'), tx('Three free tools in one click')]]
        .map(([ic, name, text]) => h('div.setup-card', {}, h('span.setup-card-icon', {}, icon(ic)), h('b', {}, name), h('span', {}, text))),
    ) },
  { id: 'music', icon: 'collection', name: tx('Your music'), sub: tx('Folder and quality'), title: tx('Your music'),
    lead: tx('Where downloaded tracks go, and in what quality.'),
    build: (app) => musicStep(app) },
  { id: 'accounts', icon: 'link', name: tx('Your accounts'), sub: 'Spotify, Discogs, Gemini', title: tx('Link your accounts'),
    lead: tx('Reboxed works without any account. Each one you link adds something; they all stay in Preferences ▸ Accounts.'),
    build: async () => h('div', {}, await spotifySection(), await discogsSection(), await aiSection()) },
  { id: 'stems', icon: 'wave', name: 'Stems', sub: tx('Separation models'), title: tx('Stems: vocals, drums and bass apart'),
    lead: tx('Download at least one model to use the STEMS buttons.'),
    build: (app) => stemsSection(app.library, (k, v) => app.applySetting(k, v), app).then((el) => h('div', {},
      help(tx('FAST starts at once, HQ sounds cleaner.'), tx('"Test the engines" finds the fastest engine of this computer (CPU or GPU).')), el)) },
  { id: 'tools', icon: 'download', name: tx('Downloads'), sub: tx('Free tools'), title: tx('Download tracks'),
    lead: tx('Downloading from YouTube, SoundCloud, Spotify or Deezer needs three free tools.'),
    build: async (app) => h('div', {},
      help(tx('Install them in one click.'), tx('yt-dlp downloads, ffmpeg converts to MP3 / FLAC and adds covers, deno is needed by YouTube for some videos.')),
      app.downloads.toolsPanel()) },
  { id: 'done', icon: 'check', name: tx('Ready'), sub: tx('Summary'), title: tx('You are ready'),
    lead: tx('Add your music with "+ Folder" or "+ Files" (bottom left), or drop files on the window. Tracks are analysed as they arrive.'),
    build: async (app, go) => {
      const rows = await readiness(app);
      return h('div', {},
        h('div.setup-summary', {}, ...rows.map((r) => h(`div.setup-sum${r.ok ? '.ok' : ''}`, {},
          h('span.setup-sum-mark', {}, r.ok ? '✓' : '○'), h('b', {}, r.label), h('span', {}, r.text)))),
        h('div.frow', {},
          h('button.dbtn.small', { onclick: () => go('accounts') }, tx('Back to the accounts')),
          h('span.dim', {}, tx('or later: Preferences ▸ Accounts. This assistant stays in Preferences ▸ General.'))));
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
      rail.replaceChildren(h('div.setup-brand', {}, h('img', { src: 'assets/logo.svg', alt: '' }), h('span', {}, tx('Setup'))),
        ...STEPS.map((s, k) => h(`button.setup-step${k === i ? '.on' : ''}${seen.has(k) && k !== i ? '.seen' : ''}`, { type: 'button', onclick: () => go(k) },
          h('span.setup-num', {}, seen.has(k) && k < i ? '✓' : String(k + 1)),
          h('span.setup-step-text', {}, h('b', {}, s.name), h('small', {}, s.sub)))));
      overlay.querySelector('.setup-count').textContent = i === 0 || i === STEPS.length - 1 ? '' : tx`Step ${i} of ${STEPS.length - 2}`;
      title.textContent = step.title;
      lead.textContent = step.lead;
      body.replaceChildren(h('p.dim', {}, tx('Loading…')));
      try {
        const content = await step.build(app, go);
        // Same row layout as Preferences: every value cell is a block.
        [...(content.matches('.form-grid') ? [content] : []), ...content.querySelectorAll('.form-grid')].forEach((g) => [...g.children].forEach((c, k) => {
          if (k % 2 === 1 && c.tagName !== 'DIV') { const w = document.createElement('div'); c.replaceWith(w); w.append(c); }
        }));
        body.replaceChildren(content);
        body.scrollTop = 0;
      } catch (err) { body.replaceChildren(h('p', {}, tx`This step could not open: ${errText(err)}`)); }
      const last = i === STEPS.length - 1;
      // only real buttons (an empty slot is left out, never shown as text)
      buttons.replaceChildren(...[
        i === 0 ? h('button', { onclick: finish }, tx('Skip the setup')) : h('button', { onclick: () => go(i - 1) }, tx('Back')),
        h('span.spacer'),
        !last && i > 0 ? h('button', { onclick: () => go(i + 1) }, tx('Skip this step')) : null,
        h('button.primary', { onclick: () => { if (last) finish(); else go(i + 1); } }, last ? tx('Start mixing') : i === 0 ? tx("Let's go") : tx('Next')),
      ].filter(Boolean));
    };
    document.body.append(overlay);
    show().catch((err) => { toast(errText(err)); finish(); });
  });
}
