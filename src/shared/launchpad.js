// Launchpad X protocol (Programmer mode), from Novation's Programmer's Reference. Pure functions.
//
// Layout in Programmer mode: the 8x8 pads are notes row*10+col (bottom-left = 11, top-right = 88);
// the right column sends CC 89, 79 … 19 (top to bottom); the top row sends CC 91–98; the logo is
// LED 99. Colours: SysEx 03h with RGB entries (0-127 each), up to 81 entries per message.

export const LPX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c];

/** Programmer mode on (true) or back to Live mode (false). */
export const lpxMode = (programmer) => [...LPX_HEADER, 0x0e, programmer ? 1 : 0, 0xf7];

/** LED brightness 0..127. */
export const lpxBrightness = (v) => [...LPX_HEADER, 0x08, Math.max(0, Math.min(127, Math.round(v))), 0xf7];

/**
 * RGB LED messages for a list of [index, r, g, b] (0..127), split in messages of 81 entries.
 * @param {[number, number, number, number][]} leds
 */
export function lpxRgb(leds) {
  const out = [];
  for (let i = 0; i < leds.length; i += 81) {
    const msg = [...LPX_HEADER, 0x03];
    for (const [idx, r, g, b] of leds.slice(i, i + 81)) msg.push(3, idx, r & 0x7f, g & 0x7f, b & 0x7f);
    msg.push(0xf7);
    out.push(msg);
  }
  return out;
}

/** Pad note for grid cell (x 0..7 left to right, y 0..7 top to bottom). */
export const padNote = (x, y) => (8 - y) * 10 + (x + 1);

/** Grid cell of a pad note, or null. */
export function padCell(note) {
  const row = Math.floor(note / 10); const col = note % 10;
  if (row < 1 || row > 8 || col < 1 || col > 8) return null;
  return { x: col - 1, y: 8 - row };
}

/** Right-column button CC for row y (0 = top). */
export const sideCc = (y) => (8 - y) * 10 + 9;
/** Top-row button CC for column x (0..7). */
export const topCc = (x) => 91 + x;
export const LOGO = 99;

/** Top-row buttons, by their printed function in Programmer mode. */
export const TOP = { up: 91, down: 92, left: 93, right: 94, session: 95, note: 96, custom: 97, capture: 98 };

/**
 * Decode a message from the pad surface.
 * @returns {{kind: 'pad', x: number, y: number, velocity: number} | {kind: 'side', y: number, press: boolean}
 *   | {kind: 'top', x: number, press: boolean} | {kind: 'pressure', x: number, y: number, value: number} | null}
 */
export function lpxDecode(bytes) {
  const [status, d1 = 0, d2 = 0] = bytes;
  const type = status & 0xf0;
  if (type === 0x90 || type === 0x80) {
    const cell = padCell(d1);
    if (cell) return { kind: 'pad', ...cell, velocity: type === 0x80 ? 0 : d2 };
  } else if (type === 0xa0) {
    const cell = padCell(d1);
    if (cell) return { kind: 'pressure', ...cell, value: d2 };
  } else if (type === 0xb0) {
    if (d1 >= 91 && d1 <= 98) return { kind: 'top', x: d1 - 91, press: d2 > 0 };
    if (d1 % 10 === 9 && d1 >= 19 && d1 <= 89) return { kind: 'side', y: 8 - Math.floor(d1 / 10), press: d2 > 0 };
  }
  return null;
}

/** The pad-surface MIDI port of a Launchpad X ("LPX MIDI", "MIDIIN2 (LPX MIDI)"), not the DAW port. */
export const isLpxPort = (name) => /\bLPX MIDI\b|Launchpad X.*MIDI/i.test(name ?? '') && !/DAW/i.test(name ?? '');
