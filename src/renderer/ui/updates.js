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

/** Preferences > General rows: check at startup, check now. */
export function updateSettings(app) {
  const s = app.library.settings;
  const status = h('span.dim', {}, app.updateInfo ? (app.updateInfo.newer ? `Reboxed ${app.updateInfo.latest} is available.` : `Up to date (${app.updateInfo.current}).`) : '');
  const now = h('button.dbtn.small', { type: 'button' }, 'Check now');
  now.onclick = async () => {
    now.disabled = true; status.textContent = 'Checking GitHub…';
    const info = await checkForUpdates(app, { silent: true });
    now.disabled = false;
    if (!info) { status.textContent = 'Could not reach GitHub.'; return; }
    status.replaceChildren(info.newer
      ? h('span', {}, `Reboxed ${info.latest} is available. `, h('button.dbtn.small', { type: 'button', onclick: () => openUpdateDialog(app, info) }, 'Install…'))
      : document.createTextNode(`Up to date (${info.current}).`));
  };
  return [
    h('label', {}, 'Check for updates at startup'), h('div', {}, h('input', { type: 'checkbox', checked: s.checkUpdates !== false, onchange: (e) => app.library.setSetting('checkUpdates', e.target.checked) })),
    h('label', {}, 'Updates'), h('div', {}, h('div.frow', {}, now, status)),
  ];
}
