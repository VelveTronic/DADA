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
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log";

/** Older than this and the holder is presumed dead. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * The mutation sidecar's own staleness bound.
 *
 * A sidecar is held across a re-read and an `unlink` — microseconds of work, and
 * nothing in between waits on a network or a database. Giving it the LOCK's
 * thirty minutes meant a takeover that died mid-unlink froze every later run for
 * half an hour, for a reservation whose honest lifetime is milliseconds. A
 * minute is still thousands of times longer than the work it covers.
 *
 * A caller that shortens `staleMs` for a test is shortening this too: the
 * sidecar can never outlive the lock generation it belongs to.
 */
export const MUTATION_STALE_MS = 60 * 1000;

function mutationStaleMs(staleMs: number): number {
  return Math.min(staleMs, MUTATION_STALE_MS);
}

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
  hostname: string;
  ownerToken: string;
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
  hostname?: string;
  /** Test seam; null means the platform could not safely determine liveness. */
  pidIsAlive?: (pid: number) => boolean | null;
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
  /** Identity fallback for legacy or truncated bodies that have no token. */
  fingerprint?: string;
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
  if (typeof body.pid !== "number" || !Number.isSafeInteger(body.pid) || body.pid <= 0) {
    return null;
  }
  if (typeof body.hostname !== "string" || body.hostname.length === 0) return null;
  if (typeof body.ownerToken !== "string" || body.ownerToken.length < 16) return null;
  return {
    job: body.job,
    pid: body.pid,
    startedAt: body.startedAt,
    hostname: body.hostname,
    ownerToken: body.ownerToken,
  };
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
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch {
    return null;
  }

  try {
    const text = readFileSync(fd, "utf8");
    const stat = fstatSync(fd);
    const fingerprint = createHash("sha256")
      .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:`)
      .update(text)
      .digest("hex");
    return { body: parseLockBody(text), mtimeMs: stat.mtimeMs, fingerprint };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MutationClaim {
  path: string;
  ownerToken: string;
}

function sameLockGeneration(
  first: LockObservation,
  second: LockObservation,
): boolean {
  const firstToken = first.body?.ownerToken;
  const secondToken = second.body?.ownerToken;
  if (firstToken || secondToken) return firstToken === secondToken;
  return Boolean(first.fingerprint && first.fingerprint === second.fingerprint);
}

function mutationPath(lockPath: string, observed: LockObservation): string | null {
  const identity = observed.body?.ownerToken ?? observed.fingerprint;
  if (!identity) return null;
  const generation = createHash("sha256").update(identity).digest("hex");
  return `${lockPath}.mutation-${generation}`;
}

/**
 * Atomically reserve the right to remove one exact lock generation.
 *
 * Release and stale takeover use the same deterministic sidecar name. Only one
 * of them can create it with `wx`; the winner then re-reads the main file before
 * unlinking. A sidecar left by a hard crash is reclaimed after
 * `MUTATION_STALE_MS` — its own short TTL, not the lock's — and affects only
 * that old generation, never a later lock with a different ownership token.
 */
function acquireMutationClaim(
  lockPath: string,
  job: string,
  observed: LockObservation,
  pid: number,
  hostname: string,
  now: () => Date,
  staleMs: number,
): MutationClaim | null {
  const claimPath = mutationPath(lockPath, observed);
  if (!claimPath) return null;

  const ownerToken = randomUUID();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(claimPath, "wx");
      break;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw new LockError(
          "LOCK_UNWRITABLE",
          lockPath,
          `cannot reserve lock-file mutation: ${describe(error)}`,
        );
      }

      const existing = observeLock(claimPath);
      if (!existing) continue;
      if (!isStaleLock(existing, now().getTime(), mutationStaleMs(staleMs))) {
        return null;
      }

      // Rename is the conditional removal primitive here: only one contender
      // can move the exact old sidecar away, so a new sidecar created after
      // that move cannot be deleted by the losing contender.
      const quarantinePath = `${claimPath}.reclaim-${randomUUID()}`;
      try {
        renameSync(claimPath, quarantinePath);
      } catch (reclaimError) {
        if (isErrnoCode(reclaimError, "ENOENT")) continue;
        throw new LockError(
          "LOCK_UNWRITABLE",
          lockPath,
          `cannot reclaim expired lock-file mutation: ${describe(reclaimError)}`,
        );
      }
      try {
        unlinkSync(quarantinePath);
      } catch {
        /* A quarantined sidecar cannot block this generation anymore. */
      }
    }
  }

  let writeError: unknown;
  try {
    if (fd === null) throw new Error("mutation claim was not created");
    writeSync(
      fd,
      formatLockBody({
        job: `${job}:mutation`,
        pid,
        startedAt: now().toISOString(),
        hostname,
        ownerToken,
      }),
    );
  } catch (error) {
    writeError = error;
  } finally {
    closeSync(fd);
  }

  if (writeError) {
    try {
      unlinkSync(claimPath);
    } catch {
      /* fail closed: a partial claim blocks deletion of this generation */
    }
    throw new LockError(
      "LOCK_UNWRITABLE",
      lockPath,
      `cannot write lock-file mutation claim: ${describe(writeError)}`,
    );
  }

  return { path: claimPath, ownerToken };
}

function releaseMutationClaim(claim: MutationClaim): void {
  const observed = observeLock(claim.path);
  if (observed?.body?.ownerToken !== claim.ownerToken) return;
  try {
    unlinkSync(claim.path);
  } catch {
    /* fail closed: a later attempt will not delete through an uncertain claim */
  }
}

function defaultPidIsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return false;
    if (isErrnoCode(error, "EPERM")) return true;
    return null;
  }
}

function holderMayStillBeAlive(
  observed: LockObservation,
  hostname: string,
  pidIsAlive: (pid: number) => boolean | null,
): boolean {
  const holder = observed.body;
  if (!holder || holder.hostname !== hostname) return false;
  try {
    // Unknown (permissions/platform) is deliberately fail-closed. Only a
    // definite "no such PID" permits a same-host stale takeover.
    return pidIsAlive(holder.pid) !== false;
  } catch {
    return true;
  }
}

function heldError(job: string, lockPath: string, observed: LockObservation | null): LockError {
  const holder = observed?.body;
  return new LockError(
    "LOCK_HELD",
    lockPath,
    `${job} is already running` +
      (holder ? ` (pid ${holder.pid}, since ${holder.startedAt})` : ""),
  );
}

/**
 * Take `<dir>/<job>.lock` or throw.
 *
 * `wx` is the whole mechanism: an exclusive create is atomic in the filesystem,
 * so two processes racing for the same lock cannot both win it.
 *
 * Every body carries a random ownership token. Release and stale takeover first
 * reserve mutation of that exact generation with their own `wx` sidecar, then
 * re-read the main file before unlinking it. The exclusive main-file create
 * still decides who owns the lock after a stale generation is removed.
 */
export function acquireLock(dir: string, job: string, options: LockOptions = {}): Lock {
  const {
    staleMs = LOCK_STALE_MS,
    now = () => new Date(),
    log,
    pid = process.pid,
    hostname = systemHostname(),
    pidIsAlive = defaultPidIsAlive,
  } = options;
  const lockPath = join(dir, `${job}.lock`);
  const ownerToken = randomUUID();
  let takeoverLog: { observed: LockObservation; observedAt: number } | null = null;

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

    // The file may have disappeared between EEXIST and observation. Retrying
    // the atomic create is safe and avoids treating a completed run as stale.
    if (!observed) {
      fd = create();
      if (fd === null) throw heldError(job, lockPath, observeLock(lockPath));
    } else {
      const observedAt = now().getTime();
      if (
        !isStaleLock(observed, observedAt, staleMs) ||
        holderMayStillBeAlive(observed, hostname, pidIsAlive)
      ) {
        throw heldError(job, lockPath, observed);
      }

      const claim = acquireMutationClaim(
        lockPath,
        job,
        observed,
        pid,
        hostname,
        now,
        staleMs,
      );
      if (!claim) {
        throw new LockError(
          "LOCK_HELD",
          lockPath,
          `${job} lock takeover is already in progress`,
        );
      }

      try {
        const current = observeLock(lockPath);
        if (current) {
          const currentAt = now().getTime();
          if (
            !sameLockGeneration(observed, current) ||
            !isStaleLock(current, currentAt, staleMs) ||
            holderMayStillBeAlive(current, hostname, pidIsAlive)
          ) {
            throw heldError(job, lockPath, current);
          }

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
        }

        fd = create();
        if (fd === null) {
          throw new LockError(
            "LOCK_HELD",
            lockPath,
            `${job} was taken by another run while the stale lock was being cleared`,
          );
        }
      } finally {
        releaseMutationClaim(claim);
      }

      takeoverLog = { observed, observedAt };
    }
  }

  try {
    writeSync(
      fd,
      formatLockBody({
        job,
        pid,
        startedAt: now().toISOString(),
        hostname,
        ownerToken,
      }),
    );
  } finally {
    closeSync(fd);
  }

  if (takeoverLog && log) {
    try {
      log.warn("stale lock taken over", {
        job,
        path: lockPath,
        heldSince: takeoverLog.observed.body?.startedAt,
        heldByPid: takeoverLog.observed.body?.pid,
        ageMs: lockAgeMs(takeoverLog.observed, takeoverLog.observedAt),
      });
    } catch {
      /* lock ownership must not be lost because diagnostic logging failed */
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      // Idempotent and silent: release runs in a `finally`. It deletes only the
      // generation whose unpredictable token this Lock object owns.
      if (released) return;
      released = true;

      const observed = observeLock(lockPath);
      if (observed?.body?.ownerToken !== ownerToken) return;

      let claim: MutationClaim | null;
      try {
        claim = acquireMutationClaim(
          lockPath,
          job,
          observed,
          pid,
          hostname,
          now,
          staleMs,
        );
      } catch {
        return;
      }
      if (!claim) return;

      try {
        const current = observeLock(lockPath);
        if (
          current?.body?.ownerToken !== ownerToken ||
          !sameLockGeneration(observed, current)
        ) {
          return;
        }
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone or externally protected; never delete by assumption */
        }
      } finally {
        releaseMutationClaim(claim);
      }
    },
  };
}
