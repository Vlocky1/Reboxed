import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyAppDir, copyDatabase, moveStemsRoot, Storage } from '../src/main/storage.js';
import { LibraryStore } from '../src/main/library-store.js';

const exists = (p) => access(p).then(() => true, () => false);

test('first start of Reboxed: %APPDATA%/rbclone becomes %APPDATA%/Reboxed, artwork paths follow', async () => {
  const appData = await mkdtemp(join(tmpdir(), 'reboxed-mig-'));
  const old = join(appData, 'rbclone');
  await mkdir(join(old, 'artwork'), { recursive: true });
  await mkdir(join(old, 'models', 'spleeter'), { recursive: true });
  await writeFile(join(old, 'artwork', 'a.jpg'), 'x');
  await writeFile(join(old, 'library.json'), JSON.stringify({
    version: 1,
    tracks: [{ id: 't', path: 'D:\\Music\\Song.mp3', artwork: join(old, 'artwork', 'a.jpg') }],
    settings: { grooveCaptures: { '0:0:0': { file: `${old}/groove/deck1-A1.wav` } } },
  }));
  assert.equal(migrateLegacyAppDir(appData), true);
  const now = join(appData, 'Reboxed');
  assert.ok(await exists(join(now, 'library.json')));
  assert.ok(await exists(join(now, 'models', 'spleeter')));
  assert.ok(!(await exists(old)));
  assert.equal(migrateLegacyAppDir(appData), false); // only once

  const store = new LibraryStore(now, { legacyDir: old });
  const lib = await store.load();
  assert.equal(lib.tracks[0].artwork, join(now, 'artwork', 'a.jpg'));
  assert.equal(lib.tracks[0].path, 'D:\\Music\\Song.mp3');
  assert.equal(lib.settings.grooveCaptures['0:0:0'].file, join(now, 'groove', 'deck1-A1.wav'));
  await store.save(lib);
  assert.equal(JSON.parse(await readFile(join(now, 'library.json'), 'utf8')).dbDir, now);
});

test('library folder on a removable drive: copy, default stems folder inside it, stems move', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reboxed-db-'));
  const app = join(base, 'app'); const usb = join(base, 'usb');
  await mkdir(join(app, 'analysis'), { recursive: true });
  await mkdir(join(app, 'stems', 'Song'), { recursive: true });
  await writeFile(join(app, 'library.json'), '{"tracks":[]}');
  await writeFile(join(app, 'analysis', 't.json'), '{}');
  await writeFile(join(app, 'stems', 'Song', 'reboxed-stems.json'), '{}');
  await copyDatabase(app, usb, { withStems: true });
  for (const f of ['library.json', 'analysis/t.json', 'stems/Song/reboxed-stems.json']) assert.ok(await exists(join(usb, f)), f);

  const storage = new Storage(app);
  storage.cfg.database = usb;
  assert.equal(storage.stemsRoot, join(usb, 'stems'));
  storage.cfg.stemsMode = 'custom'; storage.cfg.stemsDir = join(usb, 'Tracks', 'stems');
  assert.equal(await moveStemsRoot(join(usb, 'stems'), storage.stemsRoot), 1);
  assert.ok(await exists(join(usb, 'Tracks', 'stems', 'Song', 'reboxed-stems.json')));
  storage.cfg.stemsMode = 'beside';
  assert.equal(storage.stemsRoot, null);
});
