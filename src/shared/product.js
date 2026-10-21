// Where Reboxed is sold (Lemon Squeezy). storeId / productId: a key from another store or product is
// refused once they are set. Discount codes are made in the Lemon Squeezy dashboard (Store > Discounts).
export const PRODUCT = {
  name: 'Reboxed',
  price: '10 €',
  buyUrl: 'https://reboxed.lemonsqueezy.com/checkout/buy/3639fa22-a137-4f19-986e-ad7dbe941e4c',
  storeId: null,
  productId: null,
  // Open beta: free for everyone until this date (local midnight); then the trial, then a licence.
  betaEndsAt: '2026-12-21',
  // "Buy me a coffee": a donation page (Lemon Squeezy pay-what-you-want product, Ko-fi…). Hidden while empty.
  donateUrl: null,
};

/** The beta end date as a timestamp (local midnight), or null. */
export const betaEnd = (p = PRODUCT) => (p.betaEndsAt ? new Date(`${p.betaEndsAt}T00:00:00`).getTime() : null);
