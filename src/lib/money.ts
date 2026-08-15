export const centsFromEuros = (euros: number): number =>
  Math.round(euros * 100);

export const eurosFromCents = (cents: number): number => cents / 100;

/** Quantity can have three decimals for weighed products. */
export const lineTotalCents = (
  qty: number,
  unitPriceCents: number,
): number => Math.round(qty * unitPriceCents);

/**
 * Sum of `qty × unit price` over a whole cart, or NULL when ANY line's unit
 * price is unknown to the caller.
 *
 * `unitCentsByProduct` carries the prices the server ALREADY rendered on the
 * current page — nothing here derives a price, it only adds up figures that
 * were resolved from the company's tarifa server-side. The null is what keeps
 * the mobile cart bar honest: a cart holding one product this page never priced
 * has no subtotal to show, and a short total is worse than no total.
 */
export const cartSubtotalCents = (
  qtyByProduct: Record<string, number>,
  unitCentsByProduct: Record<string, number>,
): number | null => {
  let total = 0;
  for (const [productId, qty] of Object.entries(qtyByProduct)) {
    const unitCents = unitCentsByProduct[productId];
    if (typeof unitCents !== "number") return null;
    total += lineTotalCents(qty, unitCents);
  }
  return total;
};

export const formatEuros = (cents: number, locale: string): string =>
  new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
