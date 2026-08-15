export const centsFromEuros = (euros: number): number =>
  Math.round(euros * 100);

export const eurosFromCents = (cents: number): number => cents / 100;

/** Quantity can have three decimals for weighed products. */
export const lineTotalCents = (
  qty: number,
  unitPriceCents: number,
): number => Math.round(qty * unitPriceCents);

export const formatEuros = (cents: number, locale: string): string =>
  new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "es-ES", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
