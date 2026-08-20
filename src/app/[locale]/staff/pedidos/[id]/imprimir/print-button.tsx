"use client";

import { useTranslations } from "next-intl";
import { BTN_PRIMARY } from "@/components/ui";

/**
 * The one client leaf on the print sheet: `window.print()` is a browser call,
 * so the button cannot be a Server Component. Everything else on the route —
 * the sheet, the toggle, the way back — is server-rendered markup; Ctrl+P works
 * without this button ever being pressed, which is why losing JS costs the
 * screen nothing but this shortcut.
 */
export function PrintButton() {
  const t = useTranslations("staff");
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={`${BTN_PRIMARY} inline-flex h-9 items-center text-sm`}
    >
      {t("print.print")}
    </button>
  );
}
