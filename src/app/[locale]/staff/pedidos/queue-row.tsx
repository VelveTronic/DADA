"use client";

import Link from "next/link";
import { useId, useRef, type ReactNode } from "react";

/**
 * ONE order of the queue table.  Its details use a native modal dialog: on a
 * phone it is a bottom sheet, while wider screens get a centred window.  The
 * dialog stays inside this row's valid `<td>` and is promoted to the top layer
 * by `showModal()`, so no invalid element is inserted between `<tbody>` and
 * `<tr>` and Escape/focus trapping come from the platform.
 *
 * The owner's third pass (2026-08-20) turned the queue from cards into this
 * table: a real `<thead>` names the columns, the cells align by column instead
 * of by fixed-track guesswork — which is also what retired the previous
 * round's uneven-gap complaint, since a table's columns share their widths by
 * construction — and the 明细 toggle lost its `(7 项)` count, which is what
 * used to wrap it onto two lines inside its track. The modal now holds the full
 * order summary, lines, notes, failure diagnosis and permitted actions.
 *
 * Everything in every cell arrives server-rendered as props; this file owns
 * only the native dialog controls.
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
  detail,
  selectionColumn = false,
  selection,
  detailsTitle,
  closeLabel,
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
  /** Full server-rendered order detail shown in the modal. */
  detail: ReactNode;
  /** Whether this view has the bulk-selection column at all. */
  selectionColumn?: boolean;
  selection?: ReactNode;
  detailsTitle: string;
  closeLabel: string;
}) {
  const dialogId = useId();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <tr className="border-t border-[#F4F0EC] align-middle transition-colors hover:bg-[#FCFBFA]">
      {selectionColumn && (
        <td className="py-2.5 pl-[18px] pr-1 text-center">{selection}</td>
      )}
      <td className="py-2.5 pl-[18px] pr-3 whitespace-nowrap">{number}</td>
      <td className="px-3 py-2.5 text-[11px] whitespace-nowrap text-muted">
        {date}
      </td>
      <td className="max-w-80 px-3 py-2.5">{client}</td>
      <td className="px-3 py-2.5">
        {detail != null && (
          <button
            type="button"
            aria-controls={dialogId}
            aria-haspopup="dialog"
            aria-label={toggleAria}
            onClick={() => {
              if (!dialog.current?.open) dialog.current?.showModal();
            }}
            className="flex h-8 items-center gap-1 rounded-lg border border-border-strong bg-surface-dim px-2.5 text-[12.5px] whitespace-nowrap text-ink-soft transition-colors hover:border-brand hover:text-brand-ink"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="size-4 -rotate-90"
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
            {toggleLabel}
          </button>
        )}
        {detail != null && (
          <dialog
            ref={dialog}
            id={dialogId}
            aria-labelledby={titleId}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                event.currentTarget.close();
              }
            }}
            className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl border border-border-strong bg-surface p-0 text-left text-ink shadow-2xl backdrop:bg-black/40 sm:inset-0 sm:m-auto sm:max-h-[calc(100dvh-3rem)] sm:max-w-4xl sm:rounded-2xl"
          >
            <div className="flex max-h-[92dvh] flex-col sm:max-h-[calc(100dvh-3rem)]">
              <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-5">
                <h2 id={titleId} className="min-w-0 flex-1 text-base font-bold">
                  {detailsTitle}
                </h2>
                <button
                  type="button"
                  onClick={() => dialog.current?.close()}
                  aria-label={closeLabel}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong text-xl leading-none text-ink-soft transition-colors hover:border-brand hover:text-brand-ink"
                >
                  ×
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
                {detail}
              </div>
            </div>
          </dialog>
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
      <td className="px-3 py-2.5 whitespace-nowrap">{badge}</td>
      <td className="py-2.5 pr-[18px] pl-3 text-right font-semibold whitespace-nowrap tabular-nums">
        {price}
      </td>
    </tr>
  );
}
