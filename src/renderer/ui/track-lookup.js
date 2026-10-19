// Track information ▸ "Search online": find the track on Deezer (no account needed) and Spotify
// (when set up in Preferences), show what was found next to each field, and copy only the ticked
// values into the form (Genre is ticked by default). Nothing is saved until the Track information
// dialog is saved.
import { h, fmtTime } from './dom.js';

const FIELDS = [
  ['title', 'Title'], ['mixName', 'Mix name'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['genre', 'Genre'], ['year', 'Year'], ['trackNumber', 'Track number'], ['discNumber', 'Disc number'], ['label', 'Label'],
  ['artwork', 'Artwork'],
];
const DEFAULT_ON = new Set(['genre']);
const SOURCE = { spotify: 'Spotify', deezer: 'Deezer' };
/** Online search (replaced by the smoke test, which runs offline). */
export const lookupApi = { lookup: (q) => window.rb.metadata.lookup(q) };

/** Results with the closest duration first (within 3 s), keeping the services' order otherwise. */
export function orderByDuration(list, duration) {
  if (!duration) return list;
  const near = (c) => (c.duration && Math.abs(c.duration - duration) <= 3 ? 0 : 1);
  return list.map((c, i) => [c, i]).sort((a, b) => near(a[0]) - near(b[0]) || a[1] - b[1]).map(([c]) => c);
}

/**
 * @param {object} t the track
 * @param {Record<string, HTMLInputElement>} inputs Track information fields
 * @param {{artwork: string|null}} pending receives the chosen artwork URL (applied on save)
 */
export function lookupPanel(t, inputs, pending) {
  const panel = h('div.ti-spotify', { hidden: true });
  const query = h('input.text', { value: [t.artist, t.title].filter(Boolean).join(' - '), spellcheck: false });
  const status = h('span.dim');
  const pick = h('select', { hidden: true });
  const table = h('div.ti-sp-table');
  const applyBtn = h('button.dbtn.dlc-primary', { hidden: true }, 'Use the ticked values');
  let results = [];
  let checks = new Map();

  const current = (k) => (k === 'artwork' ? (pending.artwork ? 'new cover' : t.artwork ? 'current cover' : '') : String(inputs[k]?.value ?? ''));

  const showCandidate = () => {
    const c = results[Number(pick.value) || 0];
    const src = SOURCE[c.source] ?? c.source;
    checks = new Map();
    const rows = FIELDS.map(([k, label]) => {
      let found = k === 'artwork' ? c.artworkUrl : c[k];
      if (found === 0) found = '';
      const same = k !== 'artwork' && String(found ?? '').toLowerCase() === current(k).toLowerCase();
      const box = h('input', { type: 'checkbox', checked: DEFAULT_ON.has(k) && !!found && !same, disabled: !found || same });
      let value = () => found;
      let cell;
      if (k === 'artwork') cell = found ? h('img.ti-sp-cover', { src: c.thumbUrl || found, alt: '' }) : h('span.dim', {}, '—');
      else if (k === 'genre' && c.genres.length > 1) {
        // Every genre found: choose which one goes in the Genre field.
        const sel = h('select', { onchange: () => { box.disabled = false; box.checked = true; } },
          c.genres.map((g) => h('option', { value: g, selected: g === c.genre }, g)));
        value = () => sel.value;
        cell = sel;
      } else cell = found ? h('span', { title: String(found) }, String(found)) : h('span.dim', {}, k === 'genre' ? 'no genre found' : '—');
      if (k === 'genre' && c.completedFrom === 'deezer' && found) cell = h('span', {}, cell, h('small.dim', {}, ' (Deezer)'));
      checks.set(k, { box, value });
      return h('label.ti-sp-row', { class: same ? 'same' : undefined },
        box, h('span.ti-sp-k', {}, label),
        h('span.ti-sp-cur', { title: current(k) }, current(k) || h('span.dim', {}, '(empty)')),
        h('span.ti-sp-arrow', {}, same ? '=' : '→'), h('span.ti-sp-new', {}, cell));
    });
    table.replaceChildren(...[h('div.ti-sp-head', {}, h('span'), h('span', {}, 'Field'), h('span', {}, 'Now'), h('span'), h('span', {}, `Found on ${src}`)), ...rows,
      h('div.ti-sp-foot', {},
        c.url ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.rb.openExternal(c.url); } }, `Open on ${src}`) : null,
        c.duration ? h('span.dim', {}, `${c.url ? ' · ' : ''}Length ${fmtTime(c.duration)}${t.duration ? ` (this file: ${fmtTime(t.duration)})` : ''}`) : null)].filter(Boolean));
    applyBtn.hidden = false;
  };

  const search = async () => {
    panel.hidden = false;
    status.textContent = 'Searching online…';
    table.replaceChildren(); pick.hidden = true; applyBtn.hidden = true;
    let r;
    try {
      const q = query.value.trim();
      const same = q === [t.artist, t.title].filter(Boolean).join(' - ');
      r = await lookupApi.lookup(same ? { title: inputs.title.value || t.title, artist: inputs.artist.value || t.artist } : { query: q });
    } catch (err) {
      status.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      return;
    }
    results = orderByDuration(r.candidates, t.duration);
    const where = r.sources.join(' + ');
    const problems = r.errors.length ? ` (${r.errors.join('; ')})` : '';
    if (!results.length) { status.textContent = `Nothing found on ${where}${problems}. Change the search words and try again.`; return; }
    status.textContent = `${results.length} result(s) on ${where}${problems}${results.length > 1 ? ' — choose the right one:' : ':'}`;
    pick.replaceChildren(...results.map((c, i) => h('option', { value: i },
      `[${SOURCE[c.source] ?? c.source}] ${c.artist} — ${c.title}${c.mixName ? ` (${c.mixName})` : ''} · ${c.album}${c.year ? `, ${c.year}` : ''}${c.genre ? ` · ${c.genre}` : ''}${c.duration ? ` · ${fmtTime(c.duration)}` : ''}`)));
    pick.hidden = results.length < 2;
    showCandidate();
  };
  pick.onchange = showCandidate;
  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

  applyBtn.onclick = () => {
    let n = 0;
    for (const [k, { box, value }] of checks) {
      if (!box.checked) continue;
      if (k === 'artwork') { pending.artwork = value(); n++; continue; }
      const input = inputs[k];
      if (!input) continue;
      input.value = String(value());
      input.classList.add('ti-changed');
      n++;
    }
    status.textContent = n ? `✓ ${n} field(s) filled in — press Save to keep them.` : 'Nothing ticked.';
    if (n) showCandidate();
  };

  const open = h('button.dbtn.small.ti-sp-open', { type: 'button', onclick: search, title: 'Deezer (genres, label…), plus Spotify when it is set up in Preferences > Library' }, 'Search Deezer');
  window.rb.spotify?.status().then((st) => { if (st.clientId && st.hasSecret) open.textContent = 'Search Deezer + Spotify'; }).catch(() => {});
  panel.append(
    h('div.dlc-bar', {}, query, h('button.dbtn', { type: 'button', onclick: search }, 'Search'), h('button.dbtn.small', { type: 'button', onclick: () => { panel.hidden = true; } }, 'Close')),
    h('div.ti-sp-status', {}, status, ' ', pick), table, applyBtn);
  return { button: open, panel };
}
