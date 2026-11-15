// "Export to USB (CDJ / XDJ)": writes a drive Pioneer players can read (export.pdb, analysis files
// with beat grid, coloured hot cues, memory cues and waveforms, artwork, My Settings).
import { h, toast, modal, help } from './dom.js';
import { PLAYER_SETTINGS, MIXER_SETTINGS, defaultSettings } from '../../shared/cdj/mysettings.js';

const GROUPS = [
  ['Display', ['waveformColor', 'overviewWaveform', 'waveformCurrentPosition', 'keyDisplayFormat', 'waveformDivisions', 'waveformOrPhaseMeter', 'jogDisplayMode', 'phaseMeter', 'timeMode', 'language']],
  ['Playback', ['jogMode', 'vinylSpeedAdjust', 'quantize', 'quantizeBeatValue', 'beatJumpBeatValue', 'sync', 'masterTempo', 'tempoRange', 'autoCue', 'autoCueLevel', 'hotCueAutoload', 'hotCueColor', 'playMode', 'needleLock', 'ejectLock']],
  ['Lights', ['lcdBrightness', 'jogLcdBrightness', 'padButtonBrightness', 'jogRingBrightness', 'jogRingIndicator', 'slipFlashing', 'discSlotIllumination', 'onAirDisplay']],
  ['Mixer (DJM)', Object.keys(MIXER_SETTINGS)],
];

/** Playlists -> plain tree with track ids (intelligent playlists take their current contents). */
function resolveTree(lib, nodes, keep) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'folder') {
      const children = resolveTree(lib, n.children, keep);
      if (children.length) out.push({ type: 'folder', name: n.name, children });
    } else if (keep(n.id)) {
      out.push({ type: 'playlist', name: n.name, trackIds: n.type === 'smart' ? lib.rowsFor(n.id).map((r) => r.track.id) : [...n.trackIds] });
    }
  }
  return out;
}

export async function openCdjExport(app) {
  const lib = app.library;
  const settings = { ...defaultSettings(), ...(lib.settings.cdjSettings ?? {}) };
  const drives = await window.rb.cdj.drives().catch(() => []);
  let root = drives[0]?.root ?? null;
  const selected = new Set();
  const walk = (nodes, fn) => nodes.forEach((n) => { fn(n); if (n.type === 'folder') walk(n.children, fn); });
  walk(lib.playlists, (n) => { if (n.type !== 'folder') selected.add(n.id); });
  let whole = true;

  return new Promise((resolve) => {
    const title = h('h2', {}, 'Export to USB for DJ players');
    const body = h('div.dialog-body.rbi.cdjx');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.rbi-dialog.cdjx-dialog', { role: 'dialog' }, title, body, buttons));
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    const setButtons = (list) => buttons.replaceChildren(...list.map((b) => h(`button${b.primary ? '.primary' : ''}`, { onclick: b.onclick, disabled: b.disabled }, b.label)));

    // the chosen drive: made by the other DJ software? earlier exports that can be undone?
    const driveInfo = h('div.cdjx-driveinfo');
    const showDriveInfo = () => {
      const d = drives.find((x) => x.root === root);
      driveInfo.replaceChildren(...[
        d?.otherSoftware ? h('div.cdjx-warn', {},
          h('b', {}, 'This drive was made by your other DJ software.'),
          help('Exporting here replaces its library on the drive (a backup is kept, and the export can be undone). To use the drive in that software, give it your collection as XML instead.',
            { steps: ['Close this window and click "Export collection as XML…" (⋯ menu above the playlists).', 'In your other DJ software, import that XML file, then export the drive from there.'],
              notes: ['This window is for players read straight from the USB drive.'] }),
          h('button.dbtn.small', { onclick: () => { close(null); app.exportXml(); } }, 'Export collection as XML instead…')) : null,
        d?.backups ? h('div.frow', {}, h('span.dim', {}, `${d.backups} earlier export(s) on this drive can be undone.`),
          h('button.dbtn.small', { onclick: () => undoMenu() }, 'Undo an earlier export…')) : null,
      ].filter(Boolean));
    };
    const undoMenu = async () => {
      const list = await window.rb.cdj.backups(root).catch(() => []);
      if (!list.length) { toast('Nothing to undo on this drive'); return; }
      const b = list[0];
      const ok = await modal('Undo the last export',
        h('div', {}, h('p', {}, `Puts the drive back as it was before the export of ${b.name.replace(/^backup-/, '').replace(/T(\d\d)-(\d\d).*/, ' $1:$2')} (UTC).`),
          help('Nothing is deleted.', 'Reboxed\'s database and the files it created are moved to a folder "reboxed-undone-<date>" next to the backup; the previous databases and the files it had overwritten come back.')),
        [{ label: 'Undo it', primary: true, value: true }, { label: 'Cancel', value: null }]);
      if (!ok) return;
      try {
        const r = await window.rb.cdj.undo(root, b.dir);
        toast(`Drive put back: ${r.restored} file(s) restored, Reboxed's export kept aside in ${r.dir}`, 9000);
        const fresh = await window.rb.cdj.drives().catch(() => drives);
        drives.splice(0, drives.length, ...fresh);
        showDriveInfo();
      } catch (err) { toast(`Undo failed: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 8000); }
    };
    const driveSel = h('select', { onchange: (e) => { root = e.target.value || null; showDriveInfo(); } },
      drives.length ? drives.map((d) => h('option', { value: d.root, selected: d.root === root }, `${d.root}${d.otherSoftware ? '  (made by your other DJ software)' : d.hasExport ? '  (has an export: it will be backed up)' : ''}`)) : h('option', { value: '' }, 'No drive found'));
    const other = h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { root = d; driveSel.append(h('option', { value: d, selected: true }, d)); } } }, 'Other folder…');

    const tree = h('div.rbi-tree');
    const renderTree = () => {
      const rows = [];
      const add = (nodes, depth) => nodes.forEach((n) => {
        if (n.type === 'folder') { rows.push(h('div.rbi-node', { style: { paddingLeft: `${4 + depth * 16}px` } }, `▾ ${n.name}`)); add(n.children, depth + 1); return; }
        rows.push(h('label.rbi-node', { style: { paddingLeft: `${4 + depth * 16}px` } },
          h('input', { type: 'checkbox', checked: selected.has(n.id), onchange: (e) => { if (e.target.checked) selected.add(n.id); else selected.delete(n.id); } }),
          h('span.rbi-name', {}, n.name), h('span.dim', {}, n.type === 'smart' ? 'intelligent' : String(n.trackIds.length))));
      });
      add(lib.playlists, 0);
      tree.replaceChildren(...(rows.length ? rows : [h('p.dim', {}, 'No playlists.')]));
    };
    renderTree();

    const all = { ...PLAYER_SETTINGS, ...MIXER_SETTINGS };
    const form = GROUPS.map(([name, keys]) => h('details.cdjx-group', { open: name === 'Display' },
      h('summary', {}, name),
      h('div.form-grid', {}, keys.flatMap((k) => [h('label', {}, all[k].label), h('select', { onchange: (e) => { settings[k] = e.target.value; } },
        Object.keys(all[k].choices).map((c) => h('option', { value: c, selected: settings[k] === c }, c)))]))));

    function start() {
      body.replaceChildren(
        h('div.form-grid', {}, h('label', {}, 'Drive'), h('div', {}, driveSel, ' ', other)),
        driveInfo,
        h('p.dim', {}, 'For DJ players read straight from the USB drive. Tracks already on the drive stay where they are, the others are copied. Everything the export changes is backed up and can be undone.'),
        h('div.rbi-cols', {},
          h('div.rbi-col', {},
            h('h3', {}, 'What to export'),
            h('label.rbi-opt', {}, h('input', { type: 'radio', name: 'cdjx-what', checked: whole, onchange: () => { whole = true; } }), h('span', {}, 'The whole collection, with the selected playlists')),
            h('label.rbi-opt', {}, h('input', { type: 'radio', name: 'cdjx-what', checked: !whole, onchange: () => { whole = false; } }), h('span', {}, 'Only the tracks of the selected playlists')),
            h('h3', {}, 'Playlists'), tree),
          h('div.rbi-col', {}, h('h3', {}, 'Player settings (My Settings)'),
            h('p.dim', {}, 'Loaded by the players when the drive is inserted.'),
            ...form,
            h('button.dbtn.small', { onclick: () => { Object.assign(settings, defaultSettings()); start(); } }, 'Reset to defaults'))));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }, { label: 'Export', primary: true, onclick: () => run() }]);
      showDriveInfo();
    }

    async function run() {
      if (!root) { toast('Choose a drive first'); return; }
      lib.setSetting('cdjSettings', settings);
      const playlists = resolveTree(lib, lib.playlists, (id) => selected.has(id));
      const ids = new Set();
      if (whole) lib.all().forEach((t) => ids.add(t.id));
      walk(playlists, (n) => { if (n.type === 'playlist') n.trackIds.forEach((id) => ids.add(id)); });
      const tracks = [...ids].map((id) => lib.get(id)).filter(Boolean).map((t) => ({ ...t, features: undefined }));
      const line = h('p.dim', {}, 'Preparing…');
      const bar = h('progress', { max: 1, value: 0 });
      body.replaceChildren(line, bar);
      setButtons([]);
      const off = window.rb.cdj.onProgress((p) => {
        bar.value = p.total ? p.done / p.total : 0;
        line.textContent = p.phase === 'tracks' ? `Track ${p.done} / ${p.total}: ${p.file ?? ''}` : p.phase === 'database' ? 'Writing the database…' : 'Done';
      });
      try {
        const r = await window.rb.cdj.export({ root, tracks, playlists, settings });
        title.textContent = 'Drive ready for DJ players';
        body.replaceChildren(h('ul.rbi-report', {},
          h('li', {}, h('b', {}, String(r.tracks)), ' tracks exported'),
          h('li', {}, h('b', {}, String(r.inPlace)), ' already on the drive, ', h('b', {}, String(r.copied)), ' copied'),
          h('li', {}, h('b', {}, String(r.playlists)), ' playlists'),
          r.missing.length ? h('li', {}, h('b', {}, String(r.missing.length)), ' missing files skipped') : null,
          r.backup ? h('li', {}, 'What was on the drive before is kept in ', h('code', {}, r.backup)) : null),
        h('p.dim', {}, 'Eject the drive safely before plugging it into the player.'));
        setButtons([
          ...(r.backup ? [{ label: 'Undo this export', onclick: async () => {
            const fresh = await window.rb.cdj.drives().catch(() => drives);
            drives.splice(0, drives.length, ...fresh);
            await undoMenu();
            close(r);
          } }] : []),
          { label: 'Close', primary: true, onclick: () => close(r) }]);
      } catch (err) {
        body.replaceChildren(h('p.rbi-error', {}, `Export failed: ${err.message}`));
        setButtons([{ label: 'Back', onclick: () => start() }, { label: 'Close', onclick: () => close(null) }]);
      } finally { off(); }
    }

    document.body.append(overlay);
    start();
  });
}
