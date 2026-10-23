// Library browser: tree (collection / playlists / histories), search + track filter, track table.
import { h, fmtTime, contextMenu, modal, promptText, confirmDialog, toast } from './dom.js';
import { IndexedTrack, compileQuery, SEARCH_FIELDS, SearchController, compileTrackFilter, BPM_RANGE_PERCENTS } from '../../search/index.js';
import { displayKey, compatibleKeys } from '../../shared/keys.js';
import { TRACK_COLORS } from '../../shared/rekordbox-xml.js';
import { findRelated } from '../../shared/related.js';
import { suggest } from '../../shared/dsp/features.js';
import { icon } from './icons.js';
import { mediaUrl } from '../analysis/analyzer.js';
import { base64ToU8 } from '../../shared/dsp/waveform.js';
import { editSmartList, relatedPanel } from './lists-ui.js';
import { openRelink } from './relink.js';
import { openCdjExport } from './cdj-export.js';
import { lookupPanel } from './track-lookup.js';
import { openAutoTag, undoAutoTag } from './autotag.js';
import { openCleanNames } from './clean-names.js';
import { openTransferExport, openTransferImport } from './transfer.js';
import { openDuplicates } from './duplicates.js';
import { addedTime, dateAddedText } from '../../shared/date-added.js';
import { DEFAULT_SETTINGS } from '../library.js';

/** Drag data type of a column header being moved. */
const COLUMN_TYPE = 'application/x-rb-column';

/** Value of the Track information date-time field. */
const dateTimeInput = (t) => (t.dateAdded ? `${t.dateAdded}T${addedTime(t) ?? '00:00'}` : '');

const ROW_H = 24;
const COLOR_CSS = Object.fromEntries(TRACK_COLORS.map((c) => [c.name, c.css]));
const CAMELOT = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

export const COLUMNS = {
  pos: { label: '#', width: 40, get: (r) => (r.pos >= 0 ? r.pos + 1 : ''), sort: (r) => r.pos, num: true },
  color: { label: '', width: 10, get: () => '', sort: (r) => TRACK_COLORS.findIndex((c) => c.name === r.track.color) },
  artwork: { label: '', menuLabel: 'Artwork', width: 28, get: () => '', sort: (r) => (r.track.artwork ? 0 : 1) },
  stems: { label: 'Stems', width: 58, get: () => '', sort: (r) => (r.track.stems === 'hq' ? 0 : r.track.stems ? 1 : 2) },
  title: { label: 'Track Title', width: 260, get: (r) => r.track.title, sort: (r) => (r.track.title ?? '').toLowerCase() },
  artist: { label: 'Artist', width: 170, get: (r) => r.track.artist, sort: (r) => (r.track.artist ?? '').toLowerCase() },
  album: { label: 'Album', width: 160, get: (r) => r.track.album, sort: (r) => (r.track.album ?? '').toLowerCase() },
  genre: { label: 'Genre', width: 120, get: (r) => r.track.genre, sort: (r) => (r.track.genre ?? '').toLowerCase() },
  bpm: { label: 'BPM', width: 64, get: (r) => (r.track.bpm ? r.track.bpm.toFixed(2) : ''), sort: (r) => r.track.bpm ?? 0, num: true },
  key: { label: 'Key', width: 50, get: (r, s) => displayKey(r.track.key, s.keyNotation), sort: (r) => CAMELOT.indexOf(r.track.key) },
  preview: { label: 'Preview', width: 130, get: () => '', sort: (r) => (r.track.wavePreview ? 0 : 1) },
  duration: { label: 'Time', width: 56, get: (r) => (r.track.duration ? fmtTime(r.track.duration) : ''), sort: (r) => r.track.duration ?? 0, num: true },
  rating: { label: 'Rating', width: 76, get: () => '', sort: (r) => r.track.rating ?? 0 },
  dateAdded: { label: 'Date Added', width: 120, get: (r) => dateAddedText(r.track), sort: (r) => `${r.track.dateAdded ?? ''} ${addedTime(r.track) ?? '00:00'}` },
  comments: { label: 'Comments', width: 180, get: (r) => r.track.comments, sort: (r) => (r.track.comments ?? '').toLowerCase() },
  label: { label: 'Label', width: 120, get: (r) => r.track.label, sort: (r) => (r.track.label ?? '').toLowerCase() },
  year: { label: 'Year', width: 50, get: (r) => r.track.year || '', sort: (r) => r.track.year ?? 0, num: true },
  remixer: { label: 'Remixer', width: 120, get: (r) => r.track.remixer, sort: (r) => (r.track.remixer ?? '').toLowerCase() },
  composer: { label: 'Composer', width: 120, get: (r) => r.track.composer, sort: (r) => (r.track.composer ?? '').toLowerCase() },
  mixName: { label: 'Mix Name', width: 120, get: (r) => r.track.mixName, sort: (r) => (r.track.mixName ?? '').toLowerCase() },
  playCount: { label: 'DJ Play Count', width: 60, get: (r) => r.track.playCount || '', sort: (r) => r.track.playCount ?? 0, num: true },
  bitrate: { label: 'Bitrate', width: 60, get: (r) => (r.track.bitrate ? `${r.track.bitrate}` : ''), sort: (r) => r.track.bitrate ?? 0, num: true },
  kind: { label: 'File Type', width: 60, get: (r) => r.track.kind, sort: (r) => r.track.kind ?? '' },
  myTags: { label: 'My Tag', width: 140, get: (r) => (r.track.myTags ?? []).join(', '), sort: (r) => (r.track.myTags ?? []).join(',') },
  location: { label: 'Location', width: 280, get: (r) => r.track.path, sort: (r) => r.track.path },
};

/** Preview images by track waveform data, width and colour style (rows are re-created on scroll). */
const previewCache = new Map();

/** Small whole-track waveform of a row (Preview column), from track.wavePreview. */
function previewCanvas(b64, width, style) {
  const key = `${width}|${style}|${b64}`;
  let url = previewCache.get(key);
  if (!url) {
    const data = base64ToU8(b64);
    const cols = data.length / 3;
    const dpr = devicePixelRatio || 1;
    const W = Math.max(8, Math.round((width - 8) * dpr)); const H = Math.round(18 * dpr);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const colours = style === 'blue' ? ['#1f4fd8', '#3a8cff', '#c8e4ff'] : ['#1d5bff', '#f2971f', '#ffffff'];
    for (let x = 0; x < W; x++) {
      const i = Math.min(cols - 1, Math.floor((x / W) * cols)) * 3;
      const [lo, mi, hi] = [data[i], data[i + 1], data[i + 2]];
      if (style === 'rgb') {
        const mx = Math.max(lo, mi, hi) || 1;
        g.fillStyle = `rgb(${Math.round(255 * (lo / mx) ** 0.65)},${Math.round(255 * (mi / mx) ** 0.65)},${Math.round(255 * (hi / mx) ** 0.65)})`;
        const hh = (mx / 255) * H; g.fillRect(x, H - hh, 1, hh);
        continue;
      }
      // Drawn from the baseline up, like the deck overview: lows full, mids and highs inside.
      [lo, mi * 0.62, hi * 0.38].forEach((v, b) => { const hh = (v / 255) * H; g.fillStyle = colours[b]; g.fillRect(x, H - hh, 1, hh); });
    }
    url = c.toDataURL();
    if (previewCache.size > 3000) previewCache.clear();
    previewCache.set(key, url);
  }
  return h('img.wave-preview', { src: url, alt: '', draggable: false });
}

export class Browser {
  /**
   * @param {object} app {library, analyzeTracks, loadTrack, decks, importFolder, importFiles, importXml, exportXml}
   */
  constructor(app) {
    this.app = app;
    this.lib = app.library;
    this.source = 'collection';
    this.sort = { col: 'dateAdded', dir: -1 };
    this.query = { text: '', field: 'all' };
    this.filterOpen = false;
    this.filter = {
      bpm: { enabled: false, base: 128, rangePercent: 2 },
      key: { enabled: false, keys: [] },
      rating: { enabled: false, ratings: [] },
      color: { enabled: false, colors: [] },
      myTag: { enabled: false, tags: [], mode: 'all' },
    };
    this.selected = new Set();   // row keys
    this.anchor = null;
    this.rows = [];
    this.index = new WeakMap();

    this.tree = h('nav.tree');
    this.searchInput = h('input.search-input', { placeholder: 'Search', spellcheck: false, type: 'search' });
    this.fieldSelect = h('select.search-field', {}, SEARCH_FIELDS.map((f) => h('option', { value: f.id }, f.label)));
    this.filterBtn = h('button.dbtn', { onclick: () => { this.filterOpen = !this.filterOpen; this.renderFilter(); }, title: 'Track filter' }, 'FILTER');
    this.filterPanel = h('div.filter-panel');
    this.relatedEl = h('div.related-host');
    this.status = h('span.status');
    this.count = h('span.count');
    this.head = h('div.thead');
    this.spacer = h('div.tspacer');
    this.body = h('div.tbody', {}, this.spacer);
    this.scroller = h('div.tscroll', { tabIndex: 0 }, this.head, this.body);

    this.controller = new SearchController({ onSearch: (q) => { this.query = q; this.refreshRows(); } });
    this.searchInput.addEventListener('input', () => this.controller.textChanged(this.searchInput.value));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.controller.submit();
      if (e.key === 'Escape') { this.searchInput.value = ''; this.controller.clear(); this.scroller.focus(); }
      e.stopPropagation();
    });
    this.fieldSelect.addEventListener('change', () => this.controller.setField(this.fieldSelect.value));

    this.el = h('section.browser', {},
      h('div.tree-pane', {},
        h('div.tree-tools', {},
          h('button.dbtn.small', { onclick: () => app.importFolder(), title: 'Add a folder to the collection' }, '+ Folder'),
          h('button.dbtn.small', { onclick: () => app.importFiles(), title: 'Add files to the collection' }, '+ Files'),
          h('button.dbtn.small', { onclick: (e) => this.moreMenu(e), title: 'More' }, '⋯')),
        this.tree),
      h('div.list-pane', {},
        h('div.list-tools', {},
          h('div.searchbox', {}, icon('search', 'search-ico'), this.searchInput, this.fieldSelect),
          this.filterBtn, this.count, h('span.spacer'), this.status),
        this.relatedEl,
        this.filterPanel,
        this.scroller));

    this.scroller.addEventListener('scroll', () => this.renderBody());
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.renderBody()).observe(this.scroller);
    this.lib.addEventListener('change', (e) => this.onLibraryChange(e.detail));

    this.renderTree();
    this.renderFilter();
    this.refreshRows();
  }

  get columns() {
    const cols = this.lib.settings.columns.filter((c) => COLUMNS[c]);
    return this.ordered ? ['pos', ...cols] : cols;
  }

  focusSearch() { this.searchInput.focus(); this.searchInput.select(); }

  onLibraryChange({ kind }) {
    if (['playlists', 'playlist', 'history', 'taglist', 'tracks'].includes(kind)) this.renderTree();
    if (kind === 'settings') { this.renderHead(); this.renderBody(); return; }
    if (kind === 'track') {
      if (this.stemsBadge) this.stemsBadge.textContent = `${this.lib.all().filter((t) => t.stems).length}`;
      if (this.source === 'stems') { this.refreshRows(); return; }
      this.rows = this.rows.map((r) => ({ ...r, track: this.lib.get(r.track.id) ?? r.track }));
      this.renderBody();
      return;
    }
    this.refreshRows();
  }

  // ---- tree ----------------------------------------------------------------------------------

  renderTree() {
    const lib = this.lib;
    const item = (id, label, cls, extra = {}) => {
      const el = h(`div.tree-item${cls ? `.${cls}` : ''}${this.source === id ? '.active' : ''}`, { onclick: () => this.select(id), dataset: { id }, ...extra }, label);
      const dropTo = cls === 'playlist' ? (ids) => lib.addToPlaylist(id, ids) : cls === 'taglist' ? (ids) => lib.addToTagList(ids) : null;
      el.addEventListener('dragover', (e) => {
        if (dropTo && e.dataTransfer.types.includes('application/x-rb-tracks')) { e.preventDefault(); el.classList.add('drop'); }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const ids = JSON.parse(e.dataTransfer.getData('application/x-rb-tracks') || '[]');
        if (ids.length && dropTo) { dropTo(ids); toast(`${ids.length} track(s) added`); }
      });
      return el;
    };
    // Playlists, intelligent playlists and folders can be dragged: onto a folder = inside it,
    // onto the upper / lower edge of a row = before / after it.
    const NODE_TYPE = 'application/x-rb-node';
    const clearMarks = () => this.tree.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
    const zone = (e, row, n) => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      if (n.type === 'folder') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
      return y < 0.5 ? 'before' : 'after';
    };
    const movable = (row, n) => {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(NODE_TYPE, n.id); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(NODE_TYPE)) return;
        e.preventDefault();
        clearMarks();
        row.classList.add({ before: 'drop-before', after: 'drop-after', inside: 'drop-into' }[zone(e, row, n)]);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-into'));
      row.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData(NODE_TYPE);
        clearMarks();
        if (!id) return;
        e.preventDefault(); e.stopPropagation();
        if (!lib.moveNode(id, n.id, zone(e, row, n))) toast('A folder cannot go inside itself');
      });
      row.addEventListener('dragend', clearMarks);
      return row;
    };
    const nodes = (list, depth) => list.flatMap((n) => {
      const pad = { style: { paddingLeft: `${10 + depth * 14}px` } };
      if (n.type === 'folder') {
        const row = movable(item(n.id, h('span', {}, h('span.twisty', { onclick: (e) => { e.stopPropagation(); lib.toggleFolder(n.id); } }, n.open ? '▾' : '▸'), icon('folder'), n.name), 'folder', pad), n);
        row.addEventListener('contextmenu', (e) => this.nodeMenu(e, n));
        row.onclick = () => lib.toggleFolder(n.id);
        return [row, ...(n.open ? nodes(n.children, depth + 1) : [])];
      }
      if (n.type === 'smart') {
        const row = movable(item(n.id, h('span', {}, icon('smart'), n.name), 'smart', pad), n);
        row.addEventListener('contextmenu', (e) => this.nodeMenu(e, n));
        return [row];
      }
      const row = movable(item(n.id, h('span', {}, icon('playlist'), n.name, h('span.dim.count-badge', {}, `${n.trackIds.length}`)), 'playlist', pad), n);
      row.addEventListener('contextmenu', (e) => this.nodeMenu(e, n));
      return [row];
    });
    // Dropping on the "Playlists" header moves the node back to the top level.
    const playlistsHeader = h('div.tree-section', {}, h('span', {}, 'Playlists'),
      h('button.icon', { title: 'New playlist', onclick: async () => { const n = await promptText('New playlist', 'Untitled Playlist'); if (n) this.select(lib.createNode('playlist', n).id); } }, icon('playlist')),
      h('button.icon', { title: 'New intelligent playlist', onclick: () => this.newSmartList() }, icon('smart')),
      h('button.icon', { title: 'New folder', onclick: async () => { const n = await promptText('New folder', 'New Folder'); if (n) lib.createNode('folder', n); } }, icon('folder')));
    playlistsHeader.title = 'Drop a playlist or folder here to move it to the top level';
    playlistsHeader.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(NODE_TYPE)) { e.preventDefault(); clearMarks(); playlistsHeader.classList.add('drop-into'); } });
    playlistsHeader.addEventListener('dragleave', () => playlistsHeader.classList.remove('drop-into'));
    playlistsHeader.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData(NODE_TYPE);
      clearMarks();
      if (id) { e.preventDefault(); lib.moveNode(id, null); }
    });
    const tagItem = item('tag-list', h('span', {}, icon('tag'), 'Tag List', h('span.dim.count-badge', {}, `${lib.tagList.length}`)), 'taglist');
    tagItem.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Convert to playlist…', disabled: !lib.tagList.length, action: async () => { const name = await promptText('New playlist', 'Tag List'); if (name) this.select(lib.tagListToPlaylist(name).id); } },
        { label: 'Clear Tag List', disabled: !lib.tagList.length, action: () => lib.clearTagList() },
      ]);
    });
    this.tree.replaceChildren(
      item('collection', h('span', {}, icon('collection'), 'Collection', h('span.dim.count-badge', {}, `${lib.tracks.size}`)), 'collection'),
      tagItem,
      item('stems', h('span', {}, icon('wave'), 'Stems', (this.stemsBadge = h('span.dim.count-badge', {}, `${lib.all().filter((t) => t.stems).length}`))), 'stems',
        { title: 'Tracks whose stems are already separated: they load with their stems ready' }),
      item('related', h('span', {}, icon('related'), 'Related Tracks'), 'related',
        { title: 'Tracks that match by their tags and analysis: key, BPM, genre, artist, rating… (criteria you choose)' }),
      item('suggest', h('span', {}, icon('suggest'), 'Track Suggestion'), 'suggest',
        { title: 'Tracks that sound alike, from the audio itself (timbre, harmony, energy, groove)' }),
      playlistsHeader,
      ...nodes(lib.playlists, 0),
      h('div.tree-section', {}, h('span', {}, 'Histories'),
        lib.histories.length ? h('button.icon', { title: 'Delete all histories', onclick: () => this.clearHistories() }, icon('trash')) : null),
      ...lib.histories.map((x) => {
        const row = item(x.id, h('span', {}, icon('history'), x.date, h('span.dim.count-badge', {}, `${x.trackIds.length}`)), 'history');
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Turn into playlist', action: () => lib.historyToPlaylist(x.id) },
            '-',
            { label: 'Delete this history', action: () => this.deleteHistory(x) },
            { label: 'Delete all histories', action: () => this.clearHistories() },
          ]);
        });
        return row;
      }));
    if (this.focusArea === 'tree') this.paintTreeCursor();
  }

  nodeMenu(e, n) {
    e.preventDefault();
    const lib = this.lib;
    contextMenu(e.clientX, e.clientY, [
      ...(n.type === 'folder' ? [
        { label: 'New playlist here', action: async () => { const name = await promptText('New playlist', 'Untitled Playlist'); if (name) lib.createNode('playlist', name, n.id); } },
        { label: 'New folder here', action: async () => { const name = await promptText('New folder', 'New Folder'); if (name) lib.createNode('folder', name, n.id); } },
        { label: 'New intelligent playlist here', action: () => this.newSmartList(n.id) },
        '-'] : n.type === 'smart' ? [
        { label: 'Edit conditions…', action: () => this.editSmart(n) },
        { label: 'Freeze into a normal playlist', action: () => {
          const p = lib.createNode('playlist', `${n.name} (frozen)`);
          lib.addToPlaylist(p.id, lib.rowsFor(n.id).map((r) => r.track.id));
        } },
        '-'] : [
        { label: 'Analyze tracks', action: () => this.app.analyzeTracks(n.trackIds) },
        { label: 'Export as M3U8…', action: () => this.app.exportM3u(n) },
        '-']),
      ...(n.type !== 'folder' ? [{ label: 'Find duplicates…', action: () => openDuplicates(this.app, n.id) }] : []),
      { label: 'Send to another Reboxed (USB drive)…', action: () => {
        const ids = [];
        const walk = (x) => (x.type === 'folder' ? x.children.forEach(walk) : ids.push(x.id));
        walk(n);
        openTransferExport(this.app, ids);
      } },
      { label: 'Move to', submenu: [
        { label: 'Top level', disabled: lib.playlists.includes(n), action: () => lib.moveNode(n.id, null) },
        ...lib.folderTargets(n.id).map(({ node, depth }) => ({
          label: `${'   '.repeat(depth)}${node.name}`, disabled: node.children.includes(n), action: () => lib.moveNode(n.id, node.id, 'inside'),
        })),
      ] },
      { label: 'Rename…', action: async () => { const name = await promptText('Rename', n.name); if (name) lib.renameNode(n.id, name); } },
      { label: 'Delete', action: async () => {
        if (await confirmDialog('Delete', `Delete "${n.name}"${n.type === 'folder' ? ' and everything in it' : ''}?`)) {
          if (this.source === n.id) this.select('collection');
          lib.deleteNode(n.id);
        }
      } },
    ]);
  }

  moreMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 2, [
      { label: 'Import a DJ library (XML: playlists, cues, tags)…', action: () => this.app.importXml() },
      { label: 'Download tracks (YouTube, new releases)…', action: () => this.app.downloads.open() },
      { label: 'Export to USB for DJ players…', action: () => openCdjExport(this.app) },
      { label: 'Auto-tag the tracks shown… (Spotify / Deezer)', action: () => openAutoTag(this.app, (this.selectedRows().length > 1 ? this.selectedRows() : this.rows ?? []).map((r) => r.track.id)) },
      { label: 'Clean the names of the tracks shown…', action: () => openCleanNames(this.app, (this.selectedRows().length > 1 ? this.selectedRows() : this.rows ?? []).map((r) => r.track.id)) },
      { label: 'Undo the last auto-tag / clean', disabled: !this.app.lastAutoTag?.length, action: () => undoAutoTag(this.app) },
      { label: 'Export collection as XML…', action: () => this.app.exportXml() },
      { label: 'Send to another Reboxed (USB drive)…', action: () => openTransferExport(this.app) },
      { label: 'Import from another Reboxed…', action: () => openTransferImport(this.app) },
      '-',
      { label: 'Find duplicates in the collection…', action: () => openDuplicates(this.app) },
      { label: 'Analyze all unanalyzed tracks', action: () => this.app.analyzeTracks(this.lib.all().filter((t) => !t.analyzed).map((t) => t.id)) },
      { label: 'Find missing files', action: () => this.app.findMissing() },
      { label: 'Move my collection to a USB drive…', action: () => openRelink(this.app) },
    ]);
  }

  select(source) {
    this.source = source;
    this.selected.clear();
    const node = this.lib.findNode(source)?.node;
    this.sort = source === 'collection' || source === 'stems' || node?.type === 'smart' ? { col: 'dateAdded', dir: -1 }
      : source === 'related' || source === 'suggest' ? { col: null, dir: 1 } // keep relevance order
        : { col: 'pos', dir: 1 };
    this.renderTree();
    this.renderRelated();
    this.refreshRows();
    this.scroller.scrollTop = 0;
  }

  /** Lists computed from a seed track (deck/master/selection), refreshed when decks change. */
  get seedDependent() { return this.source === 'related' || this.source === 'suggest'; }

  /** Sources whose rows have a meaningful position (#) and can be edited by position. */
  get ordered() {
    return this.source === 'tag-list' || this.source.startsWith('history-') || this.lib.findNode(this.source)?.node.type === 'playlist';
  }

  smartContext() {
    return { keyNotation: this.lib.settings.keyNotation, tags: [...new Set(this.lib.all().flatMap((t) => t.myTags ?? []))].sort() };
  }

  async newSmartList(parentId = null) {
    const r = await editSmartList({ name: 'Intelligent Playlist', rules: { match: 'all', conditions: [] } }, this.smartContext());
    if (r) this.select(this.lib.createNode('smart', r.name, parentId, r.rules).id);
  }

  async editSmart(node) {
    const r = await editSmartList({ name: node.name, rules: node.rules }, this.smartContext());
    if (!r) return;
    this.lib.renameNode(node.id, r.name);
    this.lib.setSmartRules(node.id, r.rules);
  }

  // ---- related tracks ------------------------------------------------------------------------

  renderRelated() {
    const s = this.lib.settings;
    if (this.source === 'suggest') {
      const seedSel = h('select', { onchange: (e) => { this.lib.settings = { ...this.lib.settings, relatedSeed: e.target.value }; this.lib.scheduleSave(); this.refreshRows(); } },
        [['master', 'Master deck'], ...Array.from({ length: s.deckCount }, (_, i) => [`deck${i + 1}`, `Deck ${i + 1}`]), ['selected', 'Selected track']]
          .map(([v, l]) => h('option', { value: v, selected: s.relatedSeed === v }, l)));
      this.relatedEl.replaceChildren(h('div.filter-panel.related-panel', {}, h('div.frow', {},
        h('span.ftoggle', {}, 'SOUNDS LIKE'), seedSel,
        h('span.dim', {}, 'Ranked by audio fingerprint (timbre, harmony, energy, groove) with compatible tempo. Tracks analyzed before this version need re-analysis.'))));
      return;
    }
    if (this.source !== 'related') { this.relatedEl.replaceChildren(); return; }
    this.relatedEl.replaceChildren(relatedPanel(s.related, s.relatedSeed, s.deckCount, (criteria, seed) => {
      this.lib.settings = { ...this.lib.settings, related: criteria, relatedSeed: seed };
      this.lib.scheduleSave();
      this.refreshRows();
    }));
  }

  relatedSeedTrack() {
    const { relatedSeed } = this.lib.settings;
    const decks = this.app.engine.decks;
    if (relatedSeed === 'selected') return this.relatedSelected ?? null;
    const deck = relatedSeed === 'master' ? (this.app.engine.masterDeck ?? decks.find((d) => d.loaded)) : decks[Number(relatedSeed.slice(4)) - 1];
    return deck?.track ? this.lib.get(deck.track.id) ?? deck.track : null;
  }

  suggestRows() {
    const seed = this.relatedSeedTrack();
    this.count.title = seed ? `Sounds like: ${seed.title}` : '';
    if (!seed?.features) return [];
    return suggest(seed, seed.features, this.lib.all().map((t) => ({ track: t, features: t.features })))
      .map((r) => ({ track: r.track, pos: -1 }));
  }

  relatedRows() {
    const seed = this.relatedSeedTrack();
    this.count.title = seed ? `Related to: ${seed.artist ? `${seed.artist} - ` : ''}${seed.title}` : 'Load a track (or pick "Selected track")';
    return findRelated(this.lib.all(), seed, this.lib.settings.related).map((r) => ({ track: r.track, pos: -1 }));
  }

  // ---- filter panel --------------------------------------------------------------------------

  renderFilter() {
    this.filterBtn.classList.toggle('on', this.filterOpen || this.filterActive());
    if (!this.filterOpen) { this.filterPanel.replaceChildren(); this.filterPanel.hidden = true; return; }
    this.filterPanel.hidden = false;
    const f = this.filter;
    const update = () => { this.refreshRows(); this.filterBtn.classList.toggle('on', true); };
    const toggle = (obj, label) => h('label.ftoggle', {}, h('input', { type: 'checkbox', checked: obj.enabled, onchange: (e) => { obj.enabled = e.target.checked; update(); } }), label);
    const chips = (values, selected, labelOf, onChange, styleOf) => h('div.chips', {}, values.map((v) => {
      const c = h(`button.chip${selected.includes(v) ? '.on' : ''}`, { style: styleOf?.(v) }, labelOf(v));
      c.onclick = () => { const i = selected.indexOf(v); if (i >= 0) selected.splice(i, 1); else selected.push(v); c.classList.toggle('on'); onChange(); };
      return c;
    }));
    const allTags = [...new Set(this.lib.all().flatMap((t) => t.myTags ?? []))].sort();
    const fromDeck = () => {
      const d = this.app.engine.masterDeck ?? this.app.engine.decks.find((x) => x.loaded);
      if (!d?.loaded) { toast('No track loaded on a deck'); return; }
      if (d.currentBpm) { f.bpm.base = Math.round(d.currentBpm * 100) / 100; f.bpm.enabled = true; }
      const key = d.analysis?.key || d.track.key;
      if (key) { f.key.keys = compatibleKeys(key); f.key.enabled = true; }
      this.renderFilter(); update();
    };
    this.filterPanel.replaceChildren(
      h('div.frow', {}, toggle(f.bpm, 'BPM'),
        h('input.num', { type: 'number', step: 0.1, value: f.bpm.base, onchange: (e) => { f.bpm.base = Number(e.target.value); update(); } }),
        h('span', {}, '±'),
        h('select', { onchange: (e) => { f.bpm.rangePercent = Number(e.target.value); update(); } },
          BPM_RANGE_PERCENTS.map((p) => h('option', { value: p, selected: p === f.bpm.rangePercent }, `${p}%`))),
        h('button.dbtn.small', { onclick: fromDeck, title: 'Set BPM and KEY from the master deck (compatible keys)' }, 'FROM DECK')),
      h('div.frow', {}, toggle(f.key, 'KEY'), chips(CAMELOT, f.key.keys, (k) => displayKey(k, this.lib.settings.keyNotation), update)),
      h('div.frow', {}, toggle(f.rating, 'RATING'), chips([0, 1, 2, 3, 4, 5], f.rating.ratings, (r) => (r ? '★'.repeat(r) : '0'), update)),
      h('div.frow', {}, toggle(f.color, 'COLOR'), chips(TRACK_COLORS.map((c) => c.name), f.color.colors, (c) => c, update, (c) => ({ borderColor: COLOR_CSS[c] }))),
      h('div.frow', {}, toggle(f.myTag, 'MY TAG'),
        h('select', { onchange: (e) => { f.myTag.mode = e.target.value; update(); } },
          h('option', { value: 'all', selected: f.myTag.mode === 'all' }, 'Match all'), h('option', { value: 'any', selected: f.myTag.mode === 'any' }, 'Match any')),
        allTags.length ? chips(allTags, f.myTag.tags, (t) => t, update) : h('span.dim', {}, 'No My Tags yet (edit a track to add some)')));
  }

  filterActive() {
    return Object.values(this.filter).some((x) => x.enabled);
  }

  // ---- rows ----------------------------------------------------------------------------------

  entryFor(track) {
    let e = this.index.get(track);
    if (!e) { e = new IndexedTrack(track); this.index.set(track, e); }
    return e;
  }

  refreshRows() {
    const all = this.source === 'related' ? this.relatedRows()
      : this.source === 'suggest' ? this.suggestRows()
        : this.lib.rowsFor(this.source);
    const match = compileQuery(this.query.text, { field: this.query.field });
    const pass = compileTrackFilter(this.filter);
    this.rows = all.filter((r) => match(this.entryFor(r.track)) && pass(r.track));
    this.rows.forEach((r) => { r.key = r.pos >= 0 ? `${r.pos}` : r.track.id; });
    const col = COLUMNS[this.sort.col];
    const dir = this.sort.dir;
    if (col) {
      this.rows.sort((a, b) => {
        const x = col.sort(a); const y = col.sort(b);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    const keys = new Set(this.rows.map((r) => r.key));
    for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
    this.count.textContent = `${this.rows.length} track${this.rows.length === 1 ? '' : 's'}`;
    this.renderHead();
    this.renderBody();
  }

  renderHead() {
    const s = this.sort;
    this.applyWidths();
    this.head.replaceChildren(...this.columns.map((c) => {
      const def = COLUMNS[c];
      const grip = h('span.col-grip', { title: 'Drag to resize · double-click to fit the content' });
      grip.addEventListener('pointerdown', (e) => this.startResize(e, c, grip));
      grip.addEventListener('dblclick', (e) => { e.stopPropagation(); this.autoFit(c); });
      grip.addEventListener('click', (e) => e.stopPropagation());
      const cell = h(`div.th.c-${c}${def.num ? '.num' : ''}`, { style: { width: `var(--w-${c})` }, draggable: true, title: 'Click to sort · drag to move the column' },
        def.label, s.col === c ? h('span.sort', {}, s.dir > 0 ? ' ▲' : ' ▼') : '', grip);
      cell.onclick = () => { this.sort = { col: c, dir: s.col === c ? -s.dir : 1 }; this.refreshRows(); };
      cell.oncontextmenu = (e) => this.columnMenu(e);
      // Drag a header onto another to move the column before / after it (order saved).
      cell.addEventListener('dragstart', (e) => {
        if (e.target !== cell || this.resizing) { e.preventDefault(); return; }
        e.dataTransfer.setData(COLUMN_TYPE, c);
        e.dataTransfer.effectAllowed = 'move';
      });
      const side = (e) => (e.clientX - cell.getBoundingClientRect().left > cell.offsetWidth / 2 ? 'after' : 'before');
      cell.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(COLUMN_TYPE)) return;
        e.preventDefault();
        const where = side(e);
        cell.classList.toggle('drop-before', where === 'before');
        cell.classList.toggle('drop-after', where === 'after');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop-before', 'drop-after'));
      cell.addEventListener('drop', (e) => {
        cell.classList.remove('drop-before', 'drop-after');
        const moved = e.dataTransfer.getData(COLUMN_TYPE);
        if (moved && moved !== c) { e.preventDefault(); this.moveColumn(moved, c, side(e)); }
      });
      return cell;
    }));
    this.head.style.width = 'var(--total)';
  }

  /** Put column `c` before / after column `target` (the order is kept in the settings). */
  moveColumn(c, target, where = 'before') {
    const cols = this.lib.settings.columns.filter((x) => x !== c);
    const at = cols.indexOf(target);
    if (at < 0) return;
    cols.splice(where === 'after' ? at + 1 : at, 0, c);
    this.lib.setSetting('columns', cols);
  }

  // ---- column widths (drag the header edge; double-click fits the content) -----------------------

  colWidth(c) { return this.lib.settings.columnWidths?.[c] ?? COLUMNS[c].width; }

  /** Widths live in CSS variables on the list, so a resize updates every row at once. */
  applyWidths(draft = {}) {
    let total = 0;
    for (const c of this.columns) {
      const w = draft[c] ?? this.colWidth(c);
      total += w;
      this.scroller.style.setProperty(`--w-${c}`, `${w}px`);
    }
    this.totalWidth = total;
    this.scroller.style.setProperty('--total', `${total}px`);
  }

  setColWidth(c, w) {
    this.lib.setSetting('columnWidths', { ...(this.lib.settings.columnWidths ?? {}), [c]: Math.round(w) });
    this.applyWidths();
  }

  startResize(e, c, grip) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    this.resizing = true; // not a column move
    const x0 = e.clientX; const w0 = this.colWidth(c);
    let w = w0;
    const move = (ev) => { w = Math.max(24, Math.min(1200, w0 + ev.clientX - x0)); this.applyWidths({ [c]: w }); };
    const up = () => {
      this.resizing = false;
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
      if (w !== w0) this.setColWidth(c, w);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }

  /** Width that shows the longest value of the column (and its header) in full. */
  autoFit(c) {
    const def = COLUMNS[c];
    const sample = this.body.querySelector(`.td.c-${c}`) ?? this.body.querySelector('.td');
    const font = sample ? getComputedStyle(sample).font : '12px "Segoe UI"';
    const g = (this.measureCtx ??= document.createElement('canvas').getContext('2d'));
    g.font = font;
    let max = g.measureText(def.label ?? '').width + 18;
    const settings = this.lib.settings;
    for (const r of this.rows.slice(0, 20000)) {
      const text = String(def.get(r, settings) ?? '');
      if (text) max = Math.max(max, g.measureText(text).width + (c === 'title' ? 26 : 16));
    }
    if (!['rating', 'artwork', 'color', 'stems', 'preview'].includes(c)) this.setColWidth(c, Math.min(900, Math.ceil(max)));
  }

  columnMenu(e) {
    e.preventDefault();
    const cur = this.lib.settings.columns;
    contextMenu(e.clientX, e.clientY, Object.entries(COLUMNS).filter(([k]) => k !== 'pos').map(([k, def]) => ({
      label: def.menuLabel || def.label || 'Color', checked: cur.includes(k),
      action: () => this.lib.setSetting('columns', cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]),
    })).concat([
      '-',
      { label: 'Fit all columns to their content', action: () => this.columns.forEach((c) => this.autoFit(c)) },
      { label: 'Reset column widths', action: () => { this.lib.setSetting('columnWidths', {}); this.applyWidths(); } },
      { label: 'Reset column order', action: () => {
        const order = DEFAULT_SETTINGS.columns;
        const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
        this.lib.setSetting('columns', [...cur].sort((a, b) => rank(a) - rank(b)));
      } },
    ]));
  }

  renderBody() {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW_H) + 5);
    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.spacer.style.width = 'var(--total)';
    const loaded = new Set(this.app.engine.decks.filter((d) => d.track).map((d) => d.track.id));
    const played = this.lib.playedToday();
    const settings = this.lib.settings;
    const frag = [];
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const t = r.track;
      const row = h(`div.tr${this.selected.has(r.key) ? '.sel' : ''}${loaded.has(t.id) ? '.loaded' : ''}${played.has(t.id) ? '.played' : ''}${t.missing ? '.missing' : ''}`, {
        style: { top: `${i * ROW_H}px`, width: 'var(--total)' }, draggable: true, dataset: { i },
      });
      for (const c of this.columns) {
        const def = COLUMNS[c];
        const cell = h(`div.td.c-${c}${def.num ? '.num' : ''}`, { style: { width: `var(--w-${c})` } });
        if (c === 'color') cell.style.background = COLOR_CSS[t.color] ?? 'transparent';
        else if (c === 'artwork') { if (t.artwork) cell.append(h('img.thumb', { src: mediaUrl(t.artwork), loading: 'lazy', alt: '' })); }
        else if (c === 'preview') {
          if (t.wavePreview) cell.append(previewCanvas(t.wavePreview, this.colWidth('preview'), settings.waveformColor));
          else if (t.analyzed) this.app.fillPreview?.(t.id); // analysed before 1.18: made from the stored analysis
        }
        else if (c === 'stems') {
          const job = this.app.stemJobs?.get(t.id);
          if (job) {
            const pct = job.total > 1 ? Math.round((job.done / job.total) * 100) : 0;
            cell.append(h('span.stem-badge.busy', { style: { '--p': `${pct}%` } }, job.state === 'queued' ? '…' : `${pct}%`));
          } else if (t.stems) cell.append(h(`span.stem-badge.${t.stems === 'hq' ? 'hq' : 'fast'}`, {}, t.stems === 'hq' ? 'HQ' : 'FAST'));
        }
        else if (c === 'rating') cell.append(...[1, 2, 3, 4, 5].map((n) => h(`span.star${n <= (t.rating ?? 0) ? '.on' : ''}`, {
          onclick: (e) => { e.stopPropagation(); this.lib.update(t.id, { rating: t.rating === n ? 0 : n }); },
        }, '★')));
        else if (c === 'title') {
          cell.textContent = def.get(r, settings) ?? '';
          if (!t.analyzed) cell.prepend(h('span.unanalyzed', { title: 'Not analyzed' }, '● '));
          if (played.has(t.id)) cell.prepend(h('span.played-mark', { title: 'Already played today' }, '✓ '));
        }
        else cell.textContent = def.get(r, settings) ?? '';
        if (c === 'key' && t.key) cell.classList.add('keycell');
        row.append(cell);
      }
      row.addEventListener('pointerdown', (e) => this.onRowDown(e, i));
      row.addEventListener('dblclick', () => this.app.loadToFreeDeck(t.id));
      row.addEventListener('contextmenu', (e) => this.rowMenu(e, i));
      row.addEventListener('dragstart', (e) => {
        if (!this.selected.has(r.key)) { this.selected = new Set([r.key]); }
        const ids = this.selectedRows().map((x) => x.track.id);
        e.dataTransfer.setData('application/x-rb-tracks', JSON.stringify(ids));
        e.dataTransfer.setData('application/x-rb-positions', JSON.stringify({ source: this.source, positions: this.selectedRows().map((x) => x.pos) }));
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      if (this.lib.findNode(this.source)?.node.type === 'playlist') {
        row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-rb-positions')) e.preventDefault(); });
        row.addEventListener('drop', (e) => {
          const data = JSON.parse(e.dataTransfer.getData('application/x-rb-positions') || 'null');
          if (data?.source === this.source) { e.preventDefault(); this.lib.movePlaylistEntries(this.source, data.positions, r.pos); }
        });
      }
      frag.push(row);
    }
    this.body.replaceChildren(this.spacer, ...frag);
  }

  selectedRows() { return this.rows.filter((r) => this.selected.has(r.key)); }

  onRowDown(e, i) {
    if (e.button === 2 && this.selected.has(this.rows[i].key)) return;
    const key = this.rows[i].key;
    if (e.shiftKey && this.anchor !== null) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.selected = new Set(this.rows.slice(a, b + 1).map((r) => r.key));
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
      this.anchor = i;
    } else {
      if (this.selected.has(key) && e.button === 0 && this.selected.size > 1) return; // allow multi-drag
      this.selected = new Set([key]);
      this.anchor = i;
    }
    this.paintSelection();
  }

  /** Update selection classes in place (re-rendering rows would break dblclick and drag). */
  paintSelection() {
    for (const row of this.body.children) {
      if (row.dataset.i === undefined) continue;
      const r = this.rows[Number(row.dataset.i)];
      row.classList.toggle('sel', !!r && this.selected.has(r.key));
    }
  }

  onKey(e) {
    if (!this.rows.length) return;
    const cur = this.anchor ?? -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      e.stopPropagation();
    } else if (e.key === 'Enter' && cur >= 0) {
      this.app.loadToFreeDeck(this.rows[cur].track.id);
      e.stopPropagation();
    } else if (e.key === 'Delete' && this.selected.size) {
      this.removeSelected();
      e.stopPropagation();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selected = new Set(this.rows.map((r) => r.key));
      this.renderBody();
      e.stopPropagation();
    }
  }

  // ---- controller navigation (BROWSE encoder, BACK, page jumps) ------------------------------

  /** Selectable tree items in display order (open folders expanded). */
  treeItems() {
    const out = ['collection', 'tag-list', 'stems', 'related', 'suggest'];
    const walk = (nodes) => nodes.forEach((n) => { out.push(n.id); if (n.type === 'folder' && n.open) walk(n.children); });
    walk(this.lib.playlists);
    this.lib.histories.forEach((h) => out.push(h.id));
    return out;
  }

  /** BROWSE rotate: moves the tree cursor when the tree has focus, else the track cursor. */
  browseMove(delta) {
    if (this.focusArea !== 'tree') { this.moveSelection(delta); return; }
    const items = this.treeItems();
    const i = Math.max(0, Math.min(items.length - 1, items.indexOf(this.treeCursor ?? this.source) + delta));
    this.treeCursor = items[i];
    this.paintTreeCursor();
  }

  /**
   * BROWSE press: in the tree, open the item under the cursor (folder: expand) and go to its tracks;
   * in the track list, go back to the playlists (cursor on the current one).
   */
  browsePress() {
    if (this.focusArea !== 'tree') { this.treeCursor = this.source; this.setFocus('tree'); return; }
    const id = this.treeCursor ?? this.source;
    const node = this.lib.findNode(id)?.node;
    if (node?.type === 'folder') { this.lib.toggleFolder(id); return; }
    this.select(id);
    this.setFocus('list');
  }

  /** BACK: from the track list go to the tree; in the tree close the folder under the cursor. */
  browseBack() {
    if (this.focusArea !== 'tree') { this.setFocus('tree'); return; }
    const r = this.lib.findNode(this.treeCursor ?? this.source);
    if (r?.node.type === 'folder' && r.node.open) this.lib.toggleFolder(r.node.id);
    else if (r?.parent) { this.treeCursor = r.parent.id; this.paintTreeCursor(); }
  }

  setFocus(area) {
    this.focusArea = area;
    if (area === 'tree' && !this.treeCursor) this.treeCursor = this.source;
    this.el.classList.toggle('focus-tree', area === 'tree');
    this.paintTreeCursor();
  }

  paintTreeCursor() {
    for (const el of this.tree.querySelectorAll('.tree-item')) {
      el.classList.toggle('cursor', this.focusArea === 'tree' && el.dataset.id === (this.treeCursor ?? this.source));
    }
    this.tree.querySelector('.tree-item.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  /** Page jumps for BROWSE JUMP UP/DOWN (SHIFT = top/bottom). */
  pageJump(dir, toEdge = false) {
    if (!this.rows.length) return;
    if (toEdge) {
      // Put the cursor one row away from the edge, then step onto it (moveSelection clamps).
      this.anchor = dir < 0 ? 1 : this.rows.length - 2;
      this.moveSelection(dir < 0 ? -1 : 1);
      return;
    }
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1);
    this.moveSelection(dir * page);
  }

  /** Move the single selection by `delta` rows (arrow keys, MIDI browse encoder). */
  moveSelection(delta) {
    if (!this.rows.length || !delta) return;
    const i = Math.max(0, Math.min(this.rows.length - 1, (this.anchor ?? -1) + delta));
    this.selected = new Set([this.rows[i].key]);
    this.anchor = i;
    const y = i * ROW_H;
    const headH = this.head.offsetHeight;
    if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
    if (y + ROW_H + headH > this.scroller.scrollTop + this.scroller.clientHeight) this.scroller.scrollTop = y + ROW_H + headH - this.scroller.clientHeight;
    this.renderBody();
  }

  /** The track under the cursor/selection, for keyboard "load to deck". */
  currentTrackId() {
    const r = this.anchor !== null ? this.rows[this.anchor] : this.selectedRows()[0];
    return r?.track.id ?? null;
  }

  async removeSelected() {
    const rows = this.selectedRows();
    if (!rows.length) return;
    if (this.source === 'collection') {
      if (await confirmDialog('Remove from collection', `Remove ${rows.length} track(s) from the collection? Files are not deleted.`)) {
        this.lib.removeTracks(rows.map((r) => r.track.id));
      }
    } else if (this.source === 'tag-list') {
      this.lib.removeFromTagList(rows.map((r) => r.pos));
    } else if (this.lib.findNode(this.source)?.node.type === 'playlist' || this.isHistory(this.source)) {
      this.lib.removeFromPlaylist(this.source, rows.map((r) => r.pos));
    }
  }

  isHistory(id) { return this.lib.histories.some((x) => x.id === id); }

  async deleteHistory(x) {
    if (!(await confirmDialog('Delete history', `Delete the history of ${x.date} (${x.trackIds.length} track(s))? The tracks stay in the collection.`))) return;
    if (this.source === x.id) this.select('collection');
    this.lib.deleteHistory(x.id);
  }

  async clearHistories() {
    if (!this.lib.histories.length) return;
    if (!(await confirmDialog('Delete all histories', `Delete all ${this.lib.histories.length} histories? The tracks stay in the collection.`))) return;
    if (this.isHistory(this.source)) this.select('collection');
    this.lib.clearHistories();
  }

  rowMenu(e, i) {
    e.preventDefault();
    if (!this.selected.has(this.rows[i].key)) { this.selected = new Set([this.rows[i].key]); this.anchor = i; this.paintSelection(); }
    const rows = this.selectedRows();
    const ids = rows.map((r) => r.track.id);
    const first = rows[0].track;
    const lib = this.lib;
    const playlists = lib.playlistList();
    contextMenu(e.clientX, e.clientY, [
      ...this.app.visibleDecks().map((d) => ({ label: `Load to Deck ${d.index + 1}`, action: () => this.app.loadTrack(d.index, first.id) })),
      '-',
      { label: 'Add to playlist', submenu: playlists.length
        ? playlists.map((p) => ({ label: p.label, action: () => { lib.addToPlaylist(p.id, ids); toast(`Added to ${p.label}`); } }))
        : [{ label: '(no playlists)', disabled: true }] },
      { label: 'New playlist from selection…', action: async () => {
        const name = await promptText('New playlist', 'Untitled Playlist');
        if (name) { const n = lib.createNode('playlist', name); lib.addToPlaylist(n.id, ids); }
      } },
      { label: 'Add to Tag List', action: () => { lib.addToTagList(ids); toast(`${ids.length} track(s) tagged`); } },
      { label: 'Show related tracks', action: () => {
        this.relatedSelected = first;
        this.lib.settings = { ...this.lib.settings, relatedSeed: 'selected' };
        this.select('related');
      } },
      '-',
      { label: 'Analyze', action: () => this.app.analyzeTracks(ids) },
      { label: 'Create cues from phrases', action: () => ids.forEach((id) => this.app.createCuesFor(id)) },
      { label: 'Separate stems', action: () => ids.forEach((id) => this.app.separateStems(id)) },
      { label: 'Show suggestions (sounds like)', action: () => {
        this.relatedSelected = first;
        this.lib.settings = { ...this.lib.settings, relatedSeed: 'selected' };
        this.select('suggest');
      } },
      { label: 'Rating', submenu: [0, 1, 2, 3, 4, 5].map((n) => ({ label: n ? '★'.repeat(n) : 'None', action: () => ids.forEach((id) => lib.update(id, { rating: n })) })) },
      { label: 'Color', submenu: [{ label: 'None', action: () => ids.forEach((id) => lib.update(id, { color: '' })) },
        ...TRACK_COLORS.map((c) => ({ label: c.name, checked: first.color === c.name, action: () => ids.forEach((id) => lib.update(id, { color: c.name })) }))] },
      { label: 'Track information…', action: () => this.editTrack(first.id) },
      { label: `Auto-tag with Spotify / Deezer… (${ids.length})`, action: () => openAutoTag(this.app, ids) },
      { label: `Clean names (Lyrics, Official Video…)… (${ids.length})`, action: () => openCleanNames(this.app, ids) },
      { label: 'Show in Explorer', action: () => window.rb.showItem(first.path) },
      '-',
      this.source === 'collection'
        ? { label: 'Remove from collection', action: () => this.removeSelected() }
        : { label: this.source === 'tag-list' ? 'Remove from Tag List' : this.isHistory(this.source) ? 'Remove from history' : 'Remove from playlist',
          disabled: !(this.source === 'tag-list' || this.isHistory(this.source) || lib.findNode(this.source)?.node.type === 'playlist'), action: () => this.removeSelected() },
    ]);
  }

  /**
   * Track information: everything that can be edited, grouped, each with what it changes.
   * Edits are saved in the Reboxed library (the audio file's own tags are not rewritten).
   */
  async editTrack(id) {
    const t = this.lib.get(id);
    if (!t) return;
    const inputs = {};
    const text = (k, opts = {}) => (inputs[k] = h(opts.area ? 'textarea.text' : 'input.text', {
      value: opts.number ? (t[k] || '') : (t[k] ?? ''), spellcheck: false, placeholder: opts.placeholder ?? '',
      ...(opts.area ? {} : { type: opts.number ? 'number' : 'text', min: opts.number ? 0 : undefined }),
    }));
    const row = (label, input, hint) => [h('label', {}, label), h('div.ti-field', {}, input, hint ? h('small.ti-hint', {}, hint) : null)];

    const rating = h('div.ti-stars', {}, [1, 2, 3, 4, 5].map((n) => h('button.ti-star', { type: 'button', dataset: { n } }, '★')));
    let ratingValue = t.rating ?? 0;
    const paintStars = () => rating.querySelectorAll('.ti-star').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= ratingValue));
    rating.onclick = (e) => { const n = Number(e.target.dataset?.n); if (n) { ratingValue = ratingValue === n ? 0 : n; paintStars(); } };
    paintStars();
    const color = h('select', {}, h('option', { value: '' }, 'None'),
      TRACK_COLORS.map((c) => h('option', { value: c.name, selected: t.color === c.name, style: { color: c.css } }, `● ${c.name}`)));
    const notation = this.lib.settings.keyNotation;
    const key = h('select', {}, h('option', { value: '' }, '—'),
      CAMELOT.map((k) => h('option', { value: k, selected: t.key === k }, notation === 'musical' ? `${displayKey(k, 'musical')} (${k})` : `${k} (${displayKey(k, 'musical')})`)));
    const bpm = h('input.text', { type: 'number', step: '0.01', min: 0, value: t.bpm ? t.bpm.toFixed(2) : '' });
    const tags = h('input.text', { value: (t.myTags ?? []).join(', '), placeholder: 'e.g. warm-up, vocal, peak' });
    const cues = t.cues ?? [];
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n ? `${Math.round(n / 1024)} kB` : '');
    const info = (label, value) => (value || value === 0 ? [h('label', {}, label), h('div.ti-ro', {}, String(value))] : []);
    const pending = { artwork: null };
    const sp = lookupPanel(t, inputs, pending);

    const body = h('div.trackinfo', {},
      h('div.ti-top', {},
        h('p.ti-note', {}, 'Every field below can be edited. Changes are saved in your Reboxed library (they appear everywhere in Reboxed and in exports); the audio file itself is not modified.'),
        sp.button),
      sp.panel,
      h('div.ti-cols', {},
        h('div', {},
          h('h4', {}, 'Track'),
          h('div.form-grid', {},
            row('Title', text('title')), row('Artist', text('artist'), 'Several artists: separate with ", " or " & "'),
            row('Album', text('album')), row('Album artist', text('albumArtist')), row('Genre', text('genre')),
            row('Year', text('year', { number: true })), row('Track number', text('trackNumber', { number: true })), row('Disc number', text('discNumber', { number: true }))),
          h('h4', {}, 'Credits'),
          h('div.form-grid', {},
            row('Remixer', text('remixer')), row('Original artist', text('originalArtist')), row('Composer', text('composer')),
            row('Label', text('label')), row('Mix name', text('mixName'), 'e.g. Original Mix, Extended Mix'), row('Grouping', text('grouping')))),
        h('div', {},
          h('h4', {}, 'DJ'),
          h('div.form-grid', {},
            row('Rating', rating, 'Click a star; click it again to clear'),
            row('Color', color),
            row('My Tag', tags, 'Comma separated; used by the Track Filter and Intelligent Playlists'),
            row('Comments', text('comments', { area: true })),
            row('BPM', bpm, t.beatgrid ? 'Changing it re-spaces the beatgrid from its first beat' : ''),
            row('Key', key),
            row('DJ play count', text('playCount', { number: true })),
            row('Date added', (inputs.dateAdded = h('input.text', { type: 'datetime-local', value: dateTimeInput(t) })))),
          h('h4', {}, 'File (read only)'),
          h('div.form-grid', {},
            h('label', {}, 'Location'), h('div.ti-ro', {}, h('span.path', {}, t.path), ' ', h('button.dbtn.small', { onclick: () => window.rb.showItem(t.path) }, 'Show in folder')),
            ...info('Type', t.kind || t.path.split('.').pop().toUpperCase()),
            ...info('Duration', t.duration ? fmtTime(t.duration) : ''),
            ...info('Bitrate', t.bitrate ? `${t.bitrate} kbps` : ''),
            ...info('Sample rate', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : ''),
            ...info('Size', kb(t.fileSize)),
            ...info('Analysis', t.analyzed ? 'analysed' : 'not analysed yet'),
            ...info('Stems', t.stems ? t.stems.toUpperCase() : 'none'),
            ...info('Cues', `${cues.filter((c) => c.kind === 'hot').length} hot cues, ${cues.filter((c) => c.kind === 'memory').length} memory cues`)))));
    const ok = await modal(`Track information — ${t.title || 'Untitled'}`, body, [{ label: 'Save', primary: true, value: true }, { label: 'Cancel', value: null }]);
    if (!ok) return;
    const patch = { rating: ratingValue, color: color.value, key: key.value };
    for (const k of ['title', 'artist', 'album', 'albumArtist', 'genre', 'remixer', 'originalArtist', 'composer', 'label', 'mixName', 'grouping', 'comments']) patch[k] = inputs[k].value;
    for (const k of ['year', 'trackNumber', 'discNumber', 'playCount']) patch[k] = Math.max(0, Math.round(Number(inputs[k].value) || 0));
    if (inputs.dateAdded.value && inputs.dateAdded.value !== dateTimeInput(t)) {
      patch.dateAdded = inputs.dateAdded.value.slice(0, 10);
      patch.addedAt = inputs.dateAdded.value.length > 10 ? new Date(inputs.dateAdded.value).getTime() : undefined;
    }
    if (pending.artwork) {
      try { patch.artwork = await window.rb.artworkFromUrl(pending.artwork); } catch (err) { toast(`Cover not saved: ${err.message}`); }
    }
    patch.myTags = tags.value.split(',').map((x) => x.trim()).filter(Boolean);
    const newBpm = Number(bpm.value);
    if (newBpm > 0 && Math.abs(newBpm - (t.bpm ?? 0)) > 0.001) {
      patch.bpm = newBpm;
      if (t.beatgrid) patch.beatgrid = { ...t.beatgrid, bpm: newBpm, beats: undefined };
    }
    this.lib.update(id, patch);
    this.app.onTrackEdited?.(id);
  }

  setStatus(text) { this.status.textContent = text; }
}
