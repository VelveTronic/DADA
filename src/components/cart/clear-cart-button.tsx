"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { clearCart } from "@/app/actions/cart";
import { useCart } from "./cart-provider";

/**
 * 清空 — the cart page's one destructive control, in the corner of its title
 * row, and the only place in the portal where a press throws away work.
 *
 * **Two presses, no dialog.** The first press ARMS it: the word becomes 确认清空？
 * in the accent ink, and only the second press writes the empty cookie. A
 * `confirm()` would be the other way of asking, and it is the wrong one here —
 * it blocks the whole page behind a browser chrome dialog in the wrong language,
 * on a phone, over a list the customer is trying to look at while they decide.
 * Arming in place asks the same question with the answer still visible behind
 * it.
 *
 * **Both ways out of the armed state cost nothing.** A 4-second timer disarms
 * it, and so does losing focus: a customer who armed it by accident and then
 * scrolled, or tapped a quantity, or simply stopped, is back to a button that
 * does nothing on its next press. The timer is what covers a thumb that never
 * moves focus anywhere — on a phone, tapping the page background does not blur a
 * button — so neither mechanism is redundant.
 *
 * There is no undo behind this: the cookie is the cart, and once it is empty the
 * lines are gone. That is exactly why the second press has to be a decision
 * rather than a repeat of the first.
 *
 * It renders NOTHING on an empty cart, from the provider rather than from the
 * server's row count, so it disappears on the same frame as the last line the
 * customer removed — and it takes itself off screen the instant the clear it
 * performed lands.
 */

/** Long enough to read 确认清空？and decide; short enough to be gone by the next screen. */
const DISARM_MS = 4000;

export function ClearCartButton({ locale }: { locale: string }) {
  const { count } = useCart();
  const t = useTranslations("cart");
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  // Restarted by the `armed` dependency and cleared on the way out, so the
  // countdown belongs to the arming that started it: disarming (or clearing)
  // cancels the timer rather than leaving it to fire onto a later state.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // AFTER the hooks, never before: React counts hook calls per render, and an
  // early return above them would change that count the moment the cart empties.
  if (count === 0) return null;

  const label = armed ? t("clearConfirm") : t("clear");

  return (
    <button
      type="button"
      disabled={pending}
      // `aria-label` in both states even though the visible word says the same
      // thing: it is the accessible NAME that has to change on arming, and
      // stating it explicitly is what keeps the button from ever being announced
      // with the label of the state it just left.
      aria-label={label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        // Disarm first: the write below empties the cart, `count` reaches 0 and
        // this button unmounts — but a refused or dropped request would leave it
        // on screen, and it must not still be armed when it lands there.
        setArmed(false);
        startTransition(async () => {
          await clearCart(locale);
        });
      }}
      // `ml-auto` lives on the control rather than on a wrapper in the page: this
      // renders nothing at all on an empty cart, and an empty `ml-auto` div left
      // behind in the title row would be a spacer nobody can see.
      //
      // 44px of height and at least 44px of width (WCAG 2.5.5), most of it to the
      // LEFT of the word — `justify-end` plus the padding — so the target grows
      // towards the title rather than off the screen edge, and `-mr-2` pulls the
      // box's own right padding back out to the page gutter so the word still
      // sits where the design draws it.
      className={`ml-auto -mr-2 flex h-11 min-w-11 shrink-0 items-center justify-end pr-2 pl-3 text-[12.5px] transition-colors ${
        armed ? "font-semibold text-brand-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
