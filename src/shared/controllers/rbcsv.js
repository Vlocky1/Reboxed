// Parser for rekordbox controller mapping files (MidiMappings/<model>.midi.csv).
// Row format: name,function,type,input,deck1..deck4,output,deck1..deck4,option,comment
//   input/output are 4 hex digits "SSDD": status byte + data byte, e.g. "900B" = note 0x0B on ch 1.
//   When deck columns are filled, the status' low nibble is replaced by that deck's MIDI channel
//   (deck1..4 = columns), so "900B" with "0,1,2,3" means channels 1-4.

/**
 * @typedef {{status: number, data1: number, deck: number|null}} MidiAddr  deck 0..3 or null (global)
 * @typedef {{name: string, label: string, type: string, inputs: MidiAddr[], outputs: MidiAddr[], options: Record<string, string|boolean>}} MappingEntry
 */

const HEX4 = /^[0-9A-Fa-f]{4}$/;

function addrs(code, decks) {
  // Some rows give a full address per deck instead (e.g. jog ring output "BF00,BF01,BF02,BF03").
  if (!code && decks.some((d) => HEX4.test(d ?? ''))) {
    return decks.map((d, deck) => (HEX4.test(d ?? '') ? { status: parseInt(d.slice(0, 2), 16), data1: parseInt(d.slice(2), 16), deck } : null)).filter(Boolean);
  }
  if (!code || !HEX4.test(code)) return [];
  const status = parseInt(code.slice(0, 2), 16);
  const data1 = parseInt(code.slice(2), 16);
  const chans = decks.map((d) => (d === '' || d === undefined ? null : Number(d)));
  if (chans.every((c) => c === null)) return [{ status, data1, deck: null }];
  return chans
    .map((ch, deck) => (ch === null || Number.isNaN(ch) ? null : { status: (status & 0xf0) | (ch & 0x0f), data1, deck }))
    .filter(Boolean);
}

function parseOptions(s) {
  const out = {};
  for (const part of String(s ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

/**
 * @param {string} text CSV contents
 * @returns {{device: string, entries: MappingEntry[]}}
 */
export function parseRekordboxMapping(text) {
  let device = '';
  const entries = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols[0] === '@file') { device = cols[2] ?? ''; continue; }
    if (cols[0].startsWith('#') || !cols[0]) continue;
    const [name, label, type, input, i1, i2, i3, i4, output, o1, o2, o3, o4, option] = cols;
    entries.push({
      name, label: label ?? '', type: type ?? '',
      inputs: addrs(input, [i1, i2, i3, i4]),
      outputs: addrs(output, [o1, o2, o3, o4]),
      options: parseOptions(option),
    });
  }
  return { device, entries };
}

/** Key used to route incoming messages: note on/off share a key. */
export function addrKey(status, data1) {
  const type = status & 0xf0;
  const s = type === 0x80 ? 0x90 | (status & 0x0f) : status;
  return `${s.toString(16)}:${data1.toString(16)}`;
}
