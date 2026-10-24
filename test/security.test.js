import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isTrustedUrl, guardIpc, hardenContents } from '../src/main/security.js';

test('only Reboxed pages are trusted', () => {
  assert.equal(isTrustedUrl('app://rb/renderer/index.html'), true);
  assert.equal(isTrustedUrl('app://rb/renderer/index.html?smoke=1'), true);
  for (const url of ['https://example.com/', 'http://localhost/', 'file:///C:/x.html', 'app://evil/x', 'appx://rb/', 'about:blank', '', null]) {
    assert.equal(isTrustedUrl(url), false, String(url));
  }
});

test('IPC answers only Reboxed pages', async () => {
  const handlers = {}; const listeners = {};
  const ipc = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    handleOnce: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { listeners[ch] = fn; },
    once: (ch, fn) => { listeners[ch] = fn; },
  };
  const blocked = [];
  guardIpc(ipc, { log: (m) => blocked.push(m) });
  ipc.handle('fs:writeFile', (_e, path) => `wrote ${path}`);
  let heard = 0;
  ipc.on('smoke:ready', () => { heard++; });
  const from = (url) => ({ senderFrame: { url } });
  assert.equal(await handlers['fs:writeFile'](from('app://rb/renderer/index.html'), 'x'), 'wrote x');
  assert.throws(() => handlers['fs:writeFile'](from('https://example.com/'), 'x'), /Not allowed/);
  assert.throws(() => handlers['fs:writeFile']({ sender: { getURL: () => 'file:///C:/other.html' } }, 'x'), /Not allowed/);
  listeners['smoke:ready'](from('https://example.com/'));
  listeners['smoke:ready'](from('app://rb/renderer/index.html'));
  assert.equal(heard, 1);
  assert.equal(blocked.length, 3);
  assert.equal(guardIpc(ipc), ipc, 'guarding twice changes nothing');
});

test('the window never leaves Reboxed pages and opens no new window', () => {
  const contents = new EventEmitter();
  let openHandler = null;
  contents.setWindowOpenHandler = (fn) => { openHandler = fn; };
  hardenContents(contents);
  const navigate = (event, url) => { let prevented = false; contents.emit(event, { preventDefault: () => { prevented = true; }, url }, url); return prevented; };
  assert.equal(navigate('will-navigate', 'https://example.com/'), true);
  assert.equal(navigate('will-navigate', 'file:///C:/Users/x/Downloads/page.html'), true);
  assert.equal(navigate('will-redirect', 'http://localhost:9999/'), true);
  assert.equal(navigate('will-frame-navigate', 'https://example.com/frame'), true);
  assert.equal(navigate('will-navigate', 'app://rb/renderer/index.html'), false, 'reloading the app is fine');
  let webview = false;
  contents.emit('will-attach-webview', { preventDefault: () => { webview = true; } });
  assert.equal(webview, true);
  assert.deepEqual(openHandler({ url: 'https://example.com/' }), { action: 'deny' });
});
