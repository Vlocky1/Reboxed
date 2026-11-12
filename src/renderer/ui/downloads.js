// Download centre: search YouTube or SoundCloud, paste a link (the platform is detected), follow
// channels for new releases, and download the audio with yt-dlp. Finished files join the
// collection, get analysed and land in a "Downloads" playlist. Quality and folder live in
// Preferences > Downloads.
import { h, toast, fmtTime } from './dom.js';
import { icon } from './icons.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { cleanTrackName, parseKeywords } from '../../shared/clean-name.js';
import { findOnYoutube } from '../../shared/yt-match.js';
import { matchLostDownloads } from '../../shared/dl-recover.js';
import { CollectionIndex } from '../../shared/in-collection.js';

const FORMAT_NAMES = { m4a: 'M4A', mp3: 'MP3 320', flac: 'FLAC', wav: 'WAV' };
const PLATFORMS = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', deezer: 'Deezer' };
// The sources' marks, drawn simply (to say where the tracks come from).
const LOGOS = {
  youtube: '<svg viewBox="0 0 24 24"><rect x="1.5" y="5" width="21" height="14" rx="4.5" fill="#ff0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>',
  soundcloud: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#ff5500"/><path d="M8.6 16.5V9.6c.6-.4 1.3-.6 2-.6 2.1 0 3.8 1.5 4.1 3.5.3-.1.6-.2.9-.2 1.4 0 2.4 1.1 2.4 2.1s-1 2.1-2.4 2.1zM7.4 16.5V10.4M6.2 16.5v-5.1M5 16.5v-3.6" fill="#fff" stroke="#fff" stroke-width=".9" stroke-linecap="round"/></svg>',
  spotify: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#1ed760"/><path d="M6.5 9.3c3.8-1.1 8.2-.8 11.3 1M7.2 12.6c3.1-.8 6.6-.5 9.2 1M7.9 15.7c2.4-.6 5-.4 7 .8" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round"/></svg>',
  deezer: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#a238ff"/><path d="M5 17.5h2.6M5 15h2.6M9.3 17.5h2.6M9.3 15h2.6M9.3 12.5h2.6M13.6 17.5h2.6M13.6 15h2.6M13.6 12.5h2.6M13.6 10h2.6M17.9 17.5h1.4M17.9 15h1.4M17.9 12.5h1.4M17.9 10h1.4M17.9 7.5h1.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
const SOURCE_HINT = {
  youtube: 'YouTube: search, videos, playlists, channels',
  soundcloud: 'SoundCloud: search, tracks, sets, artist pages',
  spotify: 'Spotify: tracks, albums and playlists (links; search with your Spotify keys) — the audio comes from YouTube',
  deezer: 'Deezer: search, tracks, albums and playlists (no account needed) — the audio comes from YouTube',
};
const PLACEHOLDER = {
  youtube: 'Search YouTube, or paste a link (video, playlist, channel)',
  soundcloud: 'Search SoundCloud, or paste a link (track, set, artist)',
  spotify: 'Paste a Spotify link (track, album, playlist), or search with your Spotify keys',
  deezer: 'Search Deezer, or paste a Deezer link (track, album, playlist)',
};
const INTRO = {
  youtube: 'Search YouTube, or paste any YouTube link: a playlist lists its tracks, with "Download all". A link from Spotify, Deezer or SoundCloud also works here.',
  soundcloud: 'Search SoundCloud, or paste a track, a set or an artist page.',
  spotify: 'Spotify gives the tracks (no account needed for links; with your Spotify keys in Preferences > Library: search, and playlists of any length). Each one is found on YouTube (same title, artist and length; no live, cover or sped-up versions), then downloaded with Spotify\'s title and artist.',
  deezer: 'Deezer gives the tracks (search, track, album or playlist link; no account needed). Each one is found on YouTube (same title, artist and length), then downloaded with Deezer\'s title and artist.',
};
const cleanErr = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
// Download sizes of the tools (MB, see src/main/tools.js), shown on the install button.
const TOOL_MB = { 'yt-dlp': 17, ffmpeg: 87, deno: 41 };

/** Source of a pasted link: 'youtube', 'soundcloud', 'spotify', 'deezer' or null. */
export function platformOf(url) {
  const s = String(url ?? '').trim();
  if (/^spotify:(track|album|playlist):/i.test(s)) return 'spotify';
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
  if (/(^|\.)(soundcloud\.com|snd\.sc)$/.test(host)) return 'soundcloud';
  if (/(^|\.)(spotify\.com|spotify\.link)$/.test(host)) return 'spotify';
  if (/(^|\.)(deezer\.com|deezer\.page\.link|dzr\.page\.link)$/.test(host)) return 'deezer';
  return null;
}
const ACTIVE = new Set(['queued', 'starting', 'downloading', 'converting']);

const ago = (ts) => {
  if (!ts) return '';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 31) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
};

export class DownloadCenter {
  /** @param {object} app Reboxed app */
  constructor(app) {
    this.app = app;
    /** key -> {item, state, pct, speed, eta, file, error} */
    this.jobs = new Map();
    this.feedItems = null;     // last "New releases" result
    this.newCount = 0;
    this.listeners = new Set();
    window.rb.dl.onProgress((key, p) => this.onProgress(key, p));
  }

  get cfg() { return { ...DEFAULT_SETTINGS.downloads, ...(this.app.library.settings.downloads ?? {}) }; }
  save(patch) { this.app.library.setSetting('downloads', { ...this.cfg, ...patch }); }
  /** full: rebuild the open tab; otherwise only progress / counters change. */
  changed(full = false) { this.listeners.forEach((f) => f(full)); this.app.refreshDownloadStatus?.(); }

  async folder() {
    if (this.cfg.folder) return this.cfg.folder;
    const { music } = await window.rb.paths();
    return `${music}\\Reboxed Downloads`;
  }

  tools() { return window.rb.dl.tools(this.cfg.toolsDir); }

  /**
   * Tools status with actions: install the missing tools from their official releases, update
   * yt-dlp, or choose a folder. Used by the download window and Preferences > Downloads.
   * @param {() => void} [onChange] called after tools were installed or a folder chosen
   */
  toolsPanel(onChange) {
    const el = h('div.tools-panel');
    const status = h('span.dim');
    const busy = (text) => { el.classList.add('busy'); status.textContent = text; };
    const run = async (task) => {
      const off = window.rb.dl.onToolsProgress((name, rec, total, phase) => {
        busy(phase === 'extract' ? `${name}: unpacking…` : phase === 'done' ? `${name} ✓` : total ? `${name}: ${Math.round((rec / total) * 100)}% of ${Math.round(total / 1048576)} MB` : `${name}: starting…`);
      });
      try { await task(); onChange?.(); } catch (err) { toast(`Tools: ${err.message}`, 6000); } finally { off(); el.classList.remove('busy'); render(); }
    };
    const render = async () => {
      const t = await this.tools();
      const missing = [!t.ytdlp && 'yt-dlp', !t.ffmpeg && 'ffmpeg', !t.deno && 'deno'].filter(Boolean);
      const mb = missing.reduce((a, n) => a + TOOL_MB[n], 0);
      status.textContent = t.ytdlp
        ? `yt-dlp ${t.version ?? ''} · ffmpeg ${t.ffmpeg ? '✓' : '✗ (needed for MP3/FLAC/WAV and covers)'} · deno ${t.deno ? '✓' : '✗ (YouTube may refuse some videos)'}`
        : `Missing: ${missing.join(', ')}`;
      status.className = t.ytdlp ? 'dim' : 'rbi-error';
      el.replaceChildren(status,
        missing.length ? h('button.dbtn.small.primary', { title: 'Downloads them from their official releases into Reboxed\'s tools folder',
          onclick: () => run(() => window.rb.dl.installTools(missing)) }, `Install ${missing.join(' + ')} (${mb} MB)`) : '',
        t.ytdlp ? h('button.dbtn.small', { title: 'YouTube changes often: a newer yt-dlp fixes most download errors',
          onclick: () => run(async () => { busy('yt-dlp: updating…'); const r = await window.rb.dl.updateYtdlp(); toast(r.installed ? `yt-dlp ${r.tools.version ?? ''} installed in Reboxed's tools folder` : (r.output || 'yt-dlp is up to date'), 5000); }) }, 'Update yt-dlp') : '',
        h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { this.save({ toolsDir: d }); render(); onChange?.(); } } }, 'Choose folder…'));
    };
    render();
    return el;
  }

  isDone(id) { return !!this.cfg.done[id]; }

  /** The collection, as compared with what is offered for download (rebuilt after any change). */
  get collection() {
    const lib = this.app.library;
    if (!this.colWatch) { this.colWatch = true; lib.addEventListener?.('change', () => { this.colIndex = null; }); }
    return (this.colIndex ??= new CollectionIndex(lib.all(), { keywords: parseKeywords(this.cfg.cleanKeywords) }));
  }

  /**
   * The collection track a video / upload already is: {sure: true} same names and length, {sure:
   * false} same names, another length (null when it is not there, or was downloaded from here).
   */
  ownedUpload(item) {
    if (!item?.title || this.isDone(item.id)) return null;
    return this.collection.find({ title: item.title, artist: item.channel, duration: item.duration }, { upload: true });
  }

  /** The collection track a Spotify / Deezer track already is (kept on the track). */
  ownedCatalog(t) {
    if (t.own === undefined) t.own = this.collection.find({ title: t.title, artist: t.artist, duration: t.duration, mixName: t.mixName }) ?? null;
    return t.forced ? null : t.own;
  }

  /** "Already in your collection: Artist – Title" (or "Maybe…" with both lengths). */
  ownedLabel(own, duration) {
    const t = own.track; const name = `${t.artist ? `${t.artist} – ` : ''}${t.title}`;
    return own.sure ? `Already in your collection: ${name}`
      : `Maybe already in your collection: ${name} (same names, ${t.duration ? fmtTime(t.duration) : '?'} in the collection${duration ? ` vs ${fmtTime(duration)} here` : ''}: another edit? Checked by ear once downloaded)`;
  }

  /** The badge of a result already (or maybe) in the collection. */
  ownedBadge(own, duration) {
    return h(own.sure ? 'span.dlc-owned' : 'span.dlc-owned.maybe', { title: this.ownedLabel(own, duration) }, own.sure ? '✓ In collection' : '≈ Maybe in collection');
  }

  /** A track into the playlist named after a list (created on first use). */
  addToNamed(id, addTo) {
    if (!id || !addTo) return;
    const lib = this.app.library;
    let pl = lib.playlists.find((n) => n.src === addTo.src);
    if (!pl) { pl = lib.createNode('playlist', addTo.name); pl.src = addTo.src; }
    if (!pl.trackIds.includes(id)) lib.addToPlaylist(pl.id, [id]);
  }

  /** Queue items (from search, links or feeds). */
  async enqueue(items) {
    const folder = await this.folder();
    for (const item of items) {
      const key = item.id;
      if (this.jobs.has(key) && ACTIVE.has(this.jobs.get(key).state)) continue;
      this.jobs.set(key, { item, state: 'queued', pct: 0 });
      window.rb.dl.download({ key, url: item.url }, { folder, format: this.cfg.format })
        .then((file) => this.finished(item, file), () => { /* state already reported through progress */ })
        .catch((err) => this.notAdded(item, err.message));
    }
    this.changed(this.tab === 'queue');
  }

  cancel(key) { window.rb.dl.cancel(key); }

  onProgress(key, p) {
    const job = this.jobs.get(key);
    if (!job) return;
    Object.assign(job, p);
    if (p.state === 'error') toast(`Download failed: ${job.item.title} — ${p.error}`, 7000);
    this.changed();
  }

  /** The download went through but the track is not in the library: said clearly, can be retried. */
  notAdded(item, reason) {
    const job = this.jobs.get(item.id);
    if (job) Object.assign(job, { state: 'error', error: reason });
    toast(`"${item.title}" was downloaded but not added to the library: ${reason}`, 9000);
    this.changed();
  }

  /** Add the file to the collection (and the Downloads playlist), remember it was downloaded. */
  async finished(item, file) {
    if (!file) { this.notAdded(item, 'no file came back from the download'); return; }
    await this.app.importPaths([file]);
    if (!this.app.library.idForPath(file)) { this.notAdded(item, `cannot read ${file}`); return; }
    this.afterImport(item, file);
    toast(`Downloaded: ${item.title}`);
    this.changed();
  }

  /**
   * Tracks downloaded before 1.21 whose name had an accent, Japanese or an emoji: the file is in the
   * download folder, the library never got it, and the download shows as done. They are added now.
   */
  async recoverLost() {
    const lib = this.app.library;
    const entries = Object.entries(this.cfg.done).filter(([, path]) => typeof path === 'string' && !lib.idForPath(path));
    if (!entries.length) return 0;
    const exists = await window.rb.existsMany(entries.map(([, path]) => path));
    const lost = entries.filter((_, i) => !exists[i]).map(([id, path]) => ({ id, path }));
    if (!lost.length) return 0;
    const files = (await window.rb.listAudio(await this.folder()).catch(() => [])).map((f) => f.path).filter((p) => !lib.idForPath(p));
    const found = matchLostDownloads(lost, files);
    if (found.length) await this.app.importPaths(found.map((f) => f.path));
    for (const f of found) if (lib.idForPath(f.path)) this.afterImport({ id: f.id, title: lib.get(lib.idForPath(f.path))?.title ?? '' }, f.path);
    // A garbled record with no file: back to "can be downloaded" instead of a false "in collection".
    const done = { ...this.cfg.done };
    const fixed = new Set(found.map((f) => f.id));
    for (const l of lost) if (!fixed.has(l.id) && l.path.includes('�')) delete done[l.id];
    this.save({ done: { ...done, ...Object.fromEntries(found.map((f) => [f.id, f.path])) } });
    if (found.length) toast(`${found.length} downloaded track(s) that never reached the library were added`, 7000);
    this.changed();
    return found.length;
  }

  /** A downloaded file just joined the collection: its clean name, its playlists, marked as done. */
  afterImport(item, file) {
    const lib = this.app.library;
    const id = lib.idForPath(file);
    // Name cleaner: "(Paroles)", "[Official Video]", "- Topic"… go as the track joins the collection.
    if (id && this.cfg.cleanNames !== false) {
      const t = lib.get(id);
      const clean = cleanTrackName({ title: t.title || item.title, artist: t.artist }, parseKeywords(this.cfg.cleanKeywords));
      if (clean.title !== t.title || clean.artist !== (t.artist ?? '')) lib.update(id, clean);
    }
    // From a Spotify playlist: Spotify's clean title and artist rather than the video's.
    if (id && item.meta) lib.update(id, item.meta);
    if (id && this.cfg.playlist) {
      let pl = lib.playlists.find((n) => n.src === 'downloads');
      if (!pl) { pl = lib.createNode('playlist', 'Downloads'); pl.src = 'downloads'; }
      if (!pl.trackIds.includes(id)) lib.addToPlaylist(pl.id, [id]);
    }
    this.addToNamed(id, item.addTo);
    this.save({ done: { ...this.cfg.done, [item.id]: file } });
    if (id) this.watchByEar(id);
  }

  // ---- after the download: the sound against the collection --------------------------------------

  /** Check a download by ear once it is analysed (analysed now when automatic analysis is off). */
  watchByEar(id) {
    const t = this.app.library.get(id);
    if (!t) return;
    this.earWait ??= new Map();             // track waiting for its analysis → downloads to check then
    if (t.analyzed) { this.checkByEar(id); return; }
    this.earWait.set(id, new Set([...(this.earWait.get(id) ?? []), id]));
    if (!this.app.library.settings.autoAnalyze) this.app.analyzeTracks([id]);
  }

  /** A track was just analysed (called by the app): the downloads that waited for it are checked. */
  analysed(id) {
    const owners = this.earWait?.get(id);
    if (!owners) return;
    this.earWait.delete(id);
    for (const dl of owners) this.checkByEar(dl);
  }

  /**
   * The download against the collection: its candidates (names under any reading, sound
   * fingerprint) compared by ear. Candidates not analysed yet are analysed, then it is checked again.
   * Duplicates go to the "Suspected duplicates" playlist.
   */
  async checkByEar(id) {
    const lib = this.app.library;
    const t = lib.get(id);
    if (!t?.analyzed) return;
    const { checkNewTrack } = await import('./duplicates.js');
    const { pairs, waiting } = await checkNewTrack(this.app, t, { keywords: parseKeywords(this.cfg.cleanKeywords) });
    this.earWait ??= new Map();
    for (const w of waiting) this.earWait.set(w.id, new Set([...(this.earWait.get(w.id) ?? []), id]));
    if (waiting.length) this.app.analyzeTracks(waiting.map((w) => w.id));
    const fresh = pairs.filter((p) => !(this.earSeen ??= new Set()).has(`${p.a.id}|${p.b.id}`));
    if (!fresh.length) return;
    fresh.forEach((p) => this.earSeen.add(`${p.a.id}|${p.b.id}`));
    this.earLog = (this.earLog ?? []).slice(-40);  // what was flagged and why (checks, diagnostics)
    this.earLog.push(...fresh.map((p) => `${p.a.title} [${Math.round(p.a.duration ?? 0)}] ↔ ${p.b.title} [${Math.round(p.b.duration ?? 0)}]: ${p.verdict.kind} ${p.verdict.score} meta ${p.meta}${p.audio ? ` sound ${p.audio.score} overlap ${p.audio.overlap}` : ''}`));
    const { SUSPECTS_SRC, SUSPECTS_NAME } = await import('./duplicates.js');
    let pl = lib.playlists.find((n) => n.src === SUSPECTS_SRC);
    if (!pl) { pl = lib.createNode('playlist', SUSPECTS_NAME); pl.src = SUSPECTS_SRC; }
    const ids = [...new Set(fresh.flatMap((p) => [p.a.id, p.b.id]))].filter((x) => !pl.trackIds.includes(x));
    if (ids.length) lib.addToPlaylist(pl.id, ids);
    const p = fresh[0]; const twin = p.a.id === id ? p.b : p.a;
    toast(`"${t.title}" sounds like "${twin.artist ? `${twin.artist} – ` : ''}${twin.title}" already in your collection (${p.verdict.label}). Both are in the playlist "${SUSPECTS_NAME}": right-click it > Find duplicates… to keep one.`, 12000);
  }

  /** Followed channels / playlists: latest uploads, newest first, with the "new" ones counted. */
  async checkFeeds() {
    const { subs, seen, maxMinutes } = this.cfg;
    if (!subs.length) { this.feedItems = []; this.newCount = 0; this.changed(); return []; }
    this.checking = true; this.changed(true);
    const results = [];
    for (let i = 0; i < subs.length; i += 3) {
      const part = await Promise.all(subs.slice(i, i + 3).map((s) => window.rb.dl.feed(s.url, 15)
        .then((f) => f.items.map((it) => ({ ...it, source: s.name || f.name })))
        .catch((err) => { toast(`${s.name}: ${err.message}`, 6000); return []; })));
      results.push(...part.flat());
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    this.feedItems = [...byId.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const seenSet = new Set(seen);
    const fits = (it) => !maxMinutes || !it.duration || it.duration <= maxMinutes * 60;
    this.feedItems.forEach((it) => { it.isNew = !seenSet.has(it.id) && !this.isDone(it.id); });
    this.newCount = this.feedItems.filter((it) => it.isNew && fits(it)).length;
    this.checking = false;
    this.changed(true);
    return this.feedItems;
  }

  markSeen() {
    if (!this.feedItems) return;
    const seen = new Set(this.cfg.seen);
    this.feedItems.forEach((it) => seen.add(it.id));
    this.save({ seen: [...seen].slice(-5000) });
    this.newCount = 0;
    this.changed();
  }

  follow(url, name) {
    const subs = this.cfg.subs;
    if (subs.some((s) => s.url === url)) { toast(`Already following ${name || url}`); return; }
    this.save({ subs: [...subs, { url, name: name || url }] });
    toast(`Following ${name || url} — new uploads show in New releases`);
    this.changed(true);
  }

  unfollow(url) { this.save({ subs: this.cfg.subs.filter((s) => s.url !== url) }); this.changed(true); }

  activeCount() { return [...this.jobs.values()].filter((j) => ACTIVE.has(j.state)).length; }

  // ---- panel -------------------------------------------------------------------------------------

  // ---- the window: a source (YouTube, SoundCloud, Spotify, Deezer), then search or a link -----------

  /**
   * Open the window. tab: 'search' / 'link' (the source view; with this.link set, that link is read),
   * 'spotify' (the Spotify source, with its last list), 'feeds', 'queue'.
   */
  open(tab = 'search') {
    const view = tab === 'feeds' || tab === 'queue' ? tab : 'source';
    if (tab === 'spotify') this.source = 'spotify';
    if (tab === 'link' && this.link) { this.source = platformOf(this.link) ?? this.source; this.pendingLink = this.link; this.link = null; }
    if (this.overlay) { this.showTab(view); return; }
    this.sourceBtns = new Map(Object.entries(PLATFORMS).map(([id, label]) => [id, h('button.dlc-source', { dataset: { platform: id }, title: SOURCE_HINT[id], onclick: () => this.setSource(id) },
      h('span.dlc-logo', { innerHTML: LOGOS[id] }), h('span', {}, label))]));
    this.tabBtns = new Map([['feeds', 'New releases'], ['queue', 'Queue']].map(([id, label]) => [id, h('button.seg-btn', { onclick: () => this.showTab(id) }, label)]));
    this.body = h('div.dlc-body');
    this.toolsLine = h('div.dlc-tools');
    const folderEl = h('span.dlc-folder');
    const summary = async () => { const f = await this.folder(); folderEl.textContent = `${FORMAT_NAMES[this.cfg.format] ?? this.cfg.format} → ${f}`; folderEl.title = f; };
    summary();
    const footer = h('div.dlc-footer', {},
      h('label', {}, 'Saving as '), folderEl,
      h('button.dbtn.small', { onclick: async () => { await this.app.openSettings('downloads'); summary(); } }, 'Quality & folder…'));
    const close = () => { this.overlay.remove(); this.overlay = null; this.listeners.delete(this.rerender); };
    this.overlay = h('div.overlay', { onpointerdown: (e) => { if (e.target === this.overlay) close(); } },
      h('div.dialog.dlc', { role: 'dialog' },
        h('h2', {}, icon('download'), ' Download tracks', h('button.dlc-x', { title: 'Close (downloads continue)', onclick: close }, '✕')),
        h('div.dlc-tabs', {}, h('div.dlc-sources', {}, [...this.sourceBtns.values()]), h('span.spacer'), h('div.seg', {}, [...this.tabBtns.values()])),
        this.toolsLine, this.body, footer,
        h('p.dlc-legal', {}, 'Only download music you have the right to use (free downloads, your own or licensed releases). ',
          'Spotify and Deezer give the track lists; the audio of each track comes from YouTube. Uses yt-dlp, ffmpeg and deno (installed from here, or already on this computer).')));
    this.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    document.body.append(this.overlay);
    this.rerender = (full) => this.renderTab(!full);
    this.listeners.add(this.rerender);
    this.toolsLine.replaceChildren(this.toolsPanel());
    this.showTab(view);
  }

  /** The chosen source (remembered). */
  get source() { return this._source ?? (PLATFORMS[this.cfg.platform] ? this.cfg.platform : 'youtube'); }
  set source(p) { this._source = p; }

  setSource(p, render = true) {
    if (!PLATFORMS[p]) return;
    this._source = p;
    this.save({ platform: p });
    if (render) this.showTab('source');
  }

  showTab(id) {
    this.tab = id;
    this.tabBtns.forEach((b, k) => b.classList.toggle('on', k === id));
    this.sourceBtns?.forEach((b, k) => b.classList.toggle('on', id === 'source' && k === this.source));
    this.renderTab(false);
    if (id === 'feeds' && !this.feedItems && !this.checking) this.checkFeeds();
  }

  /** soft: progress update only (keep inputs and scroll). */
  renderTab(soft) {
    if (!this.overlay) return;
    this.tabBtns.get('queue').textContent = `Queue${this.activeCount() ? ` (${this.activeCount()})` : ''}`;
    this.tabBtns.get('feeds').textContent = `New releases${this.newCount ? ` (${this.newCount})` : ''}`;
    if (soft) { this.rows?.forEach((update) => update()); return; }
    const scroll = this.body.scrollTop;
    if (this.tab === 'feeds') this.renderFeeds();
    else if (this.tab === 'queue') this.renderQueue();
    else this.renderSource();
    this.body.scrollTop = scroll;
  }

  /** One result row; returns the element and registers its progress updater. */
  row(item, { showSource = false } = {}) {
    const action = h('div.dlc-action');
    const update = () => {
      const job = this.jobs.get(item.id);
      if (job && ACTIVE.has(job.state)) {
        const pct = Math.round(job.pct ?? 0);
        action.replaceChildren(h('div.dlc-prog', { style: { '--p': `${pct}%` } },
          job.state === 'queued' ? 'Queued' : job.state === 'converting' ? 'Converting…' : `${pct}%${job.eta && job.eta !== 'NA' ? ` · ${job.eta}` : ''}`),
        h('button.dbtn.small', { title: 'Cancel', onclick: () => this.cancel(item.id) }, '✕'));
      } else if (job?.state === 'done' || this.isDone(item.id)) {
        action.replaceChildren(h('span.dlc-done', {}, '✓ In collection'));
      } else if (own && !job) {
        action.replaceChildren(this.ownedBadge(own, item.duration),
          h('button.dbtn.small', { title: `${this.ownedLabel(own, item.duration)}. Download it anyway`, onclick: () => this.enqueue([item]) }, icon('download')));
      } else {
        const get = h('button.dbtn.small.dlc-get', { onclick: () => this.enqueue([item]) }, icon('download'), ' Download');
        action.replaceChildren(...(job?.state === 'error' ? [h('span.rbi-error', { title: job.error }, 'Failed '), get] : [get]));
      }
    };
    const own = this.ownedUpload(item);
    update();
    this.rows.push(update);
    const follow = item.channelUrl
      ? h('button.dlc-follow', { title: `Follow ${item.channel}: its new uploads show in New releases`, onclick: () => this.follow(item.channelUrl, item.channel) }, '+ follow')
      : null;
    return h('div.dlc-row', {},
      item.thumb ? h('img.dlc-thumb', { src: item.thumb, loading: 'lazy', alt: '' }) : h('div.dlc-thumb'),
      h('div.dlc-info', {},
        h('div.dlc-title', { title: item.title }, item.isNew ? h('span.dlc-new', {}, 'NEW') : null, item.title,
          item.preview ? h('span.dlc-preview', { title: 'SoundCloud only gives a 30 second preview of this track (SoundCloud Go+)' }, '30 s preview') : null),
        h('div.dlc-sub', {}, item.channel, follow, showSource && item.source && item.source !== item.channel ? ` · ${item.source}` : '',
          item.timestamp ? ` · ${ago(item.timestamp)}` : '', item.views ? ` · ${item.views.toLocaleString()} views` : '')),
      h('div.dlc-dur', {}, item.duration ? fmtTime(item.duration) : ''),
      action);
  }

  list(items, opts) {
    this.rows = [];
    return h('div.dlc-list', {}, items.length ? items.map((it) => this.row(it, opts)) : h('p.dim', {}, 'Nothing here.'));
  }

  /** The chosen source: one field for a search or a link, then what it found. */
  renderSource() {
    const p = this.source;
    this.sourceBtns?.forEach((b, k) => b.classList.toggle('on', k === p));
    const catalog = p === 'spotify' || p === 'deezer';
    const input = h('input.text', { placeholder: PLACEHOLDER[p], value: this.queries?.[p] ?? '', spellcheck: false });
    const go = async () => {
      const v = input.value.trim();
      if (!v) return;
      (this.queries ??= {})[p] = v;
      const lp = platformOf(v);
      if (/^https?:\/\/|^spotify:/i.test(v) && !lp) { this.flash('This link is not from YouTube, SoundCloud, Spotify or Deezer'); return; }
      if (lp) { if (lp !== p) { (this.queries ??= {})[lp] = v; this.setSource(lp, false); } await this.readLink(v); return; }
      await this.search(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const bar = h('div.dlc-bar', {}, h('span.dlc-logo.small', { innerHTML: LOGOS[p] }), input, h('button.dbtn.dlc-primary', { onclick: go }, icon('search'), ' Go'));
    const opts = this.listOpts ??= { addToPlaylist: true };
    const check = (key, label) => h('label.dlc-check', {}, h('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), ` ${label}`);
    this.rows = [];
    const parts = [bar];
    this.statusEl = h('p.dim');
    // a list read from a link (playlist, album, artist page)
    if (catalog && this.sp && (this.sp.platform ?? 'spotify') === p && !this.sp.search) {
      parts.push(h('div.dlc-bar.dlc-filters', {}, check('addToPlaylist', 'Add to a playlist named after it')));
      parts.push(...this.catalogView(this.sp));
    } else if (catalog && this.sp && (this.sp.platform ?? 'spotify') === p && this.sp.search) {
      parts.push(h('p.dim', {}, `${PLATFORMS[p]} gives the track; its audio is found on YouTube (same title, artist and length) and downloaded with ${PLATFORMS[p]}'s title and artist.`));
      parts.push(h('div.dlc-list', {}, this.sp.tracks.map((t) => this.spotifyRow(t, this.sp))));
    } else if (!catalog && this.linkList?.platform === p) {
      const L = this.linkList;
      const pending = L.items.filter((it) => !this.isDone(it.id) && !this.jobs.has(it.id));
      const owned = pending.map((it) => [it, this.ownedUpload(it)]).filter(([, o]) => o?.sure);
      const left = pending.filter((it) => !owned.some(([x]) => x === it));
      if (L.items.length > 1) {
        const addTo = () => (opts.addToPlaylist ? { name: L.name, src: `${p}:${L.url}` } : null);
        parts.push(h('div.dlc-bar.dlc-filters', {}, check('addToPlaylist', 'Add to a playlist named after it')));
        parts.push(h('div.dlc-bar', {}, h('b', {}, L.name),
          h('span.dim', {}, ` ${L.items.length} tracks${owned.length ? ` · ${owned.length} already in your collection (skipped)` : ''}`), h('span.spacer'),
          left.length ? h('button.dbtn.dlc-primary', {
            title: owned.length ? 'The tracks already in your collection are not downloaded again (they join the playlist when that option is on)' : '',
            onclick: () => { owned.forEach(([, o]) => this.addToNamed(o.id, addTo())); this.enqueue(left.map((it) => ({ ...it, addTo: addTo() }))); },
          }, `Download all ${left.length}`) : null));
      }
      parts.push(this.list(L.items));
    } else if (!catalog && this.searchResults && this.searchPlatform === p) {
      parts.push(this.list(this.searchResults));
    } else {
      parts.push(h('p.dim', {}, INTRO[p]));
    }
    parts.splice(1, 0, this.statusEl);
    this.body.replaceChildren(h('div', {}, ...parts));
    if (this.pendingLink) { const l = this.pendingLink; this.pendingLink = null; input.value = l; go(); }
    else setTimeout(() => input.focus());
  }

  flash(text, error = true) { if (this.statusEl) { this.statusEl.className = error ? 'rbi-error' : 'dim'; this.statusEl.textContent = text; } }

  /** Search the chosen source. */
  async search(q) {
    const p = this.source;
    this.flash(`Searching ${PLATFORMS[p]}…`, false);
    try {
      if (p === 'spotify' || p === 'deezer') {
        const tracks = await window.rb.catalog.search(p, q);
        this.sp = { platform: p, search: true, name: null, src: null, tracks: tracks.map((t) => ({ ...t, status: 'waiting', match: null })) };
      } else {
        this.searchResults = await window.rb.dl.search(q, 20, p);
        this.searchPlatform = p;
        this.linkList = null;
      }
      this.renderTab(false);
    } catch (err) { this.flash(cleanErr(err)); }
  }

  /** A link: one track or a list (playlist, album, artist page) from any of the four sources. */
  async readLink(url) {
    const p = this.source;
    this.flash('Reading the link…', false);
    try {
      if (p === 'spotify' || p === 'deezer') {
        await this.readSpotify(url);
        this.renderTab(false);
        this.findSpotifyOnYoutube({ download: false, addToPlaylist: this.listOpts?.addToPlaylist !== false });
      } else {
        const r = await window.rb.dl.resolveList(url);
        this.linkList = { platform: p, url, name: r.name, items: r.items };
        this.searchResults = null;
        this.renderTab(false);
      }
    } catch (err) { this.flash(cleanErr(err)); }
  }

  // ---- Spotify / Deezer lists → YouTube ------------------------------------------------------------

  /** Read a Spotify or Deezer link (track, album, playlist): its tracks, each to be found on YouTube. */
  async readSpotify(url) {
    const r = await window.rb.catalog.read(url);
    const platform = /deezer|dzr\./i.test(url) ? 'deezer' : 'spotify';
    const link = /(playlist|album|track)[/:]([A-Za-z0-9]+)/.exec(url);
    this.sp = { platform, url, kind: r.kind, name: r.name, via: r.via, src: `${platform}:${link?.[2] ?? r.name}`, tracks: r.tracks.map((t) => ({ ...t, status: 'waiting', match: null })) };
    return this.sp;
  }

  /** The search YouTube matches run through (replaced in tests). */
  ytSearch(q) { return window.rb.dl.search(q, 6, 'youtube'); }

  /**
   * Find every track of the read list on YouTube (two searches at a time) and, when asked,
   * download each one as soon as it is found.
   */
  async findSpotifyOnYoutube({ download = false, addToPlaylist = true, search = (q) => this.ytSearch(q) } = {}) {
    const sp = this.sp;
    if (!sp || sp.running) return;
    sp.running = true; sp.stop = false;
    this.changed(true);
    // tracks already in the collection are not searched nor downloaded again; they join the list's playlist
    const addTo = addToPlaylist && sp.name && !sp.search ? { name: sp.name, src: sp.src } : null;
    for (const t of sp.tracks) { const own = this.ownedCatalog(t); if (own?.sure) this.addToNamed(own.id, addTo); }
    const todo = sp.tracks.filter((t) => (t.status === 'waiting' || t.status === 'error') && !this.ownedCatalog(t)?.sure);
    const worker = async () => {
      while (todo.length && !sp.stop) {
        const t = todo.shift();
        await this.findOne(t, sp, { download, addToPlaylist, search });
      }
    };
    await Promise.all([worker(), worker()]);
    sp.running = false;
    this.changed(true);
    const found = sp.tracks.filter((t) => t.match).length;
    const owned = sp.tracks.filter((t) => this.ownedCatalog(t)?.sure).length;
    if (sp.tracks.length > 1) toast(`${sp.name}: ${owned ? `${owned} already in your collection, ` : ''}${found} / ${sp.tracks.length - owned} found on YouTube${download ? ', downloading' : ''}`, 6000);
  }

  /** One track of a list: its YouTube upload, downloaded when asked. */
  async findOne(t, list, { download = true, addToPlaylist = false, search = (q) => this.ytSearch(q) } = {}) {
    t.status = 'searching'; this.changed();
    try {
      const best = await findOnYoutube(t, search);
      t.match = best?.item ?? null;
      t.longer = !!best?.longer;
      t.status = best ? 'found' : 'none';
      if (best && download) this.enqueueSpotify(t, addToPlaylist, list);
    } catch (err) { t.status = 'error'; t.error = err.message; }
    this.changed();
  }

  enqueueSpotify(t, addToPlaylist = true, list = this.sp) {
    if (!t.match || this.isDone(t.match.id)) return;
    this.enqueue([{ ...t.match, meta: { title: t.title, artist: t.artist }, addTo: addToPlaylist && list?.name && !list.search ? { name: list.name, src: list.src } : null }]);
  }

  /** A Spotify / Deezer list read from a link: its name, progress, download all, the tracks. */
  catalogView(sp) {
    const opts = this.listOpts ??= { addToPlaylist: true };
    const found = sp.tracks.filter((t) => t.match).length;
    const owned = sp.tracks.filter((t) => this.ownedCatalog(t)?.sure).length;
    const left = sp.tracks.filter((t) => t.match && !this.isDone(t.match.id) && !this.jobs.has(t.match.id)).length;
    return [
      h('div.dlc-bar', {},
        h('span.dlc-logo.small', { innerHTML: LOGOS[sp.platform] ?? '' }), h('b', {}, sp.name),
        h('span.dim', {}, ` ${sp.tracks.length} track${sp.tracks.length > 1 ? 's' : ''} · ${found} found on YouTube${owned ? ` · ${owned} already in your collection` : ''}${sp.via === 'embed' && sp.tracks.length >= 100 ? ' · only the first 100 without Spotify keys' : ''}`),
        h('span.spacer'),
        sp.running ? h('button.dbtn', { onclick: () => { sp.stop = true; } }, 'Stop') : h('button.dbtn', { onclick: () => this.findSpotifyOnYoutube(opts) }, 'Search again (not found)'),
        left ? h('button.dbtn.dlc-primary', { onclick: () => sp.tracks.forEach((t) => this.enqueueSpotify(t, opts.addToPlaylist, sp)) }, `Download all ${left}`) : null),
      h('div.dlc-list', {}, sp.tracks.map((t) => this.spotifyRow(t, sp))),
    ];
  }

  /** The Spotify source with its last list (older entry point). */
  renderSpotify() { this.source = 'spotify'; this.renderSource(); }

  /** One Spotify / Deezer track and what was found for it on YouTube. */
  spotifyRow(t, list = this.sp) {
    const right = h('div.dlc-match');
    const action = h('div.dlc-action');
    const update = () => {
      const m = t.match;
      const own = this.ownedCatalog(t);
      if (own?.sure) {
        right.replaceChildren(this.ownedBadge(own, t.duration), h('span.dim', {}, ` · ${own.track.artist ? `${own.track.artist} – ` : ''}${own.track.title}`));
        action.replaceChildren(h('button.dbtn.small', { title: `${this.ownedLabel(own, t.duration)}. Find it on YouTube and download it anyway`, onclick: () => { t.forced = true; this.findOne(t, list, { download: true, addToPlaylist: this.listOpts?.addToPlaylist !== false }); } }, icon('download')));
        return;
      }
      right.replaceChildren(...(t.status === 'searching' ? [h('span.dim', {}, 'Searching YouTube…')]
        : t.status === 'none' ? [h('span.rbi-error', {}, 'Not found on YouTube')]
          : t.status === 'error' ? [h('span.rbi-error', { title: t.error }, 'Search failed')]
            : m ? [t.longer ? h('span.dlc-new', { title: 'The list has the short edit: this is the longer club version of the same track' }, 'EXTENDED') : null,
              h('a.dlc-yt', { href: '#', title: m.url, onclick: (e) => { e.preventDefault(); window.rb.openExternal(m.url); } }, m.title), h('span.dim', {}, ` · ${m.channel ?? ''} · ${m.duration ? fmtTime(m.duration) : ''}`)].filter(Boolean)
              : [h('span.dim', {}, list?.search ? '' : 'Waiting')]));
      if (own) right.prepend(this.ownedBadge(own, t.duration));
      const job = m ? this.jobs.get(m.id) : null;
      if (job && ACTIVE.has(job.state)) {
        const pct = Math.round(job.pct ?? 0);
        action.replaceChildren(h('div.dlc-prog', { style: { '--p': `${pct}%` } }, job.state === 'queued' ? 'Queued' : job.state === 'converting' ? 'Converting…' : `${pct}%`));
      } else if (m && (job?.state === 'done' || this.isDone(m.id))) action.replaceChildren(h('span.dlc-done', {}, '✓'));
      else if (m) action.replaceChildren(h('button.dbtn.small.dlc-get', { onclick: () => this.enqueueSpotify(t, this.listOpts?.addToPlaylist !== false, list) }, icon('download')));
      else if (list?.search && t.status === 'waiting') action.replaceChildren(h('button.dbtn.small.dlc-get', { title: 'Find it on YouTube and download it', onclick: () => this.findOne(t, list) }, icon('download'), ' Download'));
      else action.replaceChildren();
    };
    update();
    this.rows.push(update);
    return h('div.dlc-row.dlc-sprow', {},
      t.cover ? h('img.dlc-thumb.sq', { src: t.cover, loading: 'lazy', alt: '' }) : null,
      h('div.dlc-info', {}, h('div.dlc-title', { title: t.title }, t.title), h('div.dlc-sub', {}, t.artist, t.duration ? ` · ${fmtTime(t.duration)}` : '', t.album ? ` · ${t.album}` : '')),
      h('div.dlc-arrow', {}, '→'),
      right, action);
  }

  renderFeeds() {
    const c = this.cfg;
    const add = h('input.text', { placeholder: 'Follow a channel or playlist: paste its link (e.g. youtube.com/@label)', spellcheck: false });
    const doAdd = () => { const u = add.value.trim(); if (u) { this.follow(u, u.replace(/^https?:\/\/(www\.)?youtube\.com\//, '')); this.feedItems = null; this.checkFeeds(); } };
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    const fits = (it) => !c.maxMinutes || !it.duration || it.duration <= c.maxMinutes * 60;
    const items = (this.feedItems ?? []).filter((it) => fits(it) && !(this.hideDone && this.isDone(it.id)));
    const fresh = items.filter((it) => it.isNew && !this.isDone(it.id) && !this.ownedUpload(it)?.sure);
    this.body.replaceChildren(
      h('div.dlc-subs', {},
        c.subs.map((s) => h('span.chip', { title: s.url }, s.name, h('button.dlc-unfollow', { title: 'Unfollow', onclick: () => { this.unfollow(s.url); this.feedItems = null; this.checkFeeds(); } }, '×'))),
        c.subs.length ? null : h('span.dim', {}, 'Follow artists and labels (button "+ follow" in search results, or paste a channel link) to see their new tracks here.')),
      h('div.dlc-bar', {}, add, h('button.dbtn', { onclick: doAdd }, 'Follow')),
      h('div.dlc-bar.dlc-filters', {},
        h('button.dbtn.dlc-primary', { disabled: this.checking, onclick: () => this.checkFeeds() }, this.checking ? 'Checking…' : 'Check now'),
        h('label.dlc-check', {}, h('input', { type: 'checkbox', checked: !!c.maxMinutes, onchange: (e) => { this.save({ maxMinutes: e.target.checked ? 12 : 0 }); this.renderTab(false); } }), ' Hide mixes / streams (> 12 min)'),
        h('label.dlc-check', {}, h('input', { type: 'checkbox', checked: !!this.hideDone, onchange: (e) => { this.hideDone = e.target.checked; this.renderTab(false); } }), ' Hide downloaded'),
        h('label.dlc-check', {}, h('input', { type: 'checkbox', checked: c.checkOnStart, onchange: (e) => this.save({ checkOnStart: e.target.checked }) }), ' Check at startup'),
        fresh.length ? h('button.dbtn', { onclick: () => this.enqueue(fresh) }, `Download ${fresh.length} new`) : null,
        this.newCount ? h('button.dbtn', { onclick: () => { this.markSeen(); this.renderTab(false); } }, 'Mark all as seen') : null),
      this.checking && !this.feedItems ? h('p.dim', {}, 'Checking followed channels…') : this.list(items, { showSource: true }));
  }

  renderQueue() {
    const jobs = [...this.jobs.values()].reverse();
    this.rows = [];
    this.body.replaceChildren(jobs.length
      ? h('div.dlc-list', {}, jobs.map((j) => {
        const el = this.row(j.item);
        if (j.state === 'done' && j.file) el.querySelector('.dlc-action').append(h('button.dbtn.small', { title: j.file, onclick: () => window.rb.showItem(j.file) }, 'Show file'));
        return el;
      }))
      : h('p.dim', {}, 'No downloads yet.'));
  }
}
