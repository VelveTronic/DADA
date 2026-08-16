"use server";

import { hasLocale } from "next-intl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routing } from "@/i18n/routing";
import { requireStaff } from "@/lib/auth/guards";
import { isUuid } from "@/lib/orders";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  assertNotSelf,
  canManageStaff,
  canManageUsers,
  classifyCreateUserError,
  classifyDbError,
  describeDbError,
  parseStaffRole,
  parseUserKind,
  validateNewCustomer,
  validateNewStaff,
  type NewCustomerInput,
  type NewStaffInput,
  type UserAdminError,
} from "@/lib/user-admin";

/**
 * Account administration: the only writes in this app that need the
 * service-role key, because `auth.admin.createUser` exists nowhere else.
 *
 * That key bypasses RLS completely, so the database has no say left once these
 * functions start. Every one of them therefore does the same three things in
 * the same order before touching the admin client:
 *
 *   requireStaff(locale)  → who is asking, and are they still active
 *   canManage*(role)      → may they do THIS (pure, tested, in user-admin.ts)
 *   validate…(formData)   → is the request even well-formed
 *
 * A Server Action is its own POST endpoint, reachable by anyone who learns the
 * action id without ever rendering `/staff/usuarios`, which is why the role gate
 * is repeated here rather than left to the page that hides the buttons.
 *
 * The PASSWORD rule, which every line below respects: it goes from the form to
 * `auth.admin.createUser` and nowhere else. Not into a log line, not into a
 * thrown error's message, not into the redirect, not into anything
 * `revalidatePath` will re-render. The result of an action is a CODE.
 */

/** The locale arrives in a form field, so it is never trusted as a path segment. */
function safeLocale(value: FormDataEntryValue | null) {
  const candidate = String(value ?? routing.defaultLocale);
  return hasLocale(routing.locales, candidate)
    ? candidate
    : routing.defaultLocale;
}

/** Back to the page, carrying the one word it needs to draw a banner. */
function usuariosHref(locale: string, result: "ok" | UserAdminError): string {
  return `/${locale}/staff/usuarios?result=${result}`;
}

/**
 * How every action ends: revalidate, then redirect with the outcome — the same
 * convention `staff-orders.ts` uses for its `rpcResult` parameter.
 *
 * The redirect is what keeps a password out of the browser's back-forward
 * cache and out of a resubmission: the POST body dies with the 303, and the
 * page that renders next was built from a fresh read, not from the form.
 *
 * Returns `never` because `redirect()` works by THROWING NEXT_REDIRECT — which
 * is also why no caller may put this inside a try/catch that swallows errors.
 */
function finish(locale: string, result: "ok" | UserAdminError): never {
  revalidatePath(`/${locale}/staff/usuarios`);
  redirect(usuariosHref(locale, result));
}

/**
 * A failed step of a half-built account, carrying the code the UI will show.
 *
 * Thrown only inside `provisionAccount`, to jump from any step to the one
 * rollback path. Its message is built from the DATABASE's error, never from the
 * submitted input.
 */
class ProvisionFailure extends Error {
  constructor(
    readonly code: UserAdminError,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionFailure";
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

type ProvisionRequest =
  | { kind: "customer"; input: NewCustomerInput }
  | { kind: "staff"; input: NewStaffInput };

/**
 * Create the auth user, then the row that gives it a role — and undo both if the
 * second half fails.
 *
 * The two halves live in different systems (GoTrue's `auth.users` and our
 * `public` tables) with no transaction spanning them, so a failed insert leaves
 * an auth user that can log in and match nothing: no `portal_users` row means no
 * company, and `requireCompanyUser` would bounce them to `?error=inactive`
 * forever while the address stays taken. The rollback is the only thing standing
 * between a typo'd codcli and an account only a human with dashboard access can
 * clear.
 *
 * A FAILED rollback is worse than the original failure, so — exactly as
 * `scripts/create-user.ts` does — the orphan is NAMED in the server log rather
 * than left to a cleanup that failed quietly.
 */
async function provisionAccount(
  admin: AdminClient,
  request: ProvisionRequest,
): Promise<UserAdminError | null> {
  const { email, password, displayName } = request.input;

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !created?.user) {
    // `describeDbError` flattens an AuthError the same way it flattens a
    // PostgREST one: message plus code, never "[object Object]".
    console.error(
      `createAccount(${request.kind}) auth: ${describeDbError(authError) || "no user returned"}`,
    );
    return classifyCreateUserError(authError);
  }

  const userId = created.user.id;
  /** Only a company THIS call inserted is ours to delete again. */
  let createdCompanyId: string | null = null;

  try {
    if (request.kind === "staff") {
      const { error } = await admin.from("staff_users").insert({
        id: userId,
        role: request.input.role,
        display_name: displayName,
      });
      if (error) {
        throw new ProvisionFailure(
          classifyDbError(error),
          `staff_users insert failed: ${describeDbError(error)}`,
        );
      }
    } else {
      const choice = request.input.company;
      let companyId = choice.kind === "existing" ? choice.companyId : "";

      if (choice.kind === "new") {
        const { data: company, error } = await admin
          .from("companies")
          .insert(choice.company)
          .select("id")
          .single();
        if (error) {
          throw new ProvisionFailure(
            classifyDbError(error),
            `companies insert failed: ${describeDbError(error)}`,
          );
        }
        createdCompanyId = company.id;
        companyId = company.id;
      }

      const { error } = await admin.from("portal_users").insert({
        id: userId,
        company_id: companyId,
        display_name: displayName,
      });
      if (error) {
        throw new ProvisionFailure(
          classifyDbError(error),
          `portal_users insert failed: ${describeDbError(error)}`,
        );
      }
    }
    return null;
  } catch (cause) {
    console.error(
      `createAccount(${request.kind}) failed for ${email}:`,
      cause instanceof Error ? cause.message : String(cause),
    );

    const { error: userCleanup } = await admin.auth.admin.deleteUser(userId);
    if (userCleanup) {
      console.error(
        `MANUAL CLEANUP NEEDED: auth user ${userId} (${email}) — ${userCleanup.message}`,
      );
    }
    if (createdCompanyId) {
      const { error: companyCleanup } = await admin
        .from("companies")
        .delete()
        .eq("id", createdCompanyId);
      if (companyCleanup) {
        console.error(
          `MANUAL CLEANUP NEEDED: company ${createdCompanyId} — ${describeDbError(companyCleanup)}`,
        );
      }
    }

    return cause instanceof ProvisionFailure ? cause.code : "DB_ERROR";
  }
}

/**
 * A new restaurant login, for an existing company or a brand-new one. Manager+.
 *
 * `company_choice` decides which half of the form counts: the select and the
 * 新建公司 fields are both in the DOM, and sending both would be
 * `BAD_COMPANY` — the lib refuses to guess which one the user meant.
 */
export async function createCustomerAccount(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { staffUser } = await requireStaff(locale);
  // Fails CLOSED with a throw, not a redirect: a caller without the role never
  // rendered this page, so there is no banner to send them back to.
  if (!canManageUsers(staffUser.role)) throw new Error("FORBIDDEN");

  const wantsNewCompany = String(formData.get("company_choice") ?? "") === "new";
  const validated = validateNewCustomer({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("display_name"),
    companyId: wantsNewCompany ? undefined : formData.get("company_id"),
    newCompany: wantsNewCompany
      ? {
          name: formData.get("company_name"),
          codcli: formData.get("codcli"),
          tarcli: formData.get("tarcli"),
        }
      : null,
  });
  if (!validated.ok) return finish(locale, validated.error);

  const admin = createAdminClient();
  const failure = await provisionAccount(admin, {
    kind: "customer",
    input: validated.value,
  });
  return finish(locale, failure ?? "ok");
}

/**
 * A new DADA staff login. Owner only — this is the 超级管理员 power.
 *
 * A uid that already belongs to a customer is refused by the role-exclusivity
 * trigger and comes back as `ROLE_CONFLICT`; it cannot happen on a freshly
 * minted uid, but the rollback path treats it like any other failed insert.
 */
export async function createStaffAccount(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { staffUser } = await requireStaff(locale);
  if (!canManageStaff(staffUser.role)) throw new Error("FORBIDDEN");

  const validated = validateNewStaff({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("display_name"),
    role: formData.get("role"),
  });
  if (!validated.ok) return finish(locale, validated.error);

  const admin = createAdminClient();
  const failure = await provisionAccount(admin, {
    kind: "staff",
    input: validated.value,
  });
  return finish(locale, failure ?? "ok");
}

/**
 * Move a staff member between 普通员工 / 经理 / 超级管理员. Owner only.
 *
 * `assertNotSelf` compares the target against the ACTOR's `auth.uid()`: an owner
 * who demotes their own row removes the only account that could put it back.
 */
export async function setStaffRole(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { user, staffUser } = await requireStaff(locale);
  if (!canManageStaff(staffUser.role)) throw new Error("FORBIDDEN");

  const target = assertNotSelf(user.id, formData.get("user_id"));
  if (!target.ok) return finish(locale, target.error);

  const role = parseStaffRole(formData.get("role"));
  if (!role.ok) return finish(locale, role.error);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_users")
    .update({ role: role.value })
    .eq("id", target.value)
    // Without `select`, an update that matched NOTHING is indistinguishable
    // from one that worked — and the page would redraw showing the old role
    // with a success banner over it.
    .select("id");
  if (error) {
    console.error("setStaffRole:", describeDbError(error));
    return finish(locale, classifyDbError(error));
  }
  return finish(locale, data.length > 0 ? "ok" : "NOT_FOUND");
}

/**
 * 停用 / 启用 an account. Customer rows are manager+, staff rows are owner-only.
 *
 * Deactivating is this app's delete: `requireCompanyUser` and `requireStaff`
 * both bounce an inactive row to `?error=inactive`, and the RLS helpers stop
 * seeing it. The lockout guard applies to the staff branch only — a staff member
 * has no `portal_users` row of their own to switch off (the role-exclusivity
 * trigger guarantees it), so the actor can never be the customer target.
 */
export async function setUserActive(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const { user, staffUser } = await requireStaff(locale);

  const kind = parseUserKind(formData.get("kind"));
  // The kind is read BEFORE the gate because it decides which gate applies.
  if (!kind.ok) return finish(locale, kind.error);
  const allowed =
    kind.value === "staff"
      ? canManageStaff(staffUser.role)
      : canManageUsers(staffUser.role);
  if (!allowed) throw new Error("FORBIDDEN");

  const active = formData.get("active") === "1";
  const rawTarget = String(formData.get("user_id") ?? "").trim();

  let targetId: string;
  if (kind.value === "staff") {
    const target = assertNotSelf(user.id, rawTarget);
    if (!target.ok) return finish(locale, target.error);
    targetId = target.value;
  } else {
    if (!isUuid(rawTarget)) return finish(locale, "BAD_TARGET");
    targetId = rawTarget;
  }

  const admin = createAdminClient();
  const { data, error } =
    kind.value === "staff"
      ? await admin
          .from("staff_users")
          .update({ is_active: active })
          .eq("id", targetId)
          .select("id")
      : await admin
          .from("portal_users")
          .update({ is_active: active })
          .eq("id", targetId)
          .select("id");
  if (error) {
    console.error("setUserActive:", describeDbError(error));
    return finish(locale, classifyDbError(error));
  }
  return finish(locale, data.length > 0 ? "ok" : "NOT_FOUND");
}
