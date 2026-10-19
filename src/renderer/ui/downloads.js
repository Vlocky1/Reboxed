// Download centre: ask for a track (one proposal at a time, official sources first, yes / no),
// search YouTube, paste links, follow channels for new releases, and download the audio with
// yt-dlp (the engine Stacher uses). Finished files join the collection, get analysed and land in
// a "Downloads" playlist. Quality and folder live in Preferences > Downloads.
import { h, toast, fmtTime } from './dom.js';
import { icon } from './icons.js';
import { DEFAULT_SETTINGS } from '../library.js';
import { rankCandidates } from '../../shared/track-request.js';

const FORMAT_NAMES = { m4a: 'M4A', mp3: 'MP3 320', flac: 'FLAC', wav: 'WAV' };
const OFFICIAL = { topic: 'Official audio — artist "Topic" channel', artist: "Official — artist's channel", vevo: 'Official — VEVO' };
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

  isDone(id) { return !!this.cfg.done[id]; }

  /** Queue items (from search, links or feeds). */
  async enqueue(items) {
    const folder = await this.folder();
    for (const item of items) {
      const key = item.id;
      if (this.jobs.has(key) && ACTIVE.has(this.jobs.get(key).state)) continue;
      this.jobs.set(key, { item, state: 'queued', pct: 0 });
      window.rb.dl.download({ key, url: item.url }, { folder, format: this.cfg.format })
        .then((file) => this.finished(item, file))
        .catch(() => { /* state already reported through progress */ });
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

  /** Add the file to the collection (and the Downloads playlist), remember it was downloaded. */
  async finished(item, file) {
    if (!file) return;
    const lib = this.app.library;
    await this.app.importPaths([file]);
    const id = lib.idForPath(file);
    if (id && this.cfg.playlist) {
      let pl = lib.playlists.find((n) => n.src === 'downloads');
      if (!pl) { pl = lib.createNode('playlist', 'Downloads'); pl.src = 'downloads'; }
      if (!pl.trackIds.includes(id)) lib.addToPlaylist(pl.id, [id]);
    }
    this.save({ done: { ...this.cfg.done, [item.id]: file } });
    toast(`Downloaded: ${item.title}`);
    this.changed();
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

  open(tab = 'request') {
    if (this.overlay) { this.showTab(tab); return; }
    const tabs = [['request', 'Ask for a track'], ['search', 'Search'], ['link', 'Link'], ['feeds', 'New releases'], ['queue', 'Queue']];
    this.tabBtns = new Map(tabs.map(([id, label]) => [id, h('button.seg-btn', { onclick: () => this.showTab(id) }, label)]));
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
        h('div.dlc-tabs.seg', {}, [...this.tabBtns.values()]),
        this.toolsLine, this.body, footer,
        h('p.dlc-legal', {}, 'Only download music you have the right to use (free downloads, your own or licensed releases). ',
          'Uses yt-dlp, ffmpeg and deno from Stacher (~/.stacher) or your PATH.')));
    this.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    document.body.append(this.overlay);
    this.rerender = (full) => this.renderTab(!full);
    this.listeners.add(this.rerender);
    this.tools().then((t) => {
      this.toolsLine.replaceChildren(t.ytdlp
        ? h('span.dim', {}, `yt-dlp ${t.version ?? ''} · ffmpeg ${t.ffmpeg ? '✓' : '✗ (needed for MP3/FLAC/WAV and covers)'} · deno ${t.deno ? '✓' : '✗ (YouTube may refuse some videos)'}`)
        : h('span.rbi-error', {}, 'yt-dlp not found. Install Stacher (it brings yt-dlp, ffmpeg and deno) or choose the folder that holds yt-dlp: ',
          h('button.dbtn.small', { onclick: async () => { const [d] = await window.rb.openFolder(); if (d) { this.save({ toolsDir: d }); close(); this.open(tab); } } }, 'Choose folder…')));
    });
    this.showTab(tab);
  }

  showTab(id) {
    this.tab = id;
    this.tabBtns.forEach((b, k) => b.classList.toggle('on', k === id));
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
    if (this.tab === 'request') this.renderRequest();
    else if (this.tab === 'search') this.renderSearch();
    else if (this.tab === 'link') this.renderLink();
    else if (this.tab === 'feeds') this.renderFeeds();
    else this.renderQueue();
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
      } else {
        const get = h('button.dbtn.small.dlc-get', { onclick: () => this.enqueue([item]) }, icon('download'), ' Download');
        action.replaceChildren(...(job?.state === 'error' ? [h('span.rbi-error', { title: job.error }, 'Failed '), get] : [get]));
      }
    };
    update();
    this.rows.push(update);
    const follow = item.channelUrl
      ? h('button.dlc-follow', { title: `Follow ${item.channel}: its new uploads show in New releases`, onclick: () => this.follow(item.channelUrl, item.channel) }, '+ follow')
      : null;
    return h('div.dlc-row', {},
      item.thumb ? h('img.dlc-thumb', { src: item.thumb, loading: 'lazy', alt: '' }) : h('div.dlc-thumb'),
      h('div.dlc-info', {},
        h('div.dlc-title', { title: item.title }, item.isNew ? h('span.dlc-new', {}, 'NEW') : null, item.title),
        h('div.dlc-sub', {}, item.channel, follow, showSource && item.source && item.source !== item.channel ? ` · ${item.source}` : '',
          item.timestamp ? ` · ${ago(item.timestamp)}` : '', item.views ? ` · ${item.views.toLocaleString()} views` : '')),
      h('div.dlc-dur', {}, item.duration ? fmtTime(item.duration) : ''),
      action);
  }

  list(items, opts) {
    this.rows = [];
    return h('div.dlc-list', {}, items.length ? items.map((it) => this.row(it, opts)) : h('p.dim', {}, 'Nothing here.'));
  }

  // ---- ask for a track ---------------------------------------------------------------------------

  renderRequest() {
    const r = this.req ??= { text: '', queue: [], query: null, list: null, k: 0, loading: false, error: '', accepted: [] };
    const input = h('textarea.text.dlc-ask', { placeholder: 'Artist - Title   (one per line to ask for several tracks)', rows: 2, spellcheck: false });
    input.value = r.text;
    input.addEventListener('input', () => { r.text = input.value; });
    const go = () => { r.queue = input.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); this.nextRequest(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    let card;
    if (r.loading) card = h('p.dim.dlc-card', {}, `Looking for “${r.query}” on YouTube…`);
    else if (r.error) card = h('p.rbi-error.dlc-card', {}, r.error);
    else if (r.list && r.k < r.list.length) card = this.proposal(r);
    else if (r.list) {
      card = h('div.dlc-card', {}, h('p', {}, `No other video found for “${r.query}”. Try other words (add the label, "original mix", "extended"…).`),
        r.queue.length ? h('button.dbtn', { onclick: () => this.nextRequest() }, `Next track (${r.queue.length} left)`) : null);
    } else {
      card = h('p.dim.dlc-card', {}, 'Type a track as "Artist - Title". Reboxed searches YouTube and proposes one video at a time, official sources first ',
        '(the artist\'s "Topic" channel = official audio, then the artist\'s own channel). Answer Yes to download it, No to see the next proposal.');
    }
    this.rows = [];
    const history = r.accepted.length
      ? h('div', {}, h('h4.dlc-h4', {}, 'Accepted'), h('div.dlc-list', {}, [...r.accepted].reverse().map((it) => this.row(it))))
      : null;
    this.body.replaceChildren(...[h('div.dlc-bar', {}, input, h('button.dbtn.dlc-primary', { onclick: go }, icon('search'), ' Find')), card, history].filter(Boolean));
    if (!r.list && !r.loading) setTimeout(() => input.isConnected && input.focus());
  }

  /** Next line of the request list: search, rank, show the first proposal. */
  async nextRequest() {
    const r = this.req;
    const q = r.queue.shift();
    if (!q) { r.list = null; r.query = null; r.error = ''; this.renderTab(false); return; }
    Object.assign(r, { query: q, loading: true, error: '', list: null, k: 0 });
    this.renderTab(false);
    try {
      r.list = rankCandidates(await window.rb.dl.search(q, 12), q);
      if (r.queue.length === 0) r.text = '';
    } catch (err) { r.error = err.message; }
    r.loading = false;
    this.renderTab(false);
  }

  /** One proposal with Yes / No (keys Y / N). */
  proposal(r) {
    const it = r.list[r.k];
    const yes = () => { if (!r.accepted.some((x) => x.id === it.id)) r.accepted.push(it); this.enqueue([it]); this.nextRequest(); };
    const no = () => { r.k++; this.renderTab(false); };
    const meta = [it.duration ? fmtTime(it.duration) : '', it.views ? `${it.views.toLocaleString()} views` : '', ago(it.timestamp)].filter(Boolean).join(' · ');
    const card = h('div.dlc-proposal.dlc-card', {
      tabIndex: 0,
      onkeydown: (e) => { const k = e.key.toLowerCase(); if (k === 'y' || k === 'o') { e.preventDefault(); yes(); } else if (k === 'n') { e.preventDefault(); no(); } },
    },
    it.thumb ? h('img.dlc-big', { src: it.thumb, alt: '' }) : h('div.dlc-big'),
    h('div.dlc-pinfo', {},
      h('div.dim', {}, `“${r.query}” — proposal ${r.k + 1} of ${r.list.length}${r.queue.length ? ` · ${r.queue.length} more track(s) to find` : ''}`),
      h('div.dlc-ptitle', {}, it.title),
      h('div.dlc-sub', {}, it.channel, it.verified ? ' ✓' : ''),
      it.official ? h('div.dlc-official', {}, OFFICIAL[it.official]) : h('div.dlc-unofficial', {}, 'Not from an official channel'),
      h('div.dlc-sub', {}, meta),
      this.isDone(it.id) ? h('div.dlc-done', {}, '✓ Already downloaded') : null,
      h('p.dlc-q', {}, 'Is this the track you want?'),
      h('div.dlc-yn', {},
        h('button.dbtn.dlc-yes', { onclick: yes, title: 'Y' }, '✓ Yes, download'),
        h('button.dbtn.dlc-no', { onclick: no, title: 'N' }, '✕ No, next'),
        h('button.dbtn.small', { onclick: () => window.rb.openExternal(it.url) }, 'Watch on YouTube'),
        h('button.dbtn.small', { onclick: () => this.nextRequest() }, r.queue.length ? 'Skip this track' : 'Stop'))));
    setTimeout(() => card.isConnected && card.focus());
    return card;
  }

  renderSearch() {
    const input = h('input.text', { placeholder: 'Artist, title, label… (YouTube)', value: this.query ?? '', spellcheck: false });
    const results = h('div', {}, this.searchResults ? this.list(this.searchResults) : h('p.dim', {}, 'Search YouTube, then download the audio straight into your collection.'));
    const go = async () => {
      const q = input.value.trim();
      if (!q) return;
      this.query = q;
      results.replaceChildren(h('p.dim', {}, 'Searching…'));
      try { this.searchResults = await window.rb.dl.search(q, 20); results.replaceChildren(this.list(this.searchResults)); } catch (err) { results.replaceChildren(h('p.rbi-error', {}, err.message)); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const el = h('div', {}, h('div.dlc-bar', {}, input, h('button.dbtn.dlc-primary', { onclick: go }, icon('search'), ' Search')), results);
    this.body.replaceChildren(el);
    setTimeout(() => input.focus());
  }

  renderLink() {
    const input = h('input.text', { placeholder: 'YouTube / SoundCloud link (video or playlist)', value: this.link ?? '', spellcheck: false });
    const results = h('div', {}, this.linkResults ? this.list(this.linkResults) : null);
    const go = async () => {
      const url = input.value.trim();
      if (!url) return;
      this.link = url;
      results.replaceChildren(h('p.dim', {}, 'Reading the link…'));
      try {
        this.linkResults = await window.rb.dl.resolve(url);
        results.replaceChildren(...[
          this.linkResults.length > 1 ? h('button.dbtn.dlc-primary', { onclick: () => this.enqueue(this.linkResults.filter((it) => !this.isDone(it.id))) }, `Download all ${this.linkResults.length}`) : null,
          this.list(this.linkResults)].filter(Boolean));
      } catch (err) { results.replaceChildren(h('p.rbi-error', {}, err.message)); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const el = h('div', {}, h('div.dlc-bar', {}, input, h('button.dbtn.dlc-primary', { onclick: go }, 'Get')), results);
    this.body.replaceChildren(el);
    setTimeout(() => input.focus());
  }

  renderFeeds() {
    const c = this.cfg;
    const add = h('input.text', { placeholder: 'Follow a channel or playlist: paste its link (e.g. youtube.com/@label)', spellcheck: false });
    const doAdd = () => { const u = add.value.trim(); if (u) { this.follow(u, u.replace(/^https?:\/\/(www\.)?youtube\.com\//, '')); this.feedItems = null; this.checkFeeds(); } };
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    const fits = (it) => !c.maxMinutes || !it.duration || it.duration <= c.maxMinutes * 60;
    const items = (this.feedItems ?? []).filter((it) => fits(it) && !(this.hideDone && this.isDone(it.id)));
    const fresh = items.filter((it) => it.isNew && !this.isDone(it.id));
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
