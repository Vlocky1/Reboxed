// Intelligent playlist editor and Related Tracks criteria panel.
import { h, modal } from './dom.js';
import { SMART_FIELDS, SMART_OPS, defaultCondition } from '../../shared/smartlist.js';
import { TRACK_COLORS } from '../../shared/rekordbox-xml.js';
import { displayKey } from '../../shared/keys.js';

const CAMELOT = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * @param {{name: string, rules: object}} initial
 * @param {{keyNotation: string, tags: string[]}} ctx
 * @returns {Promise<{name: string, rules: object} | null>}
 */
export function editSmartList(initial, ctx) {
  const state = { name: initial.name, rules: clone(initial.rules) };
  if (!state.rules.conditions.length) state.rules.conditions.push(defaultCondition('genre'));
  const list = h('div.cond-list');
  const nameInput = h('input.text', { value: state.name, oninput: (e) => { state.name = e.target.value; } });
  const matchSel = h('select', { onchange: (e) => { state.rules.match = e.target.value; } },
    h('option', { value: 'all', selected: state.rules.match !== 'any' }, 'Match all of the conditions'),
    h('option', { value: 'any', selected: state.rules.match === 'any' }, 'Match any of the conditions'));
  const limit = h('input.num', { type: 'number', min: 0, value: state.rules.limit ?? 0, onchange: (e) => { state.rules.limit = Number(e.target.value) || 0; } });

  const valueInputs = (c) => {
    const type = SMART_FIELDS[c.field].type;
    const input = (key, attrs = {}) => h('input.text.cond-val', { value: c[key] ?? '', ...attrs, oninput: (e) => { c[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; } });
    if (type === 'key') {
      return h('select', { onchange: (e) => { c.value = e.target.value; } },
        CAMELOT.map((k) => h('option', { value: k, selected: c.value === k }, displayKey(k, ctx.keyNotation))));
    }
    if (type === 'enum') {
      return h('select', { onchange: (e) => { c.value = e.target.value; } }, TRACK_COLORS.map((col) => h('option', { value: col.name, selected: c.value === col.name }, col.name)));
    }
    if (type === 'tags') {
      return ctx.tags.length
        ? h('select', { onchange: (e) => { c.value = e.target.value; } }, ctx.tags.map((t) => h('option', { value: t, selected: c.value === t }, t)))
        : input('value', { placeholder: 'tag' });
    }
    if (type === 'number') {
      return c.op === 'range'
        ? h('span.cond-range', {}, input('value', { type: 'number', step: 'any' }), ' – ', input('value2', { type: 'number', step: 'any' }))
        : input('value', { type: 'number', step: 'any' });
    }
    if (type === 'date') {
      return c.op === 'range'
        ? h('span.cond-range', {}, input('value', { type: 'date' }), ' – ', input('value2', { type: 'date' }))
        : input('value', { type: 'number', min: 1 });
    }
    return input('value');
  };

  const render = () => {
    list.replaceChildren(...state.rules.conditions.map((c, i) => {
      const type = SMART_FIELDS[c.field].type;
      const fieldSel = h('select', { onchange: (e) => { state.rules.conditions[i] = defaultCondition(e.target.value); render(); } },
        Object.entries(SMART_FIELDS).map(([k, def]) => h('option', { value: k, selected: c.field === k }, def.label)));
      const opSel = h('select', { onchange: (e) => { c.op = e.target.value; if (type === 'date' && c.op === 'range') { c.value = ''; c.value2 = ''; } render(); } },
        SMART_OPS[type].map(([k, label]) => h('option', { value: k, selected: c.op === k }, label)));
      return h('div.cond-row', {}, fieldSel, opSel, valueInputs(c),
        h('button.dbtn.small', { title: 'Remove', onclick: () => { state.rules.conditions.splice(i, 1); render(); } }, '−'));
    }), h('button.dbtn.small', { onclick: () => { state.rules.conditions.push(defaultCondition('bpm')); render(); } }, '+ Condition'));
  };
  render();

  const body = h('div.smart-editor', {},
    h('div.form-grid', {}, h('label', {}, 'Name'), nameInput, h('label', {}, 'Rule'), matchSel,
      h('label', {}, 'Limit (0 = none)'), limit),
    list);
  return modal('Intelligent Playlist', body, [
    { label: 'Save', primary: true, value: () => ({ name: state.name.trim() || 'Intelligent Playlist', rules: state.rules }) },
    { label: 'Cancel', value: null },
  ]);
}

/**
 * Related Tracks criteria panel. Calls onChange(criteria, seed) on every edit.
 * @param {object} criteria settings.related (cloned and mutated locally)
 * @param {string} seed 'master' | 'deckN' | 'selected'
 */
export function relatedPanel(criteria, seed, deckCount, onChange) {
  const c = clone(criteria);
  let s = seed;
  const fire = () => onChange(clone(c), s);
  const toggle = (rule, label) => h('label.ftoggle', {}, h('input', { type: 'checkbox', checked: !!c[rule].on, onchange: (e) => { c[rule].on = e.target.checked; fire(); } }), label);
  const num = (rule, key, attrs) => h('input.num', { type: 'number', value: c[rule][key], ...attrs, onchange: (e) => { c[rule][key] = Number(e.target.value); fire(); } });
  return h('div.filter-panel.related-panel', {},
    h('div.frow', {}, h('span.ftoggle', {}, 'TRACK'),
      h('select', { onchange: (e) => { s = e.target.value; fire(); } },
        [['master', 'Master deck'], ...Array.from({ length: deckCount }, (_, i) => [`deck${i + 1}`, `Deck ${i + 1}`]), ['selected', 'Selected track']]
          .map(([v, l]) => h('option', { value: v, selected: s === v }, l))),
      h('select', { onchange: (e) => { c.match = e.target.value; fire(); } },
        h('option', { value: 'all', selected: c.match === 'all' }, 'Match all of the items'),
        h('option', { value: 'any', selected: c.match === 'any' }, 'Match any of the items'))),
    h('div.frow', {}, toggle('bpm', 'BPM'), h('span', {}, '±'), num('bpm', 'pct', { min: 0, max: 50, step: 1 }), h('span', {}, '%'),
      h('label', {}, h('input', { type: 'checkbox', checked: c.bpm.doubleHalf, onchange: (e) => { c.bpm.doubleHalf = e.target.checked; fire(); } }), ' including double/half'),
      toggle('key', 'KEY'),
      h('select', { onchange: (e) => { c.key.mode = e.target.value; fire(); } },
        h('option', { value: 'same', selected: c.key.mode === 'same' }, 'Same key'),
        h('option', { value: 'compatible', selected: c.key.mode === 'compatible' }, 'Related keys'))),
    h('div.frow', {}, toggle('genre', 'GENRE'), toggle('artist', 'ARTIST'),
      h('label', {}, h('input', { type: 'checkbox', checked: c.artist.includeFeat, onchange: (e) => { c.artist.includeFeat = e.target.checked; fire(); } }), ' incl. feat./title'),
      toggle('label', 'LABEL'), toggle('color', 'COLOR'), toggle('myTag', 'MY TAG')),
    h('div.frow', {}, toggle('year', 'YEAR'), h('span', {}, '±'), num('year', 'range', { min: 0, max: 30 }),
      toggle('rating', 'RATING'), h('span', {}, '≥'), num('rating', 'min', { min: 0, max: 5 })));
}
