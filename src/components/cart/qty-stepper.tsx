"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
  STEPPER_DEC,
  STEPPER_INC,
  STEPPER_QTY,
  STEPPER_QTY_INPUT,
  STEPPER_WRAP,
} from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The catalogue row's add control: a red `+` square, which GROWS a `−` square
 * and a figure to its left once the product is in the cart — TOKACHI's
 * `quick-add-button.tsx`, adapted to a cookie cart. The wrapper is the same
 * element in both states; only its contents change (see the note on the
 * return).
 *
 * It replaces a `<form action={addToCart}>` per row. Everything the form used
 * to say still gets said: the same aria labels (`cart.add` when the row can be
 * ordered, a refusal when it cannot), the same `title` naming the price as the
 * blocker, the same disabled `+`. What changes is that the press no longer costs
 * the customer the page they were on.
 *
 * **The refusal has to stop mentioning prices when prices are off.** The row's
 * whole price cell is gone in that mode — 价格待定 included, because it is the
 * price column's placeholder — and this button is the last thing on the row that
 * could put the word back, in a `title` tooltip and in the sentence a screen
 * reader announces. `cart.addUnavailable` says the same thing without it: this
 * one cannot go in the basket. The BLOCKER is unchanged either way; only the
 * wording is, and the customer sees no amount they were not meant to.
 *
 * **`−` at 1 removes the line**, shrinking the control back to its lone `+`.
 * That is the cart's own contract (`setQty` at 0 deletes) and TOKACHI's, so the
 * stepper has no dead bottom rung and the row needs no second control to undo an
 * accidental add.
 *
 * The `+` stays disabled on an unpriced product even once a quantity exists —
 * a price can disappear after an add — but `−` never is: whatever put the line
 * there, the customer must be able to take it out.
 *
 * ## `editable`: the same control, on the cart page
 *
 * One prop, because both things it changes are the same fact — this stepper is
 * on `/carrito`, the page that IS the 购物车:
 *
 *  1. **the centre figure becomes a box you can type into.** A restaurant
 *     ordering 24 cajas of a whole-unit product had, after design 02 moved the
 *     cart's rows onto this control, no surface anywhere in the portal to TYPE
 *     that: 24 taps on `+`, or 24 round trips. The cart page is where a line is
 *     read and revised — the catalogue is where it is picked — so the box lives
 *     here and the catalogue keeps its static, `aria-live` span.
 *  2. **the `+` stops saying 加入购物车.** On the cart page itself the product
 *     is already in it; what the button does there is increase the quantity, and
 *     `cart.increaseFor` is the mirror of the `−`'s own label. The two REFUSALS
 *     are left as they are: an unpriced line's button is disabled, and what its
 *     label has to carry is why (价格待定), not which list the product is on.
 *
 * The drawing does not change: the box wears the span's own type metrics
 * (`STEPPER_QTY_INPUT`, which documents the three things an input needs on top),
 * so `− n +` is the same 96px control on both screens, in the same 32px squares,
 * around a centre that never leaves the 24–28px the slot is sized for.
 *
 * **Draft-commit, exactly as the weighed line's box does it** (`cart-line.tsx`):
 * typing writes nothing, Enter or blur commits, and a commit of 0 removes the
 * line like every other 0 in this cart. What is NOT copied is what happens to a
 * bad entry: that box keeps the draft on screen beside the banner, and this one
 * reverts to the live quantity, because 28px cannot show a customer what they
 * mistyped. Whole units only — a fractional entry is refused the same way,
 * since `create_order` would refuse it later (BAD_QTY_STEP) and a weighed
 * product never reaches this branch at all.
 */
export function QtyStepper({
  productId,
  name,
  priced,
  showPrices,
  editable = false,
}: {
  productId: string;
  /** Already localized by the server row; it names the buttons for a screen reader. */
  name: string;
  /** False while this product still has no tarifa price. Blocks the `+`, as today. */
  priced: boolean;
  /**
   * The owner's `show_prices` setting, as the page read it. It changes only what
   * the disabled `+` SAYS — never whether it is disabled — so a row this build
   * cannot price stays unorderable in both modes.
   */
  showPrices: boolean;
  /**
   * The cart page's mode: a typed centre and an increase label. Constant per
   * call site — the catalogue never passes it, this page always does — which is
   * what keeps the keyed nodes below honest (see the note on the return).
   */
  editable?: boolean;
}) {
  const { qtyOf, setQty } = useCart();
  const t = useTranslations("cart");
  const tCatalog = useTranslations("catalog");
  const plusRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Null while the box is following the cart, which is all the time except
  // between a keystroke and the commit that ends the edit.
  const [draft, setDraft] = useState<string | null>(null);

  const qty = qtyOf(productId);

  /**
   * What `−` and `+` step FROM: the figure on screen, which is the cart's own
   * except in one case — an edit the customer typed and has not committed. In
   * editable mode the press that steps is also the press that blurs the box, and
   * the two land in an order that is the browser's to decide; reading the box
   * itself is what makes the outcome the same either way, and it is the rule a
   * customer would state anyway ("+ adds one to the number I can see"). Anything
   * the box cannot mean — empty, a fraction, a minus sign — falls back to the
   * cart, which is exactly what the commit does with it.
   */
  function shownQty(): number {
    const text = inputRef.current?.value.trim();
    if (!text) return qty;
    const shown = Number(text);
    return Number.isInteger(shown) && shown >= 0 ? shown : qty;
  }

  const addLabel = !priced
    ? showPrices
      ? t("addNoPrice", { name })
      : t("addUnavailable", { name })
    : editable
      ? t("increaseFor", { name })
      : t("add", { name });
  // The tooltip is the price cell's own vocabulary, so it goes with the cell:
  // with prices off there is no title at all rather than a price-free one, since
  // the aria-label above already carries the whole reason.
  const addTitle = priced || !showPrices ? undefined : tCatalog("noPrice");

  function commit() {
    const text = (draft ?? "").trim();
    // The draft is dropped whatever happens next, so the box goes back to
    // following the cart — on a refusal that IS the revert, and on a commit it
    // is what lets a change made from the catalogue reach this line.
    setDraft(null);
    // Blur with nothing typed (the customer tapped in and back out), or a box
    // left empty: not an error, nothing to write.
    if (text === "") return;
    const next = Number(text);
    // Whole units, never negative. `Number("")` is 0, which is why the empty
    // case is caught above rather than here — an abandoned edit must not remove
    // the line.
    if (!Number.isInteger(next) || next < 0) return;
    // A retyped identical quantity is not a write. 0 is, and it removes the
    // line, which is the cart's contract everywhere.
    if (next !== qty) setQty(productId, next);
  }

  // ONE wrapper for both states, and the `+` keyed inside it, so the element
  // the customer just pressed is the same DOM node before and after the 0→1
  // transition. Returning a bare <button> from one branch and a <div> from the
  // other unmounted it mid-press: the browser drops focus to <body>, and on a
  // 50-row catalogue that costs a keyboard or screen-reader user their place in
  // the list — they land back at the top and have to walk down again to press
  // `+` a second time.
  //
  // The `qty` key is on the centre in BOTH modes, and the element under it is a
  // <span> or an <input> depending on `editable` — which is a prop of the call
  // site and never changes at runtime, so no render ever swaps one for the
  // other under a customer's cursor. What the key still buys is the 0→1
  // transition, where the centre appears beside a `+` that must not be replaced.
  return (
    <div className={STEPPER_WRAP}>
      {qty > 0 && (
        <button
          key="minus"
          type="button"
          aria-label={t("decreaseFor", { name })}
          onClick={() => {
            const from = shownQty();
            setDraft(null);
            // The shrink direction of the same problem: at 1 this press removes
            // the line and takes THIS button with it, so hand focus to the `+`
            // that survives first — otherwise the browser drops it on <body>
            // and the keyboard user loses the row. Moving focus before the
            // state change is what makes it stick: the `+` is keyed, so it is
            // the same node on the other side of the render. (On the cart page
            // the whole ROW leaves at 0, `+` included, so the handoff has
            // nowhere to land — noted, and the same is true of the `×` beside
            // it. The catalogue is where this matters and where it works.)
            if (from <= 1) plusRef.current?.focus();
            setQty(productId, Math.max(0, from - 1));
          }}
          className={STEPPER_DEC}
        >
          −
        </button>
      )}
      {qty > 0 &&
        (editable ? (
          <input
            key="qty"
            type="number"
            // Whole units, and 0 is a legal entry because 0 is how this cart
            // removes a line. The commit above enforces both again: `min` and
            // `step` are a keypad and a hint, not a validator.
            step={1}
            min={0}
            inputMode="numeric"
            ref={inputRef}
            value={draft ?? String(qty)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // This stepper sits inside the cart page's row, which is not a
              // form — but the catalogue's rows are not either and the weighed
              // box's Enter submits one, so the intent is stated rather than
              // inherited.
              event.preventDefault();
              commit();
            }}
            onBlur={commit}
            // One "数量" per row would be useless to a screen reader, so the
            // name goes in the label — the same key the weighed line's box uses,
            // for the same reason.
            aria-label={name ? t("qtyFor", { name }) : t("qty")}
            className={STEPPER_QTY_INPUT}
          />
        ) : (
          // Announced on change, so a screen reader hears the new quantity
          // without the button labels having to carry it. The editable centre
          // above is NOT a live region: a box announcing itself on every
          // keystroke would talk over the person typing into it, and its value
          // is read out by the cursor that is already in it.
          <span key="qty" aria-live="polite" className={STEPPER_QTY}>
            {qty}
          </span>
        ))}
      <button
        key="plus"
        ref={plusRef}
        type="button"
        disabled={!priced}
        aria-label={addLabel}
        title={addTitle}
        onClick={() => {
          const from = shownQty();
          setDraft(null);
          setQty(productId, from > 0 ? from + 1 : 1);
        }}
        className={STEPPER_INC}
      >
        +
      </button>
    </div>
  );
}
