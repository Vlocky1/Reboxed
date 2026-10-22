import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { licenseStatus, maskKey, TRIAL_DAYS, OFFLINE_DAYS } from '../src/shared/license.js';
import { LicenseManager } from '../src/main/license.js';
import { isBetaKey } from '../src/shared/product.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 21);

test('trial (no beta): days left from the first run, over after TRIAL_DAYS, clock set back ends it', () => {
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0), { mode: 'trial', daysLeft: TRIAL_DAYS });
  assert.equal(licenseStatus({ firstRun: T0 }, T0 + 13.5 * DAY).daysLeft, 1);
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0 + TRIAL_DAYS * DAY), { mode: 'expired', reason: 'trial' });
  assert.equal(licenseStatus({ firstRun: T0, lastSeen: T0 + 5 * DAY }, T0 + 2 * DAY).reason, 'clock');
});

test('open beta: free until its end (or with a beta key when required); testers then need the licence, newcomers get a trial', () => {
  const betaEndsAt = T0 + 70 * DAY;
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0 + DAY, { betaEndsAt }), { mode: 'beta', daysLeft: 69 });
  assert.deepEqual(licenseStatus({ firstRun: T0 }, T0 + DAY, { betaEndsAt, betaKeyRequired: true }), { mode: 'expired', reason: 'betaKey' });
  const betaKey = { firstRun: T0, key: 'b', keyKind: 'beta', instanceId: 'i', validatedAt: T0 };
  assert.deepEqual(licenseStatus(betaKey, T0 + DAY, { betaEndsAt, betaKeyRequired: true }), { mode: 'beta', daysLeft: 69, registered: true, needsCheck: false });
  // The beta is over: no extra days for testers (with or without a beta key).
  assert.deepEqual(licenseStatus({ ...betaKey, validatedAt: betaEndsAt - DAY }, betaEndsAt + 1, { betaEndsAt }), { mode: 'expired', reason: 'betaOver', betaTester: true });
  assert.deepEqual(licenseStatus({ firstRun: T0 }, betaEndsAt + 1, { betaEndsAt }), { mode: 'expired', reason: 'betaOver', betaTester: true });
  // Newcomers after the beta: the normal trial.
  assert.deepEqual(licenseStatus({ firstRun: betaEndsAt + 5 * DAY }, betaEndsAt + 6 * DAY, { betaEndsAt }), { mode: 'trial', daysLeft: TRIAL_DAYS - 1 });
  // A lifetime key works during and after the beta; a clock set back ends the beta.
  assert.equal(licenseStatus({ firstRun: T0, key: 'k', keyKind: 'lifetime', instanceId: 'i', validatedAt: betaEndsAt }, betaEndsAt + DAY, { betaEndsAt }).mode, 'licensed');
  assert.equal(licenseStatus({ firstRun: T0, lastSeen: T0 + 10 * DAY }, T0 + 5 * DAY, { betaEndsAt }).reason, 'clock');
});

test('beta keys: by product id when set, else by "beta" in the product / variant name', () => {
  assert.equal(isBetaKey({ product_name: 'Reboxed Beta' }, { betaProductId: null }), true);
  assert.equal(isBetaKey({ product_name: 'Reboxed', variant_name: 'Lifetime' }, { betaProductId: null }), false);
  assert.equal(isBetaKey({ product_id: 7, product_name: 'Reboxed Beta' }, { betaProductId: 8 }), false);
  assert.equal(isBetaKey({ product_id: 8 }, { betaProductId: 8 }), true);
});

test('website config: links (https only) and the beta discount text; offline keeps the built-in ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const product = { name: 'Reboxed', price: '5 €', buyUrl: 'https://shop/buy', donateUrl: null };
  const cfg = (body) => async () => ({ ok: true, json: async () => body });
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: cfg({ donateUrl: 'https://ko-fi.com/reboxed', buyUrl: 'javascript:alert(1)', betaUrl: 'https://reboxed.lemonsqueezy.com/buy/beta', betaDiscount: '-50 % with BETA50', price: '5 €' }), instanceName: 'PC', product });
  await lm.load();
  await lm.loadRemoteConfig();
  const p = lm.status().product;
  assert.deepEqual([p.donateUrl, p.buyUrl, p.betaUrl, p.betaDiscount, p.price], ['https://ko-fi.com/reboxed', 'https://shop/buy', 'https://reboxed.lemonsqueezy.com/buy/beta', '-50 % with BETA50', '5 €']);
  lm.fetch = async () => { throw new Error('offline'); };
  await lm.loadRemoteConfig();
  assert.equal(lm.status().product.donateUrl, 'https://ko-fi.com/reboxed');
});

test('website config switches the beta key on and off (betaKeyRequired, betaKeyUrl)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const cfg = (body) => async () => ({ ok: true, json: async () => body });
  const product = { name: 'Reboxed', price: '5 €', betaEndsAt: '2026-12-30', betaUrl: 'https://shop/beta', betaKeyRequired: false };
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: cfg({}), instanceName: 'PC', now: () => T0, product });
  assert.equal((await lm.load()).mode, 'beta', 'built in: no key while the store cannot hand them out');
  lm.fetch = cfg({ betaKeyRequired: true, betaKeyUrl: 'https://shop/beta-key' });
  await lm.loadRemoteConfig();
  const st = lm.status();
  assert.deepEqual([st.mode, st.reason, st.product.betaUrl], ['expired', 'betaKey', 'https://shop/beta-key']);
  lm.fetch = cfg({ betaKeyRequired: false });
  await lm.loadRemoteConfig();
  assert.equal(lm.status().mode, 'beta');
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
function fakeApi({ keys = { GOOD: { store_id: 1, product_id: 2, product_name: 'Reboxed' }, BETA: { store_id: 1, product_id: 3, product_name: 'Reboxed Beta' } }, offline = false } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    if (offline) throw new Error('getaddrinfo ENOTFOUND');
    const action = url.split('/').pop();
    const p = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ action, ...p });
    const meta = keys[p.license_key];
    const json = (status, body) => ({ status, json: async () => body });
    if (!meta) return json(404, { activated: false, valid: false, error: 'license_key not found.' });
    if (action === 'activate') return json(200, { activated: true, error: null, instance: { id: `inst-${p.license_key}` }, meta: { ...meta, customer_name: 'DJ Test' } });
    if (action === 'validate') return json(200, { valid: true, error: null, license_key: { status: 'active' }, meta });
    return json(200, { deactivated: true, error: null });
  };
  return { fetch, calls };
}

test('activate / validate / deactivate against the License API, product checked, offline tolerated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  let now = T0;
  const api = fakeApi();
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: api.fetch, instanceName: 'PC', now: () => now, product: { name: 'Reboxed', price: '5 €', buyUrl: null, storeId: 1, productId: 2 } });
  assert.equal((await lm.load()).mode, 'trial');
  await assert.rejects(() => lm.activate('BAD'), /license_key not found/);
  const st = await lm.activate(' GOOD ');
  assert.equal(st.mode, 'licensed');
  assert.equal(st.customer, 'DJ Test');
  assert.deepEqual(api.calls[1], { action: 'activate', license_key: 'GOOD', instance_name: 'PC' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'license.json'), 'utf8')).instanceId, 'inst-GOOD');
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

test('beta key during the beta, refused after it; the licence then replaces it (old activation freed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const end = '2026-12-30';
  const endMs = new Date(`${end}T00:00:00`).getTime();
  let now = endMs - 20 * DAY;
  const api = fakeApi();
  const product = { name: 'Reboxed', price: '5 €', storeId: 1, productId: 2, betaEndsAt: end, betaUrl: 'https://reboxed.lemonsqueezy.com/buy/beta', betaKeyRequired: true, betaDiscount: '-50 %' };
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: api.fetch, instanceName: 'PC', now: () => now, product });
  assert.equal((await lm.load()).reason, 'betaKey');
  const st = await lm.activate('BETA');
  assert.deepEqual([st.mode, st.registered, st.keyKind], ['beta', true, 'beta']);
  now = endMs + DAY;
  const over = lm.status();
  assert.deepEqual([over.mode, over.reason, over.betaTester, over.product.betaDiscount], ['expired', 'betaOver', true, '-50 %']);
  await assert.rejects(() => lm.activate('BETA'), /beta is over/);
  const lic = await lm.activate('GOOD');
  assert.equal(lic.mode, 'licensed');
  assert.ok(api.calls.some((c) => c.action === 'deactivate' && c.license_key === 'BETA'), 'beta activation freed');
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
