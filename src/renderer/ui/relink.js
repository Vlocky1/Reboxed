// "Link my tracks to a music folder": the collection uses the copies on a USB drive (e.g. J:\Tracks)
// instead of local files. Cues, analysis, playlists stay (they belong to the track, not the file);
// stems move along; tracks only found on the drive can be added; local copies can go to the bin.
import { h, toast } from './dom.js';
import { planRelink } from '../../shared/relink.js';

const DEFAULT_DIR = 'J:\\Tracks';

/** @returns {Promise<object|null>} report, or null when cancelled */
export async function openRelink(app, dir = null) {
  const lib = app.library;
  if (!dir) dir = (await window.rb.exists(DEFAULT_DIR)) ? DEFAULT_DIR : null;

  return new Promise((resolve) => {
    const title = h('h2', {}, 'Link my tracks to a music folder');
    const body = h('div.dialog-body.rbi');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.rbi-dialog', { role: 'dialog' }, title, body, buttons));
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    const setButtons = (list) => buttons.replaceChildren(...list.map((b) => h(`button${b.primary ? '.primary' : ''}`, { onclick: b.onclick, disabled: b.disabled }, b.label)));
    const choose = async () => { const [d] = await window.rb.openFolder(); if (d) scan(d); };

    function start() {
      body.replaceChildren(
        h('p', {}, 'Choose the folder that holds your music (for example your USB key ', h('code', {}, DEFAULT_DIR), ').'),
        h('p.dim', {}, 'Tracks of the collection found there (same file name) will be played from there. Their cues, tags, analysis and playlists are kept.'));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }, { label: 'Choose folder…', primary: true, onclick: choose }]);
    }

    let plan = null;
    async function scan(folder) {
      dir = folder;
      title.textContent = `Link my tracks to ${dir}`;
      body.replaceChildren(h('p.dim', {}, `Listing the music in ${dir}…`));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }]);
      let files;
      try { files = await window.rb.listAudio(dir); } catch (err) { body.replaceChildren(h('p.rbi-error', {}, err.message)); return; }
      plan = planRelink(lib.all(), files, dir);
      preview(files.length);
    }

    function preview(nFiles) {
      const unsure = plan.matches.filter((m) => !m.sure);
      const stat = (n, label) => h('div.rbi-stat', {}, h('b', {}, n.toLocaleString()), h('span', {}, label));
      const opt = (label, checked, hint) => {
        const box = h('input', { type: 'checkbox', checked });
        return [box, h('label.rbi-opt', {}, box, h('span', {}, label, hint ? h('small', {}, hint) : null))];
      };
      const [stemsHere, stemsHereEl] = opt(`Keep the stems in ${dir}\\stems`, true, 'the stems folder of the library becomes this one (analysed stems move there)');
      const [addNew, addNewEl] = opt(`Add the ${plan.newFiles.length} track(s) found only in ${dir} to the collection`, plan.newFiles.length > 0);
      const [trash, trashEl] = opt(`Send the ${plan.matches.filter((m) => m.sure).length} local copies to the Recycle Bin`, false, 'only files certainly identical (same name and size); recoverable from the bin');
      body.replaceChildren(...[
        h('div.rbi-stats', {},
          stat(nFiles, 'files in the folder'), stat(plan.matches.length, 'tracks to link'), stat(unsure.length, 'unsure (tags differ)'),
          stat(plan.already.length, 'already there'), stat(plan.newFiles.length, 'new on the drive'), stat(plan.notFound.length, 'not on the drive')),
        unsure.length ? h('details.rbi-list', {}, h('summary', {}, 'Unsure matches (same name, different size) — linked too'),
          ...unsure.slice(0, 200).map((m) => h('div', {}, m.from, h('span.dim', {}, `  →  ${m.to}`)))) : null,
        plan.notFound.length ? h('details.rbi-list', {}, h('summary', {}, 'Tracks not found in this folder (they stay where they are)'),
          ...plan.notFound.slice(0, 200).map((id) => h('div', {}, lib.get(id)?.path ?? id))) : null,
        h('div.rbi-col', {}, stemsHereEl, addNewEl, trashEl)].filter(Boolean));
      setButtons([
        { label: 'Other folder…', onclick: choose },
        { label: 'Cancel', onclick: () => close(null) },
        { label: `Link ${plan.matches.length} track(s)`, primary: true, disabled: !plan.matches.length && !plan.newFiles.length, onclick: () => apply({ stemsHere: stemsHere.checked, addNew: addNew.checked, trash: trash.checked }) },
      ]);
    }

    async function apply(o) {
      setButtons([]);
      const status = h('p.dim', {}, 'Linking…');
      body.replaceChildren(status);
      const report = { linked: 0, stemsMoved: 0, added: 0, trashed: 0 };
      if (o.stemsHere) await window.rb.storage.setStems('custom', `${dir}\\stems`, true);
      for (const [k, m] of plan.matches.entries()) {
        lib.relink(m.id, m.to);
        report.linked++;
        try { if (await window.rb.stems.relocate(m.id, m.from, m.to)) report.stemsMoved++; } catch (err) { console.warn('stems not moved', m.from, err); }
        if (k % 20 === 0) status.textContent = `Linking ${k + 1}/${plan.matches.length}…`;
      }
      // Decks holding a linked track keep playing their loaded audio; the new path is used next load.
      if (o.addNew && plan.newFiles.length) { status.textContent = 'Adding the new tracks…'; report.added = (await app.importPaths(plan.newFiles)).length; }
      if (o.trash) report.trashed = await window.rb.trash(plan.matches.filter((m) => m.sure).map((m) => m.from));
      await lib.saveNow();
      title.textContent = 'Tracks linked';
      body.replaceChildren(h('ul.rbi-report', {},
        h('li', {}, h('b', {}, String(report.linked)), ` tracks now play from ${dir}`),
        h('li', {}, h('b', {}, String(report.stemsMoved)), ' stems folders moved'),
        h('li', {}, h('b', {}, String(report.added)), ' new tracks added'),
        o.trash ? h('li', {}, h('b', {}, String(report.trashed)), ' local copies sent to the Recycle Bin') : null));
      toast(`${report.linked} track(s) linked to ${dir}`);
      setButtons([{ label: 'Close', primary: true, onclick: () => close(report) }]);
    }

    document.body.append(overlay);
    if (dir) scan(dir); else start();
  });
}
