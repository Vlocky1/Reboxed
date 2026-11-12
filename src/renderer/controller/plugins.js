// Hardware plugin registry (renderer side). Plugins are folders with a plugin.json manifest, listed
// by the main process (built-in src/plugins + the user's <app folder>/plugins); see docs/PLUGINS.md.
import { parseRekordboxMapping } from '../../shared/controllers/rbcsv.js';

/** Drivers a controller plugin can use. "pioneer": rekordbox function names (any rekordbox mapping). */
export const DRIVERS = ['pioneer', 'rekordbox'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class PluginRegistry {
  constructor(library) {
    this.library = library;
    this.all = [];
  }

  async refresh() {
    this.all = await window.rb.plugins.list().catch(() => []);
    return this.all;
  }

  get disabled() { return this.library.settings.pluginsDisabled ?? []; }

  isEnabled(p) { return !p.error && !this.disabled.includes(p.id); }

  setEnabled(id, on) {
    const rest = this.disabled.filter((x) => x !== id);
    this.library.setSetting('pluginsDisabled', on ? rest : [...rest, id]);
  }

  // ---- mods: optional changes a controller plugin offers (plugin.json "mods"), on / off per plugin ----

  /** The mods a plugin offers. */
  modsOf(p) { return Array.isArray(p?.mods) ? p.mods.filter((m) => m && m.id) : []; }

  /** Ids of the mods turned on for a plugin (a mod marked "default": true is on until turned off). */
  enabledModIds(p) {
    const saved = this.library.settings.pluginMods?.[p?.id];
    return Array.isArray(saved) ? saved : this.modsOf(p).filter((m) => m.default).map((m) => m.id);
  }

  /** The mods turned on for a plugin (their definitions). */
  enabledMods(p) {
    const on = new Set(this.enabledModIds(p));
    return this.modsOf(p).filter((m) => on.has(m.id));
  }

  setModEnabled(p, modId, on) {
    const rest = this.enabledModIds(p).filter((x) => x !== modId);
    this.library.setSetting('pluginMods', { ...(this.library.settings.pluginMods ?? {}), [p.id]: on ? [...rest, modId] : rest });
  }

  /** Problem that keeps a plugin from loading, or null. */
  problem(p) {
    if (p.error) return p.error;
    if (p.kind !== 'controller') return `unknown kind "${p.kind}"`;
    if (!DRIVERS.includes(p.driver ?? 'pioneer')) return `unknown driver "${p.driver}"`;
    if (!Array.isArray(p.match) || !p.match.length) return 'no "match" (MIDI port names)';
    if (!p.mapping) return 'no "mapping" file';
    return null;
  }

  /** Enabled controller plugin for a MIDI port name (the longest matching name wins). */
  forPort(portName) {
    const port = norm(portName);
    let best = null; let bestLen = 0;
    for (const p of this.all) {
      if (!this.isEnabled(p) || this.problem(p)) continue;
      for (const m of p.match) {
        const k = norm(m);
        if (k && port.includes(k) && k.length > bestLen) { best = p; bestLen = k.length; }
      }
    }
    return best;
  }

  /** The plugin's mapping: Reboxed JSON or a raw rekordbox .midi.csv. */
  async mapping(p) {
    const text = await window.rb.plugins.read(p.id, p.mapping);
    return /\.csv$/i.test(p.mapping) ? parseRekordboxMapping(text) : JSON.parse(text);
  }
}
