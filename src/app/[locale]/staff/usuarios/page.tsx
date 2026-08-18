import type { Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { setStaffRole, setUserActive } from "@/app/actions/staff-users";
import { StaffShell } from "@/components/staff-shell";
import { BTN_QUIET, CARD, FIELD_SM } from "@/components/ui";
import { requireStaff } from "@/lib/auth/guards";
import { perfRun } from "@/lib/perf";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import {
  canManageStaff,
  canManageUsers,
  isStaffRole,
  isUserAdminError,
  STAFF_ROLES,
  USER_ADMIN_ERRORS,
  type StaffRole,
  type UserAdminError,
} from "@/lib/user-admin";
import { CreateCustomerForm, type CompanyOption } from "./create-customer-form";
import { CreateStaffForm } from "./create-staff-form";

export const dynamic = "force-dynamic";

/**
 * 用户管理 — the back office's account list and the two forms that add to it.
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

type CustomerRow = Pick<
  Database["public"]["Tables"]["portal_users"]["Row"],
  "id" | "display_name" | "is_active"
> & {
  companies: Pick<
    Database["public"]["Tables"]["companies"]["Row"],
    "name" | "codcli" | "tarcli" | "is_active"
  > | null;
};

type StaffRow = Pick<
  Database["public"]["Tables"]["staff_users"]["Row"],
  "id" | "display_name" | "is_active" | "role"
>;

/**
 * One account. The hover tint is the admin-table density the rest of the back
 * office now reads with; `-mx-2 px-2` is what lets it reach past the text
 * column instead of stopping at it.
 */
const ROW =
  "-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-white/50";

/** Active = the account can sign in; inactive is this app's delete. */
const BADGE = "rounded-md px-1.5 py-0.5 text-xs";
const BADGE_ON = `${BADGE} bg-green-100 text-green-800`;
const BADGE_OFF = `${BADGE} bg-amber-100 text-amber-800`;
/** The row controls, which the actor's own row renders disabled. */
const ROW_BTN = `${BTN_QUIET} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-ink`;

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
  // Only for the shell's breadcrumb, which speaks the sidebar's short vocabulary
  // (用户) rather than this page's own heading (用户管理).
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

  // Four reads, one round trip. The addresses used to be fetched on a line of
  // their own ABOVE the other three, which cost the page a whole trip to GoTrue
  // before the first row query could start — and it never needed to: the account
  // lists and the address book have nothing to say to each other until both are
  // in hand.
  //
  // One call for every address, then a map: the two lists below hold `auth.uid`s
  // and nothing else, and a lookup per row would be a request per row. 1000 is
  // GoTrue's own ceiling for a page and some hundreds of times this deployment's
  // account count; a bigger tenant would need the pager, not a bigger number.
  const [
    { data: authList, error: authError },
    customerResult,
    staffResult,
    companyResult,
  ] = await Promise.all([
    perf.step("authUsers", admin.auth.admin.listUsers({ perPage: 1000 })),
    admin
      .from("portal_users")
      .select(
        "id, display_name, is_active, companies:company_id(name, codcli, tarcli, is_active)",
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
    // Only active companies are offered to a NEW account: a login under a
    // deactivated company is refused at `requireCompanyUser` anyway.
    admin
      .from("companies")
      .select("id, name, codcli")
      .eq("is_active", true)
      .order("name"),
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
  const companies: CompanyOption[] = companyResult.data ?? [];

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

      <section className={`${CARD} mt-6 p-5`}>
        <h2 className="font-medium">{t("customersTitle")}</h2>

        {customers.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noCustomers")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {customers.map((row) => {
              const name = nameOf(row.id, row.display_name);
              return (
                <li key={row.id} className={ROW}>
                  {/* The truncating column holds only text: a badge inside it
                      would be the first thing an ellipsis eats. */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{name}</p>
                    <p className="truncate text-xs text-muted">
                      {emails.get(row.id) ?? "—"}
                      {row.companies ? ` · ${row.companies.name}` : ""}
                      {row.companies?.codcli == null
                        ? ""
                        : ` · ${row.companies.codcli}`}
                      {row.companies ? ` · T${row.companies.tarcli}` : ""}
                    </p>
                  </div>

                  <span className={row.is_active ? BADGE_ON : BADGE_OFF}>
                    {row.is_active ? t("active") : t("inactive")}
                  </span>
                  {/* A live account under a switched-off company still cannot
                      sign in — `requireCompanyUser` refuses both. Saying so here
                      saves a support call about a login that "works". */}
                  {row.companies && !row.companies.is_active && (
                    <span className={BADGE_OFF}>{t("companyInactive")}</span>
                  )}

                  <form action={setUserActive}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="kind" value="customer" />
                    <input type="hidden" name="user_id" value={row.id} />
                    <input
                      type="hidden"
                      name="active"
                      value={row.is_active ? "0" : "1"}
                    />
                    <button
                      type="submit"
                      // One 停用 per row would tell a screen reader nothing
                      // about which account it belongs to.
                      aria-label={
                        row.is_active
                          ? t("deactivateFor", { name })
                          : t("activateFor", { name })
                      }
                      className={ROW_BTN}
                    >
                      {row.is_active ? t("deactivate") : t("activate")}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-5 border-t border-border pt-4">
          <h3 className="font-medium">{t("createCustomer")}</h3>
          <CreateCustomerForm
            locale={locale}
            companies={companies}
            errorLabels={errorLabels}
            labels={{
              ...formLabels,
              company: t("company"),
              companyExisting: t("companyExisting"),
              companyNew: t("companyNew"),
              companyName: t("companyName"),
              codcli: t("codcli"),
              tarcli: t("tarcli"),
              noCompanies: t("noCompanies"),
            }}
          />
        </div>
      </section>

      {/* Owner only — the whole 超级管理员 half of the page, form included. A
          manager never sees that staff accounts exist here, and
          `createStaffAccount` / `setStaffRole` refuse them regardless. */}
      {owner && (
        <section className={`${CARD} mt-6 p-5`}>
          <h2 className="font-medium">{t("staffTitle")}</h2>

          {staff.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t("noStaff")}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {staff.map((row) => {
                const name = nameOf(row.id, row.display_name);
                // The lockout guard, drawn: an owner who demotes or deactivates
                // their own row removes the only account that could undo it, and
                // `assertNotSelf` refuses it server-side anyway.
                const self = row.id === user.id;
                return (
                  <li key={row.id} className={ROW}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{name}</p>
                      <p className="truncate text-xs text-muted">
                        {emails.get(row.id) ?? "—"} · {roleLabel(row.role)}
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

                    <form
                      action={setStaffRole}
                      className="flex items-center gap-1"
                    >
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="user_id" value={row.id} />
                      <select
                        name="role"
                        defaultValue={row.role}
                        disabled={self}
                        aria-label={t("roleFor", { name })}
                        title={self ? t("self") : undefined}
                        className={`${FIELD_SM} disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {STAFF_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {roleLabels[role]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        disabled={self}
                        aria-label={t("saveRoleFor", { name })}
                        title={self ? t("self") : undefined}
                        className={ROW_BTN}
                      >
                        {t("saveRole")}
                      </button>
                    </form>

                    <form action={setUserActive}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="kind" value="staff" />
                      <input type="hidden" name="user_id" value={row.id} />
                      <input
                        type="hidden"
                        name="active"
                        value={row.is_active ? "0" : "1"}
                      />
                      <button
                        type="submit"
                        disabled={self}
                        aria-label={
                          row.is_active
                            ? t("deactivateFor", { name })
                            : t("activateFor", { name })
                        }
                        title={self ? t("self") : undefined}
                        className={ROW_BTN}
                      >
                        {row.is_active ? t("deactivate") : t("activate")}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-5 border-t border-border pt-4">
            <h3 className="font-medium">{t("createStaff")}</h3>
            <CreateStaffForm
              locale={locale}
              labels={{ ...formLabels, role: t("role") }}
              roleLabels={roleLabels}
              errorLabels={errorLabels}
            />
          </div>
        </section>
      )}
    </StaffShell>
  );
}
