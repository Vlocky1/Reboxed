const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rb', {
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
  pathForFile: (file) => webUtils.getPathForFile(file),
  paths: () => ipcRenderer.invoke('app:paths'),
  recStart: (name) => ipcRenderer.invoke('rec:start', name),
  recWrite: (id, data) => ipcRenderer.invoke('rec:write', id, data),
  recStop: (id, sampleRate, channels) => ipcRenderer.invoke('rec:stop', id, sampleRate, channels),
  smokeReady: (report) => ipcRenderer.send('smoke:ready', report),
  smokeDir: () => ipcRenderer.invoke('smoke:dir'),
  smokeShot: (name) => ipcRenderer.invoke('smoke:shot', name),
  smokeDlTest: () => ipcRenderer.invoke('smoke:dlTest'),
  rbMapping: (deviceName) => ipcRenderer.invoke('controller:rbMapping', deviceName),
  dl: {
    tools: (dir) => ipcRenderer.invoke('dl:tools', dir),
    search: (q, n) => ipcRenderer.invoke('dl:search', q, n),
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
    removeAll: () => ipcRenderer.invoke('stems:deleteAll'),
    on: (channel, cb) => {
      const allowed = ['stems:progress', 'stems:download', 'stems:fallback', 'stems:block', 'stems:job'];
      if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
      const listener = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
});
