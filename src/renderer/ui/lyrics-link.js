// The decks' side of the lyrics window (renderer/lyrics.html, its own OS window). Both pages are
// app://rb, so they talk over a BroadcastChannel: this window sends the decks' play heads (20 times a
// second while the lyrics window is open) and serves each track's lyrics (stored in the library,
// fetched once from a ".lrc" file next to the music or from LRCLIB); the lyrics window sends back
// play / seek commands for manual syncing and the lyrics the DJ edited.
import { crossfaderGains, faderGain } from '../audio/engine.js';
import { LYRICS_CHANNEL } from '../../shared/lrc.js';
const RECHECK_MISSING_DAYS = 7;
const now = () => performance.timeOrigin + performance.now();   // the same clock in both windows

export class LyricsLink {
  /** @param {object} app Reboxed app (engine, library, deckCount) */
  constructor(app) {
    this.app = app;
    this.ch = new BroadcastChannel(LYRICS_CHANNEL);
    this.ch.onmessage = (e) => this.onMessage(e.data ?? {});
    this.aliveAt = 0;
    this.loading = new Map();                                    // trackId → promise
    this.timer = setInterval(() => this.tick(), 50);
    // a track changed (edited elsewhere, lyrics saved): the lyrics window reloads it
    app.library.addEventListener('change', (e) => { const { kind, id } = e.detail ?? {}; if (kind === 'track' && id && this.open) this.post({ type: 'changed', trackId: id }); });
  }

  get open() { return now() - this.aliveAt < 3000; }

  openWindow() { return window.rb.lyrics.open(); }

  post(msg) { try { this.ch.postMessage(msg); } catch { /* window gone */ } }

  /** Each deck's play head, and which deck is "on air" (playing, the loudest through fader + crossfader). */
  state() {
    const eng = this.app.engine;
    const [a, b] = crossfaderGains(eng.crossfader ?? 0, eng.crossfaderCurve);
    const decks = eng.decks.slice(0, this.app.deckCount).map((d, i) => {
      const ch = eng.channels[i]?.state ?? {};
      const xf = ch.assign === 'A' ? a : ch.assign === 'B' ? b : 1;
      const t = d.track;
      return {
        index: i, loaded: !!d.loaded, trackId: t?.id ?? null, title: t?.title ?? '', artist: t?.artist ?? '',
        duration: d.duration || 0, position: d.loaded ? d.position() : 0, playing: !!d.playing && !d.scratching,
        speed: d.loaded ? d.rate * (d.bend ?? 1) * (d.reverse ? -1 : 1) : 1,
        level: (d.playing ? 1 : 0) * faderGain(ch.fader ?? 1) * xf,
      };
    });
    const playing = decks.filter((d) => d.loaded && d.playing).sort((x, y) => y.level - x.level);
    const master = eng.masterDeck ? eng.decks.indexOf(eng.masterDeck) : -1;
    const onAir = playing[0]?.index ?? (master >= 0 ? master : decks.find((d) => d.loaded)?.index ?? 0);
    return { type: 'state', at: now(), decks, onAir };
  }

  tick() { if (this.open) this.post(this.state()); }

  async onMessage(m) {
    switch (m.type) {
      case 'hello': case 'alive': this.aliveAt = now(); if (m.type === 'hello') this.post(this.state()); break;
      case 'get': this.sendLyrics(m.trackId, { force: !!m.force }); break;
      case 'save': this.save(m.trackId, m.lyrics); break;
      case 'search': {
        try { this.post({ type: 'results', id: m.id, results: await window.rb.lyrics.list(m.q) }); } catch (err) { this.post({ type: 'results', id: m.id, error: err.message, results: [] }); }
        break;
      }
      case 'seek': { const d = this.deck(m.deck); if (d?.loaded) d.seek(Math.max(0, Math.min(d.duration, Number(m.t) || 0))); break; }
      case 'nudge': { const d = this.deck(m.deck); if (d?.loaded) d.seek(Math.max(0, Math.min(d.duration, d.position() + (Number(m.by) || 0)))); break; }
      case 'play': { const d = this.deck(m.deck); if (d?.loaded) { if (d.playing) d.pause(); else d.play(); } break; }
      default: break;
    }
  }

  deck(i) { return Number.isInteger(i) ? this.app.engine.decks[i] : null; }

  /** The stored lyrics of a track; fetched once (".lrc" file, then LRCLIB) when it has none. */
  async lyricsOf(trackId, { force = false } = {}) {
    const lib = this.app.library;
    const t = lib.get(trackId);
    if (!t) return null;
    const have = t.lyrics;
    const fresh = have && (have.lrc || have.plain || have.edited || (have.none && Date.now() - Date.parse(have.checked ?? 0) < RECHECK_MISSING_DAYS * 864e5));
    if (fresh && !force) return have;
    if (this.loading.has(trackId)) return this.loading.get(trackId);
    const job = (async () => {
      const checked = new Date().toISOString();
      let out = null;
      const side = force ? null : await window.rb.lyrics.sidecar(t.path).catch(() => null);
      if (side) out = { v: 1, source: 'file', lrc: /\[\d{1,3}:\d{1,2}/.test(side) ? side : null, plain: /\[\d{1,3}:\d{1,2}/.test(side) ? null : side, offset: 0, checked };
      else {
        const found = await window.rb.lyrics.find({ title: t.title, artist: t.artist, duration: t.duration });
        out = found
          ? { v: 1, source: found.source, lrc: found.synced, plain: found.plain, instrumental: found.instrumental, offset: have?.offset ?? 0, checked,
            match: { artist: found.artist, title: found.title, album: found.album, duration: found.duration, id: found.id } }
          : { v: 1, none: true, checked };
      }
      lib.update(trackId, { lyrics: out }, { silent: true });
      return out;
    })().finally(() => this.loading.delete(trackId));
    this.loading.set(trackId, job);
    return job;
  }

  async sendLyrics(trackId, opts) {
    if (!trackId) return;
    this.post({ type: 'lyrics', trackId, status: 'loading' });
    try {
      const lyrics = await this.lyricsOf(trackId, opts);
      this.post({ type: 'lyrics', trackId, status: lyrics && !lyrics.none ? 'ready' : 'none', lyrics });
    } catch (err) {
      this.post({ type: 'lyrics', trackId, status: 'error', error: err.message });
    }
  }

  /** Lyrics edited / synced by hand in the lyrics window (kept: never replaced by a new search). */
  save(trackId, lyrics) {
    if (!this.app.library.get(trackId) || !lyrics || typeof lyrics !== 'object') return;
    const clean = {
      v: 1, source: String(lyrics.source ?? 'manual').slice(0, 40), lrc: typeof lyrics.lrc === 'string' ? lyrics.lrc.slice(0, 200000) : null,
      plain: typeof lyrics.plain === 'string' ? lyrics.plain.slice(0, 200000) : null, offset: Number(lyrics.offset) || 0,
      edited: !!lyrics.edited, checked: new Date().toISOString(), match: lyrics.match ?? null,
    };
    this.app.library.update(trackId, { lyrics: clean }, { silent: true });
    this.post({ type: 'lyrics', trackId, status: clean.lrc || clean.plain ? 'ready' : 'none', lyrics: clean });
  }
}
