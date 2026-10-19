// Writer for the rekordbox device database read by Pioneer CDJ / XDJ players: PIONEER/rekordbox/export.pdb
// ("DeviceSQL"). Layout written the way rekordbox 7 writes it (checked against a rekordbox export and
// the crate-digger format description): a file header page, then per table an index page followed by
// chained data pages, and one blank "empty candidate" page per table at the end.
//   page header (40 bytes) | heap of rows (each 4-byte aligned) ... | row index, built backwards
//   from the end of the page in groups of 16: [offsets 15..0][present flags u16][flags u16]

export const PAGE = 4096;
const HEADER = 40;

export const TABLE = {
  TRACKS: 0, GENRES: 1, ARTISTS: 2, ALBUMS: 3, LABELS: 4, KEYS: 5, COLORS: 6, PLAYLIST_TREE: 7, PLAYLIST_ENTRIES: 8,
  UNKNOWN_9: 9, UNKNOWN_10: 10, HISTORY_PLAYLISTS: 11, HISTORY_ENTRIES: 12, ARTWORK: 13, UNKNOWN_14: 14, UNKNOWN_15: 15,
  COLUMNS: 16, UNKNOWN_17: 17, UNKNOWN_18: 18, HISTORY: 19,
};
// Data page flags rekordbox uses per table (0x34 for tables it edits row by row, 0x24 otherwise).
const DATA_FLAGS = { 0: 0x34, 1: 0x34, 2: 0x34, 3: 0x34, 4: 0x24, 5: 0x24, 6: 0x24, 7: 0x34, 8: 0x34, 11: 0x34, 12: 0x34, 13: 0x24, 16: 0x24, 17: 0x24, 18: 0x24, 19: 0x34 };
// Tables whose rows carry an "index shift" (row number in the page x 0x20) at byte 2.
const INDEX_SHIFT = new Set([TABLE.TRACKS, TABLE.ARTISTS, TABLE.ALBUMS]);

// ---- DeviceSQL strings ----------------------------------------------------------------------------

const ASCII = /^[\x20-\x7e]*$/;

/** DeviceSQL string: short ASCII (<= 126 bytes), long ASCII, or UTF-16LE. */
export function dsqlString(s) {
  const text = String(s ?? '');
  if (ASCII.test(text) && text.length <= 126) {
    const out = new Uint8Array(text.length + 1);
    out[0] = ((text.length + 1) << 1) | 1;
    for (let i = 0; i < text.length; i++) out[i + 1] = text.charCodeAt(i);
    return out;
  }
  if (ASCII.test(text)) {
    const out = new Uint8Array(text.length + 4);
    out[0] = 0x40; out[1] = (text.length + 4) & 0xff; out[2] = (text.length + 4) >> 8;
    for (let i = 0; i < text.length; i++) out[i + 4] = text.charCodeAt(i);
    return out;
  }
  const out = new Uint8Array(text.length * 2 + 4);
  out[0] = 0x90; out[1] = (text.length * 2 + 4) & 0xff; out[2] = (text.length * 2 + 4) >> 8;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[4 + 2 * i] = c & 0xff; out[5 + 2 * i] = c >> 8; }
  return out;
}

/** Little helper to assemble rows. */
class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  u8(v) { this.parts.push(Uint8Array.of(v & 0xff)); this.length += 1; return this; }
  u16(v) { this.parts.push(Uint8Array.of(v & 0xff, (v >> 8) & 0xff)); this.length += 2; return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.parts.push(b); this.length += 4; return this; }
  raw(b) { this.parts.push(b); this.length += b.length; return this; }
  bytes() { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

// ---- rows -------------------------------------------------------------------------------------------

const TRACK_STRINGS = 21;
const TRACK_FIXED = 0x5e; // bytes before the string offsets

/**
 * Track row. Strings (index -> meaning): 0 isrc, 1 texter, 2 "0", 3, 4, 5 message, 6 kuvo "ON",
 * 7 autoload hot cues "ON", 8, 9, 10 date added, 11 release date, 12 mix name, 13, 14 analysis path,
 * 15 analysis date, 16 comment, 17 title, 18, 19 file name, 20 file path.
 */
export function trackRow(t) {
  const strings = Array(TRACK_STRINGS).fill('');
  strings[2] = '0'; strings[6] = 'ON'; strings[7] = t.autoloadHotcues === false ? 'OFF' : 'ON';
  strings[10] = t.dateAdded ?? ''; strings[11] = t.releaseDate ?? ''; strings[12] = t.mixName ?? '';
  strings[14] = t.analyzePath ?? ''; strings[15] = t.analyzeDate ?? ''; strings[16] = t.comment ?? '';
  strings[17] = t.title ?? ''; strings[19] = t.filename ?? ''; strings[20] = t.filePath ?? '';
  const enc = strings.map(dsqlString);
  const b = new Bytes();
  b.u16(0x24).u16(0).u32(0x000c0700).u32(t.sampleRate ?? 44100).u32(t.composerId ?? 0).u32(t.fileSize ?? 0)
    .u32(t.checksum ?? 0).u16(0x032a).u16(0x504e).u32(t.artworkId ?? 0).u32(t.keyId ?? 0).u32(t.originalArtistId ?? 0)
    .u32(t.labelId ?? 0).u32(t.remixerId ?? 0).u32(t.bitrate ?? 0).u32(t.trackNumber ?? 0).u32(Math.round((t.bpm ?? 0) * 100))
    .u32(t.genreId ?? 0).u32(t.albumId ?? 0).u32(t.artistId ?? 0).u32(t.id).u16(t.discNumber ?? 0).u16(t.playCount ?? 0)
    .u16(t.year ?? 0).u16(t.sampleDepth ?? 16).u16(Math.round(t.duration ?? 0)).u16(0x29).u8(t.colorId ?? 0).u8(t.rating ?? 0)
    .u16(1).u16(3);
  let ofs = TRACK_FIXED + TRACK_STRINGS * 2;
  for (const e of enc) { b.u16(ofs); ofs += e.length; }
  for (const e of enc) b.raw(e);
  return b.bytes();
}

export const artistRow = (id, name) => new Bytes().u16(0x60).u16(0).u32(id).u8(3).u8(10).raw(dsqlString(name)).bytes();
export const albumRow = (id, name, artistId = 0) => new Bytes().u16(0x80).u16(0).u32(0).u32(artistId).u32(id).u32(0).u8(3).u8(22).raw(dsqlString(name)).bytes();
export const idNameRow = (id, name) => new Bytes().u32(id).raw(dsqlString(name)).bytes(); // genres, labels
export const keyRow = (id, name) => new Bytes().u32(id).u32(id).raw(dsqlString(name)).bytes();
export const colorRow = (id, name) => new Bytes().raw(Uint8Array.of(0, 0, 0, 0, id)).u16(id).u8(0).raw(dsqlString(name)).bytes();
export const artworkRow = (id, path) => new Bytes().u32(id).raw(dsqlString(path)).bytes();
export const playlistTreeRow = (p) => new Bytes().u32(p.parentId ?? 0).u32(0).u32(p.sortOrder ?? 0).u32(p.id).u32(p.isFolder ? 1 : 0).raw(dsqlString(p.name)).bytes();
export const playlistEntryRow = (entryIndex, trackId, playlistId) => new Bytes().u32(entryIndex).u32(trackId).u32(playlistId).bytes();

/** The 8 track colours, ids 1..8 as the players know them. */
export const COLORS = ['Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple'];

// ---- pages ------------------------------------------------------------------------------------------

const align4 = (n) => (n + 3) & ~3;
const indexBytes = (n) => Math.ceil(n / 16) * 4 + n * 2;
const MAX_ROWS = 255; // keeps the row count in the page header's 8-bit field

/** Split rows of one table into pages. */
export function packRows(rows) {
  const pages = [];
  let cur = [];
  let used = 0;
  for (const r of rows) {
    const need = align4(r.length);
    if (cur.length && (used + need + indexBytes(cur.length + 1) > PAGE - HEADER || cur.length >= MAX_ROWS)) {
      pages.push(cur); cur = []; used = 0;
    }
    if (need + indexBytes(1) > PAGE - HEADER) throw new Error(`row of ${r.length} bytes does not fit in a page`);
    cur.push(r); used += need;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function dataPage(index, type, next, rows) {
  const page = new Uint8Array(PAGE);
  const v = new DataView(page.buffer);
  let used = 0;
  const offsets = [];
  rows.forEach((r, i) => {
    const row = r.slice();
    if (INDEX_SHIFT.has(type)) { row[2] = (i * 0x20) & 0xff; row[3] = ((i * 0x20) >> 8) & 0xff; }
    page.set(row, HEADER + used);
    offsets.push(used);
    used += align4(row.length);
  });
  const n = rows.length;
  v.setUint32(4, index, true); v.setUint32(8, type, true); v.setUint32(12, next, true);
  v.setUint32(16, 1, true);
  const packed = n | (n << 13);
  page[24] = packed & 0xff; page[25] = (packed >> 8) & 0xff; page[26] = (packed >> 16) & 0xff;
  page[27] = DATA_FLAGS[type] ?? 0x24;
  v.setUint16(28, PAGE - HEADER - used - indexBytes(n), true);
  v.setUint16(30, used, true);
  v.setUint16(32, n, true); // rows written in this transaction
  // Row index, groups of 16 from the end of the page.
  for (let g = 0; g * 16 < n; g++) {
    const base = PAGE - g * 36;
    const inGroup = Math.min(16, n - g * 16);
    const flags = (1 << inGroup) - 1;
    v.setUint16(base - 4, flags, true);
    v.setUint16(base - 2, flags, true);
    for (let k = 0; k < inGroup; k++) v.setUint16(base - 6 - 2 * k, offsets[g * 16 + k], true);
  }
  return page;
}

function indexPage(index, type, next) {
  const page = new Uint8Array(PAGE);
  const v = new DataView(page.buffer);
  v.setUint32(4, index, true); v.setUint32(8, type, true); v.setUint32(12, next, true);
  v.setUint32(16, 1, true);
  page[27] = 0x64;
  v.setUint16(32, 0x1fff, true); v.setUint16(34, 0x1fff, true); v.setUint16(36, 1004, true);
  v.setUint32(0x28, index, true); v.setUint32(0x2c, next, true);
  v.setUint32(0x30, 0x03ffffff, true);
  v.setUint16(0x3a, 0x1fff, true);
  for (let o = 0x3c; o < 0xfec; o += 4) v.setUint32(o, 0x1ffffff8, true);
  return page;
}

/**
 * Assemble export.pdb.
 * @param {Record<number, Uint8Array[]>} tables rows per table type (missing tables are written empty)
 * @returns {Uint8Array}
 */
export function buildPdb(tables) {
  const types = Object.values(TABLE);
  const plan = types.map((type) => ({ type, pages: packRows(tables[type] ?? []) }));
  let next = 1;
  for (const t of plan) { t.indexPage = next++; t.dataPages = t.pages.map(() => next++); }
  for (const t of plan) t.empty = next++;
  const total = next;
  const out = new Uint8Array(total * PAGE);
  const v = new DataView(out.buffer);
  v.setUint32(4, PAGE, true); v.setUint32(8, types.length, true); v.setUint32(12, total, true);
  v.setUint32(16, 5, true); v.setUint32(20, total + 1, true);
  plan.forEach((t, i) => {
    const o = 28 + i * 16;
    v.setUint32(o, t.type, true); v.setUint32(o + 4, t.empty, true);
    v.setUint32(o + 8, t.indexPage, true); v.setUint32(o + 12, t.dataPages.at(-1) ?? t.indexPage, true);
    out.set(indexPage(t.indexPage, t.type, t.dataPages[0] ?? t.empty), t.indexPage * PAGE);
    t.pages.forEach((rows, k) => {
      const idx = t.dataPages[k];
      out.set(dataPage(idx, t.type, t.dataPages[k + 1] ?? t.empty, rows), idx * PAGE);
    });
  });
  return out;
}
