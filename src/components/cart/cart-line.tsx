"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { BTN_QUIET, FIELD_SM } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The cart page's per-line client leaves: the row itself, the weighed line's
 * typed box and the `×`, all on the provider so the page and the catalogue stay
 * one cart without a navigation between them.
 *
 * **Who gets which control changed with design 02, and only for one kind of
 * line.** A whole-unit line now carries the catalogue's own `− n +`
 * (`QtyStepper`, in its editable mode — the centre figure is a box you can type
 * into on THIS page, so 24 cajas is still one entry rather than 24 taps). The
 * typed form below survives for WEIGHED goods, which is the case a stepper
 * cannot express at all: 2.75 kg is not two presses of `+` away from anything,
 * and its box needs the decimal keypad and a fractional step the stepper's
 * whole-unit centre deliberately refuses. Both write the same `setQty`
 * (absolute, 0 removes), and the `×` is still beside them — for a weighed line
 * it is the only way out, since `min` never reaches 0.
 */

/**
 * The row itself, which vanishes the moment its quantity reaches 0.
 *
 * Without this the `×` would leave a line on screen until the server render
 * caught up — the one place where the cookie being authoritative would have
 * LOOKED like the press did nothing. `children` is the row's server-rendered
 * markup, handed through untouched.
 */
export function CartLine({
  productId,
  className,
  children,
}: {
  productId: string;
  className: string;
  children: ReactNode;
}) {
  const { qtyOf } = useCart();
  if (qtyOf(productId) <= 0) return null;
  return <li className={className}>{children}</li>;
}

/**
 * The quantity box, now the WEIGHED line's control and nothing else's. Commits
 * on Enter or on "Actualizar", exactly as the form it replaces did — NOT on
 * every keystroke, which would spend a round trip per digit of a three-digit
 * order.
 *
 * The draft is dropped once a valid quantity is sent, so the field follows the
 * cart again (including a change made from the catalogue). An invalid one is
 * KEPT on screen with the banner beside it: blanking the box is an error and
 * never a silent delete — removing a line is the `×`'s job — and a customer who
 * mistyped should see what they typed. (The stepper's editable centre reverts
 * instead of keeping the draft, and the difference is the box: 28px cannot show
 * a customer what they mistyped, so there is nothing to keep.)
 *
 * Weighed-only is now STRUCTURAL rather than a sentence in this comment. The
 * kilo constants below were a `weighed ? … : …` ternary carried over from the
 * form this replaced, when one component served both kinds of line; the
 * whole-unit branch has been the stepper's since design 02, so the ternaries
 * were three conditions that could only ever answer one way — and a dead branch
 * in a control that writes quantities is exactly the kind of thing that comes
 * back to life by accident.
 */
export function CartQtyInput({
  productId,
  name,
}: {
  productId: string;
  /** Already localized; empty when the product carries no name in either language. */
  name: string;
}) {
  const { qtyOf, setQty } = useCart();
  const t = useTranslations("cart");
  const [draft, setDraft] = useState<string | null>(null);
  const qty = qtyOf(productId);

  function commit() {
    const text = (draft ?? String(qty)).trim();
    const next = text === "" ? Number.NaN : Number(text);
    setQty(productId, next);
    if (Number.isFinite(next) && next >= 0) setDraft(null);
  }

  return (
    // STACKED on a phone, inline from `sm` up, and the stack is what keeps the
    // product name legible on a weighed row. The row's name and its action
    // column divide 254px between them on a 390px phone (390 − 32 page − 32 card
    // − 48 thumb track − 24 of column gaps — see the grid note in
    // `carrito/page.tsx`), and every pixel this form takes comes out of the name
    // two tracks to its left:
    //
    // ```text
    //   stacked (this)      96 box                 + 4 + 36 × = 136 → name 118px
    //   side by side, zh    96 + 4 + 42 更新  = 142 + 4 + 36 × = 182 → name  72px
    //   side by side, es    96 + 4 + 80 Actualizar = 180 + 4 + 36 = 220 → name 34px
    // ```
    //
    // 34px is three characters and an ellipsis, on the one thing a restaurant
    // identifies goods BY. Stacked, the control is exactly as wide as the box
    // (96px = the stepper's own track), so a weighed row gives its name the same
    // 118px an ordinary one does whatever language it is read in. It costs no
    // height either: the stack is ~60px against a row that is already ~104px
    // tall (a two-line name, the meta line and the amount). Above `sm` the row
    // has width to spare and the pair goes back on one line.
    //
    // 118px is the figure for every row that CAN be ordered, and only those. A
    // paused or vanished line gets no quantity control at all, so its action
    // column is the 36px `×` alone and its name column is the 218px the third
    // track gives back — the cart's `auto` track is not the catalogue ROW's
    // fixed 6rem, deliberately. The catalogue fixes its track because the
    // stepper GROWS there on a press (a lone `+` becomes `− n +`) and every name
    // on the page would re-wrap under the customer's finger; nothing on this
    // page grows on a press, and a row whose only control is the way out has no
    // reason to hold the pixels open.
    <form
      className="flex flex-col items-end gap-1 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        type="number"
        value={draft ?? String(qty)}
        onChange={(event) => setDraft(event.target.value)}
        // Weighed goods are sold by fractional kilo — three decimals, the
        // cookie's own precision. Removing a line is the × button's job, so the
        // minimum never reaches 0.
        step={0.001}
        min={0.001}
        inputMode="decimal"
        // One "Cantidad" per row would be useless to a screen reader, so the
        // name goes in the label — unless the product carries none in either
        // language.
        aria-label={name ? t("qtyFor", { name }) : t("qty")}
        // 6rem — the same 96px the stepper occupies on every other row, which is
        // what the stack above is for.
        className={`w-24 ${FIELD_SM} text-right`}
      />
      <button type="submit" className={BTN_QUIET}>
        {t("update")}
      </button>
    </form>
  );
}

/**
 * The `×`. Absolute quantity 0 is what removes a line, here as everywhere.
 *
 * A 36px box rather than the loose `px-2` it was: it now sits at the end of the
 * row's action column, a `gap-x-3` away from a `−` square (or from a weighed
 * line's 更新), and two adjacent controls with nothing in common need a target
 * that is a target rather than a glyph with padding round it. Same size and the
 * same reasoning as the catalogue row's favourite star — short of 44px because
 * the pixels would come straight off the product name, comfortably past WCAG
 * 2.2 AA's 24px minimum — and it costs the row no height either: the 44px
 * thumbnail beside it is taller.
 */
export function CartRemoveButton({
  productId,
  name,
}: {
  productId: string;
  name: string;
}) {
  const { setQty } = useCart();
  const t = useTranslations("cart");

  return (
    <button
      type="button"
      aria-label={name ? t("removeFor", { name }) : t("remove")}
      onClick={() => setQty(productId, 0)}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-lg leading-none text-muted transition-colors hover:bg-brand-soft hover:text-brand-ink"
    >
      ×
    </button>
  );
}
