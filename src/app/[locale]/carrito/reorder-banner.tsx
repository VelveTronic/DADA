import { getTranslations } from "next-intl/server";

/**
 * What 再来一单 did, said on the page it lands on.
 *
 * `reorderIntoCart` merges a past order into the cart and redirects here with
 * the two counts it ended up with, so this is the whole report: how many
 * products were added, and how many were not. The second half is not an error —
 * `mergeReorderLines` skips a line for three ordinary reasons, and the message
 * names all three because the customer's next move depends on which it was: the
 * product is ALREADY in the cart (their own quantity stood, and this is the
 * common one), the article is no longer orderable, or the 60-line cart is full.
 * It is never silent either: a customer who pressed 再来一单 on an eight-line
 * order and got six lines has to be told, or they submit a short order believing
 * it is last week's.
 *
 * **Green when something arrived, amber when nothing did.** The press either
 * did some of what it said or none of it, and colouring an all-skipped outcome
 * green would be the banner agreeing with itself rather than with the cart. The
 * two families are the ones this portal already uses for exactly that pair (the
 * `?created=` banner on `/pedidos`, the blocked-submit line in the cart's own
 * bar).
 *
 * `role="status"`, not `alert`: the customer is being told the result of
 * something they just did, politely, after whatever the screen reader was
 * already reading. Renders NOTHING when both counts are 0, which is every
 * ordinary visit to this page.
 */
export async function ReorderBanner({
  added,
  skipped,
}: {
  added: number;
  skipped: number;
}) {
  const t = await getTranslations("cart");
  if (added <= 0 && skipped <= 0) return null;

  // Two independent sentences rather than one plural-of-plurals message: either
  // half can be absent, and " · " is the separator this portal already joins
  // half-present pairs with (the account card's identity line). Neither language
  // needs punctuation between them that the other would get wrong.
  const parts: string[] = [];
  if (added > 0) parts.push(t("reorderAdded", { n: added }));
  if (skipped > 0) parts.push(t("reorderSkipped", { n: skipped }));

  return (
    <p
      role="status"
      className={`mt-4 rounded-lg px-3 py-2 text-sm ${
        added > 0 ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"
      }`}
    >
      {parts.join(" · ")}
    </p>
  );
}
