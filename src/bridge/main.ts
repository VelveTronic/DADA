/**
 * The bridge CLI: one command per run, one run per lock, one heartbeat at the
 * end.
 *
 * This file is the esbuild entry point — everything the ERP server receives is
 * `dada-bridge.js`, one file with no node_modules beside it, driven by Task
 * Scheduler:
 *
 *     node dada-bridge.js orders          every minute
 *     node dada-bridge.js albaran-sync    every few minutes
 *     node dada-bridge.js price-sync      nightly
 *
 * Everything the program needs from the outside sits BESIDE that file:
 * `bridge.env` (config), `bridge.log` (output), `<job>.lock` (the singleton).
 * Not the working directory — Task Scheduler's default working directory is
 * `C:\Windows\System32`, and a bridge that looked for its config there would
 * work by hand and fail as a scheduled task, which is the worst way to fail.
 *
 * Argv is strict: exactly one known command, nothing else. A typo in a scheduled
 * task's arguments must be an immediate visible failure rather than a run that
 * quietly does something other than what the task was created for.
 */
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  bridgeSecrets,
  describeConfig,
  loadBridgeConfigFromFile,
  type BridgeConfig,
} from "./config";
import { connectWingest, injectOrder } from "./injector";
import { runAlbaranSync } from "./jobs/albaran-sync";
import { runOrders } from "./jobs/orders";
import { runPriceSync } from "./jobs/price-sync";
import type { JobResult } from "./jobs/shared";
import { acquireLock } from "./lock";
import { createLogger, type Logger } from "./log";
import { createBridgeSupabase, type BridgeSupabase } from "./supabase";

export const JOBS = ["orders", "albaran-sync", "price-sync"] as const;
export type JobName = (typeof JOBS)[number];

export const ENV_FILE = "bridge.env";
export const LOG_FILE = "bridge.log";

export const USAGE = [
  "dada-bridge — DADA portal ⇄ Wingest ERP",
  "",
  "Usage: node dada-bridge.js <command>",
  "",
  "Commands:",
  "  orders        claim confirmed portal orders and inject them as Wingest pedidos",
  "  albaran-sync  match Wingest albaranes back to injected portal orders",
  "  price-sync    merge Wingest article prices and units into the portal catalog",
  "  --help        print this message",
  "",
  `Config and logs live beside this file: ${ENV_FILE}, ${LOG_FILE}, <command>.lock.`,
].join("\n");

export type ArgvOutcome =
  | { kind: "job"; job: JobName }
  | { kind: "help" }
  | { kind: "error"; message: string };

function isJobName(value: string): value is JobName {
  return (JOBS as readonly string[]).includes(value);
}

/**
 * Exactly one argument, and it must be one we know.
 *
 * No arguments is an ERROR rather than help: a scheduled task created without
 * its argument would otherwise print usage, exit 0, and look healthy in Task
 * Scheduler's history forever while no order is ever injected.
 */
export function parseArgv(argv: readonly string[]): ArgvOutcome {
  if (argv.length === 0) return { kind: "error", message: "a command is required" };
  if (argv.length > 1) {
    return {
      kind: "error",
      message: `expected exactly one command, got ${argv.length}: ${argv.join(" ")}`,
    };
  }
  const [arg] = argv;
  if (arg === "--help") return { kind: "help" };
  if (isJobName(arg)) return { kind: "job", job: arg };
  return { kind: "error", message: `unknown command "${arg}"` };
}

/**
 * The directory the bundle sits in, from the path node was given.
 *
 * `process.argv[1]` rather than the working directory, for the Task Scheduler
 * reason above; the cwd fallback only matters when node was handed no script at
 * all (a REPL), which the CLI never is.
 */
export function resolveBridgeDir(scriptPath: string | undefined): string {
  if (!scriptPath) return process.cwd();
  return dirname(resolve(scriptPath));
}

async function runJob(
  job: JobName,
  cfg: BridgeConfig,
  api: BridgeSupabase,
  log: Logger,
): Promise<JobResult> {
  switch (job) {
    case "orders":
      return runOrders({
        cfg,
        api,
        log,
        connect: connectWingest,
        inject: injectOrder,
        newToken: () => randomUUID(),
      });
    case "albaran-sync":
      return runAlbaranSync({ cfg, api, log, connect: connectWingest });
    case "price-sync":
      return runPriceSync({ cfg, api, log, connect: connectWingest });
  }
}

/**
 * The whole run. Returns the process exit code rather than calling `exit`, so
 * the entry point below owns the one place the process dies.
 *
 * 0 means the run COMPLETED — per-order failures are logged, counted, and left
 * to the lease to retry. 1 means it could not run at all: bad config, a lock
 * another run holds, an unreachable database. That distinction is what makes
 * Task Scheduler's "last result" column worth looking at.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return 1;
  }

  const job = parsed.job;
  const dir = resolveBridgeDir(process.argv[1]);
  const logPath = join(dir, LOG_FILE);
  // Two loggers on the same file: this one exists to report a config failure,
  // which happens before there are any secrets to mask.
  const bootstrap = createLogger({ filePath: logPath });

  let cfg: BridgeConfig;
  try {
    cfg = loadBridgeConfigFromFile(join(dir, ENV_FILE));
  } catch (error) {
    bootstrap.logError(error, { job, stage: "config", dir });
    return 1;
  }

  const log = createLogger({ filePath: logPath, secrets: bridgeSecrets(cfg) });
  log.info("start", { job, dir, ...describeConfig(cfg) });

  const lock = (() => {
    try {
      return acquireLock(dir, job, { log });
    } catch (error) {
      // Not an error worth a stack trace every minute: the orders job overrunning
      // its one-minute schedule is exactly what the lock is for.
      log.logError(error, { job, stage: "lock" });
      return null;
    }
  })();
  if (!lock) return 1;

  const api = createBridgeSupabase(cfg);
  let result: JobResult = { ok: false, counts: {} };
  try {
    result = await runJob(job, cfg, api, log);
  } catch (error) {
    log.logError(error, { job, stage: "run" });
    result = { ok: false, counts: { error: "RUN_FAILED" } };
  } finally {
    // The summary first: it is the line the operator reads and pastes, and it
    // must survive anything the heartbeat does next.
    log.info(`${job} summary`, { ...result.counts, ok: result.ok });
    try {
      const written = await api.heartbeat({
        job,
        last_run_at: new Date().toISOString(),
        ok: result.ok,
        detail: result.counts,
      });
      if (!written) {
        log.warn("heartbeat skipped: bridge_status is not deployed yet", { job });
      }
    } catch (error) {
      // Telemetry must never fail a run that already injected orders. This is
      // the try/catch the supabase client cannot do for us: a 404 whose body is
      // not PostgREST JSON still escapes `heartbeat` as a thrown error.
      log.logError(error, { job, stage: "heartbeat" });
    }
    lock.release();
  }

  return result.ok ? 0 : 1;
}

/**
 * Direct execution only: importing this module from a test must not run a job.
 *
 * `typeof require` because the same source is loaded as an ES module by vitest,
 * where neither identifier exists; `typeof` on an undeclared name is the one
 * form that does not throw. In the esbuild CJS bundle both are real and
 * `require.main === module` is true exactly when node was pointed at this file.
 */
const isDirectRun =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Nothing should still be holding the loop open — pools are closed in a
      // `finally` — but an ERP connection that will not die must not leave a
      // scheduled task running forever. The timer is unref'd, so it can only
      // fire if something ELSE is keeping the process alive past this point.
      setTimeout(() => process.exit(code), 10_000).unref();
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
