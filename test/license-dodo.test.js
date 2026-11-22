// Dodo Payments as the shop: keys activated / validated / freed through Dodo's public licence API
// (no API key), the product checked at activation; a refund (valid: false) revokes, a server that is
// gone does not; Lemon Squeezy keys keep going to Lemon Squeezy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LicenseManager, dodoRevoked } from '../src/main/license.js';

const DAY = 86400000;
const T0 = Date.UTC(2027, 1, 10);
const PRODUCT = 'pdt_reboxedLifetime01';

/** Dodo's public licence API, as documented (activate 201/403/404/422, validate 200 {valid}, deactivate 200/403/404). */
function fakeDodo({ keys = { 'RBX-GOOD-0001': { product: PRODUCT, limit: 3 }, 'RBX-OTHER-0002': { product: 'pdt_someoneElse99', limit: 3 } } } = {}) {
  const calls = []; const instances = new Map();
  const json = (status, body) => ({ status, json: async () => body });
  const fetch = async (url, opts) => {
    assert.ok(url.startsWith('https://live.dodopayments.com/licenses/'), url);
    assert.ok(!opts.headers.Authorization, 'no API key is ever sent');
    const action = url.split('/').pop();
    const p = JSON.parse(opts.body);
    calls.push({ action, ...p });
    const k = keys[p.license_key];
    if (action === 'validate') return json(200, { valid: !!k && !k.disabled && (!p.license_key_instance_id || instances.has(p.license_key_instance_id)) });
    if (!k) return json(404, { code: 'NOT_FOUND', message: 'License key not found' });
    if (action === 'activate') {
      if (k.disabled) return json(403, { code: 'INACTIVE', message: 'License key cannot be activated' });
      if ([...instances.values()].filter((i) => i.key === p.license_key).length >= k.limit) return json(422, { code: 'LIMIT', message: 'License key activation limit reached' });
      const id = `lki_${instances.size + 1}`;
      instances.set(id, { key: p.license_key });
      return json(201, { id, business_id: 'bus_1', name: p.name, license_key_id: 'lic_1', created_at: '2027-02-10T00:00:00Z', product: { product_id: k.product, name: 'Reboxed' }, customer: { customer_id: 'cus_1', name: 'DJ Dodo', email: 'dj@example.com' } });
    }
    if (action === 'deactivate') { if (!instances.delete(p.license_key_instance_id)) return json(403, { code: 'X', message: 'not found' }); return json(200, {}); }
    return json(422, {});
  };
  return { fetch, calls, instances, keys };
}

const manager = (dodo, extra = {}) => {
  let now = T0;
  const lm = new LicenseManager({ file: join(mkdtempSync(join(tmpdir(), 'rbx-dodo-')), 'license.json'), fetch: dodo.fetch, instanceName: 'PC (Reboxed)', now: () => now,
    product: { name: 'Reboxed', price: '5 €', buyUrl: null, storeId: null, productId: null, dodoProductId: PRODUCT, ...extra } });
  return { lm, tick: (d) => { now += d * DAY; } };
};

test('a Dodo key: activated with no API key, the product checked, validated, freed', async () => {
  const dodo = fakeDodo();
  const { lm, tick } = manager(dodo);
  await lm.load();
  const st = await lm.activate(' RBX-GOOD-0001 ');
  assert.equal(st.mode, 'licensed');
  assert.equal(st.customer, 'DJ Dodo');
  assert.deepEqual(dodo.calls[0], { action: 'activate', license_key: 'RBX-GOOD-0001', name: 'PC (Reboxed)' });
  tick(8);
  assert.equal((await lm.validate()).needsCheck, false);
  assert.equal(dodo.calls.at(-1).license_key_instance_id, 'lki_1');
  await lm.deactivate();
  assert.equal(dodo.instances.size, 0, 'the computer is freed at Dodo');
});

test('another product\'s key is refused and freed; the 3-computer limit and inactive keys are said clearly', async () => {
  const dodo = fakeDodo({ keys: { 'RBX-OTHER-0002': { product: 'pdt_someoneElse99', limit: 3 }, 'RBX-FULL-0003': { product: PRODUCT, limit: 1 }, 'RBX-OFF-0004': { product: PRODUCT, limit: 3, disabled: true } } });
  const a = manager(dodo); const b = manager(dodo);
  await a.lm.load(); await b.lm.load();
  await assert.rejects(a.lm.activate('RBX-OTHER-0002'), /not a Reboxed licence/);
  assert.equal(dodo.instances.size, 0);
  await a.lm.activate('RBX-FULL-0003');
  await assert.rejects(b.lm.activate('RBX-FULL-0003'), /maximum number of computers/);
  await assert.rejects(b.lm.activate('RBX-OFF-0004'), /not active/);
});

test('a refund at Dodo (valid: false) revokes; Dodo gone (5xx, 404, not JSON, unreachable) does not', async () => {
  const dodo = fakeDodo();
  const { lm, tick } = manager(dodo);
  await lm.load();
  await lm.activate('RBX-GOOD-0001');
  assert.equal(dodoRevoked(200, { valid: false }), true);
  assert.equal(dodoRevoked(404, { valid: false }), false);
  for (const res of [{ status: 503, json: async () => ({}) }, { status: 404, json: async () => ({ code: 'NOT_FOUND' }) }, { status: 200, json: async () => { throw new SyntaxError('<html>'); } }]) {
    tick(10);
    lm.fetch = async () => res;
    assert.equal((await lm.validate()).mode, 'licensed');
  }
  lm.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND live.dodopayments.com'); };
  tick(500);
  assert.equal((await lm.validate()).mode, 'licensed', 'more than a year without the server');
  dodo.keys['RBX-GOOD-0001'].disabled = true;
  lm.fetch = dodo.fetch;
  assert.equal((await lm.validate()).reason, 'revoked');
});

test('a Dodo beta key (dodoBetaProductId) is a beta key: it works until the beta ends, then stops', async () => {
  const BETA = 'pdt_reboxedBeta0001';
  const dodo = fakeDodo({ keys: { 'RBX-BETA-0005': { product: BETA, limit: 3 }, 'RBX-GOOD-0001': { product: PRODUCT, limit: 3 } } });
  // the beta runs until 31 January 2027 included; T0 - 20 days = 21 January
  const { lm, tick } = manager(dodo, { dodoBetaProductId: BETA, betaEndsAt: '2027-01-31' });
  tick(-20);
  await lm.load();
  const st = await lm.activate('RBX-BETA-0005');
  assert.equal(lm.state.keyKind, 'beta');
  assert.notEqual(st.mode, 'expired');
  tick(11); // 1 February 2027
  assert.equal(lm.status().reason, 'betaOver', 'the beta key stops on 1 February');
  // the lifetime licence then replaces it, and the beta activation is freed at Dodo
  assert.equal((await lm.activate('RBX-GOOD-0001')).mode, 'licensed');
  assert.equal([...dodo.instances.values()].filter((i) => i.key === 'RBX-BETA-0005').length, 0);
  // a beta key activated after the end is refused and freed
  const late = manager(dodo, { dodoBetaProductId: BETA, betaEndsAt: '2027-01-31' });
  await late.lm.load();
  await assert.rejects(late.lm.activate('RBX-BETA-0005'), /beta is over/);
  assert.equal([...dodo.instances.values()].filter((i) => i.key === 'RBX-BETA-0005').length, 0);
});

test('the switch comes from the website (dodoProductId + buyUrl); Lemon Squeezy keys never go to Dodo', async () => {
  const dodo = fakeDodo();
  const { lm } = manager(dodo, { dodoProductId: undefined });
  lm.fetch = async () => ({ ok: true, json: async () => ({ dodoProductId: PRODUCT, dodoBetaProductId: 'pdt_reboxedBeta0001', buyUrl: 'https://checkout.dodopayments.com/buy/pdt_reboxedLifetime01' }) });
  await lm.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(lm.product.dodoProductId, PRODUCT);
  assert.equal(lm.product.dodoBetaProductId, 'pdt_reboxedBeta0001');
  assert.equal(lm.status().product.buyUrl, 'https://checkout.dodopayments.com/buy/pdt_reboxedLifetime01');
  const { lm: bad } = manager(dodo, { dodoProductId: undefined });
  bad.fetch = async () => ({ ok: true, json: async () => ({ dodoProductId: 'pdt_<script>' }) });
  await bad.loadRemoteConfig('https://example.test/app-config.json');
  assert.equal(bad.product.dodoProductId, undefined);
  const seen = [];
  lm.fetch = async (url) => { seen.push(url); return { status: 200, json: async () => ({ activated: true, instance: { id: 'ls' }, meta: { store_id: 1, product_id: 2, product_name: 'Reboxed' } }) }; };
  assert.equal((await lm.activate('38b1460a-5104-4067-a91d-77b872934d51')).mode, 'licensed');
  assert.ok(seen.every((u) => u.includes('lemonsqueezy')));
});
