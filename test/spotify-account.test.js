// Spotify account (Authorization Code + PKCE): sign-in URL, callback, token refresh, whole playlists
// as the user (paged), the user's playlists; stand-in fetch, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Spotify, pkcePair, authorizeUrl, itemTrack, waitForCode, REDIRECT_URI, covers, isCoverUrl } from '../src/main/spotify.js';

test('covers: a small one (≥ 64 px) for lists, the largest for the collection; hosts allowed', () => {
  const imgs = [{ url: 'L', width: 640, height: 640 }, { url: 'M', width: 300, height: 300 }, { url: 'S', width: 64, height: 64 }];
  assert.deepEqual(covers(imgs), { cover: 'S', coverLarge: 'L' });
  assert.deepEqual(covers([{ url: 'L', width: 640 }, { url: 'T', width: 32 }]), { cover: 'L', coverLarge: 'L' }, 'nothing under 64 px is used in lists');
  assert.deepEqual(covers([{ url: 'A', width: null }, { url: 'B', width: null }]), { cover: 'B', coverLarge: 'A' }, 'no widths: Spotify order (largest first)');
  assert.deepEqual(covers([]), { cover: '', coverLarge: '' });
  assert.deepEqual(covers(undefined), { cover: '', coverLarge: '' });
  for (const ok of ['https://i.scdn.co/image/ab67616d0000b273', 'https://mosaic.scdn.co/640/ab67', 'https://image-cdn-ak.spotifycdn.com/image/ab67', 'https://image-cdn-fa.spotifycdn.com/image/x', 'https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg']) assert.ok(isCoverUrl(ok), ok);
  for (const no of ['http://i.scdn.co/image/x', 'https://evil.example/i.scdn.co/x', 'https://i.scdn.co.evil.example/x', 'file:///C:/x.jpg']) assert.ok(!isCoverUrl(no), no);
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const tr = (n) => ({ name: `Track ${n}`, id: `id${n}`, duration_ms: 200000 + n, artists: [{ name: 'Artist' }], album: { images: [{ url: 'big' }, { url: 'small' }] } });

test('PKCE pair and the sign-in URL', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  const u = new URL(authorizeUrl({ clientId: 'cid', challenge, state: 'st' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.match(u.searchParams.get('scope'), /playlist-read-private/);
});

test('playlist items: 2026 "item" and older "track" shapes; local files and episodes left out', () => {
  assert.equal(itemTrack({ item: tr(1) }).title, 'Track 1');
  assert.equal(itemTrack({ track: tr(2) }).spotifyId, 'id2');
  assert.equal(itemTrack({ item: { ...tr(3), is_local: true } }), null);
  assert.equal(itemTrack({ item: { ...tr(4), type: 'episode' } }), null);
});

test('signed in: the whole playlist (paged), the token refreshed and rotated', async () => {
  let refresh = 'r1';
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    if (url.includes('/api/token')) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), 'cid');
      return json({ access_token: 'user-token', expires_in: 3600, refresh_token: 'r2' });
    }
    assert.equal(opts.headers.Authorization, 'Bearer user-token');
    if (url.includes('fields=name')) return json({ name: 'Big list' });
    const page = Number(new URL(url).searchParams.get('offset') ?? 0);
    const items = Array.from({ length: page < 100 ? 50 : 30 }, (_, k) => ({ item: tr(page + k) }));
    return json({ items, next: page < 100 ? `https://api.spotify.com/v1/playlists/P1234567890123456789/items?limit=50&offset=${page + 50}` : null });
  };
  const sp = new Spotify({ credentials: () => ({ clientId: 'cid', secret: 's' }), account: { get: () => refresh, set: async (r) => { refresh = r; } }, fetch });
  const r = await sp.playlist('https://open.spotify.com/playlist/P1234567890123456789', true);
  assert.equal(r.via, 'account');
  assert.equal(r.name, 'Big list');
  assert.equal(r.tracks.length, 130, 'all pages, beyond 100');
  assert.equal(refresh, 'r2', 'the rotated refresh token is kept');
  assert.equal(calls.filter((u) => u.includes('/api/token')).length, 1, 'one refresh for all pages');
});

test('not signed in: no account call (keys / public page as before); revoked account: signed out', async () => {
  const sp = new Spotify({ credentials: () => ({ clientId: 'cid', secret: 's' }), account: { get: () => null, set: async () => {} }, fetch: async () => json({}) });
  assert.equal(sp.signedIn, false);
  let refresh = 'old';
  const revoked = new Spotify({ credentials: () => ({ clientId: 'cid' }), account: { get: () => refresh, set: async (r) => { refresh = r; } }, fetch: async () => json({ error: 'invalid_grant' }, 400) });
  await assert.rejects(revoked.userAuth(), /connect it again/);
  assert.equal(refresh, null);
});

test('the user\'s playlists', async () => {
  const fetch = async (url) => (url.includes('/api/token') ? json({ access_token: 't', expires_in: 3600 })
    : json({ items: [{ id: 'a', name: 'Mine', items: { total: 143 }, owner: { display_name: 'Me' }, images: [{ url: 'c' }] }, null], next: null }));
  const sp = new Spotify({ credentials: () => ({ clientId: 'cid' }), account: { get: () => 'r', set: async () => {} }, fetch });
  const pls = await sp.myPlaylists();
  assert.deepEqual(pls, [{ id: 'a', name: 'Mine', url: 'https://open.spotify.com/playlist/a', total: 143, owner: 'Me', cover: 'c' }]);
});

test('the callback: the code with the right state; a refusal or another state is an error', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const ok = waitForCode({ state: 'abc', port, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const page = await fetch(`http://127.0.0.1:${port}/callback?code=THE_CODE&state=abc`);
  assert.match(await page.text(), /Spotify is connected/);
  assert.equal(await ok, 'THE_CODE');
  const bad = assert.rejects(waitForCode({ state: 'abc', port: port + 1, timeoutMs: 5000 }), /failed/);
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port + 1}/callback?code=X&state=other`);
  await bad;
  const denied = assert.rejects(waitForCode({ state: 'abc', port: port + 2, timeoutMs: 5000 }), /refused/);
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port + 2}/callback?error=access_denied&state=abc`);
  await denied;
});
