"use server";

import { hasLocale } from "next-intl";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clearCart } from "@/app/actions/cart";
import { routing } from "@/i18n/routing";
import { CART_COOKIE, parseCart } from "@/lib/cart";
import type { OrderErrorKey } from "@/lib/orders";
import { isUuid, mapOrderError } from "@/lib/orders";
import type { Json } from "@/lib/supabase/database.types";
import { createServerSupabase } from "@/lib/supabase/server";

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/** What `<input type="date">` submits, and all `p_delivery_date` can parse. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Back to the cart with a message. The base is built from `safeLocale`, never
 * from the form, so unlike the catalog's `back` round trip there is no
 * open-redirect surface to defend here.
 */
function cartErrorHref(
  locale: string,
  key: OrderErrorKey,
  detail: string | null,
): string {
  const params = new URLSearchParams({ error: key });
  if (detail) params.set("detail", detail);
  return `/${locale}/carrito?${params}`;
}

/** `create_order` returns `{order_id, order_number, duplicate?}` as jsonb. */
function orderNumberOf(data: Json | null): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data.order_number;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type Outcome =
  | { ok: true; orderNumber: number | null }
  | { ok: false; key: OrderErrorKey; detail: string | null };

/**
 * Submit the cart as an order.
 *
 * **The cookie is the order.** Lines are read server-side from the httpOnly
 * cart; the page renders no line inputs at all, so a crafted POST cannot slip in
 * a product the customer never added — and `create_order` re-resolves every
 * price from the company's tarifa regardless (CLAUDE.md: prices are never
 * trusted from the client).
 *
 * **The cart survives failure.** It is cleared only after the RPC has returned
 * an order, so a rejected submit leaves the customer's lines exactly where they
 * were, ready to fix and resend.
 */
export async function submitOrder(formData: FormData) {
  const locale = safeLocale(formData.get("locale"));

  const cart = parseCart((await cookies()).get(CART_COOKIE)?.value);
  const lines = Object.entries(cart).map(([product_id, qty]) => ({
    product_id,
    qty,
  }));
  if (lines.length === 0) {
    redirect(cartErrorHref(locale, "EMPTY_ORDER", null));
  }

  // The RANGE is create_order's call — it judges Madrid today..+60 on the
  // database clock, which is the only clock that counts. The SHAPE is ours: a
  // malformed string would come back as an opaque cast error instead of the
  // BAD_DELIVERY_DATE the customer can act on.
  const rawDate = String(formData.get("delivery_date") ?? "").trim();
  if (rawDate !== "" && !ISO_DAY.test(rawDate)) {
    redirect(cartErrorHref(locale, "BAD_DELIVERY_DATE", null));
  }
  const note = String(formData.get("note") ?? "").trim();
  const token = String(formData.get("client_token") ?? "");

  const supabase = await createServerSupabase();
  let outcome: Outcome;
  // Only the RPC round trip lives in this block. `redirect()` works by THROWING
  // NEXT_REDIRECT, so a redirect inside a try that catches everything would be
  // swallowed and reported to the customer as an unknown order failure.
  try {
    const { data, error } = await supabase.rpc("create_order", {
      p_lines: lines,
      p_delivery_date: rawDate === "" ? undefined : rawDate,
      p_note: note === "" ? undefined : note,
      // Minted once per RENDER of the cart, so a double-submit of the same page
      // is idempotent by construction: create_order hands back the order it
      // already made instead of a second one. A token that is not a uuid can
      // only come from a crafted POST; dropping it costs that caller the
      // idempotency it declined to ask for properly.
      p_client_token: isUuid(token) ? token : undefined,
    });
    outcome = error
      ? { ok: false, ...mapOrderError(error.message) }
      : { ok: true, orderNumber: orderNumberOf(data) };
  } catch (cause) {
    // supabase-js reports Postgres failures in `error`, so reaching here means
    // the request never completed.
    console.error("submitOrder create_order:", cause);
    outcome = { ok: false, key: "UNKNOWN", detail: null };
  }

  if (!outcome.ok) {
    redirect(cartErrorHref(locale, outcome.key, outcome.detail));
  }

  // Same writer as the cart's own actions, so the cookie flags and the paths
  // revalidated after a checkout can never drift from the ones set on an add.
  const reset = new FormData();
  reset.set("locale", locale);
  await clearCart(reset);

  const created = outcome.orderNumber;
  redirect(
    created == null
      ? `/${locale}/pedidos`
      : `/${locale}/pedidos?created=${created}`,
  );
}
