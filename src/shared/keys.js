// Musical key helpers: parsing tag text, Camelot / musical notation, harmonic relations.

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DISPLAY_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const DISPLAY_MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** @typedef {{tonic: number, mode: 'major'|'minor'}} Key */

/** Camelot code, e.g. A minor -> "8A", C major -> "8B". */
export function toCamelot({ tonic, mode }) {
  const steps = (((tonic - (mode === 'minor' ? 9 : 0)) * 7) % 12 + 12) % 12;
  return `${((7 + steps) % 12) + 1}${mode === 'minor' ? 'A' : 'B'}`;
}

/** Musical notation as Rekordbox shows it, e.g. "Am", "Db", "F#m". */
export function toMusical({ tonic, mode }) {
  return (mode === 'minor' ? DISPLAY_MINOR : DISPLAY_MAJOR)[tonic];
}

/**
 * Parse key text from tags or other apps: "8A", "08B", "Am", "A minor", "F#m", "Ebm", "A♭", "Gbmaj".
 * @param {string} text
 * @returns {Key|null}
 */
export function parseKey(text) {
  const s = String(text ?? '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s) return null;
  const camelot = /^0?(\d{1,2})\s*([ABab])$/.exec(s);
  if (camelot) {
    const n = Number(camelot[1]);
    if (n < 1 || n > 12) return null;
    const mode = camelot[2].toUpperCase() === 'A' ? 'minor' : 'major';
    const steps = (n - 8 + 12) % 12;
    const tonic = ((steps * 7) % 12 + (mode === 'minor' ? 9 : 0)) % 12;
    return { tonic, mode };
  }
  const musical = /^([A-Ga-g])\s*([#b]?)\s*(m|min|minor|maj|major|M)?$/i.exec(s);
  if (!musical) return null;
  let tonic = LETTER[musical[1].toUpperCase()];
  if (musical[2] === '#') tonic += 1;
  if (musical[2] === 'b') tonic += 11;
  const q = musical[3] ?? '';
  const mode = q === 'M' || /^maj/i.test(q) || q === '' ? 'major' : 'minor';
  return { tonic: tonic % 12, mode };
}

/** Normalised key code used for storage and filtering ("8A"), or '' if unknown. */
export function normalizeKeyText(text) {
  const k = parseKey(text);
  return k ? toCamelot(k) : '';
}

/** Display a stored Camelot code in the chosen notation. */
export function displayKey(camelot, notation = 'camelot') {
  if (!camelot) return '';
  if (notation === 'camelot') return camelot;
  const k = parseKey(camelot);
  return k ? toMusical(k) : camelot;
}

/** Harmonically compatible Camelot codes: same, +-1 on the wheel, relative major/minor. */
export function compatibleKeys(camelot) {
  const m = /^(\d{1,2})([AB])$/.exec(camelot ?? '');
  if (!m) return [];
  const n = Number(m[1]);
  const other = m[2] === 'A' ? 'B' : 'A';
  const wrap = (x) => ((x - 1 + 12) % 12) + 1;
  return [`${n}${m[2]}`, `${wrap(n - 1)}${m[2]}`, `${wrap(n + 1)}${m[2]}`, `${n}${other}`];
}

/** Shift a key by semitones (key shift pads). */
export function transposeKey(camelot, semitones) {
  const k = parseKey(camelot);
  if (!k) return camelot;
  return toCamelot({ tonic: (((k.tonic + semitones) % 12) + 12) % 12, mode: k.mode });
}

export const PITCH_NAMES = SHARP;
