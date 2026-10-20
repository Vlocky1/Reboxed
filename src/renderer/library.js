// Library model: collection, playlist tree (folders/playlists), histories, settings.
// Persisted through the main process (library.json); tracks are replaced immutably on update
// so per-track caches (search index) can key on object identity.
import { normalizeKeyText } from '../shared/keys.js';
import { evaluateSmartList } from '../shared/smartlist.js';
import { DEFAULT_RELATED } from '../shared/related.js';
import { selectPlaylists, playlistPaths, remapPath, trackPatch } from '../shared/rekordbox-import.js';

export const DEFAULT_SETTINGS = {
  keyNotation: 'camelot',      // 'camelot' | 'musical'
  bpmRange: [78, 155],
  autoAnalyze: true,
  waveformColor: '3band',      // '3band' | 'rgb' | 'blue'
  defaultTempoRange: 10,
  crossfaderCurve: 'smooth',
  faderCurve: 'linear',
  autoGain: true,
  masterDevice: '',
  phonesDevice: '',
  theme: 'dark', themeAccent: null, uiScale: 1, topbarLabels: 'full',
  columns: ['color', 'artwork', 'title', 'artist', 'album', 'genre', 'bpm', 'key', 'duration', 'stems', 'rating', 'dateAdded'],
  deckCount: 2,                // 2 | 4
  syncMode: 'beat',            // 'beat' (tempo + phase) | 'bpm' (tempo only)
  syncDoubleHalf: true,
  loadOnPlaying: false,        // allow loading a track onto a playing deck (load lock off)
  related: DEFAULT_RELATED,
  relatedSeed: 'master',       // 'master' | 'deck1'..'deck4' | 'selected'
  colorFx: 'FILTER',
  midiMappings: [],
  analysisMode: 'normal',      // 'normal' (constant grid) | 'dynamic' (variable tempo)
  autoCues: false,             // create cues from phrases after analysis
  mixPointLink: false,
  stemsProvider: 'auto',       // 'auto' (fastest measured) | 'cpu' | 'webgpu' | 'dml' (GPU engines)
  stemsBench: null,            // {fast: {cpu, webgpu, dml}, hq: {...}, date}: x real time, or 'crash'
  stemsQuality: 'auto',        // 'fast' (Spleeter) | 'hq' (HT-Demucs) | 'auto' (FAST now, HQ upgrade in background)
  stemsOnLoad: false,          // separate stems as soon as a track is loaded
  stemWaveform: 'muted',       // stem-coloured waveform: 'off' | 'muted' (while a part is muted) | 'always'
  outputLayout: 'stereo',      // 'stereo' | 'quad' (controller sound card: master 1/2, phones 3/4)
  controllerAudioAuto: true,   // use a recognised controller's sound card automatically
  controllerTempoInvert: false,
  // Track downloader (yt-dlp, as used by Stacher): folder '' = <Music>/Reboxed Downloads.
  downloads: { folder: '', format: 'm4a', platform: 'youtube', cleanNames: true, cleanKeywords: '', toolsDir: '', playlist: true, subs: [], seen: [], done: {}, maxMinutes: 12, checkOnStart: true },
};

/** Local date YYYY-MM-DD (the "Date Added" day; the exact moment is in addedAt, ms). */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const newId = () => crypto.randomUUID();
const pathKey = (p) => (/^[A-Za-z]:\\/.test(p) ? p.toLowerCase() : p);

export class Library extends EventTarget {
  constructor(data) {
    super();
    /** @type {Map<string, object>} */
    this.tracks = new Map((data.tracks ?? []).map((t) => [t.id, t]));
    this.playlists = data.playlists ?? [];
    this.histories = data.histories ?? [];
    this.tagList = data.tagList ?? [];
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.byPath = new Map([...this.tracks.values()].map((t) => [pathKey(t.path), t.id]));
    this.saveTimer = null;
  }

  static async load() {
    return new Library(await window.rb.loadLibrary());
  }

  emit(kind, extra = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...extra } }));
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    await window.rb.saveLibrary({
      tracks: [...this.tracks.values()], playlists: this.playlists, histories: this.histories, tagList: this.tagList, settings: this.settings,
    });
  }

  // ---- tracks --------------------------------------------------------------------------------

  get(id) { return this.tracks.get(id); }
  all() { return [...this.tracks.values()]; }
  idForPath(path) { return this.byPath.get(pathKey(path)); }

  /** Add tag-scan results; existing paths are kept. Returns the ids of new tracks. */
  addScanned(results) {
    const added = [];
    for (const r of results) {
      if (this.byPath.has(pathKey(r.path))) continue;
      const t = {
        id: newId(), dateAdded: today(), addedAt: Date.now(), rating: 0, color: '', myTags: [], cues: [], playCount: 0, analyzed: false,
        ...r, key: normalizeKeyText(r.key),
      };
      delete t.error;
      this.tracks.set(t.id, t);
      this.byPath.set(pathKey(t.path), t.id);
      added.push(t.id);
    }
    if (added.length) this.emit('tracks', { added });
    return added;
  }

  update(id, patch, { silent = false } = {}) {
    const t = this.tracks.get(id);
    if (!t) return null;
    const next = { ...t, ...patch };
    this.tracks.set(id, next);
    if (!silent) this.emit('track', { id });
    else this.scheduleSave();
    return next;
  }

  /** The same music now lives at another path (e.g. linked to the copy on a USB drive). */
  relink(id, path) {
    const t = this.tracks.get(id);
    if (!t) return null;
    this.byPath.delete(pathKey(t.path));
    const next = { ...t, path, missing: false };
    this.tracks.set(id, next);
    this.byPath.set(pathKey(path), id);
    this.emit('track', { id });
    return next;
  }

  removeTracks(ids) {
    const set = new Set(ids);
    for (const id of set) {
      const t = this.tracks.get(id);
      if (t) this.byPath.delete(pathKey(t.path));
      this.tracks.delete(id);
    }
    const strip = (nodes) => nodes.forEach((n) => {
      if (n.type === 'folder') strip(n.children);
      else if (n.trackIds) n.trackIds = n.trackIds.filter((id) => !set.has(id));
    });
    strip(this.playlists);
    this.tagList = this.tagList.filter((id) => !set.has(id));
    this.histories.forEach((h) => { h.trackIds = h.trackIds.filter((id) => !set.has(id)); });
    this.emit('tracks', { removed: ids });
  }

  /**
   * Merge a parsed rekordbox.xml ({tracks with path, playlists with paths}).
   * Existing tracks get metadata/cues/grid updated; playlists go under a dated folder.
   */
  /** Old entry point (drag & drop, tests): import everything with the default rules. */
  importXml(parsed) { return this.importRekordbox(parsed); }

  /**
   * Bring a parsed rekordbox.xml in: tracks with their metadata, cues, grids, and the playlist tree.
   * @param {{tracks: object[], playlists: object[]}} parsed from importRekordboxXml
   * @param {{selected?: Set<string>|null, scope?: 'all'|'playlists', metadata?: 'overwrite'|'fill',
   *          cues?: 'replace'|'merge'|'keep', beatgrid?: boolean, placement?: 'sync'|'new'|'root',
   *          relocated?: Map<string,string>, rules?: [string,string][], missing?: Set<string>}} opts
   *   placement 'sync' replaces the previous "rekordbox" folder, 'new' adds a dated folder, 'root' puts
   *   the playlists at the top level (replacing earlier top-level imports).
   */
  importRekordbox(parsed, opts = {}) {
    const { selected = null, scope = 'all', placement = 'sync', relocated, rules, missing } = opts;
    const where = { relocated, rules };
    const lists = selectPlaylists(parsed.playlists, selected);
    const wanted = scope === 'playlists' ? playlistPaths(lists) : null;
    const report = { added: 0, updated: 0, cues: 0, playlists: 0, folders: 0, missing: 0, relocated: 0 };
    for (const x of parsed.tracks) {
      if (!x.path || (wanted && !wanted.has(pathKey(x.path)))) continue;
      const path = remapPath(x.path, where);
      if (path !== x.path) report.relocated++;
      const lost = missing?.has(pathKey(x.path)) && path === x.path;
      if (lost) report.missing++;
      const id = this.idForPath(path) ?? (path !== x.path ? this.idForPath(x.path) : undefined);
      const old = id ? this.tracks.get(id) : null;
      const patch = { ...trackPatch(old, x, opts), path, missing: missing ? !!lost : !!old?.missing };
      report.cues += (patch.cues ?? old?.cues ?? []).length;
      if (old) {
        if (old.path !== path) { this.byPath.delete(pathKey(old.path)); this.byPath.set(pathKey(path), id); }
        this.tracks.set(id, { ...old, ...patch });
        report.updated++;
      } else {
        // rekordbox only knows the day a track was added: the time is kept only when it is today.
        const t = { id: newId(), dateAdded: today(), addedAt: Date.now(), rating: 0, color: '', myTags: [], cues: [], playCount: 0, analyzed: false, ...patch };
        if (t.dateAdded !== today()) delete t.addedAt;
        this.tracks.set(t.id, t);
        this.byPath.set(pathKey(t.path), t.id);
        report.added++;
      }
    }
    const convert = (n) => {
      if (n.type === 'folder') { report.folders++; return { id: newId(), type: 'folder', name: n.name, children: n.children.map(convert), open: false, src: 'rekordbox' }; }
      report.playlists++;
      return { id: newId(), type: 'playlist', name: n.name, src: 'rekordbox',
        trackIds: n.paths.map((p) => this.idForPath(remapPath(p, where)) ?? this.idForPath(p)).filter(Boolean) };
    };
    const nodes = lists.map(convert);
    if (placement === 'root') {
      this.playlists = this.playlists.filter((n) => n.src !== 'rekordbox').concat(nodes);
    } else if (nodes.length) {
      const prev = placement === 'sync' ? this.playlists.find((n) => n.importSource === 'rekordbox') : null;
      if (prev) { prev.children = nodes; prev.open = true; report.folderId = prev.id; } else {
        const folder = { id: newId(), type: 'folder', name: placement === 'sync' ? 'rekordbox' : `rekordbox ${today()}`, children: nodes, open: true,
          ...(placement === 'sync' ? { importSource: 'rekordbox' } : {}) };
        this.playlists.push(folder);
        report.folderId = folder.id;
      }
    }
    this.emit('tracks', {});
    this.emit('playlists');
    return report;
  }

  // ---- playlist tree -------------------------------------------------------------------------

  findNode(id, nodes = this.playlists, parent = null) {
    for (const n of nodes) {
      if (n.id === id) return { node: n, parent, siblings: nodes };
      if (n.type === 'folder') {
        const r = this.findNode(id, n.children, n);
        if (r) return r;
      }
    }
    return null;
  }

  createNode(type, name, parentId = null, rules = null) {
    const node = type === 'folder'
      ? { id: newId(), type, name, children: [], open: true }
      : type === 'smart'
        ? { id: newId(), type, name, rules: rules ?? { match: 'all', conditions: [] } }
        : { id: newId(), type, name, trackIds: [] };
    const parent = parentId ? this.findNode(parentId)?.node : null;
    (parent?.type === 'folder' ? parent.children : this.playlists).push(node);
    this.emit('playlists');
    return node;
  }

  renameNode(id, name) {
    const r = this.findNode(id);
    if (r) { r.node.name = name; this.emit('playlists'); }
  }

  deleteNode(id) {
    const r = this.findNode(id);
    if (!r) return;
    r.siblings.splice(r.siblings.indexOf(r.node), 1);
    this.emit('playlists');
  }

  /**
   * Move a playlist / intelligent playlist / folder in the tree.
   * where: 'inside' (end of a folder), 'before' or 'after' another node; targetId null = end of the top level.
   * A folder never goes inside itself or one of its subfolders.
   * @returns {boolean} moved
   */
  moveNode(id, targetId, where = 'inside') {
    const src = this.findNode(id);
    if (!src || id === targetId) return false;
    let tgt = null;
    if (targetId) {
      tgt = this.findNode(targetId);
      if (!tgt) return false;
      if (src.node.type === 'folder' && this.findNode(targetId, src.node.children)) return false;
      if (where === 'inside' && tgt.node.type !== 'folder') where = 'after';
    }
    src.siblings.splice(src.siblings.indexOf(src.node), 1);
    if (!tgt) this.playlists.push(src.node);
    else if (where === 'inside') { tgt.node.children.push(src.node); tgt.node.open = true; } else {
      const i = tgt.siblings.indexOf(tgt.node);
      tgt.siblings.splice(where === 'before' ? i : i + 1, 0, src.node);
    }
    this.emit('playlists');
    return true;
  }

  /** Folders a node may move into (not itself nor its own subfolders), with their depth. */
  folderTargets(id) {
    const out = [];
    const walk = (list, depth) => list.forEach((n) => {
      if (n.type !== 'folder' || n.id === id) return;
      out.push({ node: n, depth });
      walk(n.children, depth + 1);
    });
    walk(this.playlists, 0);
    return out;
  }

  toggleFolder(id) {
    const r = this.findNode(id);
    if (r?.node.type === 'folder') { r.node.open = !r.node.open; this.emit('playlists'); }
  }

  addToPlaylist(playlistId, trackIds) {
    const r = this.findNode(playlistId);
    if (r?.node.type !== 'playlist') return;
    r.node.trackIds.push(...trackIds.filter((id) => this.tracks.has(id)));
    this.emit('playlist', { id: playlistId });
  }

  /** Remove entries by position (a playlist may hold a track more than once). */
  /** Remove entries by position from a playlist or a history (a list may hold a track twice). */
  removeFromPlaylist(playlistId, positions) {
    const drop = new Set(positions);
    const hist = this.histories.find((x) => x.id === playlistId);
    if (hist) { hist.trackIds = hist.trackIds.filter((_, i) => !drop.has(i)); this.emit('history', { id: playlistId }); return; }
    const r = this.findNode(playlistId);
    if (r?.node.type !== 'playlist') return;
    r.node.trackIds = r.node.trackIds.filter((_, i) => !drop.has(i));
    this.emit('playlist', { id: playlistId });
  }

  movePlaylistEntries(playlistId, positions, toIndex) {
    const r = this.findNode(playlistId);
    if (r?.node.type !== 'playlist') return;
    const ids = r.node.trackIds;
    const moving = positions.sort((a, b) => a - b).map((i) => ids[i]);
    const keep = ids.filter((_, i) => !positions.includes(i));
    const before = positions.filter((i) => i < toIndex).length;
    keep.splice(toIndex - before, 0, ...moving);
    r.node.trackIds = keep;
    this.emit('playlist', { id: playlistId });
  }

  /** Flat list of playlists with their folder path, for "Add to playlist" menus. */
  playlistList(nodes = this.playlists, prefix = '') {
    return nodes.flatMap((n) => {
      if (n.type === 'folder') return this.playlistList(n.children, `${prefix}${n.name} / `);
      return n.type === 'playlist' ? [{ id: n.id, label: prefix + n.name }] : [];
    });
  }

  setSmartRules(id, rules) {
    const r = this.findNode(id);
    if (r?.node.type === 'smart') { r.node.rules = rules; this.emit('playlist', { id }); this.emit('playlists'); }
  }

  // ---- tag list (temporary crate) --------------------------------------------------------------

  addToTagList(ids) {
    this.tagList.push(...ids.filter((id) => this.tracks.has(id) && !this.tagList.includes(id)));
    this.emit('taglist');
  }

  removeFromTagList(positions) {
    const drop = new Set(positions);
    this.tagList = this.tagList.filter((_, i) => !drop.has(i));
    this.emit('taglist');
  }

  clearTagList() { this.tagList = []; this.emit('taglist'); }

  tagListToPlaylist(name) {
    const node = this.createNode('playlist', name);
    node.trackIds = [...this.tagList];
    this.emit('playlists');
    return node;
  }

  // ---- histories -----------------------------------------------------------------------------

  addToHistory(trackId) {
    const date = today();
    let h = this.histories.find((x) => x.date === date);
    if (!h) { h = { id: `history-${date}`, date, trackIds: [] }; this.histories.unshift(h); }
    if (h.trackIds.at(-1) !== trackId) h.trackIds.push(trackId);
    const t = this.tracks.get(trackId);
    if (t) this.tracks.set(trackId, { ...t, playCount: (t.playCount ?? 0) + 1 });
    this.emit('history', { id: h.id });
  }

  /** Delete one day's history (the tracks stay in the collection; play counts are kept). */
  deleteHistory(historyId) {
    const before = this.histories.length;
    this.histories = this.histories.filter((x) => x.id !== historyId);
    if (this.histories.length !== before) this.emit('history', { id: historyId });
  }

  clearHistories() {
    this.histories = [];
    this.emit('history', {});
  }

  historyToPlaylist(historyId) {
    const h = this.histories.find((x) => x.id === historyId);
    if (!h) return;
    const node = this.createNode('playlist', `History ${h.date}`);
    node.trackIds = [...h.trackIds];
    this.emit('playlists');
  }

  // ---- lists ---------------------------------------------------------------------------------

  /** Tracks shown for a tree selection. Each row carries its playlist position. */
  rowsFor(source) {
    if (source === 'collection') return this.all().map((t) => ({ track: t, pos: -1 }));
    if (source === 'tag-list') return this.tagList.map((id, pos) => ({ track: this.tracks.get(id), pos })).filter((r) => r.track);
    const node = this.findNode(source)?.node;
    if (node?.type === 'smart') return evaluateSmartList(node.rules, this.all()).map((t) => ({ track: t, pos: -1 }));
    const h = this.histories.find((x) => x.id === source);
    const ids = h ? h.trackIds : node?.trackIds ?? [];
    return ids.map((id, pos) => ({ track: this.tracks.get(id), pos })).filter((r) => r.track);
  }

  setSetting(key, value) {
    this.settings = { ...this.settings, [key]: value };
    this.emit('settings', { key });
  }
}
