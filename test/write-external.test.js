// Files saved outside the library (XML / M3U exports): into an existing folder as is, into a
// missing one by creating it. (The drive-root case — "J:\" exists but mkdir on it throws EPERM —
// cannot be reproduced without writing to a real drive root; writeExternal checks the folder
// before creating it for that reason.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from '../src/main/library-store.js';

const store = Object.create(LibraryStore.prototype);

test('an existing folder: written as is; a missing one: created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-write-'));
  await store.writeExternal(join(dir, 'collection.xml'), '<DJ_PLAYLISTS/>');
  assert.equal(readFileSync(join(dir, 'collection.xml'), 'utf8'), '<DJ_PLAYLISTS/>');
  await store.writeExternal(join(dir, 'a', 'b', 'set.m3u8'), Uint8Array.of(35, 69));
  assert.ok(existsSync(join(dir, 'a', 'b', 'set.m3u8')));
});
