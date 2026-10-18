// Intelligent cue creation from phrase analysis.
//  - a memory cue at the start of every phrase (named after it)
//  - hot cues: A = first downbeat, B = first CHORUS, C = first DOWN/BRIDGE, D = OUTRO
//  - optionally an 8-bar loop on the intro as hot cue E (handy for long mix-ins)

const HOT_COLORS = { A: '#3fdc5a', B: '#ff3f6c', C: '#25e6d6', D: '#5b6cff', E: '#ff9a1f' };

/**
 * @param {{phrases: {start: number, end: number, label: string, num: number, bars: number}[]}} phraseInfo
 * @param {import('./beatgrid.js').Beatgrid} grid
 * @param {object[]} existing current cues
 * @param {{overwrite?: boolean, introLoop?: boolean}} [opts]
 * @returns {object[]} new cue list
 */
export function createCues(phraseInfo, grid, existing = [], { overwrite = false, introLoop = true } = {}) {
  const phrases = phraseInfo?.phrases ?? [];
  if (!phrases.length || !grid) return existing;
  const keep = overwrite ? [] : existing.slice();
  const usedSlots = new Set(keep.filter((c) => c.kind === 'hot').map((c) => c.slot));
  const hasMemoryAt = (t) => keep.some((c) => c.kind === 'memory' && Math.abs(c.start - t) < 0.05);
  const out = keep;

  for (const p of phrases) {
    if (!hasMemoryAt(p.start)) out.push({ kind: 'memory', start: p.start, name: `${p.label} ${p.num}` });
  }
  const first = (...labels) => phrases.find((p) => labels.includes(p.label));
  const hot = [
    ['A', 0, phrases[0]],
    ['B', 1, first('CHORUS')],
    ['C', 2, first('DOWN', 'BRIDGE')],
    ['D', 3, [...phrases].reverse().find((p) => p.label === 'OUTRO')],
  ];
  for (const [letter, slot, p] of hot) {
    if (!p || usedSlots.has(slot)) continue;
    out.push({ kind: 'hot', slot, start: p.start, name: p.label, color: HOT_COLORS[letter] });
    usedSlots.add(slot);
  }
  if (introLoop && !usedSlots.has(4) && phrases[0].bars >= 8) {
    const start = phrases[0].start;
    out.push({ kind: 'hot', slot: 4, start, end: grid.timeOf(grid.indexAt(start) + 32), name: 'INTRO LOOP', color: HOT_COLORS.E });
  }
  return out;
}
