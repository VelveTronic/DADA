"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BTN_PRIMARY } from "@/components/ui";

/**
 * The ＋新建用户 button and the modal it opens — the owner's call (2026-08-20):
 * with thirty-three restaurants in the book, the create forms at the card feet
 * meant every new account started with a scroll to the bottom of the page. The
 * form now comes to the staff member instead.
 *
 * A native `<dialog>`, not a hand-rolled overlay: `showModal()` brings the
 * focus trap, the Escape key and the `::backdrop` for free, and this repo has
 * no dialog precedent to stay consistent with. The two FORMS inside arrive as
 * props — they are the same server-composed `CreateCustomerForm` /
 * `CreateStaffForm` the page used to render at the card feet, labels and all;
 * this leaf owns only which of the two is showing and whether the box is open.
 * `staffForm` is absent for a manager, exactly as the staff card's foot was:
 * the chooser only renders when there is a choice.
 *
 * **Closing on success is the query trick.** A create action ends in a
 * redirect to `?result=ok`, which re-renders the page but deliberately does
 * NOT remount this client leaf — an open dialog would stay open over the
 * banner it just caused. So: OPENING the dialog first strips any stale
 * `?result` from the URL (which also retires the previous banner — stale
 * praise over a new form misleads), and an effect closes the dialog whenever
 * the query string changes from what it was at open. Every success is then a
 * `"" → ?result=…` transition: the box closes, the banner is visible behind
 * it, and a REJECTED submit — no redirect, no query change — keeps the box
 * open with the form's own error line, which is where the staff member's eyes
 * already are.
 */
export function CreateUserDialog({
  labels,
  customerForm,
  staffForm,
}: {
  labels: {
    trigger: string;
    title: string;
    typeCustomer: string;
    typeStaff: string;
    close: string;
  };
  customerForm: ReactNode;
  /** Only the owner gets one; without it the chooser row never renders. */
  staffForm?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [kind, setKind] = useState<"customer" | "staff">("customer");

  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  /** The query string as it stood when the dialog was opened. */
  const openedWith = useRef(query);

  useEffect(() => {
    if (dialogRef.current?.open && query !== openedWith.current) {
      dialogRef.current.close();
    }
  }, [query]);

  const open = () => {
    // The strip is what makes the success-close above deterministic — and a
    // `?result` banner from the PREVIOUS create has no business under a new
    // one anyway. `scroll: false`: the staff member just pressed a button at
    // the top; the page must not move under the opening box.
    openedWith.current = "";
    if (query) router.replace(pathname, { scroll: false });
    dialogRef.current?.showModal();
  };

  const kinds = [
    { key: "customer" as const, label: labels.typeCustomer },
    { key: "staff" as const, label: labels.typeStaff },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={open}
        className={`${BTN_PRIMARY} inline-flex h-10 items-center gap-1 text-sm`}
      >
        <span aria-hidden className="text-base leading-none">
          ＋
        </span>
        {labels.trigger}
      </button>

      <dialog
        ref={dialogRef}
        // Focus back where the journey started, whether the box closed by ×,
        // Escape, backdrop or success — `close` fires for all four.
        onClose={() => triggerRef.current?.focus()}
        // The backdrop IS the dialog element outside the inner div: a click
        // whose target is the dialog itself can only have landed there.
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="m-auto w-[min(680px,92vw)] rounded-card border border-border bg-surface p-0 shadow-[0_24px_60px_-20px_rgba(28,25,23,.35)] backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-bold">{labels.title}</h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label={labels.close}
            className="flex size-9 items-center justify-center rounded-full text-lg leading-none text-muted transition-colors hover:bg-surface-dim hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-5 py-4">
          {staffForm != null && (
            <div className="mb-4 grid grid-cols-2 gap-2">
              {kinds.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={kind === key}
                  onClick={() => setKind(key)}
                  className={`flex h-10 items-center justify-center rounded-[10px] border text-sm transition-colors ${
                    kind === key
                      ? "border-brand bg-brand-soft/40 font-semibold text-brand-ink"
                      : "border-border-strong text-ink-soft hover:border-brand hover:text-brand-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {/* BOTH stay mounted, the inactive one hidden: a half-filled customer
              form must survive a peek at the staff tab, and `useActionState`'s
              kept values live in the component being toggled. */}
          <div className={kind === "customer" ? "" : "hidden"}>
            {customerForm}
          </div>
          {staffForm != null && (
            <div className={kind === "staff" ? "" : "hidden"}>{staffForm}</div>
          )}
        </div>
      </dialog>
    </>
  );
}
