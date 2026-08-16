# User Admin + Login UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff back-office user management (create customer/staff accounts in the UI; owner = 超级管理员 assigns roles) plus a show/hide-password eye toggle on every password field, starting with login.

**Architecture:** No schema changes — `staff_users.role` already has the three-tier check `('staff','manager','owner')` (0001_core.sql:33) and the role-exclusivity trigger exists. Enforcement is in server actions: `requireStaff` → pure role-gate functions → service-role admin client (the only way to call `auth.admin.createUser`), reusing the create/rollback pattern proven in `scripts/create-user.ts`. UI is a new `/staff/usuarios` page gated to manager/owner, with owner-only staff controls. The eye toggle is one reusable client component used by login and both create forms.

**Tech Stack:** Next.js 16 (App Router, `src/proxy.ts` note in AGENTS.md), next-intl 4 (zh default/es — every string in BOTH locales, key parity), @supabase/supabase-js admin client (server-only), vitest 4, Tailwind 4 with tokens from `src/components/ui.ts`.

**Permission model (the whole spec, keep it this small):**

| capability | staff | manager | owner (超级管理员) |
| --- | --- | --- | --- |
| existing pages (queue/products/bridge card) | ✓ | ✓ | ✓ |
| see 用户管理 nav + page | — | ✓ | ✓ |
| create customer account, toggle customer active | — | ✓ | ✓ |
| create staff account, change staff role, toggle staff active | — | — | ✓ |
| change own role / deactivate self | — | — | — (blocked — lockout guard) |

Out of scope (note in code comments, do not build): password reset for existing users, random-password generator, email invitations.

---

### Task 1: PasswordInput component + login wiring

**Files:**
- Create: `src/components/password-input.tsx`
- Modify: `src/app/[locale]/login/login-form.tsx` (whole password `<label>` block, lines 26-35)
- Modify: `src/app/[locale]/login/page.tsx` (pass two new labels)
- Modify: `messages/zh.json`, `messages/es.json` (add `login.showPassword` / `login.hidePassword`)

- [ ] **Step 1: Component.** `"use client"`. Props: `{ name: string; autoComplete: string; labels: { show: string; hide: string }; required?: boolean; minLength?: number }`. Internal `useState(false)` for visibility. Render a relative-wrapped `<input>` (className `FIELD` + right padding for the button, e.g. `pr-10`) whose `type` is `visible ? "text" : "password"`, plus an absolutely-positioned `<button type="button">` inside the wrapper with `aria-label={visible ? labels.hide : labels.show}`, `aria-pressed={visible}`, `onClick={() => setVisible(v => !v)}`. Icons are inline SVGs (an eye / eye-with-slash pair, `aria-hidden`, `stroke="currentColor"`, no icon library — the repo has none). The button must NOT submit the form and must not steal tab order from the submit button (natural DOM order after the input is fine). Do not log or echo the value anywhere.
- [ ] **Step 2: Wire login.** In `login-form.tsx` replace the raw password `<input>` with `<PasswordInput name="password" autoComplete="current-password" required labels={labels.password2}/>` — extend the `labels` prop type with `{ show: string; hide: string }` passed from `page.tsx` via `t("showPassword")` / `t("hidePassword")`. zh: 显示密码 / 隐藏密码; es: Mostrar contraseña / Ocultar contraseña.
- [ ] **Step 3: Gate.** `pnpm bridge:build` then `pnpm lint`, `pnpm typecheck`, `pnpm test` (427, no new unit tests — component behavior is browser-verified; the repo has no DOM test tooling and this task does not add any), `pnpm build`. All zero.
- [ ] **Step 4: Browser verify** (`pnpm start` after build, or report UNVERIFIED-BROWSER and the controller verifies): type into the password field, click the eye — value becomes visible and `aria-pressed` flips; click again — masked. Form still submits with Enter.
- [ ] **Step 5: Commit** `feat(auth): password visibility toggle on login` + Co-Authored-By line.

### Task 2: user-admin domain lib (TDD) + server actions

**Files:**
- Create: `src/lib/user-admin.ts`
- Create: `src/lib/user-admin.test.ts`
- Create: `src/app/actions/staff-users.ts`

- [ ] **Step 1: Failing tests first** (`src/lib/user-admin.test.ts`, table-driven like `src/lib/bridge-status.test.ts`). Cover:
  - `canManageUsers('staff')===false`, `('manager')===true`, `('owner')===true`
  - `canManageStaff` true only for `'owner'`
  - `validateNewCustomer`: happy path; email without `@` → `"BAD_EMAIL"`; password length < 8 → `"BAD_PASSWORD"`; empty displayName → `"BAD_NAME"`; company choice must be EITHER `{ companyId: uuid }` OR `{ newCompany: { name, codcli, tarcli } }` — both/neither → `"BAD_COMPANY"`; codcli not a positive integer → `"BAD_CODCLI"`; tarcli outside 1..6 → `"BAD_TARCLI"`
  - `validateNewStaff`: same email/password/name rules; role not in `['staff','manager','owner']` → `"BAD_ROLE"`
  - `assertNotSelf(actorId, targetId)` → `"SELF_FORBIDDEN"` when equal (the lockout guard for role change / deactivate on staff)
  All validators return `{ ok: true, value } | { ok: false, error: string }` — no throws, no i18n in the lib (codes only; UI translates).
- [ ] **Step 2: Run tests, confirm they fail** (`pnpm test src/lib/user-admin.test.ts`).
- [ ] **Step 3: Implement `src/lib/user-admin.ts`** — pure, no imports from supabase. Export the types (`NewCustomerInput`, `NewStaffInput`, `StaffRole = "staff" | "manager" | "owner"`).
- [ ] **Step 4: Tests green.**
- [ ] **Step 5: Server actions** (`src/app/actions/staff-users.ts`, `"use server"`, mirror the shape/error style of `src/app/actions/staff-orders.ts` and the rollback pattern + `describeDbError` flattening of `scripts/create-user.ts`):
  - `createCustomerAccount(formData)`: `requireStaff` → `canManageUsers(staffUser.role)` else error → validate → admin client: `auth.admin.createUser({ email, password, email_confirm: true })` → if `newCompany`, insert into `companies` (unique-violation on codcli reported readably) → insert `portal_users { id, company_id, display_name }` → on ANY failure roll back auth user (and inserted company) exactly like create-user.ts, naming orphans in the server log. Never put the password in logs, errors, or revalidated props.
  - `createStaffAccount(formData)`: `requireStaff` → `canManageStaff` → validate → createUser → insert `staff_users { id, role, display_name }` → same rollback.
  - `setStaffRole(formData)` (owner only): `assertNotSelf` → admin update `staff_users.role`.
  - `setUserActive(formData)` (`kind: "customer" | "staff"`; staff kind is owner-only; customer kind manager+): `assertNotSelf` when kind=staff → admin update `is_active`.
  - Each action ends `revalidatePath(\`/\${locale}/staff/usuarios\`)` and returns the page via redirect-with-status-param or the repo's existing action-result convention — READ `staff-orders.ts` first and copy its convention exactly.
- [ ] **Step 6: Gate** (bridge:build → lint, typecheck, test — 427 + new user-admin count, build).
- [ ] **Step 7: Commit** `feat(staff): user-admin domain lib and account actions` + Co-Authored-By.

### Task 3: /staff/usuarios page, nav gating, messages

**Files:**
- Create: `src/app/[locale]/staff/usuarios/page.tsx`
- Create: `src/app/[locale]/staff/usuarios/create-customer-form.tsx`, `create-staff-form.tsx` (client components using `PasswordInput`)
- Modify: `src/components/app-shell.tsx` (staff nav array near line 77 — add 用户管理 entry conditionally)
- Modify: `src/app/[locale]/staff/page.tsx` (cards array near line 44 — same condition)
- Modify: `messages/zh.json`, `messages/es.json`

- [ ] **Step 1: Page.** `requireStaff(locale)`; if `!canManageUsers(staffUser.role)` → `redirect(\`/\${locale}/staff\`)`. Data via the server-only admin client (same pattern as `/staff/productos` — RLS on `staff_users` is self-select only, and emails live in `auth.users`): `auth.admin.listUsers({ perPage: 1000 })` once, build an id→email map, then `portal_users` joined to `companies` (name, codcli, tarcli, is_active) and full `staff_users` list. Two glass cards (`GLASS_CARD` from `src/components/ui.ts`): 客户账号 (rows: email, display_name, company name + codcli, active badge, 停用/启用 button) and 员工账号 (rows: email, display_name, role, active badge; owner additionally sees a role `<select>` + 停用/启用; the actor's own row renders its controls disabled with a title=不能修改自己). The staff card and its create form render ONLY for owner.
- [ ] **Step 2: Forms.** Customer form: email, `PasswordInput` (autoComplete `new-password`, minLength 8), display name, company choice — a `<select>` of existing companies plus a 新建公司 option that reveals name/codcli/tarcli(1-6) fields. Staff form (owner only): email, `PasswordInput`, display name, role select (staff/manager/owner with zh labels 普通员工/经理/超级管理员). Both post to the Task 2 actions; on success the list revalidates and the form resets; error codes map to bilingual messages (one `messages` namespace `staff.users.*`, key parity zh/es enforced by the existing `AppConfig.Messages` typecheck).
- [ ] **Step 3: Nav.** In `app-shell.tsx` and `staff/page.tsx`, append `{ href: \`/\${locale}/staff/usuarios\`, label: t("usersAdmin") }` only when the current staff role passes `canManageUsers` — check how the staff role currently reaches each file (`requireStaff` result in the page; AppShell may need the role passed down one prop) and thread it through with minimal surface.
- [ ] **Step 4: Gate** (all five, zero) — then **browser verify**: as staff-test (manager) — nav link visible, page lists the two seeded accounts with emails, create a customer account against a NEW company (use a disposable email like `e2e-usuarios@dada.local`, then deactivate it and verify the login is refused with `error=inactive`); staff card hidden for manager. Report evidence; delete/deactivate anything you created.
- [ ] **Step 5: CLAUDE.md** — add one line to Conventions: user management writes go through the service-role client only after `requireStaff` + `canManageUsers`/`canManageStaff` role gates; staff self-modification is always rejected (`SELF_FORBIDDEN`).
- [ ] **Step 6: Commit** `feat(staff): user management page with role-gated account creation` + Co-Authored-By.

---

## Self-review notes

- Spec coverage: eye icon → Task 1; 创建账号给用户 → Tasks 2-3 (customer accounts, manager+); 超级管理员分配权限 → owner-only staff creation/role/active controls (Tasks 2-3). No schema change needed — verified `role` check constraint exists.
- The seeded staff-test account is role `manager`: it exercises the manager view. Owner-view browser verification requires promoting a disposable staff account via SQL or re-using `scripts/create-user.ts` — Task 3's verifier may create `e2e-owner@dada.local` (owner) via the script pattern and must deactivate it afterwards.
- Type consistency: `StaffRole` defined once in `src/lib/user-admin.ts`; actions and UI import it. `canManageUsers`/`canManageStaff` names used identically in Tasks 2 and 3.
