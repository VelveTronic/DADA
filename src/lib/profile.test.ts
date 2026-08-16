import { describe, expect, it } from "vitest";
import {
  classifyPasswordUpdateError,
  classifyReauthError,
  describeAuthError,
  isProfileResult,
  PROFILE_ERRORS,
  validateDisplayName,
  validatePasswordChange,
  type RawPasswordChange,
} from "./profile";
import {
  MAX_NAME_LENGTH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from "./user-admin";

/** A well-formed change: the current password, and a new one typed twice. */
const CHANGE: RawPasswordChange = {
  current: "la-clave-de-antes",
  next: "la-clave-nueva",
  confirm: "la-clave-nueva",
};

describe("validateDisplayName", () => {
  it("accepts a name and trims the whitespace around it", () => {
    expect(validateDisplayName("  陈记餐厅 老板  ")).toEqual({
      ok: true,
      value: "陈记餐厅 老板",
    });
  });

  it("accepts a name at exactly the shared ceiling", () => {
    const name = "a".repeat(MAX_NAME_LENGTH);
    expect(validateDisplayName(name)).toEqual({ ok: true, value: name });
  });

  it("refuses one character past it", () => {
    expect(validateDisplayName("a".repeat(MAX_NAME_LENGTH + 1))).toEqual({
      ok: false,
      error: "BAD_NAME",
    });
  });

  /**
   * The whole point of refusing rather than writing null: a cleared box would
   * otherwise fall the header back to the company name with nothing said.
   */
  it.each([["", "empty"], ["   ", "spaces only"]])(
    "refuses %j (%s)",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, error: "BAD_NAME" });
    },
  );

  /** A `FormData` value can be a File, and `String(file)` is "[object File]". */
  it.each([undefined, null, 42, {}])(
    "refuses %j rather than coercing it into a name",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, error: "BAD_NAME" });
    },
  );
});

describe("validatePasswordChange", () => {
  it("hands back both passwords when the form is well-formed", () => {
    expect(validatePasswordChange(CHANGE)).toEqual({
      ok: true,
      value: { current: "la-clave-de-antes", next: "la-clave-nueva" },
    });
  });

  /**
   * Spaces are characters in a password. Trimming would set a password that is
   * not the one typed — and then refuse every login with it.
   */
  it("does not trim either password", () => {
    const padded = validatePasswordChange({
      current: " vieja-clave ",
      next: " nueva-clave ",
      confirm: " nueva-clave ",
    });
    expect(padded).toEqual({
      ok: true,
      value: { current: " vieja-clave ", next: " nueva-clave " },
    });
  });

  it.each([undefined, "", null, 123])(
    "answers WRONG_PASSWORD when the current box is %j, with no round trip",
    (current) => {
      expect(validatePasswordChange({ ...CHANGE, current })).toEqual({
        ok: false,
        error: "WRONG_PASSWORD",
      });
    },
  );

  it("refuses a new password one character below the shared floor", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(
      validatePasswordChange({ ...CHANGE, next: short, confirm: short }),
    ).toEqual({ ok: false, error: "BAD_PASSWORD" });
  });

  it("accepts one exactly at it", () => {
    const floor = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(
      validatePasswordChange({ ...CHANGE, next: floor, confirm: floor }),
    ).toEqual({ ok: true, value: { current: CHANGE.current, next: floor } });
  });

  /**
   * The ceiling counts BYTES because bcrypt does: 25 Chinese characters are 75
   * bytes, and GoTrue answers that with an opaque 422 rather than a field.
   */
  it("refuses a new password past the 72-BYTE ceiling even when it is short in characters", () => {
    const long = "密".repeat(25);
    expect(long.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(
      validatePasswordChange({ ...CHANGE, next: long, confirm: long }),
    ).toEqual({ ok: false, error: "BAD_PASSWORD" });
  });

  it("refuses two new-password boxes that disagree", () => {
    expect(
      validatePasswordChange({ ...CHANGE, confirm: "la-clave-nuevaa" }),
    ).toEqual({ ok: false, error: "PASSWORD_MISMATCH" });
  });

  /** Caught here, not left to a project setting this app does not control. */
  it("refuses a new password identical to the current one", () => {
    expect(
      validatePasswordChange({
        current: "la-clave-de-antes",
        next: "la-clave-de-antes",
        confirm: "la-clave-de-antes",
      }),
    ).toEqual({ ok: false, error: "SAME_PASSWORD" });
  });

  /** Topmost field first: an unusable new password is named before the retype. */
  it("names the new password before the mismatch when both are wrong", () => {
    expect(
      validatePasswordChange({ ...CHANGE, next: "corta", confirm: "otra" }),
    ).toEqual({ ok: false, error: "BAD_PASSWORD" });
  });
});

describe("classifyReauthError", () => {
  /** The GoTrue code, and the prose for a version that sends no code. */
  it.each([
    { code: "invalid_credentials" },
    { code: "invalid_grant" },
    { message: "Invalid login credentials" },
  ])("reads %j as WRONG_PASSWORD", (error) => {
    expect(classifyReauthError(error)).toBe("WRONG_PASSWORD");
  });

  /**
   * Telling somebody their password is wrong when Auth is merely rate-limiting
   * them sends them to reset a password that was never the problem.
   */
  it.each([
    [{ code: "over_request_rate_limit", message: "Too many requests" }],
    [{ code: "unexpected_failure" }],
    [null],
  ])("keeps %j as AUTH_ERROR", (error) => {
    expect(classifyReauthError(error)).toBe("AUTH_ERROR");
  });
});

describe("classifyPasswordUpdateError", () => {
  it.each([
    [{ code: "same_password" }, "SAME_PASSWORD"],
    [
      { message: "New password should be different from the old password." },
      "SAME_PASSWORD",
    ],
    [{ code: "weak_password", message: "Password is too weak" }, "BAD_PASSWORD"],
    [
      {
        code: "validation_failed",
        message: "Password cannot be longer than 72 characters",
      },
      "BAD_PASSWORD",
    ],
    [
      { code: "validation_failed", message: "password does not meet the policy" },
      "BAD_PASSWORD",
    ],
    [{ code: "unexpected_failure" }, "AUTH_ERROR"],
    [undefined, "AUTH_ERROR"],
  ])("maps %j to %s", (error, expected) => {
    expect(classifyPasswordUpdateError(error)).toBe(expected);
  });

  /**
   * `validation_failed` also covers complaints that are not about the password
   * at all, so the message has to name it before the field is blamed.
   */
  it("does not blame the password for an unrelated validation_failed", () => {
    expect(
      classifyPasswordUpdateError({
        code: "validation_failed",
        message: "Only an email address or phone number should be provided",
      }),
    ).toBe("AUTH_ERROR");
  });
});

describe("describeAuthError", () => {
  it("joins the message and the code, and reads nothing else off the object", () => {
    expect(
      describeAuthError({
        message: "Invalid login credentials",
        code: "invalid_credentials",
        // Whatever a future client attaches stays out of the log line.
        password: "no-debe-aparecer",
      }),
    ).toBe("Invalid login credentials | code invalid_credentials");
  });

  it.each([
    [{}, ""],
    [null, ""],
    ["a string", ""],
    [{ message: "Auth is down" }, "Auth is down"],
  ])("survives %j", (error, expected) => {
    expect(describeAuthError(error)).toBe(expected);
  });
});

describe("isProfileResult", () => {
  it.each([...PROFILE_ERRORS, "ok"])("accepts %s", (value) => {
    expect(isProfileResult(value)).toBe(true);
  });

  it.each(["", "OK", "BAD", "__proto__", "toString"])(
    "refuses %j, so the URL cannot pick the banner",
    (value) => {
      expect(isProfileResult(value)).toBe(false);
    },
  );
});
