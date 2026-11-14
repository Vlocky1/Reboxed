// Duplicate finder window: in a playlist or the whole collection, the same music twice (another
// file, format, name or edit). Names only propose candidates; the audio decides (see
// shared/duplicates.js). Each group: listen, pick the version to keep, then remove the others from
// the playlist or merge them into it in the collection.
import { h, fmtTime, toast } from './dom.js';
import { mediaUrl } from '../analysis/analyzer.js';
import { base64ToU8 } from '../../shared/dsp/waveform.js';
import { candidatePairs, energyCurves, audioSimilarity, verdict, groupPairs, pickKeeper, soundAlike } from '../../shared/duplicates.js';
import { CollectionIndex } from '../../shared/in-collection.js';
import { MERGE_FIELDS, defaultPicks, fieldText } from '../../shared/merge-fields.js';

const pairKey = (a, b) => [a, b].sort().join('|');

/** The playlist where downloads that sound like a track already there wait for a decision. */
export const SUSPECTS_SRC = 'dup-suspects';
export const SUSPECTS_NAME = 'Suspected duplicates';

/**
 * A new track (a download) against the collection: its candidates by name (any reading) and by
 * sound fingerprint, then checked by ear.
 * @returns {Promise<{pairs: object[], waiting: object[]}>} duplicate pairs with the track; candidates
 *   not analysed yet (to analyse, then check again)
 */
export async function checkNewTrack(app, track, { keywords } = {}) {
  const others = app.library.all().filter((x) => x.id !== track.id && !x.missing);
  const byName = new CollectionIndex(others, { keywords }).findAll(track, { upload: !track.artist }).map((f) => f.track);
  // another name, same recording: the same fingerprint and the same length
  const bySound = others.filter((x) => Math.abs((x.duration ?? 0) - (track.duration ?? 0)) <= 5 && soundAlike(track, x));
  const cands = [...new Map([...byName, ...bySound].map((x) => [x.id, x])).values()].slice(0, 12);
  if (!cands.length) return { pairs: [], waiting: [] };
  const res = await findDuplicates(app, [track, ...cands], () => {}, { keywords });
  const pairs = res.groups.flatMap((g) => g.pairs).filter((p) => p.a.id === track.id || p.b.id === track.id);
  return { pairs, waiting: cands.filter((x) => !x.analyzed) };
}
const fmtOf = (t) => `${(t.kind || t.path.split('.').pop() || '').toUpperCase()}${t.bitrate ? ` ${t.bitrate}` : ''}`;

/**
 * Find the duplicates (no window): pairs checked by ear, grouped.
 * @param {object} app
 * @param {object[]} tracks
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function findDuplicates(app, tracks, onProgress = () => {}, { keywords } = {}) {
  const ignored = new Set(app.library.settings.dupIgnore ?? []);
  const pairs = candidatePairs(tracks, { keywords }).filter(([a, b]) => !ignored.has(pairKey(a.id, b.id)));
  const curves = new Map();
  const curvesOf = async (t) => {
    if (!t.analyzed) return null;
    if (!curves.has(t.id)) {
      const wf = (await window.rb.getAnalysis(t.id).catch(() => null))?.waveform;
      curves.set(t.id, wf ? energyCurves({ pps: wf.pps, low: base64ToU8(wf.low), mid: base64ToU8(wf.mid), high: base64ToU8(wf.high) }) : null);
    }
    return curves.get(t.id);
  };
  const checked = [];
  for (const [i, [a, b, meta]] of pairs.entries()) {
    onProgress(i, pairs.length);
    const [ca, cb] = [await curvesOf(a), await curvesOf(b)];
    const audio = ca && cb ? audioSimilarity(ca, cb) : null;
    checked.push({ a, b, meta, audio, verdict: verdict(a, b, meta, audio) });
    if (i % 10 === 9) await new Promise((r) => setTimeout(r)); // keep the window responsive
  }
  onProgress(pairs.length, pairs.length);
  return {
    groups: groupPairs(checked.filter((p) => p.verdict.duplicate)),
    versions: checked.filter((p) => !p.verdict.duplicate),
  };
}

/**
 * The versions side by side: one column per track (▶ to listen, "keep this file"), one row per
 * piece of information with a tick in each column. Rows where the versions differ are marked;
 * the kept file gets exactly what is ticked.
 */
function fieldPicker(app, g, live, keepId, { merge, notDuplicates }) {
  let keep = keepId;
  const picks = g.picks ?? defaultPicks(live.find((t) => t.id === keep), live.filter((t) => t.id !== keep));
  g.picks = picks;
  const grid = h('div.dup-grid', { style: { '--cols': live.length } });
  const name = `dupf-${g.pairs[0].a.id}`;
  const renderGrid = () => {
    const cells = [h('div.dup-gh.dup-gcorner', {}, '')];
    for (const t of live) {
      cells.push(h(`div.dup-gh${t.id === keep ? '.kept' : ''}`, {},
        h('div.dup-gh-top', {},
          h('button.dbtn.small.dup-play', { type: 'button', title: 'Listen (headphones)', onclick: () => app.engine.preview(mediaUrl(t.path)) }, '▶'),
          h('div.dup-info', {}, h('div.dup-title', { title: t.title }, t.title), h('div.dup-sub', {}, [fmtOf(t), t.duration ? fmtTime(t.duration) : ''].filter(Boolean).join(' · ')))),
        h('label.dup-keepfile', { title: t.path },
          h('input', { type: 'radio', name: `${name}-file`, checked: t.id === keep, onchange: () => { keep = t.id; g.keep = t.id; renderGrid(); } }),
          t.id === keep ? ' Audio file kept' : ' Keep this file')));
    }
    for (const f of MERGE_FIELDS) {
      const texts = live.map((t) => fieldText(t, f));
      if (texts.every((x) => x === '—')) continue;              // nothing to choose
      const same = texts.every((x) => x === texts[0]);
      cells.push(h(`div.dup-gl${same ? '.same' : ''}`, {}, f.label, same ? h('span.dup-same', {}, 'same') : null));
      live.forEach((t, k) => {
        cells.push(h(`label.dup-cell${picks[f.key] === t.id ? '.on' : ''}${same ? '.same' : ''}`, { title: texts[k] },
          h('input', { type: 'radio', name: `${name}-${f.key}`, checked: picks[f.key] === t.id, onchange: () => { picks[f.key] = t.id; renderGrid(); } }),
          h('span', {}, texts[k])));
      });
    }
    grid.replaceChildren(...cells);
  };
  renderGrid();
  return h('div.dup-picker', {},
    grid,
    h('div.dup-actions', {},
      h('button.dbtn.small', { onclick: notDuplicates }, 'Not duplicates'),
      h('button.dbtn.small.primary', { title: 'The kept file gets every ticked value and replaces the others in every playlist; the others leave the collection (files are not deleted)', onclick: () => merge(keep, { ...picks }) }, 'Merge with these choices')));
}

/**
 * @param {object} app
 * @param {string|null} playlistId a playlist / intelligent playlist, or null for the collection
 */
export async function openDuplicates(app, playlistId = null) {
  const lib = app.library;
  const node = playlistId ? lib.findNode(playlistId)?.node : null;
  const rows = node ? lib.rowsFor(playlistId) : null;
  const tracks = rows ? [...new Map(rows.map((r) => [r.track.id, r.track])).values()] : lib.all();
  const editable = node?.type === 'playlist';
  // Suspected duplicates: a group decided (merged, or "not duplicates") leaves the list
  const settle = (ids) => {
    if (node?.src !== SUSPECTS_SRC) return;
    const gone = new Set(ids);
    lib.removeFromPlaylist(node.id, node.trackIds.map((id, i) => (gone.has(id) ? i : -1)).filter((i) => i >= 0));
  };
  const where = node ? `"${node.name}"` : 'the collection';

  const body = h('div.dup');
  const title = h('h2', {}, `Duplicates in ${where}`);
  const buttons = h('div.dialog-buttons');
  const overlay = h('div.overlay', {}, h('div.dialog.dup-dialog', { role: 'dialog' }, title, body, buttons));
  let closed = false;
  const close = () => { closed = true; app.engine.stopPreview?.(); overlay.remove(); };
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  buttons.append(h('button', { onclick: close }, 'Close'));
  document.body.append(overlay);

  const bar = h('progress', { max: 1, value: 0 });
  const line = h('p.dim', {}, `Comparing ${tracks.length} tracks: names first, then the sound of the likely pairs…`);
  body.replaceChildren(line, bar);
  // the suspects list: each one against the whole collection (its twin may not be in the list)
  let pool = tracks;
  if (node?.src === SUSPECTS_SRC) {
    const index = new CollectionIndex(lib.all());
    pool = [...new Map([...tracks, ...tracks.flatMap((t) => index.findAll(t, { upload: !t.artist }).map((f) => f.track))].map((t) => [t.id, t])).values()];
  }
  const result = await findDuplicates(app, pool, (d, n) => { bar.max = Math.max(1, n); bar.value = d; line.textContent = `Listening to the likely pairs: ${d} / ${n}`; });
  if (closed) return result;
  const notAnalysed = tracks.filter((t) => !t.analyzed).length;
  // Field-by-field mode: for each piece of information, tick the version to keep (remembered)
  let fieldMode = false;
  try { fieldMode = localStorage.getItem('reboxed.dupFieldMode') === '1'; } catch { /* private storage */ }
  const modeSwitch = () => h('label.dup-mode', { title: 'Compare the versions side by side and tick, for each piece of information, the one the kept track gets' },
    h('input', { type: 'checkbox', checked: fieldMode, onchange: (e) => {
      fieldMode = e.target.checked;
      try { localStorage.setItem('reboxed.dupFieldMode', fieldMode ? '1' : '0'); } catch { /* private storage */ }
      render();
    } }), ' Choose field by field');

  const render = () => {
    const parts = [];
    // The same entry several times in the playlist.
    if (editable) {
      const seen = new Set(); const repeats = [];
      node.trackIds.forEach((id, pos) => { if (seen.has(id)) repeats.push(pos); seen.add(id); });
      if (repeats.length) {
        parts.push(h('div.dup-group', {}, h('div.dup-head', {}, h('b', {}, `${repeats.length} track(s) are in this playlist more than once`), h('span.spacer'),
          h('button.dbtn.small.primary', { onclick: () => { lib.removeFromPlaylist(node.id, repeats); toast(`${repeats.length} repeated entr${repeats.length > 1 ? 'ies' : 'y'} removed`); render(); } }, 'Remove the repeats'))));
      }
    }
    const groups = result.groups.filter((g) => g.tracks.filter((t) => lib.get(t.id)).length > 1);
    parts.push(h('div.dup-top', {}, h('p.dim', {}, groups.length
      ? `${groups.length} group(s) of duplicates, surest first. ▶ plays a version in the headphones.`
      : 'No duplicates found.',
    notAnalysed ? ` ${notAnalysed} track(s) not analysed: compared by name and length only.` : ''), groups.length ? modeSwitch() : null));
    for (const g of groups) {
      const live = g.tracks.map((t) => lib.get(t.id)).filter(Boolean);
      let keep = (g.keep && lib.get(g.keep)) ? g.keep : pickKeeper(live).id;
      const name = `dup-${g.pairs[0].a.id}`;
      const trackRows = live.map((t) => h('label.dup-track', {},
        h('input', { type: 'radio', name, checked: t.id === keep, onchange: () => { keep = t.id; g.keep = t.id; } }),
        h('button.dbtn.small.dup-play', { type: 'button', title: 'Listen (headphones)', onclick: (e) => { e.preventDefault(); app.engine.preview(mediaUrl(t.path)); } }, '▶'),
        h('div.dup-info', {},
          h('div.dup-title', {}, `${t.artist ? `${t.artist} — ` : ''}${t.title}`),
          h('div.dup-sub', {}, [fmtOf(t), t.duration ? fmtTime(t.duration) : '', t.bpm ? `${t.bpm.toFixed(1)} BPM` : '', `${t.cues?.length ?? 0} cues`, t.rating ? '★'.repeat(t.rating) : '', t.missing ? 'file missing' : ''].filter(Boolean).join(' · ')),
          h('div.dup-path', { title: t.path }, t.path))));
      const verdicts = g.pairs.map((p) => h('div.dup-verdict', {}, h('span.dup-score', { style: { '--s': `${p.verdict.score}%` } }, `${p.verdict.score}%`),
        ` ${p.verdict.label}`, p.audio ? h('span.dim', {}, ` · sound ${Math.round(p.audio.score * 100)} %${p.audio.lag ? `, offset ${Math.round(p.audio.lag)} s` : ''}`) : null,
        g.pairs.length > 1 ? h('span.dim', {}, ` · ${p.a.title} ↔ ${p.b.title}`) : null));
      const drop = () => live.filter((t) => t.id !== keep).map((t) => t.id);
      const actions = h('div.dup-actions', {},
        editable ? h('button.dbtn.small', { onclick: () => {
          const gone = new Set(drop());
          lib.removeFromPlaylist(node.id, node.trackIds.map((id, i) => (gone.has(id) ? i : -1)).filter((i) => i >= 0));
          if (!node.trackIds.includes(keep)) lib.addToPlaylist(node.id, [keep]);
          toast('Removed from the playlist (still in the collection)'); render();
        } }, 'Keep it, remove the others from this playlist') : null,
        h('button.dbtn.small.primary', { title: 'The kept version replaces the others in every playlist and gets their cues, tags and plays if it has none; the others leave the collection (files are not deleted)',
          onclick: () => { lib.mergeDuplicates(keep, drop()); settle([keep]); toast('Merged: one version left in the collection'); render(); } }, 'Keep it, merge the others in the collection'),
        h('button.dbtn.small', { onclick: () => {
          const ign = new Set(lib.settings.dupIgnore ?? []);
          g.pairs.forEach((p) => ign.add(pairKey(p.a.id, p.b.id)));
          lib.setSetting('dupIgnore', [...ign]);
          settle(live.map((t) => t.id));
          result.groups = result.groups.filter((x) => x !== g); render();
        } }, 'Not duplicates'));
      if (fieldMode) {
        parts.push(h('div.dup-group', {}, ...verdicts, fieldPicker(app, g, live, keep, {
          merge: (keepId, picks) => {
            lib.mergeDuplicates(keepId, live.filter((t) => t.id !== keepId).map((t) => t.id), { picks });
            settle([keepId]);
            toast('Merged with your choices: one version left in the collection');
            render();
          },
          notDuplicates: () => actions.lastChild.click(),
        }), h('div.dup-hidden-actions', { hidden: true }, actions)));
      } else parts.push(h('div.dup-group', {}, ...verdicts, ...trackRows, actions));
    }
    if (result.versions.length) {
      parts.push(h('details.dup-versions', {}, h('summary', {}, `${result.versions.length} pair(s) with the same name but different audio (remixes, other versions): not duplicates`),
        ...result.versions.slice(0, 100).map((p) => h('div.dup-sub', {}, `${p.a.title} (${fmtTime(p.a.duration ?? 0)}) ↔ ${p.b.title} (${fmtTime(p.b.duration ?? 0)}) · sound ${Math.round((p.audio?.score ?? 0) * 100)} %`))));
    }
    body.replaceChildren(...parts);
  };
  render();
  return result;
}
