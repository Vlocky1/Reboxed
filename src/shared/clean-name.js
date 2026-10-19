// Name cleaner: removes video / upload decorations from titles and artists — "(Paroles)",
// "[Official Video]", "| Lyrics", "Visualizer", "- Topic", "VEVO"… — and keeps what DJs need:
// mix names, remixes, edits, featurings, live versions. Downloads are cleaned when they join the
// collection; Preferences > Downloads holds the keyword list.

/** Default keywords (one word or a few words each); matched as whole words, case and accents ignored. */
export const DEFAULT_KEYWORDS = [
  'official', 'officiel', 'officielle', 'video', 'videoclip', 'clip', 'music video', 'lyrics', 'lyric', 'paroles', 'letra', 'testo',
  'audio', 'visualizer', 'visualiser', 'hd', 'hq', '4k', 'mv', 'm/v', 'color coded', 'karaoke', 'sub', 'subtitulado', 'traduction', 'vostfr',
];

/** Brackets with these words are never removed: they name the version of the track. */
const KEEP = /\b(mix|remix|edit|rework|bootleg|vip|dub|version|feat|ft|featuring|live|acoustic|unplugged|instrumental|extended|radio|remaster(ed)?|cover|prod)\b/i;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function keywordRe(keywords) {
  const words = (keywords?.length ? keywords : DEFAULT_KEYWORDS).map((k) => fold(k).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(`(^|[^a-z0-9])(${words.map(escape).join('|')})(?=$|[^a-z0-9])`, 'i');
}

/**
 * Clean a title.
 * @param {string} title
 * @param {string[]} [keywords]
 */
export function cleanTitle(title, keywords) {
  const kw = keywordRe(keywords);
  let s = String(title ?? '');
  // Bracket groups made of decoration words: "(Official Video)", "[Paroles]", "【MV】"…
  s = s.replace(/\s*[([{【]([^()[\]{}【】]*)[)\]}】]/g, (m, inner) => (kw.test(fold(inner)) && !KEEP.test(inner) ? '' : m));
  // Trailing decorations without brackets: "| Lyrics", "- Official Video", "Official Music Video", "#hashtags".
  s = s.replace(/\s+#[\p{L}\p{N}_]+/gu, '');
  for (let k = 0; k < 3; k++) {
    s = s.replace(/\s*(?:[|｜/•]|\s[-–—:]\s)\s*([^|｜/•]*)$/u, (m, tail) => (tail && kw.test(fold(tail)) && !KEEP.test(tail) && tail.split(/\s+/).length <= 5 ? '' : m));
    s = s.replace(/\s+((?:official|officiel(?:le)?)\s+)?(?:music\s+|lyrics?\s+)?(?:video|vid[ée]o|clip|audio|visuali[sz]er)\s*$/i, '');
  }
  return s.replace(/[([{]\s*[)\]}]/g, '').replace(/\s{2,}/g, ' ').replace(/[\s\-–—|:]+$/g, '').trim();
}

/** Clean an artist: YouTube channel suffixes ("- Topic", "VEVO", "Official"). */
export function cleanArtist(artist) {
  return String(artist ?? '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/\s+(official|officiel(le)?)( channel| page)?$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}

/**
 * Clean a track's name. "Artist - Title" titles are split when the artist is empty or is only the
 * uploading channel (same name, or a VEVO / Topic channel).
 * @param {{title?: string, artist?: string}} t
 * @param {string[]} [keywords]
 * @returns {{title: string, artist: string}}
 */
export function cleanTrackName(t, keywords) {
  let title = cleanTitle(t.title, keywords);
  let artist = cleanArtist(t.artist);
  const channel = /(vevo|-\s*topic|official)$/i.test(String(t.artist ?? '').trim());
  const dash = /\s[-–—]\s/.exec(title);
  if (dash) {
    const left = title.slice(0, dash.index).trim();
    const right = title.slice(dash.index + dash[0].length).trim();
    const same = fold(left).replace(/[^a-z0-9]/g, '') === fold(artist).replace(/[^a-z0-9]/g, '');
    if (left && right && !KEEP.test(right.split(/\s+/)[0] ?? '') && (!artist || same || channel)) {
      artist = cleanArtist(left);
      title = right;
    }
  }
  return { title: cleanTitle(title, keywords), artist };
}

/** Keyword list from the Preferences text ("a, b, c"); empty -> defaults. */
export const parseKeywords = (text) => {
  const list = String(text ?? '').split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_KEYWORDS;
};
