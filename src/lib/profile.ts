/**
 * The rules behind 我的信息 — a restaurant editing its own display name and its
 * own password — with nothing in them that can touch a database or an Auth API.
 *
 * It is `user-admin.ts`'s sibling and deliberately shaped like it: codes rather
 * than sentences (they survive a redirect as a query parameter and are
 * translated at the edge of the UI), fail closed, and never throw. The two
 * modules share the actual limits — `MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_BYTES`,
 * `MAX_NAME_LENGTH` are IMPORTED rather than restated, so a password a manager
 * may set for a customer is exactly a password that customer may set for
 * themselves. A second copy of "8" would be a rule that drifts.
 *
 * **The password rule, in the one place it can be tested.** Nothing here stores,
 * returns, logs or echoes a password: `validatePasswordChange` hands back the two
 * strings its caller already has so they can go straight to Supabase Auth, and
 * every failure is a bare CODE. There is no field on any exported type that a
 * password could travel back to the browser in.
 */

import {
  MAX_NAME_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  passwordByteLength,
} from "@/lib/user-admin";

/** Everything the 我的信息 page can report, as one closed list. */
export const PROFILE_ERRORS = [
  /** Empty, or longer than the column's own ceiling. */
  "BAD_NAME",
  /** The NEW password fails our own floor or bcrypt's 72-byte ceiling. */
  "BAD_PASSWORD",
  /** The two new-password boxes disagree. */
  "PASSWORD_MISMATCH",
  /** The new password IS the current one — nothing to change. */
  "SAME_PASSWORD",
  /** Re-authentication with the current password failed. */
  "WRONG_PASSWORD",
  /** Supabase Auth refused for a reason the customer cannot act on. */
  "AUTH_ERROR",
  /** The `portal_users` write failed. */
  "DB_ERROR",
] as const;

export type ProfileError = (typeof PROFILE_ERRORS)[number];

/** What travels back to `/perfil` in `?name=` / `?pwd=`. */
export type ProfileResult = "ok" | ProfileError;

/**
 * Both parameters are user-editable, so the page proves a value belongs to this
 * list before using it as a message key — otherwise the URL decides what the
 * banner says.
 */
export function isProfileResult(value: string): value is ProfileResult {
  return value === "ok" || (PROFILE_ERRORS as readonly string[]).includes(value);
}

/** What every check in this file returns: a value, or the reason there is none. */
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProfileError };

function fail(error: ProfileError): { ok: false; error: ProfileError } {
  return { ok: false, error };
}

/**
 * A form field as text, or "" for anything that is not a string.
 *
 * `FormData.get` is typed `string | File` and a crafted POST can send either, so
 * a non-string is simply absent rather than `String()`-coerced into
 * "[object File]" — which would sail through a length check.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The name the restaurant wants to be called, on its way into
 * `portal_users.display_name`.
 *
 * Same bounds as the staff-side create form, imported rather than repeated. The
 * column is nullable, but an EMPTY name is refused rather than written as null:
 * the shell falls back to the company name when the field is null, and a
 * customer who cleared the box by accident would see the header change into
 * something they never typed with no error to explain it.
 */
export function validateDisplayName(raw: unknown): Validated<string> {
  const name = text(raw);
  if (!name || name.length > MAX_NAME_LENGTH) return fail("BAD_NAME");
  return { ok: true, value: name };
}

/** The three boxes of the 修改密码 form, as they arrive: anything, until checked. */
export interface RawPasswordChange {
  current?: unknown;
  next?: unknown;
  confirm?: unknown;
}

/**
 * The two passwords the caller needs, and nothing else.
 *
 * `current` is here because the re-authentication needs it, not because anything
 * inspects it: this is the only object in the module that ever holds one, it is
 * consumed inside a single server action, and it is never returned to a browser.
 */
export interface PasswordChange {
  current: string;
  next: string;
}

/**
 * A password change, checked in the order the form shows it and one error at a
 * time — the UI has one message line, and naming the field the customer will fix
 * next is more use than a list.
 *
 * Nothing is trimmed. Leading and trailing spaces are characters in a password,
 * and silently removing them would set a password that is not the one the person
 * typed — and then fail every future login with it.
 *
 * The empty CURRENT box is `WRONG_PASSWORD` rather than a fourth code: no account
 * can have an empty password (the floor is 8), so the answer is already known
 * and there is no reason to spend a round trip on Auth to hear it. It also keeps
 * the wording honest — the current box is wrong, which is exactly what happened.
 *
 * `SAME_PASSWORD` is caught HERE rather than left to GoTrue: the project setting
 * that rejects a reused password is not one this app controls, so without this
 * check "change" could succeed while changing nothing at all.
 */
export function validatePasswordChange(
  raw: RawPasswordChange,
): Validated<PasswordChange> {
  const current = typeof raw.current === "string" ? raw.current : "";
  const next = typeof raw.next === "string" ? raw.next : "";
  const confirm = typeof raw.confirm === "string" ? raw.confirm : "";

  if (!current) return fail("WRONG_PASSWORD");

  // The floor counts CHARACTERS (our own "long enough" rule) and the ceiling
  // counts BYTES (bcrypt's, which GoTrue enforces): a 25-character Chinese
  // passphrase is 75 bytes, which a `.length` check waves through.
  if (
    next.length < MIN_PASSWORD_LENGTH ||
    passwordByteLength(next) > MAX_PASSWORD_BYTES
  ) {
    return fail("BAD_PASSWORD");
  }

  if (next !== confirm) return fail("PASSWORD_MISMATCH");
  if (next === current) return fail("SAME_PASSWORD");

  return { ok: true, value: { current, next } };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function field(value: unknown, key: string): string {
  const found = record(value)[key];
  return typeof found === "string" ? found : "";
}

/**
 * A Supabase Auth error as one line an operator can read.
 *
 * Deliberately narrow: the CODE and the MESSAGE, and nothing else off the error
 * object. GoTrue never puts a submitted password in either, but a
 * `console.error(error)` of the whole object would print whatever a future
 * version decides to attach — including, on some clients, the request body.
 * Naming the two fields is what keeps a password out of the server log by
 * construction rather than by hope.
 */
export function describeAuthError(error: unknown): string {
  const code = field(error, "code");
  return [field(error, "message"), code && `code ${code}`].filter(Boolean).join(" | ");
}

/**
 * The re-authentication's answer, as one of two codes.
 *
 * A refused sign-in is overwhelmingly "that is not your current password", and
 * that is the one the customer can act on. Everything else — a rate limit, an
 * Auth outage, a project that has disabled password grants — is AUTH_ERROR,
 * because telling somebody their password is wrong when the service is simply
 * down sends them to reset a password that was never the problem.
 */
export function classifyReauthError(error: unknown): ProfileError {
  const code = field(error, "code");
  const message = field(error, "message");
  if (
    code === "invalid_credentials" ||
    code === "invalid_grant" ||
    /invalid login credentials|invalid_credentials/i.test(message)
  ) {
    return "WRONG_PASSWORD";
  }
  return "AUTH_ERROR";
}

/**
 * `auth.updateUser({ password })` failures, mapped onto the field at fault.
 *
 * `same_password` is GoTrue's own version of the check
 * `validatePasswordChange` already made — it fires when the project has
 * "prevent password reuse" on and the two checks disagree about, say, a Unicode
 * normalisation. `weak_password` is the project's strength policy, which is
 * stricter than our floor and can only be answered by the same field. The
 * 72-byte complaint arrives as `validation_failed` with prose rather than as
 * `weak_password`, so it needs the message test that `classifyCreateUserError`
 * learned the same way.
 */
export function classifyPasswordUpdateError(error: unknown): ProfileError {
  const code = field(error, "code");
  const message = field(error, "message");

  if (code === "same_password" || /should be different from the old/i.test(message)) {
    return "SAME_PASSWORD";
  }
  if (code === "weak_password") return "BAD_PASSWORD";
  if (/password/i.test(message) && /72 character|longer than|too long/i.test(message)) {
    return "BAD_PASSWORD";
  }
  if (code === "validation_failed" && /password/i.test(message)) return "BAD_PASSWORD";
  return "AUTH_ERROR";
}
