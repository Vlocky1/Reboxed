// Where Reboxed is sold (Lemon Squeezy). storeId / productId: a key from another store or product is
// refused once they are set. Discount codes are made in the Lemon Squeezy dashboard (Store > Discounts).
// The links (buy, donate, beta key) and the beta discount text can also come from the website's
// app-config.json, so they change without a new version.
export const PRODUCT = {
  name: 'Reboxed',
  price: '5 €',
  buyUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/7917cede-69b0-411f-990d-169fae665325',
  storeId: null,
  productId: null,
  // Open beta: its last day (included). Beta keys stop working the next day at local midnight
  // (1 February 2027); beta testers get a discount. The website's app-config.json can move it.
  betaEndsAt: '2027-01-31',
  // Free "Reboxed Beta" product (0 €) whose keys register the testers.
  betaUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/091a7519-f694-4e80-b2c7-77ef3d3426fa',
  // Does the beta ask for that key? Off until the store can hand out keys; the website's app-config.json
  // (betaKeyRequired) turns it on without a new version.
  betaKeyRequired: false,
  betaProductId: null, // without it, a key whose product or variant name contains "beta" is a beta key
  betaDiscount: null, // shown to beta testers when the beta ends, e.g. "-50 % with the code BETA50"
  // "Buy me a coffee".
  donateUrl: 'https://ko-fi.com/reboxed',
};

/**
 * When the beta stops, as a timestamp: local midnight at the end of its last day (betaEndsAt is
 * the last day included: '2027-01-31' stops at the start of 1 February), or null.
 */
export const betaEnd = (p = PRODUCT) => {
  if (!p.betaEndsAt) return null;
  const d = new Date(`${p.betaEndsAt}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

/** Is a licence key (Lemon Squeezy activation / validation meta) a beta key? */
export const isBetaKey = (meta = {}, p = PRODUCT) => (p.betaProductId != null ? meta.product_id === p.betaProductId : /\bbeta\b/i.test(`${meta.product_name ?? ''} ${meta.variant_name ?? ''}`));
