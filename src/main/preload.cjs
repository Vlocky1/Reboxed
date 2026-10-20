const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('rb', {
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
  },
  metadata: { lookup: (q, source, opts) => ipcRenderer.invoke('metadata:lookup', q, source, opts) },
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
  },
  stems: {
    status: () => ipcRenderer.invoke('stems:status'),
    download: (quality) => ipcRenderer.invoke('stems:download', quality),
    meta: (id, trackPath) => ipcRenderer.invoke('stems:meta', id, trackPath),
    separate: (id, left, right, opts) => ipcRenderer.invoke('stems:separate', id, left, right, opts),
    remove: (id, trackPath) => ipcRenderer.invoke('stems:delete', id, trackPath),
    relocate: (id, oldPath, newPath) => ipcRenderer.invoke('stems:relocate', id, oldPath, newPath),
    removeAll: () => ipcRenderer.invoke('stems:deleteAll'),
    convertToMp3: (tracks, kbps) => ipcRenderer.invoke('stems:convertToMp3', tracks, kbps),
    on: (channel, cb) => {
      const allowed = ['stems:progress', 'stems:download', 'stems:fallback', 'stems:block', 'stems:job', 'stems:convert'];
      if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
      const listener = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
});
