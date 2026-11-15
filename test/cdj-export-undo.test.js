// Export to a USB drive over another software's export, then undo: the drive comes back byte for
// byte (databases, a cover at the same path, a settings file); nothing is deleted. With the other
// software open, the export refuses before touching anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportToDrive, undoExport, listBackups, MANIFEST } from '../src/main/cdj-export.js';

function fakeDrive() {
  const root = mkdtempSync(join(tmpdir(), 'rbx-drive-'));
  const rb = join(root, 'PIONEER', 'rekordbox');
  mkdirSync(rb, { recursive: true });
  mkdirSync(join(root, 'PIONEER', 'Artwork', '00001'), { recursive: true });
  const before = {
    'PIONEER/rekordbox/export.pdb': 'their pdb',
    'PIONEER/rekordbox/exportExt.pdb': 'their ext',
    'PIONEER/rekordbox/exportLibrary.db': 'their library',
    'PIONEER/Artwork/00001/a1.jpg': 'their cover 1',
    'PIONEER/MYSETTING.DAT': 'their settings',
  };
  for (const [rel, text] of Object.entries(before)) writeFileSync(join(root, rel), text);
  // a track on the drive, with a cover in the library
  mkdirSync(join(root, 'Tracks'));
  writeFileSync(join(root, 'Tracks', 'song.mp3'), Buffer.alloc(2048, 1));
  const cover = join(root, '..', `${root.split(/[\\/]/).pop()}-cover.jpg`);
  writeFileSync(cover, 'reboxed cover');
  return { root, before, track: { id: 't1', title: 'Song', artist: 'Artist', path: join(root, 'Tracks', 'song.mp3'), duration: 10, bpm: 120, artwork: cover } };
}

const run = (d, o = {}) => exportToDrive({ root: d.root, tracks: [d.track], playlists: [{ type: 'playlist', name: 'Set', trackIds: ['t1'] }], settings: {}, checkOtherSoftware: async () => false, ...o },
  { getAnalysis: async () => null, resizeJpeg: () => null });

test('the other DJ software open: refused, the drive untouched', async () => {
  const d = fakeDrive();
  await assert.rejects(run(d, { checkOtherSoftware: async () => true }), /Close your other DJ software first/);
  for (const [rel, text] of Object.entries(d.before)) assert.equal(readFileSync(join(d.root, rel), 'utf8'), text, rel);
  assert.equal(readdirSync(join(d.root, 'PIONEER', 'rekordbox')).filter((n) => n.startsWith('backup-')).length, 0);
});

test('an export over another export is journaled, and undo puts the drive back byte for byte', async () => {
  const d = fakeDrive();
  const r = await run(d);
  assert.equal(r.tracks, 1);
  assert.ok(r.backup && existsSync(join(r.backup, MANIFEST)));
  const m = JSON.parse(readFileSync(join(r.backup, MANIFEST), 'utf8'));
  assert.deepEqual(m.moved.sort(), ['export.pdb', 'exportExt.pdb', 'exportLibrary.db']);
  assert.ok(m.replaced.some((p) => /Artwork[\\/]00001[\\/]a1\.jpg$/.test(p)), 'the cover at the same path is kept before being overwritten');
  assert.ok(m.replaced.some((p) => /MYSETTING\.DAT$/.test(p)));
  assert.ok(m.created.some((p) => /ANLZ0000\.DAT$/.test(p)));
  assert.equal(readFileSync(join(d.root, 'PIONEER', 'Artwork', '00001', 'a1.jpg'), 'utf8'), 'reboxed cover');
  assert.equal((await listBackups(d.root)).length, 1);

  const u = await undoExport(d.root, r.backup);
  for (const [rel, text] of Object.entries(d.before)) assert.equal(readFileSync(join(d.root, rel), 'utf8'), text, `${rel} is back`);
  assert.ok(!existsSync(join(d.root, 'PIONEER', 'Artwork', '00001', 'a1_m.jpg')), 'files the export created are set aside');
  assert.ok(existsSync(join(u.dir, 'PIONEER', 'rekordbox', 'export.pdb')), "Reboxed's database is kept aside, not deleted");
  assert.equal((await listBackups(d.root)).length, 0, 'an undone backup is not offered again');
});

test('a backup made before the journal (databases only) can be undone too', async () => {
  const d = fakeDrive();
  const rb = join(d.root, 'PIONEER', 'rekordbox');
  const old = join(rb, 'backup-2026-11-15T10-15-50-440Z');
  mkdirSync(old);
  for (const n of ['export.pdb', 'exportExt.pdb', 'exportLibrary.db']) { writeFileSync(join(old, n), `old ${n}`); writeFileSync(join(rb, n), `new ${n}`); }
  const u = await undoExport(d.root, old);
  assert.equal(u.restored, 3);
  for (const n of ['export.pdb', 'exportExt.pdb', 'exportLibrary.db']) {
    assert.equal(readFileSync(join(rb, n), 'utf8'), `old ${n}`);
    assert.equal(readFileSync(join(u.dir, 'PIONEER', 'rekordbox', n), 'utf8'), `new ${n}`);
  }
});
