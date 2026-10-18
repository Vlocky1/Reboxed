import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { access, mkdir, mkdtemp, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { wavHeader } from '../shared/wav.js';
import { tmpdir } from 'node:os';
import { LibraryStore } from './library-store.js';
import { scanPaths, readTags, findFiles, AUDIO_EXTENSIONS } from './scanner.js';
import { StemService } from './stems.js';
import { Downloader } from './downloader.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = normalize(join(here, '..'));
const smoke = process.argv.includes('--smoke');

// Product name "Reboxed"; the data stays where earlier versions put it (%APPDATA%/rbclone: library,
// analysis, stem models and caches), so renaming the app loses nothing.
app.setName('Reboxed');
app.setPath('userData', join(app.getPath('appData'), 'rbclone'));
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
  stems = new StemService(store.dir, (ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); });
  // Dev/smoke: point at already-downloaded models instead of fetching them.
  if (process.env.RBCLONE_STEM_MODEL) stems.overrides.hq = process.env.RBCLONE_STEM_MODEL;
  if (process.env.RBCLONE_SPLEETER_DIR) stems.overrides.fast = process.env.RBCLONE_SPLEETER_DIR;
  downloader = new Downloader((ch, ...args) => { if (!win.isDestroyed()) win.webContents.send(ch, ...args); });
  ipcMain.handle('dl:tools', (_e, dir) => { downloader.customDir = dir ?? ''; return downloader.tools(); });
  ipcMain.handle('dl:search', (_e, q, n) => downloader.search(q, n));
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
    const filters = kind === 'xml'
      ? [{ name: 'rekordbox XML', extensions: ['xml'] }]
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
  ipcMain.handle('app:paths', () => ({ userData: store.dir, music: smoke ? store.dir : app.getPath('music') }));

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
    // Smoke runs need real animation frames (hidden windows get almost none): show it fully transparent.
    ...(smoke ? { opacity: 0, focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
    },
  });
  registerIpc(win);

  if (smoke) {
    ipcMain.handle('smoke:dir', () => store.dir);
    ipcMain.handle('smoke:dlTest', () => process.env.RBCLONE_DL_TEST === '1');
    // Extra screenshot mid-test: <shot>-<name>.png next to the final one.
    ipcMain.handle('smoke:shot', async (_e, name) => {
      const shot = process.argv.find((a) => a.startsWith('--shot='));
      if (!shot) return null;
      const file = shot.slice(7).replace(/\.png$/i, `-${String(name).replace(/[^\w-]/g, '')}.png`);
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
    setTimeout(() => { console.log('SMOKE timeout', errors); app.exit(2); }, 360000);
  }

  await win.loadURL(`app://rb/renderer/index.html${smoke ? '?smoke=1' : ''}`);
}

app.whenReady().then(async () => {
  // The smoke test never touches the user's real library.
  store = new LibraryStore(smoke ? await mkdtemp(join(tmpdir(), 'rbclone-smoke-')) : app.getPath('userData'));
  protocol.handle('app', serveApp);
  protocol.handle('media', serveMedia);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
