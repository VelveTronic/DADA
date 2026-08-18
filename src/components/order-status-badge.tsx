import { getTranslations } from "next-intl/server";
import { isOrderStatus, type OrderStatus } from "@/lib/orders";

/**
 * One state, one colour, on both order pages — a customer scanning their history
 * and a staff member working the queue read the same badge.
 *
 * Seven states, deliberately distinct: `processing` (the bridge has claimed the
 * order) and `injected` (it is in Wingest) used to share blue, which made the
 * one transition a staff member is actually waiting on invisible. Violet now
 * carries the claim, blue the arrival. `bridge_failed` alone is red because it
 * is the one lifecycle state that explicitly requires staff intervention.
 */
const STATUS_CLASS: Record<OrderStatus, string> = {
  submitted: "bg-amber-100 text-amber-800",
  confirmed: "bg-green-100 text-green-800",
  processing: "bg-violet-100 text-violet-800",
  bridge_failed: "bg-red-100 text-red-800",
  injected: "bg-blue-100 text-blue-800",
  albaran: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-gray-200 text-gray-600",
};

/**
 * `orders.status` is `text`, so what arrives here is a plain string and is
 * guarded before it indexes either map. A state this build has never heard of
 * renders as the bare word from the database rather than throwing the page away
 * or, worse, being given a label someone invented for it.
 */
export async function OrderStatusBadge({ status }: { status: string }) {
  const t = await getTranslations("orders");
  const known = isOrderStatus(status);
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs ${
        known ? STATUS_CLASS[status] : "bg-gray-200 text-gray-600"
      }`}
    >
      {known ? t(`status.${status}`) : status}
    </span>
  );
}
