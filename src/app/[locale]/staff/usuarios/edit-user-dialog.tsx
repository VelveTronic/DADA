"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import {
  updateManagedAccount,
  updateManagedPassword,
} from "@/app/actions/staff-users";
import { PasswordInput } from "@/components/password-input";
import { BTN_PRIMARY, BTN_QUIET, FIELD } from "@/components/ui";
import {
  EMPTY_MANAGED_ACCOUNT_STATE,
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  type StaffRole,
} from "@/lib/user-admin";

type Company = { id: string; label: string };

export type EditableAccount = {
  id: string;
  kind: "customer" | "staff";
  email: string;
  displayName: string;
  active: boolean;
  companyId?: string;
  role?: StaffRole;
};

export type EditAccountLabels = {
  edit: string;
  editFor: string;
  title: string;
  close: string;
  email: string;
  displayName: string;
  company: string;
  role: string;
  status: string;
  active: string;
  inactive: string;
  save: string;
  passwordTitle: string;
  password: string;
  confirmPassword: string;
  passwordHint: string;
  savePassword: string;
  showPassword: string;
  hidePassword: string;
  saving: string;
  results: Record<string, string>;
};

function Result({
  result,
  labels,
}: {
  result: string | null;
  labels: EditAccountLabels;
}) {
  if (!result) return null;
  return (
    <p
      role={result === "ok" ? "status" : "alert"}
      className={`rounded-lg px-3 py-2 text-sm ${
        result === "ok"
          ? "bg-green-50 text-green-800"
          : "bg-red-50 text-red-700"
      }`}
    >
      {labels.results[result] ?? labels.results.DB_ERROR}
    </p>
  );
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BTN_PRIMARY}>
      {pending ? pendingLabel : label}
    </button>
  );
}

export function EditUserDialog({
  locale,
  account,
  companies,
  roleLabels,
  labels,
}: {
  locale: string;
  account: EditableAccount;
  companies: Company[];
  roleLabels: Record<StaffRole, string>;
  labels: EditAccountLabels;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [profileState, profileAction] = useActionState(
    updateManagedAccount,
    EMPTY_MANAGED_ACCOUNT_STATE,
  );
  const [passwordState, passwordAction] = useActionState(
    updateManagedPassword,
    EMPTY_MANAGED_ACCOUNT_STATE,
  );
  const eyes = { show: labels.showPassword, hide: labels.hidePassword };

  return (
    <>
      <button
        type="button"
        aria-label={labels.editFor}
        onClick={() => dialog.current?.showModal()}
        className={`${BTN_QUIET} h-[30px] whitespace-nowrap px-2.5 text-[12.5px]`}
      >
        {labels.edit}
      </button>

      <dialog
        ref={dialog}
        aria-label={labels.title}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-ink shadow-2xl backdrop:bg-ink/35"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-5 py-4">
          <h2 className="text-lg font-bold">{labels.title}</h2>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className={BTN_QUIET}
          >
            {labels.close}
          </button>
        </div>

        <div className="grid gap-6 p-5">
          <form action={profileAction} className="grid gap-4">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="user_id" value={account.id} />
            <input type="hidden" name="kind" value={account.kind} />

            <Result result={profileState.result} labels={labels} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm sm:col-span-2">
                {labels.email}
                <input
                  type="email"
                  name="email"
                  required
                  defaultValue={account.email}
                  autoComplete="off"
                  className={FIELD}
                />
              </label>

              <label className="grid gap-1 text-sm sm:col-span-2">
                {labels.displayName}
                <input
                  name="display_name"
                  required
                  maxLength={MAX_NAME_LENGTH}
                  defaultValue={account.displayName}
                  autoComplete="off"
                  className={FIELD}
                />
              </label>

              {account.kind === "customer" ? (
                <label className="grid gap-1 text-sm">
                  {labels.company}
                  <select
                    name="company_id"
                    required
                    defaultValue={account.companyId}
                    className={FIELD}
                  >
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="grid gap-1 text-sm">
                  {labels.role}
                  <select
                    name="role"
                    required
                    defaultValue={account.role}
                    className={FIELD}
                  >
                    {(Object.keys(roleLabels) as StaffRole[]).map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="grid gap-1 text-sm">
                {labels.status}
                <select
                  name="active"
                  defaultValue={account.active ? "1" : "0"}
                  className={FIELD}
                >
                  <option value="1">{labels.active}</option>
                  <option value="0">{labels.inactive}</option>
                </select>
              </label>
            </div>

            <div>
              <Submit label={labels.save} pendingLabel={labels.saving} />
            </div>
          </form>

          <form action={passwordAction} className="grid gap-4 border-t border-border pt-5">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="user_id" value={account.id} />
            <input type="hidden" name="kind" value={account.kind} />

            <div>
              <h3 className="font-semibold">{labels.passwordTitle}</h3>
              <p className="mt-1 text-xs text-muted">{labels.passwordHint}</p>
            </div>
            <Result result={passwordState.result} labels={labels} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                {labels.password}
                <PasswordInput
                  name="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  labels={eyes}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {labels.confirmPassword}
                <PasswordInput
                  name="confirm_password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  labels={eyes}
                />
              </label>
            </div>

            <div>
              <Submit label={labels.savePassword} pendingLabel={labels.saving} />
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}
