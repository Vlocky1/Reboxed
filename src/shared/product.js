// Where Reboxed is sold (Lemon Squeezy). storeId / productId: a key from another store or product is
// refused once they are set. Discount codes are made in the Lemon Squeezy dashboard (Store > Discounts).
// The links (buy, donate, beta key) and the beta discount text can also come from the website's
// app-config.json, so they change without a new version.
export const PRODUCT = {
  name: 'Reboxed',
  price: '5 €',
  buyUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/3639fa22-a137-4f19-986e-ad7dbe941e4c',
  storeId: null,
  productId: null,
  // Open beta: until this date (local midnight). Beta keys stop working then; beta testers get a discount.
  betaEndsAt: '2026-12-30',
  // Free "Reboxed Beta" product (0 €) whose keys register the testers.
  betaUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/f508be5f-68f4-4fd3-b365-8206ee56d1c9',
  // Does the beta ask for that key? Off until the store can hand out keys; the website's app-config.json
  // (betaKeyRequired) turns it on without a new version.
  betaKeyRequired: false,
  betaProductId: null, // without it, a key whose product or variant name contains "beta" is a beta key
  betaDiscount: null, // shown to beta testers when the beta ends, e.g. "-50 % with the code BETA50"
  // "Buy me a coffee".
  donateUrl: 'https://ko-fi.com/reboxed',
};

/** The beta end date as a timestamp (local midnight), or null. */
export const betaEnd = (p = PRODUCT) => (p.betaEndsAt ? new Date(`${p.betaEndsAt}T00:00:00`).getTime() : null);

/** Is a licence key (Lemon Squeezy activation / validation meta) a beta key? */
export const isBetaKey = (meta = {}, p = PRODUCT) => (p.betaProductId != null ? meta.product_id === p.betaProductId : /\bbeta\b/i.test(`${meta.product_name ?? ''} ${meta.variant_name ?? ''}`));
