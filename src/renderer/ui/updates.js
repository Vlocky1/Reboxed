// Updates from GitHub: checked at startup (unless turned off), a pill in the top bar when a newer
// version exists, and a dialog that downloads the installer and restarts Reboxed on the new version.
import { h, toast } from './dom.js';

/** @returns {Promise<object|null>} the check result, null on error (shown unless silent) */
export async function checkForUpdates(app, { silent = false } = {}) {
  try {
    const info = await window.rb.update.check();
    app.updateInfo = info;
    app.refreshUpdatePill?.();
    if (!silent && !info.newer) toast(info.latest ? `Reboxed ${info.current} is up to date` : 'No release found on GitHub');
    return info;
  } catch (err) {
    if (!silent) toast(`Could not check for updates: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 6000);
    return null;
  }
}

/** Dialog: what is new, download with progress, then install and restart. */
export function openUpdateDialog(app, info = app.updateInfo) {
  if (!info?.newer) return null;
  return new Promise((resolve) => {
    const body = h('div.dialog-body.update-body');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.update-dialog', { role: 'dialog' }, h('h2', {}, `Reboxed ${info.latest} is available`), body, buttons));
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !busy) close(null); e.stopPropagation(); });
    let busy = false;
    const notes = h('pre.update-notes', {}, info.notes || 'See the release page for the changes.');
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    body.replaceChildren(
      h('p', {}, `You have ${info.current}. The update downloads the installer (${info.asset?.size ? mb(info.asset.size) : ''}), installs it and restarts Reboxed. Your library and settings are kept.`),
      notes);
    const later = h('button', { onclick: () => close(null) }, 'Later');
    const page = h('button', { onclick: () => window.rb.openExternal(info.page) }, 'Release page');
    const go = h('button.primary', {}, 'Download and install');
    go.onclick = async () => {
      busy = true;
      const bar = h('progress', { max: 1, value: 0 });
      const line = h('p.dim', {}, 'Downloading…');
      body.replaceChildren(line, bar);
      buttons.replaceChildren();
      const off = window.rb.update.onProgress((got, total) => { bar.value = total ? got / total : 0; line.textContent = `Downloading… ${mb(got)}${total ? ` / ${mb(total)}` : ''}`; });
      try {
        const file = await window.rb.update.download(info.asset);
        off();
        line.textContent = 'Installing… Reboxed closes and reopens on the new version.';
        await app.library.saveNow?.();
        await window.rb.update.install(file);
      } catch (err) {
        off();
        busy = false;
        body.replaceChildren(h('p.rbi-error', {}, `Update failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`));
        buttons.replaceChildren(page, h('button', { onclick: () => close(null) }, 'Close'));
      }
    };
    buttons.append(page, later, go);
    document.body.append(overlay);
    go.focus();
  });
}

export const LINKS = {
  github: 'https://github.com/Vlocky1/Reboxed',
  releases: 'https://github.com/Vlocky1/Reboxed/releases',
  issues: 'https://github.com/Vlocky1/Reboxed/issues',
  website: 'https://vlocky1.github.io/',
  instagram: 'https://www.instagram.com/rebox.ed/',
};

/** Preferences > About: version, Check for updates (and install), links, credits. */
export function aboutSection(app, version) {
  const s = app.library.settings;
  const status = h('div.about-status');
  const showInfo = (info) => {
    if (!info) { status.replaceChildren(h('span.rbi-error', {}, 'Could not reach GitHub. Check the connection and try again.')); return; }
    status.replaceChildren(info.newer
      ? h('div.about-new', {}, h('span', {}, `Reboxed ${info.latest} is available (you have ${info.current}).`),
        h('button.dbtn.primary', { type: 'button', onclick: () => openUpdateDialog(app, info) }, `Install ${info.latest}…`))
      : h('span.about-ok', {}, !info.latest ? 'No release found on GitHub.'
        : info.latest === info.current ? `✓ Reboxed ${info.current} is the latest version.`
          : `✓ Up to date (you have ${info.current}, the latest release is ${info.latest}).`));
  };
  const check = h('button.dbtn.primary.about-check', { type: 'button' }, 'Check for updates');
  check.onclick = async () => {
    check.disabled = true;
    status.replaceChildren(h('span.dim', {}, 'Checking GitHub…'));
    showInfo(await checkForUpdates(app, { silent: true }));
    check.disabled = false;
  };
  if (app.updateInfo) showInfo(app.updateInfo);
  const link = (label, url) => h('button.dbtn', { type: 'button', title: url, onclick: () => window.rb.openExternal(url) }, label);
  return h('div', {},
    h('div.about-card', {},
      h('img.about-logo', { src: 'assets/logo.svg', alt: '' }),
      h('div', {},
        h('div.about-name', {}, 're', h('b', {}, 'box'), 'ed'),
        h('div.about-version', {}, `Version ${version}`),
        h('div.dim', {}, 'Free and open-source DJ software (MIT licence).'))),
    h('h4', {}, 'Updates'),
    h('div.form-grid', {},
      h('label', {}, 'New version'), h('div', {}, h('div.frow', {}, check), status),
      h('label', {}, 'Check at startup'), h('input', { type: 'checkbox', checked: s.checkUpdates !== false, onchange: (e) => app.library.setSetting('checkUpdates', e.target.checked) })),
    h('h4', {}, 'Links'),
    h('div.about-links', {}, link('Website', LINKS.website), link('GitHub', LINKS.github), link('Release notes', LINKS.releases), link('Report a bug', LINKS.issues), link('Instagram @rebox.ed', LINKS.instagram)),
    h('h4', {}, 'Credits'),
    h('p.dim', {}, 'Stems: Spleeter (Deezer) and HT-Demucs (Meta) models, run with ONNX Runtime. Downloads: yt-dlp, ffmpeg and deno, fetched from their own releases. ',
      'Not affiliated with AlphaTheta / Pioneer DJ; rekordbox and CDJ are their trademarks.'));
}
