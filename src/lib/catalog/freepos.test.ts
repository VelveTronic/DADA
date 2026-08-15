import { describe, expect, it } from "vitest";
import {
  FREEPOS_IMPORT_COLUMNS,
  parseFreeposImportSnapshot,
  toFreeposSkuPricing,
} from "./freepos";

const encoder = new TextEncoder();

function snapshot(extraHeader: string[] = [], extraCells: unknown[] = []) {
  const header = [...FREEPOS_IMPORT_COLUMNS, ...extraHeader];
  const row = [
    "100-034A",
    "Producto",
    null,
    "2.3300",
    "1.9900",
    "2.1900",
    "6.0000",
    "4.5000",
    null,
    "0.10",
    "0",
    null,
    null,
    null,
    ...extraCells,
  ];
  return encoder.encode(JSON.stringify({ header, rows: [row] }));
}

describe("Freepos import boundary", () => {
  it("decodes strict UTF-8 and drops non-import columns", () => {
    const [row] = parseFreeposImportSnapshot(
      snapshot(["内部备注"], ["must not escape"]),
    );

    expect(Object.keys(row)).toEqual(FREEPOS_IMPORT_COLUMNS);
    expect(row).not.toHaveProperty("内部备注");
  });

  it("rejects malformed UTF-8 before JSON parsing", () => {
    expect(() =>
      parseFreeposImportSnapshot(new Uint8Array([0xc3, 0x28])),
    ).toThrow("valid UTF-8");
  });

  it("rejects a missing or duplicate required column", () => {
    const missingDocument = JSON.parse(new TextDecoder().decode(snapshot()));
    missingDocument.header.shift();
    missingDocument.rows[0].shift();
    expect(() =>
      parseFreeposImportSnapshot(
        encoder.encode(JSON.stringify(missingDocument)),
      ),
    ).toThrow('column "编号" must occur exactly once');

    expect(() =>
      parseFreeposImportSnapshot(snapshot(["编号"], ["duplicate"])),
    ).toThrow('column "编号" must occur exactly once');
  });

  it("rejects rows whose width differs from the header", () => {
    const document = JSON.parse(new TextDecoder().decode(snapshot()));
    document.rows[0].pop();

    expect(() =>
      parseFreeposImportSnapshot(encoder.encode(JSON.stringify(document))),
    ).toThrow("does not match the header width");
  });

  it("converts SKU variants, euros, and fractional tax rates", () => {
    const [row] = parseFreeposImportSnapshot(snapshot());

    expect(toFreeposSkuPricing(row)).toEqual({
      codart: "100-034A",
      base_sku: "100-034",
      variant_suffix: "A",
      price_1_cents: 233,
      price_2_cents: 199,
      price_3_cents: 219,
      price_4_cents: 600,
      price_5_cents: 450,
      price_6_cents: null,
      iva_rate: 10,
    });
  });
});
