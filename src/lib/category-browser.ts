import { parseCategoryId } from "@/lib/categories";

/** The two image sources one category card can use. */
export interface BrowserCategoryImage {
  id: number;
  image_url: string | null;
}

/** The narrow product projection used only to find a category cover. */
export interface BrowserProductImage {
  category_id: number | null;
  image_url: string | null;
}

/** Empty and whitespace-only database values are not usable image URLs. */
function imageUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

/**
 * One cover per category: an explicitly edited category image wins, otherwise
 * the first pictured product in the stable query order becomes the fallback.
 * Categories with neither source stay absent so the UI can draw the DADA mark.
 */
export function categoryImageMap(
  categories: readonly BrowserCategoryImage[],
  products: readonly BrowserProductImage[],
): ReadonlyMap<number, string> {
  const images = new Map<number, string>();
  const categoryIds = new Set(categories.map((category) => category.id));

  for (const category of categories) {
    const configured = imageUrl(category.image_url);
    if (configured) images.set(category.id, configured);
  }

  for (const product of products) {
    const id = product.category_id;
    if (id === null || !categoryIds.has(id) || images.has(id)) continue;
    const fallback = imageUrl(product.image_url);
    if (fallback) images.set(id, fallback);
  }

  return images;
}

/** The requested public URL contract for a category card. */
export function catalogCategoryHref(locale: string, categoryId: number): string {
  return `/${locale}/catalogo?category=${categoryId}`;
}

/**
 * Resolve the new numeric `?category=` link while retaining old `?cat=` ERP
 * bookmarks. A malformed or stale value is simply an unfiltered catalogue.
 */
export function resolveCatalogCategory<
  T extends { id: number; erp_code: string },
>(
  categoryParam: string | undefined,
  legacyCatParam: string | undefined,
  categories: readonly T[],
): T | null {
  const id = parseCategoryId(categoryParam);
  if (id !== null) return categories.find((category) => category.id === id) ?? null;
  return (
    categories.find((category) => category.erp_code === legacyCatParam) ?? null
  );
}
