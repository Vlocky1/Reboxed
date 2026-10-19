import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { rebasePaths } from '../shared/portable-paths.js';

const LIBRARY_VERSION = 1;

/** JSON persistence in the database folder: library.json plus one analysis file per track. */
export class LibraryStore {
  /**
   * @param {string} dir database folder
   * @param {{legacyDir?: string}} [opts] where libraries saved before 1.2 lived (they record no dbDir)
   */
  constructor(dir, { legacyDir = null } = {}) {
    this.dir = dir;
    this.legacyDir = legacyDir;
    this.libraryFile = join(dir, 'library.json');
    this.analysisDir = join(dir, 'analysis');
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.libraryFile, 'utf8'));
      // The database folder moved (or its removable drive got another letter): paths follow.
      return rebasePaths(data, data.dbDir ?? this.legacyDir, this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return { version: LIBRARY_VERSION, tracks: [], playlists: [], settings: {} };
      throw err;
    }
  }

  async save(data) {
    await this.writeAtomic(this.libraryFile, JSON.stringify({ ...data, version: LIBRARY_VERSION, dbDir: this.dir }));
  }

  async getAnalysis(id) {
    try {
      return JSON.parse(await readFile(this.analysisPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putAnalysis(id, data) {
    await mkdir(this.analysisDir, { recursive: true });
    await this.writeAtomic(this.analysisPath(id), JSON.stringify(data));
  }

  /** Write a user-chosen file (exports, recordings). Accepts string or ArrayBuffer/typed array. */
  async writeExternal(path, data) {
    await mkdir(dirname(path), { recursive: true });
    if (typeof data === 'string') await writeFile(path, data);
    else if (data instanceof ArrayBuffer) await writeFile(path, Buffer.from(data));
    else await writeFile(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  analysisPath(id) {
    return join(this.analysisDir, `${String(id).replace(/[^\w-]/g, '_')}.json`);
  }

  async writeAtomic(file, text) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  }
}
