/**
 * The rules behind the staff back office's user management, with nothing in them
 * that can touch a database.
 *
 * Creating an account is the one operation in this app that cannot be done with
 * the caller's own credentials: `auth.admin.createUser` needs the service-role
 * key, which bypasses RLS entirely. Every check that would normally be a policy
 * therefore has to happen in application code BEFORE that client is reached —
 * so it lives here, where it is a pure function with a test, rather than inside
 * a server action where it could only be exercised by creating real accounts.
 *
 * Three consequences shape this file:
 *
 * 1. **Codes, not sentences.** Nothing here knows about zh or es. Every failure
 *    is a stable token (`BAD_CODCLI`) that survives a redirect as a query
 *    parameter and is translated at the edge of the UI. A message baked in here
 *    would arrive in the wrong language and could not be matched on.
 * 2. **Fail closed.** `staff_users.role` is a text column; the gates below treat
 *    anything that is not one of the three known roles — a typo, a future role,
 *    a missing row — as the least privileged case, never the most.
 * 3. **No throws.** Validation returns a result. A thrown validation error in a
 *    Server Action is indistinguishable from a crash to the caller, and worse,
 *    an error carrying user input risks carrying a PASSWORD into a log line.
 *    Passwords are never part of a code, an error, or a redirect.
 */

/** The three values `staff_users.role`'s check constraint allows (0001_core.sql). */
export const STAFF_ROLES = ["staff", "manager", "owner"] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** The two account kinds the back office manages; they live in different tables. */
export const USER_KINDS = ["customer", "staff"] as const;

export type UserKind = (typeof USER_KINDS)[number];

/**
 * Every failure the user-admin surface can report, as one closed list.
 *
 * They travel from a Server Action back to the page as `?result=`, so the page
 * has to be able to prove a value came from this list before using it as a
 * message key — that is what `isUserAdminError` is for.
 */
export const USER_ADMIN_ERRORS = [
  "BAD_EMAIL",
  "BAD_PASSWORD",
  "BAD_NAME",
  "BAD_COMPANY",
  "BAD_CODCLI",
  "BAD_TARCLI",
  "BAD_ROLE",
  "BAD_KIND",
  "BAD_TARGET",
  /** The lockout guard: nobody edits their own staff row. */
  "SELF_FORBIDDEN",
  "EMAIL_TAKEN",
  "CODCLI_TAKEN",
  /** One auth user cannot be both a customer and a staff member. */
  "ROLE_CONFLICT",
  "NOT_FOUND",
  "AUTH_ERROR",
  "DB_ERROR",
] as const;

export type UserAdminError = (typeof USER_ADMIN_ERRORS)[number];

export function isUserAdminError(value: string): value is UserAdminError {
  return (USER_ADMIN_ERRORS as readonly string[]).includes(value);
}

/**
 * What a REJECTED account creation hands back to the form it came from.
 *
 * The two create actions used to answer a failure the same way they answer a
 * success — a redirect — which remounts the page and leaves every field blank:
 * one wrong codcli and the staff member retypes an address, a name, a company
 * and a tarifa. So a failed create returns this instead, and the form re-renders
 * from it through `useActionState`.
 *
 * Two rules this shape exists to enforce:
 *
 * 1. **No password.** It is not a field here and must never become one. The
 *    password goes from the form to `auth.admin.createUser` and nowhere else;
 *    a value in this object is sent back to the SERVER on the next submit and
 *    sits in the DOM in between.
 * 2. **No URL.** These are somebody's personal details, so they ride the
 *    action's POST body — never a query string, which is the house rule and the
 *    reason the outcome CODE is all that ever travels in `?result=`.
 *
 * Every field is a plain string, exactly as the form sent it, because that is
 * what `defaultValue` needs: a codcli rejected as "12a" has to come back as
 * "12a" for the staff member to see what they typed.
 */
export interface CreateFormValues {
  email: string;
  displayName: string;
  /**
   * The company half. Which branch was open is NOT carried: the form keeps that
   * in its own state across a rejected submit, and a value here that nothing
   * reads is a value somebody would later have to prove is unused.
   */
  companyId: string;
  companyName: string;
  codcli: string;
  tarcli: string;
  /** The staff form's 权限 select; empty on the customer form. */
  role: string;
}

/**
 * The state both create forms hold: nothing yet, or the last failure and the
 * values that produced it. A SUCCESS never becomes a state — it redirects.
 */
export type CreateAccountState =
  | { error: null; values: null }
  | { error: UserAdminError; values: CreateFormValues };

/** What `useActionState` mounts with: no attempt made, nothing to restore. */
export const EMPTY_CREATE_STATE: CreateAccountState = { error: null, values: null };

/** What every check in this file returns: a value, or the reason there is none. */
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: UserAdminError };

function fail(error: UserAdminError): { ok: false; error: UserAdminError } {
  return { ok: false, error };
}

/**
 * Who may open 用户管理 at all, and who may touch staff accounts.
 *
 * The whole permission model is these two predicates (see the table in the
 * plan): managers run the customer side, and only the owner — 超级管理员 — can
 * mint another staff account or move somebody's role. Kept as two named
 * functions rather than a rank number so that a future fourth role has to be
 * placed deliberately instead of inheriting a `>=` comparison.
 */
export function canManageUsers(role: string | null | undefined): boolean {
  return role === "manager" || role === "owner";
}

export function canManageStaff(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Below GoTrue's own floor would be pointless; above it is our own policy. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * bcrypt hashes the first 72 BYTES and GoTrue rejects anything longer outright.
 * Catching it here turns an opaque 422 into a field-level message.
 *
 * Bytes, not characters, and the distinction is the whole point: a 25-character
 * Chinese passphrase is 75 bytes in UTF-8, which a `.length` check waves through
 * and GoTrue then refuses. Half of this deployment's staff type Chinese.
 */
export const MAX_PASSWORD_BYTES = 72;

/** What GoTrue will count when it applies its own 72-byte ceiling. */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** Long enough for a restaurant's full name, short enough not to break a table row. */
export const MAX_NAME_LENGTH = 80;

/** The RFC ceiling; `auth.users.email` will not take more either. */
const MAX_EMAIL_LENGTH = 254;

/** `companies.codcli` is `integer`, so this is a cast error, not a big number. */
const MAX_CODCLI = 2_147_483_647;

/**
 * Deliberately loose — one @, no spaces, and a dot in the domain. Address
 * validation by regex is a famous rabbit hole; this catches the two mistakes a
 * staff member actually makes (a name with no domain, a domain with no dot) and
 * leaves the rest to the confirmation mail nobody in this deployment sends.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a form field holds something `id`/`company_id` could match.
 *
 * `@/lib/orders` has a `isUuid(value: string)` of its own for order ids; this
 * one is the user-admin surface's, and it takes `unknown` because every value it
 * sees came out of a `FormData` (so it may be a File) and has not been trimmed.
 * Both branches of every target check go through THIS one, so a crafted id can
 * never take a different route depending on which table it names.
 */
export function isUuid(value: unknown): boolean {
  return UUID.test(text(value));
}

/**
 * A form field as text, or "" for anything that is not a string.
 *
 * `FormData.get` is typed `string | File`, and a crafted POST can send an
 * object. Coercing those with `String()` would turn a File into "[object File]"
 * and let it pass a length check, so non-strings are simply absent.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A whole number out of a form field, or null.
 *
 * Accepts a real number as readily as the string a `<select>` sends. The regex
 * is what rejects `"4.5"`, `"4e3"` and `"45O1"` before `Number()` turns them
 * into something plausible.
 */
function integer(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The credentials half of both forms, validated in the order the form shows it. */
interface AccountFields {
  email: string;
  password: string;
  displayName: string;
}

/**
 * Only the password is not trimmed: leading and trailing spaces are characters
 * in a password, and silently removing them would create an account whose
 * password is not the one the staff member read out to the customer.
 */
function validateAccountFields(raw: RawAccountInput): Validated<AccountFields> {
  const email = text(raw.email).toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
    return fail("BAD_EMAIL");
  }

  const password = typeof raw.password === "string" ? raw.password : "";
  // The floor counts characters (it is our own "long enough" rule) and the
  // ceiling counts bytes (it is bcrypt's, and GoTrue enforces it in bytes).
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    passwordByteLength(password) > MAX_PASSWORD_BYTES
  ) {
    return fail("BAD_PASSWORD");
  }

  const displayName = text(raw.displayName);
  if (!displayName || displayName.length > MAX_NAME_LENGTH) return fail("BAD_NAME");

  return { ok: true, value: { email, password, displayName } };
}

/** The credential fields as they arrive from a form: anything, until checked. */
export interface RawAccountInput {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
}

/** The 新建公司 branch of the customer form. */
export interface RawNewCompanyInput {
  name?: unknown;
  codcli?: unknown;
  tarcli?: unknown;
}

export interface RawCustomerInput extends RawAccountInput {
  /** Set when an existing company was picked; absent when a new one is being created. */
  companyId?: unknown;
  /** Set ONLY when the 新建公司 option is open. Presence is the choice. */
  newCompany?: RawNewCompanyInput | null;
}

export interface RawStaffInput extends RawAccountInput {
  role?: unknown;
}

export interface NewCompanyInput {
  name: string;
  codcli: number;
  tarcli: number;
}

/**
 * The company half of a customer account, as a discriminated union.
 *
 * The form offers an either/or and the action performs two very different
 * things — an insert that must be rolled back on failure, or a foreign key it
 * merely references — so the shape it consumes says which, rather than leaving
 * the action to re-derive it from two optional fields.
 */
export type CompanyChoice =
  | { kind: "existing"; companyId: string }
  | { kind: "new"; company: NewCompanyInput };

export interface NewCustomerInput {
  email: string;
  password: string;
  displayName: string;
  company: CompanyChoice;
}

export interface NewStaffInput {
  email: string;
  password: string;
  displayName: string;
  role: StaffRole;
}

/**
 * Which company this customer belongs to — exactly one of the two ways.
 *
 * Both branches filled in means the form is lying about what the user chose,
 * and neither means it sent nothing at all; both are `BAD_COMPANY` rather than
 * a guess, because guessing creates a duplicate company under a codcli the ERP
 * already uses.
 */
function validateCompanyChoice(raw: RawCustomerInput): Validated<CompanyChoice> {
  const companyId = text(raw.companyId);
  const newCompany =
    raw.newCompany && typeof raw.newCompany === "object" ? raw.newCompany : null;

  if (Boolean(companyId) === Boolean(newCompany)) return fail("BAD_COMPANY");

  if (!newCompany) {
    // A non-uuid would reach Postgres as a cast error on `company_id`.
    return isUuid(companyId)
      ? { ok: true, value: { kind: "existing", companyId } }
      : fail("BAD_COMPANY");
  }

  const name = text(newCompany.name);
  if (!name || name.length > MAX_NAME_LENGTH) return fail("BAD_COMPANY");

  // codcli is the ERP's customer number: the bridge matches orders on it, so a
  // zero or a fraction here would produce a company no albarán can ever find.
  const codcli = integer(newCompany.codcli);
  if (codcli === null || codcli <= 0 || codcli > MAX_CODCLI) return fail("BAD_CODCLI");

  // The tarifa picks which of the six price columns this customer sees. The
  // column defaults to 1, but a MISSING value here means a crafted POST, and
  // defaulting silently would put a restaurant on the wrong price tier.
  const tarcli = integer(newCompany.tarcli);
  if (tarcli === null || tarcli < 1 || tarcli > 6) return fail("BAD_TARCLI");

  return { ok: true, value: { kind: "new", company: { name, codcli, tarcli } } };
}

/**
 * A customer account request, field by field in the order the form shows them.
 *
 * One error at a time, topmost first: the UI has one message line, and naming
 * the field the user will fix next is more use than a list they have to read.
 */
export function validateNewCustomer(raw: RawCustomerInput): Validated<NewCustomerInput> {
  const account = validateAccountFields(raw);
  if (!account.ok) return account;

  const company = validateCompanyChoice(raw);
  if (!company.ok) return company;

  return { ok: true, value: { ...account.value, company: company.value } };
}

/** A role out of a form field, checked against the column's check constraint. */
export function parseStaffRole(value: unknown): Validated<StaffRole> {
  const role = text(value);
  return isStaffRole(role) ? { ok: true, value: role } : fail("BAD_ROLE");
}

/** Which of the two user tables an action is aimed at. */
export function parseUserKind(value: unknown): Validated<UserKind> {
  const kind = text(value);
  // The kind decides WHICH gate applies — staff rows are owner-only — so an
  // unrecognised value must never fall through to the laxer branch.
  return (USER_KINDS as readonly string[]).includes(kind)
    ? { ok: true, value: kind as UserKind }
    : fail("BAD_KIND");
}

export function validateNewStaff(raw: RawStaffInput): Validated<NewStaffInput> {
  const account = validateAccountFields(raw);
  if (!account.ok) return account;

  const role = parseStaffRole(raw.role);
  if (!role.ok) return role;

  return { ok: true, value: { ...account.value, role: role.value } };
}

/**
 * The lockout guard: an owner may not change their own role or deactivate
 * themselves.
 *
 * There is exactly one owner in this deployment. A demotion or a deactivation
 * applied to their own row removes the only account that could undo it, and no
 * amount of RLS can see the intent — the service-role client would apply it
 * happily. So the comparison happens here, against the ACTOR's `auth.uid()`,
 * before any client is created.
 *
 * The comparison is case- and space-insensitive because Postgres compares
 * `uuid` values, not their spelling: a crafted POST spelling the same id in
 * upper case would still match the row, and a strict string compare would wave
 * it through. An actor id that is not a uuid cannot be cleared of being the
 * target, so it fails closed as SELF_FORBIDDEN rather than passing.
 */
export function assertNotSelf(actorId: unknown, targetId: unknown): Validated<string> {
  const target = text(targetId);
  if (!isUuid(target)) return fail("BAD_TARGET");

  const actor = text(actorId);
  if (!isUuid(actor)) return fail("SELF_FORBIDDEN");

  return actor.toLowerCase() === target.toLowerCase()
    ? fail("SELF_FORBIDDEN")
    : { ok: true, value: target };
}

/**
 * The 停用 / 启用 switch, as the two values its buttons send.
 *
 * Read as a strict pair rather than `value === "1"`, because that comparison
 * turns EVERY unexpected value — a missing field, a "true", a renamed button —
 * into "deactivate". Being logged out of the back office is not a sensible
 * default for a request nobody can parse, so an unrecognised flag is refused the
 * same way an unrecognised target is.
 */
export function parseActiveFlag(value: unknown): Validated<boolean> {
  const flag = text(value);
  if (flag === "1") return { ok: true, value: true };
  if (flag === "0") return { ok: true, value: false };
  return fail("BAD_TARGET");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function field(value: unknown, key: string): string {
  const found = record(value)[key];
  return typeof found === "string" ? found : "";
}

/**
 * A PostgREST error as one line an operator can read.
 *
 * On the `{ data, error }` path PostgREST hands back a PLAIN OBJECT, not the
 * `PostgrestError` class it is typed as — that one is only constructed when
 * `throwOnError` is set. So it fails `instanceof Error` and stringifies to
 * "[object Object]", which is what a naive `console.error(error)` writes into
 * the log of a failed account creation. Same flattening as
 * `scripts/create-user.ts`, which learned this the same way.
 */
export function describeDbError(error: unknown): string {
  const source = record(error);
  const code = field(source, "code");
  return [field(source, "message"), code && `code ${code}`, field(source, "details"), field(source, "hint")]
    .filter(Boolean)
    .join(" | ");
}

/**
 * The two database failures a staff member can act on, told apart from the rest.
 *
 * Order matters: the role-exclusivity trigger
 * (`private.enforce_exclusive_user_role`) raises USER_ROLE_CONFLICT with
 * errcode **23505**, the same code a duplicate codcli produces, so it is
 * recognised first. Everything else stays `DB_ERROR` — a wrong guess sends a
 * staff member to change a field that was never the problem.
 */
export function classifyDbError(error: unknown): UserAdminError {
  const source = record(error);
  const code = field(source, "code");
  const haystack = `${field(source, "message")} ${field(source, "details")} ${field(source, "constraint")}`;

  if (/USER_ROLE_CONFLICT|auth_user_role_exclusive/i.test(haystack)) return "ROLE_CONFLICT";
  if (code === "23505" && /codcli/i.test(haystack)) return "CODCLI_TAKEN";
  // The only foreign key these writes touch is `portal_users.company_id`: the
  // chosen company was deleted between the page render and the submit.
  if (code === "23503") return "BAD_COMPANY";
  return "DB_ERROR";
}

/**
 * `auth.admin.createUser` failures, mapped back onto the form field at fault.
 *
 * "That address already has an account" is the one a staff member can fix
 * unaided, and it is also the one GoTrue has spelled several ways across
 * versions — hence both the codes and the message. Anything else is one
 * AUTH_ERROR rather than a guess about which field to blame.
 *
 * The 72-byte ceiling deserves its own branch: GoTrue answers an over-long
 * password with `validation_failed` and the prose "Password cannot be longer
 * than 72 characters" — NOT with `weak_password` — so without this it would
 * reach the staff member as the generic AUTH_ERROR, pointing at no field at all.
 * `validateAccountFields` should stop these first; this is the second line, for
 * a version of GoTrue whose counting disagrees with ours.
 */
export function classifyCreateUserError(error: unknown): UserAdminError {
  const source = record(error);
  const code = field(source, "code");
  const message = field(source, "message");

  if (
    code === "email_exists" ||
    code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(message)
  ) {
    return "EMAIL_TAKEN";
  }
  if (code === "weak_password") return "BAD_PASSWORD";
  // `validation_failed` covers several complaints ("only an email address or
  // phone number should be provided" among them), so the message has to name
  // the password before this claims the field.
  if (/password/i.test(message) && /72 character|longer than|too long/i.test(message)) {
    return "BAD_PASSWORD";
  }
  if (code === "validation_failed" && /password/i.test(message)) return "BAD_PASSWORD";
  if (code === "email_address_invalid") return "BAD_EMAIL";
  return "AUTH_ERROR";
}
