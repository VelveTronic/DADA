"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { updateOrderLineQty } from "@/app/actions/staff-orders";
import { BTN_QUIET, FIELD_SM } from "@/components/ui";
import { MAX_LINE_QTY } from "@/lib/orders";

/** The quiet row control with its disabled state, as `/staff/usuarios` styles it. */
const ROW_BTN = `${BTN_QUIET} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:text-ink`;

/**
 * The save control, split out for the ONE thing it needs that its parent cannot
 * give it: `useFormStatus`, which only reads the form it is rendered inside.
 *
 * Disabled while the action is in flight, so the second click of an impatient
 * double-press cannot post the same weight twice — harmless to the order (the RPC
 * assigns a quantity, it does not add one) but it would leave a second audit row
 * saying the quantity changed from 5.2 to 5.2.
 */
function SaveButton({
  label,
  title,
  dirty,
}: {
  label: string;
  title: string;
  dirty: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={!dirty || pending}
      aria-label={title}
      className={ROW_BTN}
    >
      {label}
    </button>
  );
}

/**
 * One pending line's quantity, editable in place — the warehouse's real weight
 * (柠檬 ordered as 1, weighed at 5.2 kg) or the real count when only 2 of 3 cajas
 * are on the shelf.
 *
 * A client component for exactly two affordances, both of them about NOT posting:
 * the button stays dead until the number actually differs from the one in the
 * database, and dead again while the post is in flight. Everything else is a
 * plain `<form action={…}>` posting FormData to a Server Action, which is how the
 * confirm and cancel controls on this same card already work — the page around it
 * stays a Server Component and no quantity is computed in the browser.
 *
 * **The value survives a rejected save.** `qty` is this component's own state and
 * a failed edit does not unmount it, so a staff member who typed 5.2 on a line
 * nobody has flagged as weighed sees 5.2 still sitting there under the
 * BAD_QTY_STEP banner — the number to fix, not a field silently reset to 1. A
 * SUCCESSFUL save re-renders the card from the database with the new `qty`, at
 * which point the typed value and the stored one agree and the button goes quiet
 * again on its own.
 *
 * `dirty` compares NUMBERS, not strings: typing `5.20` over a stored `5.2` is not
 * a change, and offering to save it would be offering to write an audit row that
 * says nothing happened.
 */
export function LineQtyForm({
  orderId,
  itemId,
  qty: stored,
  isWeighed,
  locale,
  tab,
  labels,
}: {
  orderId: string;
  /** `order_items.id` — a bigint identity, so a plain integer on the wire. */
  itemId: number;
  qty: number;
  /**
   * The product's LIVE weighed flag, as the queue read it — the same value
   * `staff_update_order_line` re-reads for itself. It decides the step and the KG
   * suffix here; it decides nothing in the RPC, which never sees this form.
   */
  isWeighed: boolean;
  locale: string;
  /** So the redirect lands back on the tab the staff member was looking at. */
  tab: string;
  /** Already localized by the server page — this leaf does no translation. */
  labels: { save: string; saveFor: string; qtyFor: string; kg: string };
}) {
  const [qty, setQty] = useState(String(stored));

  const typed = qty.trim() === "" ? Number.NaN : Number(qty);
  const dirty = Number.isFinite(typed) && typed !== stored;

  return (
    <form action={updateOrderLineQty} className="flex items-center gap-1">
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="estado" value={tab} />
      <input
        name="qty"
        type="number"
        // Weighed goods are sold to the gram; everything else is whole cajas.
        // The RPC enforces both (BAD_QTY / BAD_QTY_STEP) — this only spares the
        // staff member the round trip and gives the spinner a sane increment.
        step={isWeighed ? 0.001 : 1}
        min={isWeighed ? 0.001 : 1}
        max={MAX_LINE_QTY}
        required
        value={qty}
        onChange={(event) => setQty(event.target.value)}
        aria-label={labels.qtyFor}
        // Wide enough for `9999.999` without the spinner clipping the digits.
        className={`w-24 ${FIELD_SM} tabular-nums`}
      />
      {/* The unit a weighed quantity is IN, said once, next to the box it is
          typed into. Non-weighed lines keep the row's own `unitLabel` instead —
          `CAJA×24` means something a bare "KG" would overwrite. */}
      {isWeighed && <span className="text-xs text-muted">{labels.kg}</span>}
      <SaveButton label={labels.save} title={labels.saveFor} dirty={dirty} />
    </form>
  );
}
