// "Send to another Reboxed" (export the music and an XML to a USB drive) and "Import from another
// Reboxed" (copy that music into a local folder, keep cues, grids, tags and playlists).
import { h, modal, toast } from './dom.js';
import { exportRekordboxXml, importRekordboxXml } from '../../shared/rekordbox-xml.js';
import { collectForTransfer, needsCopy, transferCandidates, pickFound, TRANSFER_MUSIC } from '../../shared/transfer.js';
import { today } from '../library.js';

/**
 * Export dialog. preselect: playlist ids ticked when the dialog opens (null = whole collection).
 * opts.dir: destination chosen beforehand (the smoke test), no folder picker.
 */
export async function openTransferExport(app, preselect = null, opts = {}) {
  const lib = app.library;
  const picked = new Set(preselect ?? []);
  const scope = { value: preselect ? 'some' : 'all' };
  const list = h('div.transfer-list');
  const renderList = () => {
    const rows = [];
    const walk = (nodes, depth) => nodes.forEach((n) => {
      if (n.type === 'folder') { rows.push(h('div.transfer-folder', { style: { paddingLeft: `${depth * 14}px` } }, `▾ ${n.name}`)); walk(n.children, depth + 1); return; }
      const box = h('input', { type: 'checkbox', checked: picked.has(n.id), onchange: (e) => { if (e.target.checked) picked.add(n.id); else picked.delete(n.id); scope.value = 'some'; radios.some.checked = true; } });
      const count = n.type === 'smart' ? lib.rowsFor(n.id).length : n.trackIds.length;
      rows.push(h('label.transfer-row', { style: { paddingLeft: `${depth * 14}px` } }, box, h('span', {}, n.name), h('span.dim', {}, ` ${count}`)));
    });
    walk(lib.playlists, 0);
    list.replaceChildren(...(rows.length ? rows : [h('p.dim', {}, 'No playlists yet.')]));
  };
  const radio = (v) => h('input', { type: 'radio', name: 'transfer-scope', value: v, checked: scope.value === v, onchange: () => { scope.value = v; } });
  const radios = { all: radio('all'), some: radio('some') };
  renderList();
  const copy = h('input', { type: 'checkbox', checked: true });
  const ok = await modal('Send to another Reboxed', h('div.transfer', {},
    h('p', {}, 'Puts the music and an XML file (playlists, cues, beatgrids, ratings, colours, tags, comments) on a USB drive. On the other computer: ⋯ ▸ "Import from another Reboxed…" copies the music into a folder there and keeps all of it.'),
    h('label.transfer-row', {}, radios.all, h('b', {}, 'The whole collection'), h('span.dim', {}, ` ${lib.tracks.size} tracks, every playlist`)),
    h('label.transfer-row', {}, radios.some, h('b', {}, 'Only these playlists')),
    list,
    h('label.transfer-row', {}, copy, h('span', {}, 'Copy the music onto the drive '), h('span.dim', {}, '(tracks already on that drive are not copied again)'))),
  [{ label: opts.dir ? 'Send' : 'Choose the drive or folder…', primary: true, value: true }, { label: 'Cancel', value: null }]);
  if (!ok) return null;
  if (scope.value === 'some' && !picked.size) { toast('Tick at least one playlist'); return null; }
  const dir = opts.dir ?? (await window.rb.openFolder())[0];
  if (!dir) return null;
  const folder = `${dir.replace(/[\\/]+$/, '')}\\Reboxed Transfer`;
  const { tracks, playlists } = collectForTransfer(lib, scope.value === 'some' ? picked : null);
  const out = [];
  let failed = 0;
  const status = toast(`Copying 0 / ${tracks.length}…`, 600000);
  for (const [i, t] of tracks.entries()) {
    status.textContent = `Copying the music ${i + 1} / ${tracks.length}…`;
    let path = t.path;
    if (copy.checked && needsCopy(t.path, folder)) {
      try { path = await window.rb.copyInto(t.path, `${folder}\\${TRANSFER_MUSIC}`); } catch { failed++; continue; }
    }
    out.push({ ...t, path });
  }
  const xmlPath = `${folder}\\reboxed-transfer.xml`;
  await window.rb.writeFile(xmlPath, exportRekordboxXml({ tracks: out, playlists }, { productVersion: await window.rb.version() }));
  status.remove();
  toast(`${out.length} track(s) and ${countPlaylists(playlists)} playlist(s) sent to ${folder}${failed ? ` · ${failed} file(s) could not be copied` : ''}`, 8000);
  if (!opts.dir) window.rb.showItem(xmlPath);
  return { xmlPath, tracks: out.length, failed };
}

const countPlaylists = (nodes) => nodes.reduce((n, x) => n + (x.type === 'folder' ? countPlaylists(x.children) : 1), 0);

/**
 * Import a transfer XML: copy its music to a local folder, then bring tracks and playlists in.
 * opts.xmlPath / opts.dest: chosen beforehand (the smoke test).
 */
export async function openTransferImport(app, opts = {}) {
  const xmlPath = opts.xmlPath ?? (await window.rb.openFiles('xml'))[0];
  if (!xmlPath) return null;
  let parsed;
  try { parsed = importRekordboxXml(await window.rb.readText(xmlPath)); } catch (err) { toast(`Not a Reboxed / DJ library XML: ${err.message}`, 6000); return null; }
  const paths = parsed.tracks.map((t) => t.path).filter(Boolean);
  const candidates = paths.map((p) => transferCandidates(p, xmlPath));
  const found = pickFound(paths, candidates, await window.rb.existsMany(candidates.flat()));
  const { music } = await window.rb.paths();
  let dest = opts.dest ?? `${music}\\Reboxed Imports`;
  const destEl = h('code.path', {}, dest);
  const ok = await modal('Import from another Reboxed', h('div.transfer', {},
    h('p', {}, `${parsed.tracks.length} track(s), ${countPlaylists(parsed.playlists)} playlist(s). Music found: ${found.size} / ${paths.length}.`),
    h('p', {}, 'The music is copied to this folder (so it stays here once the USB drive is gone):'),
    h('div', {}, destEl, ' ', h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { dest = d; destEl.textContent = d; } } }, 'Change…')),
    h('p.dim', {}, 'Cues, beatgrids, ratings, colours, tags and comments are kept; the playlists go into a folder "Imported <date>". Tracks already in your collection are updated.')),
  [{ label: 'Copy and import', primary: true, value: true }, { label: 'Cancel', value: null }]);
  if (!ok) return null;
  const relocated = new Map();
  const status = toast('Copying…', 600000);
  let k = 0;
  for (const [key, from] of found) {
    status.textContent = `Copying the music ${++k} / ${found.size}…`;
    try { relocated.set(key, await window.rb.copyInto(from, dest)); } catch { /* reported as missing */ }
  }
  status.remove();
  const missing = new Set(paths.filter((p) => !relocated.has(p.toLowerCase()) && !relocated.has(p)).map((p) => (/^[A-Za-z]:\\/.test(p) ? p.toLowerCase() : p)));
  const report = app.library.importRekordbox(parsed, { placement: 'new', metadata: 'overwrite', cues: 'replace', relocated, missing });
  const fresh = app.library.all().filter((t) => !t.analyzed && [...relocated.values()].includes(t.path)).map((t) => t.id);
  if (fresh.length && app.library.settings.autoAnalyze) app.analyzeTracks(fresh);
  if (report.folderId) app.browser.select(report.folderId);
  toast(`Imported ${today()}: ${report.added} new, ${report.updated} updated, ${report.playlists} playlist(s)${report.missing ? ` · ${report.missing} track(s) not found on the drive` : ''}`, 8000);
  return report;
}
