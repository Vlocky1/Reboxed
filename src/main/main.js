import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, safeStorage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { access, copyFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { wavHeader } from '../shared/wav.js';
import { tmpdir } from 'node:os';
import { LibraryStore } from './library-store.js';
import { scanPaths, readTags, findFiles, listAudio, AUDIO_EXTENSIONS } from './scanner.js';
import { StemService } from './stems.js';
import { Storage, migrateLegacyAppDir, hasLibrary, copyDatabase, moveStemsRoot } from './storage.js';
import { Downloader } from './downloader.js';
import { ToolInstaller, TOOLS } from './tools.js';
import { exportToDrive, listDrives } from './cdj-export.js';
import { PluginStore } from './plugins.js';
import { Spotify } from './spotify.js';
import { Deezer } from './deezer.js';
import { MetadataLookup } from './metadata.js';
import { Updater } from './updater.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = normalize(join(here, '..'));
// --shots=<folder>: screenshots of every feature on a demo library (npm run shots), in the same
// throw-away app folder as the smoke test.
const shotsDir = process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? null;
const smoke = process.argv.includes('--smoke') || !!shotsDir;

// App folder %APPDATA%/Reboxed (machine-local: location.json, stem models, caches). Versions before
// 1.2 used %APPDATA%/rbclone: it is moved here once. The smoke test runs in a temporary folder.
app.setName('Reboxed');
const smokeDir = smoke ? mkdtempSync(join(tmpdir(), 'reboxed-smoke-')) : null;
if (!smoke) migrateLegacyAppDir(app.getPath('appData'));
const appDir = smokeDir ?? join(app.getPath('appData'), 'Reboxed');
app.setPath('userData', appDir);
if (process.platform === 'win32') app.setAppUserModelId('com.reboxed.app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
};

/** app://rb/<path under src/> -> static file, confined to src/. */
async function serveApp(request) {
  const url = new URL(request.url);
  const file = normalize(join(srcRoot, decodeURIComponent(url.pathname)));
  if (!file.startsWith(srcRoot + sep)) return new Response('Forbidden', { status: 403 });
  try {
    return new Response(await readFile(file), { headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** media://local/<encoded absolute path> -> audio file (audio extensions, or cached stem PCM). */
function serveMedia(request) {
  const url = new URL(request.url);
  const file = normalize(decodeURIComponent(url.pathname.slice(1)));
  const isStem = extname(file) === '.pcm' && stems && file.startsWith(stems.root + sep);
  const isArt = extname(file) === '.jpg' && store && file.startsWith(join(store.dir, 'artwork') + sep);
  if (!isStem && !isArt && !AUDIO_EXTENSIONS.has(extname(file).toLowerCase())) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
}

let store;
let stems;
let downloader;
let storage;
let plugins;

/** Embedded cover -> 96 px JPEG thumbnail in userData/artwork (deduplicated by content hash). */
async function saveArtwork(data) {
  const buf = Buffer.from(data);
  const dir = join(store.dir, 'artwork');
  const file = join(dir, `${createHash('sha1').update(buf).digest('hex').slice(0, 20)}.jpg`);
  try { await access(file); return file; } catch { /* not cached yet */ }
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return '';
  await mkdir(dir, { recursive: true });
  await writeFile(file, img.resize({ width: 96, quality: 'good' }).toJPEG(82));
  return file;
}

function registerIpc(win) {
  stems = new StemService(appDir, storage, (ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); });
  // Dev/smoke: point at already-downloaded models instead of fetching them.
  if (process.env.REBOXED_STEM_MODEL) stems.overrides.hq = process.env.REBOXED_STEM_MODEL;
  if (process.env.REBOXED_SPLEETER_DIR) stems.overrides.fast = process.env.REBOXED_SPLEETER_DIR;

  // Database folder (library, analysis, artwork, captures; may be a USB drive) and stems folder.
  ipcMain.handle('storage:info', () => storage.info());
  ipcMain.handle('storage:hasLibrary', (_e, dir) => hasLibrary(dir));
  /** mode 'move': copy the current library there; 'open': use the library already there. Restarts. */
  ipcMain.handle('storage:setDatabase', async (_e, dir, mode) => {
    if (mode === 'move') await copyDatabase(store.dir, dir, { withStems: storage.cfg.stemsMode === 'database' });
    storage.cfg.database = dir && normalize(dir) !== normalize(appDir) ? dir : null;
    await storage.save();
    if (!smoke) { app.relaunch(); app.exit(0); }
    return storage.info();
  });
  /** mode 'database' | 'custom' | 'beside'; move = bring the existing stems folders along. */
  ipcMain.handle('storage:setStems', async (_e, mode, dir, move) => {
    const before = storage.stemsRoot;
    storage.cfg.stemsMode = mode;
    storage.cfg.stemsDir = mode === 'custom' ? dir : storage.cfg.stemsDir;
    await storage.save();
    const moved = move ? await moveStemsRoot(before, storage.stemsRoot) : 0;
    return { moved, info: storage.info() };
  });
  ipcMain.handle('stems:relocate', (_e, id, oldPath, newPath) => stems.relocate(id, oldPath, newPath));
  ipcMain.handle('stems:convertToMp3', (_e, tracks, kbps) => stems.convertToMp3(tracks, kbps));
  ipcMain.handle('fs:listAudio', (_e, dir) => listAudio(dir));
  // Hardware plugins (docs/PLUGINS.md): built-in ones in src/plugins, the user's in <app folder>/plugins.
  plugins = new PluginStore(join(srcRoot, 'plugins'), join(appDir, 'plugins'));
  ipcMain.handle('plugins:list', () => plugins.list());
  ipcMain.handle('plugins:read', (_e, id, file) => plugins.read(id, file));
  ipcMain.handle('plugins:install', (_e, dir) => plugins.install(dir));
  ipcMain.handle('plugins:remove', (_e, id) => plugins.remove(id));
  ipcMain.handle('plugins:createFromCsv', (_e, csv, opts) => plugins.createFromCsv(csv, opts));
  ipcMain.handle('plugins:openFolder', async () => { await mkdir(plugins.userDir, { recursive: true }); return shell.openPath(plugins.userDir); });
  // Spotify track information lookup. The Client Secret is kept encrypted (OS keychain) in location.json.
  // Online lookups never hang the dialog: 15 s per request at most.
  const timedFetch = async (url, opts = {}) => {
    try { return await net.fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); } catch (err) {
      throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? `no answer from ${new URL(url).hostname} (15 s)` : `${new URL(url).hostname}: ${err.message}`);
    }
  };
  const spotify = new Spotify({
    fetch: timedFetch,
    credentials: () => {
      const c = storage.cfg.spotify;
      if (!c?.clientId || !c?.secret) return null;
      try { return { clientId: c.clientId, secret: safeStorage.decryptString(Buffer.from(c.secret, 'base64')) }; } catch { return null; }
    },
  });
  ipcMain.handle('spotify:status', () => ({ clientId: storage.cfg.spotify?.clientId ?? '', hasSecret: !!storage.cfg.spotify?.secret }));
  ipcMain.handle('spotify:setCredentials', async (_e, clientId, secret) => {
    const prev = storage.cfg.spotify ?? {};
    const enc = secret ? safeStorage.encryptString(secret).toString('base64') : (clientId ? prev.secret : null);
    storage.cfg.spotify = clientId ? { clientId, secret: enc } : null;
    await storage.save();
    spotify.forget();
    if (clientId && enc) await spotify.auth(); // check the credentials now
    return { clientId: storage.cfg.spotify?.clientId ?? '', hasSecret: !!storage.cfg.spotify?.secret };
  });
  ipcMain.handle('spotify:lookup', (_e, q) => spotify.lookup(q));
  // Deezer (no account) + Spotify (when set up), merged: Deezer brings the genres Spotify lacks.
  const metadata = new MetadataLookup({ spotify, deezer: new Deezer({ fetch: timedFetch }), spotifyReady: () => !!(storage.cfg.spotify?.clientId && storage.cfg.spotify?.secret) });
  ipcMain.handle('metadata:lookup', (_e, q, source, opts) => metadata.lookup(q, source, opts));
  /** Cover from a URL (Spotify, Deezer) -> library artwork thumbnail path. */
  ipcMain.handle('artwork:fromUrl', async (_e, url) => {
    if (!/^https:\/\/(i\.scdn\.co|cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net)\//.test(url)) throw new Error('unsupported artwork URL');
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`artwork ${res.status}`);
    return saveArtwork(new Uint8Array(await res.arrayBuffer()));
  });
  // Export to a USB drive for CDJ / XDJ players.
  ipcMain.handle('cdj:drives', () => listDrives());
  ipcMain.handle('cdj:export', (e, job) => exportToDrive(job, {
    getAnalysis: (id) => store.getAnalysis(id),
    resizeJpeg: (buf, size) => { const img = nativeImage.createFromBuffer(buf); return img.isEmpty() ? null : img.resize({ width: size, height: size, quality: 'good' }).toJPEG(85); },
    progress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('cdj:progress', p); },
  }));
  // Migration to a USB drive: tags of candidate files (no artwork), 8 at a time.
  ipcMain.handle('tags:readMany', async (_e, paths) => {
    const out = {};
    for (let i = 0; i < paths.length; i += 8) {
      const part = await Promise.all(paths.slice(i, i + 8).map((p) => readTags(p)));
      part.forEach((t, k) => { out[paths[i + k]] = { title: t.title, artist: t.artist, duration: t.duration ?? 0 }; });
    }
    return out;
  });
  /** Copy a file into a folder without overwriting (same size already there = reused). Returns the new path. */
  ipcMain.handle('fs:copyInto', async (_e, src, dir) => {
    await mkdir(dir, { recursive: true });
    const size = (await stat(src)).size;
    const ext = extname(src); const name = basename(src, ext);
    for (let k = 1; k < 100; k++) {
      const dest = join(dir, k === 1 ? `${name}${ext}` : `${name} (${k})${ext}`);
      let existing = null;
      try { existing = await stat(dest); } catch { /* free */ }
      if (existing) { if (existing.size === size) return dest; continue; }
      await copyFile(src, dest);
      if ((await stat(dest)).size !== size) throw new Error(`copy of ${src} is incomplete`);
      return dest;
    }
    throw new Error(`no free name for ${src} in ${dir}`);
  });
  // Local copies replaced by the ones on the USB drive go to the Recycle Bin (recoverable).
  ipcMain.handle('fs:trash', async (_e, paths) => {
    let n = 0;
    for (const p of paths) { try { await shell.trashItem(p); n++; } catch { /* in use or gone */ } }
    return n;
  });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\/(www\.|music\.)?youtube\.com\/|^https:\/\/youtu\.be\//.test(url)) shell.openExternal(url);
  });
  downloader = new Downloader((ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); });
  // yt-dlp / deno / ffmpeg installed from the app go to Reboxed's own tools folder.
  downloader.toolsDir = join(appDir, 'tools');
  const toolInstaller = new ToolInstaller({
    dir: downloader.toolsDir, fetch: (url, opts) => net.fetch(url, opts), version: app.getVersion(),
    send: (ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); },
  });
  ipcMain.handle('dl:tools', (_e, dir) => { downloader.customDir = dir ?? ''; return downloader.tools(); });
  ipcMain.handle('tools:install', async (_e, names) => { await toolInstaller.install(names.filter((n) => TOOLS[n])); return downloader.tools(); });
  ipcMain.handle('tools:updateYtdlp', async () => ({ ...(await toolInstaller.updateYtdlp()), tools: await downloader.tools() }));
  ipcMain.handle('dl:search', (_e, q, n, platform) => downloader.search(q, n, platform));
  ipcMain.handle('dl:feed', (_e, url, n) => downloader.feed(url, n));
  ipcMain.handle('dl:resolve', (_e, url) => downloader.resolve(url));
  ipcMain.handle('dl:download', (_e, item, opts) => downloader.download(item, opts));
  ipcMain.handle('dl:cancel', (_e, key) => downloader.cancel(key));
  ipcMain.handle('stems:status', () => stems.status());
  ipcMain.handle('stems:download', (_e, quality) => stems.downloadModel(quality));
  ipcMain.handle('stems:meta', (_e, id, trackPath) => stems.meta(id, trackPath));
  ipcMain.handle('stems:separate', (_e, id, left, right, opts) => stems.separate(id, left, right, opts));
  ipcMain.handle('stems:delete', (_e, id, trackPath) => stems.remove(id, trackPath));
  ipcMain.handle('stems:deleteAll', () => stems.removeAll());

  // A connected controller's mapping from the user's rekordbox install (MidiMappings/<model>.midi.csv).
  ipcMain.handle('controller:rbMapping', async (_e, deviceName) => {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => join(p, 'rekordbox'));
    for (const root of roots) {
      let versions = [];
      try { versions = (await readdir(root)).sort().reverse(); } catch { continue; }
      for (const v of versions) {
        const dir = join(root, v, 'MidiMappings');
        let files = [];
        try { files = await readdir(dir); } catch { continue; }
        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const hit = files.find((f) => f.endsWith('.midi.csv') && norm(deviceName).startsWith(norm(f.replace('.midi.csv', ''))));
        if (hit) return { file: join(dir, hit), text: await readFile(join(dir, hit), 'utf8') };
      }
    }
    return null;
  });

  ipcMain.handle('library:load', () => store.load());
  ipcMain.handle('library:save', (_e, data) => store.save(data));
  ipcMain.handle('analysis:get', (_e, id) => store.getAnalysis(id));
  ipcMain.handle('analysis:put', (_e, id, data) => store.putAnalysis(id, data));

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:openFiles', async (_e, kind) => {
    const filters = kind === 'xml' ? [{ name: 'rekordbox XML', extensions: ['xml'] }]
      : kind === 'csv' ? [{ name: 'rekordbox controller mapping', extensions: ['csv'] }]
      : [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((x) => x.slice(1)) }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:saveFile', async (_e, defaultName, ext) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('scan:paths', (e, paths) => scanPaths(paths, (done, total) => e.sender.send('scan:progress', done, total), { saveArtwork }));
  ipcMain.handle('tags:read', (_e, path) => readTags(path, { saveArtwork }));
  ipcMain.handle('fs:readText', (_e, path) => readFile(path, 'utf8'));
  ipcMain.handle('fs:exists', (_e, path) => access(path).then(() => true, () => false));
  // rekordbox import: check thousands of files at once, find moved ones by file name.
  ipcMain.handle('fs:existsMany', async (_e, paths) => {
    const out = new Array(paths.length);
    for (let i = 0; i < paths.length; i += 64) {
      const part = await Promise.all(paths.slice(i, i + 64).map((p) => access(p).then(() => true, () => false)));
      part.forEach((v, k) => { out[i + k] = v; });
    }
    return out;
  });
  ipcMain.handle('fs:findFiles', (_e, dir, names) => findFiles(dir, names));
  ipcMain.handle('fs:writeFile', (_e, path, data) => store.writeExternal(path, data));
  ipcMain.handle('shell:showItem', (_e, path) => shell.showItemInFolder(path));
  ipcMain.handle('app:version', () => app.getVersion());
  // In-app updates (GitHub releases).
  const updater = new Updater({
    version: app.getVersion(), fetch: (url, opts) => net.fetch(url, opts), tempDir: app.getPath('temp'),
    send: (ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); },
    quit: () => app.quit(),
  });
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', (_e, asset) => updater.download(asset));
  ipcMain.handle('update:install', (_e, file) => { if (smoke) return false; updater.install(file); return true; });
  ipcMain.handle('app:paths', () => ({ userData: store.dir, appDir, music: smoke ? store.dir : app.getPath('music') }));

  // Streaming WAV recorder: PCM chunks are appended in order, the header is patched on stop.
  const recordings = new Map();
  ipcMain.handle('rec:start', async (_e, name) => {
    const dir = join(smoke ? store.dir : app.getPath('music'), 'Reboxed Recordings');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name.replace(/[^\w.-]/g, '_')}.wav`);
    const fh = await open(path, 'w');
    await fh.write(Buffer.alloc(44));
    const id = String(Date.now());
    recordings.set(id, { fh, path, bytes: 0, chain: Promise.resolve() });
    return { id, path };
  });
  ipcMain.handle('rec:write', (_e, id, data) => {
    const r = recordings.get(id);
    if (!r) return;
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    r.chain = r.chain.then(() => r.fh.write(buf)).then(() => { r.bytes += buf.length; });
    return r.chain;
  });
  ipcMain.handle('rec:stop', async (_e, id, sampleRate, channels) => {
    const r = recordings.get(id);
    if (!r) return null;
    recordings.delete(id);
    await r.chain;
    await r.fh.write(Buffer.from(wavHeader(r.bytes, sampleRate, channels)), 0, 44, 0);
    await r.fh.close();
    return { path: r.path, bytes: r.bytes };
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#111315', title: 'Reboxed', autoHideMenuBar: true,
    fullscreen: !smoke && storage.cfg.startMode === 'fullscreen',
    show: false,
    // Smoke runs need real animation frames (hidden windows get almost none): show it fully transparent.
    ...(smoke ? { opacity: 0, focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
    },
  });
  // Start maximised (full screen windowed) by default; Preferences > General: full screen or a normal window.
  win.once('ready-to-show', () => {
    if (!smoke && (storage.cfg.startMode ?? 'maximized') === 'maximized') win.maximize();
    win.show();
  });
  // The version shows in the title bar (the page title would replace it).
  win.setTitle(`Reboxed ${app.getVersion()}`);
  win.on('page-title-updated', (e) => e.preventDefault());
  registerIpc(win);
  // Full screen: F11 toggles it.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  const startMode = () => storage.cfg.startMode ?? 'maximized';
  ipcMain.handle('win:fullscreen', () => ({ now: win.isFullScreen(), startMode: startMode() }));
  ipcMain.handle('win:setFullscreen', async (_e, { now, startMode: mode } = {}) => {
    if (typeof now === 'boolean') win.setFullScreen(now);
    if (['maximized', 'fullscreen', 'window'].includes(mode)) { storage.cfg.startMode = mode; await storage.save(); }
    return { now: win.isFullScreen(), startMode: startMode() };
  });

  if (smoke) {
    ipcMain.handle('smoke:dir', () => store.dir);
    ipcMain.handle('smoke:dlTest', () => process.env.REBOXED_DL_TEST === '1');
    // npm run shots: a freely licensed song for the stems shots, "path|Title|Artist" (copied into the test folder).
    ipcMain.handle('smoke:demoSong', async () => {
      const [path, title, artist] = (process.env.REBOXED_DEMO_SONG ?? '').split('|');
      if (!path) return null;
      const dest = join(store.dir, 'song', basename(path));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(path, dest);
      return { path: dest, title: title || basename(path, extname(path)), artist: artist || '' };
    });
    // Extra screenshot mid-test: <shot>-<name>.png next to the final one.
    ipcMain.handle('smoke:shot', async (_e, name) => {
      const shot = process.argv.find((a) => a.startsWith('--shot='));
      if (!shot && !shotsDir) return null;
      const safe = String(name).replace(/[^\w-]/g, '');
      const file = shotsDir ? join(shotsDir, `${safe}.png`) : shot.slice(7).replace(/\.png$/i, `-${safe}.png`);
      if (shotsDir) await mkdir(shotsDir, { recursive: true });
      await writeFile(file, (await win.webContents.capturePage()).toPNG());
      return file;
    });
    // CI-style check: load the UI, report renderer errors, exit with a status code.
    const errors = [];
    win.webContents.on('console-message', (event) => {
      const { level, message } = event;
      if (level === 'error' || level === 3) errors.push(message);
      console.log(`[renderer:${level}] ${message}`);
    });
    win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload ${p}: ${err}`));
    ipcMain.once('smoke:ready', async (_e, report) => {
      console.log('SMOKE', JSON.stringify(report));
      const shot = process.argv.find((a) => a.startsWith('--shot='));
      if (shot) {
        const image = await win.webContents.capturePage();
        await writeFile(shot.slice(7), image.toPNG());
        console.log('SHOT', shot.slice(7));
      }
      app.exit(errors.length || !report.ok ? 1 : 0);
    });
    // With both stem models the smoke test separates FAST then HQ on the CPU: allow 10 minutes.
    setTimeout(() => { console.log('SMOKE timeout', errors); app.exit(2); }, shotsDir ? 1200000 : 600000);
  }

  await win.loadURL(`app://rb/renderer/index.html${shotsDir ? '?shots=1' : smoke ? '?smoke=1' : ''}`);
}

/** The database folder is on a drive that is not plugged in: retry, pick another or use the local one. */
async function resolveDatabase() {
  while (!(await storage.databaseReachable())) {
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'Reboxed', noLink: true,
      message: `The Reboxed library folder is not available:\n${storage.databaseDir}`,
      detail: 'Plug in the drive that holds it and choose Retry, or choose another folder.',
      buttons: ['Retry', 'Choose another folder…', 'Use the library on this computer'], defaultId: 0, cancelId: 2,
    });
    if (r.response === 1) {
      const pick = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (!pick.canceled) { storage.cfg.database = pick.filePaths[0]; await storage.save(); }
    } else if (r.response === 2) {
      storage.cfg.database = null; await storage.save();
    }
  }
  return storage.databaseDir;
}

app.whenReady().then(async () => {
  // The smoke test never touches the user's real library (its app folder is a temporary one).
  storage = new Storage(appDir);
  await storage.load();
  store = new LibraryStore(await resolveDatabase(), { legacyDir: smoke ? null : join(app.getPath('appData'), 'rbclone') });
  protocol.handle('app', serveApp);
  protocol.handle('media', serveMedia);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
