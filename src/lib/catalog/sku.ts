export interface ParsedSku {
  base: string;
  suffix: string;
}

/** Parse only a capital variant suffix that follows a numeric tail. */
export function parseSku(codart: string): ParsedSku {
  const sku = codart.trim();
  const match = sku.match(/^(.*\d)([A-Z])$/);
  return match
    ? { base: match[1], suffix: match[2] }
    : { base: sku, suffix: "" };
}
