// Interface choices kept between sessions: the defaults until the user changes something, then
// that choice; nothing kept (nor read) when remembering is off; "back to the defaults" forgets all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UiMemory } from '../src/renderer/ui-memory.js';

const fakeLibrary = (settings = {}) => ({ settings: { rememberUi: true, ui: {}, ...settings }, saves: 0, scheduleSave() { this.saves++; } });

test('defaults first, then what the user changed', () => {
  const lib = fakeLibrary();
  const ui = new UiMemory(lib);
  assert.equal(ui.get('deck0.pads', null), null, 'nothing kept yet: the default');
  ui.set('deck0.pads', { mode: 'BEAT JUMP', bank: 0, page: 1 });
  assert.deepEqual(ui.get('deck0.pads'), { mode: 'BEAT JUMP', bank: 0, page: 1 });
  // a new session reads the same settings (they are saved with the library)
  const next = new UiMemory(fakeLibrary({ ui: lib.settings.ui }));
  assert.deepEqual(next.get('deck0.pads'), { mode: 'BEAT JUMP', bank: 0, page: 1 });
  assert.equal(next.get('sort:collection', 'default'), 'default');
});

test('only real changes are written', () => {
  const lib = fakeLibrary();
  const ui = new UiMemory(lib);
  ui.set('sort:pl1', { col: 'bpm', dir: 1 });
  ui.set('sort:pl1', { col: 'bpm', dir: 1 });
  assert.equal(lib.saves, 1, 'the same value again: no save');
  ui.set('sort:pl1', { col: 'bpm', dir: -1 });
  assert.equal(lib.saves, 2);
});

test('remembering off: nothing kept, nothing read; back to the defaults forgets all', () => {
  const lib = fakeLibrary({ rememberUi: false, ui: { waveZoom: 16 } });
  const ui = new UiMemory(lib);
  assert.equal(ui.get('waveZoom', 8), 8, 'off: the default even if something was kept');
  ui.set('waveZoom', 20);
  assert.equal(lib.settings.ui.waveZoom, 16, 'off: nothing written');
  lib.settings.rememberUi = true;
  assert.equal(ui.get('waveZoom', 8), 16);
  assert.equal(ui.count, 1);
  ui.clear();
  assert.equal(ui.count, 0);
  assert.equal(ui.get('waveZoom', 8), 8);
});
