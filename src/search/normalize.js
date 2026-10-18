// Search-form normalization, modelled on Rekordbox's MultipurposeString::formatForSearch
// (rekordbox.exe 7.2.18 @ 0x141d70f80): NFKD -> extra letter folds -> uppercase,
// plus a 56-bit character-class mask used as a fast pre-reject before substring tests.

// Letters NFKD does not decompose; Rekordbox folds them with findAndReplace (0x1427eaf40).
const EXTRA_FOLDS = new Map([
  ['Ð', 'D'], ['ð', 'D'], // Ð ð
  ['ƒ', 'F'],                  // ƒ
  ['ı', 'I'],                  // ı
  ['Ø', 'O'], ['ø', 'O'], // Ø ø
]);
const EXTRA_FOLD_RE = /[ÐðƒıØø]/g;
const COMBINING_MARK_RE = /\p{Mn}/gu;
// Katakana U+30A1..U+30F6 sit exactly 0x60 above hiragana U+3041..U+3096.
const KATAKANA_RE = /[ァ-ヶ]/g;

/**
 * @typedef {object} NormalizeOptions
 * @property {boolean} [foldAccents=false] Strip combining marks so accents match both ways.
 *   Rekordbox does NOT do this: "cafe" finds "café", but "café" does not find "cafe".
 * @property {boolean} [foldKana=false] Map katakana to hiragana. Rekordbox does NOT do this.
 */

/**
 * Normalize a string into its search form.
 * @param {string} text
 * @param {NormalizeOptions} [options]
 * @returns {string}
 */
export function normalizeForSearch(text, options = {}) {
  let s = String(text ?? '').normalize('NFKD');
  s = s.replace(EXTRA_FOLD_RE, (c) => EXTRA_FOLDS.get(c));
  if (options.foldAccents) s = s.replace(COMBINING_MARK_RE, '');
  if (options.foldKana) s = s.replace(KATAKANA_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return s.toUpperCase();
}

/**
 * Bucket index for one UTF-16 code unit (same scheme as the loop at 0x141d71433).
 * @param {number} c
 */
function charClassBit(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;      // '0'-'9' -> 0..9
  if (c >= 0x41 && c <= 0x5A) return c - 0x41 + 10; // 'A'-'Z' -> 10..35
  if (c <= 0x7F) return 36;
  if (c <= 0xFF) return 37;
  if (c <= 0x2FF) return 38;
  if (c <= 0xFFF) return 39;
  if (c >= 0xD800 && c <= 0xDFFF) return 55;
  return 40 + ((c - 0x1000) >> 12);
}

/**
 * Character-class mask of a normalized string, split into two 32-bit halves
 * (bits 0..31 in `lo`, 32..55 in `hi`) to avoid BigInt in the hot path.
 * @param {string} norm
 * @returns {{lo: number, hi: number}}
 */
export function charClassMask(norm) {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < norm.length; i++) {
    const bit = charClassBit(norm.charCodeAt(i));
    if (bit < 32) lo |= 1 << bit;
    else hi |= 1 << (bit - 32);
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

/** A string kept in its original form, its search form, and its character-class mask. */
export class SearchString {
  /**
   * @param {string} original
   * @param {NormalizeOptions} [options]
   */
  constructor(original, options) {
    this.original = String(original ?? '');
    this.norm = normalizeForSearch(this.original, options);
    const { lo, hi } = charClassMask(this.norm);
    this.maskLo = lo;
    this.maskHi = hi;
  }

  /**
   * Substring test (MultipurposeString::contains @ 0x141f255c0): reject if the token uses a
   * character class this field lacks, otherwise do a plain substring search.
   * @param {SearchString} token
   */
  contains(token) {
    if ((token.maskLo & ~this.maskLo) !== 0 || (token.maskHi & ~this.maskHi) !== 0) return false;
    return this.norm.includes(token.norm);
  }
}
