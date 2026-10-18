// Track downloader: drives yt-dlp (the engine Stacher uses) to search YouTube, read channel /
// playlist feeds for new releases and download audio with ffmpeg. Tools are found in the
// Stacher folder (~/.stacher: yt-dlp, ffmpeg, deno for YouTube's JS challenges), a custom folder
// or the PATH. Nothing is bundled.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Audio formats: yt-dlp arguments. m4a keeps YouTube's AAC stream as is (no re-encode). */
export const FORMATS = {
  m4a: ['-f', 'bestaudio[ext=m4a]/bestaudio', '--extract-audio', '--audio-format', 'm4a', '--embed-thumbnail', '--convert-thumbnails', 'jpg'],
  mp3: ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '320K', '--embed-thumbnail', '--convert-thumbnails', 'jpg'],
  flac: ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'flac', '--embed-thumbnail', '--convert-thumbnails', 'jpg'],
  wav: ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'wav'],
};

/** "Artist - Title (Official Video)" -> artist / title tags, without the video decorations. */
export const METADATA = [
  '--embed-metadata',
  '--parse-metadata', 'title:(?P<meta_artist>.+?) - (?P<meta_title>.+)',
  '--replace-in-metadata', 'meta_title,title',
  '(?i)\\s*[\\(\\[][^\\)\\]]*(official|lyrics?|audio|video|visuali[sz]er|clip|hd|4k)[^\\)\\]]*[\\)\\]]', '',
  '--replace-in-metadata', 'meta_title,title', '(?i)\\s*\\|\\s*(lyrics?|official|audio|video|visuali[sz]er).*$', '',
];

const PROGRESS = 'download:[rb] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s';

/** yt-dlp entry -> what the UI shows. */
export function toItem(e) {
  if (!e?.id) return null;
  const thumbs = e.thumbnails ?? [];
  const date = e.upload_date ? Date.UTC(+e.upload_date.slice(0, 4), +e.upload_date.slice(4, 6) - 1, +e.upload_date.slice(6, 8)) / 1000 : null;
  return {
    id: e.id,
    url: e.webpage_url || (e.ie_key === 'Youtube' || /^[\w-]{11}$/.test(e.id) ? `https://www.youtube.com/watch?v=${e.id}` : e.url),
    title: e.title ?? e.id,
    channel: e.channel ?? e.uploader ?? '',
    channelUrl: e.channel_url ?? e.uploader_url ?? '',
    duration: e.duration ?? 0,
    timestamp: e.timestamp ?? e.release_timestamp ?? date,
    views: e.view_count ?? null,
    thumb: thumbs.length ? thumbs[thumbs.length - 1].url : (e.thumbnail ?? ''),
  };
}

/** A channel link without a tab lists its uploads (/videos). */
export function feedUrl(url) {
  const u = String(url).trim();
  if (/youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)\/?$/i.test(u)) return `${u.replace(/\/$/, '')}/videos`;
  return u;
}

export class Downloader {
  /** @param {(channel: string, ...args) => void} send */
  constructor(send) {
    this.send = send;
    this.customDir = '';
    this.queue = [];
    this.running = new Map(); // key -> child process
    this.max = 2;
  }

  async find(name) {
    const dirs = [this.customDir, join(homedir(), '.stacher'), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
    for (const d of dirs) {
      const p = join(d, name + EXE);
      try { await access(p); return p; } catch { /* next */ }
    }
    return null;
  }

  /** {ytdlp, ffmpeg, deno, version} — null fields when missing. */
  async tools() {
    const [ytdlp, ffmpeg, deno] = await Promise.all([this.find('yt-dlp'), this.find('ffmpeg'), this.find('deno')]);
    let version = null;
    if (ytdlp) version = (await this.exec(ytdlp, ['--version']).catch(() => ({ out: '' }))).out.trim() || null;
    return { ytdlp, ffmpeg, deno, version };
  }

  async base() {
    const t = await this.tools();
    if (!t.ytdlp) throw new Error('yt-dlp not found (install Stacher, or set its folder in the download settings)');
    // IPv4: on this kind of network IPv6 attempts time out first (search: 163 s -> 4 s).
    const args = ['--force-ipv4', '--no-warnings', '--no-colors'];
    if (t.deno) args.push('--js-runtimes', `deno:${t.deno}`);
    if (t.ffmpeg) args.push('--ffmpeg-location', dirname(t.ffmpeg));
    return { exe: t.ytdlp, args };
  }

  exec(exe, args, onLine) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true });
      let out = ''; let err = ''; let buf = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        out += d;
        if (!onLine) return;
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(onLine);
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (buf && onLine) onLine(buf);
        resolve({ code, out, err });
      });
    });
  }

  async json(target, extra = []) {
    const { exe, args } = await this.base();
    const r = await this.exec(exe, [target, '--flat-playlist', '-J', ...args, ...extra]);
    if (r.code !== 0) throw new Error(lastError(r.err) || `yt-dlp exited with ${r.code}`);
    return JSON.parse(r.out);
  }

  /** YouTube search. */
  async search(query, count = 20) {
    const d = await this.json(`ytsearch${count}:${query}`);
    return (d.entries ?? []).map(toItem).filter(Boolean);
  }

  /** Latest uploads of a channel / playlist (approximate dates are enough to spot new ones). */
  async feed(url, count = 15) {
    const d = await this.json(feedUrl(url), ['--playlist-end', String(count), '--extractor-args', 'youtubetab:approximate_date']);
    const entries = (d.entries ?? []).flatMap((e) => (e._type === 'playlist' ? e.entries ?? [] : [e]));
    return { name: (d.channel ?? d.uploader ?? d.title ?? url).replace(/ - (Videos|Home)$/, ''), url: feedUrl(url), items: entries.map(toItem).filter(Boolean) };
  }

  /** A pasted link: one video, or every entry of a playlist. */
  async resolve(url) {
    const d = await this.json(url.trim(), ['--playlist-end', '200']);
    if (d._type === 'playlist') return (d.entries ?? []).map(toItem).filter(Boolean);
    return [toItem(d)].filter(Boolean);
  }

  /**
   * Queue a download. Progress: 'dl:progress' (key, {state, pct, speed, eta, file, error}).
   * @param {{key: string, url: string}} item
   * @param {{folder: string, format: keyof FORMATS}} opts
   */
  download(item, opts) {
    return new Promise((resolve, reject) => {
      this.queue.push({ item, opts, resolve, reject });
      this.send('dl:progress', item.key, { state: 'queued', pct: 0 });
      this.pump();
    });
  }

  cancel(key) {
    const i = this.queue.findIndex((j) => j.item.key === key);
    if (i >= 0) {
      const [job] = this.queue.splice(i, 1);
      job.reject(new Error('cancelled'));
      this.send('dl:progress', key, { state: 'cancelled' });
    }
    this.running.get(key)?.kill();
  }

  async pump() {
    while (this.running.size < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.running.set(job.item.key, null);
      this.run(job).then(job.resolve, job.reject).finally(() => { this.running.delete(job.item.key); this.pump(); });
    }
  }

  async run({ item, opts }) {
    const key = item.key;
    const progress = (p) => this.send('dl:progress', key, p);
    try {
      const { exe, args } = await this.base();
      const out = join(opts.folder, '%(meta_artist,artist,uploader)s - %(meta_title,title)s.%(ext)s');
      let file = null;
      const onLine = (line) => {
        if (line.startsWith('[rb] ')) {
          const [pct, speed, eta] = line.slice(5).split('|').map((s) => s.trim());
          const p = parseFloat(pct);
          progress({ state: p >= 100 ? 'converting' : 'downloading', pct: Number.isFinite(p) ? p : 0, speed, eta });
        } else if (line.startsWith('[rbfile] ')) file = line.slice(9).trim();
      };
      progress({ state: 'starting', pct: 0 });
      const child = spawn(exe, [
        item.url, '--no-playlist', '--windows-filenames', '--no-mtime',
        ...(FORMATS[opts.format] ?? FORMATS.m4a), ...METADATA, ...args,
        '-o', out, '--newline', '--progress', '--progress-template', PROGRESS,
        '--print', 'after_move:[rbfile] %(filepath)s',
      ], { windowsHide: true });
      this.running.set(key, child);
      const result = await new Promise((res, rej) => {
        let err = ''; let buf = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', rej);
        child.on('close', (code, signal) => { if (buf) onLine(buf); res({ code, signal, err }); });
      });
      if (result.signal || (result.code !== 0 && !file)) {
        const error = result.signal ? 'cancelled' : (lastError(result.err) || `yt-dlp exited with ${result.code}`);
        progress({ state: result.signal ? 'cancelled' : 'error', error });
        throw new Error(error);
      }
      progress({ state: 'done', pct: 100, file });
      return file;
    } catch (err) {
      if (!/cancelled|exited/.test(err.message)) progress({ state: 'error', error: err.message });
      throw err;
    }
  }
}

function lastError(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => /ERROR/.test(l));
  return (lines.pop() ?? '').replace(/^ERROR:\s*/, '').slice(0, 300);
}
