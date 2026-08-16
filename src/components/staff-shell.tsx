import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import {
  StaffSidebar,
  StaffTopBar,
  type StaffNavKey,
} from "@/components/staff-sidebar";
import { NAV_LINK } from "@/components/ui";
import { canManageStaff, canManageUsers, isStaffRole } from "@/lib/user-admin";

/**
 * The back office's frame: the sidebar on the left, a breadcrumb and a title
 * over the page's own content on the right.
 *
 * The portal is two products under one login, and this is where they part
 * company. A customer gets `AppShell` — a storefront header of icons over a
 * centred column. A staff member gets THIS: the persistent left nav every admin
 * tool has, because the four back-office pages are worked in rotation all day
 * and a header that has to be scrolled back to is a header that gets scrolled
 * back to forty times. The structure is Medusa v2's admin (studied at
 * `medusajs/medusa`, `packages/admin/dashboard/src/components/layout` — shell,
 * main-layout, nav-item); the tokens are ours, the CSS is written here, and no
 * dependency was added to get it.
 *
 * The split lives at the PAGE: a staff page renders `StaffShell`, a customer
 * page renders `AppShell`. `AppShell` no longer takes a `nav` prop at all —
 * threading a variant through a shell that then draws two entirely different
 * headers was the smaller half of the truth, and the guard each page already
 * calls (`requireStaff` vs `requireCompanyUser`) is where the two audiences are
 * actually told apart.
 *
 * A Server Component. The sidebar's two client leaves exist for the drawer's
 * open state and for the active-route highlight (`usePathname`), and for nothing
 * else — the role gating below is done here, so a nav entry a staff member may
 * not use never reaches their browser.
 */
export async function StaffShell({
  locale,
  user,
  title,
  breadcrumb,
  children,
}: {
  locale: Locale;
  /** `role` is `staff_users.role`; it decides which two entries are drawn. */
  user: { name: string; role?: string | null };
  /** The page's own h1, unchanged from the one it used to render itself. */
  title: string;
  /**
   * The short name of this page in the trail (员工后台 / 订单). Omitted by the
   * staff HOME, whose trail would be the root crumb and nothing else.
   */
  breadcrumb?: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("staff");

  // The same two gates the pages themselves use, from the same role. Hiding an
  // entry is a courtesy, never the gate: `/staff/usuarios` and `/staff/ajustes`
  // both redirect a staff member who types the URL, and every action behind them
  // repeats the check for the POST that skipped the page.
  const items: StaffNavKey[] = [
    "home",
    "orders",
    "products",
    ...(canManageUsers(user.role) ? (["users"] as const) : []),
    ...(canManageStaff(user.role) ? (["settings"] as const) : []),
  ];

  // The role in words. `staff.users.roles.*` already carries all three (a test
  // holds them to the `STAFF_ROLES` list), so the sidebar borrows that
  // vocabulary rather than printing the bare column value the old staff header
  // showed. Anything unrecognised is printed as it stands.
  const roleLabel =
    user.role == null
      ? null
      : isStaffRole(user.role)
        ? t(`users.roles.${user.role}`)
        : user.role;

  const sidebar = {
    locale,
    items,
    name: user.name,
    roleLabel,
  };

  return (
    <>
      <StaffTopBar {...sidebar} />

      <div className="flex min-h-screen">
        <StaffSidebar {...sidebar} />

        {/* `min-w-0` is what stops a wide products table from pushing the whole
            layout sideways: without it a flex item is as wide as its content and
            the sidebar gets shoved off-screen. */}
        <main className="min-w-0 flex-1 px-4 pb-16 sm:px-6">
          <div className="mx-auto w-full max-w-5xl">
            {breadcrumb && (
              <nav
                aria-label={t("shell.breadcrumb")}
                className="mt-6 flex items-center gap-2 text-sm"
              >
                <Link href={`/${locale}/staff`} className={NAV_LINK}>
                  {t("title")}
                </Link>
                <span aria-hidden="true" className="text-muted">
                  /
                </span>
                {/* The last crumb is the page you are on: text, not a link to
                    itself. */}
                <span aria-current="page" className="text-muted">
                  {breadcrumb}
                </span>
              </nav>
            )}

            <h1
              className={`${breadcrumb ? "mt-2" : "mt-8"} text-2xl font-bold tracking-tight`}
            >
              {title}
            </h1>

            {children}
          </div>
        </main>
      </div>
    </>
  );
}
