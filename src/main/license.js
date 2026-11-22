// Licence keys through Dodo Payments' public licence API (activate / validate / deactivate; no API key,
// made for client apps). Two products: the lifetime licence and the free beta key that registers a
// tester (it stops at the end of the beta). Only Dodo keys are accepted: keys from the earlier shops
// (Lemon Squeezy, Polar) are dropped when Reboxed starts. The state lives in <app folder>/license.json.
import { readFile, writeFile } from 'node:fs/promises';
import { licenseStatus, maskKey } from '../shared/license.js';
import { PRODUCT, betaEnd } from '../shared/product.js';

const DODO_API = 'https://live.dodopayments.com/licenses';
const DODO_PRODUCT = /^pdt_[A-Za-z0-9]{6,64}$/;
const KEY_FIELDS = ['key', 'provider', 'instanceId', 'keyKind', 'validatedAt', 'revoked', 'customer'];

/** Dodo's own answer that a key is not valid any more (refunded, disabled, expired): HTTP 200 with valid: false. */
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
    // A key from an earlier shop (Lemon Squeezy, Polar) no longer counts: Reboxed asks for a Dodo key.
    if (this.state.key && this.state.provider !== 'dodo') {
      for (const k of KEY_FIELDS) delete this.state[k];
      this.state.oldKeyDropped = true;
    }
    await this.save();
    return this.status();
  }

  async save() { await writeFile(this.file, JSON.stringify(this.state, null, 2)); }

  /**
   * Settings published on the website (app-config.json): buy / donate / beta key links (https only), the
   * price shown, the discount text for beta testers, the beta end date and the Dodo product ids change
   * without a new version.
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
      // the Dodo products: the lifetime licence, and the free beta key (its keys stop when the beta ends)
      if (typeof cfg.dodoProductId === 'string' && DODO_PRODUCT.test(cfg.dodoProductId.trim())) patch.dodoProductId = cfg.dodoProductId.trim();
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
      oldKeyDropped: !this.state.key && !!this.state.oldKeyDropped,
      product: { name: p.name, price: p.price, buyUrl: p.buyUrl, donateUrl: p.donateUrl ?? null, betaEndsAt: p.betaEndsAt ?? null, betaUrl: p.betaUrl ?? null, betaDiscount: p.betaDiscount ?? null },
    };
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
    if (status === 404) throw new Error('This key was not found. Keys from before 22 November 2026 no longer work: get a new one from the links below.');
    throw new Error(`The licence server answered ${status}: try again later`);
  }

  async activate(key) {
    key = String(key ?? '').trim();
    if (!key) throw new Error('Enter your licence key');
    const got = await this.activateDodo(key);
    // A new key replaces the one in use (e.g. the licence after the beta key): free the old activation.
    if (this.state.key && this.state.instanceId && this.state.key !== key) await this.releaseCurrent();
    Object.assign(this.state, { key, provider: 'dodo', instanceId: got.instanceId, keyKind: got.beta ? 'beta' : 'lifetime', validatedAt: this.now(), revoked: false, customer: got.customer });
    if (got.beta) this.state.betaTester = true;
    delete this.state.oldKeyDropped;
    await this.save();
    return this.status();
  }

  /** Free the activation of the key in use at Dodo (errors ignored). */
  async releaseCurrent() {
    const { key, instanceId } = this.state;
    if (!key || !instanceId) return;
    await this.dodoCall('deactivate', { license_key: key, license_key_instance_id: instanceId }).catch(() => {});
  }

  /**
   * Re-validate online at Dodo. Offline or a server that is gone: nothing changes (a lifetime licence
   * checked once keeps working; see licenseStatus). Only Dodo's own "valid: false" revokes.
   */
  async validate() {
    if (!this.state.key || !this.state.instanceId) return this.status();
    try {
      const { status, body } = await this.dodoCall('validate', { license_key: this.state.key, license_key_instance_id: this.state.instanceId });
      if (status === 200 && body.valid === true) Object.assign(this.state, { validatedAt: this.now(), revoked: false });
      else if (dodoRevoked(status, body)) this.state.revoked = true;
      await this.save();
    } catch (err) {
      if (!err.offline) throw err;
    }
    return this.status();
  }

  /** Frees this computer's activation (to move the licence to another computer). */
  async deactivate() {
    await this.releaseCurrent();
    for (const k of KEY_FIELDS) delete this.state[k];
    await this.save();
    return this.status();
  }
}
