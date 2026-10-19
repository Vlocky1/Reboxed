// "Date Added": the day (dateAdded, YYYY-MM-DD, as rekordbox) and, for tracks added since 1.5,
// the exact moment (addedAt, ms) so the time can be shown too.

export const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "HH:MM" when the moment of adding is known (and falls on dateAdded), else null. */
export function addedTime(t) {
  if (!t?.addedAt) return null;
  const d = new Date(t.addedAt);
  if (t.dateAdded && localDay(d) !== t.dateAdded) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "2026-10-19 14:32" (date only for tracks added before times were kept). */
export const dateAddedText = (t) => [t?.dateAdded, addedTime(t)].filter(Boolean).join(' ');
