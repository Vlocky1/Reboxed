// "Clean names": the name cleaner on tracks already in the collection — every change shown first,
// ticked by default; Apply saves, Undo restores (shares the auto-tag undo).
import { h, toast } from './dom.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { cleanTrackName, parseKeywords, DEFAULT_KEYWORDS } from '../../shared/clean-name.js';

const keywordsOf = (lib) => parseKeywords({ ...DEFAULT_SETTINGS.downloads, ...(lib.settings.downloads ?? {}) }.cleanKeywords);

/** Proposed changes for these tracks. */
export function cleanProposals(tracks, keywords) {
  const out = [];
  for (const t of tracks) {
    const c = cleanTrackName(t, keywords);
    if (c.title !== (t.title ?? '') || c.artist !== (t.artist ?? '')) out.push({ track: t, title: c.title, artist: c.artist });
  }
  return out;
}

/** @param {object} app @param {string[]} ids */
export function openCleanNames(app, ids) {
  const lib = app.library;
  const tracks = ids.map((id) => lib.get(id)).filter(Boolean);
  const props = cleanProposals(tracks, keywordsOf(lib));
  if (!props.length) { toast(`Nothing to clean in ${tracks.length} track(s)`); return Promise.resolve(null); }
  return new Promise((resolve) => {
    const boxes = props.map(() => h('input', { type: 'checkbox', checked: true }));
    const cell = (from, to) => (from === to ? h('span.at-same', {}, to) : h('span', {}, h('span.at-from', {}, from || '(empty)'), ' → ', h('span.at-to', {}, to)));
    const apply = h('button.primary', {}, 'Apply');
    const overlay = h('div.overlay', {}, h('div.dialog.autotag-dialog', { role: 'dialog' },
      h('h2', {}, `Clean names: ${props.length} of ${tracks.length} track(s)`),
      h('div.dialog-body.autotag', {},
        h('p.dim', {}, 'Removes "(Paroles)", "[Official Video]", "| Lyrics", "Visualizer", "- Topic", "VEVO"… and splits "Artist - Title". Mixes, remixes, edits, featurings and live versions stay. The keywords are in Preferences > Downloads.'),
        h('div.at-list', {}, props.map((p, i) => h('label.at-clean', {}, boxes[i],
          h('div', {}, h('div', {}, h('span.at-k', {}, 'Title '), cell(p.track.title ?? '', p.title)), h('div', {}, h('span.at-k', {}, 'Artist '), cell(p.track.artist ?? '', p.artist))))))),
      h('div.dialog-buttons', {}, h('button', { onclick: () => close(null) }, 'Cancel'), apply)));
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    apply.onclick = () => {
      const undo = [];
      props.forEach((p, i) => {
        if (!boxes[i].checked) return;
        undo.push({ id: p.track.id, before: { title: p.track.title ?? '', artist: p.track.artist ?? '' } });
        lib.update(p.track.id, { title: p.title, artist: p.artist });
        app.onTrackEdited?.(p.track.id);
      });
      app.lastAutoTag = undo;
      toast(`${undo.length} name(s) cleaned — "Undo the last auto-tag" in the ⋯ menu puts them back`, 5000);
      close({ cleaned: undo.length });
    };
    document.body.append(overlay);
  });
}

/** Preferences > Downloads: cleaner switch, keywords and a live test. */
export function cleanerSettings(cfg, save) {
  const area = h('textarea.text', { rows: 3, spellcheck: false, placeholder: DEFAULT_KEYWORDS.join(', '), value: cfg.cleanKeywords ?? '' });
  const test = h('input.text', { value: 'Indochine - Trois nuits par semaine (Clip officiel) [Paroles]', spellcheck: false });
  const testArtist = h('input.text', { value: 'IndochineVEVO', spellcheck: false, style: { maxWidth: '150px' } });
  const out = h('div.dim');
  const run = () => { const c = cleanTrackName({ title: test.value, artist: testArtist.value }, parseKeywords(area.value)); out.textContent = `→ Artist: ${c.artist || '(empty)'} · Title: ${c.title}`; };
  area.addEventListener('input', run); test.addEventListener('input', run); testArtist.addEventListener('input', run);
  area.addEventListener('change', () => save({ cleanKeywords: area.value.trim() }));
  run();
  return [
    h('label', {}, 'Clean names when adding'), h('div', {}, h('input', { type: 'checkbox', checked: cfg.cleanNames !== false, onchange: (e) => save({ cleanNames: e.target.checked }) }),
      h('span.dim', {}, '  removes (Paroles), [Official Video], Lyrics, Visualizer, - Topic, VEVO… from downloaded tracks')),
    h('label', {}, 'Words to remove'), h('div', {}, area, h('small.dim', {}, 'Comma separated, whole words, case and accents ignored. Empty = the default list. Brackets that also name a mix, remix, edit, feat. or live version are kept.')),
    h('label', {}, 'Try it'), h('div', {}, h('div.frow', {}, testArtist, test), out),
  ];
}
