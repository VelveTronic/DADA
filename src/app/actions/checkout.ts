"use server";

import { hasLocale } from "next-intl";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clearCart } from "@/app/actions/cart";
import { routing } from "@/i18n/routing";
import { CART_COOKIE, parseCart } from "@/lib/cart";
import type { OrderErrorKey } from "@/lib/orders";
import { isUuid, mapOrderError } from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { getSetting } from "@/lib/settings";
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
  const perf = perfRun("action:checkout.submitOrder");
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

  // The owner's `show_delivery_date` switch, re-read on the POST rather than
  // trusted from the render that drew the form. With the switch off the cart
  // page ships no date field at all, so the ordinary checkout posts nothing here
  // and this read never happens; what it catches is the tab that was OPEN when
  // the owner flipped the switch, and the crafted body — a server action is an
  // open POST endpoint, so the page hiding the field proves nothing about what
  // arrives (`staff-settings.ts` states the same rule for the owner gate).
  //
  // Only reached when a date was actually posted, so an order with no date pays
  // nothing for this, and the switched-off portal pays nothing at all. It fails
  // OPEN like every settings read: an unreachable `portal_settings` leaves the
  // customer's chosen date exactly where it was.
  //
  // REPLAY: the date is part of create_order's request hash, so a form rendered
  // with a date and re-submitted after the switch changed hashes differently
  // from the submit that created the order — the same `client_token` then comes
  // back IDEMPOTENCY_MISMATCH rather than a duplicate. That is the safe half of
  // the trade: the customer sees "the order changed, check it" over an order
  // that exists, never a second order.
  const deliveryDate =
    rawDate !== "" &&
    (await perf.step("settings", getSetting(supabase, "show_delivery_date")))
      ? rawDate
      : "";
  let outcome: Outcome;
  // Only the RPC round trip lives in this block. `redirect()` works by THROWING
  // NEXT_REDIRECT, so a redirect inside a try that catches everything would be
  // swallowed and reported to the customer as an unknown order failure.
  try {
    // The one round trip a checkout makes. It is also the slowest single call
    // in the portal — `create_order` re-resolves every price, writes the order,
    // its lines and its events — so it is worth being able to see on its own.
    const { data, error } = await perf.step(
      "create_order",
      supabase.rpc("create_order", {
        p_lines: lines,
        // Absent, not null: supabase-js omits an `undefined` argument from the
        // body and PostgREST then takes the function's own `default null`, which
        // is the same stored value and the same request hash as a date the
        // customer simply did not pick.
        p_delivery_date: deliveryDate === "" ? undefined : deliveryDate,
        p_note: note === "" ? undefined : note,
        // Minted once per RENDER of the cart, so a double-submit of the same
        // page is idempotent by construction: create_order hands back the order
        // it already made instead of a second one. A token that is not a uuid
        // can only come from a crafted POST; dropping it costs that caller the
        // idempotency it declined to ask for properly.
        p_client_token: isUuid(token) ? token : undefined,
      }),
    );
    outcome = error
      ? { ok: false, ...mapOrderError(error.message) }
      : { ok: true, orderNumber: orderNumberOf(data) };
  } catch (cause) {
    // supabase-js reports Postgres failures in `error`, so reaching here means
    // the request never completed.
    console.error("submitOrder create_order:", cause);
    outcome = { ok: false, key: "UNKNOWN", detail: null };
  }
  // Before the redirects: every exit from here throws, so a line logged after
  // one of them would only ever be logged on the paths that did not take it.
  perf.end();

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
