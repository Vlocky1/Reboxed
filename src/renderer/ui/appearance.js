// Preferences > Appearance: theme, accent colour, interface size, top bar style.
import { h } from './dom.js';
import { THEMES, ACCENTS, UI_SCALES, themeVars } from '../themes.js';

/** @param {object} library @param {(key: string, value: any) => void} apply */
export function appearanceSection(library, apply) {
  const s = () => library.settings;
  const cards = h('div.theme-grid');
  const accents = h('div.accent-row');

  const renderCards = () => cards.replaceChildren(...THEMES.map((t) => {
    const v = themeVars({ theme: t.id, themeAccent: s().themeAccent });
    // Miniature of the interface: top bar, waveform strip, two decks, browser rows.
    const mini = h('div.theme-mini', { style: { background: v['--bg'] } },
      h('div', { style: { height: '6px', background: v['--bg-0'], borderBottom: `1px solid ${v['--line']}` } }),
      h('div', { style: { height: '10px', margin: '3px 4px', borderRadius: '2px', background: `linear-gradient(90deg, ${v['--wave-bg']} 0 20%, ${v['--accent']} 20% 23%, ${v['--wave-bg']} 23% 48%, ${v['--on']} 48% 51%, ${v['--wave-bg']} 51%)` } }),
      h('div', { style: { display: 'flex', gap: '3px', margin: '0 4px' } },
        ...[0, 1].map(() => h('div', { style: { flex: 1, height: '18px', borderRadius: '2px', background: v['--panel'], border: `1px solid ${v['--line']}` } },
          h('div', { style: { width: '40%', height: '3px', margin: '3px', background: v['--text-2'], borderRadius: '1px' } }),
          h('div', { style: { width: '24%', height: '5px', margin: '0 3px', background: v['--accent'], borderRadius: '1px' } })))),
      h('div', { style: { margin: '3px 4px', height: '10px', background: v['--bg-2'], borderTop: `1px solid ${v['--line']}` } },
        h('div', { style: { width: '70%', height: '3px', margin: '3px 2px', background: v['--dim'] } })));
    const on = (s().theme ?? 'dark') === t.id;
    return h(`button.theme-card${on ? '.on' : ''}`, { type: 'button', dataset: { theme: t.id }, onclick: () => { apply('theme', t.id); renderCards(); renderAccents(); } },
      mini, h('span', {}, t.name));
  }));

  const renderAccents = () => {
    const cur = s().themeAccent;
    const themeAccent = themeVars({ theme: s().theme })['--accent'];
    accents.replaceChildren(
      h(`button.accent-dot.auto${cur ? '' : '.on'}`, { type: 'button', title: 'The theme\'s own accent', style: { background: themeAccent }, onclick: () => { apply('themeAccent', null); renderCards(); renderAccents(); } }, 'A'),
      ...ACCENTS.map((c) => h(`button.accent-dot${cur === c ? '.on' : ''}`, { type: 'button', title: c, dataset: { accent: c }, style: { background: c }, onclick: () => { apply('themeAccent', c); renderCards(); renderAccents(); } })),
      h('label.accent-custom', { title: 'Any colour' }, h('input', { type: 'color', value: cur ?? themeAccent, onchange: (e) => { apply('themeAccent', e.target.value); renderCards(); renderAccents(); } })));
  };
  renderCards();
  renderAccents();

  const sel = (key, options, cast = (x) => x) => h('select', { onchange: (e) => apply(key, cast(e.target.value)) },
    options.map(([v, l]) => h('option', { value: v, selected: String(s()[key] ?? '') === String(v) }, l)));
  return h('div', {},
    h('h4', {}, 'Theme'), cards,
    h('h4', {}, 'Accent colour'), h('p.dim', {}, 'Buttons that are on, selections, SYNC, progress bars… "A" keeps the theme\'s own colour.'), accents,
    h('h4', {}, 'Layout'),
    h('div.form-grid', {},
      h('label', {}, 'Interface size'), sel('uiScale', UI_SCALES, Number),
      h('label', {}, 'Top bar'), sel('topbarLabels', [['full', 'Icons and names'], ['icons', 'Icons only (more room)']])));
}
