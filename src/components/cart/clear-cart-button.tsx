"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
 * **Every way out of the armed state costs nothing.** A 4-second timer disarms
 * it, so does losing focus, and so does the cart's line count changing under it:
 * a customer who armed it by accident and then scrolled, or tapped a quantity,
 * or removed a row, or simply stopped, is back to a button that does nothing on
 * its next press. The timer is what covers a thumb that never moves focus
 * anywhere — on a phone, tapping the page background does not blur a button — so
 * none of the three is redundant.
 *
 * There is no undo behind this: the cookie is the cart, and once it is empty the
 * lines are gone. That is exactly why the second press has to be a decision
 * rather than a repeat of the first.
 *
 * It renders NOTHING on an empty cart, from the provider rather than from the
 * server's row count, so it disappears on the same frame as the last line the
 * customer removed — and, since `clearAll` empties that same optimistic cart on
 * the frame of the press, it takes itself off screen with the list it just threw
 * away rather than a round trip later.
 *
 * **The write is the provider's, not this button's.** It used to call the
 * `clearCart` action itself inside a bare transition, with nothing around the
 * await: a clear that never reached the server threw INSIDE that transition, and
 * with no `error.tsx` anywhere in this portal the whole screen would be replaced
 * by Next's crash page — a dropped request costing the customer the list they
 * were looking at. `clearAll` is the same write with the provider's optimistic
 * layer and its catch around it, so a failure now costs a banner and the lines
 * come back (see `cart-provider.tsx`).
 */

/** Long enough to read 确认清空？and decide; short enough to be gone by the next screen. */
const DISARM_MS = 4000;

export function ClearCartButton() {
  const { count, clearAll } = useCart();
  const t = useTranslations("cart");
  // THE ARMING, AND THE CART IT BELONGS TO — a line count, `"spent"` once the
  // confirming press has been made, or null. `armed` is DERIVED from it rather
  // than stored, and that is what makes the state below impossible to leave
  // stale:
  //
  //  - a list that LOST or GAINED a line under an armed button is not the list
  //    the customer armed it over, so the count stops matching and the arming
  //    lapses for free. In practice the blur below usually gets there first —
  //    pressing a `×` or a `−` moves focus off this control — and this is what
  //    holds where nothing was pressed at all;
  //  - the confirming press spends the arming outright. Returning null further
  //    down does NOT unmount this component — React keeps the instance at that
  //    position in the tree, hooks and all — so a plain `armed` boolean would
  //    survive the frames where the cart is empty and come BACK armed if the
  //    write failed, one press away from throwing the list away again, right
  //    beside the error that says it did not work. `"spent"` matches no count
  //    there is, so the button that returns is disarmed and the customer has to
  //    mean it a second time.
  //
  // Nothing here flips the visible word back on the confirming press, which is
  // the other half of the same problem: 确认清空？ is what the customer must go
  // on seeing until this control leaves the screen (see the click handler).
  const [arming, setArming] = useState<number | "spent" | null>(null);
  const armed = arming === count;

  // Restarted by the `armed` dependency and cleared on the way out, so the
  // countdown belongs to the arming that started it: disarming (or clearing)
  // cancels the timer rather than leaving it to fire onto a later state.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArming(null), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // AFTER the hooks, never before: React counts hook calls per render, and an
  // early return above them would change that count the moment the cart empties.
  if (count === 0) return null;

  const label = armed ? t("clearConfirm") : t("clear");

  return (
    <button
      type="button"
      // `aria-label` in both states even though the visible word says the same
      // thing: it is the accessible NAME that has to change on arming, and
      // stating it explicitly is what keeps the button from ever being announced
      // with the label of the state it just left.
      aria-label={label}
      // …and a name that changes under a screen reader's cursor is not announced
      // by changing. Arming is the whole of the confirmation step — there is no
      // dialog to move focus into — so the word that appears has to say itself,
      // politely, after whatever the reader was already reading.
      aria-live="polite"
      onBlur={() => setArming(null)}
      onClick={() => {
        if (!armed) {
          setArming(count);
          return;
        }
        // The arming is SPENT, not cancelled, and nothing the customer can see
        // changes on this line — which is the one thing this handler used to get
        // wrong. Flipping the word back to 清空 on the confirming press reads as
        // "nothing happened" for as long as the write is in flight, and on a bad
        // connection that is exactly the moment somebody presses it again.
        // 确认清空？stays until the control leaves the screen, which is this
        // press: `clearAll` empties the cart optimistically, `count` reaches 0
        // on the same frame and the return above takes the button with the list.
        // A write that then fails brings both back, disarmed (see the note on
        // `arming`), under the provider's banner.
        setArming("spent");
        clearAll();
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
