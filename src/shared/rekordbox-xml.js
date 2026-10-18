// Import/export of the public rekordbox.xml interchange format (File > Export Collection in
// xml format). Lets users bring their existing library, cues, beatgrids and playlists over.
import { parseXml, writeXml, childNamed, childrenNamed } from './xml.js';
import { normalizeKeyText, displayKey } from './keys.js';
import { Beatgrid, toBeatgrid } from './beatgrid.js';

export const TRACK_COLORS = [
  { name: 'Pink', hex: '0xFF007F', css: '#ff3fa0' },
  { name: 'Red', hex: '0xFF0000', css: '#ff4040' },
  { name: 'Orange', hex: '0xFFA500', css: '#ff9a1f' },
  { name: 'Yellow', hex: '0xFFFF00', css: '#ffe23a' },
  { name: 'Green', hex: '0x00FF00', css: '#3fdc5a' },
  { name: 'Aqua', hex: '0x25FDE9', css: '#25e6d6' },
  { name: 'Blue', hex: '0x0000FF', css: '#3d7dff' },
  { name: 'Purple', hex: '0x660099', css: '#a24dff' },
];
const COLOR_BY_HEX = new Map(TRACK_COLORS.map((c) => [c.hex.toUpperCase(), c.name]));

/** rekordbox Colour attribute ('0xRRGGBB') -> nearest of the 8 track colours ('' if none). */
export function colourName(hex) {
  const s = String(hex ?? '').toUpperCase();
  if (!s) return '';
  if (COLOR_BY_HEX.has(s)) return COLOR_BY_HEX.get(s);
  const v = parseInt(s.replace(/^0X|^#/, ''), 16);
  if (!Number.isFinite(v)) return '';
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  let best = ''; let bestD = Infinity;
  for (const c of TRACK_COLORS) {
    const w = parseInt(c.hex.slice(2), 16);
    const d = [(w >> 16) & 255, (w >> 8) & 255, w & 255].reduce((a, x, i) => a + (x - rgb[i]) ** 2, 0);
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best;
}

/** POSITION_MARK Type: 0 cue, 1 fade-in, 2 fade-out, 3 load, 4 loop. */
const MARK_TYPES = ['cue', 'fadein', 'fadeout', 'load', 'loop'];
const HEX_BY_COLOR = new Map(TRACK_COLORS.map((c) => [c.name, c.hex]));

const RATING_IN = { 0: 0, 51: 1, 102: 2, 153: 3, 204: 4, 255: 5 };
const RATING_OUT = [0, 51, 102, 153, 204, 255];

/** rekordbox Location URL -> OS path. */
export function locationToPath(location) {
  let p = String(location ?? '');
  p = p.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\'); // Windows drive path
  return p;
}

/** OS path -> rekordbox Location URL. */
export function pathToLocation(path) {
  const p = String(path).replace(/\\/g, '/');
  const withSlash = /^[A-Za-z]:\//.test(p) ? `/${p}` : p;
  return `file://localhost${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * @param {string} text rekordbox.xml contents
 * @returns {{tracks: object[], playlists: object[], product: string}}
 *   tracks carry `path`; playlist nodes reference tracks by `paths`.
 */
export function importRekordboxXml(text) {
  const root = parseXml(text);
  if (root.name !== 'DJ_PLAYLISTS') throw new Error('Not a rekordbox.xml file (missing DJ_PLAYLISTS)');
  const product = childNamed(root, 'PRODUCT')?.attrs.Name ?? '';
  const collection = childNamed(root, 'COLLECTION');
  const byId = new Map();
  const tracks = [];

  for (const t of childrenNamed(collection ?? { children: [] }, 'TRACK')) {
    const a = t.attrs;
    const tempo = childrenNamed(t, 'TEMPO').map((x) => ({
      start: num(x.attrs.Inizio), bpm: num(x.attrs.Bpm), beat: num(x.attrs.Battito, 1), meter: x.attrs.Metro ?? '4/4',
    }));
    const cues = childrenNamed(t, 'POSITION_MARK').map((m) => {
      const n = num(m.attrs.Num, -1);
      const hasColor = m.attrs.Red !== undefined;
      // RBClone exports Mix Point Link points as memory cues named MIX IN / MIX OUT.
      const mix = n < 0 && m.attrs.Name === 'MIX IN' ? 'mixin' : n < 0 && m.attrs.Name === 'MIX OUT' ? 'mixout' : null;
      return {
        kind: mix ?? (n >= 0 ? 'hot' : 'memory'),
        ...(num(m.attrs.Type) > 0 && num(m.attrs.Type) < 4 ? { type: MARK_TYPES[num(m.attrs.Type)] } : {}),
        slot: n >= 0 ? n : undefined,
        start: num(m.attrs.Start),
        end: m.attrs.End !== undefined && num(m.attrs.Type) === 4 ? num(m.attrs.End) : undefined,
        name: m.attrs.Name ?? '',
        color: hasColor ? rgbToCss(num(m.attrs.Red), num(m.attrs.Green), num(m.attrs.Blue)) : undefined,
      };
    });
    const track = {
      path: locationToPath(a.Location),
      title: a.Name ?? '',
      artist: a.Artist ?? '',
      composer: a.Composer ?? '',
      album: a.Album ?? '',
      grouping: a.Grouping ?? '',
      genre: a.Genre ?? '',
      kind: a.Kind ?? '',
      fileSize: num(a.Size),
      duration: num(a.TotalTime),
      trackNumber: num(a.TrackNumber),
      discNumber: num(a.DiscNumber),
      year: num(a.Year),
      bpm: num(a.AverageBpm),
      dateAdded: a.DateAdded ?? '',
      bitrate: num(a.BitRate),
      sampleRate: num(a.SampleRate),
      comments: a.Comments ?? '',
      playCount: num(a.PlayCount),
      rating: RATING_IN[num(a.Rating)] ?? Math.round(num(a.Rating) / 51),
      remixer: a.Remixer ?? '',
      key: normalizeKeyText(a.Tonality),
      label: a.Label ?? '',
      mixName: a.Mix ?? '',
      color: colourName(a.Colour),
      source: 'rekordbox',
      xmlId: a.TrackID ?? '',
      // One TEMPO = constant grid; several = dynamic grid (a beat list is rebuilt from them).
      beatgrid: tempo.length ? Beatgrid.fromMarkers(tempo, num(a.TotalTime)).toJSON() : null,
      cues,
    };
    byId.set(a.TrackID, track);
    tracks.push(track);
  }

  const playlistsRoot = childNamed(childNamed(root, 'PLAYLISTS') ?? { children: [] }, 'NODE');
  const convert = (node) => {
    if (node.attrs.Type === '0') {
      return { type: 'folder', name: node.attrs.Name ?? '', children: childrenNamed(node, 'NODE').map(convert) };
    }
    const byLocation = node.attrs.KeyType === '1';
    const paths = childrenNamed(node, 'TRACK')
      .map((x) => (byLocation ? locationToPath(x.attrs.Key) : byId.get(x.attrs.Key)?.path))
      .filter(Boolean);
    return { type: 'playlist', name: node.attrs.Name ?? '', paths };
  };
  const playlists = playlistsRoot ? childrenNamed(playlistsRoot, 'NODE').map(convert) : [];
  return { tracks, playlists, product };
}

/** Counts shown before importing. */
export function summarizeRekordbox({ tracks, playlists }) {
  const s = { tracks: tracks.length, playlists: 0, folders: 0, entries: 0, hotCues: 0, memoryCues: 0, loops: 0, comments: 0, grids: 0, rated: 0, coloured: 0 };
  for (const t of tracks) {
    for (const c of t.cues) {
      if (c.kind === 'hot') s.hotCues++; else if (c.kind === 'memory') s.memoryCues++;
      if (c.end !== undefined) s.loops++;
    }
    if (t.comments) s.comments++;
    if (t.beatgrid) s.grids++;
    if (t.rating) s.rated++;
    if (t.color) s.coloured++;
  }
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.type === 'folder') { s.folders++; walk(n.children); } else { s.playlists++; s.entries += n.paths.length; }
  });
  walk(playlists);
  return s;
}

function rgbToCss(r, g, b) {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`;
}

function cssToRgb(css) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css ?? '');
  return m ? m.slice(1).map((h) => parseInt(h, 16)) : null;
}

/**
 * @param {{tracks: object[], playlists: object[]}} library tracks have `id`; playlists have `trackIds`
 * @returns {string}
 */
export function exportRekordboxXml(library, { productVersion = '0.2.0' } = {}) {
  const idOf = new Map();
  const trackNodes = library.tracks.map((t, i) => {
    const xmlId = String(i + 1);
    idOf.set(t.id, xmlId);
    const children = [];
    const grid = toBeatgrid(t.beatgrid);
    for (const m of grid ? grid.tempoMarkers() : []) {
      children.push({ name: 'TEMPO', attrs: {
        Inizio: m.start.toFixed(3), Bpm: m.bpm.toFixed(2), Metro: '4/4', Battito: String(m.beat),
      }, children: [] });
    }
    for (const c of t.cues ?? []) {
      const rgb = cssToRgb(c.color);
      children.push({ name: 'POSITION_MARK', attrs: {
        Name: c.name ?? '', Type: c.end !== undefined ? '4' : String(Math.max(0, MARK_TYPES.indexOf(c.type))), Start: c.start.toFixed(3),
        End: c.end !== undefined ? c.end.toFixed(3) : undefined,
        Num: c.kind === 'hot' ? String(c.slot) : '-1',
        Red: rgb?.[0], Green: rgb?.[1], Blue: rgb?.[2],
      }, children: [] });
    }
    return { name: 'TRACK', attrs: {
      TrackID: xmlId, Name: t.title ?? '', Artist: t.artist ?? '', Composer: t.composer ?? '', Album: t.album ?? '',
      Grouping: t.grouping ?? '', Genre: t.genre ?? '', Kind: t.kind ?? '', Size: String(t.fileSize ?? 0),
      TotalTime: String(Math.round(t.duration ?? 0)), DiscNumber: String(t.discNumber ?? 0), TrackNumber: String(t.trackNumber ?? 0),
      Year: String(t.year ?? 0), AverageBpm: (t.bpm ?? 0).toFixed(2), DateAdded: t.dateAdded ?? '',
      BitRate: String(t.bitrate ?? 0), SampleRate: String(t.sampleRate ?? 0), Comments: t.comments ?? '',
      PlayCount: String(t.playCount ?? 0), Rating: String(RATING_OUT[t.rating ?? 0] ?? 0),
      Location: pathToLocation(t.path), Remixer: t.remixer ?? '', Tonality: displayKey(t.key, 'musical'),
      Label: t.label ?? '', Mix: t.mixName ?? '', Colour: HEX_BY_COLOR.get(t.color),
    }, children };
  });

  const convert = (node) => (node.type === 'folder'
    ? { name: 'NODE', attrs: { Type: '0', Name: node.name, Count: String(node.children.length) }, children: node.children.map(convert) }
    : { name: 'NODE', attrs: { Name: node.name, Type: '1', KeyType: '0', Entries: String((node.trackIds ?? []).length) },
      children: (node.trackIds ?? []).filter((id) => idOf.has(id)).map((id) => ({ name: 'TRACK', attrs: { Key: idOf.get(id) }, children: [] })) });

  const doc = { name: 'DJ_PLAYLISTS', attrs: { Version: '1.0.0' }, children: [
    { name: 'PRODUCT', attrs: { Name: 'RBClone', Version: productVersion, Company: 'RBClone' }, children: [] },
    { name: 'COLLECTION', attrs: { Entries: String(trackNodes.length) }, children: trackNodes },
    { name: 'PLAYLISTS', attrs: {}, children: [
      { name: 'NODE', attrs: { Type: '0', Name: 'ROOT', Count: String(library.playlists.length) }, children: library.playlists.map(convert) },
    ] },
  ] };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${writeXml(doc)}\n`;
}
