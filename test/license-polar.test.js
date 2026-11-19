// Polar as the shop (after Lemon Squeezy): keys activated / validated / freed through Polar's
// customer-portal API (no token, the organisation id), chosen from the key's shape; a refund
// (Polar's JSON 404) revokes, a server that is gone does not; Lemon Squeezy keys keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LicenseManager, keyShop, polarRevoked } from '../src/main/license.js';

const DAY = 86400000;
const T0 = Date.UTC(2027, 0, 10);
const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER_ORG = '99999999-2222-4333-8444-555555555555';

/** Polar's customer-portal licence API, as documented (activate 200/403/404, validate 200/404, deactivate 204). */
function fakePolar({ keys = { 'REBOXED-GOOD-1': { org: ORG, limit: 3 }, 'REBOXED-NOLIMIT': { org: ORG, limit: null }, 'OTHER-KEY-9': { org: OTHER_ORG, limit: 3 } } } = {}) {
  const calls = []; const activations = new Map();
  const json = (status, body) => ({ status, json: async () => body });
  const fetch = async (url, opts) => {
    assert.ok(url.startsWith('https://api.polar.sh/v1/customer-portal/license-keys/'), url);
    assert.ok(!opts.headers.Authorization, 'no token is ever sent');
    const action = url.split('/').pop();
    const p = JSON.parse(opts.body);
    calls.push({ action, ...p });
    const k = keys[p.key];
    const lk = k && { id: 'lk', organization_id: k.org, benefit_id: 'b1', key: p.key, status: 'granted', customer: { name: 'DJ Polar', email: 'dj@example.com' }, limit_activations: k.limit };
    if (!k || k.revoked) return json(404, { error: 'ResourceNotFound', detail: 'License key not found.' });
    if (action === 'activate') {
      if (k.limit === null) return json(403, { error: 'NotPermitted', detail: 'This license key does not support activations. Use /validate for licenses without activations.' });
      const used = [...activations.values()].filter((a) => a.key === p.key).length;
      if (used >= k.limit) return json(403, { error: 'NotPermitted', detail: 'License key activation limit reached.' });
      const id = `act-${activations.size + 1}`;
      activations.set(id, { key: p.key });
      return json(200, { id, license_key_id: 'lk', label: p.label, meta: {}, license_key: lk });
    }
    if (action === 'validate') {
      if (p.activation_id && !activations.has(p.activation_id)) return json(404, { error: 'ResourceNotFound', detail: 'Activation not found.' });
      return json(200, { ...lk, activation: p.activation_id ? { id: p.activation_id } : null });
    }
    if (action === 'deactivate') { activations.delete(p.activation_id); return { status: 204, json: async () => { throw new Error('no body'); } }; }
    return json(422, { detail: [] });
  };
  return { fetch, calls, activations, keys };
}

const manager = (polar, extra = {}) => {
  let now = T0;
  const lm = new LicenseManager({ file: join(mkdtempSync(join(tmpdir(), 'rbx-polar-')), 'license.json'), fetch: polar.fetch, instanceName: 'PC (Reboxed)', now: () => now,
    product: { name: 'Reboxed', price: '5 €', buyUrl: null, storeId: null, productId: null, polarOrganizationId: ORG, ...extra } });
  return { lm, tick: (d) => { now += d * DAY; } };
};

test('which shop a key comes from: Lemon Squeezy keys are bare UUIDs', () => {
  assert.equal(keyShop('38b1460a-5104-4067-a91d-77b872934d51'), 'lemonsqueezy');
  assert.equal(keyShop('REBOXED-3F2A-77B8-4D51'), 'polar');
  assert.equal(polarRevoked(404, { error: 'ResourceNotFound' }), true);
  assert.equal(polarRevoked(404, {}), false, 'a 404 page that is not Polar\'s answer');
  assert.equal(polarRevoked(500, { error: 'ResourceNotFound' }), false);
});

test('a Polar key: activated with the organisation id and no token, validated, freed', async () => {
  const polar = fakePolar();
  const { lm, tick } = manager(polar);
  await lm.load();
  const st = await lm.activate(' REBOXED-GOOD-1 ');
  assert.equal(st.mode, 'licensed');
  assert.equal(st.customer, 'DJ Polar');
  assert.deepEqual(polar.calls[0], { action: 'activate', organization_id: ORG, key: 'REBOXED-GOOD-1', label: 'PC (Reboxed)' });
  tick(8);
  assert.equal(lm.status().needsCheck, true);
  assert.equal((await lm.validate()).needsCheck, false);
  assert.equal(polar.calls.at(-1).activation_id, 'act-1');
  const off = await lm.deactivate();
  assert.notEqual(off.mode, 'licensed');
  assert.equal(off.key, '', 'the key is gone from this computer');
  assert.equal(polar.calls.at(-1).action, 'deactivate');
  assert.equal(polar.activations.size, 0, 'the computer is freed at Polar');
});

test('a product without activation limit: the key is only validated; the limit reached is said clearly', async () => {
  const polar = fakePolar();
  const { lm } = manager(polar);
  await lm.load();
  assert.equal((await lm.activate('REBOXED-NOLIMIT')).mode, 'licensed');
  assert.equal(polar.calls.map((c) => c.action).join(), 'activate,validate');
  const full = fakePolar({ keys: { 'REBOXED-FULL': { org: ORG, limit: 1 } } });
  const a = manager(full); const b = manager(full);
  await a.lm.load(); await b.lm.load();
  await a.lm.activate('REBOXED-FULL');
  await assert.rejects(b.lm.activate('REBOXED-FULL'), /maximum number of computers/);
});

test('another shop\'s Polar key is refused and its activation freed; an unknown key is said so', async () => {
  const polar = fakePolar();
  const { lm } = manager(polar);
  await lm.load();
  await assert.rejects(lm.activate('OTHER-KEY-9'), /not a Reboxed licence/);
  assert.equal(polar.activations.size, 0);
  // an unknown Polar-shaped key: Polar says not found, then the Lemon Squeezy try says so too
  lm.fetch = async (url, opts) => (url.includes('polar.sh') ? polar.fetch(url, opts) : { status: 404, json: async () => ({ activated: false, error: 'license_key not found.' }) });
  await assert.rejects(lm.activate('REBOXED-NOPE'), /not found/);
});

test('a refund at Polar revokes; Polar gone (5xx, not JSON, unreachable) does not', async () => {
  const polar = fakePolar();
  const { lm, tick } = manager(polar);
  await lm.load();
  await lm.activate('REBOXED-GOOD-1');
  for (const res of [{ status: 502, json: async () => ({}) }, { status: 404, json: async () => { throw new SyntaxError('<html>'); } }]) {
    tick(10);
    lm.fetch = async () => res;
    assert.equal((await lm.validate()).mode, 'licensed');
  }
  lm.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.polar.sh'); };
  tick(400);
  assert.equal((await lm.validate()).mode, 'licensed', 'a year without the server');
  polar.keys['REBOXED-GOOD-1'].revoked = true;
  lm.fetch = polar.fetch;
  assert.equal((await lm.validate()).reason, 'revoked');
});

test('the switch to Polar comes from the website (app-config.json): organisation id and buy link; bad values ignored', async () => {
  const polar = fakePolar();
  const { lm } = manager(polar, { polarOrganizationId: undefined });
  const cfg = { polarOrganizationId: ORG, buyUrl: 'https://buy.polar.sh/polar_cl_AbC123' };
  lm.fetch = async () => ({ ok: true, json: async () => cfg });
  await lm.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(lm.product.polarOrganizationId, ORG);
  assert.equal(lm.status().product.buyUrl, 'https://buy.polar.sh/polar_cl_AbC123');
  const { lm: other } = manager(polar, { polarOrganizationId: undefined });
  other.fetch = async () => ({ ok: true, json: async () => ({ polarOrganizationId: 'not-a-uuid"; drop', buyUrl: 'http://buy.polar.sh/x' }) });
  await other.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(other.product.polarOrganizationId, undefined);
  assert.equal(other.status().product.buyUrl, null, 'http links are refused');
});

test('Lemon Squeezy keys keep going to Lemon Squeezy when Polar is set up', async () => {
  const polar = fakePolar();
  const { lm } = manager(polar);
  await lm.load();
  const seen = [];
  lm.fetch = async (url, opts) => {
    seen.push(url);
    if (url.includes('polar.sh')) return polar.fetch(url, opts);
    return { status: 200, json: async () => ({ activated: true, instance: { id: 'ls-inst' }, meta: { store_id: 1, product_id: 2, product_name: 'Reboxed', customer_name: 'DJ LS' } }) };
  };
  const st = await lm.activate('38b1460a-5104-4067-a91d-77b872934d51');
  assert.equal(st.mode, 'licensed');
  assert.ok(seen.every((u) => u.includes('lemonsqueezy')), 'a Lemon Squeezy key never goes to Polar');
});
