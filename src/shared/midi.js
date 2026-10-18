// MIDI message decoding shared by the controller layer and tests.

/** Stable key for a message: "note:<ch>:<n>", "cc:<ch>:<n>" or "pb:<ch>" (channels 1-16). */
export function messageKey(status, d1) {
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  if (type === 0x90 || type === 0x80) return `note:${ch}:${d1}`;
  if (type === 0xb0) return `cc:${ch}:${d1}`;
  if (type === 0xe0) return `pb:${ch}`;
  return null;
}

/**
 * Decode a message into {key, press?: boolean, value01?: number, delta?: number}.
 * Buttons: note on/off (velocity 0 = off), or CC >= 64 / < 64. Knobs: CC 0..127.
 * Pitch bend: 14-bit. Relative encoders (jog/browse): CC 1..63 = +n, 65..127 = -(128-n).
 */
export function decodeMessage([status, d1 = 0, d2 = 0]) {
  const key = messageKey(status, d1);
  if (!key) return null;
  const type = status & 0xf0;
  if (type === 0x80) return { key, press: false };
  if (type === 0x90) return { key, press: d2 > 0, value01: d2 / 127 };
  if (type === 0xe0) return { key, value01: ((d2 << 7) | d1) / 16383 };
  return { key, press: d2 >= 64, value01: d2 / 127, delta: d2 === 0 || d2 === 64 ? 0 : d2 < 64 ? d2 : d2 - 128 };
}
