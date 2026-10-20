// What each performance pad does, as in rekordbox's pad tables: 16 values per mode, shown 8 at a
// time (page 0 = values 1-8, page 1 = values 9-16). Screen pads and controller pads read the same
// tables and the same page, so the labels always match what a pad does.

export const PAD_TABLES = {
  // rekordbox's BEAT JUMP pads start with the fine jumps: ±1/4, ±1/2, then ±1 … ±32 beats.
  'BEAT JUMP': [-1 / 4, 1 / 4, -1 / 2, 1 / 2, -1, 1, -2, 2, -4, 4, -8, 8, -16, 16, -32, 32],
  'BEAT LOOP': [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
  'KEY SHIFT': [4, 5, 6, 7, 0, 1, 2, 3, -4, -3, -2, -1, -8, -7, -6, -5],
  KEYBOARD: [4, 5, 6, 7, 0, 1, 2, 3, -4, -3, -2, -1, -8, -7, -6, -5],
};

/**
 * Where a mode's page starts in its table. BEAT LOOP opens on 1/4 … 32 beats (the 8 sizes most
 * used, as on the hardware) and its second page goes up to 512.
 */
const PAGE_START = { 'BEAT LOOP': [4, 8] };

/** Pages a mode has (pad modes without a table have one). */
export const padPages = (mode) => (PAD_TABLES[mode] ? 2 : 1);

/** Value of pad `slot` (0-7) of `mode` on `page`, or undefined. */
export function padValue(mode, page, slot) {
  const table = PAD_TABLES[mode];
  if (!table) return undefined;
  const p = Math.max(0, Math.min(1, page | 0));
  return table[(PAGE_START[mode]?.[p] ?? p * 8) + slot];
}
