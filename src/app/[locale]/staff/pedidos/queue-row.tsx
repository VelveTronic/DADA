"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

/**
 * ONE order of the queue TABLE: the main `<tr>` and, when opened, the fold
 * `<tr>` under it — a client leaf because the fold needs an open flag, and a
 * FRAGMENT of two rows because that is the only shape a disclosure can take
 * inside a `<tbody>` (a wrapper element between `tbody` and `tr` is invalid
 * HTML and React would hydrate a browser-repaired tree).
 *
 * The owner's third pass (2026-08-20) turned the queue from cards into this
 * table: a real `<thead>` names the columns, the cells align by column instead
 * of by fixed-track guesswork — which is also what retired the previous
 * round's uneven-gap complaint, since a table's columns share their widths by
 * construction — and the 明细 toggle lost its `(7 项)` count, which is what
 * used to wrap it onto two lines inside its track. The count was the
 * withheld-count rule's carrier; the rule survives without it: the fold now
 * holds everything that used to render under the card (lines, note, failure
 * box, the action forms), and `fold == null` — nothing to show — is still the
 * one case that draws no toggle at all.
 *
 * Everything in every cell arrives server-rendered as props; this file owns
 * the open flag and the two glyph buttons, nothing else.
 */
export function QueueRow({
  number,
  date,
  client,
  toggleLabel,
  toggleAria,
  printHref,
  printLabel,
  printAria,
  badge,
  price,
  fold,
}: {
  /** The order number cell, pre-composed (sr-label + visible figure). */
  number: ReactNode;
  date: ReactNode;
  /** Restaurant name with its meta line under it. */
  client: ReactNode;
  toggleLabel: string;
  /** …with the order number in it, for a screen reader. */
  toggleAria: string;
  printHref: string;
  printLabel: string;
  printAria: string;
  badge: ReactNode;
  price: ReactNode;
  /**
   * The fold: lines, customer note, failure box and the action forms — or
   * null when the order has none of those, which draws no toggle.
   */
  fold: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const foldId = useId();

  return (
    <>
      <tr className="border-t border-[#F4F0EC] align-middle transition-colors hover:bg-[#FCFBFA]">
        <td className="py-2.5 pl-[18px] pr-3 whitespace-nowrap">{number}</td>
        <td className="px-3 py-2.5 text-[11px] whitespace-nowrap text-muted">
          {date}
        </td>
        <td className="max-w-80 px-3 py-2.5">{client}</td>
        <td className="px-3 py-2.5">
          {fold != null && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={foldId}
              aria-label={toggleAria}
              onClick={() => setOpen((value) => !value)}
              className="flex h-8 items-center gap-1 rounded-lg border border-border-strong bg-surface-dim px-2.5 text-[12.5px] whitespace-nowrap text-ink-soft transition-colors hover:border-brand hover:text-brand-ink"
            >
              {/* The chevron turns to say which way the press goes. */}
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
              {toggleLabel}
            </button>
          )}
        </td>
        <td className="px-3 py-2.5">
          {/* The A4 sheet, in a tab of its own so the queue — filter, scroll,
              an open fold — is exactly where it was when the print dialog
              closes. */}
          <Link
            href={printHref}
            target="_blank"
            aria-label={printAria}
            className="flex h-8 w-fit items-center gap-1 rounded-lg bg-brand-soft px-2.5 text-[12.5px] font-medium whitespace-nowrap text-brand-ink transition-colors hover:bg-brand hover:text-white"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="size-4"
            >
              <path d="M4.5 6V2.5h7V6" />
              <path d="M4.5 11.5h-2v-4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v4h-2" />
              <path d="M4.5 9.5h7v4h-7Z" />
            </svg>
            {printLabel}
          </Link>
        </td>
        <td className="px-3 py-2.5">{badge}</td>
        <td className="py-2.5 pr-[18px] pl-3 text-right font-semibold whitespace-nowrap tabular-nums">
          {price}
        </td>
      </tr>
      {open && fold != null && (
        <tr id={foldId}>
          {/* No border of its own: the fold reads as the tail of the row above,
              and the NEXT main row's top border is what closes it. */}
          <td colSpan={7} className="px-[18px] pt-0 pb-3.5">
            {fold}
          </td>
        </tr>
      )}
    </>
  );
}
