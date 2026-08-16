import { describe, expect, it } from "vitest";
import {
  assertNotSelf,
  canManageStaff,
  canManageUsers,
  classifyCreateUserError,
  classifyDbError,
  describeDbError,
  isStaffRole,
  isUserAdminError,
  isUuid,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  parseActiveFlag,
  parseStaffRole,
  parseUserKind,
  passwordByteLength,
  STAFF_ROLES,
  validateNewCustomer,
  validateNewStaff,
  type RawCustomerInput,
  type RawStaffInput,
} from "./user-admin";

/** A uuid the shape `portal_users.company_id` and `auth.users.id` really are. */
const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

/** A customer form as the page submits it, with an EXISTING company chosen. */
const CUSTOMER: RawCustomerInput = {
  email: "cliente@dada.local",
  password: "una-clave-larga",
  displayName: "陈记餐厅 老板",
  companyId: UUID,
};

/** The same form with the 新建公司 branch open instead. */
const CUSTOMER_NEW_COMPANY: RawCustomerInput = {
  email: "cliente@dada.local",
  password: "una-clave-larga",
  displayName: "陈记餐厅 老板",
  newCompany: { name: "陈记餐厅", codcli: "4501", tarcli: "3" },
};

const STAFF: RawStaffInput = {
  email: "nuevo@dada.es",
  password: "una-clave-larga",
  displayName: "Marta",
  role: "manager",
};

describe("role gates", () => {
  // The whole permission model is these two predicates; every server action and
  // every piece of nav gating asks one of them, so the table IS the spec.
  const cases: Array<[string, boolean, boolean]> = [
    ["staff", false, false],
    ["manager", true, false],
    ["owner", true, true],
  ];

  for (const [role, users, staff] of cases) {
    it(`${role}: manages users ${users}, manages staff ${staff}`, () => {
      expect(canManageUsers(role)).toBe(users);
      expect(canManageStaff(role)).toBe(staff);
    });
  }

  it("fails closed on anything that is not one of the three roles", () => {
    // `staff_users.role` is a text column behind a check constraint, and the
    // value reaches these gates as a plain string. A role this build does not
    // know — a future 'readonly', a typo, a row read before the guard ran — must
    // never be treated as more privileged than 'staff'.
    for (const role of ["", "admin", "superuser", "OWNER", "Manager", " owner", null, undefined]) {
      expect(canManageUsers(role)).toBe(false);
      expect(canManageStaff(role)).toBe(false);
    }
  });
});

describe("isStaffRole / parseStaffRole", () => {
  it("recognises exactly the three roles the check constraint allows", () => {
    for (const role of STAFF_ROLES) expect(isStaffRole(role)).toBe(true);
    for (const value of ["", "admin", "OWNER", 1, null, undefined, {}]) {
      expect(isStaffRole(value)).toBe(false);
    }
  });

  it("parses a role out of a form field, or names it BAD_ROLE", () => {
    expect(parseStaffRole("owner")).toEqual({ ok: true, value: "owner" });
    expect(parseStaffRole(" manager ")).toEqual({ ok: true, value: "manager" });
    expect(parseStaffRole("admin")).toEqual({ ok: false, error: "BAD_ROLE" });
    expect(parseStaffRole("")).toEqual({ ok: false, error: "BAD_ROLE" });
    expect(parseStaffRole(null)).toEqual({ ok: false, error: "BAD_ROLE" });
  });
});

describe("parseUserKind", () => {
  it("accepts the two account kinds and nothing else", () => {
    expect(parseUserKind("customer")).toEqual({ ok: true, value: "customer" });
    expect(parseUserKind("staff")).toEqual({ ok: true, value: "staff" });
    // The kind decides WHICH gate applies (staff rows are owner-only), so an
    // unrecognised one can never fall through to the laxer branch.
    for (const value of ["", "STAFF", "portal", null, undefined, 7]) {
      expect(parseUserKind(value)).toEqual({ ok: false, error: "BAD_KIND" });
    }
  });
});

describe("isUuid", () => {
  it("accepts a uuid in either case, trimmed, and nothing else", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid(` ${UUID} `)).toBe(true);
    // Both target branches of `setUserActive` go through this one function, so
    // the two tables cannot be reached by values of different strictness.
    for (const value of ["", "not-a-uuid", UUID.slice(0, -1), 7, null, undefined, {}]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});

describe("parseActiveFlag", () => {
  it("reads the two values the 停用/启用 buttons send", () => {
    expect(parseActiveFlag("1")).toEqual({ ok: true, value: true });
    expect(parseActiveFlag("0")).toEqual({ ok: true, value: false });
  });

  it("refuses anything else instead of defaulting to deactivate", () => {
    // `value === "1"` would turn every one of these into "switch the account
    // off", which is this app's delete. A request nobody can parse must change
    // nothing at all.
    for (const value of ["", "true", "false", "yes", "01", 1, null, undefined, {}]) {
      expect(parseActiveFlag(value)).toEqual({ ok: false, error: "BAD_TARGET" });
    }
  });
});

describe("validateNewCustomer — happy paths", () => {
  it("normalises an existing-company submission", () => {
    expect(
      validateNewCustomer({
        email: "  Cliente@DADA.local ",
        password: "una-clave-larga",
        displayName: "  陈记餐厅 老板  ",
        companyId: ` ${UUID} `,
      }),
    ).toEqual({
      ok: true,
      value: {
        email: "cliente@dada.local",
        password: "una-clave-larga",
        displayName: "陈记餐厅 老板",
        company: { kind: "existing", companyId: UUID },
      },
    });
  });

  it("turns the 新建公司 branch into numbers the companies row can take", () => {
    // codcli and tarcli arrive as strings from a form and land in `integer` and
    // `smallint` columns; converting here is what keeps the action free of
    // parsing and the database free of cast errors.
    expect(validateNewCustomer(CUSTOMER_NEW_COMPANY)).toEqual({
      ok: true,
      value: {
        email: "cliente@dada.local",
        password: "una-clave-larga",
        displayName: "陈记餐厅 老板",
        company: { kind: "new", company: { name: "陈记餐厅", codcli: 4501, tarcli: 3 } },
      },
    });
  });

  it("accepts numbers as readily as the strings a form sends", () => {
    const result = validateNewCustomer({
      ...CUSTOMER_NEW_COMPANY,
      newCompany: { name: " 陈记餐厅 ", codcli: 4501, tarcli: 6 },
    });
    expect(result.ok && result.value.company).toEqual({
      kind: "new",
      company: { name: "陈记餐厅", codcli: 4501, tarcli: 6 },
    });
  });

  it("accepts every tarifa the check constraint allows", () => {
    for (const tarcli of [1, 2, 3, 4, 5, 6]) {
      const result = validateNewCustomer({
        ...CUSTOMER_NEW_COMPANY,
        newCompany: { name: "陈记餐厅", codcli: 1, tarcli: String(tarcli) },
      });
      expect(result.ok).toBe(true);
    }
  });

  it("does not trim the password — a space is a character in a password", () => {
    const result = validateNewCustomer({ ...CUSTOMER, password: " espacios  " });
    expect(result.ok && result.value.password).toBe(" espacios  ");
  });

  it("takes a password of exactly the minimum length", () => {
    const result = validateNewCustomer({
      ...CUSTOMER,
      password: "a".repeat(MIN_PASSWORD_LENGTH),
    });
    expect(result.ok).toBe(true);
  });

  it("takes a password of exactly the maximum, counted in BYTES", () => {
    // bcrypt hashes 72 bytes and GoTrue enforces the ceiling in bytes, so the
    // boundary is 72 ASCII characters — and only 24 Chinese ones, which is the
    // whole reason this is not a `.length` check.
    for (const password of ["a".repeat(MAX_PASSWORD_BYTES), "长".repeat(24)]) {
      expect(passwordByteLength(password)).toBe(MAX_PASSWORD_BYTES);
      expect(validateNewCustomer({ ...CUSTOMER, password }).ok).toBe(true);
    }
  });

  it("takes a display name and an email of exactly the maximum length", () => {
    expect(
      validateNewCustomer({ ...CUSTOMER, displayName: "名".repeat(MAX_NAME_LENGTH) }).ok,
    ).toBe(true);
    // 254 is the RFC ceiling and what `auth.users.email` will hold.
    const email = `${"a".repeat(254 - "@dada.local".length)}@dada.local`;
    expect(email).toHaveLength(254);
    expect(validateNewCustomer({ ...CUSTOMER, email }).ok).toBe(true);
  });

  it("takes the largest codcli an integer column can hold", () => {
    const result = validateNewCustomer({
      ...CUSTOMER_NEW_COMPANY,
      newCompany: { name: "陈记餐厅", codcli: "2147483647", tarcli: "1" },
    });
    expect(result.ok && result.value.company).toEqual({
      kind: "new",
      company: { name: "陈记餐厅", codcli: 2_147_483_647, tarcli: 1 },
    });
  });
});

describe("validateNewCustomer — rejections", () => {
  const cases: Array<{ name: string; patch: Partial<RawCustomerInput>; error: string }> = [
    {
      name: "an address with no @ is not an address",
      patch: { email: "cliente.dada.local" },
      error: "BAD_EMAIL",
    },
    {
      name: "…nor is a bare local part, nor a dotless domain",
      patch: { email: "cliente@dada" },
      error: "BAD_EMAIL",
    },
    { name: "an empty email", patch: { email: "   " }, error: "BAD_EMAIL" },
    { name: "a missing email", patch: { email: undefined }, error: "BAD_EMAIL" },
    {
      name: "an email with a space in it",
      patch: { email: "cliente @dada.local" },
      error: "BAD_EMAIL",
    },
    {
      name: `a password shorter than ${MIN_PASSWORD_LENGTH}`,
      patch: { password: "a".repeat(MIN_PASSWORD_LENGTH - 1) },
      error: "BAD_PASSWORD",
    },
    { name: "no password at all", patch: { password: "" }, error: "BAD_PASSWORD" },
    {
      // bcrypt truncates at 72 bytes and GoTrue rejects longer ones outright;
      // catching it here costs one comparison and saves an opaque auth error.
      name: `a password longer than ${MAX_PASSWORD_BYTES} bytes`,
      patch: { password: "a".repeat(MAX_PASSWORD_BYTES + 1) },
      error: "BAD_PASSWORD",
    },
    {
      // 25 Chinese characters are 75 bytes: a `.length` ceiling waves this
      // through and GoTrue answers with a 422 nobody can act on. Half the staff
      // of this deployment type Chinese, so this is the realistic case.
      name: "a 25-character Chinese passphrase — 75 bytes, not 25",
      patch: { password: "长".repeat(25) },
      error: "BAD_PASSWORD",
    },
    { name: "an empty display name", patch: { displayName: "" }, error: "BAD_NAME" },
    {
      name: `a display name one character past ${MAX_NAME_LENGTH}`,
      patch: { displayName: "名".repeat(MAX_NAME_LENGTH + 1) },
      error: "BAD_NAME",
    },
    {
      // 255 is one past what `auth.users.email` will take.
      name: "an email one character past the RFC ceiling",
      patch: { email: `${"a".repeat(255 - "@dada.local".length)}@dada.local` },
      error: "BAD_EMAIL",
    },
    {
      name: "a display name of only whitespace",
      patch: { displayName: "   " },
      error: "BAD_NAME",
    },
    {
      name: "a display name longer than the form allows",
      patch: { displayName: "名".repeat(200) },
      error: "BAD_NAME",
    },
    {
      // Both branches filled in means the form is lying about which one the
      // user chose; picking one for them would create the wrong company.
      name: "both an existing company and a new one",
      patch: { newCompany: { name: "陈记餐厅", codcli: "4501", tarcli: "3" } },
      error: "BAD_COMPANY",
    },
    {
      name: "neither an existing company nor a new one",
      patch: { companyId: undefined },
      error: "BAD_COMPANY",
    },
    { name: "an empty company id", patch: { companyId: "  " }, error: "BAD_COMPANY" },
    {
      name: "a company id that is not a uuid",
      patch: { companyId: "4501" },
      error: "BAD_COMPANY",
    },
    {
      name: "a new company with no name",
      patch: { companyId: undefined, newCompany: { name: " ", codcli: "4501", tarcli: "3" } },
      error: "BAD_COMPANY",
    },
    {
      name: "a codcli of zero",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "0", tarcli: "3" } },
      error: "BAD_CODCLI",
    },
    {
      name: "a negative codcli",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "-3", tarcli: "3" } },
      error: "BAD_CODCLI",
    },
    {
      name: "a fractional codcli",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "4.5", tarcli: "3" } },
      error: "BAD_CODCLI",
    },
    {
      name: "a codcli that is not a number",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "45O1", tarcli: "3" } },
      error: "BAD_CODCLI",
    },
    {
      name: "a missing codcli",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "", tarcli: "3" } },
      error: "BAD_CODCLI",
    },
    {
      // `companies.codcli` is `integer`; a value past 2^31-1 is a cast error in
      // Postgres, not a big customer number.
      name: "a codcli past what an integer column holds",
      patch: {
        companyId: undefined,
        newCompany: { name: "陈记餐厅", codcli: "2147483648", tarcli: "3" },
      },
      error: "BAD_CODCLI",
    },
    {
      name: "a tarifa below the range",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "4501", tarcli: "0" } },
      error: "BAD_TARCLI",
    },
    {
      name: "a tarifa above the range",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "4501", tarcli: "7" } },
      error: "BAD_TARCLI",
    },
    {
      name: "a fractional tarifa",
      patch: {
        companyId: undefined,
        newCompany: { name: "陈记餐厅", codcli: "4501", tarcli: "2.5" },
      },
      error: "BAD_TARCLI",
    },
    {
      // The column defaults to 1, but a missing select means a crafted POST —
      // defaulting silently would put a customer on the wrong price tier.
      name: "a missing tarifa",
      patch: { companyId: undefined, newCompany: { name: "陈记餐厅", codcli: "4501" } },
      error: "BAD_TARCLI",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(validateNewCustomer({ ...CUSTOMER, ...testCase.patch })).toEqual({
        ok: false,
        error: testCase.error,
      });
    });
  }

  it("reports the first bad field in form order, not a list", () => {
    // The UI shows one message; naming the topmost problem sends the user to the
    // field they will fix first, and the next submit names the next one.
    expect(
      validateNewCustomer({
        email: "nope",
        password: "x",
        displayName: "",
        companyId: "nope",
      }),
    ).toEqual({ ok: false, error: "BAD_EMAIL" });
  });

  it("survives values a form can carry but a person cannot type", () => {
    // FormData entries are `string | File`; a crafted POST can send either.
    expect(
      validateNewCustomer({
        email: { toString: () => "cliente@dada.local" },
        password: 12345678,
        displayName: ["王"],
        companyId: UUID,
      }),
    ).toEqual({ ok: false, error: "BAD_EMAIL" });
  });
});

describe("validateNewStaff", () => {
  it("normalises a staff submission", () => {
    expect(
      validateNewStaff({
        email: " Nuevo@DADA.es ",
        password: "una-clave-larga",
        displayName: " Marta ",
        role: "owner",
      }),
    ).toEqual({
      ok: true,
      value: {
        email: "nuevo@dada.es",
        password: "una-clave-larga",
        displayName: "Marta",
        role: "owner",
      },
    });
  });

  const cases: Array<{ name: string; patch: Partial<RawStaffInput>; error: string }> = [
    { name: "an email without @", patch: { email: "nuevo.dada.es" }, error: "BAD_EMAIL" },
    {
      name: "a short password",
      patch: { password: "a".repeat(MIN_PASSWORD_LENGTH - 1) },
      error: "BAD_PASSWORD",
    },
    { name: "an empty display name", patch: { displayName: " " }, error: "BAD_NAME" },
    { name: "a role nobody has", patch: { role: "admin" }, error: "BAD_ROLE" },
    {
      // 'superuser' is what a well-meaning form could send for 超级管理员; the
      // column's check constraint spells it 'owner'.
      name: "a role the check constraint would reject",
      patch: { role: "superuser" },
      error: "BAD_ROLE",
    },
    { name: "no role at all", patch: { role: undefined }, error: "BAD_ROLE" },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(validateNewStaff({ ...STAFF, ...testCase.patch })).toEqual({
        ok: false,
        error: testCase.error,
      });
    });
  }

  it("accepts each of the three roles", () => {
    for (const role of STAFF_ROLES) {
      const result = validateNewStaff({ ...STAFF, role });
      expect(result.ok && result.value.role).toBe(role);
    }
  });
});

describe("assertNotSelf", () => {
  it("refuses when the actor is the target — the lockout guard", () => {
    // An owner who demotes or deactivates their own row locks the only account
    // that can undo it out of the back office. The DB cannot see the intent, so
    // this is the only thing standing between them and a support call.
    expect(assertNotSelf(UUID, UUID)).toEqual({ ok: false, error: "SELF_FORBIDDEN" });
  });

  it("compares the way Postgres compares uuids: case and space insensitive", () => {
    // A crafted POST can spell the same uuid in upper case, and `uuid` equality
    // in Postgres would still match the row. A case-sensitive guard here would
    // wave that through.
    expect(assertNotSelf(UUID, UUID.toUpperCase())).toEqual({
      ok: false,
      error: "SELF_FORBIDDEN",
    });
    expect(assertNotSelf(UUID, ` ${UUID} `)).toEqual({ ok: false, error: "SELF_FORBIDDEN" });
  });

  it("passes a different account through, with the target id as its value", () => {
    expect(assertNotSelf(UUID, ` ${OTHER_UUID} `)).toEqual({
      ok: true,
      value: OTHER_UUID,
    });
  });

  it("refuses a target that is not a uuid rather than sending it to Postgres", () => {
    for (const target of ["", "   ", "not-a-uuid", null, undefined, 7]) {
      expect(assertNotSelf(UUID, target)).toEqual({ ok: false, error: "BAD_TARGET" });
    }
  });

  it("refuses when the ACTOR id is missing — an unknown actor cannot be cleared", () => {
    // Fails closed: without an actor id the guard cannot prove the target is
    // someone else, and 'cannot prove' is not 'go ahead'.
    expect(assertNotSelf("", UUID)).toEqual({ ok: false, error: "SELF_FORBIDDEN" });
  });
});

describe("describeDbError", () => {
  it("flattens the fields an operator needs into one line", () => {
    // On the { data, error } path PostgREST hands back a PLAIN OBJECT, not the
    // PostgrestError class it is typed as, so it stringifies to [object Object]
    // and `instanceof Error` is false. Same flattening as scripts/create-user.ts.
    expect(
      describeDbError({
        message: 'duplicate key value violates unique constraint "companies_codcli_key"',
        code: "23505",
        details: "Key (codcli)=(4501) already exists.",
        hint: null,
      }),
    ).toBe(
      'duplicate key value violates unique constraint "companies_codcli_key" | code 23505 | Key (codcli)=(4501) already exists.',
    );
  });

  it("never returns the empty-object stringification, whatever it is handed", () => {
    for (const error of [null, undefined, {}, { message: "" }]) {
      expect(describeDbError(error)).not.toContain("[object Object]");
    }
    expect(describeDbError({ message: "boom" })).toBe("boom");
  });
});

describe("classifyDbError", () => {
  const cases: Array<{ name: string; error: unknown; code: string }> = [
    {
      name: "a taken codcli is named, not buried in a constraint name",
      error: {
        message: 'duplicate key value violates unique constraint "companies_codcli_key"',
        code: "23505",
        details: "Key (codcli)=(4501) already exists.",
        hint: null,
      },
      code: "CODCLI_TAKEN",
    },
    {
      // The role-exclusivity trigger raises USER_ROLE_CONFLICT with errcode
      // 23505 too, so it MUST be recognised before the unique-violation branch.
      name: "the role-exclusivity trigger is a role conflict, not a duplicate key",
      error: { message: "USER_ROLE_CONFLICT", code: "23505", details: null, hint: null },
      code: "ROLE_CONFLICT",
    },
    {
      name: "…by its constraint name as well as by its message",
      error: {
        message: 'duplicate key value violates unique constraint "auth_user_role_exclusive"',
        code: "23505",
      },
      code: "ROLE_CONFLICT",
    },
    {
      name: "a dangling company_id is a bad company choice",
      error: {
        message:
          'insert or update on table "portal_users" violates foreign key constraint "portal_users_company_id_fkey"',
        code: "23503",
        details: 'Key (company_id)=(11111111-1111-4111-8111-111111111111) is not present in table "companies".',
      },
      code: "BAD_COMPANY",
    },
    {
      name: "a revoked grant is nobody's form field",
      error: { message: "permission denied for table staff_users", code: "42501" },
      code: "DB_ERROR",
    },
    {
      name: "another duplicate key is not the codcli one",
      error: {
        message: 'duplicate key value violates unique constraint "portal_users_pkey"',
        code: "23505",
        details: "Key (id)=(11111111-1111-4111-8111-111111111111) already exists.",
      },
      code: "DB_ERROR",
    },
    { name: "no error object at all", error: null, code: "DB_ERROR" },
    { name: "an error with nothing in it", error: {}, code: "DB_ERROR" },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(classifyDbError(testCase.error)).toBe(testCase.code);
    });
  }
});

describe("classifyCreateUserError", () => {
  it("names an address that already has an account", () => {
    // The one failure a staff member can fix themselves, and the one GoTrue
    // spells four different ways across versions.
    expect(classifyCreateUserError({ code: "email_exists", status: 422 })).toBe("EMAIL_TAKEN");
    expect(classifyCreateUserError({ code: "user_already_exists", status: 422 })).toBe(
      "EMAIL_TAKEN",
    );
    expect(
      classifyCreateUserError({
        message: "A user with this email address has already been registered",
        status: 422,
      }),
    ).toBe("EMAIL_TAKEN");
  });

  it("maps the password and email complaints back onto the form fields", () => {
    expect(classifyCreateUserError({ code: "weak_password", status: 422 })).toBe("BAD_PASSWORD");
    expect(classifyCreateUserError({ code: "email_address_invalid", status: 400 })).toBe(
      "BAD_EMAIL",
    );
  });

  it("recognises the 72-byte ceiling, which GoTrue does not call weak_password", () => {
    // `validateAccountFields` should stop these first; this is the second line,
    // for a GoTrue whose byte counting disagrees with ours. It arrives as a
    // generic `validation_failed` with the answer in the prose.
    expect(
      classifyCreateUserError({
        code: "validation_failed",
        status: 422,
        message: "Password cannot be longer than 72 characters",
      }),
    ).toBe("BAD_PASSWORD");
    expect(
      classifyCreateUserError({
        status: 422,
        message: "password is too long",
      }),
    ).toBe("BAD_PASSWORD");
  });

  it("does not claim the password field for every validation_failed", () => {
    // The same code covers complaints that name no field this form has; a guess
    // here sends a staff member to retype a password that was never the problem.
    expect(
      classifyCreateUserError({
        code: "validation_failed",
        status: 422,
        message: "Only an email address or phone number should be provided on signup.",
      }),
    ).toBe("AUTH_ERROR");
  });

  it("keeps everything else as one auth failure, not as a guess", () => {
    for (const error of [
      { message: "fetch failed" },
      { status: 500, message: "Internal Server Error" },
      {},
      null,
    ]) {
      expect(classifyCreateUserError(error)).toBe("AUTH_ERROR");
    }
  });
});

describe("isUserAdminError", () => {
  it("recognises the codes the page may read back out of the URL", () => {
    // The result of every action travels as a query parameter, so the page has
    // to check it before using it as a message key.
    for (const code of [
      "BAD_EMAIL",
      "BAD_PASSWORD",
      "BAD_NAME",
      "BAD_COMPANY",
      "BAD_CODCLI",
      "BAD_TARCLI",
      "BAD_ROLE",
      "BAD_KIND",
      "BAD_TARGET",
      "SELF_FORBIDDEN",
      "EMAIL_TAKEN",
      "CODCLI_TAKEN",
      "ROLE_CONFLICT",
      "NOT_FOUND",
      "AUTH_ERROR",
      "DB_ERROR",
    ]) {
      expect(isUserAdminError(code)).toBe(true);
    }
    for (const code of ["ok", "", "bad_email", "<script>", "DROP TABLE"]) {
      expect(isUserAdminError(code)).toBe(false);
    }
  });
});
