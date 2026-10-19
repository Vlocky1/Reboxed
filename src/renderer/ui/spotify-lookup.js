// Track information ▸ "Search Spotify": find the track on Spotify, show what was found next to each
// field, and copy only the ticked values into the form (Genre is ticked by default). Nothing is
// saved until the Track information dialog is saved.
import { h, fmtTime } from './dom.js';

const FIELDS = [
  ['title', 'Title'], ['mixName', 'Mix name'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['genre', 'Genre'], ['year', 'Year'], ['trackNumber', 'Track number'], ['discNumber', 'Disc number'], ['label', 'Label'],
  ['artwork', 'Artwork'],
];
const DEFAULT_ON = new Set(['genre']);
/** Spotify search (replaced by the smoke test, which runs offline). */
export const spotifyApi = { lookup: (q) => window.rb.spotify.lookup(q) };

/** Spotify results, the closest duration first (within 3 s), keeping Spotify's order otherwise. */
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
export function spotifyPanel(t, inputs, pending) {
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
        // All the artist's genres: choose which one goes in the Genre field.
        const sel = h('select', { onchange: () => { box.checked = true; } }, c.genres.map((g) => h('option', { value: g }, g)));
        value = () => sel.value;
        cell = sel;
      } else cell = found ? h('span', { title: String(found) }, String(found)) : h('span.dim', {}, k === 'genre' ? 'no genre on Spotify' : '—');
      checks.set(k, { box, value });
      return h('label.ti-sp-row', { class: same ? 'same' : undefined },
        box, h('span.ti-sp-k', {}, label),
        h('span.ti-sp-cur', { title: current(k) }, current(k) || h('span.dim', {}, '(empty)')),
        h('span.ti-sp-arrow', {}, same ? '=' : '→'), h('span.ti-sp-new', {}, cell));
    });
    table.replaceChildren(...[h('div.ti-sp-head', {}, h('span'), h('span', {}, 'Field'), h('span', {}, 'Now'), h('span'), h('span', {}, 'Spotify')), ...rows,
      c.spotifyUrl ? h('div.ti-sp-foot', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.rb.openExternal(c.spotifyUrl); } }, 'Open on Spotify'),
        c.duration ? h('span.dim', {}, ` · ${fmtTime(c.duration)}${t.duration ? ` (this file: ${fmtTime(t.duration)})` : ''}`) : null) : null].filter(Boolean));
    applyBtn.hidden = false;
  };

  const search = async () => {
    panel.hidden = false;
    status.textContent = 'Searching Spotify…';
    table.replaceChildren(); pick.hidden = true; applyBtn.hidden = true;
    try {
      const q = query.value.trim();
      const same = q === [t.artist, t.title].filter(Boolean).join(' - ');
      results = orderByDuration(await spotifyApi.lookup(same ? { title: inputs.title.value || t.title, artist: inputs.artist.value || t.artist } : { query: q }), t.duration);
    } catch (err) {
      status.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      return;
    }
    if (!results.length) { status.textContent = 'Nothing found. Change the search words and try again.'; return; }
    status.textContent = results.length > 1 ? `${results.length} results — choose the right one:` : '1 result:';
    pick.replaceChildren(...results.map((c, i) => h('option', { value: i }, `${c.artist} — ${c.title}${c.mixName ? ` (${c.mixName})` : ''} · ${c.album}${c.year ? `, ${c.year}` : ''}${c.duration ? ` · ${fmtTime(c.duration)}` : ''}`)));
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

  const open = h('button.dbtn.small.ti-sp-open', { type: 'button', onclick: search }, 'Search Spotify');
  panel.append(
    h('div.dlc-bar', {}, query, h('button.dbtn', { type: 'button', onclick: search }, 'Search'), h('button.dbtn.small', { type: 'button', onclick: () => { panel.hidden = true; } }, 'Close')),
    h('div.ti-sp-status', {}, status, ' ', pick), table, applyBtn);
  return { button: open, panel };
}
