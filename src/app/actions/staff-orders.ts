"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { assertStaff } from "@/lib/auth/assert-staff";
import type {
  BulkConfirmActionState,
  LineEditResult,
  QueueTab,
} from "@/lib/orders";
import {
  isUuid,
  mapLineEditError,
  normalizeBulkConfirmIds,
  parseBulkConfirmResult,
  safeQueueTab,
  validateLineQty,
} from "@/lib/orders";
import { createServerSupabase } from "@/lib/supabase/server";

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * The three things a staff transition can do, all of them worth a banner:
 * `ok` it applied, `wrong-state` the RPC returned false (the order had already
 * moved on), `error` the call itself failed and nothing is known about the order.
 */
type RpcResult = "ok" | "wrong-state" | "error";

/** Back to the queue, on the tab the staff member was looking at. */
function queueHref(locale: string, tab: QueueTab, result: RpcResult): string {
  const params = new URLSearchParams({ rpcResult: result });
  if (tab !== "submitted") params.set("estado", tab);
  return `/${locale}/staff/pedidos?${params}`;
}

/** Exactly the two fields of an RPC reply this code reads. */
type RpcReply = { data: boolean | null; error: { message: string } | null };

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

/**
 * The shared body of all order-state transitions.
 *
 * `false` is NOT success. Every RPC constrains the state it may leave, so false
 * means somebody else moved the order first — the queue says so instead of
 * redrawing as if the click had worked (alertable, never assume).
 *
 * The RPC runs on the AUTHENTICATED client, never the service-role one: it
 * gates on `private.is_staff()` itself, and the `order_events` row it writes
 * records `auth.uid()` as the actor. An admin-client call would file every
 * confirmation under nobody.
 */
async function runTransition(
  formData: FormData,
  perform: (
    supabase: ServerSupabase,
    orderId: string,
    text: string | undefined,
  ) => Promise<RpcReply>,
): Promise<void> {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const tab = safeQueueTab(String(formData.get("estado") ?? ""));
  const orderId = String(formData.get("order_id") ?? "");
  // An order id that is not a uuid can only come from a crafted POST, and would
  // otherwise reach Postgres as a cast error. Silent, like the cart actions.
  if (!isUuid(orderId)) return;

  // Both forms name the field `note`: the confirm note and the cancel reason are
  // the same box to a staff member, and only the RPC parameter differs.
  const raw = String(formData.get("note") ?? "").trim();
  const text = raw === "" ? undefined : raw;

  const supabase = await createServerSupabase();
  let result: RpcResult;
  // Only the RPC round trip lives in this block. `redirect()` works by THROWING
  // NEXT_REDIRECT, so a redirect inside a catch-all try would be swallowed.
  try {
    const { data, error } = await perform(supabase, orderId, text);
    if (error) {
      // Not a wrong state: NOTE_TOO_LONG, a revoked grant, a lost connection.
      // Reporting those as "already confirmed" would be a lie.
      console.error("staff order transition:", error);
      result = "error";
    } else {
      result = data === true ? "ok" : data === false ? "wrong-state" : "error";
    }
  } catch (cause) {
    console.error("staff order transition:", cause);
    result = "error";
  }

  revalidatePath(`/${locale}/staff/pedidos`);
  redirect(queueHref(locale, tab, result));
}

/** submitted → confirmed, with an optional internal note. */
export async function confirmOrder(formData: FormData) {
  await runTransition(formData, async (supabase, orderId, note) => {
    const { data, error } = await supabase.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_staff_note: note,
    });
    return { data, error };
  });
}

/**
 * submitted[] → confirmed[] in one database transaction.
 *
 * The web app deliberately stops at `confirmed`.  The on-premise bridge is the
 * only component with Wingest credentials and will claim these rows on its next
 * run; moving that import into this Server Action would collapse the project's
 * credential boundary back into the public web tier.
 *
 * Unlike the single-row form this action returns state to `useActionState`
 * instead of redirecting.  The database reports both applied and skipped rows,
 * so a concurrent confirmation is visible as a partial result rather than being
 * guessed away.  A database error is transaction-wide: no successful prefix is
 * possible because the UPDATE and audit INSERT live in one RPC transaction.
 */
export async function confirmOrdersBulk(
  _previous: BulkConfirmActionState,
  formData: FormData,
): Promise<BulkConfirmActionState> {
  // A Server Action is an independent POST endpoint.  The page guard and a
  // disabled button are UI only; authorization is repeated here and again by
  // the security-definer RPC.
  await assertStaff();

  const locale = safeLocale(formData.get("locale"));
  const ids = normalizeBulkConfirmIds(formData.getAll("order_id"));
  if (!ids) {
    return {
      outcome: "invalid",
      requestedCount: 0,
      confirmedCount: 0,
      skippedCount: 0,
    };
  }

  const supabase = await createServerSupabase();
  try {
    const { data, error } = await supabase.rpc("staff_bulk_confirm_orders", {
      p_order_ids: ids,
    });
    if (error) {
      console.error("staff bulk confirm:", error);
      return {
        outcome: "error",
        requestedCount: ids.length,
        confirmedCount: 0,
        skippedCount: 0,
      };
    }

    const result = parseBulkConfirmResult(data, ids);
    if (!result) {
      console.error("staff bulk confirm: malformed RPC result");
      return {
        outcome: "error",
        requestedCount: ids.length,
        confirmedCount: 0,
        skippedCount: 0,
      };
    }

    revalidatePath(`/${locale}/staff/pedidos`);
    return {
      outcome:
        result.confirmedCount === result.requestedCount
          ? "ok"
          : result.confirmedCount === 0
            ? "wrong-state"
            : "partial",
      requestedCount: result.requestedCount,
      confirmedCount: result.confirmedCount,
      skippedCount: result.skippedCount,
    };
  } catch (cause) {
    console.error("staff bulk confirm:", cause);
    return {
      outcome: "error",
      requestedCount: ids.length,
      confirmedCount: 0,
      skippedCount: 0,
    };
  }
}

/** submitted → cancelled, with an optional reason (stored as an event detail). */
export async function cancelOrder(formData: FormData) {
  await runTransition(formData, async (supabase, orderId, reason) => {
    const { data, error } = await supabase.rpc("staff_cancel_order", {
      p_order_id: orderId,
      p_reason: reason,
    });
    return { data, error };
  });
}

/**
 * bridge_failed → confirmed, clearing this failure cycle so the bridge may
 * claim it again.
 *
 * The RPC is the authority on the transition and records the staff actor. This
 * action repeats the active-staff gate because a Server Action is an independent
 * POST endpoint, even when its button only renders on the protected queue.
 */
export async function requeueOrder(formData: FormData) {
  await runTransition(formData, async (supabase, orderId) => {
    const { data, error } = await supabase.rpc("staff_requeue_order", {
      p_order_id: orderId,
    });
    return { data, error };
  });
}

/** Back to the queue with the line editor's own banner code. */
function lineHref(
  locale: string,
  tab: QueueTab,
  result: LineEditResult,
): string {
  const params = new URLSearchParams({ lineResult: result });
  if (tab !== "submitted") params.set("estado", tab);
  return `/${locale}/staff/pedidos?${params}`;
}

/**
 * Set the real quantity on ONE line of a pending order — the weighed-goods edit,
 * and the partial-stock one.
 *
 * `staff_update_order_line` is the authority on every rule here and this action
 * repeats none of them: the factor, the price and the product's weighed flag are
 * all re-read inside the RPC, which is the only place they can be read without
 * asking the form that is being validated. What the action owns is the shape of
 * the request and the banner code that comes back.
 *
 * The ONE check it makes first is the shape of the number itself, and it makes it
 * on the PERMISSIVE branch (`isWeighed: true`): NaN, zero, a negative, four
 * decimals and anything over the cart's own 9,999 cap are answered here rather
 * than a round trip later, while the integer-vs-fractional question is left
 * entirely to the RPC — the action cannot know whether this product is weighed,
 * and a form field claiming so would be exactly the input we refuse to trust.
 *
 * Like the two transitions above, this runs on the AUTHENTICATED client: the RPC
 * gates on `private.is_staff()` and files the `line_adjusted` event under
 * `auth.uid()`, which a service-role call would record as nobody.
 */
export async function updateOrderLineQty(formData: FormData) {
  await assertStaff();
  const locale = safeLocale(formData.get("locale"));
  const tab = safeQueueTab(String(formData.get("estado") ?? ""));
  const orderId = String(formData.get("order_id") ?? "");
  // `order_items.id` is a bigint identity, so the wire value is a plain integer.
  const itemId = Number(formData.get("item_id"));
  // Neither can come out of the rendered page malformed; both would otherwise
  // reach Postgres as a cast error. Silent, like the cart actions.
  if (!isUuid(orderId) || !Number.isSafeInteger(itemId) || itemId <= 0) return;

  // `<input type="number">` always posts a dot-decimal string or an empty one —
  // a comma typed into it never reaches here, it makes the field blank, and a
  // blank field is a quantity of zero, which is a BAD_QTY like any other.
  const qty = Number(String(formData.get("qty") ?? "").trim());
  // Named like the other two forms' field. The card has no per-line note box
  // today; the RPC takes one and records it in the audit row, so the action
  // forwards whatever the form carries rather than hard-coding its absence.
  const rawNote = String(formData.get("note") ?? "").trim();
  const note = rawNote === "" ? undefined : rawNote;

  let result: LineEditResult;
  const shape = validateLineQty(qty, true);
  if (shape) {
    result = shape;
  } else {
    const supabase = await createServerSupabase();
    // Only the RPC round trip lives in this block — `redirect()` throws
    // NEXT_REDIRECT, which a catch-all try would swallow.
    try {
      const { data, error } = await supabase.rpc("staff_update_order_line", {
        p_order_id: orderId,
        p_item_id: itemId,
        p_qty: qty,
        p_note: note,
      });
      if (error) {
        console.error("staff line edit:", error);
        result = mapLineEditError(error.message);
      } else {
        // `false` is NOT success: the RPC updates `where status = 'submitted'`
        // and answers whether that still held, so a false means the order was
        // confirmed or cancelled first and this quantity never landed.
        result =
          data === true ? "ok" : data === false ? "WRONG_STATE" : "DB_ERROR";
      }
    } catch (cause) {
      console.error("staff line edit:", cause);
      result = "DB_ERROR";
    }
  }

  // The customer's own /pedidos needs nothing: it is `force-dynamic` and reads
  // the same rows on its next request, which is why the two transitions above
  // revalidate only this path either.
  revalidatePath(`/${locale}/staff/pedidos`);
  redirect(lineHref(locale, tab, result));
}
