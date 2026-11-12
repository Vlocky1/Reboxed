// Lyrics sync from speech recognition: the words a recogniser heard (with times, some of them wrong)
// are aligned with the known lyrics (Needleman-Wunsch on words, fuzzy word match), and every lyrics
// line gets the time of its first well-heard word; lines with none are placed between their
// neighbours by word count. Also: lines made from the recognised words alone (no lyrics known).

/** A word as compared: lower case, no accents, letters and digits only. */
export function normWord(w) {
  return String(w ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The words of a lyrics line ("(ooh)", "-", "♪" are not words). */
export function lineWords(text) {
  return String(text ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[\s\-–—/]+/).map(normWord).filter(Boolean);
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** How alike two normalised words are, 0..1. */
export function wordSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

const MATCH = 0.6;          // a word heard this alike counts as the lyrics word
const GAP_LYRIC = -0.55;    // a lyrics word the recogniser did not hear
const GAP_HEARD = -0.35;    // a heard word that is not in the lyrics (ad-libs, wrong guesses)

/**
 * Global alignment of lyrics words (a) with heard words (b). Returns, for each lyrics word, the index
 * of the heard word it matched, or -1.
 */
export function alignWords(a, b) {
  const m = a.length, n = b.length;
  const score = new Float32Array((m + 1) * (n + 1));
  const move = new Uint8Array((m + 1) * (n + 1));     // 1 diag, 2 up (skip lyric), 3 left (skip heard)
  const at = (i, j) => i * (n + 1) + j;
  for (let i = 1; i <= m; i++) { score[at(i, 0)] = i * GAP_LYRIC; move[at(i, 0)] = 2; }
  for (let j = 1; j <= n; j++) { score[at(0, j)] = j * GAP_HEARD; move[at(0, j)] = 3; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const s = wordSim(a[i - 1], b[j - 1]);
      const d = score[at(i - 1, j - 1)] + (s >= MATCH ? 1 + s : -1);
      const u = score[at(i - 1, j)] + GAP_LYRIC;
      const l = score[at(i, j - 1)] + GAP_HEARD;
      if (d >= u && d >= l) { score[at(i, j)] = d; move[at(i, j)] = 1; } else if (u >= l) { score[at(i, j)] = u; move[at(i, j)] = 2; } else { score[at(i, j)] = l; move[at(i, j)] = 3; }
    }
  }
  const out = new Array(m).fill(-1);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    const mv = move[at(i, j)];
    if (mv === 1) { if (wordSim(a[i - 1], b[j - 1]) >= MATCH) out[i - 1] = j - 1; i--; j--; } else if (mv === 2) i--; else j--;
  }
  return out;
}

/**
 * Times for lyrics lines from heard words.
 * @param {string[]} texts the lyrics, one line each
 * @param {{w: string, t: number}[]} heard words with their start (s)
 * @returns {{lines: {t: number|null, text: string}[], matched: number}} matched: share of lyrics words heard
 */
export function syncLines(texts, heard) {
  const words = []; const firstOf = [];
  texts.forEach((text, li) => { firstOf[li] = words.length; for (const w of lineWords(text)) words.push({ w, li }); });
  const hb = heard.map((h) => ({ t: h.t, nw: normWord(h.w) })).filter((h) => h.nw);
  const map = alignWords(words.map((x) => x.w), hb.map((h) => h.nw));
  const wordTime = map.map((j) => (j >= 0 ? hb[j].t : null));
  // a line starts at its first heard word, moved back by the words before it in the line
  const avgWord = 0.32;
  const raw = texts.map((_, li) => {
    const a = firstOf[li], z = li + 1 < texts.length ? firstOf[li + 1] : words.length;
    for (let k = a; k < z; k++) if (wordTime[k] !== null) return { t: Math.max(0, wordTime[k] - (k - a) * avgWord), at: a };
    return { t: null, at: a };
  });
  // lines heard nowhere: between the neighbours, by words
  const known = raw.map((r, i) => (r.t !== null ? i : -1)).filter((i) => i >= 0);
  const lines = raw.map((r, i) => {
    if (r.t !== null || !known.length) return { t: r.t, text: texts[i] };
    const prev = known.filter((k) => k < i).at(-1), next = known.find((k) => k > i);
    if (prev === undefined) return { t: Math.max(0, raw[next].t - (raw[next].at - r.at) * avgWord * 1.2), text: texts[i] };
    if (next === undefined) return { t: raw[prev].t + (r.at - raw[prev].at) * avgWord * 1.2, text: texts[i] };
    const f = (r.at - raw[prev].at) / Math.max(1, raw[next].at - raw[prev].at);
    return { t: raw[prev].t + f * (raw[next].t - raw[prev].t), text: texts[i] };
  });
  // in order, a little apart
  for (let i = 1; i < lines.length; i++) if (lines[i].t !== null && lines[i - 1].t !== null && lines[i].t < lines[i - 1].t + 0.25) lines[i].t = lines[i - 1].t + 0.25;
  for (const l of lines) if (l.t !== null) l.t = Math.round(l.t * 100) / 100;
  const matched = words.length ? map.filter((j) => j >= 0).length / words.length : 0;
  return { lines, matched };
}

/**
 * Lines from heard words alone (no lyrics known): a new line after a pause, a sentence end, or
 * when the line gets long.
 * @param {{w: string, t: number, end?: number}[]} heard
 */
export function linesFromWords(heard, { maxChars = 42, pause = 0.7 } = {}) {
  const lines = [];
  let cur = null;
  for (let k = 0; k < heard.length; k++) {
    const h = heard[k];
    const word = String(h.w ?? '').trim();
    if (!word) continue;
    const prev = heard[k - 1];
    const gap = prev ? h.t - (prev.end ?? prev.t) : 0;
    if (!cur || gap > pause || cur.text.length + word.length + 1 > maxChars || /[.!?]$/.test(cur.text)) {
      cur = { t: Math.round(h.t * 100) / 100, text: word };
      lines.push(cur);
    } else cur.text += ` ${word}`;
  }
  return lines;
}
