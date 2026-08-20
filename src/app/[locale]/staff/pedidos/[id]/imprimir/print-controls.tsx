"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BTN_PRIMARY } from "@/components/ui";

/**
 * The sheet's 打印设置 — the owner's shape (2026-08-20): one settings row where
 * the choices live NEXT TO the print button, not a standalone toggle link that
 * reads as a second feature. Today it holds one choice, 显示价格.
 *
 * The checkbox still drives the URL (`?precios=0`), not client state: the
 * server renders the priced and the price-free sheet as DIFFERENT DOCUMENTS,
 * so the printed DOM never merely hides the money — a warehouse copy cannot
 * leak the tarifa through print-to-PDF and a text selection. `router.replace`
 * keeps the flip out of the history stack: Back from the sheet returns to the
 * queue, not to the other price mode.
 *
 * A client leaf for the same reason its predecessor was: `window.print()` and
 * an onChange are browser calls. Ctrl+P still works without ever touching it.
 */
export function PrintControls({
  showPrices,
  baseHref,
}: {
  showPrices: boolean;
  /** The sheet's own path, no query — the checkbox appends its state. */
  baseHref: string;
}) {
  const t = useTranslations("staff");
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted">{t("print.settings")}:</span>
      <label className="flex cursor-pointer items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={showPrices}
          onChange={(event) =>
            router.replace(
              event.target.checked ? baseHref : `${baseHref}?precios=0`,
            )
          }
          className="size-4 accent-[#E0231C]"
        />
        {t("print.showPrices")}
      </label>
      <button
        type="button"
        onClick={() => window.print()}
        className={`${BTN_PRIMARY} inline-flex h-9 items-center text-sm`}
      >
        {t("print.print")}
      </button>
    </div>
  );
}
