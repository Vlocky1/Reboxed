// The user's Spotify keys as saved in location.json: {clientId, secret, refresh, user}; secret and refresh
// are encrypted for this Windows account (safeStorage). A folder copied from another computer brings keys
// that cannot be decrypted here: they belong to someone else and are ignored (Client ID included).

const EMPTY = { clientId: '', secret: null, refresh: null, user: null, foreign: false };

/** @param {object|null} saved @param {(base64: string) => string} decrypt throws when not made here */
export function readSpotifyKeys(saved, decrypt) {
  if (!saved?.clientId) return { ...EMPTY };
  try {
    const secret = saved.secret ? decrypt(saved.secret) : null;
    const refresh = saved.refresh ? decrypt(saved.refresh) : null;
    return { clientId: saved.clientId, secret, refresh, user: refresh ? saved.user ?? null : null, foreign: false };
  } catch {
    return { ...EMPTY, foreign: true };
  }
}

/**
 * What to save after the user's entry. The saved secret and account stay only with the same Client ID
 * (and only when they are this computer's): another app never gets the previous one's secret.
 */
export function nextSpotifyKeys(saved, { clientId, secret }, { encrypt, decrypt }) {
  if (!clientId) return null;
  const mine = !readSpotifyKeys(saved, decrypt).foreign && saved?.clientId === clientId;
  return {
    clientId,
    secret: secret ? encrypt(secret) : (mine ? saved.secret ?? null : null),
    ...(mine ? { refresh: saved.refresh ?? null, user: saved.user ?? null } : {}),
  };
}
