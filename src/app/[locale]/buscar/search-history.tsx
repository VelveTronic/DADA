"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import {
  SEARCH_HISTORY_KEY,
  parseHistory,
  pushHistory,
} from "@/lib/search-history";

/**
 * `localStorage` as a React store.
 *
 * The obvious shape for this screen — `useState([])` plus an effect that reads
 * storage and calls `setTerms` — is exactly what `react-hooks/set-state-in-effect`
 * refuses, and it is right to: the list is state that lives OUTSIDE React, and
 * copying it into a `useState` renders the component twice on every visit to say
 * something the store already knew. `useSyncExternalStore` is the API for
 * reading one, and it hands us two things the copy could not: the server
 * snapshot below (which is what makes the first client render agree with the
 * server's empty one), and the `storage` event, so a second tab of the same
 * phone cannot leave this one showing a list that is no longer there.
 *
 * The snapshot is CACHED against the raw string, because `getSnapshot` is called
 * during render and must return the same array until the stored value actually
 * changes — a fresh `parseHistory` array every call is an infinite render loop.
 *
 * Every touch of `localStorage` is wrapped: Safari with "block all cookies"
 * throws on the property itself and a full private-mode quota throws on the
 * write. A phone that refuses storage loses its chips and keeps its search page.
 */
const EMPTY: string[] = [];
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedList: string[] = EMPTY;

function readRaw(): string | null {
  try {
    return localStorage.getItem(SEARCH_HISTORY_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): string[] {
  const raw = readRaw();
  // No key yet — the first-ever visit, and the storage-refused case — answers
  // with the very array `getServerSnapshot` returned, so hydration has nothing
  // to re-render. `parseHistory` would hand back a fresh `[]` and cost a pass.
  if (!raw) return EMPTY;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = parseHistory(raw);
  }
  return cachedList;
}

/** The server has no phone to read: every render before mount draws nothing. */
function getServerSnapshot(): string[] {
  return EMPTY;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Fires for OTHER documents of this origin only — this document's own writes
  // are announced by `writeHistory` below.
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** `next`, or `null` to forget the lot. */
function writeHistory(next: string[] | null): void {
  try {
    if (next) {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(SEARCH_HISTORY_KEY);
    }
  } catch {
    // Storage refused the write; the snapshot below simply re-reads what is
    // really there, so the chips stay honest about it.
  }
  for (const listener of listeners) listener();
}

/**
 * 历史搜索 — the chips above the results, and the only part of this screen the
 * browser owns.
 *
 * The list lives on the phone (see `lib/search-history.ts` for why it is not a
 * table), so it cannot exist during the server render: the page is one request
 * for every restaurant and the history is one handset's. Nothing is drawn until
 * the store has been read on the client, which is what keeps a list only the
 * browser knows about out of the hydration diff.
 *
 * **The effect writes, it does not read into state.** Recording the search that
 * got here is an update to the external system, keyed on `?q` — and `?q` is also
 * what makes the chips refresh when one is pressed, because a chip is a
 * navigation to this same page rather than a remount.
 *
 * `pushHistory` hands back the SAME ARRAY when the term is already at the front
 * of the list (its suite pins that by identity), and the effect's guard below
 * skips the write whenever it does — so a reload, a press on the first chip and
 * React StrictMode's second invocation in development all touch `localStorage`
 * zero times, rather than rewriting it with what it already held.
 */
export function SearchHistory({ locale, q }: { locale: string; q: string }) {
  const t = useTranslations("search");
  const terms = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const stored = getSnapshot();
    const next = pushHistory(stored, q);
    // The SAME array back means the list already says what this visit would
    // have said — a bare `/buscar` landing, or this term already at the front —
    // so the screen opens without rewriting storage (StrictMode's second pass
    // included).
    if (next !== stored) writeHistory(next);
  }, [q]);

  if (terms.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5 border-b border-border px-4 pt-1.5 pb-3.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[12.5px] font-semibold text-ink-soft">
          {t("history")}
        </h2>
        {/* 清除 alone is what the design draws, and beside the heading it sits
            next to it is enough — but a screen reader hears the button on its
            own, where "清除" could be clearing anything on the page, so the
            accessible name says which list it empties. Both strings rather than
            a title attribute: the visible word is inside the accessible one,
            which is what WCAG 2.5.3 asks for.

            44px tall for the thumb, and `-my-2.5` gives the 10px back at each
            end (the trick the catalogue row's star uses) so this control cannot
            turn an 18px caption line into a 44px band. The overhang stops
            exactly where the chips start — the block's own `gap-2.5` is those
            10px — so a press aimed at the first chip cannot land in here. */}
        <button
          type="button"
          onClick={() => writeHistory(null)}
          aria-label={t("clearHistory")}
          className="-my-2.5 -mr-2 flex h-11 min-w-11 items-center justify-end px-2 text-[11.5px] text-muted transition-colors hover:text-ink-soft"
        >
          {t("clear")}
        </button>
      </div>

      {/* Wrapped, not a sideways scroller: ten short terms are two or three
          lines on a 390px phone, and a chip the customer has to drag into view
          is worse than no shortcut at all. Each chip is a plain navigation to
          this same page with its own `?q` — the URL IS the search, which is
          what makes a chip shareable, bookmarkable and back-button-able. */}
      <div className="flex flex-wrap gap-2">
        {terms.map((term) => (
          <Link
            key={term}
            href={`/${locale}/buscar?q=${encodeURIComponent(term)}`}
            className="flex h-8 items-center rounded-full bg-surface-dim px-3 text-[12.5px] text-ink-soft transition-colors hover:text-ink"
          >
            {term}
          </Link>
        ))}
      </div>
    </div>
  );
}
