// Writer for the per-track analysis files Pioneer players read: PIONEER/USBANLZ/.../ANLZ0000.DAT,
// .EXT and .2EX. Big-endian tagged sections after a "PMAI" header, laid out like rekordbox 7 writes
// them (checked against a rekordbox export and the crate-digger format description).
//   .DAT  PPTH path, PVBR seek index, PQTZ beat grid, PWAV / PWV2 blue previews, PCOB cues (A-C, memory)
//   .EXT  PPTH, PWV3 blue detail, PCOB cues (D-H), PCO2 cues with colours and comments, PWV5 colour
//         detail, PWV4 colour preview
//   .2EX  PPTH, PWV7 three-band detail, PWV6 three-band preview, PWVC (CDJ-3000)
// Waveforms come from Reboxed's analysis: low / mid / high peaks at 150 points per second, which is
// the players' own detail density.

class Out {
  constructor() { this.parts = []; this.length = 0; }
  u8(v) { this.parts.push(Uint8Array.of(v & 0xff)); this.length += 1; return this; }
  u16(v) { this.parts.push(Uint8Array.of((v >> 8) & 0xff, v & 0xff)); this.length += 2; return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); this.parts.push(b); this.length += 4; return this; }
  raw(b) { this.parts.push(b); this.length += b.length; return this; }
  bytes() { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

/** One tagged section: fourcc, header length, total length, extra header fields, body. */
function section(tag, header, body = new Uint8Array(0)) {
  const lenHeader = 12 + header.length;
  const o = new Out();
  for (let i = 0; i < 4; i++) o.u8(tag.charCodeAt(i));
  o.u32(lenHeader).u32(lenHeader + body.length).raw(header).raw(body);
  return o.bytes();
}

function file(sections) {
  const len = 28 + sections.reduce((a, s) => a + s.length, 0);
  const o = new Out();
  for (const c of 'PMAI') o.u8(c.charCodeAt(0));
  o.u32(28).u32(len).u32(1).u32(0x10000).u32(0x10000).u32(0);
  for (const s of sections) o.raw(s);
  return o.bytes();
}

function utf16be(s, terminate = true) {
  const text = String(s ?? '');
  const out = new Uint8Array((text.length + (terminate ? 1 : 0)) * 2);
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 * i] = c >> 8; out[2 * i + 1] = c & 0xff; }
  return out;
}

const pathSection = (p) => { const b = utf16be(p); return section('PPTH', new Out().u32(b.length).bytes(), b); };

// ---- beat grid ------------------------------------------------------------------------------------

/**
 * @param {{time: number, bpm: number, beatInBar: number}[]} beats seconds, BPM, 1..4
 */
function beatGrid(beats) {
  const body = new Out();
  for (const b of beats) body.u16(b.beatInBar).u16(Math.round(b.bpm * 100)).u32(Math.round(b.time * 1000));
  return section('PQTZ', new Out().u32(0).u32(0x80000).u32(beats.length).bytes(), body.bytes());
}

// ---- cues -----------------------------------------------------------------------------------------

/** Hot cue colour codes seen in rekordbox exports, with their RGB (the RGB itself is also written). */
export const HOT_CUE_CODES = [
  [0x08, [0x00, 0xc4, 0xff]], [0x13, [0x00, 0xff, 0x30]], [0x17, [0x33, 0xff, 0x00]], [0x20, [0xff, 0xe8, 0x00]],
  [0x24, [0xff, 0x8c, 0x00]], [0x26, [0xff, 0x5e, 0x00]], [0x2b, [0xff, 0x00, 0x17]], [0x3c, [0x4d, 0x00, 0xff]],
];

export function cssToRgb(css) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css ?? '');
  return m ? m.slice(1).map((x) => parseInt(x, 16)) : null;
}

export function hotCueCode(rgb) {
  if (!rgb) return 0;
  let best = 0; let bestD = Infinity;
  for (const [code, c] of HOT_CUE_CODES) {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = code; }
  }
  return best;
}

/**
 * Cue as the players see it.
 * @typedef {{hotCue: number, time: number, loopTime?: number|null, rgb?: number[]|null, colorId?: number,
 *            comment?: string, loopBeats?: number}} Cue  seconds; hotCue 0 = memory, 1 = A ... 8 = H
 */

function pcpt(c, prev, next) {
  const loop = c.loopTime != null;
  return new Out().raw(Uint8Array.from([0x50, 0x43, 0x50, 0x54])).u32(0x1c).u32(0x38)
    .u32(c.hotCue).u32(0).u32(0x10000).u16(prev).u16(next)
    .u8(loop ? 2 : 1).u8(0).u16(0x3e8).u32(Math.round(c.time * 1000)).u32(loop ? Math.round(c.loopTime * 1000) : 0xffffffff)
    .raw(new Uint8Array(16)).bytes();
}

/** Classic cue list. Memory cues are linked in time order (previous / next index). */
function cueList(type, cues) {
  const body = new Out();
  cues.forEach((c, i) => body.raw(type === 0 ? pcpt(c, i ? i - 1 : 0xffff, i < cues.length - 1 ? i + 1 : 0xffff) : pcpt(c, 0xffff, 0xffff)));
  const header = new Out().u32(type).u16(0).u16(cues.length).u32(type === 0 ? cues.length : 0xffffffff).bytes();
  return section('PCOB', header, body.bytes());
}

function pcp2(c, hot) {
  const loop = c.loopTime != null;
  const comment = c.comment ? utf16be(c.comment) : new Uint8Array(0);
  const withColor = hot;
  const len = 44 + comment.length + (withColor ? 4 : 0);
  const o = new Out().raw(Uint8Array.from([0x50, 0x43, 0x50, 0x32])).u32(0x10).u32(len)
    .u32(c.hotCue).u8(loop ? 2 : 1).u8(0).u16(0x3e8).u32(Math.round(c.time * 1000)).u32(loop ? Math.round(c.loopTime * 1000) : 0xffffffff)
    .u8(c.colorId ?? 0).raw(Uint8Array.of(1, 0, 0, 0, 0, 0, 0))
    .u16(loop ? Math.max(1, Math.round(c.loopBeats ?? 0)) : 0).u16(loop ? 1 : 0).u32(comment.length).raw(comment);
  if (withColor) { const rgb = c.rgb ?? [0xff, 0x8c, 0x00]; o.u8(c.rgb ? hotCueCode(rgb) : 0).u8(rgb[0]).u8(rgb[1]).u8(rgb[2]); }
  return o.bytes();
}

function cueListExt(type, cues) {
  const body = new Out();
  for (const c of cues) body.raw(pcp2(c, type === 1));
  return section('PCO2', new Out().u32(type).u16(cues.length).u16(0).bytes(), body.bytes());
}

// ---- waveforms ------------------------------------------------------------------------------------

/** Max of each band over `cols` equal spans. */
function columns(wf, cols) {
  const n = wf.low.length;
  const out = { low: new Uint8Array(cols), mid: new Uint8Array(cols), high: new Uint8Array(cols) };
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * n) / cols); const z = Math.max(a + 1, Math.floor(((c + 1) * n) / cols));
    for (let i = a; i < Math.min(n, z); i++) {
      if (wf.low[i] > out.low[c]) out.low[c] = wf.low[i];
      if (wf.mid[i] > out.mid[c]) out.mid[c] = wf.mid[i];
      if (wf.high[i] > out.high[c]) out.high[c] = wf.high[i];
    }
  }
  return out;
}

const peak = (w, i) => Math.max(w.low[i], w.mid[i], w.high[i]);
/** Blue waveform byte: 5-bit height, 3-bit whiteness (high frequencies look whiter). */
const blueByte = (w, i) => {
  const p = peak(w, i);
  const h = Math.round((p / 255) * 31);
  const white = p ? Math.round((7 * w.high[i]) / p) : 0;
  return (white << 5) | h;
};

function blueSections(wf) {
  const prev = columns(wf, 400);
  const pwav = Uint8Array.from({ length: 400 }, (_, i) => blueByte(prev, i));
  const tiny = columns(wf, 100);
  const pwv2 = Uint8Array.from({ length: 100 }, (_, i) => Math.round((peak(tiny, i) / 255) * 15));
  return [
    section('PWAV', new Out().u32(400).u32(0x10000).bytes(), pwav),
    section('PWV2', new Out().u32(100).u32(0x10000).bytes(), pwv2),
  ];
}

function detailSections(wf) {
  const n = wf.low.length;
  const pwv3 = Uint8Array.from({ length: n }, (_, i) => blueByte(wf, i));
  const pwv5 = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = peak(wf, i) || 1;
    const v = (Math.round((7 * wf.low[i]) / p) << 13) | (Math.round((7 * wf.mid[i]) / p) << 10) | (Math.round((7 * wf.high[i]) / p) << 7) | (Math.round((peak(wf, i) / 255) * 31) << 2);
    pwv5[2 * i] = v >> 8; pwv5[2 * i + 1] = v & 0xff;
  }
  const c = columns(wf, 1200);
  const pwv4 = new Uint8Array(1200 * 6);
  for (let i = 0; i < 1200; i++) {
    const p = peak(c, i);
    const avg = (c.low[i] + c.mid[i] + c.high[i]) / 3;
    pwv4.set([Math.round((p / 255) * 127), 255 - Math.round((p / 255) * 127), Math.round((avg / 255) * 127),
      Math.round((c.low[i] / 255) * 102), Math.round((c.mid[i] / 255) * 78), Math.round((c.high[i] / 255) * 48)], i * 6);
  }
  return {
    pwv3: section('PWV3', new Out().u32(1).u32(n).u32(0x960000).bytes(), pwv3),
    pwv5: section('PWV5', new Out().u32(2).u32(n).u32(0x960305).bytes(), pwv5),
    pwv4: section('PWV4', new Out().u32(6).u32(1200).u32(0).bytes(), pwv4),
  };
}

function threeBandSections(wf) {
  const n = wf.low.length;
  const s = (v) => Math.round((v / 255) * 120);
  const pwv7 = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) pwv7.set([s(wf.low[i]), s(wf.mid[i]), s(wf.high[i])], i * 3);
  const c = columns(wf, 1200);
  const t = (v) => Math.round((v / 255) * 31);
  const pwv6 = new Uint8Array(1200 * 3);
  for (let i = 0; i < 1200; i++) pwv6.set([t(c.low[i]), t(c.mid[i]), t(c.high[i])], i * 3);
  return [
    section('PWV7', new Out().u32(3).u32(n).u32(0x960000).bytes(), pwv7),
    section('PWV6', new Out().u32(3).u32(1200).bytes(), pwv6),
    section('PWVC', new Out().u16(0).bytes(), new Out().u16(0x65).u16(0x7d).u16(0x91).bytes()),
  ];
}

// ---- files ----------------------------------------------------------------------------------------

/**
 * @param {{path: string, beats: {time, bpm, beatInBar}[], cues: Cue[],
 *          waveform: {low: Uint8Array, mid: Uint8Array, high: Uint8Array}|null}} t
 * @returns {{dat: Uint8Array, ext: Uint8Array, ex2: Uint8Array|null}}
 */
export function buildAnlz(t) {
  const hot = t.cues.filter((c) => c.hotCue > 0).sort((a, b) => a.hotCue - b.hotCue);
  const memory = t.cues.filter((c) => c.hotCue === 0).sort((a, b) => a.time - b.time);
  const empty = { low: new Uint8Array(1), mid: new Uint8Array(1), high: new Uint8Array(1) };
  const wf = t.waveform?.low?.length ? t.waveform : empty;
  const d = detailSections(wf);
  const dat = file([
    pathSection(t.path),
    section('PVBR', new Out().u32(0).bytes(), new Uint8Array(1604)), // 1620 bytes like rekordbox
    beatGrid(t.beats),
    ...blueSections(wf),
    cueList(1, hot.filter((c) => c.hotCue <= 3)),
    cueList(0, memory),
  ]);
  const ext = file([
    pathSection(t.path),
    d.pwv3,
    cueList(1, hot.filter((c) => c.hotCue > 3)),
    cueList(0, []),
    cueListExt(1, hot),
    cueListExt(0, memory),
    d.pwv5,
    d.pwv4,
  ]);
  const ex2 = t.waveform?.low?.length ? file([pathSection(t.path), ...threeBandSections(wf)]) : null;
  return { dat, ext, ex2 };
}
