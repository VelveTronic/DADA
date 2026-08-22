import { describe, expect, it } from "vitest";
import {
  CATALOG_IMAGE_ACCEPT,
  MAX_CATALOG_IMAGE_BYTES,
  validateCatalogImage,
} from "./catalog-image";

describe("validateCatalogImage", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ])("accepts %s as %s", (type, extension) => {
    expect(validateCatalogImage({ type, size: 1024 })).toEqual({
      ok: true,
      extension,
    });
  });

  it.each(["image/gif", "image/svg+xml", "text/html", ""])(
    "rejects %s",
    (type) => {
      expect(validateCatalogImage({ type, size: 1024 })).toEqual({
        ok: false,
        code: "IMAGE_TYPE",
      });
    },
  );

  it("accepts the exact size ceiling", () => {
    expect(
      validateCatalogImage({ type: "image/png", size: MAX_CATALOG_IMAGE_BYTES }),
    ).toEqual({ ok: true, extension: "png" });
  });

  it.each([MAX_CATALOG_IMAGE_BYTES + 1, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an unsafe byte size (%s)",
    (size) => {
      expect(validateCatalogImage({ type: "image/png", size })).toEqual({
        ok: false,
        code: "IMAGE_TOO_LARGE",
      });
    },
  );

  it("keeps the file-input hint in lockstep with the accepted MIME types", () => {
    expect(CATALOG_IMAGE_ACCEPT).toBe("image/jpeg,image/png,image/webp");
  });
});
