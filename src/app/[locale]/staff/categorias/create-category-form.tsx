"use client";

import { useActionState } from "react";
import { createCategory } from "@/app/actions/staff-categories";
import { BTN_PRIMARY, FIELD_SM } from "@/components/ui";
import type { CategoryError } from "@/lib/categories";
import {
  EMPTY_CATEGORY_FORM_STATE,
  MAX_CATEGORY_NAME_LENGTH,
} from "@/lib/categories";

/**
 * 新建一级分类 — two name fields and a button.
 *
 * A client component for one reason: a REJECTED create has to answer the form
 * rather than the URL. Every other write on this page redirects with
 * `?result=`, which is right for a row action (nothing was typed) and wrong
 * here, because the redirect remounts the page and blanks both fields — a staff
 * member who typed a Chinese name and left the Spanish one empty would retype
 * the Chinese one to find that out.
 *
 * React resets an uncontrolled form after its action completes, and it resets to
 * whatever `defaultValue` the same commit put on each field. That is the whole
 * mechanism, and it is `create-customer-form.tsx`'s: a rejection returns the
 * values it was sent and they are the defaults the reset lands on; a success
 * returns none, so the fields go back to empty for the next category. There is
 * no redirect on success either — the action revalidates, the list beside this
 * card redraws with the new (hidden) row in it, and the form stays open, which
 * is how four categories get added in a row.
 */
export function CreateCategoryForm({
  labels,
  errorLabels,
}: {
  /** Already localized by the server page — this leaf does no translation. */
  labels: {
    nameZh: string;
    nameEs: string;
    submit: string;
    hiddenCopy: string;
    ok: string;
  };
  /** The same `staff.categories.results.*` sentences the page's banner draws from. */
  errorLabels: Record<CategoryError, string>;
}) {
  const [state, formAction, pending] = useActionState(
    createCategory,
    EMPTY_CATEGORY_FORM_STATE,
  );
  /** The last rejected submission, or nothing on a first render or a success. */
  const kept = state.values;

  return (
    // No `locale` field, and that is the difference from every sibling form on
    // this page: they post one because they REDIRECT, and the path they redirect
    // to needs a locale segment. This one answers the form instead, and
    // `createCategory` revalidates both locales' paths outright — so a locale
    // here would be a field nothing reads.
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-xs text-muted">
        {labels.nameZh}
        <input
          name="name_zh"
          maxLength={MAX_CATEGORY_NAME_LENGTH}
          autoComplete="off"
          defaultValue={kept?.zh ?? ""}
          className={`${FIELD_SM} text-ink`}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        {labels.nameEs}
        <input
          name="name_es"
          maxLength={MAX_CATEGORY_NAME_LENGTH}
          autoComplete="off"
          defaultValue={kept?.es ?? ""}
          className={`${FIELD_SM} text-ink`}
        />
      </label>

      {/* Neither field is `required`: the rule is "at least one of the two",
          which no single input can express, and marking both would demand a
          Spanish name for a category the ERP only ever names in Chinese.
          `validateCategoryName` is the rule, in one place. */}
      <p className="text-xs text-muted sm:col-span-2">{labels.hiddenCopy}</p>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={BTN_PRIMARY}>
          {labels.submit}
        </button>
        {/* Beside the button rather than at the top of the page: this is the
            answer to THIS submit, and the fields it talks about are here. */}
        {state.code && (
          <p role="alert" className="text-sm text-red-700">
            {errorLabels[state.code]}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-green-800">
            {labels.ok}
          </p>
        )}
      </div>
    </form>
  );
}
