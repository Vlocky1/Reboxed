// "Ask for a track": rank YouTube search results so the first proposal is the right recording from
// an official source. Pure functions (tested under Node).
//   official audio  : "<Artist> - Topic" channels (YouTube Music, uploaded by the label/distributor)
//   artist channel  : the channel named after the artist (also "<Artist>VEVO")
// Versions nobody asked for (live, cover, remix, sped up, lyrics channels...) go down the list.

/** Lower case, no accents, letters and digits only ("Fred again . ." -> "fredagain"). */
export function normName(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const words = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length > 1 || /\d/.test(w));

/** "Artist - Title" (also "Title by Artist"); artists split on , & feat x. */
export function parseRequest(text) {
  const raw = String(text ?? '').trim();
  let artist = ''; let title = raw;
  const dash = raw.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) { artist = dash[0]; title = dash.slice(1).join(' - '); } else {
    const by = /^(.*)\s+by\s+(.+)$/i.exec(raw);
    if (by) { title = by[1]; artist = by[2]; }
  }
  const artists = artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b|\bwith\b)\s*/i).map(normName).filter(Boolean);
  return { raw, artist: artist.trim(), title: title.trim(), artists };
}

// Unwanted versions unless the request mentions them: [pattern, penalty].
const VERSIONS = [
  [/\blive\b|\bconcert\b|\bsession\b/, 30], [/\bcover\b/, 35], [/\bremix\b|\brmx\b|\bbootleg\b|\bflip\b/, 25],
  [/sped ?up|speed ?up|\bslowed\b|\breverb\b|nightcore|\b8d\b/, 40], [/\bkaraoke\b|\binstrumental\b/, 30],
  [/\breaction\b|\btutorial\b|\bhow to\b/, 45], [/\bfull album\b|\b1 hour\b|\b10 hours?\b|\bloop\b/, 40],
  [/\blyrics?\b|\blyric video\b|\bparoles\b/, 8], [/\bacoustic\b|\bpiano version\b/, 20],
];

/**
 * @param {{title: string, channel: string, duration?: number, views?: number, verified?: boolean}} item
 * @param {ReturnType<typeof parseRequest>} req
 * @returns {{score: number, official: 'topic'|'artist'|'vevo'|null}}
 */
export function scoreCandidate(item, req) {
  let score = 0;
  let official = null;
  const channelRaw = String(item.channel ?? '');
  const topic = /\s-\s*topic$/i.test(channelRaw);
  const ch = normName(channelRaw.replace(/\s-\s*topic$/i, ''));
  const vevo = /vevo$/.test(ch);
  const chBase = vevo ? ch.replace(/vevo$/, '') : ch;
  const isArtist = req.artists.length > 0 && req.artists.some((a) => a && (a === chBase || (a.length > 3 && chBase.startsWith(a) && chBase.length - a.length <= 8)));
  if (isArtist && topic) { score += 60; official = 'topic'; } else if (isArtist && vevo) { score += 48; official = 'vevo'; } else if (isArtist) { score += 52; official = 'artist'; }
  if (item.verified) score += 4;

  const t = String(item.title ?? '').toLowerCase();
  const titleWords = words(item.title);
  const want = words(req.title || req.raw);
  if (want.length) score += 30 * (want.filter((w) => titleWords.includes(w)).length / want.length);
  if (req.artists.length && req.artists.some((a) => normName(item.title).includes(a))) score += 8;

  const asked = String(req.raw).toLowerCase();
  for (const [re, penalty] of VERSIONS) if (re.test(t) && !re.test(asked)) score -= penalty;
  // DJ-friendly: audio uploads (title only, as on Topic channels) and original / extended mixes.
  if (/official (audio|visuali[sz]er)/.test(t)) score += 8;
  if (req.title && normName(item.title) === normName(req.title)) score += 6;
  if (/\b(original|extended|club) mix\b/.test(t)) score += 5;

  const d = item.duration ?? 0;
  if (d && d > 12 * 60 && !/\bmix\b|\bset\b/.test(asked)) score -= 30;
  if (d && d < 60) score -= 30;
  if (item.views) score += Math.min(6, Math.log10(item.views + 1));
  return { score, official };
}

/** Best first. */
export function rankCandidates(items, text) {
  const req = parseRequest(text);
  return items.map((item) => ({ ...item, ...scoreCandidate(item, req) })).sort((a, b) => b.score - a.score);
}
