import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginStore } from '../src/main/plugins.js';
import { PluginRegistry } from '../src/renderer/controller/plugins.js';

const builtinDir = fileURLToPath(new URL('../src/plugins', import.meta.url));
const CSV = [
  '@file,1,DDJ-TEST',
  '#name,function,type,input,deck1,deck2,deck3,deck4,output,deck1,deck2,deck3,deck4,option,comment',
  'PlayPause,PlayPause,Button,900B,0,1,,,900B,0,1,,,Fast,Play/Pause',
].join('\n');

const fakeLibrary = () => ({ settings: {}, setSetting(k, v) { this.settings[k] = v; } });

test('built-in controller plugins are valid and their mappings load', async () => {
  const store = new PluginStore(builtinDir, join(mkdtempSync(join(tmpdir(), 'rbx-pl-')), 'plugins'));
  const all = await store.list();
  const reg = new PluginRegistry(fakeLibrary());
  reg.all = all;
  for (const id of ['pioneer-ddj-grv6', 'pioneer-ddj-flx2', 'pioneer-ddj-flx4', 'pioneer-ddj-flx6', 'pioneer-ddj-flx10']) {
    const p = all.find((x) => x.id === id);
    assert.ok(p, id);
    assert.equal(reg.problem(p), null, id);
    const mapping = JSON.parse(await store.read(id, p.mapping));
    assert.ok(mapping.entries.length > 50, `${id}: ${mapping.entries.length} entries`);
  }
  assert.equal(all.find((p) => p.id === 'pioneer-ddj-grv6').audio.layout, 'quad');
});

test('picks the plugin from the MIDI port name (longest match, enabled only)', () => {
  const lib = fakeLibrary();
  const reg = new PluginRegistry(lib);
  reg.all = [
    { id: 'a', kind: 'controller', driver: 'pioneer', mapping: 'm.json', match: ['DDJ-FLX'] },
    { id: 'b', kind: 'controller', driver: 'pioneer', mapping: 'm.json', match: ['DDJ-FLX10'] },
    { id: 'c', kind: 'controller', driver: 'unknown', mapping: 'm.json', match: ['XDJ'] },
  ];
  assert.equal(reg.forPort('DDJ-FLX10 MIDI 1').id, 'b');
  assert.equal(reg.forPort('ddj flx4').id, 'a');
  assert.equal(reg.forPort('XDJ-RX3'), null);
  reg.setEnabled('b', false);
  assert.deepEqual(lib.settings.pluginsDisabled, ['b']);
  assert.equal(reg.forPort('DDJ-FLX10 MIDI 1').id, 'a');
  reg.setEnabled('b', true);
  assert.equal(reg.forPort('DDJ-FLX10').id, 'b');
});

test('installs, overrides, creates from a rekordbox CSV and removes user plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rbx-pl-'));
  const store = new PluginStore(builtinDir, join(root, 'plugins'));
  // A user plugin with a built-in id replaces it.
  const src = join(root, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'pioneer-ddj-flx4', name: 'My FLX4', kind: 'controller', driver: 'pioneer', match: ['DDJ-FLX4'], mapping: 'mapping.csv' }));
  writeFileSync(join(src, 'mapping.csv'), CSV);
  await store.install(src);
  const flx4 = (await store.list()).filter((p) => p.id === 'pioneer-ddj-flx4');
  assert.equal(flx4.length, 1);
  assert.equal(flx4[0].name, 'My FLX4');
  assert.equal(flx4[0].overrides, true);
  await assert.rejects(store.read('pioneer-ddj-flx4', '../../outside.txt'), /outside/);
  // Raw rekordbox CSV mappings are parsed by the registry.
  globalThis.window = { rb: { plugins: { read: (id, f) => store.read(id, f) } } };
  const reg = new PluginRegistry(fakeLibrary());
  assert.equal((await reg.mapping(flx4[0])).device, 'DDJ-TEST');
  await store.remove('pioneer-ddj-flx4');
  assert.equal((await store.list()).find((p) => p.id === 'pioneer-ddj-flx4').builtin, true);
  await assert.rejects(store.remove('pioneer-ddj-grv6'), /only plugins you installed/);
  // From a rekordbox mapping.
  const csv = join(root, 'DDJ-TEST.midi.csv');
  writeFileSync(csv, CSV);
  const m = await store.createFromCsv(csv, { decks: 2 });
  assert.equal(m.id, 'custom-ddj-test');
  assert.deepEqual(m.match, ['DDJ-TEST']);
  assert.ok(existsSync(join(root, 'plugins', 'custom-ddj-test', 'mapping.json')));
  assert.equal(JSON.parse(readFileSync(join(root, 'plugins', 'custom-ddj-test', 'mapping.json'), 'utf8')).entries.length, 1);
  // Bad manifests are listed with their error instead of breaking the list.
  mkdirSync(join(root, 'plugins', 'broken'));
  writeFileSync(join(root, 'plugins', 'broken', 'plugin.json'), '{ nope');
  assert.match((await store.list()).find((p) => p.id === 'broken').error, /plugin\.json/);
});
