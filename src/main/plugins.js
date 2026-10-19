// Hardware plugins: one folder per plugin with a plugin.json manifest (see docs/PLUGINS.md).
// Built-in plugins live in src/plugins (read only); the user's in <app folder>/plugins. A user plugin
// with the id of a built-in one replaces it (to fix or extend a mapping without rebuilding Reboxed).
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { parseRekordboxMapping } from '../shared/controllers/rbcsv.js';

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class PluginStore {
  constructor(builtinDir, userDir) {
    this.builtinDir = builtinDir;
    this.userDir = userDir;
  }

  async scan(dir, builtin) {
    let names = [];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of names) {
      if (!e.isDirectory()) continue;
      const folder = join(dir, e.name);
      try {
        const m = JSON.parse(await readFile(join(folder, 'plugin.json'), 'utf8'));
        if (!ID.test(m.id ?? '')) throw new Error('invalid id');
        out.push({ ...m, builtin, folder });
      } catch (err) {
        out.push({ id: e.name, name: e.name, builtin, folder, error: `plugin.json: ${err.message}` });
      }
    }
    return out;
  }

  /** All plugins; a user plugin hides the built-in one with the same id. */
  async list() {
    const user = await this.scan(this.userDir, false);
    const ids = new Set(user.map((p) => p.id));
    const builtin = (await this.scan(this.builtinDir, true)).map((p) => ({ ...p, overridden: ids.has(p.id) }));
    return [...builtin.filter((p) => !p.overridden), ...user.map((p) => ({ ...p, overrides: builtin.some((b) => b.id === p.id) }))];
  }

  async folderOf(id) {
    const p = (await this.list()).find((x) => x.id === id);
    if (!p) throw new Error(`no plugin ${id}`);
    return p.folder;
  }

  /** A file of a plugin (text), confined to its folder. */
  async read(id, file) {
    const folder = await this.folderOf(id);
    const path = normalize(join(folder, file));
    if (!path.startsWith(folder + sep)) throw new Error('outside the plugin folder');
    return readFile(path, 'utf8');
  }

  /** Path of a plugin file for the plugin:// protocol (null if outside). */
  async resolve(id, file) {
    const folder = await this.folderOf(id).catch(() => null);
    if (!folder) return null;
    const path = normalize(join(folder, file));
    return path.startsWith(folder + sep) ? path : null;
  }

  /** Copy a plugin folder (with its plugin.json) into the user plugins. */
  async install(src) {
    const m = JSON.parse(await readFile(join(src, 'plugin.json'), 'utf8'));
    if (!ID.test(m.id ?? '')) throw new Error('plugin.json needs an "id" made of lower-case letters, digits, "-", "_" or "."');
    if (m.kind !== 'controller') throw new Error('only "controller" plugins are supported for now');
    const dest = join(this.userDir, m.id);
    await rm(dest, { recursive: true, force: true });
    await mkdir(this.userDir, { recursive: true });
    await cp(src, dest, { recursive: true });
    return m;
  }

  async remove(id) {
    const user = await this.scan(this.userDir, false);
    const p = user.find((x) => x.id === id);
    if (!p) throw new Error('only plugins you installed can be removed');
    await rm(p.folder, { recursive: true, force: true });
  }

  /** New plugin from a rekordbox controller mapping (.midi.csv). */
  async createFromCsv(csvPath, { id, name, match, decks = 2 } = {}) {
    const mapping = parseRekordboxMapping(await readFile(csvPath, 'utf8'));
    const pid = id || `custom-${(mapping.device || 'controller').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (!ID.test(pid)) throw new Error('invalid plugin id');
    const manifest = {
      id: pid, name: name || mapping.device || pid, version: '1.0.0', author: 'me', kind: 'controller',
      description: `Made from ${csvPath.split(/[\\/]/).pop()} (${mapping.entries.length} entries).`,
      match: [match || mapping.device], driver: 'pioneer', mapping: 'mapping.json', decks,
    };
    const dir = join(this.userDir, pid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dir, 'mapping.json'), JSON.stringify(mapping));
    return manifest;
  }
}
