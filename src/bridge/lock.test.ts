import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCK_STALE_MS,
  LockError,
  acquireLock,
  formatLockBody,
  isStaleLock,
  lockAgeMs,
  observeLock,
  parseLockBody,
} from "./lock";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dada-bridge-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-08-16T10:00:00.000Z");

describe("parseLockBody", () => {
  it("round-trips a body it wrote", () => {
    const body = { job: "orders", pid: 4242, startedAt: NOW.toISOString() };
    expect(parseLockBody(formatLockBody(body))).toEqual(body);
  });

  it("returns null rather than throwing on a body a crash truncated", () => {
    expect(parseLockBody('{"job":"orders","pi')).toBeNull();
    expect(parseLockBody("")).toBeNull();
    expect(parseLockBody("not json at all")).toBeNull();
  });

  it("returns null when a field is missing or the wrong type", () => {
    expect(parseLockBody('{"job":"orders","pid":1}')).toBeNull();
    expect(parseLockBody('{"job":"orders","pid":"1","startedAt":"x"}')).toBeNull();
    expect(parseLockBody("[1,2,3]")).toBeNull();
    expect(parseLockBody("null")).toBeNull();
  });
});

describe("lockAgeMs", () => {
  const nowMs = NOW.getTime();

  it("measures from the timestamp the holder wrote", () => {
    const observed = {
      body: { job: "orders", pid: 1, startedAt: "2026-08-16T09:55:00.000Z" },
      mtimeMs: 0,
    };
    expect(lockAgeMs(observed, nowMs)).toBe(5 * 60 * 1000);
  });

  it("falls back to mtime when the body is unreadable", () => {
    expect(lockAgeMs({ body: null, mtimeMs: nowMs - 90_000 }, nowMs)).toBe(90_000);
  });

  it("falls back to mtime when startedAt is not a date", () => {
    const observed = {
      body: { job: "orders", pid: 1, startedAt: "yesterday" },
      mtimeMs: nowMs - 1_000,
    };
    expect(lockAgeMs(observed, nowMs)).toBe(1_000);
  });
});

describe("isStaleLock", () => {
  const nowMs = NOW.getTime();
  const at = (ageMs: number) => ({
    body: { job: "orders", pid: 1, startedAt: new Date(nowMs - ageMs).toISOString() },
    mtimeMs: nowMs - ageMs,
  });

  it("holds a lock younger than the threshold", () => {
    expect(isStaleLock(at(LOCK_STALE_MS - 1), nowMs)).toBe(false);
  });

  it("takes over a lock at or past the threshold", () => {
    expect(isStaleLock(at(LOCK_STALE_MS), nowMs)).toBe(true);
    expect(isStaleLock(at(LOCK_STALE_MS + 1), nowMs)).toBe(true);
  });

  it("treats a file that is no longer there as stale", () => {
    expect(isStaleLock(null, nowMs)).toBe(true);
  });

  it("does NOT take over a lock stamped in the future", () => {
    // A backwards clock adjustment on the ERP server must not let two runs at
    // the ERP at once; the safe failure is "still held".
    expect(isStaleLock(at(-60 * 60 * 1000), nowMs)).toBe(false);
  });

  it("honours a caller's threshold", () => {
    expect(isStaleLock(at(5_000), nowMs, 1_000)).toBe(true);
    expect(isStaleLock(at(5_000), nowMs, 10_000)).toBe(false);
  });
});

describe("acquireLock", () => {
  it("creates <job>.lock beside the bundle and names the holder", () => {
    const dir = tempDir();
    const lock = acquireLock(dir, "orders", { now: () => NOW, pid: 777 });

    expect(lock.path).toBe(join(dir, "orders.lock"));
    expect(parseLockBody(readFileSync(lock.path, "utf8"))).toEqual({
      job: "orders",
      pid: 777,
      startedAt: NOW.toISOString(),
    });
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("refuses a second run of the same job", () => {
    const dir = tempDir();
    acquireLock(dir, "orders", { now: () => NOW, pid: 777 });

    try {
      acquireLock(dir, "orders", { now: () => NOW });
      expect.unreachable("the second acquire must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LockError);
      expect((error as LockError).code).toBe("LOCK_HELD");
      // The operator has to be able to see who to blame.
      expect((error as LockError).message).toContain("777");
    }
  });

  it("lets a DIFFERENT job run at the same time", () => {
    const dir = tempDir();
    const orders = acquireLock(dir, "orders", { now: () => NOW });
    const prices = acquireLock(dir, "price-sync", { now: () => NOW });

    expect(orders.path).not.toBe(prices.path);
    expect(existsSync(prices.path)).toBe(true);
  });

  it("takes over a lock a crashed run left behind, and says so", () => {
    const dir = tempDir();
    const stale = join(dir, "orders.lock");
    writeFileSync(
      stale,
      formatLockBody({
        job: "orders",
        pid: 111,
        startedAt: new Date(NOW.getTime() - LOCK_STALE_MS - 1).toISOString(),
      }),
    );
    const warnings: { message: string; fields: unknown }[] = [];

    const lock = acquireLock(dir, "orders", {
      now: () => NOW,
      pid: 222,
      log: { warn: (message, fields) => warnings.push({ message, fields }) },
    });

    expect(parseLockBody(readFileSync(lock.path, "utf8"))?.pid).toBe(222);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("stale lock");
  });

  it("releases idempotently, even after the file was deleted by hand", () => {
    const dir = tempDir();
    const lock = acquireLock(dir, "orders", { now: () => NOW });
    rmSync(lock.path);
    expect(() => {
      lock.release();
      lock.release();
    }).not.toThrow();
  });

  it("reports an undirectable lock path as LOCK_UNWRITABLE", () => {
    const dir = join(tempDir(), "does", "not", "exist");
    try {
      acquireLock(dir, "orders", { now: () => NOW });
      expect.unreachable("a missing directory must throw");
    } catch (error) {
      expect((error as LockError).code).toBe("LOCK_UNWRITABLE");
    }
  });
});

describe("observeLock", () => {
  it("returns null when there is no lock file", () => {
    expect(observeLock(join(tempDir(), "orders.lock"))).toBeNull();
  });

  it("reports an unparseable body with a usable mtime", () => {
    const dir = tempDir();
    const path = join(dir, "orders.lock");
    writeFileSync(path, "half a jso");
    const observed = observeLock(path);

    expect(observed?.body).toBeNull();
    expect(observed?.mtimeMs).toBeGreaterThan(0);
  });
});
