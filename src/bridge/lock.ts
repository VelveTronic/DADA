/**
 * The singleton lock: one run of one job at a time, on one box.
 *
 * Task Scheduler fires `orders` every minute and does NOT wait for the previous
 * run to finish. Two concurrent runs would each call `bridge_claim_confirmed`
 * with their own token — the RPC's FOR UPDATE SKIP LOCKED keeps them off each
 * other's rows, so nothing corrupts, but the second run would open a second
 * SERIALIZABLE transaction against the same `newcontador` rows and the pair
 * would sit there blocking each other for no gain. One lock, one run.
 *
 * The lock is a FILE beside the bundle rather than a mutex or a socket for one
 * reason: after a crash (or a `taskkill`) the operator can see it, read who held
 * it and since when, and delete it. A named mutex leaves nothing behind to look
 * at, and a lock nobody can inspect is a lock somebody eventually reboots for.
 *
 * Staleness is the other half of that bargain: a crashed run leaves its file
 * forever, so a lock older than `LOCK_STALE_MS` is taken over. Thirty minutes is
 * far longer than any healthy run (the orders job is seconds; price-sync is a
 * few minutes over ~3k articles) and far shorter than a working day.
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log";

/** Older than this and the holder is presumed dead. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/** Named failure so main can report the reason without inspecting a message. */
export class LockError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "LockError";
    this.code = code;
    this.path = path;
  }
}

/** What a lock file says about its holder. Written as one line of JSON. */
export interface LockBody {
  job: string;
  pid: number;
  startedAt: string;
}

/** A held lock. `release` is idempotent and never throws. */
export interface Lock {
  path: string;
  release(): void;
}

export interface LockOptions {
  staleMs?: number;
  now?: () => Date;
  /** Told when a stale lock is taken over — an event worth seeing in the log. */
  log?: Pick<Logger, "warn">;
  pid?: number;
}

/**
 * What we could observe about an existing lock file: the timestamp it claims,
 * and the timestamp the filesystem gives it.
 *
 * Both, because they fail differently. A crash mid-write leaves a truncated body
 * with no usable `startedAt`, and mtime still dates the file. A file copied or
 * restored by hand carries a misleading mtime, and the body still names the run.
 */
export interface LockObservation {
  body: LockBody | null;
  mtimeMs: number;
}

export function formatLockBody(body: LockBody): string {
  return `${JSON.stringify(body)}\n`;
}

/**
 * Parse a lock body, or null if it is not one. Never throws: this runs on the
 * contents of a file another process may have been killed halfway through
 * writing, and "unreadable" has to fall back to mtime rather than fail the run.
 */
export function parseLockBody(text: string): LockBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Partial<LockBody>;
  if (typeof body.job !== "string" || typeof body.startedAt !== "string") return null;
  if (typeof body.pid !== "number") return null;
  return { job: body.job, pid: body.pid, startedAt: body.startedAt };
}

/**
 * How long the observed lock has been held, in milliseconds.
 *
 * The body's own `startedAt` wins over mtime, because it is what the holder
 * meant; mtime is the fallback for a body we could not read. A `startedAt` that
 * does not parse as a date is treated as no timestamp at all.
 */
export function lockAgeMs(observed: LockObservation, nowMs: number): number {
  const claimed = observed.body ? Date.parse(observed.body.startedAt) : Number.NaN;
  const startedMs = Number.isNaN(claimed) ? observed.mtimeMs : claimed;
  return nowMs - startedMs;
}

/**
 * Is this lock old enough to take over?
 *
 * `null` — no file where the caller just saw one — is stale by definition: a
 * lock we cannot see is not a lock.
 *
 * A NEGATIVE age (a lock stamped in the future) is deliberately NOT stale. The
 * ERP server's clock is in another timezone and has been adjusted before; a
 * clock that jumped backwards must not turn every live lock into a stale one and
 * let two runs at the ERP at once. The failure mode is the safe one: the
 * operator sees "lock held" until the file's own time passes.
 */
export function isStaleLock(
  observed: LockObservation | null,
  nowMs: number,
  staleMs: number = LOCK_STALE_MS,
): boolean {
  if (!observed) return true;
  return lockAgeMs(observed, nowMs) >= staleMs;
}

/** Read a lock file, or null if it is not there any more. */
export function observeLock(lockPath: string): LockObservation | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
  return { body: parseLockBody(text), mtimeMs };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Take `<dir>/<job>.lock` or throw.
 *
 * `wx` is the whole mechanism: an exclusive create is atomic in the filesystem,
 * so two processes racing for the same lock cannot both win it.
 *
 * The known gap is the stale takeover: between unlinking a dead lock and
 * creating ours, another run could do the same. Closing that needs a rename
 * dance for a case that requires two runs to start within milliseconds of each
 * other AFTER a crash left a 30-minute-old file — a race we would never observe
 * and could never test. The second create is still exclusive, so the loser gets
 * LOCK_HELD rather than a shared lock.
 */
export function acquireLock(dir: string, job: string, options: LockOptions = {}): Lock {
  const {
    staleMs = LOCK_STALE_MS,
    now = () => new Date(),
    log,
    pid = process.pid,
  } = options;
  const lockPath = join(dir, `${job}.lock`);

  const create = (): number | null => {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) return null;
      throw new LockError(
        "LOCK_UNWRITABLE",
        lockPath,
        `cannot create the lock file: ${describe(error)}`,
      );
    }
  };

  let fd = create();
  if (fd === null) {
    const observed = observeLock(lockPath);
    if (!isStaleLock(observed, now().getTime(), staleMs)) {
      const holder = observed?.body;
      throw new LockError(
        "LOCK_HELD",
        lockPath,
        `${job} is already running` +
          (holder ? ` (pid ${holder.pid}, since ${holder.startedAt})` : ""),
      );
    }
    log?.warn("stale lock taken over", {
      job,
      path: lockPath,
      heldSince: observed?.body?.startedAt,
      heldByPid: observed?.body?.pid,
      ageMs: observed ? lockAgeMs(observed, now().getTime()) : null,
    });
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw new LockError(
          "LOCK_UNWRITABLE",
          lockPath,
          `cannot remove the stale lock file: ${describe(error)}`,
        );
      }
    }
    fd = create();
    if (fd === null) {
      throw new LockError(
        "LOCK_HELD",
        lockPath,
        `${job} was taken by another run while the stale lock was being cleared`,
      );
    }
  }

  try {
    writeSync(fd, formatLockBody({ job, pid, startedAt: now().toISOString() }));
  } finally {
    closeSync(fd);
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      // Idempotent and silent: release runs in a `finally`, and a lock file that
      // is already gone (an operator deleted it mid-run) is not a reason to turn
      // a completed run into a failed one.
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}
