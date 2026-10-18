// Automix: plays a list back to back on decks 1 and 2. The next track is preloaded, synced to
// the outgoing one and started `mixBeats` before the end, then the crossfader fades across
// over the same number of beats.

const PRELOAD_SEC = 45;

export class Automix extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.active = false;
    this.queue = [];
    this.index = 0;
    this.cur = 0;
    this.mixing = null;   // {from, to, start, dur}
    this.preloading = false;
    this.settings = { mixBeats: 16, repeat: false, shuffle: false };
  }

  emit() { this.dispatchEvent(new Event('change')); }
  get decks() { return this.app.engine.decks; }

  /** Start with the given track ids (playlist order), from `startIndex`. */
  async start(ids, startIndex = 0) {
    if (!ids.length) return;
    this.queue = this.settings.shuffle ? shuffle(ids.slice()) : ids.slice();
    this.index = Math.min(startIndex, this.queue.length - 1);
    const engine = this.app.engine;
    this.cur = this.decks[0].playing ? 0 : this.decks[1].playing ? 1 : 0;
    engine.setAssign(0, 'A'); engine.setAssign(1, 'B');
    this.active = true;
    this.mixing = null;
    const d = this.decks[this.cur];
    if (!d.playing) {
      await this.app.loadTrack(this.cur, this.queue[this.index]);
      engine.setMasterDeck(this.cur);
      this.setCrossfader(this.cur === 0 ? -1 : 1);
      d.play();
    }
    this.emit();
  }

  stop() {
    this.active = false;
    this.mixing = null;
    this.emit();
  }

  setCrossfader(x) {
    this.app.engine.setCrossfader(x);
    this.app.mixer.controls.get('crossfader')?.apply((x + 1) / 2);
  }

  nextIndex() {
    const n = this.index + 1;
    if (n < this.queue.length) return n;
    return this.settings.repeat ? 0 : -1;
  }

  /** Where the outgoing track should start mixing out (seconds). */
  mixOutPoint(deck) {
    const out = deck.mixPoint('mixout');
    if (out) return out.start;
    const beatSec = deck.period || 0.5;
    const mixSec = this.settings.mixBeats * beatSec;
    return Math.max(0, deck.duration - mixSec - beatSec);
  }

  tick() {
    if (!this.active) return;
    const from = this.decks[this.cur];
    const otherIdx = 1 - this.cur;
    const to = this.decks[otherIdx];
    if (!from.loaded) return;
    const pos = from.position();
    const next = this.nextIndex();

    if (this.mixing) {
      const t = (performance.now() - this.mixing.start) / 1000;
      const k = Math.min(1, t / this.mixing.dur);
      const a = this.cur === 0 ? -1 : 1;
      this.setCrossfader(a + (-a - a) * k);
      if (k >= 1) {
        from.pause();
        if (from.sync) from.toggleSync();
        this.cur = otherIdx;
        this.index = this.mixing.nextIndex;
        this.mixing = null;
        this.app.engine.setMasterDeck(this.cur);
        this.emit();
      }
      return;
    }

    if (next < 0) {
      if (!from.playing) this.stop();
      return;
    }
    // Preload the next track on the idle deck.
    const remaining = from.duration - pos;
    if (!this.preloading && remaining < PRELOAD_SEC && to.track?.id !== this.queue[next]) {
      this.preloading = true;
      this.app.loadTrack(otherIdx, this.queue[next]).finally(() => { this.preloading = false; });
      return;
    }
    // Start the transition.
    if (to.track?.id === this.queue[next] && to.loaded && !to.playing && pos >= this.mixOutPoint(from)) {
      this.app.engine.setMasterDeck(this.cur);
      const mixIn = to.mixPoint('mixin');
      if (mixIn) to.seek(mixIn.start);
      if (!to.sync) to.toggleSync();
      to.play();
      const dur = this.settings.mixBeats * (60 / (from.currentBpm || 120));
      this.mixing = { start: performance.now(), dur, nextIndex: next };
      this.emit();
    }
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
