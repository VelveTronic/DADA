import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config";
import type { JobResult } from "./jobs/shared";
import { EjeYearMismatchError } from "./jobs/orders";
import { LockError, type Lock } from "./lock";
import type { LogFields, Logger, LoggerOptions } from "./log";
import type { BridgeSupabase, HeartbeatRow } from "./supabase";
import {
  ENV_FILE,
  JOBS,
  LOG_FILE,
  USAGE,
  parseArgv,
  resolveBridgeDir,
  runMain,
  type MainDeps,
} from "./main";

describe("parseArgv", () => {
  it("accepts each job exactly once", () => {
    for (const job of JOBS) {
      expect(parseArgv([job])).toEqual({ kind: "job", job });
    }
  });

  it("accepts --help", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
  });

  it("treats NO argument as an error, not as help", () => {
    // A scheduled task created without its argument has to fail visibly rather
    // than print usage and exit 0 forever.
    const outcome = parseArgv([]);
    expect(outcome.kind).toBe("error");
  });

  it("rejects an unknown command and names it", () => {
    const outcome = parseArgv(["order"]);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toContain('"order"');
  });

  it("rejects a second argument", () => {
    const outcome = parseArgv(["orders", "--dry-run"]);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toContain("exactly one");
  });

  it("rejects a job repeated", () => {
    expect(parseArgv(["orders", "orders"]).kind).toBe("error");
  });

  it("does not accept abbreviations, flags or casing variants", () => {
    for (const argv of [["-h"], ["help"], ["--orders"], ["ORDERS"], ["orders "]]) {
      expect(parseArgv(argv).kind).toBe("error");
    }
  });
});

describe("USAGE", () => {
  it("names every command the parser accepts", () => {
    for (const job of JOBS) expect(USAGE).toContain(job);
    expect(USAGE).toContain("--help");
  });

  it("tells the operator where config and logs live", () => {
    expect(USAGE).toContain(ENV_FILE);
    expect(USAGE).toContain(LOG_FILE);
  });
});

describe("resolveBridgeDir", () => {
  it("is the directory of the script node was given, not the working directory", () => {
    const script = resolve("C:/dada/bridge/dada-bridge.js");
    expect(resolveBridgeDir(script)).toBe(dirname(script));
  });

  it("resolves a relative script path against the working directory", () => {
    expect(resolveBridgeDir("dist/dada-bridge.js")).toBe(
      dirname(resolve("dist/dada-bridge.js")),
    );
  });

  it("falls back to the working directory when node was given no script", () => {
    expect(resolveBridgeDir(undefined)).toBe(process.cwd());
  });
});

const DIR = resolve("C:/dada/bridge");
const NOW = new Date("2026-08-16T05:31:00.000Z");

const cfg: BridgeConfig = {
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "service-key",
  wingestServer: "SERVER\\WINGEST",
  wingestPort: 50352,
  wingestDb: "wg_test",
  wingestUser: "dada_bridge",
  wingestPassword: "sql-password",
  erpUser: "SFY",
  can: "B",
  eje: 26,
  allowHistoricalEje: false,
  historicalOrderId: null,
  alm: "00001",
  serfac: 1,
  claimLimit: 20,
  leaseSeconds: 300,
};

interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

interface Harness {
  deps: MainDeps;
  lines: Line[];
  /** Everything with an order worth asserting, in the order it happened. */
  events: string[];
  beats: HeartbeatRow[];
  loggers: LoggerOptions[];
  stdout: string[];
  stderr: string[];
  jobRuns: number;
  jobNow: Date | null;
}

/**
 * `runMain` with every dependency faked and every side effect recorded.
 *
 * The point of the seam: none of the branches below — which failure writes a
 * heartbeat, which one gets a stack trace, what order the `finally` does its
 * three things in — is reachable through `main()`, which reads a real
 * `bridge.env`, takes a real lock file and opens real sockets.
 */
function harness(
  overrides: {
    argv?: readonly string[];
    loadConfig?: () => BridgeConfig;
    acquire?: () => Lock;
    run?: () => Promise<JobResult>;
    heartbeat?: (row: HeartbeatRow) => Promise<boolean>;
  } = {},
): Harness {
  const lines: Line[] = [];
  const events: string[] = [];
  const beats: HeartbeatRow[] = [];
  const loggers: LoggerOptions[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const state = { jobRuns: 0, jobNow: null as Date | null };

  const at =
    (level: string) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields });
      if (message.endsWith(" summary")) events.push("summary");
    };
  const log: Logger = {
    info: at("INFO"),
    warn: at("WARN"),
    error: at("ERROR"),
    logError: (error, fields = {}) => {
      lines.push({
        level: "ERROR",
        message: "failed",
        // Only what `describeError` lifts matters here: `stack` is the field
        // whose presence separates logError from error.
        fields: {
          ...fields,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      });
    },
  };

  const api = {
    heartbeat: async (row: HeartbeatRow) => {
      events.push("heartbeat");
      beats.push(row);
      return overrides.heartbeat ? overrides.heartbeat(row) : true;
    },
  } as unknown as BridgeSupabase;

  const lock: Lock = {
    path: join(DIR, "orders.lock"),
    release: () => {
      events.push("release");
    },
  };

  const deps: MainDeps = {
    argv: overrides.argv ?? ["orders"],
    dir: DIR,
    loadConfig: overrides.loadConfig ?? (() => cfg),
    createLogger: (options) => {
      loggers.push(options);
      return log;
    },
    createApi: () => api,
    acquireLock: overrides.acquire ?? (() => lock),
    runJob: async (_job, _cfg, _api, _log, now) => {
      state.jobRuns++;
      state.jobNow = now();
      return overrides.run
        ? overrides.run()
        : { ok: true, counts: { claimed: 1, injected: 1 } };
    },
    now: () => NOW,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };

  return {
    deps,
    lines,
    events,
    beats,
    loggers,
    stdout,
    stderr,
    get jobRuns() {
      return state.jobRuns;
    },
    get jobNow() {
      return state.jobNow;
    },
  };
}

describe("runMain — argv", () => {
  it("prints usage to stdout and exits 0 for --help, touching nothing else", async () => {
    const h = harness({ argv: ["--help"] });
    expect(await runMain(h.deps)).toBe(0);

    expect(h.stdout.join("")).toContain(USAGE);
    expect(h.stderr).toEqual([]);
    // No config read, no lock taken, no heartbeat: --help must be safe to run
    // on a server while a scheduled run is in flight.
    expect(h.loggers).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("prints the reason AND usage to stderr and exits 1 for a bad command", async () => {
    const h = harness({ argv: ["order"] });
    expect(await runMain(h.deps)).toBe(1);

    expect(h.stderr.join("")).toContain('unknown command "order"');
    expect(h.stderr.join("")).toContain(USAGE);
    expect(h.stdout).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe("runMain — config", () => {
  it("reports a bad bridge.env and writes NO heartbeat", async () => {
    const h = harness({
      loadConfig: () => {
        throw new Error("SUPABASE_URL is missing");
      },
    });
    expect(await runMain(h.deps)).toBe(1);

    // There is no service key to write a heartbeat WITH: this is the one
    // failure the staff card cannot see, and it shows up there as 未运行.
    expect(h.beats).toEqual([]);
    expect(h.events).toEqual([]);
    const failure = h.lines.find((line) => line.level === "ERROR");
    expect(failure?.fields).toMatchObject({ job: "orders", stage: "config", dir: DIR });
  });

  it("gives the bootstrap logger no secrets to mask, and the real one both", async () => {
    const h = harness();
    await runMain(h.deps);

    expect(h.loggers).toHaveLength(2);
    expect(h.loggers[0]).toEqual({ filePath: join(DIR, LOG_FILE) });
    // Config is loaded by the time the second logger exists, so the service key
    // and the SQL password can be masked out of anything mssql or fetch writes.
    expect(h.loggers[1].secrets).toEqual(["service-key", "sql-password"]);
  });
});

describe("runMain — the lock", () => {
  it("logs a held lock WITHOUT a stack trace and heartbeats code=LOCK_HELD", async () => {
    const path = join(DIR, "orders.lock");
    const h = harness({
      acquire: () => {
        throw new LockError("LOCK_HELD", path, "orders is already running (pid 4242)");
      },
    });
    expect(await runMain(h.deps)).toBe(1);

    const failure = h.lines.find((line) => line.level === "ERROR");
    // `log.error`, not `logError`: an every-minute job overrunning its schedule
    // is the ordinary case this lock exists for, and a stack per minute would
    // bury the run it is waiting on.
    expect(failure?.fields).toMatchObject({ stage: "lock", code: "LOCK_HELD", path });
    expect(failure?.fields.stack).toBeUndefined();
    expect(failure?.message).toContain("already running");

    // The heartbeat is what lets the card tell "blocked every minute" from
    // "never scheduled" — both otherwise leave a stale last_run_at.
    expect(h.beats).toEqual([
      {
        job: "orders",
        last_run_at: NOW.toISOString(),
        ok: false,
        detail: { code: "LOCK_HELD" },
      },
    ]);
    // Nothing ran and nothing was released: the lock is somebody else's.
    expect(h.jobRuns).toBe(0);
    expect(h.events).toEqual(["heartbeat"]);
  });

  it("logs an UNEXPECTED lock failure in full, and heartbeats LOCK_FAILED", async () => {
    const h = harness({
      acquire: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    expect(await runMain(h.deps)).toBe(1);

    const failure = h.lines.find((line) => line.level === "ERROR");
    // Not the expected case, so the whole thing goes in the log — this is the
    // one an operator has never seen before.
    expect(failure?.fields.stack).toBeDefined();
    expect(failure?.fields).toMatchObject({ stage: "lock" });
    expect(h.beats[0].detail).toEqual({ code: "LOCK_FAILED" });
  });

  it("keeps a LockError's own code when it is not LOCK_HELD", async () => {
    const h = harness({
      acquire: () => {
        throw new LockError("LOCK_UNWRITABLE", join(DIR, "orders.lock"), "read-only directory");
      },
    });
    await runMain(h.deps);
    expect(h.beats[0].detail).toEqual({ code: "LOCK_UNWRITABLE" });
  });
});

describe("runMain — the run", () => {
  it("heartbeats the counts and exits 0 when the job completes", async () => {
    const h = harness();
    expect(await runMain(h.deps)).toBe(0);
    expect(h.jobNow).toEqual(NOW);

    expect(h.beats).toEqual([
      {
        job: "orders",
        last_run_at: NOW.toISOString(),
        ok: true,
        detail: { claimed: 1, injected: 1 },
      },
    ]);
  });

  it("exits 1 with the job's own counts when the job reports failure", async () => {
    const h = harness({
      run: async () => ({ ok: false, counts: { articles: 0, error: "socket hang up" } }),
    });
    expect(await runMain(h.deps)).toBe(1);
    expect(h.beats[0]).toMatchObject({ ok: false, detail: { error: "socket hang up" } });
  });

  it("turns a thrown job into detail.code = RUN_FAILED — the key is `code`", async () => {
    const h = harness({
      run: () => Promise.reject(new Error("boom")),
    });
    expect(await runMain(h.deps)).toBe(1);

    // `code`, not `error`: the house style is that `code` is the short machine
    // token, and the staff card keys its failure rendering on this exact key.
    expect(h.beats[0]).toMatchObject({ ok: false, detail: { code: "RUN_FAILED" } });
    expect(Object.keys(h.beats[0].detail as object)).toEqual(["code"]);
    expect(h.lines.some((line) => line.fields.stage === "run")).toBe(true);
  });

  it("preserves EJE_YEAR_MISMATCH in the failure heartbeat", async () => {
    const h = harness({
      run: () => Promise.reject(new EjeYearMismatchError(25, 26)),
    });

    expect(await runMain(h.deps)).toBe(1);
    expect(h.beats[0]).toMatchObject({
      ok: false,
      detail: { code: "EJE_YEAR_MISMATCH" },
    });
  });

  it("summarises, THEN heartbeats, THEN releases the lock — in that order", async () => {
    const h = harness();
    await runMain(h.deps);

    // The summary is the line the operator reads and pastes; it must survive
    // anything the heartbeat does next, and the lock must outlive both.
    expect(h.events).toEqual(["summary", "heartbeat", "release"]);
    const summary = h.lines.find((line) => line.message === "orders summary");
    expect(summary?.fields).toEqual({ claimed: 1, injected: 1, ok: true });
  });

  it("keeps that order when the job throws", async () => {
    const h = harness({ run: () => Promise.reject(new Error("boom")) });
    await runMain(h.deps);
    expect(h.events).toEqual(["summary", "heartbeat", "release"]);
  });

  it("releases the lock even when the heartbeat throws, and still exits 0", async () => {
    const h = harness({
      heartbeat: () => Promise.reject(new Error("503 from PostgREST")),
    });
    // Telemetry never fails a run: the orders are already in Wingest.
    expect(await runMain(h.deps)).toBe(0);
    expect(h.events).toEqual(["summary", "heartbeat", "release"]);
    expect(h.lines.some((line) => line.fields.stage === "heartbeat")).toBe(true);
  });

  it("says so once when bridge_status is not deployed, without failing", async () => {
    const h = harness({ heartbeat: () => Promise.resolve(false) });
    expect(await runMain(h.deps)).toBe(0);

    const warn = h.lines.find((line) => line.level === "WARN");
    expect(warn?.message).toContain("bridge_status is not deployed");
  });

  it("names the job it was given, for each job", async () => {
    for (const job of JOBS) {
      const h = harness({ argv: [job] });
      await runMain(h.deps);
      expect(h.beats[0].job).toBe(job);
      expect(h.lines[0]).toMatchObject({ message: "start", fields: { job, dir: DIR } });
    }
  });

  it("reads config and log from the bundle's own directory", async () => {
    const h = harness();
    let seen = "";
    h.deps.loadConfig = (envPath) => {
      seen = envPath;
      return cfg;
    };
    await runMain(h.deps);

    // Task Scheduler's working directory is C:\Windows\System32; a bridge that
    // looked for its config there would work by hand and fail as a task.
    expect(seen).toBe(join(DIR, ENV_FILE));
    expect(h.loggers[0].filePath).toBe(join(DIR, LOG_FILE));
  });
});
