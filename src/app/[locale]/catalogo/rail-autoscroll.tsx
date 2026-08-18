"use client";

import { useEffect } from "react";

/**
 * Scrolls the category rail to the entry the page is showing, once, on mount.
 *
 * The rail is a 61-entry column in an 88px gutter, so most of it is off screen:
 * a customer who lands on `/catalogo?cat=…` — from a bookmark, a shared link, a
 * reload, or the browser's back button after a hard navigation — gets the rail
 * at scrollTop 0, with the entry that is actually lit somewhere below the fold.
 * The screen then says "全部" on the left and a category's products on the
 * right, which reads as a broken filter rather than a scrolled list.
 *
 * `block: "nearest"` is the whole behaviour: an entry already in view is left
 * exactly where it is, so this cannot fight a customer who has scrolled the rail
 * themselves. It also scrolls no further than it must, which keeps the entry at
 * the edge it entered from instead of yanking it to the middle.
 *
 * It runs ONCE and that is deliberate. Picking a category is a client
 * navigation: the `<nav>` element survives it, so the rail keeps the scroll
 * position the customer left it at, and re-running this on every render would
 * take that away from them. The mount case is the only one where the position
 * was lost.
 *
 * A `document.querySelector` rather than a ref, because the element it wants is
 * a sibling rendered by the server component around it — a ref would mean
 * making every rail entry a client component to hold it. There is exactly one
 * `[data-rail-active]` on the page; the rail is single-select.
 */
export function RailAutoscroll() {
  useEffect(() => {
    document
      .querySelector("[data-rail-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, []);

  return null;
}
