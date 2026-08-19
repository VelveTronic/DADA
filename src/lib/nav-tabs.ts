/**
 * WHICH TAB IS LIT — the one rule, for every navigation surface the customer
 * shell draws: the phone's bottom `TabBar`, the desktop header's icon row
 * (`storefront-nav.tsx`) and the demand bar, which shows itself on the two
 * screens where goods are picked and nowhere else (`cart/cart-bar.tsx`).
 *
 * A pure module with NO imports, deliberately. Both callers are client
 * components and this is what they share; a shared list living in either of
 * them would drag `next/link`, `next-intl` and the cart context into the other
 * one — and into this file's own test, which is a table and needs no browser.
 *
 * **The pathname it takes is LOCALE-STRIPPED**, which is what next-intl's
 * `usePathname` hands back: `/catalogo`, never `/zh/catalogo`.
 *
 * Matching is by first SEGMENT, not by whole string. `/pedidos` and a future
 * `/pedidos/1234` are the same tab — an order's own page is still 我的 — and
 * that is also why `/catalogofalso` is nobody's tab rather than the
 * catalogue's. Anything unrecognised (`/`, `/login`, `/staff/...`) answers
 * null: those screens are outside the customer shell entirely.
 */
export type TabKey = "catalog" | "search" | "cart" | "account";

/**
 * The pages behind 我的 — the tab, and the header's 用户 menu, which stays lit
 * across all four. The app never reads the list itself; it asks `activeTab`.
 * Exported so the table below it can be walked in the test.
 */
export const ACCOUNT_PATHS = [
  "/cuenta",
  "/pedidos",
  "/direcciones",
  "/perfil",
] as const;

const TAB_BY_SEGMENT: Record<string, TabKey> = {
  "/catalogo": "catalog",
  "/buscar": "search",
  "/carrito": "cart",
  ...Object.fromEntries(ACCOUNT_PATHS.map((path) => [path, "account" as const])),
};

export function activeTab(pathname: string): TabKey | null {
  // ["", "catalogo", "…"] for "/catalogo/…"; ["", ""] for "/". Index 1 is the
  // first segment either way, and an empty one matches nothing below.
  const segment = pathname.split("/")[1] ?? "";
  return TAB_BY_SEGMENT[`/${segment}`] ?? null;
}
