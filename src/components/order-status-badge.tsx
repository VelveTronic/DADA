import { getTranslations } from "next-intl/server";
import { isOrderStatus, type OrderStatus } from "@/lib/orders";

/**
 * One state, one colour, on both order pages — a customer scanning their history
 * and a staff member working the queue read the same badge.
 *
 * Seven states, deliberately distinct, and the four the customer meets most are
 * now drawn from the warm-beige design's own palette rather than Tailwind's
 * default ramps: the brand's soft red opens the story (`submitted` — the order
 * is with us), amber holds it while the shop prices it (`confirmed`), a cool
 * slate marks its arrival in Wingest (`injected`) and a muted green closes it
 * (`albaran`). `processing` (the bridge has claimed the order) keeps violet, and
 * it keeps it for the reason it was given violet in the first place: it and
 * `injected` used to share blue, which made the one transition a staff member is
 * actually waiting on invisible. `bridge_failed` keeps Tailwind's red-100/800,
 * the loudest pair here, because it is the one lifecycle state that explicitly
 * requires staff intervention — `submitted`'s brand tint is deliberately the
 * quieter red of the two.
 */
const STATUS_CLASS: Record<OrderStatus, string> = {
  submitted: "bg-brand-soft text-brand-ink",
  // The mockup's own amber ink is `#B26A00`, and at chip size — 12px, semibold,
  // which is NORMAL text to WCAG, not large — it lands at 3.90:1 on this
  // background and misses AA's 4.5:1. `#9A5C00` is the nearest darkening that
  // clears it (4.95:1) on the mockup's unchanged `#FFF4E6`.
  confirmed: "bg-[#FFF4E6] text-[#9A5C00]",
  processing: "bg-violet-100 text-violet-800",
  bridge_failed: "bg-red-100 text-red-800",
  injected: "bg-[#EEF2F7] text-[#3E5A78]",
  albaran: "bg-[#F0F4F0] text-[#4A6A4E]",
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
    // `shrink-0` is not decoration: both order pages put this chip in a
    // `flex-wrap` row beside a name that truncates, and without it the chip is
    // what gives way — the state ends up clipped to a couple of characters.
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-semibold ${
        known ? STATUS_CLASS[status] : "bg-gray-200 text-gray-600"
      }`}
    >
      {known ? t(`status.${status}`) : status}
    </span>
  );
}
