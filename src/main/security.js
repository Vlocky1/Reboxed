// Hardening of the app window. Only Reboxed's own pages (app://rb/…) may run in a window, reach the
// main process (IPC) or get permissions (MIDI, audio devices). Any other page — a link dropped on the
// window, a redirect, a window.open — is never loaded, and a frame from elsewhere gets no answer.

export const APP_ORIGIN = 'app://rb';

/** Is this URL one of Reboxed's own pages? */
export function isTrustedUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'app:' && u.host === 'rb';
  } catch {
    return false;
  }
}

/** URL of the frame that sent an IPC message (the top page's URL as a fallback). */
const senderUrl = (event) => event?.senderFrame?.url || event?.sender?.getURL?.() || '';

/**
 * Every IPC handler / listener registered after this call answers only Reboxed's own pages.
 * A call from anywhere else is refused (handle) or ignored (on / once).
 * @param {import('electron').IpcMain} ipc
 */
export function guardIpc(ipc, { log = () => {} } = {}) {
  if (ipc.__rbGuarded) return ipc;
  const wrap = (fn, refuse) => (event, ...args) => {
    if (!isTrustedUrl(senderUrl(event))) { log(`blocked IPC from ${senderUrl(event) || 'unknown'}`); return refuse(); }
    return fn(event, ...args);
  };
  const handle = ipc.handle.bind(ipc);
  const handleOnce = ipc.handleOnce?.bind(ipc);
  const on = ipc.on.bind(ipc);
  const once = ipc.once.bind(ipc);
  ipc.handle = (channel, fn) => handle(channel, wrap(fn, () => { throw new Error('Not allowed'); }));
  if (handleOnce) ipc.handleOnce = (channel, fn) => handleOnce(channel, wrap(fn, () => { throw new Error('Not allowed'); }));
  ipc.on = (channel, fn) => on(channel, wrap(fn, () => undefined));
  ipc.once = (channel, fn) => once(channel, wrap(fn, () => undefined));
  ipc.__rbGuarded = true;
  return ipc;
}

/**
 * A window's contents never leave Reboxed's pages: navigations, redirects and frame navigations to
 * anything else are cancelled, new windows are refused, <webview> is refused.
 * @param {import('electron').WebContents} contents
 */
export function hardenContents(contents, { log = () => {} } = {}) {
  const block = (what) => (event, url) => {
    const target = typeof url === 'string' ? url : event?.url;
    if (isTrustedUrl(target)) return;
    event.preventDefault();
    log(`blocked ${what} to ${target}`);
  };
  contents.on('will-navigate', block('navigation'));
  contents.on('will-redirect', block('redirect'));
  contents.on('will-frame-navigate', block('frame navigation'));
  contents.on('will-attach-webview', (event) => { event.preventDefault(); log('blocked webview'); });
  contents.setWindowOpenHandler(({ url }) => { log(`blocked new window ${url}`); return { action: 'deny' }; });
}

/**
 * Permissions (MIDI, audio output devices…) only for Reboxed's own pages.
 * @param {import('electron').Session} session
 */
export function hardenSession(session) {
  session.setPermissionRequestHandler((contents, _permission, callback, details) => {
    callback(isTrustedUrl(details?.requestingUrl || contents?.getURL?.()));
  });
  session.setPermissionCheckHandler((contents, _permission, requestingOrigin, details) => {
    const origin = details?.requestingUrl || requestingOrigin || contents?.getURL?.() || '';
    return isTrustedUrl(/^[a-z]+:\/\/[^/]+$/i.test(origin) ? `${origin}/` : origin);
  });
}
