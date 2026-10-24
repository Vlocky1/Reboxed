const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// The bridge to the main process exists only on Reboxed's own pages (app://rb). Any other page that
// would end up in the window gets nothing (the main process also refuses its IPC calls).
const trusted = location.protocol === 'app:' && location.host === 'rb';

const api = {
  /** Interface size (Preferences > Appearance). */
  setZoom: (f) => webFrame.setZoomFactor(Math.min(1.5, Math.max(0.7, Number(f) || 1))),
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (data) => ipcRenderer.invoke('library:save', data),
  getAnalysis: (id) => ipcRenderer.invoke('analysis:get', id),
  putAnalysis: (id, data) => ipcRenderer.invoke('analysis:put', id, data),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFiles: (kind) => ipcRenderer.invoke('dialog:openFiles', kind),
  saveFileDialog: (name, ext) => ipcRenderer.invoke('dialog:saveFile', name, ext),
  scanPaths: (paths) => ipcRenderer.invoke('scan:paths', paths),
  onScanProgress: (cb) => {
    const listener = (_e, done, total) => cb(done, total);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.off('scan:progress', listener);
  },
  readTags: (path) => ipcRenderer.invoke('tags:read', path),
  readText: (path) => ipcRenderer.invoke('fs:readText', path),
  exists: (path) => ipcRenderer.invoke('fs:exists', path),
  existsMany: (paths) => ipcRenderer.invoke('fs:existsMany', paths),
  findFiles: (dir, names) => ipcRenderer.invoke('fs:findFiles', dir, names),
  writeFile: (path, data) => ipcRenderer.invoke('fs:writeFile', path, data),
  showItem: (path) => ipcRenderer.invoke('shell:showItem', path),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  listAudio: (dir) => ipcRenderer.invoke('fs:listAudio', dir),
  readTagsMany: (paths) => ipcRenderer.invoke('tags:readMany', paths),
  copyInto: (src, dir) => ipcRenderer.invoke('fs:copyInto', src, dir),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  spotify: {
    status: () => ipcRenderer.invoke('spotify:status'),
    setCredentials: (clientId, secret) => ipcRenderer.invoke('spotify:setCredentials', clientId, secret),
    lookup: (q) => ipcRenderer.invoke('spotify:lookup', q),
    playlist: (url) => ipcRenderer.invoke('spotify:playlist', url),
  },
  metadata: { lookup: (q, source, opts) => ipcRenderer.invoke('metadata:lookup', q, source, opts) },
  discogs: {
    status: () => ipcRenderer.invoke('discogs:status'),
    setToken: (token) => ipcRenderer.invoke('discogs:setToken', token),
  },
  artworkFromUrl: (url) => ipcRenderer.invoke('artwork:fromUrl', url),
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    read: (id, file) => ipcRenderer.invoke('plugins:read', id, file),
    install: (dir) => ipcRenderer.invoke('plugins:install', dir),
    remove: (id) => ipcRenderer.invoke('plugins:remove', id),
    createFromCsv: (csv, opts) => ipcRenderer.invoke('plugins:createFromCsv', csv, opts),
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  },
  cdj: {
    drives: () => ipcRenderer.invoke('cdj:drives'),
    export: (job) => ipcRenderer.invoke('cdj:export', job),
    onProgress: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('cdj:progress', l); return () => ipcRenderer.off('cdj:progress', l); },
  },
  version: () => ipcRenderer.invoke('app:version'),
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (key) => ipcRenderer.invoke('license:activate', key),
    validate: () => ipcRenderer.invoke('license:validate'),
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (asset) => ipcRenderer.invoke('update:download', asset),
    install: (file) => ipcRenderer.invoke('update:install', file),
    onProgress: (cb) => { const l = (_e, got, total) => cb(got, total); ipcRenderer.on('update:progress', l); return () => ipcRenderer.off('update:progress', l); },
  },
  fullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  setFullscreen: (opts) => ipcRenderer.invoke('win:setFullscreen', opts),
  storage: {
    info: () => ipcRenderer.invoke('storage:info'),
    hasLibrary: (dir) => ipcRenderer.invoke('storage:hasLibrary', dir),
    setDatabase: (dir, mode) => ipcRenderer.invoke('storage:setDatabase', dir, mode),
    setStems: (mode, dir, move) => ipcRenderer.invoke('storage:setStems', mode, dir, move),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  paths: () => ipcRenderer.invoke('app:paths'),
  recStart: (name) => ipcRenderer.invoke('rec:start', name),
  recWrite: (id, data) => ipcRenderer.invoke('rec:write', id, data),
  recStop: (id, sampleRate, channels) => ipcRenderer.invoke('rec:stop', id, sampleRate, channels),
  smokeReady: (report) => ipcRenderer.send('smoke:ready', report),
  smokeDir: () => ipcRenderer.invoke('smoke:dir'),
  smokeShot: (name) => ipcRenderer.invoke('smoke:shot', name),
  smokeDlTest: () => ipcRenderer.invoke('smoke:dlTest'),
  smokeEnv: (name) => ipcRenderer.invoke('smoke:env', name),
  smokeDemoSong: () => ipcRenderer.invoke('smoke:demoSong'),
  rbMapping: (deviceName) => ipcRenderer.invoke('controller:rbMapping', deviceName),
  dl: {
    tools: (dir) => ipcRenderer.invoke('dl:tools', dir),
    search: (q, n, platform) => ipcRenderer.invoke('dl:search', q, n, platform),
    feed: (url, n) => ipcRenderer.invoke('dl:feed', url, n),
    resolve: (url) => ipcRenderer.invoke('dl:resolve', url),
    download: (item, opts) => ipcRenderer.invoke('dl:download', item, opts),
    cancel: (key) => ipcRenderer.invoke('dl:cancel', key),
    onProgress: (cb) => {
      const listener = (_e, key, p) => cb(key, p);
      ipcRenderer.on('dl:progress', listener);
      return () => ipcRenderer.off('dl:progress', listener);
    },
    installTools: (names) => ipcRenderer.invoke('tools:install', names),
    updateYtdlp: () => ipcRenderer.invoke('tools:updateYtdlp'),
    onToolsProgress: (cb) => {
      const listener = (_e, name, received, total, phase) => cb(name, received, total, phase);
      ipcRenderer.on('tools:progress', listener);
      return () => ipcRenderer.off('tools:progress', listener);
    },
  },
  nvidia: {
    status: () => ipcRenderer.invoke('nvidia:status'),
    install: () => ipcRenderer.invoke('nvidia:install'),
    remove: () => ipcRenderer.invoke('nvidia:remove'),
    onProgress: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('nvidia:progress', l); return () => ipcRenderer.off('nvidia:progress', l); },
  },
  stems: {
    status: () => ipcRenderer.invoke('stems:status'),
    download: (quality) => ipcRenderer.invoke('stems:download', quality),
    meta: (id, trackPath) => ipcRenderer.invoke('stems:meta', id, trackPath),
    exportTo: (id, trackPath, dest) => ipcRenderer.invoke('stems:exportTo', id, trackPath, dest),
    adopt: (id, trackPath, src) => ipcRenderer.invoke('stems:adopt', id, trackPath, src),
    separate: (id, left, right, opts) => ipcRenderer.invoke('stems:separate', id, left, right, opts),
    remove: (id, trackPath) => ipcRenderer.invoke('stems:delete', id, trackPath),
    relocate: (id, oldPath, newPath) => ipcRenderer.invoke('stems:relocate', id, oldPath, newPath),
    removeAll: () => ipcRenderer.invoke('stems:deleteAll'),
    bench: (quality, ep, seconds) => ipcRenderer.invoke('stems:bench', quality, ep, seconds),
    convertToMp3: (tracks, kbps) => ipcRenderer.invoke('stems:convertToMp3', tracks, kbps),
    on: (channel, cb) => {
      const allowed = ['stems:progress', 'stems:download', 'stems:fallback', 'stems:block', 'stems:job', 'stems:convert'];
      if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
      const listener = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
};

if (trusted) contextBridge.exposeInMainWorld('rb', api);
