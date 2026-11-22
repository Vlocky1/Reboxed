// Where Reboxed is sold: Dodo Payments. Two products: the lifetime licence and the free beta key.
// A key of any other product (or shop) is refused. Discount codes are made in the Dodo dashboard.
// The links (buy, donate, beta key), the product ids and the beta discount text can also come from the
// website's app-config.json, so they change without a new version.
export const PRODUCT = {
  name: 'Reboxed',
  price: '5 €',
  buyUrl: 'https://checkout.dodopayments.com/buy/pdt_0NsHIOSRfFGFzVqkzq5ca?quantity=1',
  dodoProductId: 'pdt_0NsHIOSRfFGFzVqkzq5ca',
  // Open beta: its last day (included). Beta keys stop working the next day at local midnight
  // (1 February 2027); beta testers get a discount. The website's app-config.json can move it.
  betaEndsAt: '2027-01-31',
  // Free "Reboxed Beta" product (0 €) whose keys register the testers.
  betaUrl: 'https://checkout.dodopayments.com/buy/pdt_0NsUxzJBBnEqtA4jnmpwP?quantity=1',
  dodoBetaProductId: 'pdt_0NsUxzJBBnEqtA4jnmpwP',
  // Does the beta ask for that key? Off when the website cannot be reached; its app-config.json
  // (betaKeyRequired) turns it on.
  betaKeyRequired: false,
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
