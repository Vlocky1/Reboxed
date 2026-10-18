// "Import from rekordbox" tool: pick the rekordbox.xml export, preview what it holds, choose the
// playlists and merge rules, find moved music files, then import and report.
import { h, toast } from './dom.js';
import { icon } from './icons.js';
import { importRekordboxXml, summarizeRekordbox } from '../../shared/rekordbox-xml.js';
import { forEachNode, selectPlaylists, playlistPaths, remapPath, inferRules } from '../../shared/rekordbox-import.js';

const DEFAULTS = { scope: 'all', metadata: 'overwrite', cues: 'replace', beatgrid: true, placement: 'sync', analyze: true };
const keyOf = (p) => (/^[A-Za-z]:\\/.test(p) ? p.toLowerCase() : p);
const baseName = (p) => p.split(/[\\/]/).pop();

/**
 * @param {object} app RBClone app (library, browser, analyzeTracks)
 * @param {string} [file] rekordbox.xml to open directly (drag & drop)
 * @returns {Promise<object|null>} import report, or null when cancelled
 */
export function openRekordboxImport(app, file = null) {
  const lib = app.library;
  const saved = lib.settings.rekordboxImport ?? {};
  const opts = { ...DEFAULTS, ...saved };
  delete opts.lastPath;
  const st = { path: null, parsed: null, summary: null, selected: new Set(), missing: new Set(), relocated: new Map(), rules: [], checking: false };

  return new Promise((resolve) => {
    const title = h('h2', {}, 'Import from rekordbox');
    const body = h('div.dialog-body.rbi');
    const buttons = h('div.dialog-buttons');
    const dialog = h('div.dialog.rbi-dialog', { role: 'dialog' }, title, body, buttons);
    const overlay = h('div.overlay', {}, dialog);
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    overlay.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    overlay.addEventListener('drop', (e) => {
      const p = [...e.dataTransfer.files].map((f) => window.rb.pathForFile(f)).find((x) => /\.xml$/i.test(x ?? ''));
      e.preventDefault(); e.stopPropagation();
      if (p) load(p);
    });
    const setButtons = (list) => buttons.replaceChildren(...list.map((b) => h(`button${b.primary ? '.primary' : ''}`, { onclick: b.onclick, disabled: b.disabled }, b.label)));

    // ---- step 1: source -------------------------------------------------------------------------
    function stepSource(error = '') {
      title.textContent = 'Import from rekordbox';
      const last = saved.lastPath;
      body.replaceChildren(
        h('p', {}, 'Bring your rekordbox library over: tracks with all their information, cues and playlists.'),
        h('ol.rbi-howto', {},
          h('li', {}, 'In rekordbox, open ', h('b', {}, 'File ▸ Export Collection in xml format'), ' and save ', h('code', {}, 'rekordbox.xml'), '.'),
          h('li', {}, 'Choose that file below, or drop it on this window.')),
        h('div.rbi-pick', {},
          h('button.dbtn.rbi-choose', { onclick: async () => { const [f] = await window.rb.openFiles('xml'); if (f) load(f); } }, 'Choose rekordbox.xml…'),
          last ? h('button.dbtn', { title: last, onclick: () => load(last) }, `Re-import ${baseName(last)}`) : null),
        error ? h('p.rbi-error', {}, error) : null,
        h('div.rbi-note', {},
          h('b', {}, 'Imported: '), 'title, artist, album, genre, composer, remixer, label, mix, year, BPM, key, comments, rating, colour, play count, date added, ',
          'hot cues (A–H with names and colours), memory cues, loops, beatgrid, playlists and folders.',
          h('br'), h('b', {}, 'Not in rekordbox.xml: '), 'My Tags, histories and waveforms. Reboxed redraws waveforms by analysing the audio; ',
          'your grid, cues and key are kept.'));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }]);
    }

    async function load(path) {
      title.textContent = 'Import from rekordbox';
      body.replaceChildren(h('p.dim', {}, `Reading ${path}…`));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }]);
      try {
        st.parsed = importRekordboxXml(await window.rb.readText(path));
      } catch (err) {
        stepSource(`This file could not be read: ${err.message}`);
        return;
      }
      st.path = path;
      st.summary = summarizeRekordbox(st.parsed);
      st.selected = new Set();
      forEachNode(st.parsed.playlists, (n, k) => { if (n.type !== 'folder') st.selected.add(k); });
      st.relocated = new Map(); st.rules = []; st.missing = new Set();
      stepPreview();
      checkMissing();
    }

    // ---- step 2: preview and options ------------------------------------------------------------
    const missingBox = h('div.rbi-missing');
    const importBtnLabel = () => {
      const n = opts.scope === 'playlists' ? playlistPaths(selectPlaylists(st.parsed.playlists, st.selected)).size : st.parsed.tracks.length;
      return `Import ${n.toLocaleString()} track${n === 1 ? '' : 's'}`;
    };
    const refreshButtons = () => setButtons([
      { label: 'Back', onclick: () => stepSource() },
      { label: 'Cancel', onclick: () => close(null) },
      { label: importBtnLabel(), primary: true, disabled: st.checking, onclick: () => doImport() },
    ]);

    function stepPreview() {
      const s = st.summary;
      title.textContent = `Import from rekordbox — ${baseName(st.path)}`;
      const stat = (n, label) => h('div.rbi-stat', {}, h('b', {}, n.toLocaleString()), h('span', {}, label));
      const radio = (key, value, label, hint) => h('label.rbi-opt', {},
        h('input', { type: 'radio', name: `rbi-${key}`, checked: opts[key] === value, onchange: () => { opts[key] = value; refreshButtons(); } }),
        h('span', {}, label, hint ? h('small', {}, hint) : null));
      const check = (key, label, hint) => h('label.rbi-opt', {},
        h('input', { type: 'checkbox', checked: !!opts[key], onchange: (e) => { opts[key] = e.target.checked; } }),
        h('span', {}, label, hint ? h('small', {}, hint) : null));
      body.replaceChildren(
        h('div.rbi-stats', {},
          stat(s.tracks, 'tracks'), stat(s.playlists, 'playlists'), stat(s.folders, 'folders'),
          stat(s.hotCues, 'hot cues'), stat(s.memoryCues, 'memory cues'), stat(s.loops, 'loops'),
          stat(s.comments, 'comments'), stat(s.grids, 'beatgrids'), stat(s.rated, 'rated')),
        missingBox,
        h('div.rbi-cols', {},
          h('div.rbi-col', {}, h('h3', {}, 'Playlists'), playlistTree()),
          h('div.rbi-col', {},
            h('h3', {}, 'Tracks'),
            radio('scope', 'all', 'Whole collection'),
            radio('scope', 'playlists', 'Only tracks in the selected playlists'),
            h('h3', {}, 'Tracks already in Reboxed'),
            radio('metadata', 'overwrite', 'rekordbox wins', 'titles, comments, rating… exactly as in rekordbox'),
            radio('metadata', 'fill', 'Keep my Reboxed edits', 'only fill what is empty here'),
            h('h3', {}, 'Cues'),
            radio('cues', 'replace', "Take rekordbox's cues"),
            radio('cues', 'merge', 'Merge', 'add rekordbox cues on free pads / new positions'),
            radio('cues', 'keep', 'Keep mine'),
            check('beatgrid', 'Import beatgrids', 'Reboxed keeps them when analysing'),
            h('h3', {}, 'Playlists go to'),
            radio('placement', 'sync', 'A "rekordbox" folder', 're-importing updates it, no duplicates'),
            radio('placement', 'new', 'A new dated folder'),
            radio('placement', 'root', 'The top level of the tree'),
            h('h3', {}, 'After import'),
            check('analyze', 'Analyse new tracks', 'waveforms; your grid, cues and key are kept'))),
      );
      renderMissing();
      refreshButtons();
    }

    function playlistTree() {
      const boxes = new Map();
      const leafKeys = (n, k) => {
        if (n.type !== 'folder') return [k];
        const out = [];
        forEachNode(n.children, (c, ck) => { if (c.type !== 'folder') out.push(ck); }, k);
        return out;
      };
      const sync = () => {
        for (const [k, { box, node }] of boxes) {
          if (node.type !== 'folder') { box.checked = st.selected.has(k); continue; }
          const keys = leafKeys(node, k);
          const on = keys.filter((x) => st.selected.has(x)).length;
          box.checked = keys.length > 0 && on === keys.length;
          box.indeterminate = on > 0 && on < keys.length;
        }
        refreshButtons();
      };
      const rows = [];
      forEachNode(st.parsed.playlists, (n, k) => {
        const depth = k.split('/').length - 1;
        const box = h('input', { type: 'checkbox', onchange: (e) => {
          for (const x of leafKeys(n, k)) { if (e.target.checked) st.selected.add(x); else st.selected.delete(x); }
          sync();
        } });
        boxes.set(k, { box, node: n });
        rows.push(h('label.rbi-node', { style: { paddingLeft: `${4 + depth * 16}px` } }, box,
          icon(n.type === 'folder' ? 'folder' : 'playlist'), h('span.rbi-name', {}, n.name),
          n.type !== 'folder' ? h('span.dim', {}, String(n.paths.length)) : null));
      });
      const all = (on) => {
        forEachNode(st.parsed.playlists, (n, k) => { if (n.type !== 'folder') { if (on) st.selected.add(k); else st.selected.delete(k); } });
        sync();
      };
      sync();
      return h('div', {},
        h('div.rbi-tree-tools', {}, h('button.dbtn.small', { onclick: () => all(true) }, 'All'), h('button.dbtn.small', { onclick: () => all(false) }, 'None')),
        h('div.rbi-tree', {}, rows.length ? rows : h('p.dim', {}, 'No playlists in this file.')));
    }

    // ---- missing files ----------------------------------------------------------------------------
    async function checkMissing() {
      st.checking = true; renderMissing(); refreshButtons();
      const tracks = st.parsed.tracks;
      const ok = await window.rb.existsMany(tracks.map((t) => remapPath(t.path, st)));
      st.missing = new Set(tracks.filter((_, i) => !ok[i]).map((t) => keyOf(t.path)));
      st.checking = false; renderMissing(); refreshButtons();
    }

    async function relocate() {
      const [dir] = await window.rb.openFolder();
      if (!dir) return;
      const lost = st.parsed.tracks.filter((t) => st.missing.has(keyOf(t.path)));
      missingBox.replaceChildren(h('p.dim', {}, `Searching ${dir} for ${lost.length} file(s)…`));
      const found = await window.rb.findFiles(dir, [...new Set(lost.map((t) => baseName(t.path)))]);
      const pairs = [];
      for (const t of lost) {
        const cands = found[baseName(t.path).toLowerCase()] ?? [];
        const hit = cands.find((c) => t.fileSize && c.size === t.fileSize) ?? (cands.length === 1 ? cands[0] : null);
        if (hit) { st.relocated.set(keyOf(t.path), hit.path); pairs.push([t.path, hit.path]); }
      }
      st.rules = inferRules([...st.relocated].map(([k, v]) => [st.parsed.tracks.find((t) => keyOf(t.path) === k)?.path ?? k, v]));
      toast(`${pairs.length} of ${lost.length} file(s) found`);
      await checkMissing();
    }

    function renderMissing() {
      if (!st.parsed) return;
      if (st.checking) { missingBox.replaceChildren(h('p.dim', {}, 'Checking that the music files exist…')); return; }
      const n = st.missing.size;
      const moved = st.parsed.tracks.filter((t) => remapPath(t.path, st) !== t.path).length;
      if (!n) {
        missingBox.replaceChildren(h('p.rbi-ok', {}, `✓ All ${st.parsed.tracks.length.toLocaleString()} music files found${moved ? ` (${moved} relocated)` : ''}.`));
        return;
      }
      const list = st.parsed.tracks.filter((t) => st.missing.has(keyOf(t.path))).slice(0, 200);
      missingBox.replaceChildren(
        h('div.rbi-warn', {},
          h('span', {}, `${n} music file${n > 1 ? 's' : ''} not found at the path rekordbox knows${moved ? ` (${moved} relocated)` : ''}. `,
            'They are imported anyway (shown in red) with their cues. Point Reboxed to the folder where they are now:'),
          h('button.dbtn.small', { onclick: relocate }, 'Search in folder…')),
        h('details.rbi-list', {}, h('summary', {}, 'Show missing files'),
          ...list.map((t) => h('div', { title: t.path }, `${t.artist ? `${t.artist} — ` : ''}${t.title}`, h('span.dim', {}, `  ${t.path}`))),
          n > list.length ? h('div.dim', {}, `…and ${n - list.length} more`) : null));
    }

    // ---- step 3: import --------------------------------------------------------------------------
    async function doImport() {
      body.replaceChildren(h('p.dim', {}, 'Importing…'));
      setButtons([]);
      await new Promise((r) => setTimeout(r, 30));
      let report;
      try {
        report = lib.importRekordbox(st.parsed, { ...opts, selected: st.selected, relocated: st.relocated, rules: st.rules, missing: st.missing });
      } catch (err) {
        body.replaceChildren(h('p.rbi-error', {}, `Import failed: ${err.message}`));
        setButtons([{ label: 'Back', onclick: () => stepPreview() }, { label: 'Close', onclick: () => close(null) }]);
        return;
      }
      lib.setSetting('rekordboxImport', { ...opts, lastPath: st.path });
      if (opts.analyze) {
        const ids = lib.all().filter((t) => t.source === 'rekordbox' && !t.analyzed && !t.missing).map((t) => t.id);
        if (ids.length) app.analyzeTracks(ids);
      }
      if (report.folderId) app.browser.select(report.folderId);
      title.textContent = 'rekordbox import finished';
      const line = (n, label) => h('li', {}, h('b', {}, n.toLocaleString()), ` ${label}`);
      body.replaceChildren(h('ul.rbi-report', {},
        line(report.added, 'new tracks'), line(report.updated, 'tracks updated'), line(report.cues, 'cues (hot + memory)'),
        line(report.playlists, `playlists in ${report.folders} folder(s)`),
        report.relocated ? line(report.relocated, 'files relocated') : null,
        report.missing ? line(report.missing, 'files still missing (shown in red)') : null),
        opts.analyze ? h('p.dim', {}, 'New tracks are being analysed in the background for their waveforms.') : null);
      setButtons([{ label: 'Close', primary: true, onclick: () => close(report) }]);
    }

    document.body.append(overlay);
    if (file) load(file); else stepSource();
  });
}
