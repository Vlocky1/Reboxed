// Interface choices remembered between sessions: everything starts from the defaults, and as soon
// as the user changes something (a pad page, the sort of a list, the waveform zoom…) it is kept
// for the next launch. Preferences > General can turn it off, or forget everything.
// Stored in settings.ui (one key per choice), saved quietly: no settings event, the library file
// is written with the next save.

export class UiMemory {
  /** @param {import('./library.js').Library} library */
  constructor(library) {
    this.library = library;
  }

  /** Remembering is on unless the user turned it off. */
  get on() { return this.library.settings.rememberUi !== false; }

  /** A remembered choice, or the fallback (also when remembering is off). */
  get(key, fallback = undefined) {
    if (!this.on) return fallback;
    const v = this.library.settings.ui?.[key];
    return v === undefined ? fallback : v;
  }

  /** Keep a choice (nothing when remembering is off, or when it did not change). */
  set(key, value) {
    if (!this.on) return;
    const ui = this.library.settings.ui ?? {};
    if (JSON.stringify(ui[key]) === JSON.stringify(value)) return;
    this.library.settings = { ...this.library.settings, ui: { ...ui, [key]: value } };
    this.library.scheduleSave();
  }

  /** Forget a choice (back to its default next time). */
  delete(key) {
    const ui = { ...(this.library.settings.ui ?? {}) };
    if (!(key in ui)) return;
    delete ui[key];
    this.library.settings = { ...this.library.settings, ui };
    this.library.scheduleSave();
  }

  /** Forget everything: the next launch starts from the defaults. */
  clear() {
    this.library.settings = { ...this.library.settings, ui: {} };
    this.library.scheduleSave();
  }

  /** How many choices are remembered. */
  get count() { return Object.keys(this.library.settings.ui ?? {}).length; }
}
