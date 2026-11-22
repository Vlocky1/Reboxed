// Licence keys through the Lemon Squeezy License API (activate / validate / deactivate; no API key,
// made for apps). Two kinds of keys: the lifetime licence, and the free beta key that registers a tester
// (it stops at the end of the beta). The state lives in <app folder>/license.json.
import { readFile, writeFile } from 'node:fs/promises';
import { licenseStatus, maskKey } from '../shared/license.js';
import { PRODUCT, betaEnd, isBetaKey } from '../shared/product.js';

const API = 'https://api.lemonsqueezy.com/v1/licenses';

/**
 * Does a validate answer say this key was taken back? Only a well-formed answer about the key:
 * HTTP 200/400 with `valid: false` and the key's own status (disabled after a refund, expired).
 * Anything else (404, 5xx, a page that is not JSON, no key object) is the server, not the key.
 */
export function revokedAnswer(status, body) {
  if (!(status === 200 || status === 400) || body?.valid !== false) return false;
  return ['disabled', 'expired'].includes(body.license_key?.status);
}

// ---- Polar (the shop after Lemon Squeezy) ----------------------------------------------------------
// Customer-portal endpoints: no token, made for apps; the organisation id says whose key it is.
const POLAR_API = 'https://api.polar.sh/v1/customer-portal/license-keys';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Polar's own "this key is not valid" (refunded, revoked, disabled, expired, unknown): a JSON 404 from its API. */
export const polarRevoked = (status, body) => status === 404 && body?.error === 'ResourceNotFound';

/** Lemon Squeezy keys are bare UUIDs; Polar keys carry a prefix. Which shop to ask first. */
export const keyShop = (key) => (UUID.test(String(key ?? '').trim()) ? 'lemonsqueezy' : 'polar');

// ---- Dodo Payments (the shop after Lemon Squeezy) --------------------------------------------------
// Public licence endpoints (no API key, made for client apps); the activation tells the product.
const DODO_API = 'https://live.dodopayments.com/licenses';
const DODO_PRODUCT = /^pdt_[A-Za-z0-9]{6,64}$/;

/** Dodo's own answer that a key is not valid any more: HTTP 200 with valid: false. */
export const dodoRevoked = (status, body) => status === 200 && body?.valid === false;

export class LicenseManager {
  /**
   * @param {{file: string, fetch: typeof fetch, instanceName: string, now?: () => number, product?: object, dev?: boolean}} o
   *   dev: Reboxed run from its source (not installed): no licence is asked for.
   */
  constructor({ file, fetch: f, instanceName, now = Date.now, product = PRODUCT, dev = false }) {
    Object.assign(this, { file, fetch: f, instanceName, now, product, dev });
    this.state = {};
  }

  async load() {
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); } catch { this.state = {}; }
    const now = this.now();
    this.state.firstRun ??= now;
    this.state.lastSeen = Math.max(this.state.lastSeen ?? 0, now);
    await this.save();
    return this.status();
  }

  async save() { await writeFile(this.file, JSON.stringify(this.state, null, 2)); }

  /**
   * Settings published on the website (app-config.json): buy / donate / beta key links (https only), the
   * price shown and the discount text for beta testers change without a new version. The beta end date
   * stays built in.
   */
  async loadRemoteConfig(url = 'https://reboxed.github.io/app-config.json') {
    try {
      const res = await Promise.race([this.fetch(`${url}?t=${this.now()}`), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]);
      if (!res.ok) return;
      const cfg = await res.json();
      const https = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
      const patch = {};
      for (const k of ['donateUrl', 'buyUrl', 'betaUrl']) if (https(cfg[k])) patch[k] = cfg[k];
      // betaKeyUrl: the beta key link under a name 1.17.0 does not read (there, betaUrl alone asks for a key).
      if (https(cfg.betaKeyUrl)) patch.betaUrl = cfg.betaKeyUrl;
      if (typeof cfg.betaKeyRequired === 'boolean') patch.betaKeyRequired = cfg.betaKeyRequired;
      if (typeof cfg.betaDiscount === 'string' && cfg.betaDiscount.trim()) patch.betaDiscount = cfg.betaDiscount.trim().slice(0, 200);
      if (typeof cfg.price === 'string' && /^[\d.,]+\s?[€$£]$/.test(cfg.price.trim())) patch.price = cfg.price.trim();
      // the last day of the open beta (YYYY-MM-DD, a real date, not before 2026 nor after 2028)
      if (typeof cfg.betaEndsAt === 'string' && /^20(2[6-8])-\d\d-\d\d$/.test(cfg.betaEndsAt) && !Number.isNaN(new Date(`${cfg.betaEndsAt}T00:00:00`).getTime())) patch.betaEndsAt = cfg.betaEndsAt;
      // the shop: Polar once its organisation id is published (Lemon Squeezy keys keep working)
      if (typeof cfg.polarOrganizationId === 'string' && UUID.test(cfg.polarOrganizationId.trim())) patch.polarOrganizationId = cfg.polarOrganizationId.trim();
      if (typeof cfg.polarBenefitId === 'string' && UUID.test(cfg.polarBenefitId.trim())) patch.polarBenefitId = cfg.polarBenefitId.trim();
      if (typeof cfg.dodoProductId === 'string' && DODO_PRODUCT.test(cfg.dodoProductId.trim())) patch.dodoProductId = cfg.dodoProductId.trim();
      // the free beta key handed out at Dodo (0 €): a key of this product is a beta key, it stops when the beta ends
      if (typeof cfg.dodoBetaProductId === 'string' && DODO_PRODUCT.test(cfg.dodoBetaProductId.trim())) patch.dodoBetaProductId = cfg.dodoBetaProductId.trim();
      this.product = { ...this.product, ...patch };
    } catch { /* offline: the built-in settings */ }
  }

  status() {
    const p = this.product;
    const s = this.dev && !this.state.key ? { mode: 'dev' }
      : licenseStatus(this.state, this.now(), { betaEndsAt: betaEnd(p), betaKeyRequired: !!(p.betaKeyRequired && p.betaUrl) });
    if (this.state.betaTester && s.mode === 'expired' && s.reason === 'betaOver') s.betaTester = true;
    return {
      ...s,
      key: maskKey(this.state.key),
      keyKind: this.state.keyKind ?? null,
      customer: this.state.customer ?? null,
      product: { name: p.name, price: p.price, buyUrl: p.buyUrl, donateUrl: p.donateUrl ?? null, betaEndsAt: p.betaEndsAt ?? null, betaUrl: p.betaUrl ?? null, betaDiscount: p.betaDiscount ?? null },
    };
  }

  /** POST to the License API; its errors come back as JSON with `error`. */
  async call(action, params) {
    let res;
    try {
      res = await this.fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    } catch (err) {
      throw Object.assign(new Error(`Could not reach the licence server (${err.message})`), { offline: true });
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /** A key of another store, or of another product than the licence or the beta, is refused. */
  sameProduct(meta = {}) {
    return (this.product.storeId == null || meta.store_id === this.product.storeId)
      && (this.product.productId == null || meta.product_id === this.product.productId || isBetaKey(meta, this.product));
  }

  /** POST to Polar's customer-portal licence API (JSON). */
  async polarCall(action, params) {
    let res;
    try {
      res = await this.fetch(`${POLAR_API}/${action}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: this.product.polarOrganizationId, ...params }),
      });
    } catch (err) {
      throw Object.assign(new Error(`Could not reach the licence server (${err.message})`), { offline: true });
    }
    const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /** A Polar key of this shop (and of the licence's benefit when it is set). */
  polarSameProduct(lk = {}) {
    return lk.organization_id === this.product.polarOrganizationId && (!this.product.polarBenefitId || lk.benefit_id === this.product.polarBenefitId);
  }

  /** Activate a Polar key on this computer (or only validate it when the product has no activation limit). */
  async activatePolar(key) {
    let { status, body } = await this.polarCall('activate', { key, label: this.instanceName });
    let instanceId; let lk;
    if (status === 200 && body.id) { instanceId = body.id; lk = body.license_key; }
    else if (status === 403 && /does not support activations/i.test(body.detail ?? '')) {
      ({ status, body } = await this.polarCall('validate', { key }));
      if (status !== 200) throw new Error('This licence key could not be activated');
      instanceId = 'polar-no-activation'; lk = body;
    } else if (status === 403) throw new Error(/limit/i.test(body.detail ?? '') ? 'This licence is already active on its maximum number of computers: free one (Preferences > About) or contact support' : (body.detail || 'This licence key cannot be activated'));
    else if (status === 404) { const e = new Error('This licence key was not found'); e.notFound = true; throw e; }
    else throw new Error(`The licence server answered ${status}: try again later`);
    if (!this.polarSameProduct(lk)) {
      if (instanceId !== 'polar-no-activation') await this.polarCall('deactivate', { key, activation_id: instanceId }).catch(() => {});
      throw new Error('This key is not a Reboxed licence');
    }
    return { instanceId, customer: lk?.customer?.name || lk?.customer?.email || null };
  }

  /** POST to Dodo's public licence API (JSON). */
  async dodoCall(action, params) {
    let res;
    try {
      res = await this.fetch(`${DODO_API}/${action}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw Object.assign(new Error(`Could not reach the licence server (${err.message})`), { offline: true });
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /**
   * Activate a Dodo key on this computer: the lifetime licence (dodoProductId) or the beta key
   * (dodoBetaProductId). A key of another product, or a beta key once the beta is over, is refused and freed.
   */
  async activateDodo(key) {
    const { status, body } = await this.dodoCall('activate', { license_key: key, name: this.instanceName });
    if (status === 201 || (status === 200 && body.id)) {
      const product = body.product?.product_id;
      const free = () => this.dodoCall('deactivate', { license_key: key, license_key_instance_id: body.id }).catch(() => {});
      const beta = product != null && product === this.product.dodoBetaProductId;
      if (!beta && (product == null || product !== this.product.dodoProductId)) { await free(); throw new Error('This key is not a Reboxed licence'); }
      const end = betaEnd(this.product);
      if (beta && end && this.now() >= end) { await free(); throw new Error('The open beta is over: this beta key no longer works. Get the lifetime licence.'); }
      return { instanceId: body.id, customer: body.customer?.name || body.customer?.email || null, beta };
    }
    if (status === 422) throw new Error('This licence is already active on its maximum number of computers (3): free one (Preferences > About on that computer) or contact reboxed@proton.me');
    if (status === 403) throw new Error('This licence key is not active (refunded or disabled)');
    if (status === 404) { const e = new Error('This licence key was not found'); e.notFound = true; throw e; }
    throw new Error(`The licence server answered ${status}: try again later`);
  }

  async activate(key) {
    key = String(key ?? '').trim();
    if (!key) throw new Error('Enter your licence key');
    // Dodo, the shop in use once its product id is published: keys that are not Lemon Squeezy's
    if ((this.product.dodoProductId || this.product.dodoBetaProductId) && keyShop(key) !== 'lemonsqueezy') {
      let got;
      try { got = await this.activateDodo(key); } catch (err) { if (!err.notFound) throw err; }
      if (got) {
        if (this.state.key && this.state.instanceId && this.state.key !== key) await this.releaseCurrent();
        Object.assign(this.state, { key, provider: 'dodo', instanceId: got.instanceId, keyKind: got.beta ? 'beta' : 'lifetime', validatedAt: this.now(), revoked: false, customer: got.customer });
        if (got.beta) this.state.betaTester = true;
        await this.save();
        return this.status();
      }
    }
    // the shop the key comes from: Polar keys carry a prefix, Lemon Squeezy keys are bare UUIDs
    if (this.product.polarOrganizationId && keyShop(key) === 'polar') {
      let got;
      try { got = await this.activatePolar(key); } catch (err) { if (!err.notFound) throw err; }
      if (got) {
        if (this.state.key && this.state.instanceId && this.state.key !== key) await this.releaseCurrent();
        Object.assign(this.state, { key, provider: 'polar', instanceId: got.instanceId, keyKind: 'lifetime', validatedAt: this.now(), revoked: false, customer: got.customer });
        await this.save();
        return this.status();
      }
    }
    const { body } = await this.call('activate', { license_key: key, instance_name: this.instanceName });
    if (!body.activated) throw new Error(body.error || 'This licence key could not be activated');
    const release = () => this.call('deactivate', { license_key: key, instance_id: body.instance.id }).catch(() => {});
    if (!this.sameProduct(body.meta)) { await release(); throw new Error('This key is not a Reboxed licence'); }
    const beta = isBetaKey(body.meta, this.product);
    const end = betaEnd(this.product);
    if (beta && end && this.now() >= end) { await release(); throw new Error('The open beta is over: this beta key no longer works. Get the lifetime licence.'); }
    // A new key replaces the one in use (e.g. the licence after the beta key): free the old activation.
    if (this.state.key && this.state.instanceId && this.state.key !== key) await this.releaseCurrent();
    Object.assign(this.state, { key, provider: 'lemonsqueezy', instanceId: body.instance.id, keyKind: beta ? 'beta' : 'lifetime', validatedAt: this.now(), revoked: false, customer: body.meta?.customer_name ?? null });
    if (beta) this.state.betaTester = true;
    await this.save();
    return this.status();
  }

  /** Free the activation of the key in use, at the shop it comes from (errors ignored). */
  async releaseCurrent() {
    const { key, instanceId, provider } = this.state;
    if (!key || !instanceId) return;
    if (provider === 'polar') {
      if (instanceId !== 'polar-no-activation' && this.product.polarOrganizationId) await this.polarCall('deactivate', { key, activation_id: instanceId }).catch(() => {});
    } else if (provider === 'dodo') {
      await this.dodoCall('deactivate', { license_key: key, license_key_instance_id: instanceId }).catch(() => {});
    } else await this.call('deactivate', { license_key: key, instance_id: instanceId }).catch(() => {});
  }

  /**
   * Re-validate online, at the shop the key comes from. Offline or a server that is gone: nothing
   * changes (a lifetime licence checked once keeps working; see licenseStatus).
   */
  async validate() {
    if (!this.state.key || !this.state.instanceId) return this.status();
    try {
      if (this.state.provider === 'dodo') {
        const { status, body } = await this.dodoCall('validate', { license_key: this.state.key, license_key_instance_id: this.state.instanceId });
        if (status === 200 && body.valid === true) Object.assign(this.state, { validatedAt: this.now(), revoked: false });
        // Dodo's own "valid: false" (refunded / disabled / expired); anything else is the server
        else if (dodoRevoked(status, body)) this.state.revoked = true;
      } else if (this.state.provider === 'polar') {
        if (!this.product.polarOrganizationId) return this.status();
        const params = { key: this.state.key, ...(this.state.instanceId !== 'polar-no-activation' ? { activation_id: this.state.instanceId } : {}) };
        const { status, body } = await this.polarCall('validate', params);
        if (status === 200 && this.polarSameProduct(body)) Object.assign(this.state, { validatedAt: this.now(), revoked: false });
        // Polar's own JSON 404 is its answer about the key (refunded, revoked, disabled, expired)
        else if (polarRevoked(status, body)) this.state.revoked = true;
      } else {
        const { status, body } = await this.call('validate', { license_key: this.state.key, instance_id: this.state.instanceId });
        if (body.valid && this.sameProduct(body.meta)) Object.assign(this.state, { validatedAt: this.now(), revoked: false });
        // Revoked only on an explicit answer about this key (refunded / disabled / expired). A 404, a
        // server error or an answer that is not about the key (the server gone, moved, down) changes
        // nothing: a paid licence must not stop because the shop closes.
        else if (revokedAnswer(status, body)) this.state.revoked = true;
      }
      await this.save();
    } catch (err) {
      if (!err.offline) throw err;
    }
    return this.status();
  }

  /** Frees this computer's activation (to move the licence to another computer). */
  async deactivate() {
    await this.releaseCurrent();
    for (const k of ['key', 'provider', 'instanceId', 'keyKind', 'validatedAt', 'revoked', 'customer']) delete this.state[k];
    await this.save();
    return this.status();
  }
}
