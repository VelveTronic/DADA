"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import type { Cart } from "@/lib/cart";
import {
  CART_COOKIE,
  isProductId,
  parseCart,
  serializeCart,
  setQty,
} from "@/lib/cart";

/** 30 days: long enough that a cart survives a weekend, short enough to expire. */
const CART_MAX_AGE = 60 * 60 * 24 * 30;

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * A redirect target this server may hand a browser: path-absolute and
 * same-origin. `//host` and `/\host` are protocol-relative URLs to a browser,
 * not paths.
 */
function isSafePath(value: string): boolean {
  return (
    value.length <= 512 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
  );
}

/**
 * Where to bounce the browser when a cart edit fails, with `?cartError` for the
 * page to render.
 *
 * `back` carries the caller's own URL (search, tab and page) so an error does
 * not throw the customer back to page 1 of the unfiltered catalog. It is form
 * input, so it is never trusted. The base below is a throwaway — only
 * pathname+search is ever emitted, never a host.
 */
function cartErrorHref(
  back: FormDataEntryValue | null,
  fallback: string,
  code: "full" | "qty",
): string {
  const raw = String(back ?? "");
  const path = isSafePath(raw) ? raw : fallback;
  try {
    const url = new URL(path, "http://cart.invalid");
    url.searchParams.set("cartError", code);
    const href = `${url.pathname}${url.search}`;
    // Checked AGAIN after parsing. WHATWG strips ASCII tab/newline before it
    // parses, so `/<TAB>/evil.com//x` passes the check above and comes back out
    // as the protocol-relative `//x` — an open redirect if it were emitted.
    return isSafePath(href) ? href : `${fallback}?cartError=${code}`;
  } catch {
    return `${fallback}?cartError=${code}`;
  }
}

async function readCart(): Promise<Cart> {
  return parseCart((await cookies()).get(CART_COOKIE)?.value);
}

/**
 * httpOnly so no script can read or forge the cart; lax so it still rides along
 * on the top-level GET that follows a redirect. Quantities only — a price never
 * goes into this cookie (CLAUDE.md: prices are never trusted from the client).
 */
async function writeCart(cart: Cart): Promise<void> {
  (await cookies()).set(CART_COOKIE, serializeCart(cart), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: CART_MAX_AGE,
  });
}

function revalidateCart(locale: string): void {
  revalidatePath(`/${locale}/catalogo`);
  revalidatePath(`/${locale}/carrito`);
}

/** Add `qty` (default 1) to whatever the line already holds. */
export async function addToCart(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));
  const productId = String(formData.get("product_id") ?? "");
  const back = formData.get("back");
  const fallback = `/${locale}/catalogo`;
  // A junk product id can only come from a crafted POST. Silent, like the
  // favorites action: there is nothing here worth an error page.
  if (!isProductId(productId)) return;

  const rawQty = formData.get("qty");
  const text = String(rawQty ?? "").trim();
  const qty = text === "" ? 1 : Number(text);
  if (!Number.isFinite(qty) || qty <= 0) {
    redirect(cartErrorHref(back, fallback, "qty"));
  }

  const cart = await readCart();
  let next: Cart;
  try {
    next = setQty(cart, productId, (cart[productId] ?? 0) + qty);
  } catch (error) {
    const full = error instanceof Error && error.message === "CART_FULL";
    redirect(cartErrorHref(back, fallback, full ? "full" : "qty"));
  }

  await writeCart(next);
  revalidateCart(locale);
}

/** Absolute quantity for one line; 0 removes it. */
export async function setCartQty(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));
  const productId = String(formData.get("product_id") ?? "");
  const back = formData.get("back");
  const fallback = `/${locale}/carrito`;
  if (!isProductId(productId)) return;

  const text = String(formData.get("qty") ?? "").trim();
  // Blank is an error, never a silent delete: a customer who clears the box by
  // accident must not lose the line without being told.
  const qty = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(qty) || qty < 0) {
    redirect(cartErrorHref(back, fallback, "qty"));
  }

  const cart = await readCart();
  let next: Cart;
  try {
    next = setQty(cart, productId, qty);
  } catch (error) {
    const full = error instanceof Error && error.message === "CART_FULL";
    redirect(cartErrorHref(back, fallback, full ? "full" : "qty"));
  }

  await writeCart(next);
  revalidateCart(locale);
}

/** Empty the cart. Also the post-checkout reset. */
export async function clearCart(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));
  await writeCart({});
  revalidateCart(locale);
}
