import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { StaffShell } from "@/components/staff-shell";
import { ADMIN_CARD } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { groupAccountsByCompany } from "@/lib/company-accounts";
import { madridMonthStartIso } from "@/lib/orders";
import { perfRun } from "@/lib/perf";
import { scanRange, scanTruncated, scanWindowCount } from "@/lib/scan-windows";
import { readLoggedCount } from "@/lib/shell-counts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import {
  canManageStaff,
  canManageUsers,
  isStaffRole,
  isUserAdminError,
  USER_ADMIN_ERRORS,
  type StaffRole,
  type UserAdminError,
} from "@/lib/user-admin";
import { CreateCustomerForm, type CompanyOption } from "./create-customer-form";
import { CreateStaffForm } from "./create-staff-form";
import { CreateUserDialog } from "./create-user-dialog";
import { EditUserDialog, type EditAccountLabels } from "./edit-user-dialog";

export const dynamic = "force-dynamic";

/**
 * 客户 — the restaurants this portal serves, the logins that belong to each of
 * them, and the two forms that add to both.
 *
 * The list is COMPANY-first: one block per restaurant (its name, its `codcli`,
 * its tarifa, how many orders it has placed this month, whether it is switched
 * on) with its accounts nested under it. That is the mockup's clients screen
 * (`docs/design/dada-staff-admin.dc.html:370-424`) mapped onto what this portal
 * actually records — see the note over the customers card for the four columns
 * of that screen there is no data for.
 *
 * Everything on this page is read with the SERVICE-ROLE client, for two reasons
 * that have nothing to do with convenience:
 *
 * 1. RLS on `staff_users` is self-select only — a manager reading the staff list
 *    with their own session would see exactly one row, their own.
 * 2. Email addresses live in `auth.users`, which no session client can read at
 *    all. `auth.admin.listUsers` is the only way, and it needs the admin client.
 *
 * That client bypasses RLS entirely, so the gate is the two lines below it:
 * `requireStaff` (who, and still active) then `canManageUsers` (may they). The
 * redirect on failure is what makes the nav entry's absence honest — a plain
 * staff member who types the URL lands back on the staff home, and every action
 * behind the buttons repeats both checks for the POST that skipped the page.
 */

type CustomerCompany = Pick<
  Database["public"]["Tables"]["companies"]["Row"],
  "name" | "codcli" | "tarcli" | "is_active" | "notes"
>;

/**
 * One customer account, with its restaurant.
 *
 * `company_id` is read as a COLUMN as well as followed as an embed: it is the
 * key the month's order tally is grouped by, and the embedded object carries no
 * id of its own.
 *
 * The `| null` on the embed is this file's own widening and is kept
 * deliberately. `portal_users.company_id` is `not null references companies(id)`
 * (`0001_core.sql:24`), so supabase-js infers the embed non-null and no such row
 * can exist today; the page still groups one into a visible 无关联餐厅 block
 * rather than letting an account that can sign in fall out of the list. See
 * `CompanyGroup["id"]`.
 */
type CustomerRow = Pick<
  Database["public"]["Tables"]["portal_users"]["Row"],
  "id" | "display_name" | "is_active" | "company_id"
> & {
  companies: CustomerCompany | null;
};

type StaffRow = Pick<
  Database["public"]["Tables"]["staff_users"]["Row"],
  "id" | "display_name" | "is_active" | "role"
>;

/** The service-role client, for the scan below. */
type AdminSupabase = ReturnType<typeof createAdminClient>;

/**
 * What a figure that did not arrive looks like, everywhere on this page — the
 * staff home's own constant, for the same reason it has one.
 */
const DASH = "—";

/**
 * The internal hairlines of the three-cell stats strip, per cell.
 *
 * `divide-x` will not do it, for the reason the dashboard's `KPI_RULES` spells
 * out: Tailwind puts the rule on every child but the last, which is right for
 * the mockup's three-across but wrong for the stacked layout below `sm`, where
 * cells 1 and 2 want a rule ABOVE them and none at their left edge. Naming each
 * cell's rules draws both.
 */
const STAT_RULES = [
  "",
  "border-t sm:border-t-0 sm:border-l",
  "border-t sm:border-t-0 sm:border-l",
];

/**
 * A row on either card. The mockup's list rhythm: an `#F4F0EC` rule above every
 * row but the first of its block and the `#FCFBFA` admin wash on hover — the two
 * shades `/staff/productos` and `/staff/categorias` already draw lists with,
 * neither of them a token (both appear only where a list sits on white).
 *
 * Horizontal padding is NOT in here. The company header and the staff rows take
 * the card's own 18px; an ACCOUNT row is indented past the avatar instead, and
 * layering `pl-16` over a `px-[18px]` in the same class string would leave which
 * one wins to the order Tailwind happened to emit them in.
 */
const ROW =
  "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 text-sm transition-colors hover:bg-[#FCFBFA]";
/** The card's own gutter, for the rows that start at it. */
const ROW_X = "px-[18px]";

/** Active = the account can sign in; inactive is this app's delete. */
const BADGE = "whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs";
const BADGE_ON = `${BADGE} bg-green-100 text-green-800`;
const BADGE_OFF = `${BADGE} bg-amber-100 text-amber-800`;
/**
 * How many orders each restaurant has placed THIS MONTH, tallied in memory.
 *
 * ONE query for every company's figure — `select company_id` over this month's
 * orders — rather than a `head: true` count per company, which is one round trip
 * per row of the list below: this portal serves on the order of a hundred
 * restaurants, so on the order of a hundred requests to draw one page.
 *
 * It is a loop and not a single request because PostgREST caps every response at
 * `max_rows` (1000 — `supabase/config.toml:18`, and 1000 is the cloud default
 * the hosted project runs on too) whether or not the request asks for a limit: a
 * `.range(0, 4999)` over 2,300 orders comes back with 1000 rows, no error, and a
 * `Content-Range` of `0-999/2300`. So the scan walks windows of the cap until it
 * has covered the `count` the FIRST window reported — `scanWindowCount` is where
 * that arithmetic lives and is tested. **Today that is ONE window**: a month's
 * orders sit well inside one 1000-row window at this portal's volumes, so the
 * loop makes exactly one request — and that holds for ANY month under 1000
 * orders, which is the claim being made here rather than a counted figure. The
 * cap is silent, which is precisely why the loop is written before it is needed.
 *
 * `.order("id")` is what makes the windows mean anything. Two `OFFSET` reads of
 * an unordered table are two independent scans as far as Postgres is concerned:
 * they may hand back the same row twice and miss another entirely, so the tally
 * would come out DIFFERENT on every load. The primary key is stable, indexed and
 * never rewritten, so the windows are disjoint and the page is repeatable.
 *
 * **It fails CLOSED**, which is where it parts company with the categories
 * page's scan. There, a window that failed leaves counts that read LOW and the
 * list still says something true about what was read. Here a missing window does
 * not make a figure vague, it makes it WRONG in a specific way: a restaurant
 * whose orders all sat in the window that failed renders a confident `0 单`
 * beside its name. So any window error, a missing `Content-Range` on the first
 * window (without it the scan cannot know how many windows it owes) and a plan
 * capped by `MAX_SCAN_WINDOWS` all return `null`, and every row on the page then
 * draws an em dash instead of a number. The ceiling is checked on the FIRST
 * window, where the total is learned: a month past 10,000 orders is refused
 * before the other nine requests are issued rather than after, since their rows
 * are going to be thrown away either way.
 *
 * None of those three branches has a unit test, and that is the precedent
 * `/staff/categorias` set for its own inline scan: testing a loop written
 * against the supabase client means mocking the client, which pins the mock and
 * not the page, so the loops are verified on a fixture render instead — while
 * the arithmetic that could actually be wrong, the window count and the
 * ceiling, has its own table in `scan-windows.test.ts`.
 *
 * Cancelled orders are IN the tally: 本月单量 counts what the restaurant placed,
 * and an order they cancelled was still placed. No status filter, therefore no
 * argument about which of the seven states counts.
 */
async function scanMonthOrders(
  admin: AdminSupabase,
): Promise<Map<string, number> | null> {
  // ONE boundary for the whole scan, read once: a render that crosses midnight
  // on the 1st with the clock inside the loop would count its later windows
  // against a different month.
  const monthStart = madridMonthStartIso(new Date());
  const tally = new Map<string, number>();
  // One, until the first response says how many are really needed. Bounded by
  // `MAX_SCAN_WINDOWS` inside `scanWindowCount`, so this cannot run away.
  let windows = 1;

  for (let index = 0; index < windows; index++) {
    const { from, to } = scanRange(index);
    const { data, error, count } = await admin
      .from("orders")
      .select("company_id", { count: "exact" })
      .gte("created_at", monthStart)
      .order("id")
      .range(from, to);
    if (error) {
      console.error("staff users month order scan:", error);
      return null;
    }
    for (const row of data ?? []) {
      tally.set(row.company_id, (tally.get(row.company_id) ?? 0) + 1);
    }
    if (index === 0) {
      if (count === null) {
        // A successful `count: "exact"` response ALWAYS carries a
        // `Content-Range`; its absence means something stripped the header, and
        // this scan's stopping rule is read from it. Same decision `readCount`
        // makes for the counts above, for the same reason.
        console.error(
          "staff users month order scan: no content-range on the first window",
        );
        return null;
      }
      // Checked HERE, on the window that learned the total, and not after the
      // loop: a plan past the ceiling ends in `null` whatever the other windows
      // come back with, so asking for them is nine round trips spent filling a
      // tally that is about to be thrown away. Before the window count is even
      // computed — an assignment the ceiling makes dead would be noise.
      if (scanTruncated(count)) {
        console.error(
          `staff users month order scan: ${count} orders this month is past the window ceiling`,
        );
        return null;
      }
      windows = scanWindowCount(count);
    }
  }

  return tally;
}

export default async function StaffUsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { locale } = await params;
  const { result: rawResult } = await searchParams;
  setRequestLocale(locale);
  const perf = perfRun(`/${locale}/staff/usuarios`);
  // Sequential on purpose, as on `/staff/productos`: every read below is on the
  // SERVICE-ROLE client, which answers without RLS. Racing those against the
  // guard the way the session-client pages do would run them for a caller the
  // guard is about to refuse, so they wait for both gates to have returned.
  const { user, staffUser } = await requireStaff(locale);
  if (!canManageUsers(staffUser.role)) redirect(`/${locale}/staff`);
  const owner = canManageStaff(staffUser.role);

  const t = await getTranslations("staff.users");
  // Only for the shell's breadcrumb, which speaks the sidebar's vocabulary — the
  // same 客户 this page is now titled, since decision 7 relabelled both.
  const tStaff = await getTranslations("staff");
  // The eye toggle's two labels are the login page's; the same control, so the
  // same words rather than a second pair to keep in step.
  const tLogin = await getTranslations("login");

  // The actions redirect with `?result=<CODE>`. The parameter is user-editable,
  // so it is proved to be one of the known codes BEFORE it is used as a message
  // key — a raw value would render as whatever the URL said.
  const raw = rawResult ?? "";
  const result: "ok" | UserAdminError | null =
    raw === "ok" || isUserAdminError(raw) ? raw : null;

  const admin = createAdminClient();

  // Everything this page knows, in ONE round: seven requests for an owner (six
  // for a manager, who is not shown the staff list), and the month scan adds a
  // window only past its first 1000 orders. The addresses used to be fetched on
  // a line of their own ABOVE the row queries, which cost the page a whole trip
  // to GoTrue before the first of them could start — and it never needed to: the
  // account lists and the address book have nothing to say to each other until
  // both are in hand.
  //
  // One call for every address, then a map: the two lists below hold `auth.uid`s
  // and nothing else, and a lookup per row would be a request per row. 1000 is
  // GoTrue's own ceiling for a page and some hundreds of times this deployment's
  // account count; a bigger tenant would need the pager, not a bigger number.
  //
  // The two COUNTS are their own reads rather than lengths of the lists beside
  // them, and that is the dashboard's rule applied here: a folded count shares
  // its list's fate, and a figure whose whole job is to be trusted when the list
  // is empty must be able to survive the list. It also keeps them honest past
  // 1000 rows — both lists are capped by PostgREST exactly as the scan above
  // describes, so `companies.length` would quietly stop growing while the real
  // number kept going.
  const [
    { data: authList, error: authError },
    customerResult,
    staffResult,
    companyResult,
    [companyCountResult, accountCountResult],
    monthTally,
  ] = await Promise.all([
    perf.step("authUsers", admin.auth.admin.listUsers({ perPage: 1000 })),
    admin
      .from("portal_users")
      .select(
        // `notes` rides the ADMIN client only — the column is revoked from
        // authenticated (CLAUDE.md), and this is the one page that may read it:
        // its first ` | ` segment is the restaurant's REAL name (the bulk
        // import of 2026-08-20 wrote `真名 | 法人 | CIF` there, with the code
        // as `companies.name`), which is the table's 公司 column.
        "id, display_name, is_active, company_id, companies:company_id(name, codcli, tarcli, is_active, notes)",
      )
      .order("created_at"),
    // Owner only, and read only when the section that shows it will be drawn.
    // RLS on `staff_users` is self-select, so this list only exists at all
    // because the admin client bypasses it — reading rows a manager may not see
    // and then hiding them in the markup would make that bypass the only thing
    // standing between them and the list.
    owner
      ? admin
          .from("staff_users")
          .select("id, display_name, is_active, role")
          .order("created_at")
      : Promise.resolve(null),
    // Owners need the complete company set when repairing an existing account;
    // the create form below still receives only active choices.
    admin
      .from("companies")
      .select("id, name, codcli, is_active")
      .order("name"),
    perf.step(
      "counts",
      Promise.all([
        // 合作餐厅 and 已启用账号, both `head: true` — no row comes back, only the
        // `Content-Range` count. The select list names one real column each,
        // never `*`.
        admin
          .from("companies")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true),
        admin
          .from("portal_users")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true),
      ]),
    ),
    perf.step("monthOrders", scanMonthOrders(admin)),
  ]);
  perf.end();
  if (authError) console.error("staff users listUsers:", authError);
  const emails = new Map<string, string>();
  for (const authUser of authList?.users ?? []) {
    if (authUser.email) emails.set(authUser.id, authUser.email);
  }
  for (const [what, error] of [
    ["portal_users", customerResult.error],
    ["staff_users", staffResult?.error],
    ["companies", companyResult.error],
  ] as const) {
    // A failed read renders the same empty list as no rows; the reason belongs
    // in the server log, not on the screen of somebody creating an account.
    if (error) console.error(`staff users ${what} query:`, error);
  }
  const customers: CustomerRow[] = customerResult.data ?? [];
  const staff: StaffRow[] = staffResult?.data ?? [];
  const allCompanies = companyResult.data ?? [];
  const companies: CompanyOption[] = allCompanies.filter(
    (company) => company.is_active,
  );

  // Both counts read and logged by the shared half (`lib/shell-counts.ts`),
  // which prints `staff users <name> count (status <n>)` — the scope string is
  // the same "staff users" the query logs above use. `null` reaches the strip
  // as an em dash, never as 0: a count that did not arrive must not be able to
  // tell a manager this portal has no restaurants on it.
  const activeCompanies = readLoggedCount(
    "staff users",
    "active companies",
    companyCountResult,
  );
  const activeAccounts = readLoggedCount(
    "staff users",
    "active accounts",
    accountCountResult,
  );

  /**
   * This month's orders for one restaurant. `0` is a real answer — the tally
   * simply has no entry for a restaurant that has not ordered — and `null` means
   * the scan itself could not be trusted, which the row draws as an em dash.
   */
  const monthCountOf = (companyId: string): number | null =>
    monthTally === null ? null : (monthTally.get(companyId) ?? 0);

  /**
   * 本月下单客户: how many of the ACTIVE restaurants ordered this month.
   *
   * The tally's own key count is not that figure. Its keys are every company
   * that placed an order since the 1st, deactivated ones included — switching a
   * restaurant off does not unplace the orders it made on the 3rd — while
   * 合作餐厅 in the cell beside it counts active companies only. Left as
   * `monthTally.size` the pair could print a numerator larger than its
   * denominator, and the two cells would be answering different questions in
   * the same row of the same strip. Intersecting with the active ids the page
   * has already read makes it a fraction again, which is what the mockup's own
   * sub-line was (`:375` — 86 家餐厅 · 本月下单 62 家).
   *
   * So a restaurant deactivated AFTER it ordered this month is left out, BY
   * DESIGN: this cell answers "how many of the restaurants we serve ordered
   * this month", and one we have switched off is not one of them. Its orders
   * are still in the tally and still on its own row's 本月单量, which is a
   * different question and keeps its answer.
   *
   * It now depends on TWO reads, so it dashes when EITHER of them failed — the
   * scan, as every row does, and the companies list. A half-known intersection
   * is not a small number, it is an unknown one: printing it would tell a
   * manager that fewer restaurants ordered than really did, in exactly the
   * confident-looking way the em dash exists to prevent.
   *
   * The list is capped at 1000 rows like every read on this page, so past a
   * thousand ACTIVE restaurants this would drift under the count beside it —
   * the same "far inside one window" the scan above rests on, and it would want
   * the same windowing on the day it stops being true.
   */
  const monthCustomers =
    monthTally === null || companyResult.error
      ? null
      : companies.filter((company) => monthTally.has(company.id)).length;

  /** What to call an account in a label: their name, else the address, else the id. */
  const nameOf = (id: string, displayName: string | null) =>
    displayName ?? emails.get(id) ?? id;

  /** A role read from a text column, labelled only when it is one we know. */
  const roleLabel = (role: string) =>
    isStaffRole(role) ? t(`roles.${role}`) : role;

  const roleLabels: Record<StaffRole, string> = {
    staff: t("roles.staff"),
    manager: t("roles.manager"),
    owner: t("roles.owner"),
  };

  const formLabels = {
    email: t("email"),
    password: t("password"),
    passwordHint: t("passwordHint"),
    displayName: t("displayName"),
    submit: t("submit"),
    showPassword: tLogin("showPassword"),
    hidePassword: tLogin("hidePassword"),
  };

  // A rejected create answers the FORM with a code instead of redirecting, so
  // the forms need the same sentences this page's banner uses. Built from the
  // closed list rather than a handful of literals: a new code gets a message
  // here the moment it exists, exactly as `messages.test.ts` requires.
  const errorLabels = Object.fromEntries(
    USER_ADMIN_ERRORS.map((code) => [code, t(`results.${code}`)]),
  ) as Record<UserAdminError, string>;

  const editLabels: EditAccountLabels = {
    edit: t("edit"),
    editFor: t("editFor", { name: "" }),
    title: t("editTitle"),
    close: t("closeDialog"),
    email: t("email"),
    displayName: t("displayName"),
    company: t("company"),
    role: t("role"),
    status: t("colStatus"),
    active: t("active"),
    inactive: t("inactive"),
    save: t("saveAccount"),
    passwordTitle: t("passwordTitle"),
    password: t("password"),
    confirmPassword: t("confirmPassword"),
    passwordHint: t("passwordHint"),
    savePassword: t("savePassword"),
    showPassword: tLogin("showPassword"),
    hidePassword: tLogin("hidePassword"),
    saving: t("saving"),
    results: { ok: t("results.ok"), ...errorLabels },
  };

  const editCompanies = allCompanies.map((company) => ({
    id: company.id,
    label: `${company.name}${company.is_active ? "" : ` · ${t("companyInactive")}`}`,
  }));

  /**
   * The accounts, under their restaurants. Ordered by NAME through the reader's
   * own collator — `Intl.Collator("zh-CN")` sorts 海鲜楼 by pinyin and the es one
   * puts «Ñam» where a Spanish reader looks for it, where a bare `<` would sort
   * both by UTF-16 code point. The accounts inside each block keep the read's
   * `created_at` order.
   */
  const collator = new Intl.Collator(locale === "zh" ? "zh-CN" : "es-ES");
  const groups = groupAccountsByCompany(customers, collator.compare);

  /**
   * The three figures over the list. Every one of them is a real read, and every
   * one dashes on its own: an em dash says "this number did not arrive", where a
   * 0 computed from a failed read is a sentence about the business that happens
   * to be false.
   */
  const stats: { key: string; label: string; value: number | null }[] = [
    { key: "companies", label: t("statCompanies"), value: activeCompanies },
    { key: "month", label: t("statMonthActive"), value: monthCustomers },
    { key: "accounts", label: t("statActiveAccounts"), value: activeAccounts },
  ];

  return (
    <StaffShell
      locale={locale}
      title={t("title")}
      breadcrumb={tStaff("nav.users")}
      user={{
        name: staffUser.display_name ?? staffUser.id,
        role: staffUser.role,
      }}
    >
      {result && (
        <p
          role={result === "ok" ? "status" : "alert"}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            result === "ok"
              ? "bg-green-50 text-green-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {t(`results.${result}`)}
        </p>
      )}

      {/* ＋新建用户, at the TOP, opening the modal that now holds both create
          forms. The mockup drew this button and the first build refused it —
          "a button whose only honest behaviour is to scroll down is a button
          that lies" — because the forms lived at the card feet. The owner then
          worked the page with thirty-three restaurants in it (2026-08-20) and
          the feet were a scroll marathon; the modal is what makes the button
          honest: the form comes to it. The forms themselves are unchanged and
          server-composed here; the dialog only chooses between them. */}
      <div className="mt-[18px] flex justify-end">
        <CreateUserDialog
          labels={{
            trigger: t("createUser"),
            title: t("createUser"),
            typeCustomer: t("createCustomer"),
            typeStaff: t("createStaff"),
            close: t("closeDialog"),
          }}
          customerForm={
            <CreateCustomerForm
              locale={locale}
              companies={companies}
              errorLabels={errorLabels}
              labels={{
                ...formLabels,
                company: t("company"),
                companyExisting: t("companyExisting"),
                companyExistingHint: t("companyExistingHint"),
                companyNew: t("companyNew"),
                companyNewHint: t("companyNewHint"),
                companyPick: t("companyPick"),
                companyName: t("companyName"),
                codcli: t("codcli"),
                codcliHint: t("codcliHint"),
                tarcli: t("tarcli"),
                noCompanies: t("noCompanies"),
              }}
            />
          }
          staffForm={
            owner ? (
              <CreateStaffForm
                locale={locale}
                labels={{ ...formLabels, role: t("role") }}
                roleLabels={roleLabels}
                errorLabels={errorLabels}
              />
            ) : undefined
          }
        />
      </div>

      {/* ONE card holding three cells with internal rules, per the mockup's own
          `repeat(3,1fr)` strip (`:383-390`); `overflow-hidden` is what keeps
          those rules inside the 12px radius. Stacked below `sm`, where three
          26px figures would be three ~110px columns and «Clientes con pedidos
          este mes» would wrap four times inside one.

          The mockup's sub-line under the title (`:375` — 86 家餐厅 · 本月下单 62
          家) is NOT drawn: it is these first two figures in a sentence, and a
          page that prints the same two numbers twice has two places to disagree
          with itself the day one read fails.

          The mockup's THIRD cell is 月结客户 (`:652`) — how many restaurants are
          on monthly settlement, the same 月结/现结 nothing in this schema
          records, which is why the 结算 column is missing from the list below
          too. 已启用账号 has that slot instead: it is the other number this page
          is about, and it is one this portal can actually answer. */}
      <div
        className={`${ADMIN_CARD} mt-3 grid grid-cols-1 overflow-hidden sm:grid-cols-3`}
      >
        {stats.map((stat, index) => (
          <div
            key={stat.key}
            className={`flex flex-col gap-2 border-[#EDE9E5] p-5 ${
              // `?? ""` and not a bare index: a fourth stat would index past the
              // array and render `class="undefined"` on the cell.
              STAT_RULES[index] ?? ""
            }`}
          >
            {/* The mockup's `#79726B` label → `text-ink-soft`, the mapping the
                dashboard's KPI strip records in full. */}
            <p className="text-[12.5px] text-ink-soft">{stat.label}</p>
            <p className="font-num text-[26px] font-bold leading-none tabular-nums">
              {stat.value === null ? (
                // Roughly two thirds of the figure's size (18 of 26), as on the
                // dashboard (24 of 34): an em dash at full size is a black bar
                // that reads as a redaction rather than as "we do not know".
                // `leading-none` above keeps the line box 26px either way, so a
                // dashed cell is exactly as tall as its neighbours.
                <span className="text-[18px] text-muted">{DASH}</span>
              ) : (
                stat.value
              )}
            </p>
          </div>
        ))}
      </div>

      {/* The account book, grouped by restaurant. FOUR of the mockup's seven
          columns are not drawn, and none of them for want of space (decision 3):
          门店 (the cell `:405`, its header `:394`) — there is no store concept,
          one company is one customer number; 联系人 + 电话 (`:406-409`) — the
          real contacts ARE the portal accounts, so they are the rows nested
          under each restaurant instead of a name in a cell; 结算 (`:414`) —
          月结/现结 is not recorded anywhere; and 代下单 / 详情 (`:416-419`) —
          neither exists. Its ＋新建客户 button (`:379`; the 导出名单 to its left
          is `:378`) IS drawn now, as the page-top ＋新建用户 — the first build
          refused it while the form lived at this card's foot ("a button whose
          only honest behaviour is to scroll down lies about being one"), and
          the modal is what changed the verdict: the form comes to the button.

          This is an ACCOUNT list grouped by restaurant, not a company list: it
          is built from `portal_users`, so a company with no account yet never
          appears here at all. Those are exactly the companies the ＋新建用户
          dialog's 「挂到已有公司」 select offers — that select reads
          `companies` directly, which is where a restaurant with no login is
          visible. */}
      <section className={`${ADMIN_CARD} mt-[18px]`}>
        <h2 className="border-b border-[#EDE9E5] px-[18px] py-4 text-[15px] font-bold">
          {/* 客户账号 / «Cuentas de cliente», unchanged. The PAGE is now titled
              客户 (decision 7), and renaming this header to 合作餐厅 would
              promise a book of restaurants — which this is not, per the note
              above. */}
          {t("customersTitle")}
        </h2>

        {groups.length === 0 ? (
          <p className="px-[18px] py-6 text-[13px] text-muted">
            {t("noCustomers")}
          </p>
        ) : (
          // A TABLE, one row per restaurant — the owner's call (2026-08-20
          // round two): the stacked company-row-plus-account-row shape spent
          // two full-width lines on every restaurant, and with thirty-three of
          // them the book stopped fitting a screen. The common case (one
          // account per restaurant) is now ONE row carrying everything; only a
          // restaurant with a second login grows extra rows, which show just
          // the account half over blank company cells — the blank IS the
          // grouping, the way a ledger repeats nothing.
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[#EDE9E5] text-left text-[11.5px] text-ink-soft">
                  <th className="py-2.5 pl-[18px] pr-3 font-medium">
                    {t("colCode")}
                  </th>
                  <th className="px-3 py-2.5 font-medium">{t("colCompany")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("colCodcli")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("colEmail")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("colTarifa")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    {t("colMonth")}
                  </th>
                  <th className="px-3 py-2.5 font-medium">{t("colStatus")}</th>
                  {/* Named for a screen reader, silent on screen — the repo's
                      standing colActions convention. */}
                  <th className="py-2.5 pl-3 pr-[18px]">
                    <span className="sr-only">{t("colActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.flatMap((group) => {
                  const company = group.company;
                  const name = company?.name ?? t("noCompany");
                  const month =
                    group.id === null ? null : monthCountOf(group.id);
                  // The restaurant's REAL name, from the notes convention the
                  // bulk import wrote (`真名 | 法人 | CIF`). A company created
                  // by hand may have no notes — the cell dashes, it does not
                  // guess.
                  const realName =
                    company?.notes?.split(" | ")[0]?.trim() || null;
                  return group.accounts.map((row, index) => {
                    const accountName = nameOf(row.id, row.display_name);
                    const email = emails.get(row.id) ?? DASH;
                    const first = index === 0;
                    return (
                      <tr
                        key={row.id}
                        // A restaurant's rows open with the card-rule shade;
                        // its extra account rows with the lighter row rule —
                        // the two-tone hairline is what still groups them now
                        // that indentation is gone.
                        className={`border-t ${
                          first ? "border-[#EDE9E5]" : "border-[#F4F0EC]"
                        } align-middle transition-colors hover:bg-[#FCFBFA]`}
                      >
                        {first ? (
                          <>
                            <td className="py-2.5 pl-[18px] pr-3">
                              <span className="text-[13.5px] font-semibold">
                                {name}
                              </span>
                              {company && !company.is_active && (
                                /* 公司已停用, once, on the thing that was
                                   switched off — a live account under it still
                                   cannot sign in (`requireCompanyUser` refuses
                                   both). */
                                <span className={`ml-2 ${BADGE_OFF}`}>
                                  {t("companyInactive")}
                                </span>
                              )}
                            </td>
                            <td
                              className="max-w-64 truncate px-3 py-2.5"
                              // The full name survives the ellipsis under the
                              // pointer.
                              title={realName ?? undefined}
                            >
                              {realName ?? DASH}
                            </td>
                            <td className="px-3 py-2.5 font-num tabular-nums">
                              {company?.codcli ?? DASH}
                            </td>
                          </>
                        ) : (
                          // The company half, blank on purpose: repeating the
                          // code on every login row would make two logins read
                          // as two restaurants. Empty, not omitted — the cells
                          // keep the columns aligned.
                          <td colSpan={3} className="py-2 pl-[18px]" />
                        )}
                        <td className="max-w-72 px-3 py-2.5">
                          <span className="block truncate">{email}</span>
                          {/* The display name only when it adds something the
                              code column has not already said. */}
                          {accountName !== name && (
                            <span className="block truncate text-xs text-muted">
                              {accountName}
                            </span>
                          )}
                        </td>
                        {first ? (
                          <>
                            <td
                              className="px-3 py-2.5 font-num text-[12.5px] text-ink-soft"
                              title={t("tarcli")}
                            >
                              {company ? `T${company.tarcli}` : DASH}
                            </td>
                            <td className="px-3 py-2.5 text-right font-num font-semibold tabular-nums">
                              {month ?? DASH}
                            </td>
                          </>
                        ) : (
                          <td colSpan={2} />
                        )}
                        <td className="px-3 py-2.5">
                          <span
                            className={row.is_active ? BADGE_ON : BADGE_OFF}
                          >
                            {row.is_active ? t("active") : t("inactive")}
                          </span>
                        </td>
                        <td className="py-2.5 pl-3 pr-[18px] text-right">
                          {owner && (
                            <EditUserDialog
                              locale={locale}
                              account={{
                                id: row.id,
                                kind: "customer",
                                email: emails.get(row.id) ?? "",
                                displayName: row.display_name ?? "",
                                active: row.is_active,
                                companyId: row.company_id,
                              }}
                              companies={editCompanies}
                              roleLabels={roleLabels}
                              labels={{
                                ...editLabels,
                                editFor: t("editFor", { name: accountName }),
                              }}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Owner only — the whole 超级管理员 half of the page, form included. A
          manager never sees that staff accounts exist here, and
          `createStaffAccount` / `setStaffRole` refuse them regardless. The
          mockup has no such card (decision 4 keeps it); only its shell and row
          metrics are the admin ones now. */}
      {owner && (
        <section className={`${ADMIN_CARD} mt-[18px]`}>
          <h2 className="border-b border-[#EDE9E5] px-[18px] py-4 text-[15px] font-bold">
            {t("staffTitle")}
          </h2>

          {staff.length === 0 ? (
            <p className="px-[18px] py-6 text-[13px] text-muted">
              {t("noStaff")}
            </p>
          ) : (
            <ul>
              {staff.map((row) => {
                const name = nameOf(row.id, row.display_name);
                // The lockout guard, drawn: an owner who demotes or deactivates
                // their own row removes the only account that could undo it, and
                // `assertNotSelf` refuses it server-side anyway.
                const self = row.id === user.id;
                return (
                  <li
                    key={row.id}
                    className={`${ROW} ${ROW_X} border-t border-[#F4F0EC] first:border-t-0`}
                  >
                    {/* Same 120px floor as the account rows, and this row needs
                        it more: it carries a role select and two buttons. */}
                    <div className="min-w-30 flex-1">
                      <p className="truncate text-[13px] font-semibold">
                        {name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {emails.get(row.id) ?? DASH} · {roleLabel(row.role)}
                      </p>
                    </div>

                    <span className={row.is_active ? BADGE_ON : BADGE_OFF}>
                      {row.is_active ? t("active") : t("inactive")}
                    </span>

                    {/* Said out loud, because the `title`s below cannot say it:
                        a browser suppresses the tooltip of a DISABLED control,
                        so on this row the greyed-out select and buttons would
                        otherwise explain themselves to nobody. */}
                    {self && (
                      <span className="text-xs text-muted">{t("selfRow")}</span>
                    )}

                    {!self && isStaffRole(row.role) && (
                      <EditUserDialog
                        locale={locale}
                        account={{
                          id: row.id,
                          kind: "staff",
                          email: emails.get(row.id) ?? "",
                          displayName: row.display_name ?? "",
                          active: row.is_active,
                          role: row.role,
                        }}
                        companies={editCompanies}
                        roleLabels={roleLabels}
                        labels={{
                          ...editLabels,
                          editFor: t("editFor", { name }),
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

        </section>
      )}
    </StaffShell>
  );
}
