import { getTranslations } from "next-intl/server";
import { isOrderStatus, type OrderStatus } from "@/lib/orders";

/**
 * One state, one colour, on both order pages — a customer scanning their history
 * and a staff member working the queue read the same badge.
 */
const STATUS_CLASS: Record<OrderStatus, string> = {
  submitted: "bg-amber-100 text-amber-800",
  confirmed: "bg-green-100 text-green-800",
  processing: "bg-blue-100 text-blue-800",
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
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
        known ? STATUS_CLASS[status] : "bg-gray-200 text-gray-600"
      }`}
    >
      {known ? t(`status.${status}`) : status}
    </span>
  );
}
