"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { NAV_LINK, NAV_PILL } from "@/components/ui";
import { useCart } from "./cart-provider";

/**
 * The header's cart entry — the same label, the same count and the same soft
 * brand pill the server shell used to render, moved to a client leaf so it
 * ticks on the press rather than on the next navigation.
 *
 * It counts LINES, not units, exactly as before (`cart.cartLink` takes `{n}`):
 * "Carrito (3)" means three products, whatever the quantities are.
 */
export function CartNavLink({ locale }: { locale: string }) {
  const { count } = useCart();
  const t = useTranslations("cart");

  return (
    <Link
      href={`/${locale}/carrito`}
      // Same rule the shell had: the entry only takes the accent once there is
      // something in it — a cart nobody can see is a cart nobody submits.
      className={count > 0 ? NAV_PILL : NAV_LINK}
    >
      {t("cartLink", { n: count })}
    </Link>
  );
}
