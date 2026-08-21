"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { GridViewIcon, ListViewIcon } from "@/components/icons";

type CatalogView = "list" | "grid";

const STORAGE_KEY = "dada.catalog.view";

let fallbackView: CatalogView = "list";
const viewListeners = new Set<() => void>();

function isCatalogView(value: string | null): value is CatalogView {
  return value === "list" || value === "grid";
}

function readCatalogView(): CatalogView {
  if (typeof window === "undefined") return "list";

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isCatalogView(saved)) {
      fallbackView = saved;
      return saved;
    }
  } catch {
    // The in-memory fallback below still gives this visit a working switcher.
  }

  return fallbackView;
}

function subscribeToCatalogView(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;

  viewListeners.add(onStoreChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    fallbackView = isCatalogView(event.newValue) ? event.newValue : "list";
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    viewListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Keeps the catalogue's two product presentations in one place. Both views
 * stay mounted so the cart context remains live when the customer switches;
 * the inactive one is hidden from layout and assistive technology.
 */
export function CatalogViewSwitcher({
  paneLabel,
  count,
  viewModeLabel,
  listLabel,
  gridLabel,
  list,
  grid,
}: {
  paneLabel: string;
  count: ReactNode;
  viewModeLabel: string;
  listLabel: string;
  gridLabel: string;
  list: ReactNode;
  grid: ReactNode;
}) {
  const view = useSyncExternalStore(
    subscribeToCatalogView,
    readCatalogView,
    () => "list",
  );

  function choose(next: CatalogView) {
    fallbackView = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A failed preference write must not prevent switching this page.
    }
    viewListeners.forEach((listener) => listener());
  }

  const toggleButton =
    "inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand";

  return (
    <>
      <div className="sticky top-0 z-10 flex min-h-12 items-center justify-between gap-2 bg-surface px-4 py-1.5">
        <h1 className="min-w-0 truncate text-sm font-bold">{paneLabel}</h1>

        <div className="flex shrink-0 items-center gap-2">
          <span className="font-num text-xs text-faint tabular-nums">{count}</span>
          <div
            role="group"
            aria-label={viewModeLabel}
            className="inline-flex rounded-[10px] border border-border-strong bg-surface-dim p-0.5"
          >
            <button
              type="button"
              aria-label={listLabel}
              aria-pressed={view === "list"}
              title={listLabel}
              onClick={() => choose("list")}
              className={`${toggleButton} ${
                view === "list"
                  ? "bg-surface text-brand-ink shadow-sm"
                  : "text-muted hover:bg-surface hover:text-ink"
              }`}
            >
              <ListViewIcon />
            </button>
            <button
              type="button"
              aria-label={gridLabel}
              aria-pressed={view === "grid"}
              title={gridLabel}
              onClick={() => choose("grid")}
              className={`${toggleButton} ${
                view === "grid"
                  ? "bg-surface text-brand-ink shadow-sm"
                  : "text-muted hover:bg-surface hover:text-ink"
              }`}
            >
              <GridViewIcon />
            </button>
          </div>
        </div>
      </div>

      <div hidden={view !== "list"}>{list}</div>
      <div hidden={view !== "grid"}>{grid}</div>
    </>
  );
}
