"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

/**
 * The queue card's HEADER ROW and its fold, as one client leaf.
 *
 * It exists because of a containment problem `<details>` cannot solve: the
 * owner's layout (2026-08-20) puts the 明细 toggle IN the right-hand control
 * cluster — one horizontal line of 明细 · 打印 · status · money — while the
 * lines it opens span the card's full width BELOW that line. A `<summary>`
 * lives inside its `<details>`, so with the native element either the toggle
 * leaves the cluster or the lines are squeezed into it. This component holds
 * the open flag instead and renders the two halves where the layout wants
 * them; everything inside the row and the fold is still server-rendered and
 * arrives as props.
 *
 * The toggle carries `aria-expanded`/`aria-controls`, which is the half of
 * `<details>` semantics worth keeping; the fold is plain conditional render,
 * so a closed card costs the DOM nothing — same as `<details>` pre-Chromium
 * `hidden=until-found`, and nothing on this queue is searched with Ctrl+F
 * while folded.
 *
 * The cluster is a fixed-track grid (see its note below) and the two actions
 * are BUTTONS with fills — 明细 on the dim ground, 打印 on the soft brand —
 * badge-weight beside the status chip, per the owner's second pass. The row
 * still holds two shallow stacks of card height until somebody opens it.
 */
export function QueueRow({
  children,
  lines,
  toggleLabel,
  toggleAria,
  printHref,
  printLabel,
  printAria,
  badge,
  price,
}: {
  /** The left half: number, date, restaurant, meta — server-rendered. */
  children: ReactNode;
  /** The fold's content, or null when the line read came back short. */
  lines: ReactNode;
  /** 明细 (7 项) — also the withheld-count rule's carrier: null lines, no toggle. */
  toggleLabel: string;
  /** …and the same with the order number in it, for a screen reader. */
  toggleAria: string;
  printHref: string;
  printLabel: string;
  printAria: string;
  badge: ReactNode;
  price: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const foldId = useId();

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
          {children}
        </div>

        {/* A GRID of fixed tracks, not a flex run — the owner's alignment
            call (2026-08-20 round two): down fifty rows, 明细 sits under 明细
            and money under money, whatever the restaurant's name did to the
            left half. Every cell is centred in its track; the track widths are
            sized for the widest content either locale produces (明细（88 项）/
            Líneas (88), the 打印 pill, 已进ERP, a four-figure euro amount).
            An order whose lines failed to read keeps an EMPTY first cell
            rather than sliding the other three left — the withheld-count rule
            must not un-align the column it withheld from. */}
        <div className="ml-auto grid shrink-0 grid-cols-[7rem_5.5rem_5rem_6rem] items-center justify-items-center gap-x-2">
          {lines != null ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={foldId}
              aria-label={toggleAria}
              onClick={() => setOpen((value) => !value)}
              className="flex h-8 items-center gap-1 rounded-lg border border-border-strong bg-surface-dim px-2.5 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:text-brand-ink"
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
          ) : (
            <span aria-hidden />
          )}

          {/* The A4 sheet, in a tab of its own so the queue — filter, scroll,
              an open fold — is exactly where it was when the print dialog
              closes. The soft brand fill is the owner's "make it show" —
              a badge-weight pill beside the status chip, not a text link. */}
          <Link
            href={printHref}
            target="_blank"
            aria-label={printAria}
            className="flex h-8 items-center gap-1 rounded-lg bg-brand-soft px-2.5 text-[12.5px] font-medium text-brand-ink transition-colors hover:bg-brand hover:text-white"
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

          {badge}
          {price}
        </div>
      </div>

      {open && lines != null && <div id={foldId}>{lines}</div>}
    </>
  );
}
