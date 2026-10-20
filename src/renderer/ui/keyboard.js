// Keyboard shortcuts, after Rekordbox's "Performance 1" preset, all reassignable (Preferences >
// Keyboard). A binding is a physical key (KeyboardEvent.code) with modifiers, e.g. "Shift+KeyD";
// labels show the letters of the user's own layout. AZERTY keyboards are detected and get the
// AZERTY preset (same letters as the QWERTY preset) until the user changes the bindings.
import { h, toast } from './dom.js';

const LOOP_SIZES = [0.5, 1, 2, 4, 8];

/** Deck actions (bound once per deck 1 and 2). hold: also acts on key release. */
export const DECK_ACTIONS = [
  { id: 'play', label: 'Play / Pause', run: (d) => d.playPause() },
  { id: 'cue', label: 'Cue (hold to preview)', hold: true, run: (d) => d.cueDown(), release: (d) => d.cueUp() },
  { id: 'sync', label: 'Beat sync', run: (d) => d.toggleSync() },
  { id: 'bendDown', label: 'Pitch bend −', hold: true, repeat: true, run: (d) => d.nudge(-1), release: (d) => d.nudge(0) },
  { id: 'bendUp', label: 'Pitch bend +', hold: true, repeat: true, run: (d) => d.nudge(1), release: (d) => d.nudge(0) },
  { id: 'loopIn', label: 'Loop in', run: (d) => d.loopIn() },
  { id: 'loopOut', label: 'Loop out', run: (d) => d.loopOut() },
  { id: 'reloop', label: 'Reloop / exit', run: (d) => d.reloopExit() },
  { id: 'loopHalf', label: 'Loop ½', run: (d) => d.resizeLoop(0.5) },
  { id: 'loopDouble', label: 'Loop ×2', run: (d) => d.resizeLoop(2) },
  ...LOOP_SIZES.map((b, k) => ({ id: `beatLoop${k}`, label: `Beat loop ${b === 0.5 ? '½' : b}`, run: (d) => d.beatLoop(b) })),
  ...[0, 1, 2, 3].map((k) => ({ id: `hot${k}`, label: `Hot cue ${'ABCD'[k]}`, run: (d) => d.hotCuePress(k) })),
  ...[0, 1, 2, 3].map((k) => ({ id: `hotDel${k}`, label: `Delete hot cue ${'ABCD'[k]}`, run: (d) => d.deleteHotCue(k) })),
  { id: 'slipRev', label: 'Slip reverse (hold)', hold: true,
    run: (d) => { if (!d.slip) { d.toggleSlip(); d.autoSlip = true; } d.setReverse(true); },
    release: (d) => { d.setReverse(false); if (d.autoSlip) { d.autoSlip = false; d.toggleSlip(); } } },
  { id: 'memSet', label: 'Set memory cue', run: (d) => d.addMemoryCue() },
  { id: 'memDel', label: 'Delete memory cue', run: (d) => d.deleteMemoryCueNear() },
  { id: 'load', label: 'Load selected track', run: (d, app) => { const id = app.browser.currentTrackId(); if (id) app.loadTrack(d.index, id); } },
];
export const GLOBAL_ACTIONS = [
  { id: 'search', label: 'Search', run: (app) => app.browser.focusSearch() },
  { id: 'layout', label: 'Browser full / split', run: (app) => app.toggleLayout() },
];

/** Rekordbox "Performance 1" (QWERTY positions). */
export const QWERTY_KEYMAP = (() => {
  const m = { search: 'Ctrl+KeyF', layout: 'Space' };
  const decks = [
    { play: 'KeyZ', cue: 'KeyA', sync: 'KeyQ', bendDown: 'KeyW', bendUp: 'KeyE', loopIn: 'KeyD', loopOut: 'KeyF', reloop: 'KeyG', loopHalf: 'Shift+KeyD', loopDouble: 'Shift+KeyG',
      slipRev: 'KeyS', memSet: 'Shift+KeyT', memDel: 'Shift+KeyR', load: 'Shift+ArrowLeft', digits: [1, 2, 3, 4, 5] },
    { play: 'KeyN', cue: 'KeyH', sync: 'KeyY', bendDown: 'KeyU', bendUp: 'KeyI', loopIn: 'KeyK', loopOut: 'KeyL', reloop: 'Semicolon', loopHalf: 'Shift+KeyK', loopDouble: 'Shift+Semicolon',
      slipRev: 'KeyJ', memSet: 'Shift+KeyP', memDel: 'Shift+KeyO', load: 'Shift+ArrowRight', digits: [6, 7, 8, 9, 0] },
  ];
  decks.forEach(({ digits, ...keys }, i) => {
    for (const [id, code] of Object.entries(keys)) m[`deck${i + 1}.${id}`] = code;
    digits.forEach((n, k) => { m[`deck${i + 1}.beatLoop${k}`] = `Ctrl+Digit${n}`; });
    digits.slice(0, 4).forEach((n, k) => { m[`deck${i + 1}.hot${k}`] = `Digit${n}`; m[`deck${i + 1}.hotDel${k}`] = `Shift+Digit${n}`; });
  });
  return m;
})();

/** The same letters on an AZERTY keyboard (A/Q, Z/W swapped; ";" is where QWERTY has ","). */
export const AZERTY_KEYMAP = Object.fromEntries(Object.entries(QWERTY_KEYMAP).map(([k, v]) => [k, v.replace(/Key[AQZW]$|Semicolon$/, (c) => ({ KeyA: 'KeyQ', KeyQ: 'KeyA', KeyZ: 'KeyW', KeyW: 'KeyZ', Semicolon: 'Comma' })[c])]));

export const PRESETS = { qwerty: ['QWERTY (Rekordbox Performance 1)', QWERTY_KEYMAP], azerty: ['AZERTY (same letters)', AZERTY_KEYMAP] };

/** Layout map of the user's keyboard (code -> character), when the browser can tell. */
let layoutMap = null;
export async function loadLayoutMap() {
  try { layoutMap = await navigator.keyboard?.getLayoutMap?.(); } catch { layoutMap = null; }
  return layoutMap;
}
export const isAzerty = () => layoutMap?.get?.('KeyQ') === 'a' && layoutMap?.get?.('KeyW') === 'z';

const NAMES = { Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: 'Enter', Tab: 'Tab', Backspace: '⌫', Escape: 'Esc' };
/** "Shift+KeyD" -> "Shift + D" in the user's layout. */
export function comboLabel(combo) {
  if (!combo) return '—';
  return combo.split('+').map((part) => {
    if (['Ctrl', 'Shift', 'Alt'].includes(part)) return part;
    const ch = layoutMap?.get?.(part);
    if (ch && ch.trim()) return ch.length === 1 ? ch.toUpperCase() : ch;
    return NAMES[part] ?? part.replace(/^Key|^Digit|^Numpad/, '');
  }).join(' + ');
}

/** Combo of a key event (null for a lone modifier). */
export function comboOf(e) {
  if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return null;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.code].filter(Boolean).join('+');
}

/** The bindings in use: the user's, else the preset that fits the keyboard. */
export function currentKeymap(settings) {
  if (settings.keymap && Object.keys(settings.keymap).length) return { ...QWERTY_KEYMAP, ...settings.keymap };
  return isAzerty() ? AZERTY_KEYMAP : QWERTY_KEYMAP;
}

/** Every bindable action: {key, label, deck, action}. */
export function allActions() {
  return [
    ...GLOBAL_ACTIONS.map((a) => ({ key: a.id, label: a.label, deck: null, action: a })),
    ...DECK_ACTIONS.flatMap((a) => [0, 1].map((i) => ({ key: `deck${i + 1}.${a.id}`, label: a.label, deck: i, action: a }))),
  ];
}

/** @param {object} app {engine, browser, loadTrack, toggleLayout, library} */
export function installKeyboard(app) {
  loadLayoutMap();
  const actions = allActions();
  const held = new Map(); // code -> action entry being held
  let cache = { settings: null, byCombo: null };
  const lookup = () => {
    const s = app.library.settings;
    if (cache.settings !== s || cache.layout !== layoutMap) {
      const km = currentKeymap(s);
      cache = { settings: s, layout: layoutMap, byCombo: new Map(actions.filter((a) => km[a.key]).map((a) => [km[a.key], a])) };
    }
    return cache.byCombo;
  };
  const isTyping = (e) => {
    const t = e.target;
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
  };

  window.addEventListener('keydown', (e) => {
    const combo = comboOf(e);
    if (!combo) return;
    const entry = lookup().get(combo);
    if (!entry) return;
    if (entry.key === 'search') { e.preventDefault(); entry.action.run(app); return; }
    if (isTyping(e) || document.querySelector('.overlay')) return;
    e.preventDefault();
    if (e.repeat && !entry.action.repeat) return;
    if (entry.deck === null) { entry.action.run(app); return; }
    const d = app.engine.decks[entry.deck];
    if (!d) return;
    if (entry.action.hold) { if (held.has(e.code) && !entry.action.repeat) return; held.set(e.code, entry); }
    entry.action.run(d, app);
  });
  window.addEventListener('keyup', (e) => {
    const entry = held.get(e.code);
    if (!entry) return;
    held.delete(e.code);
    entry.action.release?.(app.engine.decks[entry.deck], app);
  });
  window.addEventListener('blur', () => { for (const [, entry] of held) entry.action.release?.(app.engine.decks[entry.deck], app); held.clear(); });
}

/** Preferences > Keyboard: presets and every binding, click a key then press the new one. */
export async function keyboardSection(library) {
  await loadLayoutMap();
  let map = currentKeymap(library.settings);
  const save = (m) => { map = m; library.setSetting('keymap', { ...m }); render(); };
  const actions = allActions();
  const labelOf = (key) => actions.find((a) => a.key === key)?.label ?? key;
  let recording = null; // {key, button}
  const table = h('table.shortcuts.keymap');
  const status = h('span.dim');

  const bindButton = (key) => {
    const b = h('button.key-bind', { type: 'button', dataset: { key } }, comboLabel(map[key]));
    b.onclick = () => {
      if (recording) recording.button.classList.remove('rec');
      recording = { key, button: b };
      b.classList.add('rec'); b.textContent = 'Press a key…';
      status.textContent = 'Press the new key (with Shift / Ctrl / Alt if you want). Esc cancels, Backspace removes the key.';
    };
    return b;
  };
  const render = () => {
    const deckRows = DECK_ACTIONS.map((a) => h('tr', {}, h('td', {}, a.label), h('td', {}, bindButton(`deck1.${a.id}`)), h('td', {}, bindButton(`deck2.${a.id}`))));
    const globalRows = GLOBAL_ACTIONS.map((a) => h('tr', {}, h('td', {}, a.label), h('td', { colSpan: 2 }, bindButton(a.id))));
    table.replaceChildren(
      h('tr', {}, h('th', {}, 'Function'), h('th', {}, 'Deck 1'), h('th', {}, 'Deck 2')),
      ...deckRows,
      h('tr', {}, h('th', { colSpan: 3 }, 'Everywhere')),
      ...globalRows,
      h('tr', {}, h('td', {}, 'Full screen on / off'), h('td', { colSpan: 2 }, h('span.key-fixed', {}, 'F11'))));
  };
  // Key capture (before the dialog's own Escape / Enter handling).
  const onKey = (e) => {
    if (!recording) return;
    if (!table.isConnected) { window.removeEventListener('keydown', onKey, true); return; }
    e.preventDefault(); e.stopPropagation();
    const { key } = recording;
    if (e.code === 'Escape') { recording = null; status.textContent = ''; render(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { const m = { ...map }; delete m[key]; recording = null; status.textContent = `${labelOf(key)}: no key`; save(m); return; }
    const combo = comboOf(e);
    if (!combo) return;
    const m = { ...map };
    const taken = Object.entries(m).find(([k, v]) => v === combo && k !== key);
    if (taken) delete m[taken[0]];
    m[key] = combo;
    recording = null;
    status.textContent = taken ? `${comboLabel(combo)} was used by "${labelOf(taken[0])}${taken[0].startsWith('deck') ? ` (deck ${taken[0][4]})` : ''}": that one has no key now.` : `${labelOf(key)} → ${comboLabel(combo)}`;
    save(m);
  };
  window.addEventListener('keydown', onKey, true);
  render();
  const detected = layoutMap ? (isAzerty() ? 'AZERTY keyboard detected.' : 'Keyboard layout detected.') : '';
  return h('div', {},
    h('div.form-grid', {},
      h('label', {}, 'Preset'), h('div', {}, h('div.frow', {},
        ...Object.entries(PRESETS).map(([id, [label, preset]]) => h('button.dbtn.small', { type: 'button', onclick: () => { save({ ...preset }); status.textContent = `${label} loaded`; toast(`Keyboard: ${label}`); } }, label))),
      h('small', {}, `${detected} Keys are physical keys; their letters are shown as on your keyboard.`)),
      h('label', {}, 'Change a key'), h('div', {}, h('small', {}, 'Click a key below, then press the new one.'), status)),
    h('h4', {}, 'Shortcuts'),
    table);
}
