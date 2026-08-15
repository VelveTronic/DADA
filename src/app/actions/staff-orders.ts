"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { getSessionUser } from "@/lib/auth/session";
import type { QueueTab } from "@/lib/orders";
import { isUuid, safeQueueTab } from "@/lib/orders";
import { createServerSupabase } from "@/lib/supabase/server";

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/**
 * Server-action staff gate: verifies an active staff_users row; throws otherwise.
 *
 * Suspenders. `staff_confirm_order` and `staff_cancel_order` both raise
 * STAFF_ONLY on `private.is_staff()` of their own accord, which is the belt — but
 * a Server Action is its own POST endpoint, reachable by anyone who knows the
 * action id without ever rendering the page, and a caller who gets that far
 * should be stopped here rather than one round trip later. Fails CLOSED, like
 * the staff-products gate it is copied from.
 */
async function assertStaff() {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHENTICATED");

  const supabase = await createServerSupabase();
  const { data: staffUser, error } = await supabase
    .from("staff_users")
    .select("id, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) console.error("assertStaff:", error);
  if (!staffUser?.is_active) throw new Error("NOT_STAFF");
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
 * The shared body of both transitions.
 *
 * `false` is NOT success. Both RPCs update `where status = 'submitted'` and
 * return whether that matched, so a false means someone else confirmed or
 * cancelled this order first — the queue says so instead of redrawing as if the
 * click had worked (the plan's RPC contract: alertable, never assume).
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
