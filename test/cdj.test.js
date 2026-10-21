import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/shared/cdj/pdb.js';
import { buildAnlz, hotCueCode, cssToRgb } from '../src/shared/cdj/anlz.js';
import { crc16xmodem, buildSettingFiles, defaultSettings, PLAYER_SETTINGS } from '../src/shared/cdj/mysettings.js';

const tag = (buf, at) => String.fromCharCode(...buf.subarray(at, at + 4));

test('DeviceSQL strings: short ASCII, long ASCII, UTF-16', () => {
  assert.deepEqual([...P.dsqlString('abc')], [9, 97, 98, 99]);
  const long = P.dsqlString('x'.repeat(200));
  assert.deepEqual([...long.subarray(0, 3)], [0x40, 204, 0]);
  const utf = P.dsqlString('Café');
  assert.equal(utf[0], 0x90);
  assert.equal(utf.length, 4 + 8);
  assert.equal(utf[4], 'C'.charCodeAt(0));
});

test('export.pdb: header, 20 tables, 4 KiB pages, rows spread over pages', () => {
  const tracks = Array.from({ length: 300 }, (_, i) => P.trackRow({
    id: i + 1, title: `Track ${i + 1}`, artistId: 1, albumId: 0, genreId: 0, keyId: 0, colorId: 0, rating: 0, bpm: 128, duration: 200,
    bitrate: 320, fileSize: 1, year: 0, sampleRate: 44100, filename: `t${i}.mp3`, filePath: `/Contents/t${i}.mp3`,
    analyzePath: '/PIONEER/USBANLZ/P000/00000001/ANLZ0000.DAT', analyzeDate: '2026-10-19', dateAdded: '2026-10-19', comment: '',
  }));
  const pdb = P.buildPdb({ [P.TABLE.TRACKS]: tracks, [P.TABLE.ARTISTS]: [P.artistRow(1, 'Artist')] });
  const v = new DataView(pdb.buffer);
  assert.equal(pdb.length % P.PAGE, 0);
  assert.equal(v.getUint32(4, true), P.PAGE);
  assert.equal(v.getUint32(8, true), 20);
  assert.equal(v.getUint32(12, true), pdb.length / P.PAGE);
  // Track table pointer: first page = its index page, last page a data page; tracks need several pages.
  const first = v.getUint32(28 + 8, true); const last = v.getUint32(28 + 12, true);
  assert.equal(v.getUint32(28, true), P.TABLE.TRACKS);
  assert.ok(last - first >= 2, `track data pages ${first}..${last}`);
  // Each data page records its own index and the table type.
  assert.equal(v.getUint32(last * P.PAGE + 4, true), last);
  assert.equal(v.getUint32(last * P.PAGE + 8, true), P.TABLE.TRACKS);
});

test('ANLZ files: PMAI header, sections in rekordbox order, hot cue colours', () => {
  const beats = Array.from({ length: 16 }, (_, i) => ({ time: i * 0.5, bpm: 120, beatInBar: (i % 4) + 1 }));
  const waveform = { low: new Uint8Array(300).fill(200), mid: new Uint8Array(300).fill(100), high: new Uint8Array(300).fill(50) };
  const cues = [{ hotCue: 1, time: 1, rgb: cssToRgb('#ff8c00') }, { hotCue: 5, time: 2, rgb: [0, 196, 255] }, { hotCue: 0, time: 3 }];
  const { dat, ext, ex2 } = buildAnlz({ path: '/Contents/a.mp3', beats, cues, waveform });
  const sections = (buf) => {
    const out = []; const v = new DataView(buf.buffer, buf.byteOffset);
    assert.equal(tag(buf, 0), 'PMAI');
    assert.equal(v.getUint32(8), buf.length);
    for (let o = v.getUint32(4); o < buf.length; o += v.getUint32(o + 8)) out.push(tag(buf, o));
    return out;
  };
  assert.deepEqual(sections(dat), ['PPTH', 'PVBR', 'PQTZ', 'PWAV', 'PWV2', 'PCOB', 'PCOB']);
  assert.deepEqual(sections(ext), ['PPTH', 'PWV3', 'PCOB', 'PCOB', 'PCO2', 'PCO2', 'PWV5', 'PWV4']);
  assert.deepEqual(sections(ex2), ['PPTH', 'PWV7', 'PWV6', 'PWVC']);
  assert.equal(hotCueCode([0xff, 0x8c, 0x00]), 0x24);
  assert.equal(hotCueCode([0x00, 0xc4, 0xff]), 0x08);
  assert.equal(buildAnlz({ path: '/a.mp3', beats: [], cues: [], waveform: null }).ex2, null);
});

test('My Settings files: CRC16-XMODEM and chosen values', () => {
  assert.equal(crc16xmodem(new TextEncoder().encode('123456789')), 0x31c3);
  const files = buildSettingFiles({ ...defaultSettings(), jogMode: 'CDJ' });
  assert.deepEqual(Object.keys(files).sort(), ['DEVSETTING.DAT', 'DJMMYSETTING.DAT', 'MYSETTING.DAT', 'MYSETTING2.DAT']);
  for (const [name, buf] of Object.entries(files)) {
    const v = new DataView(buf.buffer);
    const len = v.getUint32(100, true);
    assert.equal(buf.length, 104 + len + 4, name);
    const crc = crc16xmodem(name === 'DJMMYSETTING.DAT' ? buf.subarray(0, 104 + len) : buf.subarray(104, 104 + len));
    assert.equal(v.getUint16(104 + len, true), crc, `${name} CRC`);
  }
  // "CDJ" is the name earlier versions saved for the pitch bend jog mode.
  const jog = PLAYER_SETTINGS.jogMode;
  assert.equal(files['MYSETTING.DAT'][104 + jog.offset], jog.choices['pitch bend']);
});
