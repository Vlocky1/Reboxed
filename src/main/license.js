// Licence keys through the Lemon Squeezy License API (activate / validate / deactivate; no API key,
// made for apps). Two kinds of keys: the lifetime licence, and the free beta key that registers a tester
// (it stops at the end of the beta). The state lives in <app folder>/license.json.
import { readFile, writeFile } from 'node:fs/promises';
import { licenseStatus, maskKey } from '../shared/license.js';
import { PRODUCT, betaEnd, isBetaKey } from '../shared/product.js';

const API = 'https://api.lemonsqueezy.com/v1/licenses';

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

  async activate(key) {
    key = String(key ?? '').trim();
    if (!key) throw new Error('Enter your licence key');
    const { body } = await this.call('activate', { license_key: key, instance_name: this.instanceName });
    if (!body.activated) throw new Error(body.error || 'This licence key could not be activated');
    const release = () => this.call('deactivate', { license_key: key, instance_id: body.instance.id }).catch(() => {});
    if (!this.sameProduct(body.meta)) { await release(); throw new Error('This key is not a Reboxed licence'); }
    const beta = isBetaKey(body.meta, this.product);
    const end = betaEnd(this.product);
    if (beta && end && this.now() >= end) { await release(); throw new Error('The open beta is over: this beta key no longer works. Get the lifetime licence.'); }
    // A new key replaces the one in use (e.g. the licence after the beta key): free the old activation.
    if (this.state.key && this.state.instanceId && this.state.key !== key) {
      await this.call('deactivate', { license_key: this.state.key, instance_id: this.state.instanceId }).catch(() => {});
    }
    Object.assign(this.state, { key, instanceId: body.instance.id, keyKind: beta ? 'beta' : 'lifetime', validatedAt: this.now(), revoked: false, customer: body.meta?.customer_name ?? null });
    if (beta) this.state.betaTester = true;
    await this.save();
    return this.status();
  }

  /** Re-validate online. Offline: nothing changes (the key keeps working for OFFLINE_DAYS). */
  async validate() {
    if (!this.state.key || !this.state.instanceId) return this.status();
    try {
      const { status, body } = await this.call('validate', { license_key: this.state.key, instance_id: this.state.instanceId });
      if (body.valid && this.sameProduct(body.meta)) Object.assign(this.state, { validatedAt: this.now(), revoked: false });
      else if (status === 404 || ['expired', 'disabled'].includes(body.license_key?.status) || body.valid === false) this.state.revoked = true;
      await this.save();
    } catch (err) {
      if (!err.offline) throw err;
    }
    return this.status();
  }

  /** Frees this computer's activation (to move the licence to another computer). */
  async deactivate() {
    const { key, instanceId } = this.state;
    if (key && instanceId) await this.call('deactivate', { license_key: key, instance_id: instanceId }).catch(() => {});
    for (const k of ['key', 'instanceId', 'keyKind', 'validatedAt', 'revoked', 'customer']) delete this.state[k];
    await this.save();
    return this.status();
  }
}
