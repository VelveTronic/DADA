"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "@/i18n/navigation";
import { formatEuros } from "@/lib/money";
import { useCart } from "./cart-provider";

/**
 * The phone's bottom cart bar (TOKACHI's `cart-bar.tsx` shape): count, name,
 * subtotal, fixed above the safe area, below `lg` only and only while the cart
 * has something in it.
 *
 * **It is not there because the header scrolls away** — the header is sticky
 * and the cart count is always on it. It earns its place on two other counts:
 * it shows the RUNNING SUBTOTAL, which the header entry never has room for and
 * which is the number a restaurant is actually watching while it shops; and it
 * puts the way to checkout inside thumb reach at 44px, instead of at the top
 * corner of a phone held one-handed.
 *
 * **The subtotal is the page's own arithmetic or nothing.** The provider adds up
 * the prices the SERVER rendered on this page (`cartSubtotalCents` returns null
 * the moment one line is missing from that set) — so a cart holding something
 * off the current catalogue page shows the count alone. TOKACHI's rule, for the
 * same reason: a total that quietly drops a line is worse than no total.
 *
 * It hides itself on `/carrito`, where it would be a link to the page it is on
 * and a second copy of the subtotal already in the layout.
 */
export function CartBar({ locale }: { locale: string }) {
  const { count, subtotalCents } = useCart();
  const t = useTranslations("cart");
  // next-intl strips the locale prefix, so this is `/carrito`, not `/zh/carrito`.
  const pathname = usePathname();

  if (count === 0 || pathname === "/carrito") return null;

  return (
    <>
      {/* Reserves the scroll room the fixed bar covers, so the last catalogue
          row is never stuck underneath it. */}
      <div aria-hidden="true" className="h-20 lg:hidden" />
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/85 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-[14px] lg:hidden">
        <Link
          href={`/${locale}/carrito`}
          className="mx-auto flex h-11 max-w-5xl items-center justify-between gap-3 rounded-full bg-brand px-2 pr-5 text-sm font-semibold text-white transition-colors hover:bg-brand/90"
        >
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-white text-sm font-bold text-brand-ink tabular-nums">
            {count}
          </span>
          <span>{t("title")}</span>
          <span className="tabular-nums">
            {subtotalCents == null ? "—" : formatEuros(subtotalCents, locale)}
          </span>
        </Link>
      </div>
    </>
  );
}
