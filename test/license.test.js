import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { licenseStatus, maskKey, TRIAL_DAYS, OFFLINE_DAYS } from '../src/shared/license.js';
import { LicenseManager } from '../src/main/license.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 21);

test('trial: days left from the first run, over after TRIAL_DAYS, clock set back ends it', () => {
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0), { mode: 'trial', daysLeft: TRIAL_DAYS, afterBeta: false });
  assert.equal(licenseStatus({ firstRun: T0 }, T0 + 13.5 * DAY).daysLeft, 1);
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0 + TRIAL_DAYS * DAY), { mode: 'expired', reason: 'trial', afterBeta: false });
  assert.equal(licenseStatus({ firstRun: T0, lastSeen: T0 + 5 * DAY }, T0 + 2 * DAY).reason, 'clock');
});

test('open beta: free until its end, then 14 days for beta users; new users after it get a normal trial', () => {
  const betaEndsAt = T0 + 60 * DAY;
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0 + DAY, { betaEndsAt }), { mode: 'beta', daysLeft: 59 });
  const after = licenseStatus({ firstRun: T0 }, betaEndsAt + 2 * DAY, { betaEndsAt });
  assert.deepEqual(after, { mode: 'trial', daysLeft: TRIAL_DAYS - 2, afterBeta: true });
  assert.equal(licenseStatus({ firstRun: T0 }, betaEndsAt + TRIAL_DAYS * DAY, { betaEndsAt }).reason, 'trial');
  assert.deepEqual(licenseStatus({ firstRun: betaEndsAt + 5 * DAY }, betaEndsAt + 6 * DAY, { betaEndsAt }), { mode: 'trial', daysLeft: TRIAL_DAYS - 1, afterBeta: false });
  // A key works during the beta too; a clock set back ends the beta.
  assert.equal(licenseStatus({ firstRun: T0, key: 'k', instanceId: 'i', validatedAt: T0 }, T0 + DAY, { betaEndsAt }).mode, 'licensed');
  assert.equal(licenseStatus({ firstRun: T0, lastSeen: T0 + 10 * DAY }, T0 + 5 * DAY, { betaEndsAt }).reason, 'clock');
});

test('donation / buy links from the website config: https only, offline keeps the built-in ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const product = { name: 'Reboxed', price: '10 €', buyUrl: 'https://shop/buy', donateUrl: null };
  const cfg = (body) => async () => ({ ok: true, json: async () => body });
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: cfg({ donateUrl: 'https://ko-fi.com/reboxed', buyUrl: 'javascript:alert(1)' }), instanceName: 'PC', product });
  await lm.load();
  await lm.loadRemoteConfig();
  assert.equal(lm.status().product.donateUrl, 'https://ko-fi.com/reboxed');
  assert.equal(lm.status().product.buyUrl, 'https://shop/buy');
  lm.fetch = async () => { throw new Error('offline'); };
  await lm.loadRemoteConfig();
  assert.equal(lm.status().product.donateUrl, 'https://ko-fi.com/reboxed');
});

test('developer build (run from the source) needs no licence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: fakeApi().fetch, instanceName: 'PC', dev: true, now: () => T0 + 400 * DAY });
  assert.equal((await lm.load()).mode, 'dev');
});

test('licensed: works offline for OFFLINE_DAYS, asks for a check after a week, revoked keys stop', () => {
  const st = { firstRun: T0 - 100 * DAY, key: 'k', instanceId: 'i', validatedAt: T0 };
  assert.deepEqual(licenseStatus(st, T0 + DAY), { mode: 'licensed', needsCheck: false });
  assert.equal(licenseStatus(st, T0 + 8 * DAY).needsCheck, true);
  assert.equal(licenseStatus(st, T0 + (OFFLINE_DAYS + 1) * DAY).reason, 'offline');
  assert.equal(licenseStatus({ ...st, revoked: true }, T0).reason, 'revoked');
  assert.equal(maskKey('38b1460a-5104-4067-a91d-77b872934d51'), '••••-4d51');
});

/** Lemon Squeezy License API stand-in. */
function fakeApi({ keys = { GOOD: { store_id: 1, product_id: 2 } }, offline = false } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    if (offline) throw new Error('getaddrinfo ENOTFOUND');
    const action = url.split('/').pop();
    const p = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ action, ...p });
    const meta = keys[p.license_key];
    const json = (status, body) => ({ status, json: async () => body });
    if (!meta) return json(404, { activated: false, valid: false, error: 'license_key not found.' });
    if (action === 'activate') return json(200, { activated: true, error: null, instance: { id: `inst-${p.instance_name}` }, meta: { ...meta, customer_name: 'DJ Test' } });
    if (action === 'validate') return json(200, { valid: true, error: null, license_key: { status: 'active' }, meta });
    return json(200, { deactivated: true, error: null });
  };
  return { fetch, calls };
}

test('activate / validate / deactivate against the License API, product checked, offline tolerated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  let now = T0;
  const api = fakeApi();
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: api.fetch, instanceName: 'PC', now: () => now, product: { name: 'Reboxed', price: '10 €', buyUrl: null, storeId: 1, productId: 2 } });
  assert.equal((await lm.load()).mode, 'trial');
  await assert.rejects(() => lm.activate('BAD'), /license_key not found/);
  const st = await lm.activate(' GOOD ');
  assert.equal(st.mode, 'licensed');
  assert.equal(st.customer, 'DJ Test');
  assert.deepEqual(api.calls[1], { action: 'activate', license_key: 'GOOD', instance_name: 'PC' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'license.json'), 'utf8')).instanceId, 'inst-PC');
  // A week later the key is re-checked; offline it keeps working.
  now += 8 * DAY;
  assert.equal(lm.status().needsCheck, true);
  assert.equal((await lm.validate()).needsCheck, false);
  lm.fetch = fakeApi({ offline: true }).fetch;
  now += 10 * DAY;
  assert.equal((await lm.validate()).mode, 'licensed');
  // Deactivate frees the computer; the trial does not start again.
  lm.fetch = api.fetch;
  const off = await lm.deactivate();
  assert.equal(off.mode, 'expired');
  assert.equal(api.calls.at(-1).action, 'deactivate');
});

test('a key of another product is refused and its activation released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const api = fakeApi({ keys: { OTHER: { store_id: 9, product_id: 9 } } });
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: api.fetch, instanceName: 'PC', product: { storeId: 1, productId: 2 } });
  await lm.load();
  await assert.rejects(() => lm.activate('OTHER'), /not a Reboxed licence/);
  assert.deepEqual(api.calls.map((c) => c.action), ['activate', 'deactivate']);
  assert.equal(lm.status().mode, 'trial');
});
