import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import {
  StaffSidebar,
  StaffTopBar,
  type ShellCounts,
  type StaffNavKey,
} from "@/components/staff-sidebar";
import { NAV_LINK } from "@/components/ui";
import { perfRun } from "@/lib/perf";
import { type CountResult, readCount } from "@/lib/shell-counts";
import { createServerSupabase } from "@/lib/supabase/server";
import { canManageStaff, canManageUsers, isStaffRole } from "@/lib/user-admin";

/**
 * One backlog figure, or `null` when the read cannot be trusted to have one.
 *
 * The decision itself is `readCount` in `lib/shell-counts.ts`, pure and under
 * test; this is the logging half. It matters that it logs BOTH failure shapes,
 * because a `head: true` request that fails quietly is the easiest kind to miss:
 * a HEAD response has no body, so postgrest-js has no error JSON to parse and
 * `error.message` would be `""` even when it does fill one in. The status is
 * therefore printed too, and a result with no error at all is named as what it
 * is rather than logged as `null`. `null` travels to the sidebar as an em dash;
 * see `ShellCounts`.
 */
function readShellCount(name: string, result: CountResult): number | null {
  const value = readCount(result);
  if (value === null) {
    console.error(
      `staff shell ${name} count (status ${result.status}):`,
      result.error ?? "no content-range on the response",
    );
  }
  return value;
}

/**
 * The back office's frame: the sidebar on the left, a breadcrumb and a title
 * over the page's own content on the right.
 *
 * The portal is two products under one login, and this is where they part
 * company. A customer gets `AppShell` — a storefront header of icons over a
 * centred column. A staff member gets THIS: the persistent left nav every admin
 * tool has, because the six back-office pages are worked in rotation all day
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
  //
  // 分类 is ungated: category writes are open to any active staff member — it is
  // one of the tables whose write RLS is a bare `is_staff()` (so are `products`,
  // migration 20260815101406:173-180) and, uniquely, the one whose id sequence is
  // granted to authenticated (:719, the only such grant in the schema), which is
  // what lets the session client INSERT a row at all. The page guards itself with
  // `requireStaff` like every other one.
  const items: StaffNavKey[] = [
    "home",
    "orders",
    "products",
    "categories",
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

  // The sidebar's three figures, on the SESSION client under staff RLS — the
  // same mechanism `/staff/pedidos` reads its queue with, and `head: true` so
  // that not one row comes back, only the Content-Range count (the idiom
  // `/cuenta` uses for its four). The select list names one real column each:
  // `orders` is column-revoked (`staff_note`) and a `*` there 403s the query.
  //
  // This is ONE extra round trip per staff page, and it is paid HERE rather than
  // beside the page's own reads because the shell renders after those have
  // already resolved — the price of real counts in the nav, taken deliberately
  // over polling or over a number that is only refreshed by luck.
  //
  // On ONE page these predicates have a second reader: `/staff/pedidos` counts
  // `submitted` and `bridge_failed` again for its own tab chips
  // (`staff/pedidos/page.tsx`, the `countQuery` note). Same request, separate
  // round — the queue's counts go out beside its guard, these go out after the
  // page has rendered — so the sidebar badge and the chip beside it can differ
  // by the milliseconds between the two. Both figures are real; neither is
  // stale by design. Unifying them behind one `cache()`d read is a recorded
  // follow-up, deliberately not done here.
  //
  // Its own `perfRun` for the same reason: the page's run called `end()` before
  // it rendered this shell, so a `perfStep` would be recorded into a line that
  // has already been printed (see the cache-slot note in `lib/perf.ts`). One
  // step for the three, because they go out together. Every staff request now
  // prints TWO `[perf]` lines — the page's and this one's — and that is the
  // intended shape, not a duplicate.
  //
  // The nuance in taking a run here: `perfRun` claims the request's cache slot
  // (`perf.ts:125`), so from this line on the slot points at THIS run rather
  // than the page's. Any `perfStep` later in the same render would land in it —
  // and `perf.end()` on the next line closes it, so that span would be recorded
  // into a printed line and silently dropped rather than falling back to
  // `standalone()`. Nothing does that today: the only production caller of
  // `perfStep` is `lib/auth/guards.ts`, which every page enters through BEFORE
  // it renders (its unit tests call it too), and Server Actions are separate
  // requests with slots of their own.
  const supabase = await createServerSupabase();
  const perf = perfRun("staff-shell");
  const [submittedResult, bridgeFailedResult, unavailableResult] =
    await perf.step(
      "counts",
      Promise.all([
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("status", "submitted"),
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("status", "bridge_failed"),
        supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("is_available", false),
      ]),
    );
  perf.end();

  // BACKLOG, not today: none of the three is date-filtered, which is why the
  // sidebar heads them 待办 and not the mockup's 今日. The today-scoped figures
  // belong to the dashboard's KPI strip.
  const counts: ShellCounts = {
    submitted: readShellCount("submitted", submittedResult),
    bridgeFailed: readShellCount("bridge failed", bridgeFailedResult),
    unavailable: readShellCount("unavailable", unavailableResult),
  };

  const sidebar = {
    locale,
    items,
    name: user.name,
    roleLabel,
    counts,
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
