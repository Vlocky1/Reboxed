// "Move my collection to the USB drive": every track still on the computer is pointed at the same
// music on the drive (same name, another format, or a similar name confirmed by tags / duration),
// or copied onto the drive, so nothing of the collection stays local. Cues, tags, analysis and
// playlists stay (they belong to the track, not the file); stems move along; tracks only found on
// the drive can be added; local copies can go to the Recycle Bin.
import { h, toast } from './dom.js';
import { planMigration, filesToConfirm } from '../../shared/migrate.js';
import { insidePath } from '../../shared/portable-paths.js';

const DEFAULT_DIR = 'J:\\Tracks';
const COPY_SUBDIR = 'From computer';
const BADGE = { sure: ['sure', 'Same music'], likely: ['likely', 'Very likely'], check: ['check', 'To check'], none: ['none', 'Not on the drive'], missing: ['missing', 'File missing'] };

/** @returns {Promise<object|null>} report, or null when cancelled */
export async function openRelink(app, dir = null) {
  const lib = app.library;
  if (!dir) dir = (await window.rb.exists(DEFAULT_DIR)) ? DEFAULT_DIR : null;

  return new Promise((resolve) => {
    const title = h('h2', {}, 'Move my collection to a USB drive');
    const body = h('div.dialog-body.rbi.mig');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.rbi-dialog.mig-dialog', { role: 'dialog' }, title, body, buttons));
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    const setButtons = (list) => buttons.replaceChildren(...list.map((b) => h(`button${b.primary ? '.primary' : ''}`, { onclick: b.onclick, disabled: b.disabled }, b.label)));
    const choose = async () => { const [d] = await window.rb.openFolder(); if (d) scan(d); };
    const rel = (p) => (insidePath(p, dir) ? p.slice(dir.replace(/\\+$/, '').length + 1) : p);

    function start() {
      body.replaceChildren(
        h('p', {}, 'Choose the folder of your USB drive that holds your music (for example ', h('code', {}, DEFAULT_DIR), ').'),
        h('p.dim', {}, 'Reboxed finds, for every track still on this computer, the same music on the drive — same file name, another format, or a similar name confirmed by the tags and the duration — and lets you check before anything changes.'));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }, { label: 'Choose folder…', primary: true, onclick: choose }]);
    }

    let files = []; let plans = []; let exists = new Map(); const choice = new Map();
    let filter = 'all';
    const status = (p) => {
      const c = choice.get(p.track.id);
      if (c?.kind === 'link') return p.candidates.find((x) => x.path === c.path)?.confidence ?? 'check';
      return exists.get(p.track.id) ? 'none' : 'missing';
    };

    async function scan(folder) {
      dir = folder;
      title.textContent = `Move my collection to ${dir}`;
      const line = h('p.dim', {}, `Listing the music in ${dir}…`);
      const bar = h('progress', { max: 1, value: 0 });
      body.replaceChildren(line, bar);
      setButtons([{ label: 'Cancel', onclick: () => close(null) }]);
      try { files = await window.rb.listAudio(dir); } catch (err) { body.replaceChildren(h('p.rbi-error', {}, err.message)); return; }
      const tracks = lib.all();
      line.textContent = `${files.length} files on the drive. Looking for the tracks of your collection…`;
      plans = planMigration(tracks, files, dir);
      const ok = await window.rb.existsMany(plans.map((p) => p.track.path));
      exists = new Map(plans.map((p, i) => [p.track.id, ok[i]]));
      // Names alone leave some doubts: read the tags (title, artist, duration) of those drive files.
      const toRead = filesToConfirm(plans);
      const tags = new Map();
      for (let i = 0; i < toRead.length; i += 120) {
        line.textContent = `Checking tags and durations: ${Math.min(i + 120, toRead.length)} / ${toRead.length}…`;
        bar.value = i / Math.max(1, toRead.length);
        const got = await window.rb.readTagsMany(toRead.slice(i, i + 120));
        for (const [k, v] of Object.entries(got)) tags.set(k, v);
      }
      if (toRead.length) plans = planMigration(tracks, files, dir, tags);
      choice.clear();
      for (const p of plans) {
        const best = p.candidates[0];
        choice.set(p.track.id, best ? { kind: 'link', path: best.path } : exists.get(p.track.id) ? { kind: 'copy' } : { kind: 'keep' });
      }
      review();
    }

    function counts() {
      const n = { all: plans.length, sure: 0, likely: 0, check: 0, none: 0, missing: 0 };
      for (const p of plans) n[status(p)]++;
      return n;
    }

    function rowFor(p) {
      const t = p.track;
      const sel = h('select.mig-choice');
      for (const c of p.candidates) {
        sel.append(h('option', { value: `link:${c.path}` }, `→ ${rel(c.path)}  (${BADGE[c.confidence][1].toLowerCase()}${c.why ? ` — ${c.why}` : ''})`));
      }
      if (exists.get(t.id)) sel.append(h('option', { value: 'copy', title: `${dir}\\${COPY_SUBDIR}` }, `Copy it to the drive ("${COPY_SUBDIR}" folder)`));
      sel.append(h('option', { value: 'keep' }, 'Keep it on this computer'));
      sel.append(h('option', { value: 'remove' }, 'Remove it from the collection'));
      const c = choice.get(t.id);
      sel.value = c.kind === 'link' ? `link:${c.path}` : c.kind;
      const badge = h('span.mig-badge');
      const paint = () => { const s = status(p); badge.className = `mig-badge ${BADGE[s][0]}`; badge.textContent = BADGE[s][1]; };
      sel.onchange = () => {
        const v = sel.value;
        choice.set(t.id, v.startsWith('link:') ? { kind: 'link', path: v.slice(5) } : { kind: v });
        paint(); refreshCounts();
      };
      paint();
      return h('div.mig-row', {},
        badge,
        h('div.mig-track', {},
          h('div.mig-title', {}, t.title || '(no title)', t.artist ? h('span.dim', {}, ` — ${t.artist}`) : null),
          h('div.mig-path', { title: t.path }, t.path, exists.get(t.id) ? '' : h('span.rbi-error', {}, '  (file not found)'))),
        sel);
    }

    let countsEl; let listEl; let tabsEl;
    function refreshCounts() {
      const n = counts();
      const linked = n.sure + n.likely + n.check;
      countsEl.replaceChildren(
        ...[['all', 'still on this computer'], ['sure', 'same music on the drive'], ['likely', 'very likely'], ['check', 'to check'], ['none', 'not on the drive (copy them)'], ['missing', 'file missing']]
          .map(([k, label]) => h('div.rbi-stat', {}, h('b', {}, String(n[k])), h('span', {}, label))));
      setButtons([
        { label: 'Other folder…', onclick: choose },
        { label: 'Cancel', onclick: () => close(null) },
        { label: `Apply (${linked} link, ${[...choice.values()].filter((c) => c.kind === 'copy').length} copy)`, primary: true, onclick: () => apply() },
      ]);
    }
    function renderList() {
      const shown = plans.filter((p) => filter === 'all' || status(p) === filter);
      listEl.replaceChildren(...(shown.length ? shown.slice(0, 600).map(rowFor) : [h('p.dim', {}, 'Nothing here.')]),
        ...(shown.length > 600 ? [h('p.dim', {}, `…and ${shown.length - 600} more (use the buttons above to handle them all)`)] : []));
      tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
    }
    const bulk = (pred, value) => {
      for (const p of plans) {
        if (!pred(p)) continue;
        if (value === 'accept' && p.candidates[0]) choice.set(p.track.id, { kind: 'link', path: p.candidates[0].path });
        else if (value === 'copy' && exists.get(p.track.id)) choice.set(p.track.id, { kind: 'copy' });
        else if (value === 'keep') choice.set(p.track.id, { kind: 'keep' });
      }
      refreshCounts(); renderList();
    };

    const opts = { stemsHere: true, addNew: true, trash: false };
    function review() {
      if (!plans.length) {
        body.replaceChildren(h('p.rbi-ok', {}, `✓ Every track of your collection is already in ${dir}.`));
        setButtons([{ label: 'Close', primary: true, onclick: () => close({ linked: 0, copied: 0, remaining: 0 }) }]);
        return;
      }
      countsEl = h('div.rbi-stats');
      listEl = h('div.mig-list');
      tabsEl = h('div.seg.mig-tabs', {}, [['all', 'All'], ['check', 'To check'], ['likely', 'Very likely'], ['sure', 'Same'], ['none', 'Not on the drive'], ['missing', 'Missing']]
        .map(([f, l]) => h('button.seg-btn', { dataset: { f }, onclick: () => { filter = f; renderList(); } }, l)));
      const opt = (key, label, hint) => h('label.rbi-opt', {}, h('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), h('span', {}, label, hint ? h('small', {}, hint) : null));
      body.replaceChildren(
        countsEl,
        h('div.mig-bulk', {},
          h('button.dbtn.small', { onclick: () => bulk((p) => status(p) === 'check' || (p.candidates[0] && choice.get(p.track.id).kind !== 'link'), 'accept') }, 'Accept every proposal'),
          h('button.dbtn.small', { onclick: () => bulk((p) => !p.candidates.length, 'copy') }, 'Copy every track not on the drive'),
          h('button.dbtn.small', { onclick: () => bulk((p) => status(p) === 'check', 'keep') }, 'Keep the ones to check')),
        tabsEl, listEl,
        h('div.rbi-col.mig-opts', {},
          opt('stemsHere', `Keep the stems in ${dir}\\stems`, 'analysed stems move there'),
          opt('addNew', `Add the tracks found only on the drive to the collection`),
          opt('trash', 'Send the local files to the Recycle Bin afterwards', 'only files now linked or copied to the drive; recoverable from the bin')));
      refreshCounts();
      renderList();
    }

    async function apply() {
      setButtons([]);
      const line = h('p.dim', {}, 'Applying…');
      const bar = h('progress', { max: 1, value: 0 });
      body.replaceChildren(line, bar);
      const report = { linked: 0, copied: 0, removed: 0, stemsMoved: 0, added: 0, trashed: 0, errors: [] };
      if (opts.stemsHere) await window.rb.storage.setStems('custom', `${dir}\\stems`, true);
      const done = []; // local files now replaced by a file on the drive
      const used = new Set();
      let k = 0;
      for (const p of plans) {
        k++;
        if (k % 10 === 0) { line.textContent = `Applying ${k} / ${plans.length}…`; bar.value = k / plans.length; }
        const t = p.track; const c = choice.get(t.id);
        try {
          let to = null;
          if (c.kind === 'link') { to = c.path; report.linked++; } else if (c.kind === 'copy') { to = await window.rb.copyInto(t.path, `${dir}\\${COPY_SUBDIR}`); report.copied++; } else if (c.kind === 'remove') { lib.removeTracks([t.id]); report.removed++; continue; } else continue;
          used.add(to.toLowerCase());
          lib.relink(t.id, to);
          if (await window.rb.stems.relocate(t.id, t.path, to)) report.stemsMoved++;
          if (exists.get(t.id) && to.toLowerCase() !== t.path.toLowerCase()) done.push(t.path);
        } catch (err) { report.errors.push(`${t.title}: ${err.message}`); }
      }
      if (opts.addNew) {
        const inLib = new Set(lib.all().map((x) => x.path.toLowerCase()));
        const fresh = files.map((f) => f.path).filter((p) => !inLib.has(p.toLowerCase()) && !used.has(p.toLowerCase()));
        if (fresh.length) { line.textContent = `Adding ${fresh.length} track(s) found only on the drive…`; report.added = (await app.importPaths(fresh)).length; }
      }
      if (opts.trash && done.length) report.trashed = await window.rb.trash(done);
      await lib.saveNow();
      report.remaining = lib.all().filter((x) => !insidePath(x.path, dir)).length;
      title.textContent = report.remaining ? 'Collection moved (almost)' : 'Your whole collection is on the drive';
      body.replaceChildren(h('ul.rbi-report', {},
        h('li', {}, h('b', {}, String(report.linked)), ' tracks linked to the same music on the drive'),
        h('li', {}, h('b', {}, String(report.copied)), ` tracks copied to ${dir}\\${COPY_SUBDIR}`),
        h('li', {}, h('b', {}, String(report.stemsMoved)), ' stems folders moved'),
        report.added ? h('li', {}, h('b', {}, String(report.added)), ' tracks added from the drive') : null,
        report.removed ? h('li', {}, h('b', {}, String(report.removed)), ' removed from the collection') : null,
        opts.trash ? h('li', {}, h('b', {}, String(report.trashed)), ' local files sent to the Recycle Bin') : null,
        h('li', {}, h('b', {}, String(report.remaining)), report.remaining ? ' tracks still on this computer (kept, or with no file)' : ' tracks left on this computer')),
      ...report.errors.slice(0, 20).map((e) => h('p.rbi-error', {}, e)));
      toast(`${report.linked + report.copied} track(s) now on ${dir}`);
      setButtons([{ label: 'Close', primary: true, onclick: () => close(report) }]);
    }

    document.body.append(overlay);
    if (dir) scan(dir); else start();
  });
}
