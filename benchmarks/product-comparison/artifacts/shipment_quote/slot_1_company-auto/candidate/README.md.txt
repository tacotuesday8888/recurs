# Parcel shop: implement shipment quotes

The storefront has a quote API skeleton. Implement its cart, pricing and delivery
modules, then finish their integration in src/quote.js. Use synchronous exports,
Node built-ins only, and do not mutate any input. Change only src/cart.js,
src/pricing.js, src/delivery.js and src/quote.js. Public tests are immutable.
Run npm test. No network, persistence, clock, or external service is required.

Acceptance requirements:
- normalizeCart(items, catalog) takes an array of at most 100 {sku, quantity}
  records. sku is a nonempty string and must be an OWN key of catalog; quantity
  is an integer from 1 to 1000. Catalog entries used by the cart have integer
  unitCents in [0,1000000], grams in [1,100000], and stock in [0,1000000].
  Throw TypeError for invalid input, missing SKUs, or invalid used entries.
  Empty arrays are valid. Catalog is a non-null non-array object; unused entries
  are ignored. Merge duplicate SKUs in first-appearance order. If the merged
  quantity exceeds stock, throw RangeError. Return new records containing
  exactly {sku, quantity, unitCents, grams}; no catalog references escape.
- priceCart(lines, discountBps = 0) accepts normalized lines. discountBps must be
  an integer in [0,10000], otherwise TypeError. Compute subtotalCents as the sum
  of quantity * unitCents. Apply ONE discount to the whole subtotal, rounding
  DOWN: discountCents = floor(subtotalCents * discountBps / 10000). Return exactly
  {subtotalCents, discountCents, merchandiseCents}, where merchandiseCents is
  subtotalCents minus discountCents. Free items are allowed.
- deliveryCost(totalGrams, merchandiseCents, zone) takes integer totalGrams in
  [0,10000000000], integer merchandiseCents in [0,100000000000], and zone equal
  to local or remote. Invalid arguments throw TypeError, including unknown
  zones on empty orders. Zero grams costs zero. Otherwise charge per STARTED
  kilogram: local = 500 + 200 * ceil(totalGrams/1000); remote = 900 + 350 *
  ceil(totalGrams/1000). Local delivery is free when merchandiseCents >= 5000
  AFTER the discount. Remote delivery is never free for nonempty orders.
- quote(items, catalog, {zone = 'local', discountBps = 0} = {}) composes those
  modules. Return exactly {lines, subtotalCents, discountCents, merchandiseCents,
  deliveryCents, totalCents}, where totalCents includes delivery and shipment
  weight includes every unit. Propagate validation failures, including invalid
  zone/discount on an empty cart. Preserve the exported function names.

Scope: a small deterministic pricing exercise, not checkout, payments, taxes,
inventory reservation, or a full commerce application. Modules have distinct
responsibilities, but the quote integration depends on their shared contracts.
