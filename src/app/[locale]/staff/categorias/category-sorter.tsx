"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  moveCategoryAction,
  reorderCategoriesAction,
} from "@/app/actions/staff-categories";
import { BTN_PRIMARY } from "@/components/ui";

const ROW =
  "flex items-center gap-2 border-t border-[#F4F0EC] px-[14px] py-[11px]";
const MOVE_BTN =
  "inline-flex size-8 items-center justify-center rounded-lg border border-border-strong bg-surface text-xs leading-none text-ink-soft transition-colors hover:border-brand hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:text-ink-soft";
const DRAG_HANDLE =
  "inline-flex size-8 shrink-0 cursor-grab items-center justify-center rounded-lg border border-dashed border-border-strong bg-field text-sm text-muted active:cursor-grabbing";

export interface SorterCategory {
  id: number;
  label: string;
  secondName: string | null;
  href: string;
  isActive: boolean;
  limited: boolean;
  productCount: string;
}

export type SorterEntry =
  | { kind: "category"; category: SorterCategory }
  | {
      kind: "group";
      label: string;
      countLabel: string;
      children: SorterCategory[];
    };

interface SorterLabels {
  moveUp: string;
  moveDown: string;
  moveGroupUp: string;
  moveGroupDown: string;
  dragHandle: string;
  expandGroup: string;
  collapseGroup: string;
  hiddenChip: string;
  limitedChip: string;
  saveOrder: string;
  orderHint: string;
  unchanged: string;
}

interface CategorySorterProps {
  entries: SorterEntry[];
  locale: string;
  selectedId: number | null;
  creating: boolean;
  initialOpenGroup: string;
  labels: SorterLabels;
}

type Dragged =
  | { kind: "top"; index: number }
  | { kind: "child"; group: string; index: number };

function flatten(entries: readonly SorterEntry[]): number[] {
  return entries.flatMap((entry) =>
    entry.kind === "group"
      ? entry.children.map((child) => child.id)
      : [entry.category.id],
  );
}

/**
 * Everything about the server's list that this component draws or posts, as
 * one string.
 *
 * It is the RESEED TRIGGER, and it has to cover more than the ids. The ids
 * alone would miss a rename — `renameCategory` redirects back here with the
 * same rows in the same order, and the list would keep painting the old
 * word — while the ids alone are exactly what a create changes, which is the
 * failure this exists for: `createCategory` deliberately does NOT redirect
 * (it revalidates so the form can stay open for the next one), so the server
 * sends a longer list to a component that had already seeded its state, and
 * the next 保存顺序 posted the OLD set. `staff_reorder_categories` compares
 * the submitted array against `count(*)` and answers BAD_ORDER, so the whole
 * reorder failed with a message about a bad request rather than about the
 * category that had just been added.
 */
function serverSignature(entries: readonly SorterEntry[]): string {
  return entries
    .map((entry) =>
      entry.kind === "group"
        ? `g:${entry.label}:${entry.countLabel}:${entry.children
            .map((child) => `${child.id}/${child.label}/${child.isActive}/${child.limited}/${child.productCount}`)
            .join("|")}`
        : `c:${entry.category.id}/${entry.category.label}/${entry.category.isActive}/${entry.category.limited}/${entry.category.productCount}`,
    )
    .join(";");
}

function moveAt<T>(values: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) {
    return [...values];
  }
  const next = [...values];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * WordPress-style category menu editor: pointer users drag, keyboard and touch
 * users have the same one-step ↑/↓ controls, and nothing is written until the
 * explicit Save order form posts the complete flattened tree.
 */
export function CategorySorter({
  entries: initialEntries,
  locale,
  selectedId,
  creating,
  initialOpenGroup,
  labels,
}: CategorySorterProps) {
  const [entries, setEntries] = useState(initialEntries);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(initialOpenGroup ? [initialOpenGroup] : []),
  );

  /**
   * Re-seed from the server whenever the server's list actually changed —
   * React's own "adjust state while rendering" pattern, which runs before the
   * children paint and needs no effect.
   *
   * The comparison is on CONTENT (`serverSignature`) and not on the prop's
   * identity: a client re-render caused by a drag must not reset the drag, and
   * every server render hands over a fresh array. An unsaved reorder IS
   * discarded when the list underneath it changed, and that is the point — the
   * alternative is posting an order for a set the database no longer has.
   */
  const signature = serverSignature(initialEntries);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setEntries(initialEntries);
  }

  const initialOrder = useMemo(() => flatten(initialEntries).join(","), [initialEntries]);
  const order = flatten(entries);
  const dirty = order.join(",") !== initialOrder;
  const openValue = openGroups.values().next().value ?? "-";

  const moveTop = (from: number, to: number) => {
    setEntries((current) => moveAt(current, from, to));
  };

  const moveChild = (group: string, from: number, to: number) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.kind === "group" && entry.label === group
          ? { ...entry, children: moveAt(entry.children, from, to) }
          : entry,
      ),
    );
  };

  const toggleGroup = (group: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const commonFields = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="cat" value={selectedId ?? ""} />
      {creating && <input type="hidden" name="new" value="1" />}
      <input type="hidden" name="open" value={openValue} />
    </>
  );

  const moveButtons = (
    target: { id: number } | { group: string },
    name: string,
    index: number,
    length: number,
    move: (from: number, to: number) => void,
  ) => (
    <div className="flex flex-none items-center gap-0.5">
      {([-1, 1] as const).map((delta) => {
        const up = delta === -1;
        const disabled = up ? index === 0 : index === length - 1;
        const group = "group" in target;
        const labelTemplate = group
          ? up
            ? labels.moveGroupUp
            : labels.moveGroupDown
          : up
            ? labels.moveUp
            : labels.moveDown;
        const label = labelTemplate.replace("__NAME__", name);
        return (
          <form key={delta} action={moveCategoryAction}>
            {commonFields}
            {group ? (
              <input type="hidden" name="group" value={target.group} />
            ) : (
              <input type="hidden" name="id" value={target.id} />
            )}
            <input type="hidden" name="dir" value={up ? "up" : "down"} />
            <button
              type="submit"
              disabled={disabled}
              aria-label={label}
              className={MOVE_BTN}
              onClick={(event) => {
                event.preventDefault();
                if (!disabled) move(index, index + delta);
              }}
            >
              <span aria-hidden>{up ? "↑" : "↓"}</span>
            </button>
          </form>
        );
      })}
    </div>
  );

  const categoryRow = (
    category: SorterCategory,
    index: number,
    siblings: number,
    childGroup: string | null,
  ) => {
    const isSelected = category.id === selectedId;
    const drag: Dragged = childGroup
      ? { kind: "child", group: childGroup, index }
      : { kind: "top", index };
    const compatible =
      dragged?.kind === drag.kind &&
      (drag.kind === "top" ||
        (dragged?.kind === "child" && dragged.group === drag.group));
    return (
      <li
        key={category.id}
        className={`${ROW} ${childGroup ? "pl-7" : ""} ${
          isSelected ? "bg-brand-soft text-brand-ink" : "hover:bg-[#FCFBFA]"
        }`}
        onDragOver={(event) => {
          if (compatible) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!compatible || !dragged) return;
          if (dragged.kind === "top") moveTop(dragged.index, index);
          if (dragged.kind === "child" && childGroup) {
            moveChild(childGroup, dragged.index, index);
          }
          setDragged(null);
        }}
      >
        {moveButtons(
          { id: category.id },
          category.label,
          index,
          siblings,
          childGroup
            ? (from, to) => moveChild(childGroup, from, to)
            : moveTop,
        )}
        <span
          draggable
          aria-label={labels.dragHandle.replace("__NAME__", category.label)}
          title={labels.dragHandle.replace("__NAME__", category.label)}
          className={DRAG_HANDLE}
          onDragStart={() => setDragged(drag)}
          onDragEnd={() => setDragged(null)}
        >
          <span aria-hidden>⋮⋮</span>
        </span>
        <Link
          href={category.href}
          aria-current={isSelected ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[13.5px] ${isSelected ? "font-bold" : ""}`}>
              {category.label}
            </span>
            {category.secondName && (
              <span className="block truncate text-[11px] text-muted">
                {category.secondName}
              </span>
            )}
          </span>
          {!category.isActive && (
            <span className="flex-none rounded-md bg-surface-dim px-1.5 py-0.5 text-[11px] text-muted">
              {labels.hiddenChip}
            </span>
          )}
          {category.limited && (
            <span className="flex-none rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
              {labels.limitedChip}
            </span>
          )}
          <span className="flex-none font-num text-xs text-muted tabular-nums">
            {category.productCount}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <>
      <ul className="lg:max-h-[calc(100vh-17rem)] lg:overflow-y-auto [&>li:first-child]:border-t-0">
        {entries.map((entry, topIndex) => {
          if (entry.kind === "category") {
            return categoryRow(entry.category, topIndex, entries.length, null);
          }
          const isOpen = openGroups.has(entry.label);
          const compatible = dragged?.kind === "top";
          return (
            <li
              key={`group:${entry.label}`}
              className="border-t border-[#F4F0EC]"
              onDragOver={(event) => {
                if (compatible) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged?.kind === "top") {
                  moveTop(dragged.index, topIndex);
                  setDragged(null);
                }
              }}
            >
              <div className="flex items-center gap-2 bg-field px-[14px] py-[11px]">
                {moveButtons(
                  { group: entry.label },
                  entry.label,
                  topIndex,
                  entries.length,
                  moveTop,
                )}
                <span
                  draggable
                  aria-label={labels.dragHandle.replace("__NAME__", entry.label)}
                  title={labels.dragHandle.replace("__NAME__", entry.label)}
                  className={DRAG_HANDLE}
                  onDragStart={() => setDragged({ kind: "top", index: topIndex })}
                  onDragEnd={() => setDragged(null)}
                >
                  <span aria-hidden>⋮⋮</span>
                </span>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={(isOpen
                    ? labels.collapseGroup
                    : labels.expandGroup
                  ).replace("__NAME__", entry.label)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => toggleGroup(entry.label)}
                >
                  <span aria-hidden className="w-3 flex-none text-[10px] text-muted">
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">
                    {entry.label}
                  </span>
                  <span className="flex-none font-num text-xs text-muted tabular-nums">
                    {entry.countLabel}
                  </span>
                </button>
              </div>
              {isOpen && (
                <ul>
                  {entry.children.map((category, childIndex) =>
                    categoryRow(
                      category,
                      childIndex,
                      entry.children.length,
                      entry.label,
                    ),
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <form
        action={reorderCategoriesAction}
        className="flex flex-wrap items-center gap-3 border-t border-[#EDE9E5] bg-field px-[14px] py-3"
      >
        {commonFields}
        <input type="hidden" name="order" value={JSON.stringify(order)} />
        <button type="submit" disabled={!dirty} className={BTN_PRIMARY}>
          {labels.saveOrder}
        </button>
        <p className="min-w-0 flex-1 text-[11px] text-muted" aria-live="polite">
          {dirty ? labels.orderHint : labels.unchanged}
        </p>
      </form>
    </>
  );
}
