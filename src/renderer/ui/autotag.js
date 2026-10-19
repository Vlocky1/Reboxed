// Auto-tag: batch tagging of the selected tracks with a recipe of steps, e.g. 1) Spotify: title and
// artist, 2) Deezer: genre (searched with the title Spotify just cleaned). Each change is shown
// before anything is saved, ticked by default; Apply saves the ticked ones and can be undone.
import { h, toast } from './dom.js';
import { DEFAULT_RECIPE, TAG_FIELDS, runRecipe } from '../../shared/autotag.js';

const SOURCES = { spotify: 'Spotify', deezer: 'Deezer' };
const LABEL = Object.fromEntries(TAG_FIELDS);
const clone = (x) => JSON.parse(JSON.stringify(x));
/** Lookups (replaced by the smoke test, which runs offline). */
export const autotagApi = { lookup: (q, source, opts) => window.rb.metadata.lookup(q, source, opts), pause: 250 };

/** @param {object} app @param {string[]} ids selected tracks */
export function openAutoTag(app, ids) {
  const lib = app.library;
  const tracks = ids.map((id) => lib.get(id)).filter(Boolean);
  if (!tracks.length) return Promise.resolve(null);
  const recipe = clone(lib.settings.autoTagRecipe ?? DEFAULT_RECIPE);

  return new Promise((resolve) => {
    const title = h('h2', {}, `Auto-tag ${tracks.length} track${tracks.length > 1 ? 's' : ''}`);
    const body = h('div.dialog-body.autotag');
    const buttons = h('div.dialog-buttons');
    const overlay = h('div.overlay', {}, h('div.dialog.autotag-dialog', { role: 'dialog' }, title, body, buttons));
    let stop = false;
    const close = (v) => { stop = true; overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    const setButtons = (list) => buttons.replaceChildren(...list.map((b) => h(`button${b.primary ? '.primary' : ''}`, { onclick: b.onclick, disabled: b.disabled }, b.label)));

    // ---- 1. recipe ----
    function setup() {
      const steps = h('div.at-steps');
      const render = () => steps.replaceChildren(...recipe.steps.map((step, i) => h('div.at-step', {},
        h('div.at-step-head', {},
          h('b', {}, `Step ${i + 1}`),
          h('div.seg', {}, Object.entries(SOURCES).map(([id, label]) => h(`button.seg-btn${step.source === id ? '.on' : ''}`, { type: 'button', dataset: { source: id }, onclick: () => { step.source = id; render(); } }, label))),
          h('span.spacer'),
          i > 0 ? h('button.dbtn.small', { type: 'button', title: 'Move up', onclick: () => { recipe.steps.splice(i - 1, 0, ...recipe.steps.splice(i, 1)); render(); } }, '↑') : null,
          recipe.steps.length > 1 ? h('button.dbtn.small', { type: 'button', title: 'Remove this step', onclick: () => { recipe.steps.splice(i, 1); render(); } }, '✕') : null),
        h('div.at-fields', {}, TAG_FIELDS.map(([f, label]) => h('label.at-field', {},
          h('input', { type: 'checkbox', checked: step.fields.includes(f), dataset: { field: f },
            onchange: (e) => { step.fields = e.target.checked ? [...step.fields, f] : step.fields.filter((x) => x !== f); } }), label))),
        h('div.at-opts', {},
          h('label', {}, h('input', { type: 'checkbox', checked: !!step.onlyEmpty, onchange: (e) => { step.onlyEmpty = e.target.checked; } }), ' Only fill empty fields'),
          h('label', {}, h('input', { type: 'checkbox', checked: step.titleWithMix !== false, onchange: (e) => { step.titleWithMix = e.target.checked; } }), ' Mix name in the title (“Song (Extended Mix)”)'),
          step.source === 'spotify' && step.fields.includes('genre') ? h('span.at-warn', {}, 'Spotify has almost no genres: take the genre from Deezer.') : null))));
      render();
      const tol = h('select', { onchange: (e) => { recipe.tolerance = Number(e.target.value); } },
        [[2, '± 2 s'], [4, '± 4 s'], [8, '± 8 s'], [9999, 'ignore the duration']].map(([v, l]) => h('option', { value: v, selected: recipe.tolerance === v }, l)));
      body.replaceChildren(
        h('p.dim', {}, 'Steps run in order on every track. Each step searches with the track as the previous steps left it, so Deezer can search with the title Spotify cleaned. A result is used only when the artist, the title and the duration agree; you check every change before it is saved.'),
        steps,
        h('div.frow', {},
          h('button.dbtn.small', { type: 'button', onclick: () => { recipe.steps.push({ source: 'deezer', fields: ['genre'], onlyEmpty: false, titleWithMix: true }); render(); } }, '+ Add a step'),
          h('button.dbtn.small', { type: 'button', onclick: () => { Object.assign(recipe, clone(DEFAULT_RECIPE)); setup(); } }, 'Default recipe (Spotify title + artist, Deezer genre)'),
          h('span.spacer'), h('label', {}, 'Same duration: ', tol)));
      setButtons([{ label: 'Cancel', onclick: () => close(null) }, { label: 'Find the changes', primary: true, onclick: () => run() }]);
    }

    // ---- 2. lookups ----
    async function run() {
      recipe.steps = recipe.steps.filter((s) => s.fields.length);
      if (!recipe.steps.length) { toast('Tick at least one field'); setup(); return; }
      lib.setSetting('autoTagRecipe', clone(recipe));
      const line = h('p.dim', {}, 'Starting…');
      const bar = h('progress', { max: tracks.length, value: 0 });
      body.replaceChildren(line, bar);
      setButtons([{ label: 'Stop', onclick: () => { stop = true; } }]);
      const results = await runRecipe(tracks, recipe, autotagApi.lookup, {
        pause: autotagApi.pause,
        stopped: () => stop,
        onProgress: (done, total, t) => { bar.value = done; line.textContent = t ? `${done + 1} / ${total} — ${t.artist ? `${t.artist} - ` : ''}${t.title}` : 'Done'; },
      });
      if (!overlay.isConnected) return;
      review(results);
    }

    // ---- 3. review & apply ----
    function review(results) {
      const rows = [];
      const items = []; // {track, change, box}
      const fieldsUsed = new Set();
      let notFound = 0;
      for (const r of results) {
        const lines = [];
        for (const s of r.steps) {
          if (!s.match) {
            lines.push(h('div.at-miss', {}, `${SOURCES[s.source]}: ${s.error || 'no matching track'}`));
            continue;
          }
          for (const c of s.changes) {
            fieldsUsed.add(c.field);
            const box = h('input', { type: 'checkbox', checked: true, dataset: { field: c.field } });
            items.push({ track: r.track, change: c, box });
            lines.push(h('label.at-change', {}, box, h('span.at-k', {}, LABEL[c.field]),
              h('span.at-from', { title: String(c.from) }, c.field === 'artwork' ? (c.from ? 'cover' : '(none)') : String(c.from) || '(empty)'),
              h('span.at-arrow', {}, '→'),
              c.field === 'artwork' ? h('img.at-cover', { src: c.to, alt: '' }) : h('span.at-to', { title: String(c.to) }, String(c.to)),
              h('span.at-src', {}, SOURCES[s.source])));
          }
          if (!s.changes.length) lines.push(h('div.at-same', {}, `${SOURCES[s.source]}: found, nothing to change`));
        }
        if (r.steps.some((s) => !s.match)) notFound++;
        rows.push(h('div.at-track', {}, h('div.at-name', {}, `${r.track.artist ? `${r.track.artist} - ` : ''}${r.track.title}`), ...lines));
      }
      const count = h('span');
      const refresh = () => { const n = items.filter((x) => x.box.checked).length; count.textContent = `${n} change${n === 1 ? '' : 's'} ticked`; applyBtn.disabled = !n; };
      const applyBtn = h('button.primary', { onclick: () => apply(items.filter((x) => x.box.checked)) }, 'Apply');
      items.forEach((x) => x.box.addEventListener('change', refresh));
      const toggles = [...fieldsUsed].map((f) => h('button.dbtn.small', { type: 'button', onclick: () => {
        const sel = items.filter((x) => x.change.field === f); const on = !sel.every((x) => x.box.checked);
        sel.forEach((x) => { x.box.checked = on; }); refresh();
      } }, `${LABEL[f]} on/off`));
      title.textContent = `Auto-tag: ${items.length} change${items.length === 1 ? '' : 's'} found`;
      body.replaceChildren(
        h('div.frow.at-summary', {}, count, h('span.dim', {}, ` · ${results.length} tracks · ${notFound} with a step that found nothing`), h('span.spacer'), ...toggles),
        h('div.at-list', {}, rows.length ? rows : h('p.dim', {}, 'Nothing found.')));
      buttons.replaceChildren(h('button', { onclick: () => setup() }, 'Back'), h('button', { onclick: () => close(null) }, 'Cancel'), applyBtn);
      refresh();
    }

    async function apply(chosen) {
      const byTrack = new Map();
      for (const x of chosen) { if (!byTrack.has(x.track.id)) byTrack.set(x.track.id, []); byTrack.get(x.track.id).push(x.change); }
      const undo = [];
      let covers = 0;
      for (const [id, changes] of byTrack) {
        const t = lib.get(id);
        if (!t) continue;
        const patch = {};
        for (const c of changes) {
          if (c.field === 'artwork') {
            try { patch.artwork = await window.rb.artworkFromUrl(c.to); covers++; } catch { /* keep the old cover */ }
          } else patch[c.field] = typeof t[c.field] === 'number' || ['year', 'trackNumber', 'discNumber'].includes(c.field) ? Number(c.to) || 0 : c.to;
        }
        undo.push({ id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, t[k] ?? ''])) });
        lib.update(id, patch);
        app.onTrackEdited?.(id);
      }
      app.lastAutoTag = undo;
      title.textContent = 'Auto-tag done';
      body.replaceChildren(h('p', {}, `${chosen.length} change(s) saved on ${byTrack.size} track(s)${covers ? `, ${covers} cover(s)` : ''}.`),
        h('p.dim', {}, 'The audio files are not modified; the changes are in your Reboxed library (and its exports).'));
      buttons.replaceChildren(
        h('button', { onclick: () => { undoAutoTag(app); close({ undone: true }); } }, 'Undo'),
        h('button.primary', { onclick: () => close({ applied: chosen.length, tracks: byTrack.size }) }, 'Close'));
    }

    document.body.append(overlay);
    setup();
  });
}

/** Put back the values the last auto-tag replaced. */
export function undoAutoTag(app) {
  const undo = app.lastAutoTag;
  if (!undo?.length) return 0;
  for (const { id, before } of undo) { if (app.library.get(id)) { app.library.update(id, before); app.onTrackEdited?.(id); } }
  app.lastAutoTag = null;
  toast(`Auto-tag undone on ${undo.length} track(s)`);
  return undo.length;
}
