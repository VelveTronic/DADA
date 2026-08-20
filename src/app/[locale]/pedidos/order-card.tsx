import { getTranslations } from "next-intl/server";
import { OrderStatusBadge } from "@/components/order-status-badge";
import { ProductThumb, THUMB_LG_PX } from "@/components/product-thumb";
import { CARD } from "@/components/ui";
import { localizedName, unitLabel } from "@/lib/catalog/display";
import { formatEuros } from "@/lib/money";
import { formatOrderDate, orderUnits } from "@/lib/orders";
import type { Database } from "@/lib/supabase/database.types";
import type { PublicOrder } from "@/lib/supabase/public.types";

/**
 * Exactly the line columns a customer's own card renders, off the order's own
 * SNAPSHOT — the name, unit and amount the order was placed with, which is what
 * a restaurant is looking at when it asks what it ordered last Tuesday. Nothing
 * here is re-read from the catalogue; the only live thing on this card is the
 * photo, and that is looked up separately because the snapshot has never carried
 * one.
 */
export type OrderCardLine = Pick<
  Database["public"]["Tables"]["order_items"]["Row"],
  | "product_id"
  | "codart"
  | "name"
  | "qty"
  | "unit"
  | "units_per_case"
  | "line_total_cents"
>;

/**
 * How many photos the strip shows before it stops. The design draws three.
 *
 * Exported because the page's thumbnail read is bounded by it: a line past the
 * third can never draw a photo on this card (and the detail panel draws none at
 * all), so there is no reason to ask the catalogue about its product.
 */
export const THUMB_LIMIT = 3;

/**
 * ONE order in a restaurant's history: what it was, what state it is in, and the
 * two things that can be done with it — open the lines, or order the same again.
 *
 * A component rather than markup inside the page because the page is about the
 * three reads that feed this card, and because a card this dense is worth being
 * able to render on its own against fixtures.
 *
 * **The panel is a real `<details>`.** No client JavaScript is involved: the
 * summary IS the 查看详情 button, the browser toggles it on click and on
 * Enter/Space, and the lines are in the document either way (a screen reader and
 * a printer both find them). The reorder form is its SIBLING and not inside it —
 * anything but the summary is hidden while the panel is closed, and a 再来一单
 * button that appeared only after pressing 查看详情 would be a button nobody
 * finds. That sibling is also what sets the panel's width: it takes its own
 * ~90px off the row, and the disclosure gets the rest.
 */
export async function OrderCard({
  locale,
  order,
  lines,
  images,
  showPrices,
  reorder,
}: {
  locale: string;
  order: PublicOrder;
  /** This order's lines, in `sort_order` — already grouped by the page. */
  lines: OrderCardLine[];
  /** `product_id` → photo, for the products on this card that still have one. */
  images: Map<string, string | null>;
  /** The owner's `show_prices` switch, as the page read it. */
  showPrices: boolean;
  /**
   * The 再来一单 server action. A prop so this card can be rendered against an
   * inert stub; the page passes `reorderIntoCart`, and it is the ONLY thing on
   * this screen that writes anything.
   */
  reorder: (formData: FormData) => Promise<void>;
}) {
  const t = await getTranslations("orders");
  // The money and date vocabulary is the cart's, reused rather than duplicated
  // into a second namespace.
  const tCart = await getTranslations("cart");

  // The per-LINE quantity in the panel, mapped exactly as `formatEuros` and
  // `formatOrderDate` map theirs, so the amount and the money on one line cannot
  // disagree about whether two and a half kilos is written 2.5 or 2,5. Built
  // once per card rather than per line. The 合计 N 件 figure in the header does
  // NOT come through here: next-intl formats it inside the ICU message from the
  // bare `zh`/`es` locale, so that one agrees with these by CLDR rather than by
  // construction.
  const qtyFormat = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "es-ES");

  // An order always HAS lines, so an empty list is the page's line read having
  // failed. Everything on this card that would otherwise ASSERT something about
  // them hangs off this one flag — the 共 N 种 figure and the disclosure — because
  // 共 0 种 · 合计 0 件 is not a degraded card, it is a false statement about a
  // real order. The photo strip needs no flag: `slice(0, THUMB_LIMIT)` of an
  // empty list already draws no boxes, so the row loses the strip on its own.
  const hasLines = lines.length > 0;

  return (
    <li className={`${CARD} flex flex-col gap-3 p-3.5`}>
      <div className="flex items-center justify-between gap-2">
        {/* The REAL `order_number` — the sequence Wingest and the delivery note
            both know this order by — not the mockup's invented `DD-20260818-014`.
            Archivo, because it is a numeral. The mark is written `N.º` — the
            RAE's abbreviation of «número», the same form `profile.customerNo`
            and the staff table heads print — and reads as a document number
            anywhere; the sr-only line beside it is the translated sentence, so
            a screen reader announces 订单 1005 / Pedido 1005 rather than
            spelling a symbol. */}
        <span className="font-num text-xs text-muted">
          <span className="sr-only">
            {t("orderNumber", { n: order.order_number })}
          </span>
          <span aria-hidden>N.º {order.order_number}</span>
        </span>
        <OrderStatusBadge status={order.status} />
      </div>

      <div className="flex items-center gap-2">
        {/* Up to three photos — what a restaurant actually recognises a past
            order by, at 50px because there is no product name beside them to
            help. A line whose product has no file (or none any more) keeps its
            slot as an empty box, so the strip stays a strip. */}
        {lines.slice(0, THUMB_LIMIT).map((line, index) => (
          <ProductThumb
            // The codart is the line's own stable handle; the index keeps the
            // key unique if an order ever carries the same article twice.
            key={`${line.codart}-${index}`}
            src={line.product_id ? images.get(line.product_id) : null}
            size={THUMB_LG_PX}
          />
        ))}

        <div className="flex min-w-0 flex-1 flex-col gap-1 pl-1">
          {hasLines && (
            <p className="text-[13px] font-semibold">
              {t("kindsUnits", {
                lines: lines.length,
                units: orderUnits(lines.map((line) => line.qty)),
              })}
            </p>
          )}
          {/* `text-muted` and not the design's lighter grey: `--color-faint` is
              documented as never being for anything a customer has to READ, and
              the ERP document numbers on this line are precisely what a
              restaurant quotes on the phone. Same AA-over-mockup call the status
              chips and the account card already made. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>
              {t("placedAt")}: {formatOrderDate(order.created_at, locale)}
            </span>
            {order.delivery_date && (
              <span>
                {tCart("deliveryDate")}:{" "}
                {formatOrderDate(order.delivery_date, locale)}
              </span>
            )}
            {/* The ERP document numbers appear only once the bridge has written
                them back, which is exactly when they start being the number a
                restaurant quotes on the phone. */}
            {order.numped != null && (
              <span>{t("erpOrder", { n: order.numped })}</span>
            )}
            {order.numalb != null && (
              <span>{t("erpAlbaran", { n: order.numalb })}</span>
            )}
          </div>
        </div>
      </div>

      {order.customer_note && (
        <p className="rounded-lg bg-surface-dim p-2.5 text-xs leading-relaxed text-muted">
          {t("note", { text: order.customer_note })}
        </p>
      )}

      <div className="flex items-start gap-2">
        {/* No lines, no disclosure. An order always HAS lines, so this is the
            read that failed — and a 查看详情 that opens on nothing is worse than
            a card that does not offer it. 再来一单 stays: it re-reads the lines
            server-side and would answer honestly either way. */}
        {hasLines && (
          <details className="group min-w-0 flex-1">
            {/* The summary IS the outlined 查看详情 button. `flex` also removes
                the disclosure triangle in every engine that draws one as a
                `list-item` marker; the WebKit pseudo-element is the one that
                needs saying out loud. The chevron is decoration — the
                disclosure's own state is announced by the element.

                The accessible name carries the order, for the same reason
                再来一单's does: a screen reader's list of controls is fifty
                identical 查看详情 in a row otherwise, and this one is the
                summary — the thing a reader lands on to decide whether to open
                it. The visible label stays the short one. */}
            <summary
              aria-label={t("detailFor", { number: order.order_number })}
              className="flex h-9 w-fit cursor-pointer list-none items-center rounded-lg border border-border-strong px-3.5 text-xs font-semibold text-ink-soft transition-colors hover:text-ink [&::-webkit-details-marker]:hidden"
            >
              {t("detail")}
              <span
                aria-hidden
                className="ml-1 transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </summary>

            <div className="mt-2 divide-y divide-border text-xs">
              {lines.map((line, index) => (
                <div
                  key={`${line.codart}-${index}`}
                  className="flex justify-between gap-2 py-1.5"
                >
                  {/* The snapshot's own name, in the reader's language. A line
                      placed before a product had a Chinese name falls back to
                      the codart rather than to an empty cell — the number on the
                      delivery note is worth more than nothing. */}
                  <span className="min-w-0 truncate text-ink-soft">
                    {localizedName(line.name, locale) || line.codart}
                  </span>
                  <span className="flex-none font-num text-muted tabular-nums">
                    {qtyFormat.format(line.qty)}{" "}
                    {unitLabel(line.unit, line.units_per_case)}
                  </span>
                  {showPrices && (
                    <span className="flex-none text-right font-num font-semibold tabular-nums">
                      {formatEuros(line.line_total_cents, locale)}
                    </span>
                  )}
                </div>
              ))}

              {/* The order's own total, and the label that names it, stand or
                  fall together. The order still HAS a total — it is stored in
                  cents and the ERP prints it — the customer's screen just does
                  not show it while the owner's switch is off. */}
              {showPrices && (
                <div className="flex justify-between gap-2 py-1.5 font-semibold">
                  <span>{tCart("subtotal")}</span>
                  <span className="font-num tabular-nums">
                    {formatEuros(order.subtotal_cents, locale)}
                  </span>
                </div>
              )}
            </div>
          </details>
        )}

        {/* 再来一单. It writes the CART cookie and nothing else — no order is
            placed by this button (see `reorderIntoCart`) — which is why it is
            the outlined accent rather than the portal's one filled red: the
            filled button on a customer's screen is 提交订单, and there must
            be no press on this page that looks like it. `text-brand-ink` and not
            the mockup's `#E0231C`: the fill red fails AA as WORDING (globals.css
            documents the pair). */}
        <form action={reorder} className="ml-auto flex-none">
          <input type="hidden" name="order_id" value={order.id} />
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            // 再来一单 alone names nothing in a list of four identical buttons,
            // so the accessible name carries the order it repeats.
            aria-label={t("reorderFor", { n: order.order_number })}
            className="flex h-9 items-center rounded-lg border border-brand px-3.5 text-xs font-semibold text-brand-ink transition-colors hover:bg-brand-soft"
          >
            {t("reorder")}
          </button>
        </form>
      </div>
    </li>
  );
}
