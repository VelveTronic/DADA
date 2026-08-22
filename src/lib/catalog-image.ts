/** The formats accepted by every catalogue-image upload surface. */
const CATALOG_IMAGE_EXTENSIONS: Readonly<Record<string, "jpg" | "png" | "webp">> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Public Supabase bucket shared by product and category artwork. */
export const CATALOG_IMAGE_BUCKET = "product-images";

/** Used by both file inputs so the browser hint matches server validation. */
export const CATALOG_IMAGE_ACCEPT = Object.keys(CATALOG_IMAGE_EXTENSIONS).join(",");

/** 5 MB. The normal catalogue asset is much smaller; this is an abuse guard. */
export const MAX_CATALOG_IMAGE_BYTES = 5 * 1024 * 1024;

export type CatalogImageCheck =
  | { ok: true; extension: "jpg" | "png" | "webp" }
  | { ok: false; code: "IMAGE_TYPE" | "IMAGE_TOO_LARGE" };

/**
 * One shared server-side contract for product and category uploads.
 *
 * The browser's `accept` attribute is only a picker hint. Both Server Actions
 * call this function again on the received File before any bytes reach Storage.
 */
export function validateCatalogImage(file: {
  type: string;
  size: number;
}): CatalogImageCheck {
  const extension = CATALOG_IMAGE_EXTENSIONS[file.type];
  if (!extension) return { ok: false, code: "IMAGE_TYPE" };
  if (!Number.isSafeInteger(file.size) || file.size > MAX_CATALOG_IMAGE_BYTES) {
    return { ok: false, code: "IMAGE_TOO_LARGE" };
  }
  return { ok: true, extension };
}
