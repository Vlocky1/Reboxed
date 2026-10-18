// Search-box behaviour, modelled on Rekordbox's browse::SearchFilter + PlaylistSearchTimer
// (handler @ 0x1414b8c30, timer @ 0x142162140): 500 ms debounce while typing, immediate on
// Enter / Esc / clear / field change, and no re-run when tokens and field are unchanged.

import { tokenize } from './engine.js';

export const TYPING_DELAY_MS = 500;

export class SearchController {
  /**
   * @param {object} opts
   * @param {(query: {text: string, tokens: string[], field: string}) => void} opts.onSearch
   * @param {number} [opts.delayMs=500]
   * @param {string} [opts.field='all']
   */
  constructor({ onSearch, delayMs = TYPING_DELAY_MS, field = 'all' }) {
    this.onSearch = onSearch;
    this.delayMs = delayMs;
    this.field = field;
    this.text = '';
    /** @type {string|null} */
    this.lastKey = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null;
  }

  /** Call on every edit of the search box. */
  textChanged(text) {
    this.text = text;
    this.schedule(text.length > 0 ? this.delayMs : 0);
  }

  /** Enter: search now. */
  submit() {
    this.schedule(0);
  }

  /** Esc: clear and search now. */
  clear() {
    this.text = '';
    this.schedule(0);
  }

  /** Field-selector change: search now. */
  setField(field) {
    this.field = field;
    this.schedule(0);
  }

  dispose() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** @param {number} delay */
  schedule(delay) {
    this.dispose();
    if (delay === 0) this.run();
    else this.timer = setTimeout(() => { this.timer = null; this.run(); }, delay);
  }

  run() {
    const tokens = tokenize(this.text);
    const key = JSON.stringify([this.field, tokens]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.onSearch({ text: this.text, tokens, field: this.field });
  }
}
