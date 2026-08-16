import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, describeError, formatLogLine, redactSecrets } from "./log";
import { InjectError } from "./injector";

const AT = "2026-08-16T08:00:00.000Z";
const now = () => new Date(AT);

const tempDirs: string[] = [];
function tempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dada-bridge-log-"));
  tempDirs.push(dir);
  return join(dir, "bridge.log");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("redactSecrets", () => {
  it("masks every occurrence of every secret", () => {
    expect(redactSecrets("key=abc and again abc", ["abc"])).toBe("key=*** and again ***");
  });

  it("masks the longest secret first, so no fragment survives", () => {
    expect(redactSecrets("sb_secret_long", ["sb_secret", "sb_secret_long"])).toBe("***");
  });

  it("ignores empty secrets rather than shredding the line", () => {
    expect(redactSecrets("hello", ["", "x"])).toBe("hello");
  });
});

describe("formatLogLine", () => {
  it("puts the timestamp, level and message first, then key=value fields", () => {
    expect(formatLogLine(AT, "INFO", "claimed", { orders: 3, job: "orders" })).toBe(
      `${AT} INFO claimed orders=3 job=orders`,
    );
  });

  it("quotes a value containing whitespace or a quote", () => {
    expect(formatLogLine(AT, "WARN", "x", { note: "two words" })).toBe(
      `${AT} WARN x note="two words"`,
    );
  });

  it("drops null and undefined fields instead of printing them", () => {
    expect(formatLogLine(AT, "INFO", "x", { a: 1, b: null, c: undefined })).toBe(
      `${AT} INFO x a=1`,
    );
  });

  it("keeps one event on one line", () => {
    const line = formatLogLine(AT, "ERROR", "broke\nbadly", { stack: "a\nb" });
    expect(line.includes("\n")).toBe(false);
  });

  it("JSON-encodes objects rather than printing [object Object]", () => {
    expect(formatLogLine(AT, "INFO", "x", { detail: { a: 1 } })).toContain('{\\"a\\":1}');
  });
});

describe("describeError", () => {
  it("flattens an InjectError into its code and order context", () => {
    const fields = describeError(
      new InjectError("CONTRACT", "cabecera", {
        orderId: "id",
        orderNumber: 4242,
        ref: "PORTAL-4242",
      }),
    );
    expect(fields.code).toBe("CONTRACT");
    expect(fields.error).toContain("PORTAL-4242");
  });

  it("follows the cause one level, so the wrapper does not hide the reason", () => {
    const cause = new Error("deadlock victim");
    const fields = describeError(new Error("inject failed", { cause }));
    expect(fields.cause).toBe("Error: deadlock victim");
  });

  it("survives a non-Error throw", () => {
    expect(describeError("plain string")).toEqual({ error: "plain string" });
  });

  it("lifts a path, so the file to delete is a field and not buried in prose", () => {
    const error = Object.assign(new Error("orders is already running"), {
      code: "LOCK_HELD",
      path: "C:\\dada\\bridge\\orders.lock",
    });
    expect(describeError(error)).toMatchObject({
      code: "LOCK_HELD",
      path: "C:\\dada\\bridge\\orders.lock",
    });
  });

  it("leaves path out when the error has none", () => {
    expect(describeError(new Error("plain"))).not.toHaveProperty("path");
  });
});

describe("createLogger", () => {
  it("writes to stderr and appends to the log file", () => {
    const filePath = tempLogPath();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createLogger({ filePath, now });

    log.info("started", { job: "orders" });
    log.warn("slow", { ms: 900 });

    expect(stderr).toHaveBeenCalledTimes(2);
    expect(readFileSync(filePath, "utf8")).toBe(
      `${AT} INFO started job=orders\n${AT} WARN slow ms=900\n`,
    );
  });

  it("never writes a secret, wherever it turns up in the line", () => {
    const filePath = tempLogPath();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createLogger({ filePath, secrets: ["sb_secret_key", "hunter2"], now });

    // The realistic leak: a library error message we do not control.
    log.logError(new Error("login failed for Password=hunter2"), { job: "orders" });
    log.info("config", { url: "https://x?apikey=sb_secret_key" });

    const written = readFileSync(filePath, "utf8");
    expect(written).not.toContain("sb_secret_key");
    expect(written).not.toContain("hunter2");
    expect(written).toContain("***");
  });

  it("keeps running on stderr when the log file cannot be written", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // A directory that does not exist: losing the file must not stop the bridge.
    const log = createLogger({ filePath: join(tmpdir(), "no-such-dir-xyz", "bridge.log"), now });
    expect(() => log.info("still alive")).not.toThrow();
    expect(() => log.info("still alive again")).not.toThrow();
    // The line itself, the one-time warning, then the second line only.
    expect(stderr).toHaveBeenCalledTimes(3);
  });

  it("logs an order-context error at ERROR with its code", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createLogger({ now });
    log.logError(
      new InjectError("INJECT_FAILED", "boom", {
        orderId: "id",
        orderNumber: 4242,
        ref: "PORTAL-4242",
      }),
      { orderNumber: 4242 },
    );
    const line = String(stderr.mock.calls[0][0]);
    expect(line).toContain("ERROR failed");
    expect(line).toContain("orderNumber=4242");
    expect(line).toContain("code=INJECT_FAILED");
  });
});
