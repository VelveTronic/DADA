"use client";

import { useActionState } from "react";
import { createStaffAccount } from "@/app/actions/staff-users";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, FIELD } from "@/components/ui";
import {
  EMPTY_CREATE_STATE,
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  STAFF_ROLES,
  type StaffRole,
  type UserAdminError,
} from "@/lib/user-admin";

/**
 * The 新建员工账号 form — the 超级管理员 power, rendered only for an owner.
 *
 * A client component because `PasswordInput` is one (the eye toggle owns a
 * boolean) and because a rejected submit has to redraw with what was typed;
 * the fields themselves are uncontrolled and go straight into the Server
 * Action's FormData. `createStaffAccount` re-checks `canManageStaff` regardless
 * of who could see this form: a Server Action is its own POST endpoint, and a
 * hidden form is not a permission.
 *
 * The role options come from `STAFF_ROLES` rather than from three literals, so
 * a fourth role added to the column's check constraint appears here as soon as
 * it has a label instead of silently going missing.
 *
 * The failure path is the customer form's, for the same reason and with the same
 * exception: React resets the fields after the action and lands them on the
 * `defaultValue`s the returned values just supplied — all of them except the
 * password, which is never returned and is always retyped.
 */
export function CreateStaffForm({
  locale,
  labels,
  roleLabels,
  errorLabels,
}: {
  locale: string;
  /** Already localized by the server page — this leaf does no translation. */
  labels: {
    email: string;
    password: string;
    passwordHint: string;
    displayName: string;
    role: string;
    submit: string;
    showPassword: string;
    hidePassword: string;
  };
  roleLabels: Record<StaffRole, string>;
  /** The same `staff.users.results.*` sentences the page's banner draws from. */
  errorLabels: Record<UserAdminError, string>;
}) {
  const [state, formAction, pending] = useActionState(
    createStaffAccount,
    EMPTY_CREATE_STATE,
  );
  /** The last rejected submission, or nothing on a first render or a success. */
  const kept = state.values;

  return (
    <form action={formAction} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="locale" value={locale} />

      <label className="flex flex-col gap-1 text-sm">
        {labels.email}
        <input
          name="email"
          type="email"
          required
          // Somebody else's address; the staff member's own saved one would be
          // the fastest way to create the wrong account.
          autoComplete="off"
          defaultValue={kept?.email ?? ""}
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.password}
        <PasswordInput
          name="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          labels={{ show: labels.showPassword, hide: labels.hidePassword }}
        />
        <span className="text-xs text-muted">{labels.passwordHint}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.displayName}
        <input
          name="display_name"
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          defaultValue={kept?.displayName ?? ""}
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {labels.role}
        {/* Keyed, not merely defaulted: React applies a `defaultValue` to a
            select's options on MOUNT and never again, so without this the form's
            reset would drop the chosen 权限 back to 普通员工 while the fields
            beside it kept what was typed. Verified in the browser, 2026-08-16. */}
        <select
          key={kept?.role || "staff"}
          name="role"
          defaultValue={kept?.role || "staff"}
          className={FIELD}
        >
          {STAFF_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabels[role]}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={BTN_PRIMARY}>
          {labels.submit}
        </button>
        {/* Beside the button rather than at the top of the page: this is the
            answer to THIS submit, and the fields it talks about are here. */}
        {state.error && (
          <p role="alert" className="text-sm text-red-700">
            {errorLabels[state.error]}
          </p>
        )}
      </div>
    </form>
  );
}
