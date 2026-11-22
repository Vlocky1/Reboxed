import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { licenseStatus, maskKey, TRIAL_DAYS, OFFLINE_DAYS } from '../src/shared/license.js';
import { LicenseManager } from '../src/main/license.js';
import { betaEnd } from '../src/shared/product.js';

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
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch: async () => { throw new Error('offline'); }, instanceName: 'PC', dev: true, now: () => T0 + 400 * DAY });
  assert.equal((await lm.load()).mode, 'dev');
});

test('licensed: a lifetime licence checked once never stops offline (the shop may close); beta keys do; revoked keys stop', () => {
  const st = { firstRun: T0 - 100 * DAY, key: 'k', instanceId: 'i', keyKind: 'lifetime', validatedAt: T0 };
  assert.deepEqual(licenseStatus(st, T0 + DAY), { mode: 'licensed', needsCheck: false });
  assert.equal(licenseStatus(st, T0 + 8 * DAY).needsCheck, true);
  assert.equal(licenseStatus(st, T0 + (OFFLINE_DAYS + 1) * DAY).mode, 'licensed', 'a month without the server: still licensed');
  assert.equal(licenseStatus(st, T0 + 3 * 365 * DAY).mode, 'licensed', 'years without the server: still licensed');
  assert.equal(licenseStatus({ ...st, keyKind: undefined }, T0 + 400 * DAY).mode, 'licensed', 'keys activated before keyKind existed are lifetime');
  const beta = { ...st, keyKind: 'beta' };
  assert.equal(licenseStatus(beta, T0 + (OFFLINE_DAYS + 1) * DAY, { betaEndsAt: T0 + 400 * DAY }).reason, 'offline');
  assert.equal(licenseStatus({ ...st, validatedAt: undefined }, T0 + (OFFLINE_DAYS + 1) * DAY).reason, 'offline', 'never checked: no free pass');
  assert.equal(licenseStatus({ ...st, revoked: true }, T0).reason, 'revoked');
  assert.equal(maskKey('38b1460a-5104-4067-a91d-77b872934d51'), '••••-4d51');
});


test('Reboxed 1.34.2: keys from the earlier shops (Lemon Squeezy, Polar) are dropped; Reboxed asks for a Dodo key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const file = join(dir, 'license.json');
  const product = { name: 'Reboxed', price: '5 €', betaEndsAt: '2027-01-31', betaUrl: 'https://checkout.dodopayments.com/buy/pdt_beta', betaKeyRequired: true, dodoProductId: 'pdt_lifetime01', dodoBetaProductId: 'pdt_beta000001' };
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error('no network in this test'); };
  for (const old of [
    { key: '38b1460a-5104-4067-a91d-77b872934d51', instanceId: 'inst', keyKind: 'lifetime', validatedAt: T0, customer: 'DJ' }, // Lemon Squeezy (no provider field)
    { key: '38b1460a-5104-4067-a91d-77b872934d51', provider: 'lemonsqueezy', instanceId: 'inst', keyKind: 'beta', validatedAt: T0 },
    { key: 'POLAR-KEY-1', provider: 'polar', instanceId: 'act', keyKind: 'lifetime', validatedAt: T0 },
  ]) {
    writeFileSync(file, JSON.stringify({ firstRun: T0 - 30 * DAY, lastSeen: T0, betaTester: true, ...old }));
    const lm = new LicenseManager({ file, fetch, instanceName: 'PC', now: () => T0, product });
    const st = await lm.load();
    assert.deepEqual([st.mode, st.reason, st.key, st.oldKeyDropped], ['expired', 'betaKey', '', true], old.provider ?? 'lemonsqueezy');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.key, undefined, 'the old key is gone from license.json');
    assert.equal(saved.betaTester, true, 'still known as a beta tester');
  }
  assert.equal(calls.length, 0, 'no shop is called to drop an old key');
  // A Dodo key is kept as it is.
  writeFileSync(file, JSON.stringify({ firstRun: T0 - 30 * DAY, key: 'RBX-1', provider: 'dodo', instanceId: 'lki_1', keyKind: 'lifetime', validatedAt: T0 }));
  const lm = new LicenseManager({ file, fetch, instanceName: 'PC', now: () => T0, product });
  assert.equal((await lm.load()).mode, 'licensed');
});

test('an old Lemon Squeezy key typed in now goes to Dodo and is refused with a clear message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbx-lic-'));
  const seen = [];
  const fetch = async (url) => { seen.push(url); return { status: 404, json: async () => ({ code: 'NOT_FOUND' }) }; };
  const lm = new LicenseManager({ file: join(dir, 'license.json'), fetch, instanceName: 'PC', now: () => T0, product: { name: 'Reboxed', price: '5 €', dodoProductId: 'pdt_lifetime01' } });
  await lm.load();
  await assert.rejects(() => lm.activate('38b1460a-5104-4067-a91d-77b872934d51'), /no longer work/);
  assert.ok(seen.length === 1 && seen[0].startsWith('https://live.dodopayments.com/licenses/activate'));
  assert.equal(lm.status().mode, 'trial');
});

test('the beta date is its last day: beta keys work all of 31 January 2027 and stop on 1 February at midnight; the website can move it', async () => {
  const p = { betaEndsAt: '2027-01-31' };
  const end = betaEnd(p);
  assert.equal(new Date(end).getDate(), 1);
  assert.equal(new Date(end).getMonth(), 1, 'February');
  const beta = { firstRun: end - 60 * DAY, key: 'B', instanceId: 'i', keyKind: 'beta', validatedAt: end - 2 * DAY };
  const lastMinute = new Date(2027, 0, 31, 23, 59).getTime();
  const firstMinute = new Date(2027, 1, 1, 0, 0).getTime();
  assert.equal(licenseStatus(beta, lastMinute, { betaEndsAt: end }).mode, 'beta', '31 January 23:59: still the beta');
  assert.equal(licenseStatus(beta, firstMinute, { betaEndsAt: end }).reason, 'betaOver', '1 February 00:00: over');
  const lm = new LicenseManager({ file: join(mkdtempSync(join(tmpdir(), 'rbx-lic-')), 'license.json'), fetch: async () => ({ ok: true, json: async () => ({ betaEndsAt: '2027-02-28' }) }), instanceName: 'PC', product: { name: 'Reboxed', price: '5 €', betaEndsAt: '2027-01-31' } });
  await lm.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(lm.product.betaEndsAt, '2027-02-28', 'moved from the website');
  lm.fetch = async () => ({ ok: true, json: async () => ({ betaEndsAt: '2099-01-01' }) });
  await lm.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(lm.product.betaEndsAt, '2027-02-28', 'a date out of range is ignored');
});
