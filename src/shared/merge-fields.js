// Merging duplicates field by field: for each piece of information (title, cues, beatgrid,
// rating…), the user ticks the track whose value the kept track gets. The kept track is the audio
// file that stays; the others leave the collection (their files are not touched).

/** The information that can be picked, in the order shown. `fields`: what a pick copies. */
export const MERGE_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'genre', label: 'Genre' },
  { key: 'label', label: 'Label' },
  { key: 'year', label: 'Year' },
  { key: 'key', label: 'Key' },
  { key: 'grid', label: 'BPM & beatgrid', fields: ['bpm', 'beatgrid', 'dynamicGrid', 'gridLocked'] },
  { key: 'cues', label: 'Cues' },
  { key: 'rating', label: 'Rating' },
  { key: 'color', label: 'Colour' },
  { key: 'comments', label: 'Comments' },
  { key: 'myTags', label: 'My tags' },
  { key: 'artwork', label: 'Cover' },
];

const fieldsOf = (f) => f.fields ?? [f.key];
const empty = (v) => v === undefined || v === null || v === '' || v === 0 || (Array.isArray(v) && !v.length);

/** Does this track hold something for this information? */
export const hasValue = (t, f) => fieldsOf(f).some((k) => !empty(t?.[k]));

/** A short text for a value (shown next to its tick box). */
export function fieldText(t, f) {
  if (!hasValue(t, f)) return '—';
  switch (f.key) {
    case 'grid': return `${Number(t.bpm ?? t.beatgrid?.bpm ?? 0).toFixed(2)} BPM${t.beatgrid?.beats ? ' · variable' : ''}${t.gridLocked ? ' · locked' : ''}`;
    case 'cues': {
      const hot = (t.cues ?? []).filter((c) => c.num >= 0 && c.type !== 'memory').length;
      return `${t.cues.length} cue${t.cues.length > 1 ? 's' : ''}${hot ? ` (${hot} hot)` : ''}`;
    }
    case 'rating': return '★'.repeat(Math.max(0, Math.min(5, t.rating)));
    case 'myTags': return t.myTags.join(', ');
    case 'artwork': return 'cover';
    default: return String(t[f.key]);
  }
}

/**
 * The ticks to start from: the kept track's own value when it has one, else the first other track
 * that has one (so nothing is lost unless the user unticks it).
 * @returns {Record<string, string>} information key → id of the track it comes from
 */
export function defaultPicks(keep, others) {
  const picks = {};
  for (const f of MERGE_FIELDS) {
    const from = hasValue(keep, f) ? keep : others.find((t) => hasValue(t, f)) ?? keep;
    picks[f.key] = from.id;
  }
  return picks;
}

/**
 * What the kept track becomes: each picked information copied from its track (an empty pick
 * clears it). Plays are added up, whatever is picked.
 * @param {object} keep the track that stays
 * @param {object[]} tracks all tracks of the group (keep included)
 * @param {Record<string, string>} picks from defaultPicks, changed by the user
 */
export function pickedPatch(keep, tracks, picks) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const patch = {};
  for (const f of MERGE_FIELDS) {
    const from = byId.get(picks[f.key]) ?? keep;
    if (from.id === keep.id) continue;
    for (const k of fieldsOf(f)) patch[k] = from[k] ?? null;
  }
  patch.playCount = tracks.reduce((n, t) => n + (t.playCount ?? 0), 0);
  return patch;
}
