import { describe, expect, it } from "vitest";
import {
  catalogCategoryHref,
  categoryImageMap,
  resolveCatalogCategory,
} from "./category-browser";

describe("categoryImageMap", () => {
  it("keeps an edited category image ahead of product fallbacks", () => {
    const images = categoryImageMap(
      [
        { id: 1, image_url: "https://images/category.jpg" },
        { id: 2, image_url: null },
      ],
      [
        { category_id: 1, image_url: "https://images/product-1.jpg" },
        { category_id: 2, image_url: "https://images/product-2.jpg" },
      ],
    );

    expect(Object.fromEntries(images)).toEqual({
      1: "https://images/category.jpg",
      2: "https://images/product-2.jpg",
    });
  });

  it("uses the first usable pictured product and ignores unrelated rows", () => {
    const images = categoryImageMap(
      [
        { id: 1, image_url: "  " },
        { id: 2, image_url: null },
      ],
      [
        { category_id: null, image_url: "https://images/uncategorised.jpg" },
        { category_id: 3, image_url: "https://images/hidden.jpg" },
        { category_id: 1, image_url: null },
        { category_id: 1, image_url: "https://images/first.jpg" },
        { category_id: 1, image_url: "https://images/second.jpg" },
      ],
    );

    expect(Object.fromEntries(images)).toEqual({
      1: "https://images/first.jpg",
    });
  });
});

describe("category catalogue links", () => {
  const categories = [
    { id: 7, erp_code: "83" },
    { id: 8, erp_code: "p123" },
  ];

  it("writes the numeric category URL used by the browser page", () => {
    expect(catalogCategoryHref("zh", 7)).toBe("/zh/catalogo?category=7");
  });

  it("prefers the new id parameter and retains legacy ERP-code bookmarks", () => {
    expect(resolveCatalogCategory("8", "83", categories)).toEqual(categories[1]);
    expect(resolveCatalogCategory(undefined, "83", categories)).toEqual(
      categories[0],
    );
  });

  it("fails open to an unfiltered catalogue for malformed or stale ids", () => {
    expect(resolveCatalogCategory("7 OR 1=1", undefined, categories)).toBeNull();
    expect(resolveCatalogCategory("999", undefined, categories)).toBeNull();
  });
});
