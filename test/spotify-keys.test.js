// Spotify keys: those of another computer (a copied folder) are ignored, a new Client ID never keeps the
// previous secret or account, and an account the Spotify app does not accept is not kept as connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSpotifyKeys, readSpotifyKeys } from '../src/main/spotify-keys.js';
import { Spotify } from '../src/main/spotify.js';

const pc = (name) => ({
  encrypt: (t) => `${name}:${t}`,
  decrypt: (b) => { if (!b.startsWith(`${name}:`)) throw new Error('cannot decrypt'); return b.slice(name.length + 1); },
});
const a = pc('A'); const b = pc('B');
const saved = { clientId: 'ida', secret: 'A:sec', refresh: 'A:ref', user: 'Ann' };

test('keys are read on the computer that saved them; elsewhere nothing shows, Client ID included', () => {
  assert.deepEqual(readSpotifyKeys(saved, a.decrypt), { clientId: 'ida', secret: 'sec', refresh: 'ref', user: 'Ann', foreign: false });
  assert.deepEqual(readSpotifyKeys(saved, b.decrypt), { clientId: '', secret: null, refresh: null, user: null, foreign: true });
  assert.equal(readSpotifyKeys(null, a.decrypt).clientId, '');
  assert.equal(readSpotifyKeys({ clientId: 'ida' }, a.decrypt).clientId, 'ida', 'a Client ID alone (PKCE sign-in)');
});

test('a new Client ID drops the previous secret and account; the same one keeps them', () => {
  assert.deepEqual(nextSpotifyKeys(saved, { clientId: 'idb', secret: '' }, a), { clientId: 'idb', secret: null });
  assert.deepEqual(nextSpotifyKeys(saved, { clientId: 'idb', secret: 'new' }, a), { clientId: 'idb', secret: 'A:new' });
  assert.deepEqual(nextSpotifyKeys(saved, { clientId: 'ida', secret: '' }, a), { clientId: 'ida', secret: 'A:sec', refresh: 'A:ref', user: 'Ann' });
  assert.deepEqual(nextSpotifyKeys(saved, { clientId: 'ida', secret: 'mine' }, b), { clientId: 'ida', secret: 'B:mine' }, 'another computer: nothing kept');
  assert.equal(nextSpotifyKeys(saved, { clientId: '', secret: '' }, a), null);
});

test('sign-in refused by the Spotify app (403: not on its list): a clear message, not left connected', async () => {
  let refresh = null;
  const sp = new Spotify({
    credentials: () => ({ clientId: 'cid', secret: null }),
    account: { get: () => refresh, set: async (r) => { refresh = r; } },
    fetch: async (url) => (String(url).includes('/api/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 't', refresh_token: 'r', expires_in: 3600 }) }
      : { ok: false, status: 403, json: async () => ({}) }),
  });
  const open = async (u) => {
    const state = new URL(u).searchParams.get('state');
    setTimeout(() => fetch(`http://127.0.0.1:8888/callback?code=c&state=${state}`).catch(() => {}), 50);
  };
  await assert.rejects(sp.signIn(open), /refused this account/);
  assert.equal(refresh, null);
  assert.equal(sp.signedIn, false);
});
