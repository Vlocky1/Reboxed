import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/renderer/library.js';

function lib() {
  const l = new Library({ playlists: [
    { id: 'f1', type: 'folder', name: 'Sets', open: false, children: [
      { id: 'p1', type: 'playlist', name: 'Friday', trackIds: [] },
      { id: 'f2', type: 'folder', name: 'Old', open: false, children: [{ id: 'p2', type: 'playlist', name: '2024', trackIds: [] }] },
    ] },
    { id: 'p3', type: 'playlist', name: 'Warm-up', trackIds: [] },
    { id: 's1', type: 'smart', name: 'Techno 130+', rules: { match: 'all', conditions: [] } },
  ] });
  l.scheduleSave = () => {};
  return l;
}
const shape = (nodes) => nodes.map((n) => (n.type === 'folder' ? [n.id, shape(n.children)] : n.id));

test('move a playlist into a folder, between nodes, back to the top level', () => {
  const l = lib();
  assert.ok(l.moveNode('p3', 'f2', 'inside'));
  assert.deepEqual(shape(l.playlists), [['f1', ['p1', ['f2', ['p2', 'p3']]]], 's1']);
  assert.equal(l.findNode('f2').node.open, true);
  assert.ok(l.moveNode('p3', 'p1', 'before'));
  assert.deepEqual(shape(l.playlists), [['f1', ['p3', 'p1', ['f2', ['p2']]]], 's1']);
  assert.ok(l.moveNode('s1', 'p1', 'after'));
  assert.deepEqual(shape(l.playlists), [['f1', ['p3', 'p1', 's1', ['f2', ['p2']]]]]);
  assert.ok(l.moveNode('p1', null));
  assert.deepEqual(shape(l.playlists), [['f1', ['p3', 's1', ['f2', ['p2']]]], 'p1']);
  assert.ok(l.moveNode('p2', 'p3', 'inside')); // onto a playlist = right after it
  assert.deepEqual(shape(l.playlists), [['f1', ['p3', 'p2', 's1', ['f2', []]]], 'p1']);
});

test('a folder cannot go inside itself or its subfolders', () => {
  const l = lib();
  assert.equal(l.moveNode('f1', 'f2', 'inside'), false);
  assert.equal(l.moveNode('f1', 'p2', 'before'), false);
  assert.equal(l.moveNode('f1', 'f1', 'inside'), false);
  assert.deepEqual(l.folderTargets('f1'), []);
  assert.deepEqual(l.folderTargets('p3').map((x) => [x.node.id, x.depth]), [['f1', 0], ['f2', 1]]);
  assert.ok(l.moveNode('f2', null));
  assert.deepEqual(shape(l.playlists), [['f1', ['p1']], 'p3', 's1', ['f2', ['p2']]]);
});
