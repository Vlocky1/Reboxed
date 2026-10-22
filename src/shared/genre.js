// DJ genres from what online services say about a track. Discogs styles, MusicBrainz genres / tags
// and Deezer album genres are mapped to one DJ vocabulary, then vote: specific genres (Tech House)
// beat broad ones (Electronic, Dance), better sources count more, and a genre whose usual tempo
// does not fit the track's BPM loses most of its weight.

/**
 * DJ genre -> [words that mean it (lower case, after normalising), usual BPM range or null].
 * Order matters: the first rule matching a raw tag wins, so specific names come first.
 */
const RULES = [
  ['Melodic House & Techno', ['melodic techno', 'melodic house', 'melodic house techno', 'melodic house and techno'], [115, 130]],
  ['Afro House', ['afro house', 'afro tech'], [115, 128]],
  ['Organic House', ['organic house', 'organic downtempo'], [95, 124]],
  ['Tech House', ['tech house'], [120, 130]],
  ['Deep House', ['deep house'], [110, 126]],
  ['Progressive House', ['progressive house'], [118, 130]],
  ['Bass House', ['bass house'], [120, 130]],
  ['Future House', ['future house'], [120, 128]],
  ['Electro House', ['electro house', 'complextro', 'fidget house'], [124, 132]],
  ['Big Room', ['big room', 'big room house', 'mainstage'], [124, 132]],
  ['Jackin House', ['jackin house', 'jacking house', 'chicago house', 'ghetto house'], [118, 130]],
  ['Soulful House', ['soulful house', 'garage house', 'gospel house'], [115, 126]],
  ['Funky House', ['funky house', 'disco house', 'french house', 'filter house'], [115, 128]],
  ['Minimal / Deep Tech', ['minimal', 'minimal techno', 'deep tech', 'microhouse', 'minimal house'], [118, 130]],
  ['Hard Techno', ['hard techno', 'industrial techno', 'schranz'], [138, 165]],
  ['Peak Time Techno', ['peak time techno', 'driving techno', 'peak time driving'], [125, 145]],
  ['Techno', ['techno', 'detroit techno', 'acid techno', 'dub techno', 'raw techno', 'hypnotic techno'], [118, 150]],
  ['Psy-Trance', ['psy trance', 'psytrance', 'goa trance', 'progressive psytrance', 'full on'], [130, 150]],
  ['Trance', ['trance', 'uplifting trance', 'progressive trance', 'vocal trance', 'tech trance'], [124, 145]],
  ['Hardstyle', ['hardstyle', 'hard dance', 'rawstyle', 'hardcore', 'gabber', 'frenchcore'], [140, 200]],
  ['Drum & Bass', ['drum and bass', 'drum n bass', 'dnb', 'liquid funk', 'neurofunk', 'jump up', 'jungle'], [160, 180]],
  ['Dubstep', ['dubstep', 'brostep', 'riddim'], [135, 150]],
  ['UK Garage', ['uk garage', 'speed garage', '2 step', '2step', 'bassline'], [126, 140]],
  ['Breaks', ['breaks', 'breakbeat', 'nu skool breaks', 'big beat'], [110, 140]],
  ['Indie Dance', ['indie dance', 'nu disco indie', 'dark disco'], [110, 128]],
  ['Nu Disco', ['nu disco', 'nu-disco', 'disco edit', 'cosmic disco'], [110, 126]],
  ['Disco', ['disco', 'italo disco', 'euro disco', 'boogie'], [105, 130]],
  ['Amapiano', ['amapiano'], [105, 118]],
  ['Afrobeats', ['afrobeats', 'afrobeat', 'afropop', 'afro pop', 'afroswing'], [90, 120]],
  ['Reggaeton', ['reggaeton', 'dembow', 'latin urban', 'perreo'], [85, 105]],
  ['Latin', ['latin', 'salsa', 'bachata', 'cumbia', 'merengue', 'latin pop', 'moombahton'], null],
  ['Dancehall', ['dancehall', 'ragga'], [85, 110]],
  ['Reggae', ['reggae', 'roots reggae', 'dub'], [60, 100]],
  ['Trap', ['trap', 'edm trap', 'hybrid trap'], null],
  ['Hip-Hop', ['hip hop', 'hip-hop', 'rap', 'boom bap', 'gangsta', 'drill', 'grime', 'conscious'], [60, 115]],
  ['R&B', ['r b', 'rnb', 'r and b', 'contemporary r b', 'neo soul', 'soul'], [60, 115]],
  ['Funk', ['funk', 'p funk', 'g funk'], [90, 125]],
  ['Electro', ['electro', 'electro funk', 'miami bass'], [110, 135]],
  ['Downtempo', ['downtempo', 'chillout', 'chill out', 'trip hop', 'lo fi', 'lofi', 'chillwave'], [60, 110]],
  ['Ambient', ['ambient', 'drone', 'new age'], null],
  ['House', ['house', 'vocal house', 'tribal house', 'acid house', 'club house', 'dance house'], [115, 130]],
  ['Electronica', ['electronica', 'idm', 'leftfield', 'experimental electronic'], null],
  ['Dance / Pop', ['dance pop', 'electropop', 'electro pop', 'europop', 'euro house', 'eurodance', 'synth pop', 'synthpop', 'edm'], null],
  ['Pop', ['pop', 'k pop', 'j pop', 'teen pop', 'variete', 'chanson'], null],
  ['Rock', ['rock', 'indie rock', 'alternative', 'punk', 'metal', 'grunge', 'indie'], null],
  ['Jazz', ['jazz', 'nu jazz', 'acid jazz', 'swing'], null],
  ['Classical', ['classical', 'orchestral', 'soundtrack', 'score'], null],
  ['Country', ['country', 'folk', 'bluegrass'], null],
];

/**
 * Tags that say nothing precise: "Electro" on Deezer means any electronic music, not electro-funk.
 * They become "Electronic" (or keep their broad genre) and only win when nothing better is known.
 */
const GENERIC = new Set(['electronic', 'electro', 'dance', 'electronic dance music', 'club', 'dance music', 'edm', 'electronic music', 'clubbing',
  'techno house', 'dance electro', 'electro dance']); // Deezer's broad categories ("Techno/House")
const BROAD = new Set([...GENERIC, 'pop', 'instrumental', 'remix']);

/** Broad genre -> its precise kinds. */
const FAMILIES = {
  House: ['Tech House', 'Deep House', 'Progressive House', 'Bass House', 'Future House', 'Electro House', 'Big Room', 'Jackin House',
    'Soulful House', 'Funky House', 'Afro House', 'Organic House', 'Melodic House & Techno', 'Minimal / Deep Tech'],
  Techno: ['Peak Time Techno', 'Hard Techno', 'Melodic House & Techno', 'Minimal / Deep Tech'],
  Trance: ['Psy-Trance'],
  Disco: ['Nu Disco'],
  'Hip-Hop': ['Trap'],
  Electronica: ['Downtempo', 'Ambient'],
};

export const DJ_GENRES =[...RULES.map(([name]) => name), 'Electronic'];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** The DJ genre of one raw tag ("Tech-House", "techno, melodic"), or null. */
export function djGenre(raw) {
  const t = norm(raw);
  if (!t) return null;
  if (GENERIC.has(t)) return 'Electronic';
  for (const [name, words] of RULES) if (words.some((w) => t === norm(w))) return name;
  // "melodic techno / progressive", "dance / electro pop"…: the longest known name inside the tag.
  let best = null; let len = 0;
  for (const [name, words] of RULES) {
    for (const w of words) {
      const n = norm(w);
      if (n.length > 4 && n.length > len && ` ${t} `.includes(` ${n} `)) { best = name; len = n.length; }
    }
  }
  return best;
}

const rangeOf = (name) => RULES.find(([n]) => n === name)?.[2] ?? null;

/** Does a BPM fit a genre (also at half or double time: 87 BPM drum & bass is 174)? */
export function bpmFits(name, bpm) {
  const r = rangeOf(name);
  if (!r || !bpm) return true;
  return [bpm, bpm * 2, bpm / 2].some((b) => b >= r[0] - 3 && b <= r[1] + 3);
}

/** Weight of each source: Discogs styles are the most precise for club music. */
export const SOURCE_WEIGHT = { discogs: 3, musicbrainz: 2, deezer: 1, spotify: 1 };

/**
 * The DJ genre the sources agree on.
 * @param {{source: string, tags: string[], weights?: number[]}[]} votes raw tags per source (first = main)
 * @param {{bpm?: number}} [track]
 * @returns {{genre: string, score: number, ranked: {genre: string, score: number}[]} | null}
 */
export function chooseGenre(votes, { bpm = 0 } = {}) {
  const score = new Map();
  for (const v of votes) {
    const w = SOURCE_WEIGHT[v.source] ?? 1;
    // Within one source, a genre counts once: its best tag, plus a little for each other tag of it
    // ("rock" + "alternative rock" is not twice as much rock).
    const mine = new Map();
    v.tags.forEach((tag, i) => {
      const g = djGenre(tag);
      if (!g) return;
      const broad = BROAD.has(norm(tag));
      // Earlier tags of a source matter more; the tag's own weight (MusicBrainz vote count) too.
      const s = w * (broad ? 0.35 : 1) * (1 / (1 + i * 0.25)) * (v.weights?.[i] ?? 1);
      const prev = mine.get(g);
      mine.set(g, prev ? { best: Math.max(prev.best, s), extra: prev.extra + Math.min(prev.best, s) } : { best: s, extra: 0 });
    });
    for (const [g, { best, extra }] of mine) score.set(g, (score.get(g) ?? 0) + best + (g === 'Electronic' ? 0 : 0.25 * extra));
  }
  // A genre whose usual tempo does not fit the BPM goes as soon as one that fits is there (or keeps a
  // small weight when nothing fits); then "Electronic" is only the answer when nothing more precise is left.
  const fits = [...score.keys()].filter((g) => bpmFits(g, bpm));
  for (const g of [...score.keys()]) if (!bpmFits(g, bpm)) { if (fits.length) score.delete(g); else score.set(g, score.get(g) * 0.15); }
  if ([...score.keys()].some((g) => g !== 'Electronic')) score.delete('Electronic');
  // A parent genre backs its precise child instead of competing with it: "House" + "Tech House"
  // is Tech House.
  for (const [parent, children] of Object.entries(FAMILIES)) {
    if (!score.has(parent)) continue;
    const child = children.filter((c) => score.has(c)).sort((a, b) => score.get(b) - score.get(a))[0];
    if (!child) continue;
    score.set(child, score.get(child) + 0.6 * score.get(parent));
    score.set(parent, score.get(parent) * 0.4);
  }
  const ranked = [...score].map(([genre, s]) => ({ genre, score: Math.round(s * 100) / 100 })).sort((a, b) => b.score - a.score);
  return ranked.length ? { genre: ranked[0].genre, score: ranked[0].score, ranked } : null;
}
