// Language of the interface: English (the texts in the code) or French (lang/fr.js).
// Only texts written in the code are translated, by wrapping them: tx('Save'), tx`Deck ${n}`. Names of
// tracks, playlists, artists… are data and never go through here. A text with no translation stays in
// English. The language is read once, when the page starts (a change reloads the window).
import { FR } from './lang/fr.js';

export const LANG_KEY = 'reboxed.lang';

/**
 * The language to use. choice: 'auto' | 'en' | 'fr' (saved); auto follows Windows. The smoke test and
 * the screenshots stay in English unless the address asks for another one (?lang=fr).
 */
export function pickLang({ choice = 'auto', system = 'en', search = '' } = {}) {
  const q = new URLSearchParams(search);
  if (q.get('lang') === 'fr' || q.get('lang') === 'en') return q.get('lang');
  if (q.has('smoke') || q.has('shots')) return 'en';
  if (choice === 'fr' || choice === 'en') return choice;
  return /^fr\b/i.test(system) ? 'fr' : 'en';
}

/** The saved choice ('auto' when none). */
export function langChoice() {
  try { const c = localStorage.getItem(LANG_KEY); return c === 'fr' || c === 'en' ? c : 'auto'; } catch { return 'auto'; }
}

export function saveLangChoice(choice) {
  try { if (choice === 'auto') localStorage.removeItem(LANG_KEY); else localStorage.setItem(LANG_KEY, choice); } catch { /* private storage */ }
}

// Pages only (no window: main process, workers, tests -> English).
export const lang = typeof window === 'undefined' || typeof localStorage === 'undefined' ? 'en'
  : pickLang({ choice: langChoice(), system: globalThis.navigator?.language ?? 'en', search: globalThis.location?.search ?? '' });

/** Locale of dates and numbers. */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';

const fill = (text, values) => text.replace(/\{(\d+)\}/g, (_m, i) => String(values[i]));
const keys = new WeakMap(); // template strings array -> dictionary key

/** Dictionary key of a template: its fixed parts, with {0}, {1}… for the values. */
export const templateKey = (strings) => strings.reduce((s, part, i) => s + (i ? `{${i - 1}}` : '') + part, '');

/** Translate into a language: tr(dict)('Save'), tr(dict)`Deck ${n}`. dict null = English. */
export function translator(dict) {
  return (text, ...values) => {
    if (!Array.isArray(text)) return (dict && dict[text]) ?? text;
    if (!dict) return text.reduce((s, part, i) => s + (i ? String(values[i - 1]) : '') + part, '');
    let key = keys.get(text);
    if (key === undefined) keys.set(text, (key = templateKey(text)));
    return fill(dict[key] ?? key, values);
  };
}

/** The interface's own translator. */
export const tx = translator(lang === 'fr' ? FR : null);

// ---- messages made elsewhere (errors of the main process) ------------------------------------------

let patterns = null;
/** Translate a whole message already put together, e.g. "Spotify error 429" (dict null = unchanged). */
export function translateMessage(msg, dict) {
  if (!dict) return msg;
  if (dict[msg] !== undefined) return dict[msg];
  patterns ??= Object.entries(dict).filter(([k]) => /\{\d+\}/.test(k) && k.replace(/\{\d+\}/g, '').replace(/[^\p{L}]/gu, '').length >= 8)
    .map(([k, v]) => ({
      re: new RegExp(`^${k.split(/\{\d+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')}$`, 's'),
      order: [...k.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])), v,
    }));
  for (const p of patterns) {
    const m = p.re.exec(msg);
    if (m) { const values = []; p.order.forEach((n, i) => { values[n] = m[i + 1]; }); return fill(p.v, values); }
  }
  return msg;
}

/** An error as the user reads it: without Electron's prefix, in their language. */
export function errText(err) {
  const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return translateMessage(msg, lang === 'fr' ? FR : null);
}
