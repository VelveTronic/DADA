"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { confirmOrdersBulk } from "@/app/actions/staff-orders";
import type { BulkConfirmActionState } from "@/lib/orders";

const INITIAL_STATE: BulkConfirmActionState = {
  outcome: "idle",
  requestedCount: 0,
  confirmedCount: 0,
  skippedCount: 0,
};

interface BulkLabels {
  selected: string;
  confirm: string;
  confirming: string;
  bridgeNotice: string;
  resultOk: string;
  resultPartial: string;
  resultWrongState: string;
  resultInvalid: string;
  resultError: string;
  confirmed: string;
  skipped: string;
}

interface SelectionContextValue {
  selected: ReadonlySet<string>;
  eligibleIds: readonly string[];
  pending: boolean;
  toggle: (id: string) => void;
  toggleAll: () => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("Bulk confirmation checkbox is outside its scope");
  return value;
}

/**
 * Owns the selection and the one bulk Server Action form.  It wraps the table
 * but does not wrap it in a form: individual confirm/cancel/quantity forms live
 * inside each details dialog, and nested forms would be invalid HTML.
 */
export function BulkConfirmScope({
  enabled,
  eligibleIds,
  locale,
  labels,
  children,
}: {
  enabled: boolean;
  eligibleIds: readonly string[];
  locale: string;
  labels: BulkLabels;
  children: ReactNode;
}) {
  const eligible = useMemo(() => new Set(eligibleIds), [eligibleIds]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [result, formAction, pending] = useActionState(
    confirmOrdersBulk,
    INITIAL_STATE,
  );

  // Stale ids may remain in local state after the Server Action refreshes the
  // queue, but they never remain selected for display or submission.
  const selectedIds = eligibleIds.filter((id) => selected.has(id));
  const selectedNow = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = (id: string) => {
    if (pending || !eligible.has(id)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (pending) return;
    setSelected((current) => {
      const allSelected = eligibleIds.every((id) => current.has(id));
      return allSelected ? new Set() : new Set(eligibleIds);
    });
  };

  const outcomeText =
    result.outcome === "ok"
      ? labels.resultOk
      : result.outcome === "partial"
        ? labels.resultPartial
        : result.outcome === "wrong-state"
          ? labels.resultWrongState
          : result.outcome === "invalid"
            ? labels.resultInvalid
            : result.outcome === "error"
              ? labels.resultError
              : null;
  const outcomeBad =
    result.outcome === "invalid" || result.outcome === "error";
  const outcomeWarn =
    result.outcome === "partial" || result.outcome === "wrong-state";

  if (!enabled) return <>{children}</>;

  return (
    <SelectionContext.Provider
      value={{
        selected: selectedNow,
        eligibleIds,
        pending,
        toggle,
        toggleAll,
      }}
    >
      <div className="mt-[18px] rounded-xl border border-border-strong bg-surface px-3 py-3 sm:flex sm:items-center sm:gap-4 sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {labels.selected}: {selectedIds.length}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {labels.bridgeNotice}
          </p>
        </div>
        <form action={formAction} className="mt-3 shrink-0 sm:mt-0">
          <input type="hidden" name="locale" value={locale} />
          {selectedIds.map((id) => (
            <input key={id} type="hidden" name="order_id" value={id} />
          ))}
          <button
            type="submit"
            disabled={pending || selectedIds.length === 0}
            className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand px-4 text-[13px] font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto"
          >
            {pending ? labels.confirming : labels.confirm}
          </button>
        </form>
      </div>

      {outcomeText && (
        <div
          role={outcomeBad ? "alert" : "status"}
          aria-live="polite"
          className={`mt-2 rounded-lg px-3 py-2 text-sm ${
            outcomeBad
              ? "bg-red-50 text-red-700"
              : outcomeWarn
                ? "bg-amber-50 text-amber-900"
                : "bg-green-50 text-green-800"
          }`}
        >
          <p>{outcomeText}</p>
          {(result.outcome === "ok" || result.outcome === "partial") && (
            <p className="mt-1 text-xs tabular-nums">
              {labels.confirmed}: {result.confirmedCount}
              {result.skippedCount > 0 && (
                <>
                  {" · "}
                  {labels.skipped}: {result.skippedCount}
                </>
              )}
            </p>
          )}
        </div>
      )}

      {children}
    </SelectionContext.Provider>
  );
}

/** Select every confirmable order currently rendered on this page. */
export function BulkConfirmAllCheckbox({ label }: { label: string }) {
  const { selected, eligibleIds, pending, toggleAll } = useSelection();
  const input = useRef<HTMLInputElement>(null);
  const selectedCount = eligibleIds.filter((id) => selected.has(id)).length;
  const allSelected = eligibleIds.length > 0 && selectedCount === eligibleIds.length;

  useEffect(() => {
    if (input.current) {
      input.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [allSelected, selectedCount]);

  return (
    <input
      ref={input}
      type="checkbox"
      checked={allSelected}
      disabled={pending || eligibleIds.length === 0}
      onChange={toggleAll}
      aria-label={label}
      className="size-4 cursor-pointer accent-brand disabled:cursor-not-allowed"
    />
  );
}

/** One row's controlled checkbox, sharing the scope's pending lock. */
export function BulkConfirmCheckbox({
  id,
  label,
}: {
  id: string;
  label: string;
}) {
  const { selected, pending, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      checked={selected.has(id)}
      disabled={pending}
      onChange={() => toggle(id)}
      aria-label={label}
      className="size-4 cursor-pointer accent-brand disabled:cursor-not-allowed"
    />
  );
}
