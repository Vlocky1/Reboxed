// Where Reboxed keeps its data.
//   app folder (%APPDATA%/Reboxed): location.json, stem models, Chromium caches. Machine-local.
//   database folder (default: the app folder; can be a removable drive): library.json, analysis/,
//     artwork/, groove/ and, by default, stems/.
// location.json: {database: dir|null, stemsMode: 'database'|'custom'|'beside', stemsDir: dir|null}.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders and files of a database folder (what "move the library" copies). */
export const DATABASE_ENTRIES = ['library.json', 'analysis', 'artwork', 'groove'];

/**
 * Earlier versions lived in %APPDATA%/rbclone. Move it to %APPDATA%/Reboxed once, before Electron
 * creates the new folder (call before app.setPath / app ready).
 */
export function migrateLegacyAppDir(appData) {
  const from = join(appData, 'rbclone');
  const to = join(appData, 'Reboxed');
  if (!existsSync(from) || existsSync(join(to, 'library.json'))) return false;
  try {
    if (!existsSync(to)) { renameSync(from, to); return true; }
    // The new folder exists (caches only): move the old entries in one by one.
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (!existsSync(join(to, name))) renameSync(join(from, name), join(to, name));
    }
    return true;
  } catch (err) {
    console.warn('could not move the old rbclone folder', err);
    return false;
  }
}

export class Storage {
  /** @param {string} appDir */
  constructor(appDir) {
    this.appDir = appDir;
    this.file = join(appDir, 'location.json');
    // fullscreen: open the window in full screen (read before the window exists, so kept here).
    this.cfg = { database: null, stemsMode: 'database', stemsDir: null, fullscreen: true };
  }

  async load() {
    try { this.cfg = { ...this.cfg, ...JSON.parse(await readFile(this.file, 'utf8')) }; } catch { /* defaults */ }
    return this.cfg;
  }

  async save() {
    await mkdir(this.appDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.cfg, null, 2));
  }

  get databaseDir() { return this.cfg.database || this.appDir; }

  /** Root of the stems folders, or null when stems are kept beside each track. */
  get stemsRoot() {
    if (this.cfg.stemsMode === 'beside') return null;
    if (this.cfg.stemsMode === 'custom' && this.cfg.stemsDir) return this.cfg.stemsDir;
    return join(this.databaseDir, 'stems');
  }

  async databaseReachable() {
    try { await access(this.databaseDir); return true; } catch { return false; }
  }

  info() {
    return { ...this.cfg, appDir: this.appDir, databaseDir: this.databaseDir, stemsRoot: this.stemsRoot };
  }
}

/** Does a folder already hold a Reboxed library? */
export async function hasLibrary(dir) {
  try { await access(join(dir, 'library.json')); return true; } catch { return false; }
}

/** Copy the database entries (and optionally its stems folder) into another folder. */
export async function copyDatabase(from, to, { withStems = false } = {}) {
  await mkdir(to, { recursive: true });
  for (const name of [...DATABASE_ENTRIES, ...(withStems ? ['stems'] : [])]) {
    try { await access(join(from, name)); } catch { continue; }
    await cp(join(from, name), join(to, name), { recursive: true, force: true });
  }
}

/** Move every stems folder from one root to another (rename on the same drive, else copy + delete). */
export async function moveStemsRoot(from, to) {
  if (!from || !to || from === to) return 0;
  let entries;
  try { entries = await readdir(from, { withFileTypes: true }); } catch { return 0; }
  await mkdir(to, { recursive: true });
  let moved = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const a = join(from, e.name); const b = join(to, e.name);
    try { await access(b); continue; } catch { /* free */ }
    try { await rename(a, b); } catch {
      await cp(a, b, { recursive: true });
      await rm(a, { recursive: true, force: true });
    }
    moved++;
  }
  return moved;
}
